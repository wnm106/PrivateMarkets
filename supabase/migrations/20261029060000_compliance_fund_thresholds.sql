-- Fund-level compliance thresholds, rank bands, and parent-fund consolidation.
--
-- A rule still defines the test (what is measured, how it is grouped). Whether a
-- fund uses that test, and at what limit, is stored per fund:
--   * no group and no rank  = the fund's default limit, or applies = false to opt out
--   * group_value set       = that industry (or other group) has its own limit
--   * rank_from/rank_to     = the limit depends on the group's rank in the fund
-- A row with no fund is the rule's default, used when the fund has not set its own.
--
-- consolidate_descendants rolls positions of child funds into the parent, the
-- same direction the allocation grid uses: FUND_PARENT down from the parent.

ALTER TABLE compliance.rule_versions
    ADD COLUMN IF NOT EXISTS consolidate_descendants BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE compliance.rule_evaluation_results
    ADD COLUMN IF NOT EXISTS rank_position INTEGER;

COMMENT ON COLUMN compliance.rule_versions.consolidate_descendants IS
    'When true, a fund result includes positions held by descendant funds (FUND_PARENT, parent to child).';
COMMENT ON COLUMN compliance.rule_evaluation_results.rank_position IS
    '1 is the largest group for a MAX test, or the smallest for a MIN test. Null when the value could not be computed.';

CREATE TABLE IF NOT EXISTS compliance.rule_thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES compliance.rules(id) ON DELETE CASCADE,
    entity_id UUID REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    group_value TEXT,
    rank_from INTEGER,
    rank_to INTEGER,
    soft_limit_value NUMERIC,
    hard_limit_value NUMERIC,
    applies BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    valid_from DATE NOT NULL DEFAULT DATE '2020-01-01',
    valid_to DATE NOT NULL DEFAULT DATE '9999-12-31',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (valid_from <= valid_to),
    CHECK (rank_from IS NULL OR rank_from >= 1),
    CHECK (rank_to IS NULL OR rank_from IS NOT NULL),
    CHECK (rank_to IS NULL OR rank_from IS NULL OR rank_to >= rank_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_threshold_grain
    ON compliance.rule_thresholds (
        rule_id,
        COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(group_value, ''),
        COALESCE(rank_from, 0),
        COALESCE(rank_to, 0)
    )
    WHERE valid_to = DATE '9999-12-31';

CREATE INDEX IF NOT EXISTS idx_compliance_threshold_rule ON compliance.rule_thresholds(rule_id);
CREATE INDEX IF NOT EXISTS idx_compliance_threshold_entity ON compliance.rule_thresholds(entity_id);

COMMENT ON TABLE compliance.rule_thresholds IS
    'Limits for a compliance rule. entity_id null is the rule default. A fund row overrides it. group_value is the grouped result (an industry). rank_from/rank_to is an inclusive band, rank_to null meaning that rank and every rank after it.';

ALTER TABLE compliance.rule_thresholds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Compliance thresholds readable by authenticated" ON compliance.rule_thresholds;
CREATE POLICY "Compliance thresholds readable by authenticated" ON compliance.rule_thresholds
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Compliance thresholds writable by tenant admins" ON compliance.rule_thresholds;
CREATE POLICY "Compliance thresholds writable by tenant admins" ON compliance.rule_thresholds
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON compliance.rule_thresholds TO authenticated;

-- Most specific matching row wins: the fund's own row before a rule default,
-- then a group row before a rank band, then a rank band before the plain limit.
CREATE OR REPLACE FUNCTION compliance.resolve_threshold(
    p_rule_id UUID,
    p_entity_id UUID,
    p_group TEXT,
    p_rank BIGINT,
    p_as_of DATE,
    p_fallback_soft NUMERIC,
    p_fallback_hard NUMERIC
) RETURNS TABLE (soft_limit NUMERIC, hard_limit NUMERIC, applies BOOLEAN, source TEXT)
LANGUAGE sql STABLE
AS $function$
    SELECT picked.soft_limit_value, picked.hard_limit_value, picked.applies, picked.source
    FROM (
        SELECT t.soft_limit_value, t.hard_limit_value, t.applies,
               CASE WHEN t.entity_id IS NULL THEN 'RULE' ELSE 'FUND' END AS source
        FROM compliance.rule_thresholds t
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR t.entity_id IS NULL)
          AND (t.group_value IS NULL OR t.group_value = p_group)
          AND (
                (t.rank_from IS NULL AND t.rank_to IS NULL)
                OR (
                    p_rank IS NOT NULL
                    AND t.rank_from IS NOT NULL
                    AND t.rank_from <= p_rank
                    AND (t.rank_to IS NULL OR p_rank <= t.rank_to)
                )
          )
        ORDER BY
            CASE WHEN t.entity_id = p_entity_id THEN 0 ELSE 1 END,
            CASE WHEN t.group_value IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN t.rank_from IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
    ) picked
    UNION ALL
    SELECT p_fallback_soft, p_fallback_hard, TRUE, 'VERSION'
    WHERE NOT EXISTS (
        SELECT 1
        FROM compliance.rule_thresholds t
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR t.entity_id IS NULL)
          AND (t.group_value IS NULL OR t.group_value = p_group)
          AND (
                (t.rank_from IS NULL AND t.rank_to IS NULL)
                OR (
                    p_rank IS NOT NULL
                    AND t.rank_from IS NOT NULL
                    AND t.rank_from <= p_rank
                    AND (t.rank_to IS NULL OR p_rank <= t.rank_to)
                )
          )
    );
