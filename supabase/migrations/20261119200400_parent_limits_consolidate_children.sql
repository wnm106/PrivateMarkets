-- A parent fund's limits measure exposure at the aggregate: the positions of
-- the parent and of every child fund below it.
--
-- 1. Every fund rule measured on positions, orders, accounts or securities now
--    rolls child funds up (consolidate_descendants). Rules measured on the fund
--    record itself (board, fees, seed capital) stay as they are, since a child
--    fund's record is not part of the parent's. New rule versions default to
--    rolling up.
--
-- 2. fund_security_capacities counts the same positions the evaluator counts:
--    for a rule that rolls up, the fund's own positions and those of all its
--    child funds. A portfolio's room for an issuer, sector or instrument is now
--    the limit less what its sleeves already hold.
--
-- 3. The capacity function collects each fund's positions once, and reads each
--    position's group once per rule, instead of once per security. The rule's
--    anchors are read once per rule.

UPDATE compliance.rule_versions rv
SET consolidate_descendants = TRUE
FROM compliance.rules r
WHERE rv.rule_id = r.id
  AND r.anchor_domain_code = 'FUND'
  AND rv.base_domain_code IS DISTINCT FROM 'FUND'
  AND NOT rv.consolidate_descendants;

ALTER TABLE compliance.rule_versions
    ALTER COLUMN consolidate_descendants SET DEFAULT TRUE;

COMMENT ON COLUMN compliance.rule_versions.consolidate_descendants IS
    'When true, a fund anchor is measured on its own positions and those of every child fund below it (FUND_PARENT, recursive). A parent fund''s limits measure the aggregate, so this is the default.';


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
    v_member UUID;
    v_security UUID;
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_anchors UUID[];
    v_members UUID[];
    v_positions UUID[];
    v_kept UUID[];
    v_position UUID;
    -- Booked positions per fund (own only), and per fund with its child funds.
    v_own JSONB := '{}'::JSONB;
    v_rolled JSONB := '{}'::JSONB;
    -- Per fund and rule: the group of each position, and sums by group.
    v_group_of JSONB;
    v_num_by_group JSONB;
    v_den_by_group JSONB;
    v_group TEXT;
    v_security_group TEXT;
    v_unfunded BOOLEAN;
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_total_denominator NUMERIC;
    v_limit NUMERIC;
    v_soft NUMERIC;
    v_resolved RECORD;
    v_grows BOOLEAN;
    v_fraction NUMERIC;
    v_capacity NUMERIC;
    v_targets UUID[];
    v_row RECORD;
    v_same_group_den BOOLEAN;
    v_money TEXT[] := ARRAY['MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT', 'CURRENT_VALUE'];
