-- Proforma packages and the book they are scored against.
--
-- A proforma is any number of buys and sells scored together. Each leg is an
-- ephemeral position: positive FUNDED_PAR_AMOUNT is a buy, negative par is a
-- sell of that security. Every leg in one call shares a scenario code, so
-- strict rules (scenario_mode = 'strict') see the booked book plus the whole
-- package and nothing else. The positions and the evaluation runs are removed
-- before the function returns.
--
-- compliance.proforma_snapshot is the booked book plus those legs, one row per
-- rule and group. compliance.evaluate_proforma compares that book with the
-- package against the book without it and returns the same verdicts as
-- evaluate_pre_trade. Capacity is the largest additional par of one security
-- and is computed from these snapshots by the application
-- (packages/graphql/src/lib/compliance-capacity.ts), which solves each rule
-- from the numerator and denominator and then checks the closed form with
-- another snapshot.

-- ============================================================
-- Writes
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.write_proforma_value(
    p_entity_id UUID,
    p_attribute_code TEXT,
    p_value TEXT,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, golden_master, metadata_register, entity_instances, pg_temp
AS $$
DECLARE
    v_attribute_id UUID;
    v_data_type TEXT;
    v_numeric NUMERIC := NULL;
    v_date DATE := NULL;
    v_boolean BOOLEAN := NULL;
BEGIN
    SELECT id, data_type INTO v_attribute_id, v_data_type
    FROM metadata_register.attribute_register
    WHERE attribute_code = p_attribute_code;
    IF v_attribute_id IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN
        BEGIN
            v_numeric := p_value::NUMERIC;
        EXCEPTION WHEN OTHERS THEN
            v_numeric := NULL;
        END;
    ELSIF v_data_type = 'DATE' AND p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
        v_date := p_value::DATE;
    ELSIF v_data_type = 'BOOLEAN' THEN
        v_boolean := lower(p_value) IN ('true', 't', '1', 'yes');
    END IF;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, system_from, system_to, precedence_rank, metadata
    ) VALUES (
        p_entity_id, v_attribute_id, p_source_id, p_source_id, p_value,
        v_numeric, v_date, v_boolean,
        p_as_of_date, DATE '9999-12-31',
        p_knowledge_date - INTERVAL '1 second', TIMESTAMPTZ '9999-12-31 23:59:59+00',
        100, '{"proforma":true}'::JSONB
    );
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.cleanup_proforma(
    p_position_ids UUID[],
    p_run_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, entity_instances, pg_temp
AS $$
BEGIN
    IF p_run_ids IS NOT NULL AND array_length(p_run_ids, 1) IS NOT NULL THEN
        DELETE FROM compliance.rule_evaluation_runs WHERE id = ANY (p_run_ids);
    END IF;
    IF p_position_ids IS NOT NULL AND array_length(p_position_ids, 1) IS NOT NULL THEN
        DELETE FROM entity_instances.master_entities WHERE id = ANY (p_position_ids);
    END IF;
END;
$$;

-- Insert one hypothetical position per leg and return their ids.
-- Positive par buys the security. Negative par sells it. The caller deletes
-- the rows. On failure, rows inserted before the error are deleted here.
CREATE OR REPLACE FUNCTION compliance.materialize_proforma_legs(
    p_anchor_entity_id UUID,
    p_legs JSONB,
    p_scenario_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, entity_instances, metadata_register, golden_master, pg_temp
AS $$
DECLARE
    v_ids UUID[] := '{}'::UUID[];
    v_client UUID;
    v_source UUID;
    v_template UUID;
    v_fund_rel TEXT;
    v_sec_rel TEXT;
    v_leg JSONB;
    v_security UUID;
    v_security_code TEXT;
    v_domain TEXT;
    v_par NUMERIC;
    v_position UUID;
    v_code TEXT;
    v_attr JSONB;
    v_key TEXT;
    v_text TEXT;
BEGIN
    IF p_legs IS NULL OR jsonb_typeof(p_legs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_legs) = 0 THEN
        RETURN v_ids;
    END IF;

    SELECT client_id INTO v_client
    FROM entity_instances.master_entities
    WHERE id = p_anchor_entity_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown anchor %', p_anchor_entity_id;
    END IF;

    SELECT id INTO v_source
    FROM entity_instances.source_registry
    WHERE source_code = 'INTERNAL'
    ORDER BY precedence_rank
    LIMIT 1;
    IF v_source IS NULL THEN
        SELECT id INTO v_source
        FROM entity_instances.source_registry
        WHERE source_code = 'MANUAL'
        LIMIT 1;
    END IF;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'No INTERNAL or MANUAL source is registered';
    END IF;

    SELECT id INTO v_template
    FROM metadata_register.domain_templates
    WHERE template_code = 'POSITION_STANDARD'
    LIMIT 1;

    SELECT relationship_name INTO v_fund_rel
    FROM metadata_register.relationship_types
    WHERE relationship_code = 'POSITION_FUND';
    SELECT relationship_name INTO v_sec_rel
    FROM metadata_register.relationship_types
    WHERE relationship_code = 'POSITION_SECURITY';
    IF v_fund_rel IS NULL OR v_sec_rel IS NULL THEN
        RAISE EXCEPTION 'POSITION_FUND and POSITION_SECURITY relationship types are required';
    END IF;

    BEGIN
        FOR v_leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
            v_par := NULLIF(COALESCE(v_leg->>'par', v_leg->>'amount'), '')::NUMERIC;
            IF v_par IS NULL OR v_par = 0 THEN
                RAISE EXCEPTION 'Each proforma leg needs a non-zero par. Positive par is a buy and negative par is a sell.';
            END IF;

            v_security := NULL;
            v_security_code := NULLIF(COALESCE(v_leg->>'security_code', v_leg->>'securityCode'), '');
            IF NULLIF(COALESCE(v_leg->>'security_id', v_leg->>'securityId'), '') IS NOT NULL THEN
                v_security := NULLIF(COALESCE(v_leg->>'security_id', v_leg->>'securityId'), '')::UUID;
                SELECT entity_code, domain_code INTO v_security_code, v_domain
                FROM entity_instances.master_entities
                WHERE id = v_security;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Unknown security %', v_security;
                END IF;
            ELSIF v_security_code IS NOT NULL THEN
                SELECT id, domain_code INTO v_security, v_domain
                FROM entity_instances.master_entities
                WHERE entity_code = v_security_code;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Unknown security %', v_security_code;
                END IF;
            ELSE
                RAISE EXCEPTION 'Each proforma leg needs a security id or security code';
            END IF;
            IF v_domain IS DISTINCT FROM 'SECURITY' THEN
                RAISE EXCEPTION 'Proforma legs reference a security. % is a %', COALESCE(v_security_code, v_security::TEXT), v_domain;
            END IF;

            v_code := 'PF-' || replace(gen_random_uuid()::TEXT, '-', '');
            INSERT INTO entity_instances.master_entities (
                entity_code, domain_code, template_id, entity_name, description, client_id, metadata
            ) VALUES (
                v_code, 'POSITION', v_template,
                CASE WHEN v_par > 0 THEN 'Proforma buy ' ELSE 'Proforma sell ' END || COALESCE(v_security_code, v_code),
                'Ephemeral proforma position',
                v_client,
                jsonb_build_object('proforma', TRUE, 'scenario_code', p_scenario_code)
            ) RETURNING id INTO v_position;
            v_ids := v_ids || v_position;

            INSERT INTO entity_instances.entity_relationships (
                parent_entity_id, child_entity_id, relationship_type, relationship_code,
                is_primary, valid_from, valid_to, system_from, system_to, metadata
            ) VALUES
                (v_position, p_anchor_entity_id, v_fund_rel, 'POSITION_FUND', TRUE,
                 p_as_of_date, DATE '9999-12-31', p_knowledge_date - INTERVAL '1 second',
                 TIMESTAMPTZ '9999-12-31 23:59:59+00', '{"proforma":true}'::JSONB),
                (v_position, v_security, v_sec_rel, 'POSITION_SECURITY', TRUE,
                 p_as_of_date, DATE '9999-12-31', p_knowledge_date - INTERVAL '1 second',
                 TIMESTAMPTZ '9999-12-31 23:59:59+00', '{"proforma":true}'::JSONB);

            v_attr := v_leg->'attributes';
            IF v_attr IS NOT NULL AND jsonb_typeof(v_attr) = 'object' THEN
                FOR v_key, v_text IN
                    SELECT key, CASE jsonb_typeof(value)
                        WHEN 'string' THEN value #>> '{}'
                        WHEN 'number' THEN value #>> '{}'
                        WHEN 'boolean' THEN value #>> '{}'
                        ELSE NULL
                    END
                    FROM jsonb_each(v_attr)
                LOOP
                    IF v_text IS NULL THEN
                        CONTINUE;
                    END IF;
                    IF v_key IN (
                        'POSITION_IS_HYPOTHETICAL', 'POSITION_SCENARIO_CODE', 'FUNDED_PAR_AMOUNT',
                        'MARKET_VALUE', 'POSITION_ALLOCATION_ROLE'
                    ) THEN
                        CONTINUE;
                    END IF;
                    IF NOT compliance.write_proforma_value(
                        v_position, v_key, v_text, p_as_of_date, p_knowledge_date, v_source) THEN
                        RAISE EXCEPTION 'Attribute % is not registered', v_key;
                    END IF;
                END LOOP;
            END IF;

            IF NOT compliance.write_proforma_value(v_position, 'POSITION_IS_HYPOTHETICAL', 'true', p_as_of_date, p_knowledge_date, v_source) THEN
                RAISE EXCEPTION 'Attribute POSITION_IS_HYPOTHETICAL is not registered';
            END IF;
            IF NOT compliance.write_proforma_value(v_position, 'POSITION_SCENARIO_CODE', p_scenario_code, p_as_of_date, p_knowledge_date, v_source) THEN
                RAISE EXCEPTION 'Attribute POSITION_SCENARIO_CODE is not registered';
            END IF;
            IF NOT compliance.write_proforma_value(v_position, 'FUNDED_PAR_AMOUNT', v_par::TEXT, p_as_of_date, p_knowledge_date, v_source) THEN
                RAISE EXCEPTION 'Attribute FUNDED_PAR_AMOUNT is not registered';
            END IF;
            PERFORM compliance.write_proforma_value(v_position, 'MARKET_VALUE', v_par::TEXT, p_as_of_date, p_knowledge_date, v_source);
            PERFORM compliance.write_proforma_value(v_position, 'POSITION_ALLOCATION_ROLE', 'PROPOSAL', p_as_of_date, p_knowledge_date, v_source);
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        PERFORM compliance.cleanup_proforma(v_ids, NULL);
        RAISE;
    END;

    RETURN v_ids;
END;
$$;

-- ============================================================
-- Snapshot: booked book plus the legs
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.proforma_snapshot(
    p_anchor_entity_id UUID,
    p_legs JSONB DEFAULT '[]'::JSONB,
    p_as_of_date DATE DEFAULT CURRENT_DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_source_scope VARCHAR DEFAULT NULL,
    p_rule_codes TEXT[] DEFAULT NULL
) RETURNS TABLE (
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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, entity_instances, metadata_register, golden_master, tenancy, pg_temp
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

COMMENT ON FUNCTION compliance.proforma_snapshot(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[]) IS
    'Booked book plus any number of proforma buys and sells for one anchor. Positive par buys a security and negative par sells it. Ephemeral positions and runs are deleted before return.';

-- ============================================================
-- Package verdict: baseline book vs the same book plus every leg
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.evaluate_proforma(
    p_anchor_entity_id UUID,
    p_legs JSONB,
    p_as_of_date DATE DEFAULT CURRENT_DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_source_scope VARCHAR DEFAULT NULL,
    p_rule_codes TEXT[] DEFAULT NULL
) RETURNS TABLE (
    rule_code VARCHAR,
    rule_name VARCHAR,
    group_by_value TEXT,
    limit_direction VARCHAR,
    baseline_value NUMERIC,
    scenario_value NUMERIC,
    baseline_status VARCHAR,
    scenario_status VARCHAR,
    hard_limit_value NUMERIC,
    soft_limit_value NUMERIC,
    baseline_numerator NUMERIC,
    scenario_numerator NUMERIC,
    baseline_denominator NUMERIC,
    scenario_denominator NUMERIC,
    verdict TEXT,
    approved BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, pg_temp
AS $$
DECLARE
    v_dir TEXT;
    v_base_fail BOOLEAN;
    v_scen_fail BOOLEAN;
    v_verdict TEXT;
    v_ok BOOLEAN;
    v_row RECORD;
BEGIN
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

COMMENT ON FUNCTION compliance.evaluate_proforma(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[]) IS
    'Maintain-or-improve check for any number of buys and sells at once. Positive par buys a security and negative par sells it. Approved is false when the package creates or deepens a hard breach.';

-- The security's own metric for each par-weighted average rule. A row with a
-- null metric means the rule is a weighted average and the security has no value.
CREATE OR REPLACE FUNCTION compliance.security_test_metrics(
    p_security_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_source_scope VARCHAR DEFAULT NULL,
    p_rule_codes TEXT[] DEFAULT NULL,
    p_anchor_entity_id UUID DEFAULT NULL,
    p_security_code VARCHAR DEFAULT NULL
) RETURNS TABLE (
    rule_code VARCHAR,
    metric NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO compliance, entity_instances, pg_temp
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

COMMENT ON FUNCTION compliance.security_test_metrics(UUID, DATE, TIMESTAMPTZ, VARCHAR, TEXT[], UUID, VARCHAR) IS
    'Par-weighted-average rules and the metric this security would contribute. A null metric means the security has no value for that test.';

REVOKE ALL ON FUNCTION compliance.write_proforma_value(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.cleanup_proforma(UUID[], UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.materialize_proforma_legs(UUID, JSONB, VARCHAR, DATE, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compliance.write_proforma_value(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION compliance.cleanup_proforma(UUID[], UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION compliance.materialize_proforma_legs(UUID, JSONB, VARCHAR, DATE, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION compliance.proforma_snapshot(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.evaluate_proforma(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.security_test_metrics(UUID, DATE, TIMESTAMPTZ, VARCHAR, TEXT[], UUID, VARCHAR) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
