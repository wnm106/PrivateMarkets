-- One interpreter for a rule's population conditions, saved or not.
--
-- The rule editor previews which records a rule's conditions select. The API
-- did it with its own copy of the condition logic in TypeScript
-- (packages/graphql/src/lib/compliance-population.ts): it loaded up to 20,000
-- records and 200,000 relationships, matched them in memory, and read values
-- as of today whatever the user's dates. The evaluator matches with
-- compliance.entity_matches_conditions, which only reads saved conditions.
--
-- compliance.entity_matches_condition_set is that same matcher, taking the
-- conditions as an argument. entity_matches_conditions now reads the saved
-- conditions and hands them to it, so the evaluator is unchanged.
-- compliance.preview_population runs it over a domain's records for
-- conditions that are not saved yet, as of the caller's dates.

CREATE OR REPLACE FUNCTION compliance.entity_matches_condition_set(p_entity_id uuid, p_conditions compliance.rule_conditions[], p_applies_to character varying, p_as_of_date date, p_knowledge_date timestamp with time zone, p_source_scope character varying DEFAULT 'GOLDEN'::character varying)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
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
        SELECT DISTINCT c.condition_group FROM unnest(p_conditions) AS c
        WHERE c.applies_to = p_applies_to
    LOOP
        v_has_conditions := TRUE;
        v_group_match := NULL;
        FOR v_cond IN
            SELECT * FROM unnest(p_conditions) AS c
            WHERE c.applies_to = p_applies_to
              AND c.condition_group = v_group_rec.condition_group
            ORDER BY c.condition_order
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
$function$;

COMMENT ON FUNCTION compliance.entity_matches_condition_set(uuid, compliance.rule_conditions[], character varying, date, timestamp with time zone, character varying) IS
    'Whether a record matches a set of rule conditions. The one condition matcher: entity_matches_conditions and preview_population both call it.';

CREATE OR REPLACE FUNCTION compliance.entity_matches_conditions(p_entity_id uuid, p_rule_version_id uuid, p_applies_to character varying, p_as_of_date date, p_knowledge_date timestamp with time zone, p_source_scope character varying DEFAULT 'GOLDEN'::character varying)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT compliance.entity_matches_condition_set(
        p_entity_id,
        ARRAY(
            SELECT c FROM compliance.rule_conditions c
            WHERE c.rule_version_id = p_rule_version_id AND c.applies_to = p_applies_to
            ORDER BY c.condition_group, c.condition_order
        ),
        p_applies_to, p_as_of_date, p_knowledge_date, p_source_scope
    );
$function$;

