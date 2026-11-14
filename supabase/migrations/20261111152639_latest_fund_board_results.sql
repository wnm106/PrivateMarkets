-- The fund-threshold board only needs the newest score for each fund, group,
-- and rank. Paging the append-only history (PostgREST caps a response at
-- max_rows) was a long series of round trips. One indexed read returns that
-- grain, and the JSON payload is a single row so the row cap does not truncate it.
--
-- A later run may score only one fund. DISTINCT ON keeps an older score for a
-- fund that the newer run did not touch. Scenario runs are excluded, matching
-- the board: a what-if score must not hide the book.

CREATE INDEX IF NOT EXISTS idx_compliance_results_latest_grain
    ON compliance.rule_evaluation_results (
        rule_id,
        anchor_entity_id,
        (COALESCE(group_by_value, '')),
        rank_position,
        evaluated_at DESC,
        id DESC
    );

CREATE INDEX IF NOT EXISTS idx_compliance_runs_scenario_rule
    ON compliance.rule_evaluation_runs (rule_id)
    WHERE COALESCE(metadata->>'scenario_code', '') <> '';

CREATE OR REPLACE FUNCTION compliance.latest_fund_board_results(p_rule_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    WITH scenario_runs AS (
        SELECT run.id
        FROM compliance.rule_evaluation_runs AS run
        WHERE run.rule_id = ANY(p_rule_ids)
          AND COALESCE(run.metadata->>'scenario_code', '') <> ''
    ),
    latest AS (
        SELECT DISTINCT ON (
            result.rule_id,
            result.anchor_entity_id,
            COALESCE(result.group_by_value, ''),
            result.rank_position
        )
            result.id,
            result.run_id,
            result.rule_id,
            result.rule_version_id,
            result.anchor_entity_id,
            result.group_by_value,
            result.as_of_date,
            result.knowledge_date,
            result.source_scope,
            result.numerator_value,
            result.denominator_value,
            result.computed_value,
            result.limit_direction,
            result.soft_limit_value,
            result.hard_limit_value,
            result.status,
            result.breach_amount,
            result.contributing_count,
            result.rank_position,
            result.evaluated_at
        FROM compliance.rule_evaluation_results AS result
        WHERE result.rule_id = ANY(p_rule_ids)
          AND NOT EXISTS (
              SELECT 1
              FROM scenario_runs
              WHERE scenario_runs.id = result.run_id
          )
        ORDER BY
            result.rule_id,
            result.anchor_entity_id,
            COALESCE(result.group_by_value, ''),
            result.rank_position,
            result.evaluated_at DESC,
            result.id DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(latest)), '[]'::jsonb)
    FROM latest;
$$;

COMMENT ON FUNCTION compliance.latest_fund_board_results(uuid[]) IS
    'Newest non-scenario evaluation row for each fund, group, and rank. The fund-threshold board reads this instead of paging the result history. Audit detail stays on the result row and is not included.';

REVOKE ALL ON FUNCTION compliance.latest_fund_board_results(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.latest_fund_board_results(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION compliance.latest_fund_board_results(uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
