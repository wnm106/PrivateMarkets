-- Pro forma and investment capacity for signed-in users.
--
-- Three problems kept a signed-in user from scoring a hypothetical trade; the
-- service role saw none of them.
--
-- 1. Cleanup was refused. cleanup_proforma deleted the hypothetical position
--    while it still had values and links, and guard_entity_delete refuses that
--    for any caller that is not the backend. It now removes the position's
--    values and links first, and only for positions marked as pro forma.
-- 2. The trade was invisible. The value and link guards stamp a signed-in
--    insert as known now(), which is later than the Knowledge date the caller
--    passed, so the evaluation at that date did not see the trade.
--    materialize_proforma_legs is now a trusted writer for its own inserts (the
--    mark load_batch_revert already uses), and the link guard honours the mark
--    as the value guard does.
-- 3. It was slow. proforma_snapshot checked access to each leg's security with
--    a join the planner ran has_entity_access over every record for: about
--    5.6s of a 6.5s call against an 8s statement timeout. It now finds each
--    leg's security first and checks that one record.

CREATE OR REPLACE FUNCTION entity_instances.guard_relationship_rows()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'entity_instances', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
BEGIN
    IF tenancy.is_backend_caller()
       OR COALESCE(current_setting('golden_master.trusted_writer', TRUE), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.system_from := now();
        IF NEW.system_to IS DISTINCT FROM v_open THEN
            RAISE EXCEPTION 'A new link is current knowledge. Past knowledge cannot be written.' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - 'system_to' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'system_to' - 'updated_at') THEN
        RAISE EXCEPTION 'A recorded link cannot be changed. Revise it with entity_instances.revise_relationship.'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.system_to IS DISTINCT FROM OLD.system_to THEN
        IF OLD.system_to IS DISTINCT FROM v_open THEN
            RAISE EXCEPTION 'A link that has ended cannot be changed' USING ERRCODE = '42501';
        END IF;
        NEW.system_to := now();
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION compliance.materialize_proforma_legs(p_anchor_entity_id uuid, p_legs jsonb, p_scenario_code character varying, p_as_of_date date, p_knowledge_date timestamp with time zone)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'pg_temp'
AS $function$
DECLARE
    v_ids UUID[] := '{}'::UUID[];
    v_client UUID;
    v_source UUID;
    v_template UUID;
    v_fund_rel TEXT;
    v_sec_rel TEXT;
    v_tranche_rel TEXT;
    v_leg JSONB;
    v_security UUID;
    v_security_code TEXT;
    v_tranche UUID;
    v_unfunded BOOLEAN;
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
    SELECT relationship_name INTO v_tranche_rel
    FROM metadata_register.relationship_types
    WHERE relationship_code = 'POSITION_TRANCHE';
    IF v_fund_rel IS NULL OR v_sec_rel IS NULL THEN
        RAISE EXCEPTION 'POSITION_FUND and POSITION_SECURITY relationship types are required';
    END IF;

    -- A hypothetical position is known as of the pro forma's Knowledge date, so
    -- the evaluation at that date sees it. The row guards stamp a signed-in
    -- write as known now, which is later than that date; this function is a
    -- trusted writer for the inserts below and clears the mark when it is done.
    PERFORM set_config('golden_master.trusted_writer', 'on', TRUE);
    BEGIN
        FOR v_leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
            v_par := NULLIF(COALESCE(v_leg->>'par', v_leg->>'amount'), '')::NUMERIC;
            IF v_par IS NULL OR v_par = 0 THEN
                RAISE EXCEPTION 'Each proforma leg needs a non-zero par. Positive par is a buy and negative par is a sell.';
            END IF;
            v_unfunded := lower(COALESCE(v_leg->>'unfunded', 'false')) IN ('true', 't', '1', 'yes');

            v_security := NULL;
            v_security_code := NULLIF(COALESCE(v_leg->>'security_code', v_leg->>'securityCode'), '');
            IF NULLIF(COALESCE(v_leg->>'security_id', v_leg->>'securityId'), '') IS NOT NULL THEN
                v_security := NULLIF(COALESCE(v_leg->>'security_id', v_leg->>'securityId'), '')::UUID;
                -- Only the fund's own client's securities: an id from another client is unknown here.
                SELECT entity_code, domain_code INTO v_security_code, v_domain
                FROM entity_instances.master_entities
                WHERE id = v_security AND client_id = v_client;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Unknown security %', v_security;
                END IF;
            ELSIF v_security_code IS NOT NULL THEN
                -- A code names a record within one client. Read it in the fund's client.
                SELECT id, domain_code INTO v_security, v_domain
                FROM entity_instances.master_entities
                WHERE entity_code = v_security_code AND client_id = v_client;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Unknown security %', v_security_code;
                END IF;
            ELSE
                RAISE EXCEPTION 'Each proforma leg needs a security id or security code';
            END IF;
            IF v_domain IS DISTINCT FROM 'SECURITY' THEN
                RAISE EXCEPTION 'Proforma legs reference a security. % is a %', COALESCE(v_security_code, v_security::TEXT), v_domain;
            END IF;

            v_tranche := NULLIF(COALESCE(v_leg->>'tranche_id', v_leg->>'trancheId'), '')::UUID;
            IF v_tranche IS NOT NULL AND v_tranche_rel IS NULL THEN
                RAISE EXCEPTION 'A leg names a tranche, but the POSITION_TRANCHE relationship type is not registered';
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
            IF v_tranche IS NOT NULL THEN
                INSERT INTO entity_instances.entity_relationships (
                    parent_entity_id, child_entity_id, relationship_type, relationship_code,
                    is_primary, valid_from, valid_to, system_from, system_to, metadata
                ) VALUES
                    (v_position, v_tranche, v_tranche_rel, 'POSITION_TRANCHE', TRUE,
                     p_as_of_date, DATE '9999-12-31', p_knowledge_date - INTERVAL '1 second',
                     TIMESTAMPTZ '9999-12-31 23:59:59+00', '{"proforma":true}'::JSONB);
            END IF;

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
                        'UNFUNDED_COMMITMENT_AMOUNT', 'MARKET_VALUE', 'POSITION_ALLOCATION_ROLE'
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
            -- An unfunded commitment is exposure (market value) but not funded par,
            -- the same split the allocation writes for a revolver or delayed draw.
            IF v_unfunded THEN
                IF NOT compliance.write_proforma_value(v_position, 'UNFUNDED_COMMITMENT_AMOUNT', v_par::TEXT, p_as_of_date, p_knowledge_date, v_source) THEN
                    RAISE EXCEPTION 'Attribute UNFUNDED_COMMITMENT_AMOUNT is not registered';
                END IF;
            ELSIF NOT compliance.write_proforma_value(v_position, 'FUNDED_PAR_AMOUNT', v_par::TEXT, p_as_of_date, p_knowledge_date, v_source) THEN
                RAISE EXCEPTION 'Attribute FUNDED_PAR_AMOUNT is not registered';
            END IF;
            PERFORM compliance.write_proforma_value(v_position, 'MARKET_VALUE', v_par::TEXT, p_as_of_date, p_knowledge_date, v_source);
            PERFORM compliance.write_proforma_value(v_position, 'POSITION_ALLOCATION_ROLE', 'PROPOSAL', p_as_of_date, p_knowledge_date, v_source);
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('golden_master.trusted_writer', '', TRUE);
        PERFORM compliance.cleanup_proforma(v_ids, NULL);
        RAISE;
    END;

    PERFORM set_config('golden_master.trusted_writer', '', TRUE);
    RETURN v_ids;
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
    v_leg JSONB;
    v_leg_id TEXT;
    v_leg_code TEXT;
    v_security UUID;
