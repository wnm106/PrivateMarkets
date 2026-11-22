-- Compliance: keep each client's results, limits and what-ifs to that client.
--
-- The rule engine runs as SECURITY DEFINER so it can read positions and write
-- results in bulk. It took fund and security ids on trust, so a signed-in user
-- of one client could score, read capacities for, or file an audit entry against
-- another client's fund. Several tables that hold per-fund data were readable
-- by everyone.
--
-- Each function body below is the one already in the database with a check
-- added as its first statement. Server code (the job worker, the service role)
-- is trusted and is not affected.

-- ============================================================
-- The engine enumerates funds in one place
-- ============================================================
-- evaluate_rule, evaluate_rule_all_funds, evaluate_rules_for_funds and
-- fund_security_capacities all take their funds from here. For a signed-in
-- caller the list is cut to the funds that caller can read, so a rule run by a
-- user covers that user's funds and no others.
CREATE OR REPLACE FUNCTION compliance.get_anchor_entities(p_rule_id uuid, p_as_of_date date, p_knowledge_date timestamp with time zone)
 RETURNS TABLE(entity_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'tenancy', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
    v_backend BOOLEAN := tenancy.is_backend_caller();
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE id = p_rule_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH include_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE'
    ),
    include_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE' AND sa.include_children = TRUE
    ),
    exclude_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE'
    ),
    exclude_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE' AND sa.include_children = TRUE
    ),
    candidate AS (
        SELECT me.id AS entity_id
        FROM entity_instances.master_entities me
        WHERE me.domain_code = v_rule.anchor_domain_code
          AND me.is_active = TRUE
          -- A signed-in caller's run covers only the funds that caller can read.
          AND (v_backend OR me.id IN (SELECT tenancy.readable_entity_ids()))
          AND (
                v_rule.applies_to_all = TRUE
                OR me.id IN (SELECT entity_id FROM include_direct)
                OR me.id IN (SELECT entity_id FROM include_cascaded)
          )
    )
    SELECT c.entity_id
    FROM candidate c
    WHERE c.entity_id NOT IN (SELECT entity_id FROM exclude_direct)
      AND c.entity_id NOT IN (SELECT entity_id FROM exclude_cascaded);
END;
$$;

-- ============================================================
-- Functions that took a fund, security or result id on trust
-- ============================================================
-- compliance.fund_security_capacities gets the same check in
-- 20261121000000_reconcile_audit_with_master.sql, on the newer body that returns
-- each rule's reading (20261120213000). Replacing it here with the older body
-- would fail where the newer one exists: its return type differs.

