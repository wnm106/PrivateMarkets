-- Six rule scores ran at once and crowded each other out, so the compliance
-- panel waited about twenty seconds after the proposals were written. Score
-- every rule for the deal's funds in one call.

CREATE OR REPLACE FUNCTION compliance.score_deal_funds(
    p_plans JSONB,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_scenario VARCHAR,
    p_triggered_by UUID DEFAULT NULL
) RETURNS SETOF compliance.rule_evaluation_results
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
DECLARE
    v_plan JSONB;
    v_runs UUID[];
    v_all UUID[] := '{}'::UUID[];
BEGIN
    -- The API role cancels a statement at 8 seconds. This score is one
    -- statement covering every rule, so give it room to finish.
    PERFORM set_config('statement_timeout', '20000', true);
    IF p_plans IS NULL OR jsonb_typeof(p_plans) IS DISTINCT FROM 'array' THEN
        RETURN;
    END IF;

    PERFORM set_config('compliance.test_all_funds', 'on', TRUE);

    FOR v_plan IN SELECT value FROM jsonb_array_elements(p_plans) LOOP
        v_runs := compliance.evaluate_rules_for_funds(
            v_plan->>'ruleCode',
            p_as_of,
            p_knowledge,
            NULL,
            p_triggered_by,
            ARRAY(SELECT jsonb_array_elements_text(v_plan->'anchors')::UUID),
            p_scenario,
            TRUE
        );
        v_all := v_all || COALESCE(v_runs, '{}'::UUID[]);
    END LOOP;

    RETURN QUERY
    SELECT * FROM compliance.rule_evaluation_results
    WHERE run_id = ANY (v_all);
END;
$$;

COMMENT ON FUNCTION compliance.score_deal_funds(JSONB, DATE, TIMESTAMPTZ, VARCHAR, UUID) IS
    'Scores every listed rule for its funds in one call. Each plan is {ruleCode, anchors}. Used by the deal allocation compliance panel.';

GRANT EXECUTE ON FUNCTION compliance.score_deal_funds(JSONB, DATE, TIMESTAMPTZ, VARCHAR, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
