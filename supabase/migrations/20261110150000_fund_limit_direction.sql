-- A fund limit is a minimum or a maximum. The rule no longer decides the direction.
-- Existing threshold rows take the direction from the rule version that is in force,
-- so tests that already have a fund limit keep breaching the same way.

ALTER TABLE compliance.rule_versions
    ALTER COLUMN limit_direction DROP NOT NULL;

COMMENT ON COLUMN compliance.rule_versions.limit_direction IS
    'Legacy fallback used only when no fund limit has a direction. New rules leave this null. The direction that is enforced is compliance.rule_thresholds.limit_direction.';

ALTER TABLE compliance.rule_thresholds
    ADD COLUMN IF NOT EXISTS limit_direction VARCHAR(10);

UPDATE compliance.rule_thresholds AS t
SET limit_direction = src.limit_direction
FROM (
    SELECT DISTINCT ON (rv.rule_id) rv.rule_id, rv.limit_direction
    FROM compliance.rule_versions rv
    WHERE rv.is_active
      AND rv.system_to > NOW()
      AND rv.limit_direction IS NOT NULL
    ORDER BY rv.rule_id, rv.version_number DESC
) AS src
WHERE t.rule_id = src.rule_id
  AND t.limit_direction IS NULL;

UPDATE compliance.rule_thresholds
SET limit_direction = 'MAX'
WHERE limit_direction IS NULL;

ALTER TABLE compliance.rule_thresholds
    DROP CONSTRAINT IF EXISTS rule_thresholds_limit_direction_check;
ALTER TABLE compliance.rule_thresholds
    ADD CONSTRAINT rule_thresholds_limit_direction_check
    CHECK (limit_direction IN ('MAX', 'MIN'));
ALTER TABLE compliance.rule_thresholds
    ALTER COLUMN limit_direction SET DEFAULT 'MAX';
ALTER TABLE compliance.rule_thresholds
    ALTER COLUMN limit_direction SET NOT NULL;

COMMENT ON COLUMN compliance.rule_thresholds.limit_direction IS
    'MAX: the result breaches when it is above the soft or hard number. MIN: the result breaches when it is below. Set on the fund limit.';

DROP FUNCTION IF EXISTS compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION compliance.resolve_threshold(
    p_rule_id UUID,
    p_entity_id UUID,
    p_group TEXT,
    p_rank BIGINT,
    p_as_of DATE,
    p_fallback_soft NUMERIC,
    p_fallback_hard NUMERIC
) RETURNS TABLE (soft_limit NUMERIC, hard_limit NUMERIC, applies BOOLEAN, source TEXT, limit_direction VARCHAR)
LANGUAGE sql STABLE
AS $function$
    SELECT picked.soft_limit_value, picked.hard_limit_value, picked.applies, picked.source, picked.limit_direction
    FROM (
        SELECT t.soft_limit_value, t.hard_limit_value, t.applies, t.limit_direction,
               CASE WHEN t.entity_id IS NULL THEN 'RULE' ELSE 'FUND' END AS source
        FROM compliance.rule_thresholds t
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR t.entity_id IS NULL)
          AND (t.group_value IS NULL OR t.group_value = p_group)
          AND (
                (t.rank_from IS NULL AND t.rank_to IS NULL)
                OR (
                    p_rank IS NOT NULL
                    AND t.rank_from IS NOT NULL
                    AND t.rank_from <= p_rank
                    AND (t.rank_to IS NULL OR p_rank <= t.rank_to)
                )
          )
        ORDER BY
            CASE WHEN t.entity_id = p_entity_id THEN 0 ELSE 1 END,
            CASE WHEN t.group_value IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN t.rank_from IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
    ) picked
    UNION ALL
    SELECT p_fallback_soft, p_fallback_hard, TRUE, 'VERSION', NULL::VARCHAR
    WHERE NOT EXISTS (
        SELECT 1
        FROM compliance.rule_thresholds t
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR t.entity_id IS NULL)
          AND (t.group_value IS NULL OR t.group_value = p_group)
          AND (
                (t.rank_from IS NULL AND t.rank_to IS NULL)
                OR (
                    p_rank IS NOT NULL
                    AND t.rank_from IS NOT NULL
                    AND t.rank_from <= p_rank
                    AND (t.rank_to IS NULL OR p_rank <= t.rank_to)
                )
          )
    );