CREATE OR REPLACE FUNCTION compliance.measure_line_contributors(p_result_id uuid)
 RETURNS TABLE(amount_side text, amount_order integer, amount_label text, amount_kind text, amount_sign integer, entity_id uuid, amount_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
    r compliance.rule_evaluation_results;
    v_side text;
    v_term jsonb;
    v_ord integer;
    v_ids uuid[];
    v_rd record;
BEGIN
    -- A result is readable by whoever can read the fund it was scored for.
    IF NOT tenancy.is_backend_caller() AND EXISTS (
        SELECT 1 FROM compliance.rule_evaluation_results res
        WHERE res.id = p_result_id AND NOT tenancy.has_entity_access(res.anchor_entity_id, 'READ')
    ) THEN
        RAISE EXCEPTION 'You do not have access to this record' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO r FROM compliance.rule_evaluation_results WHERE id = p_result_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    FOREACH v_side IN ARRAY ARRAY['NUMERATOR', 'DENOMINATOR'] LOOP
        FOR v_term, v_ord IN
            SELECT e.term, e.ord::integer
            FROM jsonb_array_elements(compliance.measure_line_terms(r.rule_version_id, v_side)) WITH ORDINALITY AS e(term, ord)
        LOOP
            v_ids := compliance.clo_term_ids(
                r.anchor_entity_id, v_term -> 'path', v_term -> 'where',
                r.as_of_date, r.knowledge_date, r.source_scope, NULL
            );
            IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
                CONTINUE;
            END IF;

            SELECT * INTO v_rd FROM compliance.resolve_dimension(r.as_of_date, r.knowledge_date, r.source_scope, v_term -> 'dimension');

            IF jsonb_typeof(v_term -> 'expression') = 'object' THEN
                RETURN QUERY
                SELECT v_side, v_ord, v_term ->> 'label', upper(COALESCE(v_term ->> 'kind', 'SUM')),
                       COALESCE((v_term ->> 'sign')::integer, 1), ids.id,
                       CASE WHEN q.txt ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN q.txt::numeric END
                FROM unnest(v_ids) AS ids(id)
                CROSS JOIN LATERAL (
                    SELECT compliance.eval_operand(ids.id, v_term -> 'expression', r.as_of_date, r.knowledge_date, r.source_scope, '{}'::jsonb) AS txt
                ) AS q;
            ELSE
                RETURN QUERY
                SELECT v_side, v_ord, v_term ->> 'label', upper(COALESCE(v_term ->> 'kind', 'SUM')),
                       COALESCE((v_term ->> 'sign')::integer, 1), g.entity_id, g.val
                FROM compliance.get_numeric_values(v_ids, v_term ->> 'attribute', v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) AS g;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.record_order_audit(p_order_id uuid, p_trade_id uuid, p_action character varying, p_snapshot jsonb, p_user_id uuid, p_status character varying, p_event_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'pg_temp'
AS $$
DECLARE
    v_id UUID;
    v_event TIMESTAMPTZ := COALESCE(p_event_at, NOW());
BEGIN
    -- A signed-in caller records an audit entry only for an order or trade they
    -- can edit, and only under their own name. Server code is trusted.
    IF NOT tenancy.is_backend_caller() THEN
        PERFORM tenancy.assert_entity_access(COALESCE(p_order_id, p_trade_id), 'WRITE');
        IF p_order_id IS NOT NULL AND p_trade_id IS NOT NULL THEN
            PERFORM tenancy.assert_entity_access(p_trade_id, 'WRITE');
        END IF;
        p_user_id := auth.uid();
    END IF;
    INSERT INTO compliance.compliance_audit_log (
        order_entity_id, trade_entity_id, action, snapshot, user_id,
        compliance_status, event_at, retain_until
    ) VALUES (
        p_order_id, p_trade_id, p_action, COALESCE(p_snapshot, '{}'::jsonb), p_user_id,
        p_status, v_event, v_event + INTERVAL '6 years'
    )
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.security_test_metrics(p_security_id uuid, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[], p_anchor_entity_id uuid DEFAULT NULL::uuid, p_security_code character varying DEFAULT NULL::character varying)
 RETURNS TABLE(rule_code character varying, metric numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
    v_security UUID;
    v_domain TEXT;
    v_anchor_domain TEXT;
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_term JSONB;
    v_metric NUMERIC;
    v_text TEXT;
BEGIN
    -- A signed-in caller may test only a security and fund they can read. A
    -- security named by code is looked up across every client, so it is
    -- checked the same way as one named by id. Server code is trusted.
    IF NOT tenancy.is_backend_caller() THEN
        IF p_security_id IS NOT NULL OR p_security_code IS NOT NULL THEN
            PERFORM tenancy.assert_entity_access(
                COALESCE(p_security_id, (SELECT sec.id FROM entity_instances.master_entities sec WHERE sec.entity_code = p_security_code)),
                'READ'
            );
        END IF;
        IF p_anchor_entity_id IS NOT NULL THEN
            PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
        END IF;
    END IF;
    v_security := p_security_id;
    IF v_security IS NULL AND p_security_code IS NOT NULL THEN
        SELECT id INTO v_security
        FROM entity_instances.master_entities
        WHERE entity_code = p_security_code;
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
$$;

CREATE OR REPLACE FUNCTION compliance.proforma_snapshot(p_anchor_entity_id uuid, p_legs jsonb DEFAULT '[]'::jsonb, p_as_of_date date DEFAULT CURRENT_DATE, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[])
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, numerator_value numeric, denominator_value numeric, computed_value numeric, soft_limit_value numeric, hard_limit_value numeric, status character varying, result_unit character varying, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $$
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
    -- they can read. A security named by code is looked up across every client,
    -- so the code alone proves nothing. Server code is trusted.
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
$$;

CREATE OR REPLACE FUNCTION compliance.evaluate_proforma(p_anchor_entity_id uuid, p_legs jsonb, p_as_of_date date DEFAULT CURRENT_DATE, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[])
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, baseline_value numeric, scenario_value numeric, baseline_status character varying, scenario_status character varying, hard_limit_value numeric, soft_limit_value numeric, baseline_numerator numeric, scenario_numerator numeric, baseline_denominator numeric, scenario_denominator numeric, verdict text, approved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'pg_temp'
AS $$
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
    DELETE FROM compliance_pf_base;
    DELETE FROM compliance_pf_scenario;

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
$$;

CREATE OR REPLACE FUNCTION compliance.evaluate_pre_trade(p_anchor_entity_id uuid, p_scenario_code character varying, p_as_of_date date, p_rule_codes text[] DEFAULT NULL::text[], p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying)
 RETURNS TABLE(rule_code character varying, rule_name character varying, group_by_value text, limit_direction character varying, baseline_value numeric, scenario_value numeric, baseline_status character varying, scenario_status character varying, verdict text, approved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $$
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
$$;

-- ============================================================
-- Tables that hold one client's data but were readable by all
-- ============================================================

-- Runs a caller may see: their own, or one that scored a fund they can read.
-- A function, so the lookup runs once per query and not once per row.
CREATE OR REPLACE FUNCTION compliance.readable_run_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
    SELECT r.id
    FROM compliance.rule_evaluation_runs r
    WHERE r.triggered_by = auth.uid()
    UNION
    SELECT res.run_id
    FROM compliance.rule_evaluation_results res
    WHERE res.anchor_entity_id IN (SELECT tenancy.readable_entity_ids());
$$;
REVOKE ALL ON FUNCTION compliance.readable_run_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.readable_run_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS "Compliance runs readable by authenticated" ON compliance.rule_evaluation_runs;
CREATE POLICY "Compliance runs readable per fund access" ON compliance.rule_evaluation_runs
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR id IN (SELECT compliance.readable_run_ids()));

-- A threshold with no fund is the rule's default and is shared. One set for a
-- fund belongs to that fund's client.
DROP POLICY IF EXISTS "Compliance thresholds readable by authenticated" ON compliance.rule_thresholds;
CREATE POLICY "Compliance thresholds readable per fund access" ON compliance.rule_thresholds
    FOR SELECT TO authenticated
    USING (
        entity_id IS NULL
        OR tenancy.is_tenant_admin()
        OR entity_id IN (SELECT tenancy.readable_entity_ids())
    );

DROP POLICY IF EXISTS audit_log_read ON compliance.compliance_audit_log;
CREATE POLICY audit_log_read ON compliance.compliance_audit_log
    FOR SELECT TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR order_entity_id IN (SELECT tenancy.readable_entity_ids())
        OR trade_entity_id IN (SELECT tenancy.readable_entity_ids())
    );

-- The recalculation queue names the records waiting on a recalculation.
DROP POLICY IF EXISTS calc_invalidations_read ON golden_master.calc_invalidations;
CREATE POLICY calc_invalidations_read ON golden_master.calc_invalidations
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR entity_id IN (SELECT tenancy.readable_entity_ids()));

-- A rule owned by a client is that client's. Its versions, conditions and
-- measure lines follow the rule.
DROP POLICY IF EXISTS "Compliance rules readable by authenticated" ON compliance.rules;
CREATE POLICY "Compliance rules readable per client" ON compliance.rules
    FOR SELECT TO authenticated
    USING (tenancy.schema_row_visible(client_id));

DROP POLICY IF EXISTS "Compliance rule versions readable by authenticated" ON compliance.rule_versions;
CREATE POLICY "Compliance rule versions readable per rule" ON compliance.rule_versions
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM compliance.rules r WHERE r.id = rule_versions.rule_id));

