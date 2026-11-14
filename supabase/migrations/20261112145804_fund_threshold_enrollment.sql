-- A test can still apply to every fund. It is scored only for a fund that has
-- its own threshold for that test. A rule-level default does not enroll a fund.
-- A threshold with no numbers keeps the limit already on the test.

ALTER TABLE compliance.rule_thresholds
    ADD COLUMN IF NOT EXISTS limit_direction VARCHAR(10);

UPDATE compliance.rule_thresholds AS t
SET limit_direction = src.limit_direction
FROM (
    SELECT DISTINCT ON (rv.rule_id) rv.rule_id, rv.limit_direction
    FROM compliance.rule_versions rv
    WHERE rv.is_active
      AND rv.system_to > NOW()
      AND rv.limit_direction IS NOT NULL
    ORDER BY rv.rule_id, rv.version_number DESC
) AS src
WHERE t.rule_id = src.rule_id
  AND t.limit_direction IS NULL;

UPDATE compliance.rule_thresholds
SET limit_direction = 'MAX'
WHERE limit_direction IS NULL;

ALTER TABLE compliance.rule_thresholds
    DROP CONSTRAINT IF EXISTS rule_thresholds_limit_direction_check;
ALTER TABLE compliance.rule_thresholds
    ADD CONSTRAINT rule_thresholds_limit_direction_check
    CHECK (limit_direction IN ('MAX', 'MIN'));
ALTER TABLE compliance.rule_thresholds
    ALTER COLUMN limit_direction SET DEFAULT 'MAX';
ALTER TABLE compliance.rule_thresholds
    ALTER COLUMN limit_direction SET NOT NULL;

COMMENT ON COLUMN compliance.rule_thresholds.limit_direction IS
    'MAX: the result breaches when it is above the soft or hard number. MIN: the result breaches when it is below. Set on the fund threshold.';

-- Blank fund numbers mean "use the limit on the test" (the version value or a
-- limit read from a related record). A number that is filled in still wins.
DO $$
DECLARE
    v_def text;
    v_old text;
    v_new text;
BEGIN
    SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'compliance'
      AND p.proname = 'resolve_threshold'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'compliance.resolve_threshold was not found';
    END IF;
    IF strpos(v_def, 'fund_threshold_keeps_rule_limit') > 0 THEN
        RETURN;
    END IF;

    v_old := 'SELECT picked.soft_limit_value, picked.hard_limit_value, picked.applies, picked.source, picked.limit_direction';
    v_new := $patch$SELECT
        CASE WHEN picked.soft_limit_value IS NULL AND picked.hard_limit_value IS NULL THEN p_fallback_soft ELSE picked.soft_limit_value END,
        CASE WHEN picked.soft_limit_value IS NULL AND picked.hard_limit_value IS NULL THEN p_fallback_hard ELSE picked.hard_limit_value END,
        picked.applies, picked.source, picked.limit_direction
    -- fund_threshold_keeps_rule_limit$patch$;
    IF strpos(v_def, v_old) = 0 THEN
        v_old := 'SELECT picked.soft_limit_value, picked.hard_limit_value, picked.applies, picked.source';
        v_new := $patch$SELECT
        CASE WHEN picked.soft_limit_value IS NULL AND picked.hard_limit_value IS NULL THEN p_fallback_soft ELSE picked.soft_limit_value END,
        CASE WHEN picked.soft_limit_value IS NULL AND picked.hard_limit_value IS NULL THEN p_fallback_hard ELSE picked.hard_limit_value END,
        picked.applies, picked.source
    -- fund_threshold_keeps_rule_limit$patch$;
    END IF;
    IF strpos(v_def, v_old) = 0 THEN
        RAISE EXCEPTION 'resolve_threshold does not contain the limit select this migration replaces';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
END $$;

-- Skip the calculation unless this fund has a threshold that applies.
DO $$
DECLARE
    v_def text;
    v_old text := $old$            SELECT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = FALSE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;$old$;
    v_new text := $new$            -- fund_threshold_enrollment: the test can cover every fund, but it
            -- runs only for a fund with its own applies threshold.
            SELECT NOT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = TRUE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;$new$;
BEGIN
    SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'compliance'
      AND p.proname = 'evaluate_rule'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'compliance.evaluate_rule was not found';
    END IF;
    IF strpos(v_def, 'fund_threshold_enrollment') > 0 THEN
        RETURN;
    END IF;
    IF strpos(v_def, v_old) = 0 THEN
        RAISE EXCEPTION 'evaluate_rule does not contain the fund opt-out this migration replaces';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
END $$;

NOTIFY pgrst, 'reload schema';
