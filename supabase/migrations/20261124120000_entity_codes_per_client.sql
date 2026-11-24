-- Entity codes belong to a client.
--
-- An entity code was unique across every client, so two clients could not both
-- use, say, FUND-001. A code is now unique within its client and different
-- clients may share one. Every lookup by code must therefore say which client
-- it is for.
--
-- The two database functions that found a security by code searched every
-- client. Both run as SECURITY DEFINER, so row security did not stop that.
-- They now look only within the client of the anchor, or for a signed-in
-- caller, within the caller's own clients.

DO $$
DECLARE
    v_name TEXT;
BEGIN
    -- The single-column unique constraint created with the table, whatever its name.
    SELECT c.conname INTO v_name
    FROM pg_constraint c
    WHERE c.conrelid = 'entity_instances.master_entities'::regclass
      AND c.contype = 'u'
      AND c.conkey = ARRAY[(
          SELECT a.attnum FROM pg_attribute a
          WHERE a.attrelid = 'entity_instances.master_entities'::regclass AND a.attname = 'entity_code'
      )]::SMALLINT[];
    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE entity_instances.master_entities DROP CONSTRAINT %I', v_name);
    END IF;
END;
$$;

ALTER TABLE entity_instances.master_entities
    ADD CONSTRAINT master_entities_client_entity_code_key UNIQUE (client_id, entity_code);

COMMENT ON COLUMN entity_instances.master_entities.entity_code IS
    'The record''s code. Unique within its client; different clients may use the same code.';

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
                WHERE id = v_security
                  AND client_id = v_client;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Unknown security %', v_security;
                END IF;
            ELSIF v_security_code IS NOT NULL THEN
                SELECT id, domain_code INTO v_security, v_domain
                FROM entity_instances.master_entities
                WHERE entity_code = v_security_code
                  AND client_id = v_client;
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
    v_anchor_client UUID;
    v_matches INTEGER;
BEGIN
    -- A signed-in caller sees only their own clients' records. The service role
    -- (no signed-in user) is trusted to pass an anchor from the right client.
    IF p_anchor_entity_id IS NOT NULL THEN
        SELECT client_id INTO v_anchor_client
        FROM entity_instances.master_entities
        WHERE id = p_anchor_entity_id
          AND (auth.uid() IS NULL OR client_id IN (SELECT tenancy.current_client_ids()));
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unknown anchor %', p_anchor_entity_id;
        END IF;
    END IF;

    v_security := p_security_id;
    IF v_security IS NULL AND p_security_code IS NOT NULL THEN
        -- Entity codes are unique within a client, not across clients.
        SELECT count(*), min(id::TEXT)::UUID INTO v_matches, v_security
        FROM entity_instances.master_entities
        WHERE entity_code = p_security_code
          AND CASE
                WHEN v_anchor_client IS NOT NULL THEN client_id = v_anchor_client
                WHEN auth.uid() IS NOT NULL THEN client_id IN (SELECT tenancy.current_client_ids())
                ELSE FALSE
              END;
        IF v_matches > 1 THEN
            RAISE EXCEPTION 'Security code % is used by more than one of your clients. Give the anchor or the security id.', p_security_code;
        END IF;
        IF v_security IS NULL THEN
            RAISE EXCEPTION 'Unknown security %', p_security_code;
        END IF;
    END IF;
    IF v_security IS NULL THEN
        RAISE EXCEPTION 'A security id or security code is required';
    END IF;
    SELECT domain_code INTO v_domain
    FROM entity_instances.master_entities
    WHERE id = v_security
      AND (v_anchor_client IS NULL OR client_id = v_anchor_client)
      AND (auth.uid() IS NULL OR client_id IN (SELECT tenancy.current_client_ids()));
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown security %', COALESCE(p_security_code, v_security::TEXT);
    END IF;
    IF v_domain IS DISTINCT FROM 'SECURITY' THEN
        RAISE EXCEPTION 'Capacity is calculated for a security. % is a %', COALESCE(p_security_code, v_security::TEXT), v_domain;
    END IF;

    IF p_anchor_entity_id IS NOT NULL THEN
        SELECT domain_code INTO v_anchor_domain
        FROM entity_instances.master_entities
        WHERE id = p_anchor_entity_id
          AND client_id = v_anchor_client;
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