DROP POLICY IF EXISTS "Compliance rule conditions readable by authenticated" ON compliance.rule_conditions;
CREATE POLICY "Compliance rule conditions readable per rule" ON compliance.rule_conditions
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM compliance.rule_versions v WHERE v.id = rule_conditions.rule_version_id));

DROP POLICY IF EXISTS "Compliance measure lines readable by authenticated" ON compliance.rule_measure_lines;
CREATE POLICY "Compliance measure lines readable per rule" ON compliance.rule_measure_lines
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM compliance.rule_versions v WHERE v.id = rule_measure_lines.rule_version_id));

-- ============================================================
-- Client-owned catalog items, and the rows that hang off them
-- ============================================================
-- A template, attribute, dashboard, narrative or record experience can belong
-- to one client. The item itself was hidden from other clients, or meant to be;
-- its child rows (a template's source excerpts and sections, an attribute's
-- aliases and calculation) were readable by everyone. Each child now follows
-- its parent: the EXISTS reads the parent through the parent's own policy.

DROP POLICY IF EXISTS "Dashboards readable by authenticated" ON public.dashboard_templates;
CREATE POLICY "Dashboards readable per client" ON public.dashboard_templates
    FOR SELECT TO authenticated
    USING (tenancy.schema_row_visible(client_id));

