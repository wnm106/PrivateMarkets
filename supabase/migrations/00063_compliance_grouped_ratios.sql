-- Read numerator and denominator values once per anchor.
--
-- evaluate_rule used to call aggregate_numeric inside the group loop, so an
-- anchor-total denominator was scanned again for every group, and a ratio
-- whose two sides share an attribute and a dimension scanned that attribute
-- twice. grouped_ratio_parts loads each distinct value set once, then
-- aggregates every group from those rows. The ratio, limit test, and stored
-- result are unchanged.

CREATE OR REPLACE FUNCTION compliance.apply_aggregation(
    p_aggregation VARCHAR,
    p_values NUMERIC[]
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT COALESCE((
        SELECT CASE upper(COALESCE(p_aggregation, 'SUM'))
            WHEN 'AVG' THEN AVG(u.v)
            WHEN 'MIN' THEN MIN(u.v)
            WHEN 'MAX' THEN MAX(u.v)
            WHEN 'COUNT' THEN COUNT(u.v)::NUMERIC
            WHEN 'VALUE' THEN MAX(u.v)
            ELSE SUM(u.v)
        END
        FROM unnest(COALESCE(p_values, ARRAY[]::NUMERIC[])) AS u(v)
    ), 0);
$function$;

COMMENT ON FUNCTION compliance.apply_aggregation(VARCHAR, NUMERIC[]) IS
    'SUM/AVG/MIN/MAX/COUNT/VALUE over an already-loaded value list. Missing values are ignored. An empty list is 0, matching aggregate_numeric.';

-- One row per group. ANCHOR_TOTAL denominator is one aggregate of every base
-- entity. SAME_GROUP denominator aggregates that group's entities. Identical
-- numerator and denominator dimensions share one value read.
CREATE OR REPLACE FUNCTION compliance.grouped_ratio_parts(
    p_group_map JSONB,
    p_numerator_attribute VARCHAR,
    p_numerator_aggregation VARCHAR,
    p_numerator_dimension JSONB,
    p_denominator_attribute VARCHAR,
    p_denominator_aggregation VARCHAR,
    p_denominator_scope VARCHAR,
    p_denominator_dimension JSONB,
    p_denominator_constant NUMERIC,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS TABLE (
    group_key TEXT,
    numerator_value NUMERIC,
    denominator_value NUMERIC,
    contributing_ids UUID[]
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    v_ids UUID[];
    v_num RECORD;
    v_den RECORD;
    v_fetch_den BOOLEAN;
BEGIN
    SELECT COALESCE(array_agg(DISTINCT u.id), ARRAY[]::UUID[])
    INTO v_ids
    FROM jsonb_each(COALESCE(p_group_map, '{}'::JSONB)) AS e
    CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(e.value)::UUID AS id
    ) AS u;

    SELECT * INTO v_num
    FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, p_source_scope, p_numerator_dimension);
    SELECT * INTO v_den
    FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, p_source_scope, p_denominator_dimension);

    -- A second read is required only when the denominator is a different
    -- attribute or a different source/as-of/knowledge triple.
    v_fetch_den := p_denominator_attribute IS NOT NULL
        AND p_denominator_scope IS DISTINCT FROM 'CONSTANT'
        AND NOT (
            p_denominator_attribute = p_numerator_attribute
            AND v_num.o_as_of IS NOT DISTINCT FROM v_den.o_as_of
            AND v_num.o_knowledge IS NOT DISTINCT FROM v_den.o_knowledge
            AND v_num.o_source IS NOT DISTINCT FROM v_den.o_source
        );

    RETURN QUERY
    WITH groups AS (
        SELECT e.key AS group_key, u.id AS entity_id
        FROM jsonb_each(COALESCE(p_group_map, '{}'::JSONB)) AS e
        CROSS JOIN LATERAL (
            SELECT DISTINCT jsonb_array_elements_text(e.value)::UUID AS id
        ) AS u
    ),
    num_vals AS MATERIALIZED (
        SELECT v.entity_id, v.val
        FROM compliance.get_numeric_values(
            v_ids, p_numerator_attribute, v_num.o_as_of, v_num.o_knowledge, v_num.o_source
        ) AS v
    ),
    den_vals AS MATERIALIZED (
        SELECT v.entity_id, v.val
        FROM compliance.get_numeric_values(
            CASE WHEN v_fetch_den THEN v_ids ELSE ARRAY[]::UUID[] END,
            p_denominator_attribute,
            v_den.o_as_of,
            v_den.o_knowledge,
            v_den.o_source
        ) AS v
        UNION ALL
        SELECT n.entity_id, n.val
        FROM num_vals AS n
        WHERE NOT v_fetch_den
            AND p_denominator_attribute IS NOT NULL
            AND p_denominator_scope IS DISTINCT FROM 'CONSTANT'
    ),
    anchor_den AS (
        SELECT compliance.apply_aggregation(
            p_denominator_aggregation, array_agg(d.val)
        ) AS denominator
        FROM den_vals AS d
    ),
    grouped AS (
        SELECT
            g.group_key,
            compliance.apply_aggregation(p_numerator_aggregation, array_agg(n.val)) AS numerator_value,
            compliance.apply_aggregation(p_denominator_aggregation, array_agg(d.val)) AS same_group_denominator,
            array_agg(DISTINCT g.entity_id) AS contributing_ids
        FROM groups AS g
        LEFT JOIN num_vals AS n ON n.entity_id = g.entity_id
        LEFT JOIN den_vals AS d ON d.entity_id = g.entity_id
        GROUP BY g.group_key
    )
    SELECT
        grouped.group_key,
        grouped.numerator_value,
        CASE
            WHEN p_denominator_attribute IS NULL AND p_denominator_scope IS DISTINCT FROM 'CONSTANT' THEN NULL
            WHEN p_denominator_scope = 'CONSTANT' THEN p_denominator_constant
            WHEN p_denominator_scope = 'ANCHOR_TOTAL' THEN (SELECT anchor_den.denominator FROM anchor_den)
            ELSE grouped.same_group_denominator
        END,
        grouped.contributing_ids
    FROM grouped;
