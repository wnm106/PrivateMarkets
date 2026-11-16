-- Scores one rule for the funds on a deal in a single call.
-- Pro forma rules have no enrollment row, so the deal surface sets
-- p_ignore_enrollment. Enrolled rules leave it false and pass only the
-- funds that have a limit.

CREATE OR REPLACE FUNCTION compliance.evaluate_rules_for_funds(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_ids uuid[] DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL,
    p_ignore_enrollment boolean DEFAULT FALSE
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'pg_temp'
AS $$
DECLARE
    v_anchor uuid;
    v_run uuid;
    v_runs uuid[] := ARRAY[]::uuid[];
BEGIN
    IF p_anchor_ids IS NULL OR cardinality(p_anchor_ids) = 0 THEN
        RETURN v_runs;
    END IF;

    IF COALESCE(p_ignore_enrollment, FALSE) THEN
        PERFORM set_config('compliance.test_all_funds', 'on', TRUE);
    END IF;

    FOREACH v_anchor IN ARRAY p_anchor_ids LOOP
        v_run := compliance.evaluate_rule(
            p_rule_code, p_as_of_date, p_knowledge_date, p_source_scope,
            p_triggered_by, v_anchor, p_scenario_code
        );
        v_runs := v_runs || v_run;
    END LOOP;
    RETURN v_runs;
END;
$$;

COMMENT ON FUNCTION compliance.evaluate_rules_for_funds IS
    'Scores one rule for each fund id. When p_ignore_enrollment is true, funds without a threshold are included. Used by the deal allocation surface.';

GRANT EXECUTE ON FUNCTION compliance.evaluate_rules_for_funds(character varying, date, timestamp with time zone, character varying, uuid, uuid[], character varying, boolean) TO authenticated, service_role;

-- The deal score reads thresholds with the service role. This table was
-- granted to authenticated only, so that read failed.
GRANT SELECT, INSERT, UPDATE, DELETE ON compliance.rule_thresholds TO service_role;

NOTIFY pgrst, 'reload schema';
