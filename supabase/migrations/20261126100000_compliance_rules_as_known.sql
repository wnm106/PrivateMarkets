-- Run a compliance rule as it was known: its header, fund limits and scope at
-- the Knowledge date, not as they stand today.
--
-- Rule versions already carry a knowledge period (system_from/system_to) and
-- compliance.resolve_rule_version honours it. Three other tables decide how a
-- rule is scored and were edited in place, so a rerun at an earlier Knowledge
-- date used today's values:
--   compliance.rules                   is_active, applies_to_all, metadata
--   compliance.rule_thresholds         each fund's limits and enrollment
--   compliance.rule_scope_assignments  which records a rule covers
--
-- The live tables keep their meaning, so every screen that reads them is
-- unchanged. Each gains system_from: when its current values became known.
-- When a row is changed or removed, the row it replaced goes into
-- compliance.definition_history with the period it was known for.
--
-- One reader per table gives the rows as known at an instant:
--   compliance.rules_as_known(k), compliance.rule_thresholds_as_known(k),
--   compliance.rule_scope_assignments_as_known(k)
-- A null instant means now. The evaluator, the fund limit resolver, the deal
-- scoring plan and capacity read through them with the run's Knowledge date.
--
-- Rows that exist before this migration count as known from the start: their
-- earlier values were not kept, so a rerun at a Knowledge date before this
-- migration uses the values they had when it was applied, as every run did.

-- ============================================================
-- 1. When each row's current values became known
-- ============================================================
-- Rows that exist now count as known from the start, which is how every run
-- has read them so far. No row is rewritten.
ALTER TABLE compliance.rules ADD COLUMN IF NOT EXISTS system_from TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
ALTER TABLE compliance.rule_thresholds ADD COLUMN IF NOT EXISTS system_from TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
ALTER TABLE compliance.rule_scope_assignments ADD COLUMN IF NOT EXISTS system_from TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
ALTER TABLE compliance.rules ALTER COLUMN system_from SET DEFAULT now();
ALTER TABLE compliance.rule_thresholds ALTER COLUMN system_from SET DEFAULT now();
ALTER TABLE compliance.rule_scope_assignments ALTER COLUMN system_from SET DEFAULT now();

COMMENT ON COLUMN compliance.rules.system_from IS 'When this row''s current values became known. Earlier values are in compliance.definition_history.';
COMMENT ON COLUMN compliance.rule_thresholds.system_from IS 'When this row''s current values became known. Earlier values are in compliance.definition_history.';
COMMENT ON COLUMN compliance.rule_scope_assignments.system_from IS 'When this row''s current values became known. Earlier values are in compliance.definition_history.';

-- ============================================================
-- 2. The rows they replaced
-- ============================================================
CREATE TABLE IF NOT EXISTS compliance.definition_history (
    id BIGSERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_id UUID NOT NULL,
    rule_id UUID,
    row_data JSONB NOT NULL,
    system_from TIMESTAMPTZ NOT NULL,
    system_to TIMESTAMPTZ NOT NULL,
    CHECK (system_from < system_to)
);
CREATE INDEX IF NOT EXISTS idx_definition_history_known
    ON compliance.definition_history (table_name, system_to, system_from);
CREATE INDEX IF NOT EXISTS idx_definition_history_rule
    ON compliance.definition_history (table_name, rule_id);
COMMENT ON TABLE compliance.definition_history IS
    'Earlier values of compliance rules, fund limits and scope assignments, each with the period it was known for. Written only by compliance.keep_definition_history; read through the *_as_known functions.';

ALTER TABLE compliance.definition_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON compliance.definition_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE compliance.definition_history_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON compliance.definition_history TO service_role;

-- Nobody edits or removes history.
CREATE OR REPLACE FUNCTION compliance.definition_history_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Compliance definition history is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS definition_history_append_only ON compliance.definition_history;
CREATE TRIGGER definition_history_append_only
    BEFORE UPDATE OR DELETE ON compliance.definition_history
    FOR EACH ROW EXECUTE FUNCTION compliance.definition_history_append_only();