-- Which of a domain's records a set of conditions selects, as of the given
-- dates, a page at a time. p_conditions holds rule_conditions rows as JSON
-- (snake_case columns). Runs as the caller, so only records they can read are
-- scanned. values holds, per condition in the order given, the value the
-- record has for that condition's attribute (along its path), for display.
CREATE OR REPLACE FUNCTION compliance.preview_population(
    p_domain_code TEXT,
    p_conditions JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_limit INTEGER DEFAULT 25,
    p_offset INTEGER DEFAULT 0,
    p_cap INTEGER DEFAULT 20000
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = compliance, entity_instances, pg_temp
AS $$
DECLARE
    v_conditions compliance.rule_conditions[];
    v_scanned INTEGER;
    v_total INTEGER;
    v_rows JSONB;
BEGIN
    SELECT COALESCE(array_agg(
        jsonb_populate_record(NULL::compliance.rule_conditions,
            jsonb_build_object('applies_to', 'BASE', 'condition_group', 1, 'condition_order', 1,
                               'logic_operator', 'AND', 'attribute_dimension', '{}'::jsonb, 'compare_dimension', '{}'::jsonb)
            || jsonb_strip_nulls(c) || jsonb_build_object('applies_to', COALESCE(c ->> 'applies_to', 'BASE')))
        ORDER BY ordinality), ARRAY[]::compliance.rule_conditions[])
      INTO v_conditions
    FROM jsonb_array_elements(COALESCE(p_conditions, '[]'::jsonb)) WITH ORDINALITY AS t(c, ordinality)
    WHERE NULLIF(c ->> 'attribute_code', '') IS NOT NULL;

    WITH candidates AS (
        SELECT me.id AS entity_id, me.entity_code, me.entity_name
        FROM entity_instances.master_entities me
        WHERE me.domain_code = p_domain_code AND me.is_active
        ORDER BY me.entity_code
        LIMIT GREATEST(p_cap, 1) + 1
    ), scanned AS (
        SELECT * FROM candidates ORDER BY entity_code LIMIT GREATEST(p_cap, 1)
    ), matched AS (
        SELECT s.* FROM scanned s
        WHERE compliance.entity_matches_condition_set(s.entity_id, v_conditions, 'BASE', p_as_of_date, p_knowledge_date, 'GOLDEN')
    ), counted AS (
        SELECT (SELECT count(*) FROM matched) AS total, (SELECT count(*) FROM candidates) AS seen
    ), page AS (
        SELECT * FROM matched ORDER BY entity_code
        OFFSET GREATEST(p_offset, 0) LIMIT LEAST(GREATEST(p_limit, 1), 100)
    )
    SELECT (SELECT total FROM counted), (SELECT seen FROM counted),
           COALESCE(jsonb_agg(jsonb_build_object(
               'entityId', p.entity_id,
               'entityCode', p.entity_code,
               'entityName', p.entity_name,
               'values', (
                   SELECT COALESCE(jsonb_agg(
                       CASE WHEN u.left_expression IS NOT NULL THEN NULL ELSE
                           compliance.get_text_value_dim(
                               COALESCE((compliance.condition_subject_ids(p.entity_id, COALESCE(u.attribute_dimension -> 'relationship_path', '[]'::jsonb), p_as_of_date, p_knowledge_date))[1], p.entity_id),
                               u.attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN', u.attribute_dimension)
                       END ORDER BY u.ordinality), '[]'::jsonb)
                   FROM unnest(v_conditions) WITH ORDINALITY AS u
               )
           ) ORDER BY p.entity_code), '[]'::jsonb)
      INTO v_total, v_scanned, v_rows
    FROM page p;

    RETURN jsonb_build_object(
        'total', COALESCE(v_total, 0),
        'scanned', LEAST(COALESCE(v_scanned, 0), GREATEST(p_cap, 1)),
        'truncated', COALESCE(v_scanned, 0) > GREATEST(p_cap, 1),
        'rows', v_rows
    );
END;
$$;
COMMENT ON FUNCTION compliance.preview_population(TEXT, JSONB, DATE, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER) IS
    'The records of a domain that a set of rule conditions selects, as of the given dates, with the evaluator''s own matcher.';

REVOKE ALL ON FUNCTION compliance.entity_matches_condition_set(uuid, compliance.rule_conditions[], character varying, date, timestamp with time zone, character varying) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.entity_matches_condition_set(uuid, compliance.rule_conditions[], character varying, date, timestamp with time zone, character varying) TO authenticated, service_role;
REVOKE ALL ON FUNCTION compliance.preview_population(TEXT, JSONB, DATE, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.preview_population(TEXT, JSONB, DATE, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- What each record contributed to a stored result, read the way the evaluator
-- read it: the numerator with compliance.get_numeric_values over the
-- numerator's resolved dimension (as aggregate_numeric does), one for a count.
-- The API used to rebuild these in TypeScript, joining values to text,
-- splitting them again and adding them as floats, and walking a numerator path
-- the evaluator does not walk. Text values are for display.
--
-- Definer, like measure_line_contributors: the caller must be able to read the
-- result, which carries the client of its rule.
CREATE OR REPLACE FUNCTION compliance.result_contributor_values(p_result_id UUID)
RETURNS TABLE (
    entity_id UUID,
    entity_code TEXT,
    entity_name TEXT,
    numerator_value NUMERIC,
    numerator_text TEXT,
    denominator_text TEXT,
    group_text TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = compliance, entity_instances, pg_temp
AS $$
DECLARE
    v_result compliance.rule_evaluation_results;
    v_version compliance.rule_versions;
    v_num RECORD;
    v_den RECORD;
    v_grp RECORD;
    v_counting BOOLEAN;
BEGIN
    SELECT * INTO v_result FROM compliance.rule_evaluation_results r WHERE r.id = p_result_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Result not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT tenancy.is_backend_caller() THEN
        PERFORM tenancy.assert_entity_access(v_result.anchor_entity_id, 'READ');
    END IF;
    SELECT * INTO v_version FROM compliance.rule_versions v WHERE v.id = v_result.rule_version_id;

    SELECT * INTO v_num FROM compliance.resolve_dimension(v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den FROM compliance.resolve_dimension(v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.denominator_dimension);
    SELECT * INTO v_grp FROM compliance.resolve_dimension(v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.group_by_dimension);
    v_counting := v_version.numerator_aggregation IN ('COUNT', 'COUNT_DISTINCT');

    RETURN QUERY
    SELECT me.id,
           me.entity_code::TEXT,
           me.entity_name::TEXT,
           CASE WHEN v_counting THEN 1::NUMERIC ELSE (
               SELECT sum(g.val) FROM compliance.get_numeric_values(ARRAY[me.id], v_version.numerator_attribute_code, v_num.o_as_of, v_num.o_knowledge, v_num.o_source) g
           ) END,
           CASE WHEN v_version.numerator_attribute_code IS NULL THEN NULL ELSE
               compliance.get_text_value_dim(me.id, v_version.numerator_attribute_code, v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.numerator_dimension) END,
           CASE WHEN v_version.denominator_attribute_code IS NULL THEN NULL ELSE
               compliance.get_text_value_dim(me.id, v_version.denominator_attribute_code, v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.denominator_dimension) END,
           CASE WHEN v_version.group_by_attribute_code IS NULL THEN NULL ELSE
               compliance.get_text_value_dim(me.id, v_version.group_by_attribute_code, v_result.as_of_date, v_result.knowledge_date, v_result.source_scope, v_version.group_by_dimension) END
    FROM unnest(COALESCE(v_result.contributing_entity_ids, '{}'::UUID[])) AS c(id)
    JOIN entity_instances.master_entities me ON me.id = c.id;
END;
$$;
COMMENT ON FUNCTION compliance.result_contributor_values(UUID) IS
    'Each contributing record of a stored result with its numerator as the evaluator read it, and display values.';
REVOKE ALL ON FUNCTION compliance.result_contributor_values(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.result_contributor_values(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
