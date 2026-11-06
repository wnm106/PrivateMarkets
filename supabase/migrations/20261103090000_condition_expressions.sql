-- Compliance conditions may use an expression on either side of the comparison.
--
-- left_expression / right_expression hold the shared expression tree
-- ({const} | {ref} | {op, args} | {fn, args}) that metadata_register.eval_expr already
-- evaluates for calculated columns. A ref is an attribute code on the entity being
-- tested, or "<HOP>|<HOP>\u001f<ATTRIBUTE>" for an attribute on a related entity,
-- where a HOP is "UP:<RELATIONSHIP_CODE>" or "DOWN:<RELATIONSHIP_CODE>". A ref that
-- reaches several related entities reads the first one.
--
-- Conditions that compare a plain attribute with a literal, attribute or date
-- function keep using attribute_code / value / compare_attribute_code unchanged.
-- When left_expression is set, attribute_code holds the placeholder __EXPR__.

ALTER TABLE compliance.rule_conditions
    ADD COLUMN IF NOT EXISTS left_expression JSONB,
    ADD COLUMN IF NOT EXISTS right_expression JSONB;

COMMENT ON COLUMN compliance.rule_conditions.left_expression IS 'When set, the left-hand operand is this expression tree instead of attribute_code.';
COMMENT ON COLUMN compliance.rule_conditions.right_expression IS 'When set, the right-hand operand is this expression tree instead of value / compare_attribute_code.';

CREATE OR REPLACE FUNCTION compliance.path_text_to_hops(p_path TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object(
            'relationship_code', split_part(hop, ':', 2),
            'direction', upper(split_part(hop, ':', 1)),
            'recursive', FALSE
        ) ORDER BY ord),
        '[]'::jsonb
    )
    FROM unnest(string_to_array(NULLIF(p_path, ''), '|')) WITH ORDINALITY AS t(hop, ord)
$$;

COMMENT ON FUNCTION compliance.path_text_to_hops(TEXT) IS
    'Parses "UP:REL|DOWN:REL2" into the relationship_path array used by condition_subject_ids.';