$function$;

GRANT EXECUTE ON FUNCTION compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC) TO authenticated;

DROP FUNCTION IF EXISTS compliance.evaluate_rule(character varying, date, timestamp with time zone, character varying, uuid);

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_more UUID[];
    v_child_funds UUID[];
    v_eligible_base_ids UUID[];
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_key_ids UUID[];
    v_group_map JSONB;
    v_part RECORD;
    v_row RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
    v_hard NUMERIC;
    v_soft NUMERIC;
    v_lim NUMERIC;
    v_anc_den NUMERIC;
    v_opt_out BOOLEAN;
    v_limit RECORD;
    v_group_label TEXT;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE rule_code = p_rule_code;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');

    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator', jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform,
        'consolidate_descendants', COALESCE(v_version.consolidate_descendants, FALSE)
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by)
    RETURNING id INTO v_run_id;

    CREATE TEMP TABLE IF NOT EXISTS compliance_eval_parts (
        group_key TEXT,
        numerator NUMERIC,
        denominator NUMERIC,
        computed NUMERIC,
        contributing_ids UUID[]
    ) ON COMMIT DROP;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF p_anchor_entity_id IS NOT NULL AND v_anchor.entity_id <> p_anchor_entity_id THEN
                CONTINUE;
            END IF;

            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            -- A fund can decline the rule entirely. That is a threshold row with
            -- no group and no rank and applies = false.
            SELECT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = FALSE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            IF v_opt_out THEN
                CONTINUE;
            END IF;

            v_hard := v_version.hard_limit_value;
            v_soft := v_version.soft_limit_value;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                v_lim := NULL;
                SELECT g.val INTO v_lim
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                IF v_lim IS NOT NULL THEN
                    v_hard := v_lim;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_lim * v_version.soft_limit_factor END;
                END IF;
            END IF;

            v_anc_den := NULL;
            IF v_version.denominator_source = 'ANCHOR' AND v_version.denominator_attribute_code IS NOT NULL THEN
                SELECT g.val INTO v_anc_den
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.denominator_attribute_code, v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source) AS g
                LIMIT 1;
            END IF;

            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF COALESCE(v_version.consolidate_descendants, FALSE) THEN
                v_child_funds := compliance.walk_path(
                    ARRAY[v_anchor.entity_id],
                    '[{"relationship_code":"FUND_PARENT","direction":"DOWN","recursive":true}]'::jsonb,
                    p_as_of_date,
                    p_knowledge_date
                );
                IF v_child_funds IS NOT NULL AND array_length(v_child_funds, 1) IS NOT NULL THEN
                    IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                        v_more := v_child_funds;
                    ELSE
                        v_more := compliance.walk_path(v_child_funds, v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
                    END IF;
                    SELECT array_agg(DISTINCT x) INTO v_base_ids
                    FROM unnest(COALESCE(v_base_ids, '{}'::UUID[]) || COALESCE(v_more, '{}'::UUID[])) AS x
                    WHERE x IS NOT NULL;
                END IF;
            END IF;

            IF v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_soft, v_hard,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            SELECT array_agg(eid) INTO v_eligible_base_ids
            FROM unnest(v_base_ids) AS eid
            WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope);

            IF v_eligible_base_ids IS NULL OR array_length(v_eligible_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_soft, v_hard,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        SELECT compliance.get_text_value_dim(w[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension)
                        INTO v_key
                        FROM (SELECT compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date) AS w) wx;
                    END IF;

                    v_key := COALESCE(v_key, '__UNASSIGNED__');

                    IF v_group_map ? v_key THEN
                        v_group_map := jsonb_set(
                            v_group_map, ARRAY[v_key],
                            to_jsonb((SELECT array_agg(x) FROM (
                                SELECT jsonb_array_elements_text(v_group_map -> v_key)::UUID AS x
                                UNION ALL SELECT v_base_eid
                            ) u))
                        );
                    ELSE
                        v_group_map := jsonb_set(v_group_map, ARRAY[v_key], jsonb_build_array(v_base_eid), TRUE);
                    END IF;
                END LOOP;
            END IF;

            DELETE FROM compliance_eval_parts WHERE TRUE;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source = 'ANCHOR' THEN NULL ELSE v_version.denominator_attribute_code END,
                    v_version.denominator_aggregation,
                    v_version.denominator_scope,
                    v_version.denominator_dimension,
                    v_version.denominator_constant_value,
                    p_as_of_date,
                    p_knowledge_date,
                    v_source_scope
                )
            LOOP
                v_key := v_part.group_key;
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;
                IF v_version.denominator_source = 'ANCHOR' THEN
                    v_denominator := v_anc_den;
                END IF;

                IF v_version.denominator_source = 'ANCHOR' AND COALESCE(v_denominator, 0) = 0 THEN
                    v_computed := NULL;
                ELSIF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL;
                ELSIF v_version.result_transform IN ('PCT_CHANGE', 'ABS_PCT_CHANGE') THEN
                    v_computed := (v_numerator - v_denominator) / v_denominator;
                    IF v_version.result_transform = 'ABS_PCT_CHANGE' THEN
                        v_computed := abs(v_computed);
                    END IF;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_numerator / v_denominator;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                END IF;

                INSERT INTO compliance_eval_parts (group_key, numerator, denominator, computed, contributing_ids)
                VALUES (v_key, v_numerator, v_denominator, v_computed, v_part.contributing_ids);
            END LOOP;

            FOR v_row IN
                SELECT p.*,
                       CASE
                           WHEN p.computed IS NULL THEN NULL
                           ELSE row_number() OVER (
                               ORDER BY
                                   CASE WHEN v_version.limit_direction = 'MIN' THEN p.computed END ASC NULLS LAST,
                                   CASE WHEN COALESCE(v_version.limit_direction, 'MAX') <> 'MIN' THEN p.computed END DESC NULLS LAST,
                                   p.group_key
                           )
                       END AS rank_pos
                FROM compliance_eval_parts p
            LOOP
                v_group_label := CASE WHEN v_row.group_key IN ('__ALL__', '__UNASSIGNED__') THEN NULL ELSE v_row.group_key END;
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(
                    v_rule.id,
                    v_anchor.entity_id,
                    v_group_label,
                    v_row.rank_pos,
                    p_as_of_date,
                    v_soft,
                    v_hard
                );

                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_computed := v_row.computed;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count,
                    rank_position, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, v_group_label,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_row.numerator, v_row.denominator, v_computed,
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, v_row.contributing_ids, array_length(v_row.contributing_ids, 1),
                    v_row.rank_pos,
                    v_detail || jsonb_build_object('rank', v_row.rank_pos, 'threshold_source', v_limit.source)
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;
        END LOOP;

        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'COMPLETED', completed_at = NOW(), result_count = v_result_count, breach_count = v_breach_count
        WHERE id = v_run_id;

    EXCEPTION WHEN OTHERS THEN
        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'FAILED', completed_at = NOW(), error_message = SQLERRM
        WHERE id = v_run_id;
        RAISE;
    END;

    RETURN v_run_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(character varying, date, timestamp with time zone, character varying, uuid, uuid) TO authenticated;

