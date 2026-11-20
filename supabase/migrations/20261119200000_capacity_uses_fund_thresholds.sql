-- Allocation capacity uses the limit the deal is tested against.
--
-- fund_security_capacities sized each fund's room against the rule version's
-- default limit. evaluate_rule applies compliance.resolve_threshold, so a fund
-- with its own threshold (Harbor SI: Institutional Sleeve has a 25% sector cap
-- against a 35% default) was allocated past its limit and then scored as a
-- breach. Funds that opted out of a test, or were never assigned it, were
-- still capped by it.
--
-- Now, for every fund, security and rule:
--   * the limit is resolve_threshold for the fund and the security's group,
--     falling back to the limit attribute and then the version's limit;
--   * a fund or group that opted out of the test returns no capacity;
--   * the pro forma rules the deal surface scores (inactive on purpose) are
--     included, since the deal panel reports them for every fund;
--   * numerator_code says what the rule measures, so a rule on unfunded
--     commitments caps only the unfunded tranches of a shared security.
--
-- The return type gains a column, so the function is dropped and recreated.

DROP FUNCTION IF EXISTS compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR);

CREATE FUNCTION compliance.fund_security_capacities(
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
    group_value TEXT,
    numerator_code VARCHAR
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
    v_soft NUMERIC;
    v_resolved RECORD;
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
        -- The pro forma rules stay inactive so a scheduled run skips them, but
        -- the deal surface scores them, so the allocation must respect them.
        WHERE (r.is_active
               OR r.rule_code IN ('PF_ISSUER_CONCENTRATION', 'PF_SPONSOR_CONCENTRATION', 'PF_UNFUNDED_COMMITMENTS'))
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
                -- A fund row in rule_thresholds overrides the rule's limit, as in evaluate_rule.
                SELECT * INTO v_resolved
                FROM compliance.resolve_threshold(v_rule.id, v_fund, NULL, NULL::BIGINT, p_as_of_date, v_version.soft_limit_value, v_limit);
                IF NOT COALESCE(v_resolved.applies, TRUE) THEN
                    CONTINUE;
                END IF;
                v_limit := v_resolved.hard_limit;
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
                    numerator_code := NULL;
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
            v_soft := v_version.soft_limit_value;

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

                -- The limit is the one evaluate_rule applies to this fund and group:
                -- a fund and group row, then a fund row, then a rule row, then the
                -- rule version. A group the fund opted out of has no capacity.
                SELECT * INTO v_resolved
                FROM compliance.resolve_threshold(
                    v_rule.id, v_fund,
                    CASE WHEN v_security_group IN ('__ALL__', '__UNASSIGNED__') THEN NULL ELSE v_security_group END,
                    NULL::BIGINT, p_as_of_date, v_soft, v_limit
                );
                IF NOT COALESCE(v_resolved.applies, TRUE) OR v_resolved.hard_limit IS NULL THEN
                    CONTINUE;
                END IF;

                v_capacity := compliance.capacity_amount(
                    v_numerator, v_denominator, v_resolved.hard_limit, v_version.result_unit, 'MAX'
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
                numerator_code := v_version.numerator_attribute_code;
                RETURN NEXT;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;


COMMENT ON FUNCTION compliance.fund_security_capacities IS
    'For each fund and security, the remaining capacity of every active MAX position rule that adding the security would worsen, measured against the threshold evaluate_rule applies to that fund and group. Only funds the rule scores are returned. Capacity is compliance.capacity_amount, not a limit recomputed by the allocation engine. Securities in one group share that group''s capacity.';

GRANT EXECUTE ON FUNCTION compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;
