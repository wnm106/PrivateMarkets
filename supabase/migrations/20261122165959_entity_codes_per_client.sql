-- Record codes are unique within a client, not across every client.
--
-- master_entities.entity_code was UNIQUE on its own. A client could not use a
-- code another client had, and trying told them it existed: inserting B-FUND-1
-- as client A failed with a duplicate key on a row client A cannot see, so any
-- user could test whether an ISIN or a deal name was in use elsewhere. The feed
-- loader even read other clients' codes to refuse them up front.
--
-- Codes are now unique per client: UNIQUE (client_id, entity_code). Every
-- lookup by code reads one client's records. The compliance functions that
-- took a security code read it in the fund's client, and no longer accept a
-- security id from another client.

ALTER TABLE entity_instances.master_entities DROP CONSTRAINT IF EXISTS master_entities_entity_code_key;
ALTER TABLE entity_instances.master_entities
    ADD CONSTRAINT master_entities_client_entity_code_key UNIQUE (client_id, entity_code);
-- idx_master_entities_code stays: it serves lookups by code within the caller's clients.

-- The record a code names, within one client. With p_client_id NULL: the
-- caller's own clients, or every client for server code. Refuses a code that
-- names more than one record rather than picking one.
CREATE OR REPLACE FUNCTION entity_instances.entity_id_for_code(p_code TEXT, p_client_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = entity_instances, tenancy, pg_temp
AS $$
DECLARE
    v_ids UUID[];
BEGIN
    IF p_code IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT array_agg(e.id) INTO v_ids
    FROM entity_instances.master_entities e
    WHERE e.entity_code = p_code
      AND CASE
            WHEN p_client_id IS NOT NULL THEN e.client_id = p_client_id
            WHEN tenancy.is_backend_caller() THEN TRUE
            ELSE e.client_id IN (SELECT tenancy.current_client_ids())
          END;
    IF cardinality(v_ids) > 1 THEN
        RAISE EXCEPTION 'More than one of your clients has a record with the code %. Name it by id.', p_code
            USING ERRCODE = '21000';
    END IF;
    RETURN v_ids[1];
END;
$$;
REVOKE ALL ON FUNCTION entity_instances.entity_id_for_code(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION entity_instances.entity_id_for_code(TEXT, UUID) TO authenticated, service_role;

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
        PERFORM compliance.cleanup_proforma(v_ids, NULL);
        RAISE;
    END;

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

NOTIFY pgrst, 'reload schema';