-- The sample fund tests consolidate sleeves into the parent and carry a few
-- fund-specific limits so the workspace has something to edit.
UPDATE compliance.rule_versions rv
SET consolidate_descendants = TRUE
FROM compliance.rules r
WHERE rv.rule_id = r.id
  AND r.rule_code IN ('FUND_SECTOR_BOOK_PCT', 'FUND_ISSUER_NAV_PCT', 'FUND_POSITION_COUNT', 'FUND_GROSS_EXPOSURE')
  AND rv.version_number = 1;

INSERT INTO compliance.rule_thresholds (
    rule_id, entity_id, group_value, rank_from, rank_to, soft_limit_value, hard_limit_value, applies, notes
)
SELECT r.id, me.id, v.group_value, v.rank_from, v.rank_to, v.soft, v.hard, v.applies, v.notes
FROM compliance.rules r
JOIN (VALUES
    ('FUND_SECTOR_BOOK_PCT', 'HALY-FUND-HSI-INST', NULL::text, NULL::int, NULL::int, 20::numeric, 25::numeric, TRUE, 'Harbor institutional default sector cap'),
    ('FUND_SECTOR_BOOK_PCT', 'HALY-FUND-HSI-INST', 'Industrial distribution', NULL, NULL, 35::numeric, 45::numeric, TRUE, 'Industrial distribution is allowed a wider share'),
    ('FUND_SECTOR_BOOK_PCT', 'HSCF2-FUND', 'Industrials', NULL, NULL, 18::numeric, 20::numeric, TRUE, 'Tighter industrials cap than the rule default'),
    ('FUND_SECTOR_BOOK_PCT', 'HALY-FUND-POC', NULL, NULL, NULL, NULL::numeric, NULL::numeric, FALSE, 'Pioneer does not use the sector test'),
    ('FUND_SECTOR_BOOK_PCT', 'HALY-FUND-POC-MAIN', NULL, NULL, NULL, NULL::numeric, NULL::numeric, FALSE, 'Pioneer sleeve does not use the sector test'),
    ('FUND_SECTOR_BOOK_PCT', 'HALY-FUND-POC-OVS', NULL, NULL, NULL, NULL::numeric, NULL::numeric, FALSE, 'Pioneer sleeve does not use the sector test'),
    ('FUND_ISSUER_NAV_PCT', 'HSCF2-FUND', NULL, NULL, NULL, 12::numeric, 15::numeric, TRUE, 'Halyard single-name cap, maintained on the fund'),
    ('FUND_ISSUER_NAV_PCT', 'HALY-FUND-HSI-INST', NULL, 1, 1, 6::numeric, 8::numeric, TRUE, 'Largest issuer'),
    ('FUND_ISSUER_NAV_PCT', 'HALY-FUND-HSI-INST', NULL, 2, 4, 2.4::numeric, 3::numeric, TRUE, 'Next three issuers'),
    ('FUND_ISSUER_NAV_PCT', 'HALY-FUND-HSI-INST', NULL, 5, NULL, 1::numeric, 1.5::numeric, TRUE, 'Every issuer after the top four')
) AS v(code, fund, group_value, rank_from, rank_to, soft, hard, applies, notes) ON v.code = r.rule_code
JOIN entity_instances.master_entities me ON me.entity_code = v.fund
ON CONFLICT DO NOTHING;

SELECT compliance.evaluate_rule('FUND_SECTOR_BOOK_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_ISSUER_NAV_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_POSITION_COUNT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_GROSS_EXPOSURE', DATE '2026-09-30');

NOTIFY pgrst, 'reload schema';
