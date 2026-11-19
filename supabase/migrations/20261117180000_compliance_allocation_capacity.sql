-- Remaining capacity for an allocation comes from the compliance rules.
--
-- capacity_amount is the room, in numerator units, under a MAX limit:
--   percentage or ratio: (hard limit as a fraction) * denominator - numerator
--   currency or count:   hard limit - numerator
-- The same expression is what evaluate_rule stores as excess_amount when the
-- book is already over the limit: excess_amount = GREATEST(-capacity_amount, 0).
-- A MIN rule is not a capacity ceiling for adding exposure, so it returns NULL.
--
-- fund_security_capacities returns one row per fund, security, and MAX rule
-- whose numerator would increase if that security were allocated to that fund.
-- The allocation engine takes the lowest of those capacities. Securities that
-- land in the same rule group share one capacity; the caller must not treat
-- each row as an independent budget.

CREATE OR REPLACE FUNCTION compliance.capacity_amount(
    p_numerator NUMERIC,
    p_denominator NUMERIC,
    p_hard_limit NUMERIC,
    p_result_unit TEXT,
    p_limit_direction TEXT
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_limit_direction IS DISTINCT FROM 'MAX' THEN NULL
        WHEN p_hard_limit IS NULL OR p_numerator IS NULL THEN NULL
        WHEN p_result_unit IN ('PERCENTAGE', 'RATIO') THEN
            CASE
                WHEN p_denominator IS NULL OR p_denominator = 0 THEN NULL
                ELSE (p_hard_limit / CASE WHEN p_result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END)
                     * p_denominator - p_numerator
            END
        ELSE p_hard_limit - p_numerator
    END;
$$;

COMMENT ON FUNCTION compliance.capacity_amount IS
    'Remaining numerator room under a MAX compliance limit. Percentage and ratio limits scale the denominator; other units subtract the numerator from the limit. This is the capacity calculation the allocation engine must use.';

-- A proposed allocation has no position yet. LINE and BASE filters that read
-- the security (directly, or one hop out from the position) decide whether
-- that security would enter the rule. Filters on the position itself, such as
-- "market value is present", describe the position the allocation will write.
CREATE OR REPLACE FUNCTION compliance.proposed_security_matches(
    p_security_id UUID,
    p_rule_version_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_applies TEXT;
    v_group RECORD;
    v_cond RECORD;
    v_group_match BOOLEAN;
    v_any BOOLEAN;
    v_has BOOLEAN;
    v_path JSONB;
    v_actual TEXT;
    v_result BOOLEAN;
    v_targets UUID[];
BEGIN
    FOREACH v_applies IN ARRAY ARRAY['LINE', 'BASE'] LOOP
        v_any := FALSE;
        v_has := FALSE;
        FOR v_group IN
            SELECT DISTINCT c.condition_group
            FROM compliance.rule_conditions c
            WHERE c.rule_version_id = p_rule_version_id
              AND c.applies_to = v_applies
              AND (
                    COALESCE(c.attribute_dimension->'relationship_path'->0->>'relationship_code', '') IN ('POSITION_SECURITY', 'POSITION_TRANCHE')
                    OR (
                        COALESCE(jsonb_array_length(c.attribute_dimension->'relationship_path'), 0) = 0
                        AND c.attribute_code NOT IN (
                            'MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT', 'CURRENT_VALUE',
                            'POSITION_IS_HYPOTHETICAL', 'POSITION_SCENARIO_CODE'
                        )
                    )
                  )
        LOOP
            v_has := TRUE;
            v_group_match := NULL;
            FOR v_cond IN
                SELECT c.*
                FROM compliance.rule_conditions c
                WHERE c.rule_version_id = p_rule_version_id
                  AND c.applies_to = v_applies
                  AND c.condition_group = v_group.condition_group
                  AND (
                        COALESCE(c.attribute_dimension->'relationship_path'->0->>'relationship_code', '') IN ('POSITION_SECURITY', 'POSITION_TRANCHE')
                        OR (
                            COALESCE(jsonb_array_length(c.attribute_dimension->'relationship_path'), 0) = 0
                            AND c.attribute_code NOT IN (
                                'MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT', 'CURRENT_VALUE',
                                'POSITION_IS_HYPOTHETICAL', 'POSITION_SCENARIO_CODE'
                            )
                        )
                      )
                ORDER BY c.condition_order
            LOOP
                v_path := COALESCE(v_cond.attribute_dimension->'relationship_path', '[]'::JSONB);
                IF jsonb_array_length(v_path) > 0
                   AND v_path->0->>'relationship_code' IN ('POSITION_SECURITY', 'POSITION_TRANCHE') THEN
                    v_path := (
                        SELECT COALESCE(jsonb_agg(hops.hop ORDER BY hops.ord), '[]'::JSONB)
                        FROM jsonb_array_elements(v_path) WITH ORDINALITY AS hops(hop, ord)
                        WHERE hops.ord > 1
                    );
                END IF;
                IF v_path IS NULL OR jsonb_typeof(v_path) IS DISTINCT FROM 'array' OR jsonb_array_length(v_path) = 0 THEN
                    v_actual := compliance.get_text_value(p_security_id, v_cond.attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN');
                ELSE
                    v_targets := compliance.walk_path(ARRAY[p_security_id], v_path, p_as_of_date, p_knowledge_date);
                    v_actual := CASE
                        WHEN v_targets IS NULL OR array_length(v_targets, 1) IS NULL THEN NULL
                        ELSE compliance.get_text_value(v_targets[1], v_cond.attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN')
                    END;
                END IF;
                v_result := compliance.evaluate_operator(
                    v_actual, v_cond.operator, compliance.resolve_rhs(v_cond.value, NULL, p_as_of_date)
                );
                IF v_group_match IS NULL THEN
                    v_group_match := COALESCE(v_result, FALSE);
                ELSIF v_cond.logic_operator = 'OR' THEN
                    v_group_match := v_group_match OR COALESCE(v_result, FALSE);
                ELSE
                    v_group_match := v_group_match AND COALESCE(v_result, FALSE);
                END IF;
            END LOOP;
            IF v_group_match THEN
                v_any := TRUE;
            END IF;
        END LOOP;
        IF v_has AND NOT v_any THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION compliance.proposed_security_matches IS
    'True when allocating this security would enter the rule. Security filters are read on the security. A filter on the position amount does not keep the security out.';

-- Group key a security would join. Paths that start at a position are walked
-- from the security once the position-to-security hop is removed.
CREATE OR REPLACE FUNCTION compliance.security_group_value(
    p_security_id UUID,
    p_group_path JSONB,
    p_group_attr VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_issuer UUID;
    v_tranche UUID;
    v_deal UUID;
    v_sponsor UUID;
    v_path JSONB := COALESCE(p_group_path, '[]'::JSONB);
    v_targets UUID[];
BEGIN
    IF p_group_attr IS NULL OR btrim(p_group_attr) = '' THEN
        RETURN '__ALL__';
    END IF;

    IF p_group_attr IN ('ISSUER_LEGAL_NAME', 'SECTOR')
       OR v_path::TEXT ILIKE '%SECURITY_ISSUER%' THEN
        SELECT er.child_entity_id INTO v_issuer
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'SECURITY_ISSUER'
          AND er.parent_entity_id = p_security_id
          AND er.system_to >= TIMESTAMP '9999-01-01'
        ORDER BY er.is_primary DESC NULLS LAST
        LIMIT 1;
        IF v_issuer IS NULL THEN
            RETURN NULL;
        END IF;
        IF p_group_attr = 'SECTOR' THEN
            RETURN compliance.get_text_value(v_issuer, 'SECTOR', p_as_of_date, p_knowledge_date, 'GOLDEN');
        END IF;
        RETURN compliance.get_text_value(v_issuer, COALESCE(NULLIF(btrim(p_group_attr), ''), 'ISSUER_LEGAL_NAME'), p_as_of_date, p_knowledge_date, 'GOLDEN');
    END IF;

    IF p_group_attr = 'SPONSOR_NAME' OR v_path::TEXT ILIKE '%DEAL_SPONSOR%' THEN
        SELECT er.parent_entity_id INTO v_tranche
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'TRANCHE_SECURITY'
          AND er.child_entity_id = p_security_id
          AND er.system_to >= TIMESTAMP '9999-01-01'
        LIMIT 1;
        SELECT er.child_entity_id INTO v_deal
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'TRANCHE_DEAL'
          AND er.parent_entity_id = v_tranche
          AND er.system_to >= TIMESTAMP '9999-01-01'
        LIMIT 1;
        SELECT er.child_entity_id INTO v_sponsor
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'DEAL_SPONSOR'
          AND er.parent_entity_id = v_deal
          AND er.system_to >= TIMESTAMP '9999-01-01'
        LIMIT 1;
        RETURN compliance.get_text_value(v_sponsor, 'SPONSOR_NAME', p_as_of_date, p_knowledge_date, 'GOLDEN');
    END IF;

    IF jsonb_array_length(v_path) > 0
       AND v_path->0->>'relationship_code' IN ('POSITION_SECURITY', 'POSITION_TRANCHE') THEN
        v_path := (
            SELECT COALESCE(jsonb_agg(hops.hop ORDER BY hops.ord), '[]'::JSONB)
            FROM jsonb_array_elements(v_path) WITH ORDINALITY AS hops(hop, ord)
            WHERE hops.ord > 1
        );
    END IF;
    v_targets := compliance.walk_path(ARRAY[p_security_id], v_path, p_as_of_date, p_knowledge_date);
    IF v_targets IS NULL OR array_length(v_targets, 1) IS NULL THEN
        RETURN compliance.get_text_value(p_security_id, p_group_attr, p_as_of_date, p_knowledge_date, 'GOLDEN');
    END IF;
    RETURN compliance.get_text_value(v_targets[1], p_group_attr, p_as_of_date, p_knowledge_date, 'GOLDEN');
END;
$$;

-- A composite-term where clause is written from a position. Drop the hop that
-- lands on the security, then ask the compliance filter whether the security
-- would be in the term.
CREATE OR REPLACE FUNCTION compliance.security_matches_filters(
    p_security_id UUID,
    p_filters JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_rewritten JSONB := '[]'::JSONB;
    v_filter JSONB;
    v_path JSONB;
BEGIN
    IF p_filters IS NULL OR jsonb_typeof(p_filters) IS DISTINCT FROM 'array' OR jsonb_array_length(p_filters) = 0 THEN
        RETURN TRUE;
    END IF;
    FOR v_filter IN SELECT * FROM jsonb_array_elements(p_filters) LOOP
        v_path := COALESCE(v_filter->'path', '[]'::JSONB);
        IF jsonb_typeof(v_path) = 'array'
           AND jsonb_array_length(v_path) > 0
           AND v_path->0->>'relationship_code' = 'POSITION_SECURITY' THEN
            v_path := (
                SELECT COALESCE(jsonb_agg(hops.hop ORDER BY hops.ord), '[]'::JSONB)
                FROM jsonb_array_elements(v_path) WITH ORDINALITY AS hops(hop, ord)
                WHERE hops.ord > 1
            );
        END IF;
        v_rewritten := v_rewritten || jsonb_build_array(v_filter || jsonb_build_object('path', v_path));
    END LOOP;
    RETURN compliance.clo_filters_match(p_security_id, v_rewritten, p_as_of_date, p_knowledge_date, 'GOLDEN', NULL);
END;
$$;

-- Capacity of one composite MAX rule for one fund and security. NULL means the
-- security would not make the rule worse, or the rule is not a dollar sum.
CREATE OR REPLACE FUNCTION compliance.composite_rule_capacity(
    p_fund_id UUID,
    p_security_id UUID,
    p_version compliance.rule_versions,
    p_hard_limit NUMERIC,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_term JSONB;
    v_money TEXT[] := ARRAY['MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT', 'CURRENT_VALUE'];
    v_impacted BOOLEAN := FALSE;
    v_numerator NUMERIC := 0;
    v_denominator NUMERIC := 0;
    v_term_value NUMERIC;
    v_has_denominator BOOLEAN := FALSE;
BEGIN
    IF p_version.metadata IS NULL OR jsonb_typeof(p_version.metadata->'numerator_terms') IS DISTINCT FROM 'array' THEN
        RETURN NULL;
    END IF;
    FOR v_term IN SELECT * FROM jsonb_array_elements(p_version.metadata->'numerator_terms') LOOP
        IF COALESCE(v_term->>'kind', 'SUM') <> 'SUM' OR (v_term->>'attribute') <> ALL (v_money) THEN
            RETURN NULL;
        END IF;
        v_term_value := compliance.eval_clo_term(p_fund_id, v_term, p_as_of_date, p_knowledge_date, 'GOLDEN', NULL);
        v_numerator := v_numerator + COALESCE(v_term_value, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
        IF COALESCE((v_term->>'sign')::NUMERIC, 1) > 0
           AND compliance.security_matches_filters(p_security_id, v_term->'where', p_as_of_date, p_knowledge_date) THEN
            v_impacted := TRUE;
        END IF;
    END LOOP;
    IF NOT v_impacted THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(p_version.metadata->'denominator_terms') = 'array' THEN
        v_has_denominator := TRUE;
        FOR v_term IN SELECT * FROM jsonb_array_elements(p_version.metadata->'denominator_terms') LOOP
            IF COALESCE(v_term->>'kind', 'SUM') <> 'SUM' THEN
                RETURN NULL;
            END IF;
            v_term_value := compliance.eval_clo_term(p_fund_id, v_term, p_as_of_date, p_knowledge_date, 'GOLDEN', NULL);
            v_denominator := v_denominator + COALESCE(v_term_value, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
        END LOOP;
    END IF;

    RETURN compliance.capacity_amount(
        v_numerator,
        CASE WHEN v_has_denominator THEN v_denominator ELSE NULL END,
        p_hard_limit,
        p_version.result_unit,
        'MAX'
    );
END;
$$;

CREATE OR REPLACE FUNCTION compliance.fund_security_capacities(
    p_fund_ids UUID[],
    p_security_ids UUID[],
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_exclude_scenario VARCHAR DEFAULT NULL
) RETURNS TABLE (
    fund_id UUID,
    security_id UUID,
    rule_code VARCHAR,
    rule_name VARCHAR,
    capacity NUMERIC,
    group_value TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
    v_fund UUID;
    v_security UUID;
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_positions UUID[];
    v_kept UUID[];
    v_position UUID;
    v_group TEXT;
    v_security_group TEXT;
    v_unfunded BOOLEAN;
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_limit NUMERIC;
    v_capacity NUMERIC;
    v_targets UUID[];
    v_row RECORD;
    v_money TEXT[] := ARRAY['MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT', 'CURRENT_VALUE'];
BEGIN
    IF p_fund_ids IS NULL OR p_security_ids IS NULL THEN
        RETURN;
    END IF;

    FOR v_rule IN
        SELECT r.*
        FROM compliance.rules r
        WHERE r.is_active
          AND r.anchor_domain_code = 'FUND'
        ORDER BY r.rule_code
    LOOP
        v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
        IF v_version.id IS NULL OR v_version.limit_direction IS DISTINCT FROM 'MAX' THEN
            CONTINUE;
        END IF;

        IF COALESCE(v_version.metadata->>'logic', '') = 'composite_ratio' THEN
            FOREACH v_fund IN ARRAY p_fund_ids LOOP
                IF NOT EXISTS (
                    SELECT 1 FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
                    WHERE a.entity_id = v_fund
                ) THEN
                    CONTINUE;
                END IF;
                IF NOT compliance.entity_matches_conditions(v_fund, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, 'GOLDEN') THEN
                    CONTINUE;
                END IF;
                v_limit := NULL;
                IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                    SELECT g.val INTO v_limit
                    FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                    LIMIT 1;
                ELSIF v_version.metadata ? 'limit_term' THEN
                    v_limit := compliance.eval_clo_term(v_fund, v_version.metadata->'limit_term', p_as_of_date, p_knowledge_date, 'GOLDEN', NULL);
                ELSE
                    v_limit := v_version.hard_limit_value;
                END IF;
                FOREACH v_security IN ARRAY p_security_ids LOOP
                    IF NOT compliance.proposed_security_matches(v_security, v_version.id, p_as_of_date, p_knowledge_date) THEN
                        CONTINUE;
                    END IF;
                    v_capacity := compliance.composite_rule_capacity(
                        v_fund, v_security, v_version, v_limit, p_as_of_date, p_knowledge_date
                    );
                    IF v_capacity IS NULL THEN
                        CONTINUE;
                    END IF;
                    fund_id := v_fund;
                    security_id := v_security;
                    rule_code := v_rule.rule_code;
                    rule_name := COALESCE(v_version.rule_name, v_rule.rule_name);
                    capacity := v_capacity;
                    group_value := v_rule.rule_code;
                    RETURN NEXT;
                END LOOP;
            END LOOP;
            CONTINUE;
        END IF;

        IF v_version.numerator_aggregation IS DISTINCT FROM 'SUM'
           OR v_version.base_domain_code IS DISTINCT FROM 'POSITION'
           OR v_version.numerator_attribute_code <> ALL (v_money) THEN
            CONTINUE;
        END IF;

        FOREACH v_fund IN ARRAY p_fund_ids LOOP
            IF NOT EXISTS (
                SELECT 1 FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
                WHERE a.entity_id = v_fund
            ) THEN
                CONTINUE;
            END IF;
            IF NOT compliance.entity_matches_conditions(v_fund, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, 'GOLDEN') THEN
                CONTINUE;
            END IF;

            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}'::UUID[])
            INTO v_positions
            FROM entity_instances.entity_relationships er
            WHERE er.relationship_code = 'POSITION_FUND'
              AND er.child_entity_id = v_fund
              AND er.system_to >= TIMESTAMP '9999-01-01';

            v_kept := '{}'::UUID[];
            IF v_positions IS NOT NULL THEN
                FOREACH v_position IN ARRAY v_positions LOOP
                    IF lower(COALESCE(compliance.get_text_value(v_position, 'POSITION_IS_HYPOTHETICAL', p_as_of_date, p_knowledge_date, 'GOLDEN'), '')) = 'true' THEN
                        CONTINUE;
                    END IF;
                    IF p_exclude_scenario IS NOT NULL
                       AND compliance.get_text_value(v_position, 'POSITION_SCENARIO_CODE', p_as_of_date, p_knowledge_date, 'GOLDEN')
                           IS NOT DISTINCT FROM p_exclude_scenario THEN
                        CONTINUE;
                    END IF;
                    v_kept := v_kept || v_position;
                END LOOP;
            END IF;

            v_limit := NULL;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                SELECT g.val INTO v_limit
                FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                LIMIT 1;
            ELSE
                v_limit := v_version.hard_limit_value;
            END IF;
            IF v_limit IS NULL THEN
                CONTINUE;
            END IF;

            v_denominator := NULL;
            IF v_version.denominator_scope = 'ANCHOR_TOTAL'
               AND v_version.denominator_attribute_code IS NOT NULL
               AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE' THEN
                SELECT COALESCE(SUM(g.val), 0) INTO v_denominator
                FROM compliance.get_numeric_values(v_kept, v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g;
            ELSIF v_version.denominator_scope = 'CONSTANT' THEN
                v_denominator := v_version.denominator_constant_value;
            ELSIF v_version.denominator_attribute_code IS NOT NULL
                  AND (v_version.denominator_source = 'ANCHOR' OR v_version.denominator_aggregation = 'VALUE') THEN
                SELECT g.val INTO v_denominator
                FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                LIMIT 1;
            END IF;

            FOREACH v_security IN ARRAY p_security_ids LOOP
                IF NOT compliance.proposed_security_matches(v_security, v_version.id, p_as_of_date, p_knowledge_date) THEN
                    CONTINUE;
                END IF;
                SELECT COALESCE(bool_or(lower(COALESCE(compliance.get_text_value(er.parent_entity_id, 'TRANCHE_IS_UNFUNDED', p_as_of_date, p_knowledge_date, 'GOLDEN'), '')) IN ('true', 't', '1')), FALSE)
                INTO v_unfunded
                FROM entity_instances.entity_relationships er
                WHERE er.relationship_code = 'TRANCHE_SECURITY'
                  AND er.child_entity_id = v_security
                  AND er.system_to >= TIMESTAMP '9999-01-01';

                IF v_version.numerator_attribute_code = 'UNFUNDED_COMMITMENT_AMOUNT' AND NOT v_unfunded THEN
                    CONTINUE;
                END IF;
                IF v_version.numerator_attribute_code = 'FUNDED_PAR_AMOUNT' AND v_unfunded THEN
                    CONTINUE;
                END IF;

                v_security_group := compliance.security_group_value(
                    v_security, v_version.group_by_path, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date
                );
                IF v_security_group IS NULL THEN
                    CONTINUE;
                END IF;

                v_numerator := 0;
                IF v_kept IS NOT NULL AND array_length(v_kept, 1) IS NOT NULL THEN
                    FOR v_row IN
                        SELECT g.entity_id, g.val
                        FROM compliance.get_numeric_values(v_kept, v_version.numerator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                    LOOP
                        IF v_version.group_by_attribute_code IS NULL THEN
                            v_group := '__ALL__';
                        ELSE
                            v_group := NULL;
                            v_targets := compliance.walk_path(ARRAY[v_row.entity_id], COALESCE(v_version.group_by_path, '[]'::JSONB), p_as_of_date, p_knowledge_date);
                            IF v_targets IS NOT NULL AND array_length(v_targets, 1) IS NOT NULL THEN
                                v_group := compliance.get_text_value(v_targets[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN');
                            END IF;
                        END IF;
                        IF v_group IS NOT DISTINCT FROM v_security_group THEN
                            v_numerator := v_numerator + COALESCE(v_row.val, 0);
                        END IF;
                    END LOOP;
                END IF;

                IF v_version.denominator_scope = 'SAME_GROUP'
                   AND v_version.denominator_attribute_code IS NOT NULL
                   AND v_version.denominator_source IS DISTINCT FROM 'ANCHOR'
                   AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE' THEN
                    v_denominator := 0;
                    IF v_kept IS NOT NULL AND array_length(v_kept, 1) IS NOT NULL THEN
                        FOR v_row IN
                            SELECT g.entity_id, g.val
                            FROM compliance.get_numeric_values(v_kept, v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                        LOOP
                            IF v_version.group_by_attribute_code IS NULL THEN
                                v_group := '__ALL__';
                            ELSE
                                v_group := NULL;
                                v_targets := compliance.walk_path(ARRAY[v_row.entity_id], COALESCE(v_version.group_by_path, '[]'::JSONB), p_as_of_date, p_knowledge_date);
                                IF v_targets IS NOT NULL AND array_length(v_targets, 1) IS NOT NULL THEN
                                    v_group := compliance.get_text_value(v_targets[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN');
                                END IF;
                            END IF;
                            IF v_group IS NOT DISTINCT FROM v_security_group THEN
                                v_denominator := v_denominator + COALESCE(v_row.val, 0);
                            END IF;
                        END LOOP;
                    END IF;
                END IF;

                v_capacity := compliance.capacity_amount(
                    v_numerator, v_denominator, v_limit, v_version.result_unit, 'MAX'
                );
                IF v_capacity IS NULL THEN
                    CONTINUE;
                END IF;

                fund_id := v_fund;
                security_id := v_security;
                rule_code := v_rule.rule_code;
                rule_name := COALESCE(v_version.rule_name, v_rule.rule_name);
                capacity := v_capacity;
                group_value := v_security_group;
                RETURN NEXT;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION compliance.fund_security_capacities IS
    'For each fund and security, the remaining capacity of every active MAX position rule that adding the security would worsen. Capacity is compliance.capacity_amount, not a limit recomputed by the allocation engine. Securities in one group share that group''s capacity.';

GRANT EXECUTE ON FUNCTION compliance.proposed_security_matches(UUID, UUID, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.capacity_amount(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.security_group_value(UUID, JSONB, VARCHAR, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.security_matches_filters(UUID, JSONB, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.composite_rule_capacity(UUID, UUID, compliance.rule_versions, NUMERIC, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
