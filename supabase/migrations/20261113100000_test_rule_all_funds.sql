-- A rule is normally scored only for funds that have a threshold for it. While a
-- rule is being built no thresholds exist yet, so a test run can cover every fund.
--
-- evaluate_rule_all_funds sets a transaction-local flag and calls evaluate_rule,
-- which skips the threshold enrollment check while the flag is on. Normal runs
-- are unchanged.

DO $$
DECLARE
    v_def text;
    v_old text := E'            IF v_opt_out THEN\n                CONTINUE;\n            END IF;';
    v_new text := E'            -- test_all_funds: a test run covers funds that have no threshold yet.\n            IF v_opt_out AND COALESCE(current_setting(''compliance.test_all_funds'', TRUE), '''') <> ''on'' THEN\n                CONTINUE;\n            END IF;';
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
    IF strpos(v_def, 'test_all_funds') > 0 THEN
        RETURN;
    END IF;
    IF strpos(v_def, v_old) = 0 THEN
        RAISE EXCEPTION 'evaluate_rule does not contain the fund opt-out check this migration replaces';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
END $$;

CREATE OR REPLACE FUNCTION compliance.evaluate_rule_all_funds(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'pg_temp'
AS $$
BEGIN
    PERFORM set_config('compliance.test_all_funds', 'on', TRUE);
    RETURN compliance.evaluate_rule(
        p_rule_code, p_as_of_date, p_knowledge_date, p_source_scope,
        p_triggered_by, p_anchor_entity_id, p_scenario_code
    );
END;
$$;

COMMENT ON FUNCTION compliance.evaluate_rule_all_funds IS
    'Runs evaluate_rule for every fund, including funds with no threshold for the rule. Used by the rule builder test button.';

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule_all_funds(character varying, date, timestamp with time zone, character varying, uuid, uuid, character varying) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