REVOKE TRUNCATE ON compliance.definition_history FROM service_role;

-- Keeps the row an update or delete replaces. The trigger argument names the
-- column that holds the rule id. A row written and changed in one transaction
-- was never known outside it, so nothing is kept for it.
CREATE OR REPLACE FUNCTION compliance.keep_definition_history()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
DECLARE
    v_old JSONB := to_jsonb(OLD);
    v_rule_column TEXT := COALESCE(TG_ARGV[0], 'rule_id');
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Only a change to what the row says starts a new period.
        IF (v_old - 'updated_at' - 'system_from') = (to_jsonb(NEW) - 'updated_at' - 'system_from') THEN
            NEW.system_from := OLD.system_from;
            RETURN NEW;
        END IF;
        NEW.system_from := now();
    END IF;

    IF OLD.system_from < now() THEN
        INSERT INTO compliance.definition_history (table_name, row_id, rule_id, row_data, system_from, system_to)
        VALUES (TG_TABLE_NAME, OLD.id, NULLIF(v_old ->> v_rule_column, '')::UUID, v_old, OLD.system_from, now());
    END IF;

    RETURN CASE WHEN TG_OP = 'UPDATE' THEN NEW ELSE OLD END;
END;
$$;
REVOKE ALL ON FUNCTION compliance.keep_definition_history() FROM PUBLIC, anon, authenticated;

-- A new row is known from now, whatever the writer sent.
CREATE OR REPLACE FUNCTION compliance.definition_known_from_now()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.system_from := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION compliance.definition_known_from_now() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS keep_definition_history ON compliance.rules;
CREATE TRIGGER keep_definition_history BEFORE UPDATE OR DELETE ON compliance.rules
    FOR EACH ROW EXECUTE FUNCTION compliance.keep_definition_history('id');
DROP TRIGGER IF EXISTS keep_definition_history ON compliance.rule_thresholds;
CREATE TRIGGER keep_definition_history BEFORE UPDATE OR DELETE ON compliance.rule_thresholds
    FOR EACH ROW EXECUTE FUNCTION compliance.keep_definition_history('rule_id');
DROP TRIGGER IF EXISTS keep_definition_history ON compliance.rule_scope_assignments;
CREATE TRIGGER keep_definition_history BEFORE UPDATE OR DELETE ON compliance.rule_scope_assignments
    FOR EACH ROW EXECUTE FUNCTION compliance.keep_definition_history('rule_id');

DROP TRIGGER IF EXISTS definition_known_from_now ON compliance.rules;
CREATE TRIGGER definition_known_from_now BEFORE INSERT ON compliance.rules
    FOR EACH ROW EXECUTE FUNCTION compliance.definition_known_from_now();
DROP TRIGGER IF EXISTS definition_known_from_now ON compliance.rule_thresholds;
CREATE TRIGGER definition_known_from_now BEFORE INSERT ON compliance.rule_thresholds
    FOR EACH ROW EXECUTE FUNCTION compliance.definition_known_from_now();
DROP TRIGGER IF EXISTS definition_known_from_now ON compliance.rule_scope_assignments;
CREATE TRIGGER definition_known_from_now BEFORE INSERT ON compliance.rule_scope_assignments
    FOR EACH ROW EXECUTE FUNCTION compliance.definition_known_from_now();

-- ============================================================
-- 3. The rows as known at an instant
-- ============================================================
-- Plain SQL with no settings, so the planner inlines each into its caller. The
-- callers are SECURITY DEFINER, which is how they read the history table.
CREATE OR REPLACE FUNCTION compliance.rules_as_known(p_knowledge TIMESTAMPTZ DEFAULT NULL)
RETURNS SETOF compliance.rules
LANGUAGE sql
STABLE
AS $$
    SELECT r.* FROM compliance.rules r
    WHERE p_knowledge IS NULL OR r.system_from <= p_knowledge
    UNION ALL
    SELECT old.*
    FROM compliance.definition_history h
    CROSS JOIN LATERAL jsonb_populate_record(NULL::compliance.rules, h.row_data) AS old
    WHERE p_knowledge IS NOT NULL
      AND h.table_name = 'rules'
      AND h.system_from <= p_knowledge AND h.system_to > p_knowledge;
