-- The deal surface reads where each fund stands without a Hypo run.
--
-- fund_security_capacities now returns, beside each capacity, the reading it
-- came from: numerator and denominator of the booked book (hypothetical
-- positions left out), the hard and soft limit the fund is tested against,
-- the result unit, and whether the new position would also enter the
-- denominator. The allocation side panel shows the current figure, the room
-- and the pro forma figure from these, with no positions written.
--
-- Capacity for a share of the fund's own book (an invested-book share) now
-- counts the new position on both sides. A 25% limit on a book of 90 with 10
-- in the group used to allow 12.5 (25% of 90, less 10); the share after that
-- is 22.5 / 102.5, about 22%. The room is now 16.7, which lands on 25%.
--
-- The return type gains columns, so the function is dropped and recreated.

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
    numerator_code VARCHAR,
    numerator NUMERIC,
    denominator NUMERIC,
    hard_limit NUMERIC,
    soft_limit NUMERIC,
    result_unit VARCHAR,
    denominator_grows BOOLEAN
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
    v_grows BOOLEAN;
    v_fraction NUMERIC;
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
                -- The limit and soft limit as evaluate_rule sets them: the version,
                -- then the fund's limit attribute or limit term with the version's
                -- soft-limit factor, then a threshold row.
                v_limit := v_version.hard_limit_value;
                v_soft := v_version.soft_limit_value;
                v_fraction := NULL;
                IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                    SELECT g.val INTO v_fraction
                    FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                    LIMIT 1;
                ELSIF v_version.metadata ? 'limit_term' THEN
                    v_fraction := compliance.eval_clo_term(v_fund, v_version.metadata->'limit_term', p_as_of_date, p_knowledge_date, 'GOLDEN', NULL);
                END IF;
                IF v_fraction IS NOT NULL THEN
                    v_limit := v_fraction;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_fraction * v_version.soft_limit_factor END;
                END IF;
                -- A fund row in rule_thresholds overrides the rule's limit, as in evaluate_rule.
                SELECT * INTO v_resolved
                FROM compliance.resolve_threshold(v_rule.id, v_fund, NULL, NULL::BIGINT, p_as_of_date, v_soft, v_limit);
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
                    numerator := NULL;
                    denominator := NULL;
                    hard_limit := v_limit;
                    soft_limit := v_resolved.soft_limit;
                    result_unit := v_version.result_unit;
                    denominator_grows := NULL;
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
            -- The limit and soft limit as evaluate_rule sets them.
            v_limit := v_version.hard_limit_value;
            v_soft := v_version.soft_limit_value;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                v_fraction := NULL;
                SELECT g.val INTO v_fraction
                FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                LIMIT 1;
                IF v_fraction IS NOT NULL THEN
                    v_limit := v_fraction;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_fraction * v_version.soft_limit_factor END;
                END IF;
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

                -- When the denominator sums the same positions (an invested-book
                -- share), the new position enters the denominator too. The room x
                -- then solves (N + x) / (D + x) = L, which is (L * D - N) / (1 - L).
                v_grows := v_version.denominator_scope IN ('ANCHOR_TOTAL', 'SAME_GROUP')
                    AND v_version.denominator_source IS DISTINCT FROM 'ANCHOR'
                    AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE'
                    AND (v_version.denominator_attribute_code = 'MARKET_VALUE'
                         OR v_version.denominator_attribute_code = v_version.numerator_attribute_code);
                IF v_grows AND v_version.result_unit IN ('PERCENTAGE', 'RATIO') AND v_capacity > 0 THEN
                    v_fraction := v_resolved.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END;
                    IF v_fraction > 0 AND v_fraction < 1 THEN
                        v_capacity := v_capacity / (1 - v_fraction);
                    END IF;
                END IF;

                fund_id := v_fund;
                security_id := v_security;
                rule_code := v_rule.rule_code;
                rule_name := COALESCE(v_version.rule_name, v_rule.rule_name);
                capacity := v_capacity;
                group_value := v_security_group;
                numerator_code := v_version.numerator_attribute_code;
                numerator := v_numerator;
                denominator := v_denominator;
                hard_limit := v_resolved.hard_limit;
                soft_limit := v_resolved.soft_limit;
                result_unit := v_version.result_unit;
                denominator_grows := v_grows;
                RETURN NEXT;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;


COMMENT ON FUNCTION compliance.fund_security_capacities IS
    'For each fund and security, the remaining capacity of every active MAX position rule that adding the security would worsen, measured against the threshold evaluate_rule applies to that fund and group, with the reading it came from: the numerator and denominator of the book without hypothetical positions, the hard and soft limit, and whether the new position enters the denominator. When it does, capacity is the room that brings the share to the limit with the position counted on both sides. Securities in one group share that group''s capacity.';

GRANT EXECUTE ON FUNCTION compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;
