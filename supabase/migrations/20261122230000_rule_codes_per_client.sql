-- Compliance rule codes are unique within a client, not across every client.
--
-- compliance.rules.rule_code was UNIQUE on its own, so a client creating a
-- rule with a code another client used failed with a duplicate key on a rule
-- it cannot see, and two clients could not both have, say, LEVERAGE_LIMIT.
--
-- Codes are now unique among the shared rules (client_id NULL) and within each
-- client. A client's rule may not take a shared rule's code, so a code read in
-- one client names at most one rule. Every lookup by code says which client:
--   * evaluate_rule reads the code in its anchor's client, or in the client
--     named by evaluate_rule_for_client (the worker's jobs), else the caller's;
--   * the pro forma, pre-trade and security-metric loops consider shared rules
--     and the fund's client's own only. They considered every client's.

ALTER TABLE compliance.rules DROP CONSTRAINT IF EXISTS rules_rule_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS rules_client_rule_code_key
    ON compliance.rules (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_code);

-- A client's rule cannot shadow a shared one, nor a shared one a client's.
CREATE OR REPLACE FUNCTION compliance.guard_rule_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
BEGIN
    IF NEW.client_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM compliance.rules r WHERE r.rule_code = NEW.rule_code AND r.client_id IS NULL AND r.id <> NEW.id
    ) THEN
        RAISE EXCEPTION 'The code % belongs to a shared rule. Choose another code.', NEW.rule_code USING ERRCODE = '23505';
    END IF;
    IF NEW.client_id IS NULL AND EXISTS (
        SELECT 1 FROM compliance.rules r WHERE r.rule_code = NEW.rule_code AND r.client_id IS NOT NULL AND r.id <> NEW.id
    ) THEN
        RAISE EXCEPTION 'A client already has a rule with the code %. A shared rule needs a code no client uses.', NEW.rule_code USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION compliance.guard_rule_code() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_rule_code ON compliance.rules;
CREATE TRIGGER guard_rule_code
    BEFORE INSERT OR UPDATE OF rule_code, client_id ON compliance.rules
    FOR EACH ROW EXECUTE FUNCTION compliance.guard_rule_code();