$function$;

GRANT EXECUTE ON FUNCTION compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_more UUID[];
    v_child_funds UUID[];
    v_eligible_base_ids UUID[];
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_group_map JSONB;
    v_part RECORD;
    v_row RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
    v_hard NUMERIC;
    v_soft NUMERIC;
    v_lim NUMERIC;
    v_anc_den NUMERIC;
    v_opt_out BOOLEAN;
    v_limit RECORD;
    v_group_label TEXT;
    v_meta JSONB;
    v_walked UUID[];
    v_subject UUID;
    v_group_entities JSONB;
    v_addend NUMERIC;
    v_assets NUMERIC;
    v_debt NUMERIC;
    v_excess NUMERIC;
    v_basket_group NUMERIC;
    v_basket_cap NUMERIC;
    v_is_coverage BOOLEAN;
    v_pass_empty BOOLEAN;
    v_is_composite BOOLEAN;
    v_strict BOOLEAN;
    v_term JSONB;
    v_tval NUMERIC;
    v_num_sum NUMERIC;
    v_den_sum NUMERIC;
    v_has_den BOOLEAN;
    v_missing BOOLEAN;
    v_term_detail JSONB;
    v_limit_val NUMERIC;
    v_direction VARCHAR;
    v_rank_direction VARCHAR;
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
    v_meta := COALESCE(v_version.metadata, '{}'::jsonb);
    v_pass_empty := COALESCE((v_meta->>'pass_if_empty')::BOOLEAN, FALSE);
    v_is_coverage := COALESCE(v_meta->>'logic', '') = 'asset_coverage';
    v_is_composite := COALESCE(v_meta->>'logic', '') = 'composite_ratio';
    v_strict := COALESCE(v_meta->>'scenario_mode', '') = 'strict';
    v_basket_group := NULLIF(v_meta #>> '{exception_basket,per_group_limit}', '')::NUMERIC;
    v_basket_cap := NULLIF(v_meta #>> '{exception_basket,basket_limit}', '')::NUMERIC;

    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator', jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform,
        'consolidate_descendants', COALESCE(v_version.consolidate_descendants, FALSE),
        'logic', NULLIF(v_meta->>'logic', '')
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by, metadata)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by,
            CASE WHEN p_scenario_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scenario_code', p_scenario_code) END)
    RETURNING id INTO v_run_id;

    CREATE TEMP TABLE IF NOT EXISTS compliance_eval_parts (
        group_key TEXT,
        numerator NUMERIC,
        denominator NUMERIC,
        computed NUMERIC,
        contributing_ids UUID[]
    ) ON COMMIT DROP;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF p_anchor_entity_id IS NOT NULL AND v_anchor.entity_id <> p_anchor_entity_id THEN
                CONTINUE;
            END IF;

            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            SELECT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = FALSE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            IF v_opt_out THEN
                CONTINUE;
            END IF;

            v_rank_direction := NULL;
            SELECT t.limit_direction INTO v_rank_direction
            FROM compliance.rule_thresholds t
            WHERE t.rule_id = v_rule.id
              AND (t.entity_id = v_anchor.entity_id OR t.entity_id IS NULL)
              AND t.group_value IS NULL
              AND t.rank_from IS NULL
              AND t.rank_to IS NULL
              AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
              AND t.limit_direction IS NOT NULL
            ORDER BY CASE WHEN t.entity_id = v_anchor.entity_id THEN 0 ELSE 1 END
            LIMIT 1;
            v_rank_direction := COALESCE(v_rank_direction, v_version.limit_direction, 'MAX');
            v_direction := v_rank_direction;

            v_hard := v_version.hard_limit_value;
            v_soft := v_version.soft_limit_value;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                v_lim := NULL;
                SELECT g.val INTO v_lim
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                IF v_lim IS NOT NULL THEN
                    v_hard := v_lim;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_lim * v_version.soft_limit_factor END;
                END IF;
            END IF;

            IF v_meta ? 'limit_term' THEN
                v_limit_val := compliance.eval_clo_term(
                    v_anchor.entity_id, v_meta->'limit_term',
                    p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code
                );
                IF v_limit_val IS NOT NULL THEN
                    v_hard := v_limit_val;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_limit_val * v_version.soft_limit_factor END;
                END IF;
            END IF;

            IF v_is_composite THEN
                v_num_sum := 0;
                v_den_sum := 0;
                v_missing := FALSE;
                v_term_detail := '[]'::jsonb;
                v_has_den := jsonb_array_length(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) > 0;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'numerator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_num_sum := v_num_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'numerator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_den_sum := v_den_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'denominator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                -- A fund row in rule_thresholds overrides the limit.
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(v_rule.id, v_anchor.entity_id, NULL, NULL::BIGINT, p_as_of_date, v_soft, v_hard);
                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_direction := COALESCE(v_limit.limit_direction, v_rank_direction);

                IF v_missing OR (v_has_den AND COALESCE(v_den_sum, 0) = 0) THEN
                    v_computed := NULL;
                ELSIF v_has_den THEN
                    v_computed := v_num_sum / v_den_sum;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_num_sum;
                END IF;

                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_limit.hard_limit IS NULL AND v_limit.soft_limit IS NULL THEN
                    -- Nothing says what the limit is, so there is nothing to pass.
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
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
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_num_sum, CASE WHEN v_has_den THEN v_den_sum END, v_computed,
                    v_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, 0,
                    v_detail || jsonb_build_object('terms', v_term_detail, 'limit_source', v_limit.source)
                    || CASE
                        WHEN v_has_den AND v_direction = 'MAX' AND v_limit.hard_limit IS NOT NULL
                             AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_num_sum - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_den_sum, 0))
                        ELSE '{}'::jsonb
                       END
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

            v_anc_den := NULL;
            IF v_version.denominator_source = 'ANCHOR' AND v_version.denominator_attribute_code IS NOT NULL THEN
                SELECT g.val INTO v_anc_den
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.denominator_attribute_code, v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source) AS g
                LIMIT 1;
            END IF;

            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF COALESCE(v_version.consolidate_descendants, FALSE) THEN
                v_child_funds := compliance.walk_path(
                    ARRAY[v_anchor.entity_id],
                    '[{"relationship_code":"FUND_PARENT","direction":"DOWN","recursive":true}]'::jsonb,
                    p_as_of_date,
                    p_knowledge_date
                );
                IF v_child_funds IS NOT NULL AND array_length(v_child_funds, 1) IS NOT NULL THEN
                    IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                        v_more := v_child_funds;
                    ELSE
                        v_more := compliance.walk_path(v_child_funds, v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
                    END IF;
                    SELECT array_agg(DISTINCT x) INTO v_base_ids
                    FROM unnest(COALESCE(v_base_ids, '{}'::UUID[]) || COALESCE(v_more, '{}'::UUID[])) AS x
                    WHERE x IS NOT NULL;
                END IF;
            END IF;

            IF (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) AND NOT v_is_coverage THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            IF v_is_coverage AND (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) THEN
                v_eligible_base_ids := ARRAY[]::UUID[];
            ELSE
                SELECT array_agg(eid) INTO v_eligible_base_ids
                FROM unnest(v_base_ids) AS eid
                WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope)
                  AND compliance.include_in_scenario(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope)
                  AND (NOT v_strict OR compliance.scenario_strict_include(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope));
            END IF;

            IF v_is_coverage THEN
                v_addend := 0;
                IF v_eligible_base_ids IS NOT NULL AND array_length(v_eligible_base_ids, 1) IS NOT NULL THEN
                    SELECT COALESCE(SUM(g.val), 0) INTO v_addend
                    FROM compliance.get_numeric_values(
                        v_eligible_base_ids,
                        COALESCE(v_meta->>'addend_attribute', 'ESTIMATED_VALUE'),
                        p_as_of_date, p_knowledge_date, v_source_scope
                    ) AS g;
                END IF;
                v_assets := NULL;
                v_debt := NULL;
                SELECT g.val INTO v_assets
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'assets_attribute', 'TOTAL_AUM'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                SELECT g.val INTO v_debt
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'debt_attribute', 'TOTAL_DEBT'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;

                IF v_assets IS NULL OR v_debt IS NULL THEN
                    v_numerator := NULL;
                    v_denominator := NULL;
                    v_computed := NULL;
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSE
                    v_numerator := v_assets + COALESCE(v_addend, 0);
                    v_denominator := v_debt + COALESCE(v_addend, 0);
                    IF v_denominator = 0 THEN
                        v_computed := NULL;
                        v_status := 'NO_DATA';
                        v_breach := NULL;
                    ELSE
                        v_computed := v_numerator / v_denominator;
                        IF v_direction = 'MAX' THEN
                            IF v_hard IS NOT NULL AND v_computed > v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_computed - v_hard;
                            ELSIF v_soft IS NOT NULL AND v_computed > v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_computed - v_soft;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        ELSE
                            IF v_hard IS NOT NULL AND v_computed < v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_hard - v_computed;
                            ELSIF v_soft IS NOT NULL AND v_computed < v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_soft - v_computed;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        END IF;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_direction, v_soft, v_hard,
                    v_status, v_breach, v_eligible_base_ids, COALESCE(array_length(v_eligible_base_ids, 1), 0),
                    v_detail || jsonb_build_object(
                        'assets', v_assets,
                        'debt', v_debt,
                        'addend', v_addend,
                        'book_coverage', CASE WHEN v_debt IS NULL OR v_debt = 0 THEN NULL ELSE v_assets / v_debt END,
                        'projected_coverage', v_computed
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

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
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;
            v_group_entities := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    v_subject := NULL;
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_subject := v_base_eid;
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        v_walked := compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date);
                        IF v_walked IS NULL OR array_length(v_walked, 1) IS NULL THEN
                            v_subject := NULL;
                            v_key := NULL;
                        ELSE
                            v_subject := v_walked[1];
                            v_key := compliance.get_text_value_dim(v_subject, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                        END IF;
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

                    IF v_subject IS NOT NULL THEN
                        IF v_group_entities ? v_key THEN
                            v_group_entities := jsonb_set(
                                v_group_entities, ARRAY[v_key],
                                (v_group_entities -> v_key) || jsonb_build_array(v_subject::text)
                            );
                        ELSE
                            v_group_entities := jsonb_set(v_group_entities, ARRAY[v_key], jsonb_build_array(v_subject::text), TRUE);
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            DELETE FROM compliance_eval_parts WHERE TRUE;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source IN ('ANCHOR', 'GROUP') THEN NULL ELSE v_version.denominator_attribute_code END,
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
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;
                IF v_version.denominator_source = 'ANCHOR' THEN
                    v_denominator := v_anc_den;
                END IF;
                IF v_version.denominator_source = 'GROUP' THEN
                    v_denominator := NULL;
                    IF v_group_entities ? v_key AND jsonb_array_length(v_group_entities -> v_key) > 0 THEN
                        SELECT MAX(g.val) INTO v_denominator
                        FROM compliance.get_numeric_values(
                            ARRAY(SELECT DISTINCT t.elem::UUID FROM jsonb_array_elements_text(v_group_entities -> v_key) AS t(elem)),
                            v_version.denominator_attribute_code,
                            v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source
                        ) AS g;
                    END IF;
                END IF;

                IF v_version.denominator_source IN ('ANCHOR', 'GROUP') AND COALESCE(v_denominator, 0) = 0 THEN
                    v_computed := NULL;
                ELSIF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL;
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

                INSERT INTO compliance_eval_parts (group_key, numerator, denominator, computed, contributing_ids)
                VALUES (v_key, v_numerator, v_denominator, v_computed, v_part.contributing_ids);
            END LOOP;

            v_excess := NULL;
            IF v_basket_group IS NOT NULL THEN
                SELECT COALESCE(SUM(GREATEST(p.computed - v_basket_group, 0)), 0)
                INTO v_excess
                FROM compliance_eval_parts p
                WHERE p.computed IS NOT NULL;
            END IF;

            FOR v_row IN
                SELECT p.*,
                       CASE
                           WHEN p.computed IS NULL THEN NULL
                           ELSE row_number() OVER (
                               ORDER BY
                                   CASE WHEN v_direction = 'MIN' THEN p.computed END ASC NULLS LAST,
                                   CASE WHEN COALESCE(v_direction, 'MAX') <> 'MIN' THEN p.computed END DESC NULLS LAST,
                                   p.group_key
                           )
                       END AS rank_pos
                FROM compliance_eval_parts p
            LOOP
                v_group_label := CASE WHEN v_row.group_key IN ('__ALL__', '__UNASSIGNED__') THEN NULL ELSE v_row.group_key END;
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(
                    v_rule.id, v_anchor.entity_id, v_group_label, v_row.rank_pos, p_as_of_date, v_soft, v_hard
                );

                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_direction := COALESCE(v_limit.limit_direction, v_rank_direction);

                v_computed := v_row.computed;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_group IS NOT NULL AND v_computed > v_basket_group THEN
                    IF v_basket_cap IS NOT NULL AND v_excess > v_basket_cap THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_basket_group;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSIF v_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
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
                    status, breach_amount, contributing_entity_ids, contributing_count,
                    rank_position, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, v_group_label,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_row.numerator, v_row.denominator, v_computed,
                    v_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, v_row.contributing_ids, array_length(v_row.contributing_ids, 1),
                    v_row.rank_pos,
                    v_detail || jsonb_build_object('rank', v_row.rank_pos, 'threshold_source', v_limit.source)
                    || CASE
                        WHEN v_direction = 'MAX'
                         AND v_limit.hard_limit IS NOT NULL
                         AND v_row.denominator IS NOT NULL AND v_row.denominator <> 0
                         AND v_version.result_transform = 'NONE'
                         AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_row.numerator - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_row.denominator, 0))
                        ELSE '{}'::jsonb
                       END
                    || CASE
                        WHEN v_basket_group IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object(
                            'basket_excess', v_excess,
                            'basket_limit', v_basket_cap,
                            'allowed_exception',
                            v_computed > v_basket_group AND NOT (v_basket_cap IS NOT NULL AND v_excess > v_basket_cap)
                        )
                       END
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;

            IF v_basket_group IS NOT NULL THEN
                v_computed := v_excess;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_cap IS NOT NULL AND v_computed > v_basket_cap THEN
                    v_status := 'HARD_BREACH';
                    v_breach := v_computed - v_basket_cap;
                ELSE
                    v_status := 'PASS';
                    v_breach := NULL;
                END IF;
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, 'Exception basket',
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_excess, NULL, v_computed,
                    'MAX', NULL, v_basket_cap,
                    v_status, v_breach, NULL,
                    v_detail || jsonb_build_object(
                        'basket_excess', v_excess,
                        'basket_limit', v_basket_cap,
                        'per_group_limit', v_basket_group
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END IF;
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
$function$;

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(character varying, date, timestamp with time zone, character varying, uuid, uuid, character varying) TO authenticated, service_role;
