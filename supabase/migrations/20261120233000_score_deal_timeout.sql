-- The API role cancels a statement at 8 seconds. Scoring every rule for a
-- deal is one statement, and a busy database was cancelling it before the
-- panel could render.

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
