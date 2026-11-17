-- How workflows are doing: per workflow, over the last p_days, how many runs
-- finished each way, how long they took, how long people took to review,
-- how many reviews went overdue, how many proposed changes were approved,
-- the slowest steps, and the most common failure. Read only, for any member
-- of the client.

CREATE OR REPLACE FUNCTION public.workflow_analytics(p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    WITH bounds AS (SELECT NOW() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)) AS since),
    runs AS (
        SELECT r.*, w.workflow_name, w.workflow_code
        FROM ops.workflow_runs AS r
        JOIN ops.workflows AS w ON w.id = r.workflow_id
        WHERE ops.workflow_can_see(r.client_id) AND r.created_at >= (SELECT since FROM bounds)
    ),
    per_workflow AS (
        SELECT r.workflow_id, min(r.workflow_name) AS name, min(r.workflow_code) AS code,
               count(*) AS runs,
               count(*) FILTER (WHERE r.status = 'SUCCEEDED') AS succeeded,
               count(*) FILTER (WHERE r.status = 'FAILED') AS failed,
               count(*) FILTER (WHERE r.status = 'CANCELLED') AS cancelled,
               count(*) FILTER (WHERE r.status IN ('QUEUED', 'RUNNING', 'WAITING')) AS open,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - COALESCE(r.started_at, r.created_at)))
                   FILTER (WHERE r.status = 'SUCCEEDED' AND r.finished_at IS NOT NULL) AS median_seconds,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - COALESCE(r.started_at, r.created_at)))
                   FILTER (WHERE r.status = 'SUCCEEDED' AND r.finished_at IS NOT NULL) AS p90_seconds
        FROM runs AS r
        GROUP BY r.workflow_id
    ),
    reviews AS (
        SELECT r.workflow_id, q.*
        FROM ops.workflow_reviews AS q
        JOIN runs AS r ON r.id = q.run_id
    ),
    per_review AS (
        SELECT workflow_id,
               count(*) AS reviews,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - created_at)) FILTER (WHERE decided_at IS NOT NULL) AS median_review_seconds,
               count(*) FILTER (WHERE due_at IS NOT NULL AND (overdue_notified_at IS NOT NULL OR (status = 'OPEN' AND due_at < NOW()) OR decided_at > due_at)) AS overdue,
               count(*) FILTER (WHERE status = 'OPEN') AS waiting,
               sum((SELECT count(*) FROM jsonb_each(COALESCE(decision -> 'items', '{}'::jsonb)) AS d WHERE d.value ->> 'decision' = 'APPROVE')) AS changes_approved,
               sum((SELECT count(*) FROM jsonb_each(COALESCE(decision -> 'items', '{}'::jsonb)) AS d WHERE d.value ->> 'decision' = 'REJECT')) AS changes_rejected
        FROM reviews
        GROUP BY workflow_id
    ),
    steps AS (
        SELECT r.workflow_id, s.node_label, s.node_type,
               avg(extract(epoch FROM s.finished_at - s.started_at)) FILTER (WHERE s.status = 'SUCCEEDED' AND s.finished_at IS NOT NULL) AS avg_seconds,
               count(*) FILTER (WHERE s.status = 'FAILED') AS failures
        FROM ops.workflow_steps AS s
        JOIN runs AS r ON r.id = s.run_id
        WHERE s.node_type NOT IN ('start', 'end')
        GROUP BY r.workflow_id, s.node_id, s.node_label, s.node_type
    ),
    slowest AS (
        SELECT workflow_id, jsonb_agg(jsonb_build_object('step', node_label, 'type', node_type, 'avgSeconds', round(avg_seconds::numeric, 1), 'failures', failures)
                                      ORDER BY avg_seconds DESC NULLS LAST) FILTER (WHERE rk <= 3) AS top
        FROM (SELECT st.*, row_number() OVER (PARTITION BY workflow_id ORDER BY avg_seconds DESC NULLS LAST) AS rk FROM steps AS st) AS ranked
        GROUP BY workflow_id
    ),
    failures AS (
        SELECT DISTINCT ON (workflow_id) workflow_id, left(error_message, 200) AS error, count(*) OVER (PARTITION BY workflow_id, error_message) AS times
        FROM runs
        WHERE status = 'FAILED' AND error_message IS NOT NULL
        ORDER BY workflow_id, count(*) OVER (PARTITION BY workflow_id, error_message) DESC
    )
    SELECT jsonb_build_object(
        'days', LEAST(GREATEST(COALESCE(p_days, 30), 1), 365),
        'workflows', COALESCE(jsonb_agg(jsonb_build_object(
            'workflowId', p.workflow_id,
            'name', p.name,
            'code', p.code,
            'runs', p.runs,
            'succeeded', p.succeeded,
            'failed', p.failed,
            'cancelled', p.cancelled,
            'open', p.open,
            'medianSeconds', round(p.median_seconds::numeric, 1),
            'p90Seconds', round(p.p90_seconds::numeric, 1),
            'reviews', COALESCE(v.reviews, 0),
            'reviewsWaiting', COALESCE(v.waiting, 0),
            'reviewsOverdue', COALESCE(v.overdue, 0),
            'medianReviewSeconds', round(v.median_review_seconds::numeric, 1),
            'changesApproved', COALESCE(v.changes_approved, 0),
            'changesRejected', COALESCE(v.changes_rejected, 0),
            'slowestSteps', COALESCE(s.top, '[]'::jsonb),
            'commonFailure', CASE WHEN f.error IS NULL THEN NULL ELSE jsonb_build_object('error', f.error, 'times', f.times) END
        ) ORDER BY p.runs DESC, p.name), '[]'::jsonb)
    )
    FROM per_workflow AS p
    LEFT JOIN per_review AS v ON v.workflow_id = p.workflow_id
    LEFT JOIN slowest AS s ON s.workflow_id = p.workflow_id
    LEFT JOIN failures AS f ON f.workflow_id = p.workflow_id;
$$;

REVOKE ALL ON FUNCTION public.workflow_analytics(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workflow_analytics(INTEGER) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