$$;

CREATE OR REPLACE FUNCTION compliance.rule_thresholds_as_known(p_knowledge TIMESTAMPTZ DEFAULT NULL)
RETURNS SETOF compliance.rule_thresholds
LANGUAGE sql
STABLE
AS $$
    SELECT t.* FROM compliance.rule_thresholds t
    WHERE p_knowledge IS NULL OR t.system_from <= p_knowledge
    UNION ALL
    SELECT old.*
    FROM compliance.definition_history h
    CROSS JOIN LATERAL jsonb_populate_record(NULL::compliance.rule_thresholds, h.row_data) AS old
    WHERE p_knowledge IS NOT NULL
      AND h.table_name = 'rule_thresholds'
      AND h.system_from <= p_knowledge AND h.system_to > p_knowledge;
$$;

CREATE OR REPLACE FUNCTION compliance.rule_scope_assignments_as_known(p_knowledge TIMESTAMPTZ DEFAULT NULL)
RETURNS SETOF compliance.rule_scope_assignments
LANGUAGE sql
STABLE
AS $$
    SELECT s.* FROM compliance.rule_scope_assignments s
    WHERE p_knowledge IS NULL OR s.system_from <= p_knowledge
    UNION ALL
    SELECT old.*
    FROM compliance.definition_history h
    CROSS JOIN LATERAL jsonb_populate_record(NULL::compliance.rule_scope_assignments, h.row_data) AS old
    WHERE p_knowledge IS NOT NULL
      AND h.table_name = 'rule_scope_assignments'
      AND h.system_from <= p_knowledge AND h.system_to > p_knowledge;
$$;

