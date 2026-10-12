-- Compliance conditions may filter on an attribute reached by a relationship
-- path (security, issuer, cash flow, and the rest of the tree), not only on the
-- entity being tested. The path is stored on the condition's attribute_dimension
-- JSON as relationship_path: [{relationship_code, direction, recursive}].
-- An empty path keeps the previous same-entity behavior.
-- A path matches when ANY related entity satisfies the operator. When the walk
-- finds nobody, the operand is null (is_null matches; equals does not).

CREATE OR REPLACE FUNCTION compliance.condition_subject_ids(
    p_entity_id UUID,
    p_path JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS UUID[] LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_path IS NULL OR jsonb_typeof(p_path) IS DISTINCT FROM 'array' OR jsonb_array_length(p_path) = 0 THEN
        RETURN ARRAY[p_entity_id];
    END IF;
    RETURN compliance.walk_path(ARRAY[p_entity_id], p_path, p_as_of_date, p_knowledge_date);
END;
$$;

COMMENT ON FUNCTION compliance.condition_subject_ids IS
    'Entity ids a compliance condition reads. Empty relationship_path returns the entity itself; otherwise the ids at the end of the path (possibly none).';

CREATE OR REPLACE FUNCTION compliance.entity_matches_conditions(
    p_entity_id UUID,
    p_rule_version_id UUID,
    p_applies_to VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_group_rec RECORD;
    v_cond RECORD;
    v_group_match BOOLEAN;
    v_any_group_match BOOLEAN := FALSE;
    v_has_conditions BOOLEAN := FALSE;
    v_actual TEXT;
    v_expected TEXT;
    v_cond_result BOOLEAN;
    v_attr_path JSONB;
    v_cmp_path JSONB;
    v_subjects UUID[];
    v_cmp_ids UUID[];
    v_subject UUID;
    v_cmp_id UUID;
BEGIN
    FOR v_group_rec IN
        SELECT DISTINCT condition_group
        FROM compliance.rule_conditions
        WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
    LOOP
        v_has_conditions := TRUE;
        v_group_match := NULL;

        FOR v_cond IN
            SELECT *
            FROM compliance.rule_conditions
            WHERE rule_version_id = p_rule_version_id
              AND applies_to = p_applies_to
              AND condition_group = v_group_rec.condition_group
            ORDER BY condition_order
        LOOP
            v_attr_path := COALESCE(v_cond.attribute_dimension->'relationship_path', '[]'::jsonb);
            v_cmp_path := COALESCE(v_cond.compare_dimension->'relationship_path', '[]'::jsonb);
            v_subjects := compliance.condition_subject_ids(p_entity_id, v_attr_path, p_as_of_date, p_knowledge_date);
            v_cond_result := FALSE;

            IF v_subjects IS NULL OR array_length(v_subjects, 1) IS NULL THEN
                v_cond_result := compliance.condition_null_subject_matches(
                    p_entity_id, v_cond::compliance.rule_conditions, v_attr_path, v_cmp_path, p_as_of_date, p_knowledge_date, p_source_scope
                );
            ELSE
                FOREACH v_subject IN ARRAY v_subjects LOOP
                    v_actual := compliance.get_text_value_dim(
                        v_subject, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.attribute_dimension
                    );

                    IF v_cond.compare_attribute_code IS NULL THEN
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_cond.value);
                    ELSIF jsonb_typeof(v_cmp_path) IS DISTINCT FROM 'array'
                       OR jsonb_array_length(v_cmp_path) = 0
                       OR v_cmp_path = v_attr_path THEN
                        v_expected := compliance.get_text_value_dim(
                            v_subject, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension
                        );
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_expected);
                    ELSE
                        v_cmp_ids := compliance.condition_subject_ids(p_entity_id, v_cmp_path, p_as_of_date, p_knowledge_date);
                        IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
                            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, NULL);
                        ELSE
                            FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
                                v_expected := compliance.get_text_value_dim(
                                    v_cmp_id, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension
                                );
                                IF compliance.evaluate_operator(v_actual, v_cond.operator, v_expected) THEN
                                    v_cond_result := TRUE;
                                    EXIT;
                                END IF;
                            END LOOP;
                        END IF;
                    END IF;

                    IF v_cond_result THEN
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF v_group_match IS NULL THEN
                v_group_match := v_cond_result;
            ELSIF v_cond.logic_operator = 'OR' THEN
                v_group_match := v_group_match OR v_cond_result;
            ELSE
                v_group_match := v_group_match AND v_cond_result;
            END IF;
        END LOOP;

        IF v_group_match THEN
            v_any_group_match := TRUE;
        END IF;
    END LOOP;

    IF NOT v_has_conditions THEN
        RETURN TRUE;
    END IF;

    RETURN v_any_group_match;
END;
$$;

-- Isolated so the main function stays readable: a missing related entity is a null operand.
CREATE OR REPLACE FUNCTION compliance.condition_null_subject_matches(
    p_entity_id UUID,
    p_cond compliance.rule_conditions,
    p_attr_path JSONB,
    p_cmp_path JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cmp_ids UUID[];
    v_cmp_id UUID;
    v_expected TEXT;
BEGIN
    IF p_cond.compare_attribute_code IS NULL THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, p_cond.value);
    END IF;

    IF jsonb_typeof(p_cmp_path) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_cmp_path) = 0
       OR p_cmp_path = p_attr_path THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, NULL);
    END IF;

    v_cmp_ids := compliance.condition_subject_ids(p_entity_id, p_cmp_path, p_as_of_date, p_knowledge_date);
    IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, NULL);
    END IF;

    FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
        v_expected := compliance.get_text_value_dim(
            v_cmp_id, p_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, p_cond.compare_dimension
        );
        IF compliance.evaluate_operator(NULL, p_cond.operator, v_expected) THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION compliance.entity_matches_conditions IS
    'True when the entity satisfies the rule conditions for BASE or ANCHOR. Attribute paths walk the relationship tree and match if any related entity satisfies the operator.';
