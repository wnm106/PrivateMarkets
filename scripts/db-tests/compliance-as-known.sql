-- A compliance rule run at a Knowledge date reads the rule, its fund limits and
-- its scope as they were known then, and edits keep what they replaced.
-- Run by scripts/db-tests/compliance-as-known.ts against a database built from
-- supabase/migrations with the seed. Everything is rolled back; any failed
-- check raises. See supabase/migrations/20261126100000_compliance_rules_as_known.sql.
--
-- Inside one transaction now() does not move, so "before" is the instant just
-- before this transaction began: every committed row is known then, and a row
-- this test marks as known from now() is not.
BEGIN;
DO $$
DECLARE
    v_as_of CONSTANT DATE := COALESCE(NULLIF(current_setting('test.as_of', TRUE), ''), '2026-11-21')::DATE;
    v_before CONSTANT TIMESTAMPTZ := now() - INTERVAL '1 microsecond';
    v_t compliance.rule_thresholds;
    v_code TEXT;
    v_run UUID;
    v_hard NUMERIC;
    v_count INTEGER;
    v_history compliance.definition_history;
    v_new_from TIMESTAMPTZ;
    v_failed BOOLEAN;
    v_scope UUID;
BEGIN
    -- A fund's own limit on an active fund rule, in force at the As Of date,
    -- whose run gives that fund a result today.
    SELECT t.* INTO v_t
    FROM compliance.rule_thresholds t
    JOIN compliance.rules r ON r.id = t.rule_id AND r.is_active AND r.anchor_domain_code = 'FUND'
    WHERE t.entity_id IS NOT NULL AND t.group_value IS NULL AND t.rank_from IS NULL AND t.rank_to IS NULL
      AND t.applies AND t.hard_limit_value IS NOT NULL
      AND t.valid_from <= v_as_of AND t.valid_to >= v_as_of
      AND NOT EXISTS (
          SELECT 1 FROM compliance.rule_thresholds o
          WHERE o.rule_id = t.rule_id AND o.entity_id = t.entity_id AND o.id <> t.id
            AND o.valid_from <= v_as_of AND o.valid_to >= v_as_of
      )
    ORDER BY r.rule_code, t.entity_id
    LIMIT 1;
    IF v_t.id IS NULL THEN RAISE EXCEPTION 'setup: no fund limit to test with'; END IF;
    SELECT rule_code INTO v_code FROM compliance.rules WHERE id = v_t.rule_id;

    v_run := compliance.evaluate_rule(v_code, v_as_of, now(), NULL, NULL, v_t.entity_id);
    SELECT max(hard_limit_value) INTO v_hard FROM compliance.rule_evaluation_results WHERE run_id = v_run AND anchor_entity_id = v_t.entity_id;
    IF v_hard IS DISTINCT FROM v_t.hard_limit_value THEN
        RAISE EXCEPTION 'setup: % scored % with limit %, not its row''s %', v_code, v_t.entity_id, v_hard, v_t.hard_limit_value;
    END IF;

    -- ---------------------------------------------------------------
    -- Editing a limit keeps the row it replaced, with the period it was known for.
    -- ---------------------------------------------------------------
    UPDATE compliance.rule_thresholds SET hard_limit_value = v_t.hard_limit_value * 2 WHERE id = v_t.id
        RETURNING system_from INTO v_new_from;
    IF v_new_from <> now() THEN RAISE EXCEPTION 'an edited limit is known from %, not now', v_new_from; END IF;
    SELECT * INTO v_history FROM compliance.definition_history
        WHERE table_name = 'rule_thresholds' AND row_id = v_t.id ORDER BY id DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'an edited limit kept no history'; END IF;
    IF (v_history.row_data ->> 'hard_limit_value')::NUMERIC <> v_t.hard_limit_value THEN
        RAISE EXCEPTION 'history kept limit %, not the replaced %', v_history.row_data ->> 'hard_limit_value', v_t.hard_limit_value;
    END IF;
    IF v_history.system_from <> v_t.system_from OR v_history.system_to <> now() OR v_history.rule_id <> v_t.rule_id THEN
        RAISE EXCEPTION 'history period or rule wrong: % to %, rule %', v_history.system_from, v_history.system_to, v_history.rule_id;
    END IF;
    RAISE NOTICE 'ok: editing a limit keeps the replaced row with the period it was known for';

    -- Scored as known now: the new limit. As known just before: the old one.
    v_run := compliance.evaluate_rule(v_code, v_as_of, now(), NULL, NULL, v_t.entity_id);
    SELECT max(hard_limit_value) INTO v_hard FROM compliance.rule_evaluation_results WHERE run_id = v_run AND anchor_entity_id = v_t.entity_id;
    IF v_hard IS DISTINCT FROM v_t.hard_limit_value * 2 THEN RAISE EXCEPTION 'scored now with limit %, not the edited %', v_hard, v_t.hard_limit_value * 2; END IF;
    v_run := compliance.evaluate_rule(v_code, v_as_of, v_before, NULL, NULL, v_t.entity_id);
    SELECT max(hard_limit_value) INTO v_hard FROM compliance.rule_evaluation_results WHERE run_id = v_run AND anchor_entity_id = v_t.entity_id;
    IF v_hard IS DISTINCT FROM v_t.hard_limit_value THEN RAISE EXCEPTION 'scored as known before with limit %, not the earlier %', v_hard, v_t.hard_limit_value; END IF;
    RAISE NOTICE 'ok: a run uses the limit known at its Knowledge date';

    -- A second edit in the same transaction was never known outside it: no history.
    SELECT count(*) INTO v_count FROM compliance.definition_history WHERE row_id = v_t.id;
    UPDATE compliance.rule_thresholds SET hard_limit_value = v_t.hard_limit_value * 3 WHERE id = v_t.id;
    IF (SELECT count(*) FROM compliance.definition_history WHERE row_id = v_t.id) <> v_count THEN
        RAISE EXCEPTION 'a row changed twice in one transaction kept its unseen middle value';
    END IF;
    -- Touching only updated_at is not a change.
    UPDATE compliance.rule_thresholds SET updated_at = now() + INTERVAL '1 minute' WHERE id = v_t.id;
    IF (SELECT count(*) FROM compliance.definition_history WHERE row_id = v_t.id) <> v_count THEN
        RAISE EXCEPTION 'touching updated_at started a new period';
    END IF;
    RAISE NOTICE 'ok: unseen and bookkeeping-only edits keep nothing';

    -- ---------------------------------------------------------------
    -- Removing a limit: as known now the fund rule does not apply to that fund;
    -- as known before, it still scores against the earlier limit.
    -- ---------------------------------------------------------------
    DELETE FROM compliance.rule_thresholds WHERE id = v_t.id;
    v_run := compliance.evaluate_rule(v_code, v_as_of, now(), NULL, NULL, v_t.entity_id);
    IF EXISTS (SELECT 1 FROM compliance.rule_evaluation_results WHERE run_id = v_run AND anchor_entity_id = v_t.entity_id) THEN
        RAISE EXCEPTION 'a fund with its limit removed was still scored now';
    END IF;
    v_run := compliance.evaluate_rule(v_code, v_as_of, v_before, NULL, NULL, v_t.entity_id);
    SELECT max(hard_limit_value) INTO v_hard FROM compliance.rule_evaluation_results WHERE run_id = v_run AND anchor_entity_id = v_t.entity_id;
    IF v_hard IS DISTINCT FROM v_t.hard_limit_value THEN RAISE EXCEPTION 'after removal, scored as known before with limit %', v_hard; END IF;
    RAISE NOTICE 'ok: a removed limit still applies as known before it was removed';

    -- The deal scoring plan enrolls the fund as known before, not now.
    IF EXISTS (SELECT 1 FROM compliance.deal_score_plans(ARRAY[v_t.entity_id], v_as_of) p WHERE p.rule_id = v_t.rule_id) THEN
        RAISE EXCEPTION 'the plan as known now still enrolls a fund whose limit was removed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.deal_score_plans(ARRAY[v_t.entity_id], v_as_of, v_before) p WHERE p.rule_id = v_t.rule_id AND v_t.entity_id = ANY (p.anchor_ids)) THEN
        RAISE EXCEPTION 'the plan as known before does not enroll the fund';
    END IF;
    RAISE NOTICE 'ok: the deal scoring plan enrolls funds as known at its Knowledge date';

    -- ---------------------------------------------------------------
    -- The rule header: switched off now, active as known before.
    -- ---------------------------------------------------------------
    UPDATE compliance.rules SET is_active = FALSE WHERE id = v_t.rule_id;
    IF NOT EXISTS (SELECT 1 FROM compliance.definition_history WHERE table_name = 'rules' AND row_id = v_t.rule_id AND (row_data ->> 'is_active')::BOOLEAN) THEN
        RAISE EXCEPTION 'switching a rule off kept no history';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.rules_as_known(v_before) r WHERE r.id = v_t.rule_id AND r.is_active) THEN
        RAISE EXCEPTION 'the rule as known before is not active';
    END IF;
    IF EXISTS (SELECT 1 FROM compliance.rules_as_known(NULL) r WHERE r.id = v_t.rule_id AND r.is_active) THEN
        RAISE EXCEPTION 'the rule as known now is still active';
    END IF;
    IF (SELECT count(*) FROM compliance.rules_as_known(v_before) r WHERE r.id = v_t.rule_id) <> 1 THEN
        RAISE EXCEPTION 'the rule appears more than once as known before';
    END IF;
    RAISE NOTICE 'ok: a rule switched off is still active as known before';

    -- ---------------------------------------------------------------
    -- Scope: an exclusion added now does not apply to a run as known before.
    -- ---------------------------------------------------------------
    INSERT INTO compliance.rule_scope_assignments (rule_id, scope_type, entity_id, include_children)
        VALUES (v_t.rule_id, 'EXCLUDE', v_t.entity_id, FALSE) RETURNING id INTO v_scope;
    IF EXISTS (SELECT 1 FROM compliance.get_anchor_entities(v_t.rule_id, v_as_of, now()) a WHERE a.entity_id = v_t.entity_id) THEN
        RAISE EXCEPTION 'an excluded fund is still an anchor as known now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.get_anchor_entities(v_t.rule_id, v_as_of, v_before) a WHERE a.entity_id = v_t.entity_id) THEN
        RAISE EXCEPTION 'an exclusion added now applied to a run as known before';
    END IF;
    RAISE NOTICE 'ok: scope is read as known at the Knowledge date';

    -- History is append-only.
    v_failed := FALSE;
    BEGIN
        UPDATE compliance.definition_history SET row_data = '{}'::JSONB WHERE id = v_history.id;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'definition history was edited'; END IF;
    RAISE NOTICE 'ok: history is append-only';
END;
$$;

-- Signed-in users reach history only through the evaluator.
DO $$
BEGIN
    IF has_table_privilege('authenticated', 'compliance.definition_history', 'SELECT') THEN
        RAISE EXCEPTION 'signed-in users can read definition history directly';
    END IF;
    IF has_function_privilege('authenticated', 'compliance.rule_thresholds_as_known(timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'signed-in users can call the history reader directly';
    END IF;
    IF NOT has_function_privilege('authenticated', 'compliance.deal_score_plans(uuid[], date, timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'signed-in users lost the deal scoring plan';
    END IF;
    RAISE NOTICE 'ok: grants';
END;
$$;
ROLLBACK;