END;
$function$;

COMMENT ON FUNCTION compliance.grouped_ratio_parts(JSONB, VARCHAR, VARCHAR, JSONB, VARCHAR, VARCHAR, VARCHAR, JSONB, NUMERIC, DATE, TIMESTAMPTZ, VARCHAR) IS
    'Numerator and denominator for every group in one value read per distinct attribute dimension.';

GRANT EXECUTE ON FUNCTION compliance.apply_aggregation(VARCHAR, NUMERIC[]) TO authenticated;
GRANT EXECUTE ON FUNCTION compliance.grouped_ratio_parts(JSONB, VARCHAR, VARCHAR, JSONB, VARCHAR, VARCHAR, VARCHAR, JSONB, NUMERIC, DATE, TIMESTAMPTZ, VARCHAR) TO authenticated;

-- evaluate_rule keeps its anchor walk, conditions, and limit test.
-- Group numerators and denominators come from one read per value set.

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT NOW(),
    p_source_scope VARCHAR DEFAULT NULL,
    p_triggered_by UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = compliance, entity_instances, metadata_register, golden_master, tenancy, pg_temp
AS $eval$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_eligible_base_ids UUID[];
    v_group_rec JSONB;
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_key_ids UUID[];
    v_group_map JSONB;
    v_part RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE rule_code = p_rule_code;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');

    -- Resolve numerator/denominator dimensions once per run (run-level constants)
    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator',   jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by)
    RETURNING id INTO v_run_id;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            SELECT array_agg(eid) INTO v_eligible_base_ids
            FROM unnest(v_base_ids) AS eid
            WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope);

            IF v_eligible_base_ids IS NULL OR array_length(v_eligible_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        SELECT compliance.get_text_value_dim(w[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension)
                        INTO v_key
                        FROM (SELECT compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date) AS w) wx;
                    END IF;

                    v_key := COALESCE(v_key, '__UNASSIGNED__');

                    IF v_group_map ? v_key THEN
                        v_group_map := jsonb_set(
                            v_group_map, ARRAY[v_key],
                            to_jsonb((SELECT array_agg(x) FROM (
                                SELECT jsonb_array_elements_text(v_group_map -> v_key)::UUID AS x
                                UNION ALL SELECT v_base_eid
                            ) u))
                        );
                    ELSE
                        v_group_map := jsonb_set(v_group_map, ARRAY[v_key], jsonb_build_array(v_base_eid), TRUE);
                    END IF;
                END LOOP;
            END IF;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    v_version.denominator_attribute_code,
                    v_version.denominator_aggregation,
                    v_version.denominator_scope,
                    v_version.denominator_dimension,
                    v_version.denominator_constant_value,
                    p_as_of_date,
                    p_knowledge_date,
                    v_source_scope
                )
            LOOP
                v_key := v_part.group_key;
                v_key_ids := v_part.contributing_ids;
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;

                IF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL; -- undefined ratio / % change
                ELSIF v_version.result_transform IN ('PCT_CHANGE', 'ABS_PCT_CHANGE') THEN
                    v_computed := (v_numerator - v_denominator) / v_denominator;
                    IF v_version.result_transform = 'ABS_PCT_CHANGE' THEN
                        v_computed := abs(v_computed);
                    END IF;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_numerator / v_denominator;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                END IF;

                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_version.hard_limit_value IS NOT NULL AND v_computed > v_version.hard_limit_value THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_version.hard_limit_value;
                    ELSIF v_version.soft_limit_value IS NOT NULL AND v_computed > v_version.soft_limit_value THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_version.soft_limit_value;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE -- MIN
                    IF v_version.hard_limit_value IS NOT NULL AND v_computed < v_version.hard_limit_value THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_version.hard_limit_value - v_computed;
                    ELSIF v_version.soft_limit_value IS NOT NULL AND v_computed < v_version.soft_limit_value THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_version.soft_limit_value - v_computed;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id,
                    CASE WHEN v_key = '__ALL__' OR v_key = '__UNASSIGNED__' THEN NULL ELSE v_key END,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    v_status, v_breach, v_key_ids, array_length(v_key_ids, 1), v_detail
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;
        END LOOP;

        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'COMPLETED', completed_at = NOW(), result_count = v_result_count, breach_count = v_breach_count
        WHERE id = v_run_id;

    EXCEPTION WHEN OTHERS THEN
        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'FAILED', completed_at = NOW(), error_message = SQLERRM
        WHERE id = v_run_id;
        RAISE;
    END;

    RETURN v_run_id;
END;
$eval$;


GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(VARCHAR, DATE, TIMESTAMPTZ, VARCHAR, UUID) TO authenticated;