-- The rule a code names: a shared rule, or one client's own. With p_client_id
-- NULL, the caller's clients, or every client for server code. Refuses a code
-- that names more than one rule rather than picking one.
CREATE OR REPLACE FUNCTION compliance.rule_id_for_code(p_code TEXT, p_client_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = compliance, tenancy, pg_temp
AS $$
DECLARE
    v_ids UUID[];
BEGIN
    IF p_code IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT array_agg(r.id) INTO v_ids
    FROM compliance.rules r
    WHERE r.rule_code = p_code
      AND (r.client_id IS NULL OR CASE
            WHEN p_client_id IS NOT NULL THEN r.client_id = p_client_id
            WHEN tenancy.is_backend_caller() THEN TRUE
            ELSE r.client_id IN (SELECT tenancy.current_client_ids())
          END);
    IF cardinality(v_ids) > 1 THEN
        RAISE EXCEPTION 'More than one client has a rule with the code %. Run it for a fund, or for one client.', p_code
            USING ERRCODE = '21000';
    END IF;
    IF v_ids IS NULL THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_code USING ERRCODE = 'P0002';
    END IF;
    RETURN v_ids[1];
END;
$$;
REVOKE ALL ON FUNCTION compliance.rule_id_for_code(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.rule_id_for_code(TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(p_rule_code character varying, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_triggered_by uuid DEFAULT NULL::uuid, p_anchor_entity_id uuid DEFAULT NULL::uuid, p_scenario_code character varying DEFAULT NULL::character varying)
 RETURNS uuid
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
BEGIN
    -- A code names a rule among the shared ones and one client's own: the anchor's,
    -- else the client the caller named (evaluate_rule_for_client), else the caller's.
    SELECT * INTO v_rule FROM compliance.rules
    WHERE id = compliance.rule_id_for_code(
        p_rule_code,
        COALESCE((SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id), NULLIF(current_setting('compliance.client_id', TRUE), '')::uuid)
    );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');
    v_meta := compliance.overlay_measure_lines(v_version.id, COALESCE(v_version.metadata, '{}'::jsonb));
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

            -- fund_threshold_enrollment: the test can cover every fund, but it
            -- runs only for a fund with its own applies threshold.
            SELECT NOT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = TRUE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            -- test_all_funds: a test run covers funds that have no threshold yet.
            -- score_all_anchors: a rule on records that are not funds, such as
            -- statement periods, scores every anchor without enrollment rows.
            IF v_opt_out AND COALESCE(current_setting('compliance.test_all_funds', TRUE), '') <> 'on'
               AND NOT COALESCE((v_meta->>'score_all_anchors')::BOOLEAN, FALSE) THEN
                CONTINUE;
            END IF;

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
                ELSIF v_version.limit_direction = 'MAX' THEN
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
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, 0,
                    v_detail || jsonb_build_object('terms', v_term_detail, 'limit_source', v_limit.source)
                    || CASE
                        WHEN v_has_den AND v_version.limit_direction = 'MAX' AND v_limit.hard_limit IS NOT NULL
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
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            IF v_is_coverage AND (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) THEN
                v_eligible_base_ids := ARRAY[]::UUID[];
            ELSE
                -- Portfolio locks are one attribute on every position. Read it once.
                v_base_ids := compliance.without_allocation_locks(v_base_ids, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                IF NOT v_strict AND NOT EXISTS (
                    SELECT 1 FROM compliance.rule_conditions c
                    WHERE c.rule_version_id = v_version.id AND c.applies_to = 'BASE'
                ) THEN
                    v_eligible_base_ids := v_base_ids;
                ELSE
                    SELECT array_agg(eid) INTO v_eligible_base_ids
                    FROM unnest(v_base_ids) AS eid
                    WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope)
                      AND (NOT v_strict OR compliance.scenario_strict_include(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope));
                END IF;
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
                        IF v_version.limit_direction = 'MAX' THEN
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
                    v_version.limit_direction, v_soft, v_hard,
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
                    v_version.limit_direction, v_soft, v_hard,
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
                SELECT COALESCE(jsonb_object_agg(g.group_key, g.base_ids), '{}'::jsonb),
                       COALESCE(jsonb_object_agg(g.group_key, g.subjects) FILTER (WHERE g.subjects IS NOT NULL), '{}'::jsonb)
                INTO v_group_map, v_group_entities
                FROM (
                    SELECT m.group_key,
                           to_jsonb(array_agg(m.base_id ORDER BY m.base_id)) AS base_ids,
                           to_jsonb(array_agg(m.subject_id ORDER BY m.subject_id) FILTER (WHERE m.subject_id IS NOT NULL)) AS subjects
                    FROM compliance.group_membership(
                        v_eligible_base_ids,
                        v_version.group_by_path,
                        v_version.group_by_attribute_code,
                        v_version.group_by_dimension,
                        p_as_of_date,
                        p_knowledge_date,
                        v_source_scope
                    ) m
                    GROUP BY m.group_key
                ) g;
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
                                   CASE WHEN v_version.limit_direction = 'MIN' THEN p.computed END ASC NULLS LAST,
                                   CASE WHEN COALESCE(v_version.limit_direction, 'MAX') <> 'MIN' THEN p.computed END DESC NULLS LAST,
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
                ELSIF v_version.limit_direction = 'MAX' THEN
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
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, v_row.contributing_ids, array_length(v_row.contributing_ids, 1),
                    v_row.rank_pos,
                    v_detail || jsonb_build_object('rank', v_row.rank_pos, 'threshold_source', v_limit.source)
                    || CASE
                        WHEN v_version.limit_direction = 'MAX'
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

CREATE OR REPLACE FUNCTION compliance.proforma_snapshot(p_anchor_entity_id uuid, p_legs jsonb DEFAULT '[]'::jsonb, p_as_of_date date DEFAULT CURRENT_DATE, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[])
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, numerator_value numeric, denominator_value numeric, computed_value numeric, soft_limit_value numeric, hard_limit_value numeric, status character varying, result_unit character varying, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_domain TEXT;
    v_scenario VARCHAR := NULL;
    v_ids UUID[] := '{}'::UUID[];
    v_runs UUID[] := '{}'::UUID[];
    v_started TIMESTAMPTZ := NOW();
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run UUID;
    v_errors JSONB := '[]'::JSONB;
BEGIN
    -- A signed-in caller may test only a fund they can read, with securities
    -- they can read. A security named by code is read in the fund's client, as
    -- materialize_proforma_legs reads it. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
    IF NOT tenancy.is_backend_caller()
       AND p_legs IS NOT NULL AND jsonb_typeof(p_legs) = 'array'
       AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_legs) AS leg
            JOIN entity_instances.master_entities sec
              ON sec.id::TEXT = NULLIF(COALESCE(leg ->> 'security_id', leg ->> 'securityId'), '')
              OR (
                    NULLIF(COALESCE(leg ->> 'security_id', leg ->> 'securityId'), '') IS NULL
                    AND sec.entity_code = NULLIF(COALESCE(leg ->> 'security_code', leg ->> 'securityCode'), '')
                    AND sec.client_id = (SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id)
                 )
            WHERE NOT tenancy.has_entity_access(sec.id, 'READ')
       ) THEN
        RAISE EXCEPTION 'You do not have access to this record' USING ERRCODE = '42501';
    END IF;
    SELECT domain_code INTO v_domain
    FROM entity_instances.master_entities
    WHERE id = p_anchor_entity_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown anchor %', p_anchor_entity_id;
    END IF;

    IF p_legs IS NOT NULL AND jsonb_typeof(p_legs) = 'array' AND jsonb_array_length(p_legs) > 0 THEN
        v_scenario := 'PF' || replace(gen_random_uuid()::TEXT, '-', '');
        v_ids := compliance.materialize_proforma_legs(
            p_anchor_entity_id, p_legs, v_scenario, p_as_of_date, p_knowledge_date);
    END IF;

    BEGIN
        FOR v_rule IN
            SELECT r.*
            FROM compliance.rules r
            WHERE r.is_active
              AND r.anchor_domain_code = v_domain
              AND (p_rule_codes IS NULL OR r.rule_code = ANY (p_rule_codes))
              -- Shared rules and the fund's client's own; never another client's.
              AND (r.client_id IS NULL OR r.client_id = (SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id))
            ORDER BY r.rule_code
        LOOP
            v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
            IF v_version.id IS NULL THEN
                CONTINUE;
            END IF;
            BEGIN
                v_run := compliance.evaluate_rule(
                    v_rule.rule_code, p_as_of_date, p_knowledge_date, p_source_scope,
                    NULL, p_anchor_entity_id, v_scenario);
                v_runs := v_runs || v_run;
            EXCEPTION WHEN OTHERS THEN
                SELECT id INTO v_run
                FROM compliance.rule_evaluation_runs
                WHERE rule_id = v_rule.id
                  AND started_at >= v_started
                ORDER BY started_at DESC
                LIMIT 1;
                IF v_run IS NOT NULL THEN
                    v_runs := v_runs || v_run;
                END IF;
                v_errors := v_errors || jsonb_build_array(jsonb_build_object(
                    'rule_code', v_rule.rule_code,
                    'rule_name', v_rule.rule_name,
                    'error', SQLERRM
                ));
            END;
        END LOOP;

        RETURN QUERY
        SELECT r.rule_code::VARCHAR,
               v.rule_name::VARCHAR,
               res.group_by_value,
               res.limit_direction::VARCHAR,
               res.numerator_value,
               res.denominator_value,
               res.computed_value,
               res.soft_limit_value,
               res.hard_limit_value,
               res.status::VARCHAR,
               v.result_unit::VARCHAR,
               NULL::TEXT
        FROM compliance.rule_evaluation_results res
        JOIN compliance.rules r ON r.id = res.rule_id
        JOIN compliance.rule_versions v ON v.id = res.rule_version_id
        WHERE res.run_id = ANY (v_runs)
          AND res.anchor_entity_id = p_anchor_entity_id;

        RETURN QUERY
        SELECT (e->>'rule_code')::VARCHAR,
               (e->>'rule_name')::VARCHAR,
               NULL::TEXT,
               NULL::VARCHAR,
               NULL::NUMERIC,
               NULL::NUMERIC,
               NULL::NUMERIC,
               NULL::NUMERIC,
               NULL::NUMERIC,
               'ERROR'::VARCHAR,
               NULL::VARCHAR,
               (e->>'error')::TEXT
        FROM jsonb_array_elements(v_errors) AS e;

        PERFORM compliance.cleanup_proforma(v_ids, v_runs);
    EXCEPTION WHEN OTHERS THEN
        PERFORM compliance.cleanup_proforma(v_ids, v_runs);
        RAISE;
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION compliance.security_test_metrics(p_security_id uuid, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[], p_anchor_entity_id uuid DEFAULT NULL::uuid, p_security_code character varying DEFAULT NULL::character varying)
 RETURNS TABLE(rule_code character varying, metric numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
    v_security UUID;
    v_client UUID;
    v_domain TEXT;
    v_anchor_domain TEXT;
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_term JSONB;
    v_metric NUMERIC;
    v_text TEXT;
BEGIN
    -- A code names a record within one client: the fund's, when one is given,
    -- else the caller's own (entity_instances.entity_id_for_code).
    IF p_anchor_entity_id IS NOT NULL THEN
        SELECT a.client_id INTO v_client FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id;
    END IF;
    -- A signed-in caller may test only a security and fund they can read. A
    -- security named by code is checked the same way as one named by id.
    -- Server code is trusted.
    IF NOT tenancy.is_backend_caller() THEN
        IF p_security_id IS NOT NULL OR p_security_code IS NOT NULL THEN
            PERFORM tenancy.assert_entity_access(
                COALESCE(p_security_id, entity_instances.entity_id_for_code(p_security_code, v_client)),
                'READ'
            );
        END IF;
        IF p_anchor_entity_id IS NOT NULL THEN
            PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
        END IF;
    END IF;
    v_security := p_security_id;
    IF v_security IS NULL AND p_security_code IS NOT NULL THEN
        v_security := entity_instances.entity_id_for_code(p_security_code, v_client);
    END IF;
    IF v_security IS NULL THEN
        RAISE EXCEPTION 'A security id or security code is required';
    END IF;
    SELECT domain_code INTO v_domain
    FROM entity_instances.master_entities
    WHERE id = v_security;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown security %', COALESCE(p_security_code, v_security::TEXT);
    END IF;
    IF v_domain IS DISTINCT FROM 'SECURITY' THEN
        RAISE EXCEPTION 'Capacity is calculated for a security. % is a %', COALESCE(p_security_code, v_security::TEXT), v_domain;
    END IF;

    IF p_anchor_entity_id IS NOT NULL THEN
        SELECT domain_code INTO v_anchor_domain
        FROM entity_instances.master_entities
        WHERE id = p_anchor_entity_id;
    END IF;

    FOR v_rule IN
        SELECT r.*
        FROM compliance.rules r
        WHERE r.is_active
          AND (p_rule_codes IS NULL OR r.rule_code = ANY (p_rule_codes))
          AND (v_anchor_domain IS NULL OR r.anchor_domain_code = v_anchor_domain)
          -- Shared rules and one client's own: the fund's, else the security's.
          AND (r.client_id IS NULL OR r.client_id = COALESCE(v_client, (SELECT s.client_id FROM entity_instances.master_entities s WHERE s.id = v_security)))
        ORDER BY r.rule_code
    LOOP
        v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
        IF v_version.id IS NULL OR COALESCE(v_version.metadata->>'logic', '') IS DISTINCT FROM 'composite_ratio' THEN
            CONTINUE;
        END IF;
        v_metric := NULL;
        FOR v_term IN
            SELECT value
            FROM jsonb_array_elements(COALESCE(v_version.metadata->'numerator_terms', '[]'::JSONB))
        LOOP
            IF upper(COALESCE(v_term->>'kind', '')) IS DISTINCT FROM 'WAVG' THEN
                CONTINUE;
            END IF;
            IF upper(COALESCE(v_term->>'transform', '')) = 'YEARS_TO_DATE' THEN
                v_text := compliance.get_text_value(v_security, v_term->>'attribute', p_as_of_date, p_knowledge_date, p_source_scope);
                IF v_text IS NOT NULL THEN
                    BEGIN
                        v_metric := GREATEST((v_text::DATE - p_as_of_date)::NUMERIC / 365.25, 0);
                    EXCEPTION WHEN OTHERS THEN
                        v_metric := NULL;
                    END;
                END IF;
            ELSE
                SELECT g.val INTO v_metric
                FROM compliance.get_numeric_values(
                    ARRAY[v_security], v_term->>'attribute', p_as_of_date, p_knowledge_date, p_source_scope
                ) AS g
                LIMIT 1;
            END IF;
            rule_code := v_rule.rule_code;
            metric := v_metric;
            RETURN NEXT;
            EXIT;
        END LOOP;
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION compliance.evaluate_pre_trade(p_anchor_entity_id uuid, p_scenario_code character varying, p_as_of_date date, p_rule_codes text[] DEFAULT NULL::text[], p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying)
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, baseline_value numeric, scenario_value numeric, baseline_status character varying, scenario_status character varying, verdict text, approved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_base_run UUID;
    v_scen_run UUID;
    v_row RECORD;
    v_bfail BOOLEAN;
    v_sfail BOOLEAN;
    v_verdict TEXT;
    v_ok BOOLEAN;
BEGIN
    -- A signed-in caller may test only a fund they can read. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
    IF p_scenario_code IS NULL OR btrim(p_scenario_code) = '' THEN
        RAISE EXCEPTION 'A pre-trade check needs a scenario code';
    END IF;

    FOR v_rule IN
        SELECT r.*
        FROM compliance.rules r
        WHERE r.is_active
          AND (p_rule_codes IS NULL OR r.rule_code = ANY(p_rule_codes))
          -- Shared rules and the fund's client's own; never another client's.
          AND (r.client_id IS NULL OR r.client_id = (SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id))
        ORDER BY r.rule_code
    LOOP
        v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
        IF v_version.id IS NULL THEN
            CONTINUE;
        END IF;
        IF p_rule_codes IS NULL AND COALESCE(v_version.metadata ->> 'pre_trade', '') <> 'true' THEN
            CONTINUE;
        END IF;

        v_base_run := compliance.evaluate_rule(v_rule.rule_code, p_as_of_date, p_knowledge_date, p_source_scope, NULL, p_anchor_entity_id, NULL);
        v_scen_run := compliance.evaluate_rule(v_rule.rule_code, p_as_of_date, p_knowledge_date, p_source_scope, NULL, p_anchor_entity_id, p_scenario_code);

        FOR v_row IN
            SELECT COALESCE(b.group_by_value, s.group_by_value) AS grp,
                   COALESCE(s.limit_direction, b.limit_direction) AS dir,
                   b.computed_value AS bv, s.computed_value AS sv,
                   b.status AS bs, s.status AS ss
            FROM (SELECT * FROM compliance.rule_evaluation_results
                  WHERE run_id = v_base_run AND anchor_entity_id = p_anchor_entity_id) b
            FULL JOIN (SELECT * FROM compliance.rule_evaluation_results
                       WHERE run_id = v_scen_run AND anchor_entity_id = p_anchor_entity_id) s
              ON COALESCE(b.group_by_value, '') = COALESCE(s.group_by_value, '')
        LOOP
            v_bfail := COALESCE(v_row.bs, '') = 'HARD_BREACH';
            v_sfail := COALESCE(v_row.ss, '') = 'HARD_BREACH';

            IF v_row.ss IS NULL THEN
                v_verdict := 'NO_CHANGE';
                v_ok := TRUE;
            ELSIF v_row.ss = 'NO_DATA' THEN
                v_verdict := 'NO_DATA';
                v_ok := COALESCE(v_row.bs, 'NO_DATA') = 'NO_DATA';
            ELSIF NOT v_sfail AND NOT v_bfail THEN
                v_verdict := 'PASS';
                v_ok := TRUE;
            ELSIF v_sfail AND NOT v_bfail THEN
                v_verdict := 'NEW_BREACH';
                v_ok := FALSE;
            ELSIF NOT v_sfail AND v_bfail THEN
                v_verdict := 'CURED';
                v_ok := TRUE;
            ELSIF v_row.bv IS NULL OR v_row.sv IS NULL OR v_row.sv = v_row.bv THEN
                v_verdict := 'MAINTAINS';
                v_ok := TRUE;
            ELSIF (v_row.dir = 'MAX' AND v_row.sv > v_row.bv) OR (v_row.dir = 'MIN' AND v_row.sv < v_row.bv) THEN
                v_verdict := 'DETERIORATES';
                v_ok := FALSE;
            ELSE
                v_verdict := 'IMPROVES';
                v_ok := TRUE;
            END IF;

            RETURN QUERY SELECT v_rule.rule_code::VARCHAR, v_version.rule_name::VARCHAR, v_row.grp::TEXT,
                                v_row.dir::VARCHAR, v_row.bv, v_row.sv,
                                v_row.bs::VARCHAR, v_row.ss::VARCHAR, v_verdict, v_ok;
        END LOOP;
    END LOOP;
END;
$function$;

-- For server code that runs a rule for one client with no anchor (the worker's
-- scheduled compliance runs): the code is read in that client.
CREATE OR REPLACE FUNCTION compliance.evaluate_rule_for_client(
    p_client_id UUID,
    p_rule_code CHARACTER VARYING,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now()
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
BEGIN
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'A client is required' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('compliance.client_id', p_client_id::text, TRUE);
    RETURN compliance.evaluate_rule(p_rule_code, p_as_of_date, p_knowledge_date);
END;
$$;
REVOKE ALL ON FUNCTION compliance.evaluate_rule_for_client(UUID, CHARACTER VARYING, DATE, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compliance.evaluate_rule_for_client(UUID, CHARACTER VARYING, DATE, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
