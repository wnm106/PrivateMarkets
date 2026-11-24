-- The pro forma and the deal capacity observations clear their temp tables with a
-- bare DELETE. The API runs with safe updates on, which refuses a DELETE without a
-- WHERE clause, so every call from a signed-in user failed with "DELETE requires a
-- WHERE clause". evaluate_rule already clears its temp table with WHERE TRUE.
--
-- Both functions are redefined as they are in force on the hosted project, with
-- only those DELETE statements changed.

CREATE OR REPLACE FUNCTION compliance.evaluate_proforma(p_anchor_entity_id uuid, p_legs jsonb, p_as_of_date date DEFAULT CURRENT_DATE, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[])
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, baseline_value numeric, scenario_value numeric, baseline_status character varying, scenario_status character varying, hard_limit_value numeric, soft_limit_value numeric, baseline_numerator numeric, scenario_numerator numeric, baseline_denominator numeric, scenario_denominator numeric, verdict text, approved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'pg_temp'
AS $function$
DECLARE
    v_dir TEXT;
    v_base_fail BOOLEAN;
    v_scen_fail BOOLEAN;
    v_verdict TEXT;
    v_ok BOOLEAN;
    v_row RECORD;
BEGIN
    -- A signed-in caller may test only a fund they can read. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
    IF p_legs IS NULL OR jsonb_typeof(p_legs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_legs) = 0 THEN
        RAISE EXCEPTION 'A proforma needs at least one buy or sell';
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS compliance_pf_base (
        rule_code VARCHAR,
        rule_name VARCHAR,
        group_by_value TEXT,
        limit_direction VARCHAR,
        numerator_value NUMERIC,
        denominator_value NUMERIC,
        computed_value NUMERIC,
        soft_limit_value NUMERIC,
        hard_limit_value NUMERIC,
        status VARCHAR,
        result_unit VARCHAR,
        error_message TEXT
    ) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS compliance_pf_scenario (
        LIKE compliance_pf_base
    ) ON COMMIT DROP;
    DELETE FROM compliance_pf_base WHERE TRUE;
    DELETE FROM compliance_pf_scenario WHERE TRUE;

    INSERT INTO compliance_pf_base
    SELECT * FROM compliance.proforma_snapshot(
        p_anchor_entity_id, '[]'::JSONB, p_as_of_date, p_knowledge_date, p_source_scope, p_rule_codes);
    INSERT INTO compliance_pf_scenario
    SELECT * FROM compliance.proforma_snapshot(
        p_anchor_entity_id, p_legs, p_as_of_date, p_knowledge_date, p_source_scope, p_rule_codes);

    FOR v_row IN
        SELECT COALESCE(b.rule_code, s.rule_code) AS rule_code,
               COALESCE(s.rule_name, b.rule_name) AS rule_name,
               COALESCE(s.group_by_value, b.group_by_value) AS group_by_value,
               COALESCE(s.limit_direction, b.limit_direction) AS limit_direction,
               b.computed_value AS baseline_value,
               s.computed_value AS scenario_value,
               b.status AS baseline_status,
               s.status AS scenario_status,
               COALESCE(s.hard_limit_value, b.hard_limit_value) AS hard_limit_value,
               COALESCE(s.soft_limit_value, b.soft_limit_value) AS soft_limit_value,
               b.numerator_value AS baseline_numerator,
               s.numerator_value AS scenario_numerator,
               b.denominator_value AS baseline_denominator,
               s.denominator_value AS scenario_denominator,
               COALESCE(b.error_message, s.error_message) AS error_message
        FROM compliance_pf_base b
        FULL JOIN compliance_pf_scenario s
          ON b.rule_code = s.rule_code
         AND COALESCE(b.group_by_value, '') = COALESCE(s.group_by_value, '')
    LOOP
        v_dir := COALESCE(v_row.limit_direction, 'MAX');
        v_base_fail := COALESCE(v_row.baseline_status, '') = 'HARD_BREACH';
        v_scen_fail := COALESCE(v_row.scenario_status, '') = 'HARD_BREACH';

        IF v_row.error_message IS NOT NULL OR v_row.scenario_status = 'ERROR' OR v_row.baseline_status = 'ERROR' THEN
            v_verdict := 'NO_DATA';
            v_ok := FALSE;
        ELSIF v_row.scenario_status IS NULL THEN
            v_verdict := 'NO_CHANGE';
            v_ok := TRUE;
        ELSIF v_row.scenario_status = 'NO_DATA' THEN
            v_verdict := 'NO_DATA';
            v_ok := COALESCE(v_row.baseline_status, 'NO_DATA') = 'NO_DATA';
        ELSIF NOT v_scen_fail AND NOT v_base_fail THEN
            v_verdict := 'PASS';
            v_ok := TRUE;
        ELSIF v_scen_fail AND NOT v_base_fail THEN
            v_verdict := 'NEW_BREACH';
            v_ok := FALSE;
        ELSIF NOT v_scen_fail AND v_base_fail THEN
            v_verdict := 'CURED';
            v_ok := TRUE;
        ELSIF v_row.baseline_value IS NULL OR v_row.scenario_value IS NULL OR v_row.scenario_value = v_row.baseline_value THEN
            v_verdict := 'MAINTAINS';
            v_ok := TRUE;
        ELSIF (v_dir = 'MAX' AND v_row.scenario_value > v_row.baseline_value)
           OR (v_dir = 'MIN' AND v_row.scenario_value < v_row.baseline_value) THEN
            v_verdict := 'DETERIORATES';
            v_ok := FALSE;
        ELSE
            v_verdict := 'IMPROVES';
            v_ok := TRUE;
        END IF;

        rule_code := v_row.rule_code;
        rule_name := v_row.rule_name;
        group_by_value := v_row.group_by_value;
        limit_direction := v_row.limit_direction;
        baseline_value := v_row.baseline_value;
        scenario_value := v_row.scenario_value;
        baseline_status := v_row.baseline_status;
        scenario_status := v_row.scenario_status;
        hard_limit_value := v_row.hard_limit_value;
        soft_limit_value := v_row.soft_limit_value;
        baseline_numerator := v_row.baseline_numerator;
        scenario_numerator := v_row.scenario_numerator;
        baseline_denominator := v_row.baseline_denominator;
        scenario_denominator := v_row.scenario_denominator;
        verdict := v_verdict;
        approved := v_ok;
        RETURN NEXT;
    END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION compliance.deal_capacity_observations(p_fund_ids uuid[], p_legs jsonb, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_deal_code character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[], p_all_groups boolean DEFAULT false)
 RETURNS TABLE(fund_id uuid, rule_code character varying, rule_name character varying, group_value text, group_label text, limit_direction character varying, result_unit character varying, base_numerator numeric, base_denominator numeric, base_value numeric, base_status character varying, base_soft_limit numeric, base_hard_limit numeric, probe_numerator numeric, probe_denominator numeric, probe_value numeric, probe_status character varying, probe_soft_limit numeric, probe_hard_limit numeric, probe_rank integer, contributions jsonb, rank_sensitive boolean, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
    v_scenario VARCHAR;
    v_fund UUID;
    v_plan RECORD;
    v_run UUID;
    v_runs UUID[] := '{}'::UUID[];
    v_legs UUID[] := '{}'::UUID[];
    v_single UUID[];
    v_leg_map JSONB;
    v_leg RECORD;
    v_version compliance.rule_versions;
    v_err TEXT;
BEGIN
    IF p_fund_ids IS NULL OR p_legs IS NULL OR jsonb_typeof(p_legs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_legs) = 0 THEN
        RETURN;
    END IF;

    -- The plan already chose the funds each rule covers, the way the deal's
    -- pro forma panel does, so the evaluator does not filter by enrollment again.
    PERFORM set_config('compliance.test_all_funds', 'on', TRUE);
    PERFORM set_config('statement_timeout', '20000', TRUE);
    v_scenario := COALESCE(NULLIF(split_part(COALESCE(p_deal_code, ''), '#', 1), ''), 'CAPACITY') || '#CAPACITY';

    CREATE TEMP TABLE IF NOT EXISTS cap_obs (
        phase TEXT,
        fund_id UUID,
        rule_id UUID,
        rule_version_id UUID,
        group_value TEXT,
        numerator NUMERIC,
        denominator NUMERIC,
        computed NUMERIC,
        status TEXT,
        soft_limit NUMERIC,
        hard_limit NUMERIC,
        rank_position INTEGER,
        contributing UUID[],
        contributions JSONB,
        error_message TEXT
    ) ON COMMIT DROP;
    DELETE FROM cap_obs WHERE TRUE;

    CREATE TEMP TABLE IF NOT EXISTS cap_plan ON COMMIT DROP AS
    SELECT * FROM compliance.deal_score_plans('{}'::UUID[], p_as_of_date) LIMIT 0;
    DELETE FROM cap_plan WHERE TRUE;
    INSERT INTO cap_plan
    SELECT * FROM compliance.deal_score_plans(p_fund_ids, p_as_of_date) dp
    WHERE p_rule_codes IS NULL OR dp.rule_code = ANY (p_rule_codes);

    BEGIN
        FOREACH v_fund IN ARRAY p_fund_ids LOOP
            -- The book without this deal.
            FOR v_plan IN SELECT * FROM cap_plan WHERE v_fund = ANY (anchor_ids) LOOP
                BEGIN
                    v_run := compliance.evaluate_rule(v_plan.rule_code, p_as_of_date, p_knowledge_date, NULL, NULL, v_fund, v_scenario);
                    v_runs := v_runs || v_run;
                    INSERT INTO cap_obs (phase, fund_id, rule_id, rule_version_id, group_value, numerator, denominator, computed, status, soft_limit, hard_limit, rank_position, contributing)
                    SELECT 'base', v_fund, res.rule_id, res.rule_version_id, res.group_by_value, res.numerator_value, res.denominator_value,
                           res.computed_value, res.status, res.soft_limit_value, res.hard_limit_value, res.rank_position, res.contributing_entity_ids
                    FROM compliance.rule_evaluation_results res
                    WHERE res.run_id = v_run AND res.anchor_entity_id = v_fund;
                EXCEPTION WHEN OTHERS THEN
                    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
                    INSERT INTO cap_obs (phase, fund_id, rule_id, status, error_message)
                    VALUES ('base', v_fund, v_plan.rule_id, 'ERROR', v_err);
                END;
            END LOOP;

            -- The same book with one leg of every security.
            v_legs := compliance.materialize_proforma_legs(v_fund, p_legs, v_scenario, p_as_of_date, p_knowledge_date);
            SELECT jsonb_object_agg(l.id::TEXT, jsonb_build_object(
                       'security_id', COALESCE(j.leg->>'security_id', j.leg->>'securityId'),
                       'par', NULLIF(COALESCE(j.leg->>'par', j.leg->>'amount'), '')::NUMERIC))
            INTO v_leg_map
            FROM unnest(v_legs) WITH ORDINALITY AS l(id, n)
            JOIN jsonb_array_elements(p_legs) WITH ORDINALITY AS j(leg, n) ON j.n = l.n;

            FOR v_plan IN SELECT * FROM cap_plan WHERE v_fund = ANY (anchor_ids) LOOP
                BEGIN
                    v_run := compliance.evaluate_rule(v_plan.rule_code, p_as_of_date, p_knowledge_date, NULL, NULL, v_fund, v_scenario);
                    v_runs := v_runs || v_run;
                    INSERT INTO cap_obs (phase, fund_id, rule_id, rule_version_id, group_value, numerator, denominator, computed, status, soft_limit, hard_limit, rank_position, contributing)
                    SELECT 'probe', v_fund, res.rule_id, res.rule_version_id, res.group_by_value, res.numerator_value, res.denominator_value,
                           res.computed_value, res.status, res.soft_limit_value, res.hard_limit_value, res.rank_position, res.contributing_entity_ids
                    FROM compliance.rule_evaluation_results res
                    WHERE res.run_id = v_run AND res.anchor_entity_id = v_fund;
                EXCEPTION WHEN OTHERS THEN
                    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
                    INSERT INTO cap_obs (phase, fund_id, rule_id, status, error_message)
                    VALUES ('probe', v_fund, v_plan.rule_id, 'ERROR', v_err);
                END;
            END LOOP;

            -- What each leg added to the group it landed in: its own value of
            -- the numerator attribute when the rule sums it, and of the
            -- denominator attribute when the denominator sums the book.
            FOR v_plan IN SELECT * FROM cap_plan WHERE v_fund = ANY (anchor_ids) LOOP
                v_version := compliance.resolve_rule_version(v_plan.rule_id, p_as_of_date, p_knowledge_date);
                CONTINUE WHEN v_version.id IS NULL;
                UPDATE cap_obs o
                SET contributions = sub.contribs
                FROM (
                    SELECT o2.ctid AS row_id,
                           jsonb_object_agg(v_leg_map->(leg.id::TEXT)->>'security_id', jsonb_build_object(
                               'par', (v_leg_map->(leg.id::TEXT)->>'par')::NUMERIC,
                               'numerator', CASE WHEN v_version.numerator_aggregation = 'SUM' THEN COALESCE(nv.val, 0) END,
                               'denominator', CASE
                                   WHEN v_version.denominator_attribute_code IS NULL
                                     OR v_version.denominator_source = 'ANCHOR'
                                     OR v_version.denominator_aggregation = 'VALUE'
                                     OR v_version.denominator_scope NOT IN ('ANCHOR_TOTAL', 'SAME_GROUP') THEN 0
                                   ELSE COALESCE(dv.val, 0) END)) AS contribs
                    FROM cap_obs o2
                    CROSS JOIN LATERAL unnest(o2.contributing) AS leg(id)
                    LEFT JOIN LATERAL (
                        SELECT g.val FROM compliance.get_numeric_values(ARRAY[leg.id], v_version.numerator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g LIMIT 1
                    ) nv ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT g.val FROM compliance.get_numeric_values(ARRAY[leg.id], v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                        WHERE v_version.denominator_attribute_code IS NOT NULL LIMIT 1
                    ) dv ON TRUE
                    WHERE o2.phase = 'probe' AND o2.fund_id = v_fund AND o2.rule_id = v_plan.rule_id
                      AND v_leg_map ? (leg.id::TEXT)
                    GROUP BY o2.ctid
                ) sub
                WHERE o.ctid = sub.row_id;

                -- A book-total denominator grows with every leg the rule counts,
                -- including legs that landed in another group.
                IF v_version.denominator_scope = 'ANCHOR_TOTAL'
                   AND v_version.denominator_attribute_code IS NOT NULL
                   AND v_version.denominator_source IS DISTINCT FROM 'ANCHOR'
                   AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE' THEN
                    UPDATE cap_obs o
                    SET contributions = COALESCE(o.contributions, '{}'::JSONB) || other.extra
                    FROM (
                        SELECT target.ctid AS row_id,
                               jsonb_object_agg(sec, jsonb_build_object('par', c.value->'par', 'numerator', 0, 'denominator', c.value->'denominator')) AS extra
                        FROM cap_obs target
                        JOIN cap_obs src ON src.phase = 'probe' AND src.fund_id = target.fund_id AND src.rule_id = target.rule_id
                                        AND src.ctid <> target.ctid AND src.contributions IS NOT NULL
                        CROSS JOIN LATERAL jsonb_each(src.contributions) AS c(sec, value)
                        WHERE target.phase = 'probe' AND target.fund_id = v_fund AND target.rule_id = v_plan.rule_id
                          AND NOT (COALESCE(target.contributions, '{}'::JSONB) ? c.sec)
                        GROUP BY target.ctid
                    ) other
                    WHERE o.ctid = other.row_id;
                END IF;
            END LOOP;

            PERFORM compliance.cleanup_proforma(v_legs, NULL);
            v_legs := '{}'::UUID[];

            -- A rule that moved without naming any leg as a contributor (a
            -- composite ratio) is read one leg at a time from the change it makes.
            FOR v_plan IN SELECT * FROM cap_plan WHERE v_fund = ANY (anchor_ids) LOOP
                IF NOT EXISTS (
                    SELECT 1 FROM cap_obs o WHERE o.phase = 'probe' AND o.fund_id = v_fund AND o.rule_id = v_plan.rule_id AND o.contributions IS NOT NULL
                ) AND EXISTS (
                    SELECT 1
                    FROM cap_obs p
                    LEFT JOIN cap_obs b ON b.phase = 'base' AND b.fund_id = p.fund_id AND b.rule_id = p.rule_id
                                       AND b.group_value IS NOT DISTINCT FROM p.group_value
                    WHERE p.phase = 'probe' AND p.fund_id = v_fund AND p.rule_id = v_plan.rule_id
                      AND (b.ctid IS NULL OR p.numerator IS DISTINCT FROM b.numerator OR p.denominator IS DISTINCT FROM b.denominator)
                ) THEN
                    FOR v_leg IN SELECT j.leg FROM jsonb_array_elements(p_legs) AS j(leg) LOOP
                        BEGIN
                            v_single := compliance.materialize_proforma_legs(v_fund, jsonb_build_array(v_leg.leg), v_scenario, p_as_of_date, p_knowledge_date);
                            v_run := compliance.evaluate_rule(v_plan.rule_code, p_as_of_date, p_knowledge_date, NULL, NULL, v_fund, v_scenario);
                            v_runs := v_runs || v_run;
                            UPDATE cap_obs o
                            SET contributions = COALESCE(o.contributions, '{}'::JSONB) || jsonb_build_object(
                                    COALESCE(v_leg.leg->>'security_id', v_leg.leg->>'securityId'), jsonb_build_object(
                                        'par', NULLIF(COALESCE(v_leg.leg->>'par', v_leg.leg->>'amount'), '')::NUMERIC,
                                        'numerator', COALESCE(res.numerator_value, 0) - COALESCE(b.numerator, 0),
                                        'denominator', COALESCE(res.denominator_value, 0) - COALESCE(b.denominator, 0)))
                            FROM compliance.rule_evaluation_results res
                            LEFT JOIN cap_obs b ON b.phase = 'base' AND b.fund_id = v_fund AND b.rule_id = v_plan.rule_id
                                               AND b.group_value IS NOT DISTINCT FROM res.group_by_value
                            WHERE res.run_id = v_run AND res.anchor_entity_id = v_fund
                              AND o.phase = 'probe' AND o.fund_id = v_fund AND o.rule_id = v_plan.rule_id
                              AND o.group_value IS NOT DISTINCT FROM res.group_by_value
                              AND (COALESCE(res.numerator_value, 0) <> COALESCE(b.numerator, 0)
                                   OR COALESCE(res.denominator_value, 0) <> COALESCE(b.denominator, 0));
                            PERFORM compliance.cleanup_proforma(v_single, NULL);
                        EXCEPTION WHEN OTHERS THEN
                            GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
                            UPDATE cap_obs o SET error_message = v_err
                            WHERE o.phase = 'probe' AND o.fund_id = v_fund AND o.rule_id = v_plan.rule_id;
                        END;
                    END LOOP;
                END IF;
            END LOOP;
        END LOOP;

        RETURN QUERY
        SELECT COALESCE(p.fund_id, b.fund_id),
               r.rule_code,
               COALESCE(v.rule_name, r.rule_name)::VARCHAR,
               COALESCE(p.group_value, b.group_value),
               COALESCE(r.metadata->>'group_label', ar.attribute_name)::TEXT,
               v.limit_direction::VARCHAR,
               v.result_unit::VARCHAR,
               b.numerator, b.denominator, b.computed, b.status::VARCHAR, b.soft_limit, b.hard_limit,
               p.numerator, p.denominator, p.computed, p.status::VARCHAR, p.soft_limit, p.hard_limit, p.rank_position,
               p.contributions,
               EXISTS (
                   SELECT 1 FROM compliance.rule_thresholds t
                   WHERE t.rule_id = r.id
                     AND (t.entity_id = COALESCE(p.fund_id, b.fund_id) OR t.entity_id IS NULL)
                     AND t.rank_from IS NOT NULL
                     AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
               ),
               COALESCE(p.error_message, b.error_message)
        FROM (SELECT * FROM cap_obs WHERE phase = 'probe') p
        FULL JOIN (SELECT * FROM cap_obs WHERE phase = 'base') b
          ON b.fund_id = p.fund_id AND b.rule_id = p.rule_id AND b.group_value IS NOT DISTINCT FROM p.group_value
        JOIN compliance.rules r ON r.id = COALESCE(p.rule_id, b.rule_id)
        LEFT JOIN compliance.rule_versions v ON v.id = COALESCE(p.rule_version_id, b.rule_version_id)
        LEFT JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.group_by_attribute_code
        WHERE p_all_groups
           OR p.contributions IS NOT NULL
           OR COALESCE(p.error_message, b.error_message) IS NOT NULL
           OR p.status IS DISTINCT FROM b.status;

        PERFORM compliance.cleanup_proforma(v_legs, v_runs);
    EXCEPTION WHEN OTHERS THEN
        PERFORM compliance.cleanup_proforma(v_legs, v_runs);
        RAISE;
    END;
END;
$function$
;