BEGIN
    -- A signed-in caller may test only a fund they can read, with securities
    -- they can read. A security named by code is read in the fund's client, as
    -- materialize_proforma_legs reads it. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_anchor_entity_id, 'READ');
    -- Each leg's security is found first and then checked, one at a time. A
    -- join that filters on has_entity_access lets the planner call it for
    -- every record before the join narrows to the leg's security.
    IF NOT tenancy.is_backend_caller()
       AND p_legs IS NOT NULL AND jsonb_typeof(p_legs) = 'array' THEN
        FOR v_leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
            v_leg_id := NULLIF(COALESCE(v_leg ->> 'security_id', v_leg ->> 'securityId'), '');
            v_leg_code := NULLIF(COALESCE(v_leg ->> 'security_code', v_leg ->> 'securityCode'), '');
            v_security := NULL;
            IF v_leg_id IS NOT NULL THEN
                SELECT sec.id INTO v_security
                FROM entity_instances.master_entities sec
                WHERE sec.id = v_leg_id::UUID;
            ELSIF v_leg_code IS NOT NULL THEN
                SELECT sec.id INTO v_security
                FROM entity_instances.master_entities sec
                WHERE sec.entity_code = v_leg_code
                  AND sec.client_id = (SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id);
            END IF;
            IF v_security IS NOT NULL AND NOT tenancy.has_entity_access(v_security, 'READ') THEN
                RAISE EXCEPTION 'You do not have access to this record' USING ERRCODE = '42501';
            END IF;
        END LOOP;
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

CREATE OR REPLACE FUNCTION compliance.cleanup_proforma(
    p_position_ids UUID[],
    p_run_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO compliance, entity_instances, golden_master, pg_temp
AS $$
DECLARE
    v_ids UUID[];
BEGIN
    IF p_run_ids IS NOT NULL AND array_length(p_run_ids, 1) IS NOT NULL THEN
        DELETE FROM compliance.rule_evaluation_runs WHERE id = ANY (p_run_ids);
    END IF;
    IF p_position_ids IS NULL OR array_length(p_position_ids, 1) IS NULL THEN
        RETURN;
    END IF;
    -- Only the hypothetical positions materialize_proforma_legs wrote. Their
    -- values and links go first: the record delete guard refuses a record that
    -- still has history when the caller is signed in.
    SELECT array_agg(id) INTO v_ids
    FROM entity_instances.master_entities
    WHERE id = ANY (p_position_ids)
      AND metadata ->> 'proforma' = 'true';
    IF v_ids IS NULL THEN
        RETURN;
    END IF;
    DELETE FROM golden_master.entity_attribute_values WHERE entity_id = ANY (v_ids);
    DELETE FROM entity_instances.entity_relationships
    WHERE parent_entity_id = ANY (v_ids) OR child_entity_id = ANY (v_ids);
    DELETE FROM entity_instances.master_entities WHERE id = ANY (v_ids);
END;
$$;
