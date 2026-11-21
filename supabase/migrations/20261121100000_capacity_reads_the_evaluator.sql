-- Capacity reads the evaluator. One rule interpreter, one scoring plan.
--
-- Before this, compliance.fund_security_capacities carried its own copy of the
-- rule logic: its own book (hypothetical positions left out), its own group
-- lookup (security_group_value, fixed branches for issuer, sector and
-- sponsor), its own condition check (proposed_security_matches), its own
-- threshold call (no rank), and its own list of which rules apply to which
-- fund (every rule, every fund, no enrollment). Each of those disagreed with
-- compliance.evaluate_rule, which is what the deal's pro forma panel shows.
--
-- Now:
--   * Which rules a deal is scored on, and for which funds, is
--     compliance.deal_score_plans. The panel, the hypo and capacity use it.
--     Rules the deal surface always scores carry metadata.deal_surface
--     instead of a list of codes in application code.
--   * compliance.deal_capacity_observations runs evaluate_rule on the book
--     without this deal, then again with a small probe of every deal
--     security, and reports how each security moved each group. The
--     evaluator decides the book, the groups, the conditions, the limits and
--     the dates. The application turns that into room
--     (packages/graphql/src/lib/compliance-capacity.ts), the same module
--     investmentCapacity uses.
--   * Proforma legs can name their tranche (so a rule that groups through the
--     deal, such as sponsor, sees it) and can be unfunded (the amount goes to
--     UNFUNDED_COMMITMENT_AMOUNT instead of FUNDED_PAR_AMOUNT).
--   * The old capacity function and its private interpreters are dropped by
--     20261121100100, once the app that calls the new path is deployed. Until
--     then both exist, so applying this migration does not break the running app.

-- ============================================================
-- 1. Rule metadata replaces code lists in the application
-- ============================================================

UPDATE compliance.rules
SET metadata = COALESCE(metadata, '{}'::JSONB) || '{"deal_surface": true}'::JSONB
WHERE rule_code IN ('PF_ISSUER_CONCENTRATION', 'PF_SPONSOR_CONCENTRATION', 'PF_UNFUNDED_COMMITMENTS');

UPDATE compliance.rules r
SET metadata = COALESCE(r.metadata, '{}'::JSONB) || jsonb_build_object('group_label', v.label)
FROM (VALUES
    ('PF_ISSUER_CONCENTRATION', 'Issuer'),
    ('FUND_ISSUER_NAV_PCT', 'Issuer'),
    ('FUND_ISSUER_BOOK_PCT', 'Issuer'),
    ('ACT40_ISSUER_5_25', 'Issuer'),
    ('PF_SPONSOR_CONCENTRATION', 'Sponsor'),
    ('FUND_SECTOR_BOOK_PCT', 'Sector'),
    ('FUND_INSTRUMENT_EXPOSURE', 'Instrument')
) AS v(code, label)
WHERE r.rule_code = v.code
  AND NOT (COALESCE(r.metadata, '{}'::JSONB) ? 'group_label');

COMMENT ON COLUMN compliance.rules.metadata IS
    'Rule settings. deal_surface (boolean): the deal surface scores this rule for every fund on a deal, enrolled or not. group_label (text): what one group of the result is called, such as Issuer.';

-- ============================================================
-- 2. Which rules a deal is scored on, for which funds
-- ============================================================