BEGIN
    IF p_fund_ids IS NULL OR p_security_ids IS NULL THEN
        RETURN;
    END IF;

    -- Each fund's booked positions, then the same with its child funds. A
    -- hypothetical position, or one in the excluded scenario, is not booked.
    FOREACH v_fund IN ARRAY p_fund_ids LOOP
        v_members := ARRAY[v_fund] || COALESCE(compliance.walk_path(
            ARRAY[v_fund],
            '[{"relationship_code":"FUND_PARENT","direction":"DOWN","recursive":true}]'::jsonb,
            p_as_of_date,
            p_knowledge_date
        ), '{}'::UUID[]);
        FOREACH v_member IN ARRAY v_members LOOP
            IF v_own ? v_member::TEXT THEN
                CONTINUE;
            END IF;
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}'::UUID[])
            INTO v_positions
            FROM entity_instances.entity_relationships er
            WHERE er.relationship_code = 'POSITION_FUND'
              AND er.child_entity_id = v_member
              AND er.system_to >= TIMESTAMP '9999-01-01';
            v_kept := '{}'::UUID[];
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
            v_own := v_own || jsonb_build_object(v_member::TEXT, to_jsonb(v_kept));
        END LOOP;
        SELECT COALESCE(array_agg(DISTINCT p), '{}'::UUID[]) INTO v_kept
        FROM unnest(v_members) AS m(id),
             LATERAL jsonb_array_elements_text(v_own->(m.id::TEXT)) AS e(p_text),
             LATERAL (SELECT e.p_text::UUID AS p) x;
        v_rolled := v_rolled || jsonb_build_object(v_fund::TEXT, to_jsonb(v_kept));
    END LOOP;

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

        SELECT COALESCE(array_agg(a.entity_id), '{}'::UUID[]) INTO v_anchors
        FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        WHERE a.entity_id = ANY (p_fund_ids);
        IF array_length(v_anchors, 1) IS NULL THEN
            CONTINUE;
        END IF;

        IF COALESCE(v_version.metadata->>'logic', '') = 'composite_ratio' THEN
            FOREACH v_fund IN ARRAY p_fund_ids LOOP
                IF NOT v_fund = ANY (v_anchors) THEN
                    CONTINUE;
                END IF;
                IF NOT compliance.entity_matches_conditions(v_fund, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, 'GOLDEN') THEN
                    CONTINUE;
                END IF;
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

        v_same_group_den := v_version.denominator_scope = 'SAME_GROUP'
            AND v_version.denominator_attribute_code IS NOT NULL
            AND v_version.denominator_source IS DISTINCT FROM 'ANCHOR'
            AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE';

        FOREACH v_fund IN ARRAY p_fund_ids LOOP
            IF NOT v_fund = ANY (v_anchors) THEN
                CONTINUE;
            END IF;
            IF NOT compliance.entity_matches_conditions(v_fund, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, 'GOLDEN') THEN
                CONTINUE;
            END IF;

            -- The positions the evaluator counts for this fund: its own, and its
            -- child funds' when the rule rolls them up.
            SELECT COALESCE(array_agg(e::UUID), '{}'::UUID[]) INTO v_kept
            FROM jsonb_array_elements_text(
                CASE WHEN COALESCE(v_version.consolidate_descendants, FALSE)
                     THEN v_rolled->(v_fund::TEXT)
                     ELSE v_own->(v_fund::TEXT) END
            ) AS e;

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

            v_total_denominator := NULL;
            IF v_version.denominator_scope = 'ANCHOR_TOTAL'
               AND v_version.denominator_attribute_code IS NOT NULL
               AND v_version.denominator_aggregation IS DISTINCT FROM 'VALUE' THEN
                SELECT COALESCE(SUM(g.val), 0) INTO v_total_denominator
                FROM compliance.get_numeric_values(v_kept, v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g;
            ELSIF v_version.denominator_scope = 'CONSTANT' THEN
                v_total_denominator := v_version.denominator_constant_value;
            ELSIF v_version.denominator_attribute_code IS NOT NULL
                  AND (v_version.denominator_source = 'ANCHOR' OR v_version.denominator_aggregation = 'VALUE') THEN
                SELECT g.val INTO v_total_denominator
                FROM compliance.get_numeric_values(ARRAY[v_fund], v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                LIMIT 1;
            END IF;

            -- Each position's group, read once, and the numerator (and a
            -- same-group denominator) summed by group.
            v_group_of := '{}'::JSONB;
            v_num_by_group := '{}'::JSONB;
            v_den_by_group := '{}'::JSONB;
            IF array_length(v_kept, 1) IS NOT NULL THEN
                IF v_version.group_by_attribute_code IS NOT NULL THEN
                    FOREACH v_position IN ARRAY v_kept LOOP
                        v_group := NULL;
                        v_targets := compliance.walk_path(ARRAY[v_position], COALESCE(v_version.group_by_path, '[]'::JSONB), p_as_of_date, p_knowledge_date);
                        IF v_targets IS NOT NULL AND array_length(v_targets, 1) IS NOT NULL THEN
                            v_group := compliance.get_text_value(v_targets[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN');
                        END IF;
                        IF v_group IS NOT NULL THEN
                            v_group_of := v_group_of || jsonb_build_object(v_position::TEXT, v_group);
                        END IF;
                    END LOOP;
                END IF;

                FOR v_row IN
                    SELECT g.entity_id, g.val
                    FROM compliance.get_numeric_values(v_kept, v_version.numerator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                LOOP
                    v_group := CASE WHEN v_version.group_by_attribute_code IS NULL THEN '__ALL__' ELSE v_group_of->>(v_row.entity_id::TEXT) END;
                    IF v_group IS NOT NULL THEN
                        v_num_by_group := v_num_by_group || jsonb_build_object(
                            v_group, COALESCE((v_num_by_group->>v_group)::NUMERIC, 0) + COALESCE(v_row.val, 0)
                        );
                    END IF;
                END LOOP;

                IF v_same_group_den THEN
                    FOR v_row IN
                        SELECT g.entity_id, g.val
                        FROM compliance.get_numeric_values(v_kept, v_version.denominator_attribute_code, p_as_of_date, p_knowledge_date, 'GOLDEN') g
                    LOOP
                        v_group := CASE WHEN v_version.group_by_attribute_code IS NULL THEN '__ALL__' ELSE v_group_of->>(v_row.entity_id::TEXT) END;
                        IF v_group IS NOT NULL THEN
                            v_den_by_group := v_den_by_group || jsonb_build_object(
                                v_group, COALESCE((v_den_by_group->>v_group)::NUMERIC, 0) + COALESCE(v_row.val, 0)
                            );
                        END IF;
                    END LOOP;
                END IF;
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

                v_numerator := COALESCE((v_num_by_group->>v_security_group)::NUMERIC, 0);
                v_denominator := CASE WHEN v_same_group_den
                    THEN COALESCE((v_den_by_group->>v_security_group)::NUMERIC, 0)
                    ELSE v_total_denominator END;

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
    'For each fund and security, the remaining capacity of every active MAX position rule that adding the security would worsen, measured against the threshold evaluate_rule applies to that fund and group. A rule that consolidates descendants counts the positions of the fund and all its child funds, as the evaluator does, so a parent''s room is its aggregate limit less what its children hold. Returns the reading it came from: numerator and denominator of the booked book (hypothetical positions left out), the hard and soft limit, and whether the new position enters the denominator.';

GRANT EXECUTE ON FUNCTION compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