REVOKE ALL ON FUNCTION compliance.rules_as_known(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION compliance.rule_thresholds_as_known(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION compliance.rule_scope_assignments_as_known(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compliance.rules_as_known(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION compliance.rule_thresholds_as_known(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION compliance.rule_scope_assignments_as_known(TIMESTAMPTZ) TO service_role;
COMMENT ON FUNCTION compliance.rules_as_known(TIMESTAMPTZ) IS 'compliance.rules as known at an instant (null: now).';
COMMENT ON FUNCTION compliance.rule_thresholds_as_known(TIMESTAMPTZ) IS 'compliance.rule_thresholds as known at an instant (null: now).';
COMMENT ON FUNCTION compliance.rule_scope_assignments_as_known(TIMESTAMPTZ) IS 'compliance.rule_scope_assignments as known at an instant (null: now).';

-- ============================================================
-- 4. The readers that score a rule, reading through them
-- ============================================================
-- compliance.resolve_threshold: limits as known at the Knowledge date, and the fund
-- limit attribute of the version in force, not of any version.
DROP FUNCTION compliance.resolve_threshold(uuid, uuid, text, bigint, date, numeric, numeric);
CREATE OR REPLACE FUNCTION compliance.resolve_threshold(p_rule_id uuid, p_entity_id uuid, p_group text, p_rank bigint, p_as_of date, p_fallback_soft numeric, p_fallback_hard numeric, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(soft_limit numeric, hard_limit numeric, applies boolean, source text)
 LANGUAGE sql
 STABLE
AS $function$
    WITH rule AS (
        SELECT COALESCE(r.anchor_domain_code = 'FUND', FALSE) AS fund_rule,
               -- The version in force at these dates, not any version.
               (compliance.resolve_rule_version(p_rule_id, p_as_of, COALESCE(p_knowledge, now()))).hard_limit_attribute_code IS NOT NULL AS fund_attribute
        FROM compliance.rules_as_known(p_knowledge) r
        WHERE r.id = p_rule_id
    ),
    candidate AS (
        SELECT t.soft_limit_value, t.hard_limit_value, t.applies, t.entity_id,
               t.group_value, t.rank_from
        FROM compliance.rule_thresholds_as_known(p_knowledge) t, rule
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR (t.entity_id IS NULL AND NOT rule.fund_rule))
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
    ),
    picked AS (
        SELECT c.*
        FROM candidate c
        ORDER BY
            CASE WHEN c.entity_id = p_entity_id THEN 0 ELSE 1 END,
            CASE WHEN c.group_value IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN c.rank_from IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
    )
    -- A row: its numbers. A blank fund row on a rule that reads a fund
    -- attribute uses that attribute (the caller's fallback).
    SELECT
        CASE WHEN rule.fund_rule AND rule.fund_attribute AND p.soft_limit_value IS NULL AND p.hard_limit_value IS NULL
             THEN p_fallback_soft ELSE p.soft_limit_value END,
        CASE WHEN rule.fund_rule AND rule.fund_attribute AND p.soft_limit_value IS NULL AND p.hard_limit_value IS NULL
             THEN p_fallback_hard ELSE p.hard_limit_value END,
        p.applies,
        CASE WHEN p.entity_id IS NULL THEN 'RULE' ELSE 'FUND' END
    FROM picked p, rule
    UNION ALL
    -- No row. A fund rule does not apply, except in a rule builder preview.
    -- Other rules keep the rule version's numbers.
    SELECT p_fallback_soft, p_fallback_hard,
           NOT rule.fund_rule OR COALESCE(current_setting('compliance.rule_preview', TRUE), '') = 'on',
           CASE WHEN rule.fund_rule THEN 'PREVIEW' ELSE 'VERSION' END
    FROM rule
    WHERE NOT EXISTS (SELECT 1 FROM picked);
$function$;

-- compliance.deal_score_plans: rules and fund enrollment as known at the Knowledge date.
DROP FUNCTION compliance.deal_score_plans(uuid[], date);
CREATE OR REPLACE FUNCTION compliance.deal_score_plans(p_fund_ids uuid[], p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(rule_id uuid, rule_code character varying, anchor_ids uuid[], group_label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'metadata_register', 'pg_temp'
AS $function$
    WITH funds AS (
        SELECT DISTINCT f AS id FROM unnest(COALESCE(p_fund_ids, '{}'::UUID[])) AS f
    ),
    open_rows AS (
        SELECT t.*
        FROM compliance.rule_thresholds_as_known(p_knowledge_date) t
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
        FROM compliance.rules_as_known(p_knowledge_date) r
        WHERE COALESCE((r.metadata->>'deal_surface')::BOOLEAN, FALSE)
          AND EXISTS (SELECT 1 FROM funds)
        UNION ALL
        SELECT r.id, r.rule_code, e.anchors
        FROM compliance.rules_as_known(p_knowledge_date) r
        JOIN enrolled e ON e.rule_id = r.id
        WHERE r.is_active
          AND NOT COALESCE((r.metadata->>'deal_surface')::BOOLEAN, FALSE)
    )
    -- What one group of the result is called: the rule's own label, else the
    -- name of the attribute it groups by.
    SELECT p.id, p.rule_code, p.anchors,
           COALESCE(r.metadata->>'group_label', ar.attribute_name)::TEXT
    FROM picked p
    JOIN compliance.rules_as_known(p_knowledge_date) r ON r.id = p.id
    LEFT JOIN LATERAL (
        SELECT (compliance.resolve_rule_version(p.id, p_as_of_date, COALESCE(p_knowledge_date, now()))).group_by_attribute_code
    ) ver ON TRUE
    LEFT JOIN metadata_register.attribute_register ar ON ar.attribute_code = ver.group_by_attribute_code
    ORDER BY p.rule_code;
$function$;

-- compliance.get_anchor_entities: the rule and its scope as known at the Knowledge date.
CREATE OR REPLACE FUNCTION compliance.get_anchor_entities(p_rule_id uuid, p_as_of_date date, p_knowledge_date timestamp with time zone)
 RETURNS TABLE(entity_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'tenancy', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
    v_backend BOOLEAN := tenancy.is_backend_caller();
BEGIN
    SELECT * INTO v_rule FROM compliance.rules_as_known(p_knowledge_date) WHERE id = p_rule_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH include_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments_as_known(p_knowledge_date) sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE'
    ),
    include_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments_as_known(p_knowledge_date) sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE' AND sa.include_children = TRUE
    ),
    exclude_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments_as_known(p_knowledge_date) sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE'
    ),
    exclude_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments_as_known(p_knowledge_date) sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE' AND sa.include_children = TRUE
    ),
    candidate AS (
        SELECT me.id AS entity_id
        FROM entity_instances.master_entities me
        WHERE me.domain_code = v_rule.anchor_domain_code
          AND me.is_active = TRUE
          -- A signed-in caller's run covers only the funds that caller can read.
          AND (v_backend OR me.id IN (SELECT tenancy.readable_entity_ids()))
          AND (
                v_rule.applies_to_all = TRUE
                OR me.id IN (SELECT entity_id FROM include_direct)
                OR me.id IN (SELECT entity_id FROM include_cascaded)
          )
    )
    SELECT c.entity_id
    FROM candidate c
    WHERE c.entity_id NOT IN (SELECT entity_id FROM exclude_direct)
      AND c.entity_id NOT IN (SELECT entity_id FROM exclude_cascaded);
END;
$function$;

-- compliance.evaluate_rule: the rule, opt-outs and limits as known at the Knowledge date.
CREATE OR REPLACE FUNCTION compliance.evaluate_rule(p_rule_code character varying, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_triggered_by uuid DEFAULT NULL::uuid, p_anchor_entity_id uuid DEFAULT NULL::uuid, p_scenario_code character varying DEFAULT NULL::character varying)
 RETURNS uuid
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
    v_meta JSONB;
    v_walked UUID[];
    v_subject UUID;
    v_group_entities JSONB;
    v_addend NUMERIC;
    v_assets NUMERIC;
    v_debt NUMERIC;
    v_excess NUMERIC;
    v_basket_group NUMERIC;
    v_basket_cap NUMERIC;
    v_is_coverage BOOLEAN;
    v_pass_empty BOOLEAN;
    v_is_composite BOOLEAN;
    v_strict BOOLEAN;
    v_term JSONB;
    v_tval NUMERIC;
    v_num_sum NUMERIC;
    v_den_sum NUMERIC;
    v_has_den BOOLEAN;
    v_missing BOOLEAN;
    v_term_detail JSONB;
    v_limit_val NUMERIC;
BEGIN
    -- A code names a rule among the shared ones and one client's own: the anchor's,
    -- else the client the caller named (evaluate_rule_for_client), else the caller's.
    SELECT * INTO v_rule FROM compliance.rules_as_known(p_knowledge_date)
    WHERE id = compliance.rule_id_for_code(
        p_rule_code,
        COALESCE((SELECT a.client_id FROM entity_instances.master_entities a WHERE a.id = p_anchor_entity_id), NULLIF(current_setting('compliance.client_id', TRUE), '')::uuid)
    );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');
    v_meta := compliance.overlay_measure_lines(v_version.id, COALESCE(v_version.metadata, '{}'::jsonb));
    v_pass_empty := COALESCE((v_meta->>'pass_if_empty')::BOOLEAN, FALSE);
    v_is_coverage := COALESCE(v_meta->>'logic', '') = 'asset_coverage';
    v_is_composite := COALESCE(v_meta->>'logic', '') = 'composite_ratio';
    v_strict := COALESCE(v_meta->>'scenario_mode', '') = 'strict';
    v_basket_group := NULLIF(v_meta #>> '{exception_basket,per_group_limit}', '')::NUMERIC;
    v_basket_cap := NULLIF(v_meta #>> '{exception_basket,basket_limit}', '')::NUMERIC;

    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator', jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform,
        'consolidate_descendants', COALESCE(v_version.consolidate_descendants, FALSE),
        'logic', NULLIF(v_meta->>'logic', '')
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by, metadata)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by,
            CASE WHEN p_scenario_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scenario_code', p_scenario_code) END)
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

            -- fund_threshold_enrollment: the test can cover every fund, but it
            -- runs only for a fund with its own applies threshold.
            SELECT NOT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds_as_known(p_knowledge_date) t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = TRUE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            -- test_all_funds: a test run covers funds that have no threshold yet.
            -- score_all_anchors: a rule on records that are not funds, such as
            -- statement periods, scores every anchor without enrollment rows.
            IF v_opt_out AND COALESCE(current_setting('compliance.test_all_funds', TRUE), '') <> 'on'
               AND NOT COALESCE((v_meta->>'score_all_anchors')::BOOLEAN, FALSE) THEN
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

            IF v_meta ? 'limit_term' THEN
                v_limit_val := compliance.eval_clo_term(
                    v_anchor.entity_id, v_meta->'limit_term',
                    p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code
                );
                IF v_limit_val IS NOT NULL THEN
                    v_hard := v_limit_val;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_limit_val * v_version.soft_limit_factor END;
                END IF;
            END IF;

            IF v_is_composite THEN
                v_num_sum := 0;
                v_den_sum := 0;
                v_missing := FALSE;
                v_term_detail := '[]'::jsonb;
                v_has_den := jsonb_array_length(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) > 0;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'numerator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_num_sum := v_num_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'numerator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_den_sum := v_den_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'denominator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                -- A fund row in rule_thresholds overrides the limit.
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(v_rule.id, v_anchor.entity_id, NULL, NULL::BIGINT, p_as_of_date, v_soft, v_hard, p_knowledge_date);
                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                IF v_missing OR (v_has_den AND COALESCE(v_den_sum, 0) = 0) THEN
                    v_computed := NULL;
                ELSIF v_has_den THEN
                    v_computed := v_num_sum / v_den_sum;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_num_sum;
                END IF;

                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_limit.hard_limit IS NULL AND v_limit.soft_limit IS NULL THEN
                    -- Nothing says what the limit is, so there is nothing to pass.
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
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_num_sum, CASE WHEN v_has_den THEN v_den_sum END, v_computed,
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, 0,
                    v_detail || jsonb_build_object('terms', v_term_detail, 'limit_source', v_limit.source)
                    || CASE
                        WHEN v_has_den AND v_version.limit_direction = 'MAX' AND v_limit.hard_limit IS NOT NULL
                             AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_num_sum - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_den_sum, 0))
                        ELSE '{}'::jsonb
                       END
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
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

            IF (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) AND NOT v_is_coverage THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            IF v_is_coverage AND (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) THEN
                v_eligible_base_ids := ARRAY[]::UUID[];
            ELSE
                -- Portfolio locks are one attribute on every position. Read it once.
                v_base_ids := compliance.without_allocation_locks(v_base_ids, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                IF NOT v_strict AND NOT EXISTS (
                    SELECT 1 FROM compliance.rule_conditions c
                    WHERE c.rule_version_id = v_version.id AND c.applies_to = 'BASE'
                ) THEN
                    v_eligible_base_ids := v_base_ids;
                ELSE
                    SELECT array_agg(eid) INTO v_eligible_base_ids
                    FROM unnest(v_base_ids) AS eid
                    WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope)
                      AND (NOT v_strict OR compliance.scenario_strict_include(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope));
                END IF;
            END IF;

            IF v_is_coverage THEN
                v_addend := 0;
                IF v_eligible_base_ids IS NOT NULL AND array_length(v_eligible_base_ids, 1) IS NOT NULL THEN
                    SELECT COALESCE(SUM(g.val), 0) INTO v_addend
                    FROM compliance.get_numeric_values(
                        v_eligible_base_ids,
                        COALESCE(v_meta->>'addend_attribute', 'ESTIMATED_VALUE'),
                        p_as_of_date, p_knowledge_date, v_source_scope
                    ) AS g;
                END IF;
                v_assets := NULL;
                v_debt := NULL;
                SELECT g.val INTO v_assets
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'assets_attribute', 'TOTAL_AUM'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                SELECT g.val INTO v_debt
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'debt_attribute', 'TOTAL_DEBT'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;

                IF v_assets IS NULL OR v_debt IS NULL THEN
                    v_numerator := NULL;
                    v_denominator := NULL;
                    v_computed := NULL;
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSE
                    v_numerator := v_assets + COALESCE(v_addend, 0);
                    v_denominator := v_debt + COALESCE(v_addend, 0);
                    IF v_denominator = 0 THEN
                        v_computed := NULL;
                        v_status := 'NO_DATA';
                        v_breach := NULL;
                    ELSE
                        v_computed := v_numerator / v_denominator;
                        IF v_version.limit_direction = 'MAX' THEN
                            IF v_hard IS NOT NULL AND v_computed > v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_computed - v_hard;
                            ELSIF v_soft IS NOT NULL AND v_computed > v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_computed - v_soft;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        ELSE
                            IF v_hard IS NOT NULL AND v_computed < v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_hard - v_computed;
                            ELSIF v_soft IS NOT NULL AND v_computed < v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_soft - v_computed;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        END IF;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_soft, v_hard,
                    v_status, v_breach, v_eligible_base_ids, COALESCE(array_length(v_eligible_base_ids, 1), 0),
                    v_detail || jsonb_build_object(
                        'assets', v_assets,
                        'debt', v_debt,
                        'addend', v_addend,
                        'book_coverage', CASE WHEN v_debt IS NULL OR v_debt = 0 THEN NULL ELSE v_assets / v_debt END,
                        'projected_coverage', v_computed
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

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
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;
            v_group_entities := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                SELECT COALESCE(jsonb_object_agg(g.group_key, g.base_ids), '{}'::jsonb),
                       COALESCE(jsonb_object_agg(g.group_key, g.subjects) FILTER (WHERE g.subjects IS NOT NULL), '{}'::jsonb)
                INTO v_group_map, v_group_entities
                FROM (
                    SELECT m.group_key,
                           to_jsonb(array_agg(m.base_id ORDER BY m.base_id)) AS base_ids,
                           to_jsonb(array_agg(m.subject_id ORDER BY m.subject_id) FILTER (WHERE m.subject_id IS NOT NULL)) AS subjects
                    FROM compliance.group_membership(
                        v_eligible_base_ids,
                        v_version.group_by_path,
                        v_version.group_by_attribute_code,
                        v_version.group_by_dimension,
                        p_as_of_date,
                        p_knowledge_date,
                        v_source_scope
                    ) m
                    GROUP BY m.group_key
                ) g;
            END IF;

            DELETE FROM compliance_eval_parts WHERE TRUE;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source IN ('ANCHOR', 'GROUP') THEN NULL ELSE v_version.denominator_attribute_code END,
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
                IF v_version.denominator_source = 'GROUP' THEN
                    v_denominator := NULL;
                    IF v_group_entities ? v_key AND jsonb_array_length(v_group_entities -> v_key) > 0 THEN
                        SELECT MAX(g.val) INTO v_denominator
                        FROM compliance.get_numeric_values(
                            ARRAY(SELECT DISTINCT t.elem::UUID FROM jsonb_array_elements_text(v_group_entities -> v_key) AS t(elem)),
                            v_version.denominator_attribute_code,
                            v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source
                        ) AS g;
                    END IF;
                END IF;

                IF v_version.denominator_source IN ('ANCHOR', 'GROUP') AND COALESCE(v_denominator, 0) = 0 THEN
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

            v_excess := NULL;
            IF v_basket_group IS NOT NULL THEN
                SELECT COALESCE(SUM(GREATEST(p.computed - v_basket_group, 0)), 0)
                INTO v_excess
                FROM compliance_eval_parts p
                WHERE p.computed IS NOT NULL;
            END IF;

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
                    v_rule.id, v_anchor.entity_id, v_group_label, v_row.rank_pos, p_as_of_date, v_soft, v_hard, p_knowledge_date
                );

                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_computed := v_row.computed;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_group IS NOT NULL AND v_computed > v_basket_group THEN
                    IF v_basket_cap IS NOT NULL AND v_excess > v_basket_cap THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_basket_group;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
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
                    || CASE
                        WHEN v_version.limit_direction = 'MAX'
                         AND v_limit.hard_limit IS NOT NULL
                         AND v_row.denominator IS NOT NULL AND v_row.denominator <> 0
                         AND v_version.result_transform = 'NONE'
                         AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_row.numerator - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_row.denominator, 0))
                        ELSE '{}'::jsonb
                       END
                    || CASE
                        WHEN v_basket_group IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object(
                            'basket_excess', v_excess,
                            'basket_limit', v_basket_cap,
                            'allowed_exception',
                            v_computed > v_basket_group AND NOT (v_basket_cap IS NOT NULL AND v_excess > v_basket_cap)
                        )
                       END
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;

            IF v_basket_group IS NOT NULL THEN
                v_computed := v_excess;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_cap IS NOT NULL AND v_computed > v_basket_cap THEN
                    v_status := 'HARD_BREACH';
                    v_breach := v_computed - v_basket_cap;
                ELSE
                    v_status := 'PASS';
                    v_breach := NULL;
                END IF;
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, 'Exception basket',
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_excess, NULL, v_computed,
                    'MAX', NULL, v_basket_cap,
                    v_status, v_breach, NULL,
                    v_detail || jsonb_build_object(
                        'basket_excess', v_excess,
                        'basket_limit', v_basket_cap,
                        'per_group_limit', v_basket_group
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END IF;
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

-- compliance.deal_capacity_observations: the same plan and limits at the Knowledge date.
CREATE OR REPLACE FUNCTION compliance.deal_capacity_observations(p_fund_ids uuid[], p_legs jsonb, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_deal_code character varying DEFAULT NULL::character varying, p_rule_codes text[] DEFAULT NULL::text[], p_all_groups boolean DEFAULT false)
 RETURNS TABLE(fund_id uuid, rule_code character varying, rule_name character varying, group_value text, group_label text, limit_direction character varying, result_unit character varying, base_numerator numeric, base_denominator numeric, base_value numeric, base_status character varying, base_soft_limit numeric, base_hard_limit numeric, probe_numerator numeric, probe_denominator numeric, probe_value numeric, probe_status character varying, probe_soft_limit numeric, probe_hard_limit numeric, probe_rank integer, contributions jsonb, rank_sensitive boolean, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
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
    DELETE FROM cap_obs WHERE TRUE;

    CREATE TEMP TABLE IF NOT EXISTS cap_plan ON COMMIT DROP AS
    SELECT * FROM compliance.deal_score_plans('{}'::UUID[], p_as_of_date, p_knowledge_date) LIMIT 0;
    DELETE FROM cap_plan WHERE TRUE;
    INSERT INTO cap_plan
    SELECT * FROM compliance.deal_score_plans(p_fund_ids, p_as_of_date, p_knowledge_date) dp
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
                   SELECT 1 FROM compliance.rule_thresholds_as_known(p_knowledge_date) t
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
$function$;

REVOKE ALL ON FUNCTION compliance.resolve_threshold(uuid, uuid, text, bigint, date, numeric, numeric, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.resolve_threshold(uuid, uuid, text, bigint, date, numeric, numeric, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION compliance.resolve_threshold(uuid, uuid, text, bigint, date, numeric, numeric, timestamptz) IS
    'The limit for one rule, fund, group and rank, as known at p_knowledge (null: now). A fund rule reads only the fund''s own rows: with none, it does not apply. A blank fund row uses the fund''s limit attribute when the version in force has one. Rules on other records fall back to the rule version.';

REVOKE ALL ON FUNCTION compliance.deal_score_plans(uuid[], date, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.deal_score_plans(uuid[], date, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION compliance.deal_score_plans(uuid[], date, timestamptz) IS
    'The rules a deal is scored on and the funds each covers, as known at p_knowledge_date (null: now). Rules with metadata.deal_surface cover every fund; other active rules cover the funds with a limit assigned to them, unless the fund opted out.';

NOTIFY pgrst, 'reload schema';