-- A deal-surface rule covers every fund on the deal. Any other active rule
-- covers the funds that have a limit assigned to them (a threshold row that
-- applies, a group limit or a rank band), unless the fund opted out.
DROP FUNCTION IF EXISTS compliance.deal_capacity_observations(UUID[], JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS compliance.deal_score_plans(UUID[], DATE);
CREATE FUNCTION compliance.deal_score_plans(
    p_fund_ids UUID[],
    p_as_of_date DATE
) RETURNS TABLE (rule_id UUID, rule_code VARCHAR, anchor_ids UUID[], group_label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO compliance, metadata_register, pg_temp
AS $$
    WITH funds AS (
        SELECT DISTINCT f AS id FROM unnest(COALESCE(p_fund_ids, '{}'::UUID[])) AS f
    ),
    open_rows AS (
        SELECT t.*
        FROM compliance.rule_thresholds t
        JOIN funds ON funds.id = t.entity_id
        WHERE t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
    ),
    opted_out AS (
        SELECT rule_id, entity_id
        FROM open_rows
        WHERE applies = FALSE AND group_value IS NULL AND rank_from IS NULL
    ),
    enrolled AS (
        SELECT o.rule_id, array_agg(DISTINCT o.entity_id ORDER BY o.entity_id) AS anchors
        FROM open_rows o
        WHERE o.applies = TRUE
          AND NOT EXISTS (SELECT 1 FROM opted_out x WHERE x.rule_id = o.rule_id AND x.entity_id = o.entity_id)
        GROUP BY o.rule_id
    ),
    picked AS (
        SELECT r.id, r.rule_code, (SELECT array_agg(id ORDER BY id) FROM funds) AS anchors
        FROM compliance.rules r
        WHERE COALESCE((r.metadata->>'deal_surface')::BOOLEAN, FALSE)
          AND EXISTS (SELECT 1 FROM funds)
        UNION ALL
        SELECT r.id, r.rule_code, e.anchors
        FROM compliance.rules r
        JOIN enrolled e ON e.rule_id = r.id
        WHERE r.is_active
          AND NOT COALESCE((r.metadata->>'deal_surface')::BOOLEAN, FALSE)
    )
    -- What one group of the result is called: the rule's own label, else the
    -- name of the attribute it groups by.
    SELECT p.id, p.rule_code, p.anchors,
           COALESCE(r.metadata->>'group_label', ar.attribute_name)::TEXT
    FROM picked p
    JOIN compliance.rules r ON r.id = p.id
    LEFT JOIN LATERAL (
        SELECT (compliance.resolve_rule_version(p.id, p_as_of_date, now())).group_by_attribute_code
    ) ver ON TRUE
    LEFT JOIN metadata_register.attribute_register ar ON ar.attribute_code = ver.group_by_attribute_code
    ORDER BY p.rule_code;
$$;

COMMENT ON FUNCTION compliance.deal_score_plans(UUID[], DATE) IS
    'The rules a deal is scored on and the funds each covers. Rules with metadata.deal_surface cover every fund; other active rules cover the funds with a limit assigned to them, unless the fund opted out.';

GRANT EXECUTE ON FUNCTION compliance.deal_score_plans(UUID[], DATE) TO authenticated, service_role;

-- ============================================================
-- 3. Proforma legs: tranche and unfunded
-- ============================================================

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
$$;

-- ============================================================
-- 4. What the evaluator says each deal security does to each rule
-- ============================================================

-- For every fund, every rule the deal is scored on for that fund
-- (deal_score_plans) is evaluated twice by compliance.evaluate_rule:
--   base  : the book without this deal (scenario '<deal>#CAPACITY' leaves the
--           deal's own proposals out, as the hypo's '#BEFORE' does)
--   probe : the same book plus one leg of every security in p_legs
-- Each probe row says which legs landed in the group and what each added to
-- the numerator and the denominator, read from the leg's own values of the
-- attributes the rule sums. A rule that does not list its contributors (a
-- composite ratio) is probed one leg at a time and read from the change.
-- Nothing here interprets a rule. Legs and runs are deleted before return.
CREATE FUNCTION compliance.deal_capacity_observations(
    p_fund_ids UUID[],
    p_legs JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_deal_code VARCHAR DEFAULT NULL,
    p_rule_codes TEXT[] DEFAULT NULL,
    p_all_groups BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
    fund_id UUID,
    rule_code VARCHAR,
    rule_name VARCHAR,
    group_value TEXT,
    group_label TEXT,
    limit_direction VARCHAR,
    result_unit VARCHAR,
    base_numerator NUMERIC,
    base_denominator NUMERIC,
    base_value NUMERIC,
    base_status VARCHAR,
    base_soft_limit NUMERIC,
    base_hard_limit NUMERIC,
    probe_numerator NUMERIC,
    probe_denominator NUMERIC,
    probe_value NUMERIC,
    probe_status VARCHAR,
    probe_soft_limit NUMERIC,
    probe_hard_limit NUMERIC,
    probe_rank INTEGER,
    contributions JSONB,
    rank_sensitive BOOLEAN,
    error_message TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO compliance, entity_instances, metadata_register, golden_master, tenancy, pg_temp
AS $$
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
    DELETE FROM cap_obs;

    CREATE TEMP TABLE IF NOT EXISTS cap_plan ON COMMIT DROP AS
    SELECT * FROM compliance.deal_score_plans('{}'::UUID[], p_as_of_date) LIMIT 0;
    DELETE FROM cap_plan;
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
$$;

COMMENT ON FUNCTION compliance.deal_capacity_observations(UUID[], JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[], BOOLEAN) IS
    'compliance.evaluate_rule on each fund''s book without the deal, then with a probe leg of every security. Each row is one rule and group: the two results and what each security added to the numerator and denominator. Legs and runs are deleted before return. Capacity is solved from these rows in compliance-capacity.ts.';

GRANT EXECUTE ON FUNCTION compliance.deal_capacity_observations(UUID[], JSONB, DATE, TIMESTAMPTZ, VARCHAR, TEXT[], BOOLEAN) TO authenticated, service_role;

-- ============================================================
-- 5. The internal client is a flag, not a client code
-- ============================================================

CREATE OR REPLACE FUNCTION entity_instances.sync_intersection_client_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    v_member_client UUID;
    v_current_client UUID;
    v_internal_client UUID;
BEGIN
    SELECT id INTO v_internal_client FROM tenancy.clients WHERE is_internal ORDER BY created_at LIMIT 1;
    SELECT client_id INTO v_member_client FROM entity_instances.master_entities WHERE id = NEW.entity_id;
    SELECT client_id INTO v_current_client FROM entity_instances.intersection_instances WHERE id = NEW.intersection_id;

    IF v_member_client IS NOT NULL AND v_current_client IS DISTINCT FROM v_member_client
        AND (v_current_client IS NULL OR v_current_client = v_internal_client) THEN
        UPDATE entity_instances.intersection_instances
        SET client_id = v_member_client
        WHERE id = NEW.intersection_id;
    END IF;

    RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