CREATE OR REPLACE FUNCTION compliance.eval_operand(
    p_entity_id UUID,
    p_expr JSONB,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source VARCHAR,
    p_dim JSONB DEFAULT '{}'
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_vars JSONB := jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT));
    v_ref TEXT;
    v_path TEXT;
    v_code TEXT;
    v_ids UUID[];
    v_text TEXT;
    v_result JSONB;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) = 'null' THEN
        RETURN NULL;
    END IF;

    FOR v_ref IN
        SELECT DISTINCT r #>> '{}' FROM jsonb_path_query(p_expr, 'lax $.**.ref') AS r
    LOOP
        IF v_ref IS NULL OR v_ref = 'CURRENT_DATE' THEN
            CONTINUE;
        END IF;
        IF position(E'\u001f' IN v_ref) > 0 THEN
            v_path := split_part(v_ref, E'\u001f', 1);
            v_code := split_part(v_ref, E'\u001f', 2);
        ELSE
            v_path := '';
            v_code := v_ref;
        END IF;

        v_ids := compliance.condition_subject_ids(p_entity_id, compliance.path_text_to_hops(v_path), p_as_of, p_knowledge);
        IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
            v_text := NULL;
        ELSE
            v_text := compliance.get_text_value_dim(v_ids[1], v_code, p_as_of, p_knowledge, p_source, COALESCE(p_dim, '{}'::jsonb));
        END IF;

        v_vars := v_vars || jsonb_build_object(
            v_ref,
            CASE
                WHEN v_text IS NULL OR btrim(v_text) = '' THEN 'null'::jsonb
                WHEN btrim(v_text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN to_jsonb(btrim(v_text)::numeric)
                ELSE to_jsonb(v_text)
            END
        );
    END LOOP;

    v_result := metadata_register.eval_expr(p_expr, v_vars);
    IF v_result IS NULL OR jsonb_typeof(v_result) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(v_result) = 'number' THEN
        RETURN trim_scale((v_result #>> '{}')::numeric)::TEXT;
    END IF;
    RETURN v_result #>> '{}';
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION compliance.eval_operand(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, JSONB) IS
    'Evaluates a condition operand expression for one entity. Unreadable inputs, divide-by-zero and type errors give NULL.';

CREATE OR REPLACE FUNCTION compliance.expression_condition_matches(
    p_entity_id UUID,
    p_cond compliance.rule_conditions,
    p_attr_path JSONB,
    p_cmp_path JSONB,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source VARCHAR
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_expected TEXT;
    v_actual TEXT;
    v_cmp_ids UUID[];
    v_subjects UUID[];
    v_subject UUID;
BEGIN
    IF p_cond.right_expression IS NOT NULL THEN
        v_expected := compliance.eval_operand(p_entity_id, p_cond.right_expression, p_as_of, p_knowledge, p_source, p_cond.compare_dimension);
    ELSIF p_cond.compare_attribute_code IS NOT NULL THEN
        v_cmp_ids := compliance.condition_subject_ids(p_entity_id, p_cmp_path, p_as_of, p_knowledge);
        IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
            v_expected := NULL;
        ELSE
            v_expected := compliance.compared_value(
                p_cond.value, v_cmp_ids[1], p_cond.compare_attribute_code, p_as_of, p_knowledge, p_source, p_cond.compare_dimension
            );
        END IF;
    ELSE
        v_expected := compliance.resolve_rhs(p_cond.value, NULL, p_as_of);
    END IF;

    IF p_cond.left_expression IS NOT NULL THEN
        v_actual := compliance.eval_operand(p_entity_id, p_cond.left_expression, p_as_of, p_knowledge, p_source, p_cond.attribute_dimension);
        RETURN compliance.evaluate_operator(v_actual, p_cond.operator, v_expected);
    END IF;

    v_subjects := compliance.condition_subject_ids(p_entity_id, p_attr_path, p_as_of, p_knowledge);
    IF v_subjects IS NULL OR array_length(v_subjects, 1) IS NULL THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, v_expected);
    END IF;
    FOREACH v_subject IN ARRAY v_subjects LOOP
        v_actual := compliance.get_text_value_dim(v_subject, p_cond.attribute_code, p_as_of, p_knowledge, p_source, p_cond.attribute_dimension);
        IF compliance.evaluate_operator(v_actual, p_cond.operator, v_expected) THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION compliance.expression_condition_matches IS
    'One compliance condition where either side is an expression. Operands are read from the entity being tested; a plain left attribute still matches when ANY entity on its path satisfies the operator.';

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
        SELECT DISTINCT condition_group FROM compliance.rule_conditions
        WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
    LOOP
        v_has_conditions := TRUE;
        v_group_match := NULL;
        FOR v_cond IN
            SELECT * FROM compliance.rule_conditions
            WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
              AND condition_group = v_group_rec.condition_group
            ORDER BY condition_order
        LOOP
            v_attr_path := COALESCE(v_cond.attribute_dimension->'relationship_path', '[]'::jsonb);
            v_cmp_path := COALESCE(v_cond.compare_dimension->'relationship_path', '[]'::jsonb);
            v_cond_result := FALSE;
            IF v_cond.left_expression IS NOT NULL OR v_cond.right_expression IS NOT NULL THEN
                v_cond_result := compliance.expression_condition_matches(
                    p_entity_id, jsonb_populate_record(NULL::compliance.rule_conditions, to_jsonb(v_cond)), v_attr_path, v_cmp_path, p_as_of_date, p_knowledge_date, p_source_scope
                );
            ELSE
                v_subjects := compliance.condition_subject_ids(p_entity_id, v_attr_path, p_as_of_date, p_knowledge_date);
                IF v_subjects IS NULL OR array_length(v_subjects, 1) IS NULL THEN
                    v_cond_result := compliance.condition_null_subject_matches(p_entity_id, jsonb_populate_record(NULL::compliance.rule_conditions, to_jsonb(v_cond)), v_attr_path, v_cmp_path, p_as_of_date, p_knowledge_date, p_source_scope);
                ELSE
                    FOREACH v_subject IN ARRAY v_subjects LOOP
                        v_actual := compliance.get_text_value_dim(v_subject, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.attribute_dimension);
                        IF v_cond.compare_attribute_code IS NULL THEN
                            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, compliance.resolve_rhs(v_cond.value, NULL, p_as_of_date));
                        ELSIF jsonb_typeof(v_cmp_path) IS DISTINCT FROM 'array' OR jsonb_array_length(v_cmp_path) = 0 OR v_cmp_path = v_attr_path THEN
                            v_expected := compliance.compared_value(v_cond.value, v_subject, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension);
                            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_expected);
                        ELSE
                            v_cmp_ids := compliance.condition_subject_ids(p_entity_id, v_cmp_path, p_as_of_date, p_knowledge_date);
                            IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
                                v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, NULL);
                            ELSE
                                FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
                                    v_expected := compliance.compared_value(v_cond.value, v_cmp_id, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension);
                                    IF compliance.evaluate_operator(v_actual, v_cond.operator, v_expected) THEN
                                        v_cond_result := TRUE;
                                        EXIT;
                                    END IF;
                                END LOOP;
                            END IF;
                        END IF;
                        IF v_cond_result THEN EXIT; END IF;
                    END LOOP;
                END IF;
            END IF;
            IF v_group_match IS NULL THEN v_group_match := COALESCE(v_cond_result, FALSE);
            ELSIF v_cond.logic_operator = 'OR' THEN v_group_match := v_group_match OR COALESCE(v_cond_result, FALSE);
            ELSE v_group_match := v_group_match AND COALESCE(v_cond_result, FALSE);
            END IF;
        END LOOP;
        IF v_group_match THEN v_any_group_match := TRUE; END IF;
    END LOOP;
    IF NOT v_has_conditions THEN RETURN TRUE; END IF;
    RETURN v_any_group_match;
END;
$$;

REVOKE ALL ON FUNCTION compliance.path_text_to_hops(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.eval_operand(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.expression_condition_matches(UUID, compliance.rule_conditions, JSONB, JSONB, DATE, TIMESTAMPTZ, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compliance.path_text_to_hops(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.eval_operand(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.expression_condition_matches(UUID, compliance.rule_conditions, JSONB, JSONB, DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;
