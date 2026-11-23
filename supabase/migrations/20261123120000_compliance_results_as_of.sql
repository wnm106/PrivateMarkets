-- The compliance dashboard shows every entity type that has results, with the
-- newest score for each rule, entity, group and rank at the user's As Of and
-- Knowledge dates. latest_fund_board_results returns the newest score with no
-- dates. This function adds the two dates and names the scored entity, so the
-- dashboard reads one row and the PostgREST row cap does not truncate it.
--
-- A null date means no bound. Scenario runs are excluded, as on the fund board:
-- a what-if score must not hide the book. SECURITY INVOKER, so the caller's
-- row security on results and entities applies.

CREATE OR REPLACE FUNCTION compliance.latest_results_as_of(
    p_rule_ids uuid[],
    p_as_of_date date DEFAULT NULL,
    p_knowledge_date timestamptz DEFAULT NULL
)
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
          AND (p_as_of_date IS NULL OR result.as_of_date <= p_as_of_date)
          AND (p_knowledge_date IS NULL OR result.knowledge_date <= p_knowledge_date)
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
            result.as_of_date DESC,
            result.evaluated_at DESC,
            result.id DESC
    )
    SELECT COALESCE(jsonb_agg(
        to_jsonb(latest) || jsonb_build_object(
            'anchor_entity_code', entity.entity_code,
            'anchor_entity_name', entity.entity_name,
            'anchor_domain_code', entity.domain_code
        )
    ), '[]'::jsonb)
    FROM latest
    LEFT JOIN entity_instances.master_entities AS entity
        ON entity.id = latest.anchor_entity_id;
$$;

COMMENT ON FUNCTION compliance.latest_results_as_of(uuid[], date, timestamptz) IS
    'Newest non-scenario evaluation row for each rule, entity, group and rank at an as-of date and knowledge instant, with the scored entity''s code, name and type. The compliance dashboard reads this.';

REVOKE ALL ON FUNCTION compliance.latest_results_as_of(uuid[], date, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.latest_results_as_of(uuid[], date, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION compliance.latest_results_as_of(uuid[], date, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