DROP POLICY IF EXISTS "Narratives readable by authenticated" ON public.narrative_templates;
CREATE POLICY "Narratives readable per client" ON public.narrative_templates
    FOR SELECT TO authenticated
    USING (tenancy.schema_row_visible(client_id));

DROP POLICY IF EXISTS "Record experiences readable by authenticated" ON public.record_experiences;
CREATE POLICY "Record experiences readable per client" ON public.record_experiences
    FOR SELECT TO authenticated
    USING (tenancy.schema_row_visible(client_id));

DROP POLICY IF EXISTS template_sources_select_authenticated ON metadata_register.template_sources;
CREATE POLICY template_sources_select_scoped ON metadata_register.template_sources
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.domain_templates t WHERE t.id = template_sources.template_id));

DROP POLICY IF EXISTS template_sections_select_authenticated ON metadata_register.template_sections;
CREATE POLICY template_sections_select_scoped ON metadata_register.template_sections
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.domain_templates t WHERE t.id = template_sections.template_id));

DROP POLICY IF EXISTS "Template assignments readable by authenticated" ON metadata_register.template_attribute_assignments;
CREATE POLICY template_attribute_assignments_select_scoped ON metadata_register.template_attribute_assignments
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.domain_templates t WHERE t.id = template_attribute_assignments.template_id));

DROP POLICY IF EXISTS attribute_aliases_select_authenticated ON metadata_register.attribute_aliases;
CREATE POLICY attribute_aliases_select_scoped ON metadata_register.attribute_aliases
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.attribute_register a WHERE a.id = attribute_aliases.attribute_id));

DROP POLICY IF EXISTS calc_definitions_read ON metadata_register.calc_definitions;
CREATE POLICY calc_definitions_read ON metadata_register.calc_definitions
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.attribute_register a WHERE a.id = calc_definitions.attribute_id));

DROP POLICY IF EXISTS calc_inputs_read ON metadata_register.calc_inputs;
CREATE POLICY calc_inputs_read ON metadata_register.calc_inputs
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM metadata_register.calc_definitions d WHERE d.id = calc_inputs.calc_definition_id));

NOTIFY pgrst, 'reload schema';
