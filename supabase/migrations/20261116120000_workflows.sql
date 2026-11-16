-- Workflows: multi-step automations that mix fixed steps, agent steps, and human review.
--
-- A workflow is a graph of steps. Every save is a new, immutable version, and a
-- run is pinned to the version it started on. A run is advanced by the job
-- worker (job type workflow.advance): each step is recorded before the next one
-- starts, so a run survives a crash, and can wait days for a person.
--
--   ops.workflows           the definition: name, client, which version is published
--   ops.workflow_versions   one row per save. Never updated.
--   ops.workflow_runs       one execution. context holds each finished step's output.
--   ops.workflow_steps      one row per step reached in a run. state is the step's checkpoint.
--   ops.workflow_events     append-only audit log: what the system, the agent, and people did.
--   ops.workflow_reviews    a pause for a person: the agent's proposed changes and the decision.
--
-- Like the job tables, these are reached only through the functions below.
-- client_id NULL on a workflow marks a shared one: every client can run it, and
-- only a tenant admin can change it. A run always belongs to one client.

CREATE TABLE IF NOT EXISTS ops.workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    workflow_code VARCHAR(100) NOT NULL,
    workflow_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    published_version INTEGER,
    latest_version INTEGER NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workflows_client_code
    ON ops.workflows (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), workflow_code);

CREATE TABLE IF NOT EXISTS ops.workflow_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES ops.workflows(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    graph JSONB NOT NULL,
    change_note TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS ops.workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES ops.workflows(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES ops.workflow_versions(id),
    version INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    input JSONB NOT NULL DEFAULT '{}',
    context JSONB NOT NULL DEFAULT '{}',
    current_node TEXT,
    error_message TEXT,
    started_by UUID,
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_runs_client_created ON ops.workflow_runs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_created ON ops.workflow_runs (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_label TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    input JSONB,
    output JSONB,
    state JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS ops.workflow_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    node_id TEXT,
    event_type TEXT NOT NULL,
    actor_type VARCHAR(10) NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM', 'AGENT', 'USER')),
    actor_id UUID,
    summary TEXT NOT NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS workflow_events_run ON ops.workflow_events (run_id, id);

CREATE TABLE IF NOT EXISTS ops.workflow_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT,
    summary TEXT,
    proposal JSONB NOT NULL DEFAULT '{"items": []}',
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED')),
    decision JSONB,
    decided_by UUID,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS workflow_reviews_open ON ops.workflow_reviews (client_id, created_at DESC) WHERE status = 'OPEN';

ALTER TABLE ops.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_reviews ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.workflow_versions IS 'One row per save of a workflow. Never updated, so a run can always show the graph it ran.';
COMMENT ON TABLE ops.workflow_events IS 'Append-only. No function updates or deletes a row.';
COMMENT ON COLUMN ops.workflow_steps.state IS 'The step''s checkpoint. An agent step keeps its conversation here so a restart continues it.';

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('workflow.manage', 'Create, change, publish, and archive workflows'),
    ('workflow.run', 'Start, cancel, and retry workflow runs'),
    ('workflow.review', 'Approve or reject the changes a workflow proposes')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code IN ('workflow.manage', 'workflow.run', 'workflow.review')
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ops.workflow_can(p_client_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN tenancy.is_tenant_admin() THEN TRUE
        WHEN p_client_id IS NULL THEN FALSE
        ELSE tenancy.has_permission(p_client_id, p_permission)
    END;
$$;

-- A shared workflow (no client) is visible to anyone who belongs to a client.
CREATE OR REPLACE FUNCTION ops.workflow_can_see(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN tenancy.is_tenant_admin() THEN TRUE
        WHEN p_client_id IS NULL THEN EXISTS (SELECT 1 FROM tenancy.current_client_ids())
        ELSE p_client_id IN (SELECT tenancy.current_client_ids())
    END;
$$;

CREATE OR REPLACE FUNCTION ops.workflow_log(
    p_run_id UUID,
    p_node_id TEXT,
    p_event_type TEXT,
    p_actor_type TEXT,
    p_actor_id UUID,
    p_summary TEXT,
    p_detail JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    INSERT INTO ops.workflow_events (run_id, node_id, event_type, actor_type, actor_id, summary, detail)
    VALUES (p_run_id, p_node_id, p_event_type, COALESCE(p_actor_type, 'SYSTEM'), p_actor_id, left(COALESCE(p_summary, ''), 2000), p_detail);
$$;

-- Queues the job that moves a run forward. Not deduplicated: a second job for
-- the same run finds the run locked, or finds nothing left to do.
CREATE OR REPLACE FUNCTION ops.workflow_queue_advance(p_run_id UUID, p_client_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, requested_by)
    VALUES (p_client_id, 'workflow.advance', jsonb_build_object('workflowRunId', p_run_id), 10, p_user_id);
$$;

-- ---------------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(w) || jsonb_build_object(
        'can_manage', ops.workflow_can(w.client_id, 'workflow.manage'),
        'run_count', (SELECT count(*) FROM ops.workflow_runs AS r WHERE r.workflow_id = w.id AND ops.workflow_can_see(r.client_id)),
        'last_run_at', (SELECT max(r.created_at) FROM ops.workflow_runs AS r WHERE r.workflow_id = w.id AND ops.workflow_can_see(r.client_id))
    )
    FROM ops.workflows AS w
    WHERE w.is_active AND ops.workflow_can_see(w.client_id)
    ORDER BY w.workflow_name;
$$;

-- One workflow with the graph of p_version (default: the latest save) and its version history.
CREATE OR REPLACE FUNCTION public.workflow_get(p_id UUID, p_version INTEGER DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(w) || jsonb_build_object(
        'can_manage', ops.workflow_can(w.client_id, 'workflow.manage'),
        'version', v.version,
        'graph', v.graph,
        'versions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'version', h.version, 'change_note', h.change_note, 'created_by', h.created_by, 'created_at', h.created_at
            ) ORDER BY h.version DESC)
            FROM ops.workflow_versions AS h WHERE h.workflow_id = w.id
        ), '[]'::jsonb)
    )
    FROM ops.workflows AS w
    LEFT JOIN ops.workflow_versions AS v
           ON v.workflow_id = w.id AND v.version = COALESCE(p_version, w.latest_version)
    WHERE w.id = p_id AND ops.workflow_can_see(w.client_id);
$$;

-- Saves a workflow. Every save adds a version. It does not publish it.
CREATE OR REPLACE FUNCTION public.workflow_save(
    p_id UUID,
    p_client_id UUID,
    p_code TEXT,
    p_name TEXT,
    p_description TEXT,
    p_graph JSONB,
    p_change_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.workflows;
BEGIN
    IF NULLIF(btrim(COALESCE(p_name, '')), '') IS NULL OR NULLIF(btrim(COALESCE(p_code, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A workflow needs a name and a code' USING ERRCODE = '22023';
    END IF;
    IF p_graph IS NULL OR jsonb_typeof(p_graph -> 'nodes') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'The workflow has no steps' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        IF NOT ops.workflow_can(p_client_id, 'workflow.manage') THEN
            RAISE EXCEPTION 'You cannot manage workflows for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO ops.workflows (client_id, workflow_code, workflow_name, description, created_by)
        VALUES (p_client_id, btrim(p_code), btrim(p_name), NULLIF(btrim(COALESCE(p_description, '')), ''), auth.uid())
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ops.workflows WHERE id = p_id FOR UPDATE;
        IF NOT FOUND OR NOT ops.workflow_can_see(v_row.client_id) THEN
            RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT ops.workflow_can(v_row.client_id, 'workflow.manage') THEN
            RAISE EXCEPTION 'You cannot manage this workflow' USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO ops.workflow_versions (workflow_id, version, graph, change_note, created_by)
    VALUES (v_row.id, v_row.latest_version + 1, p_graph, NULLIF(btrim(COALESCE(p_change_note, '')), ''), auth.uid());

    UPDATE ops.workflows
       SET workflow_name = btrim(p_name),
           description = NULLIF(btrim(COALESCE(p_description, '')), ''),
           latest_version = v_row.latest_version + 1,
           updated_at = NOW()
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN public.workflow_get(v_row.id, v_row.latest_version);
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Another workflow already uses this code' USING ERRCODE = '23505';
END;
$$;

-- Publishes a version: new runs use it. Runs already started keep their version.
CREATE OR REPLACE FUNCTION public.workflow_publish(p_id UUID, p_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.workflows;
BEGIN
    SELECT * INTO v_row FROM ops.workflows WHERE id = p_id;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_row.client_id) THEN
        RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.workflow_can(v_row.client_id, 'workflow.manage') THEN
        RAISE EXCEPTION 'You cannot manage this workflow' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ops.workflow_versions WHERE workflow_id = p_id AND version = p_version) THEN
        RAISE EXCEPTION 'That version does not exist' USING ERRCODE = 'P0002';
    END IF;
    UPDATE ops.workflows SET published_version = p_version, updated_at = NOW() WHERE id = p_id;
    RETURN public.workflow_get(p_id, p_version);
END;
$$;

-- Hides a workflow. Its runs and their history stay.
CREATE OR REPLACE FUNCTION public.workflow_archive(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.workflows WHERE id = p_id;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_client) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.workflow_can(v_client, 'workflow.manage') THEN
        RAISE EXCEPTION 'You cannot manage this workflow' USING ERRCODE = '42501';
    END IF;
    UPDATE ops.workflows SET is_active = FALSE, updated_at = NOW() WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

-- Starts a run on the published version, or on p_version to try a draft.
-- p_user_id is for the worker starting a scheduled run as the schedule's owner.
CREATE OR REPLACE FUNCTION public.workflow_run_start(
    p_workflow_id UUID,
    p_client_id UUID,
    p_input JSONB DEFAULT '{}',
    p_version INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_workflow ops.workflows;
    v_version ops.workflow_versions;
    v_user UUID := auth.uid();
    v_run_id UUID;
BEGIN
    IF ops.is_service_role() THEN
        v_user := COALESCE(p_user_id, v_user);
    END IF;
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'A run needs a client' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_workflow FROM ops.workflows WHERE id = p_workflow_id AND is_active;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_workflow.client_id) THEN
        RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_workflow.client_id IS NOT NULL AND v_workflow.client_id <> p_client_id THEN
        RAISE EXCEPTION 'This workflow belongs to another client' USING ERRCODE = '42501';
    END IF;
    IF NOT ops.workflow_can(p_client_id, 'workflow.run') THEN
        RAISE EXCEPTION 'You cannot run workflows for this client' USING ERRCODE = '42501';
    END IF;
    -- Only someone who can change the workflow may run a version that is not published.
    IF p_version IS NOT NULL AND p_version IS DISTINCT FROM v_workflow.published_version
       AND NOT ops.workflow_can(v_workflow.client_id, 'workflow.manage') THEN
        RAISE EXCEPTION 'Only the published version can be run' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(p_version, v_workflow.published_version) IS NULL THEN
        RAISE EXCEPTION 'This workflow has not been published' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_version FROM ops.workflow_versions
     WHERE workflow_id = p_workflow_id AND version = COALESCE(p_version, v_workflow.published_version);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That version does not exist' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version, input, started_by)
    VALUES (p_client_id, p_workflow_id, v_version.id, v_version.version, COALESCE(p_input, '{}'::jsonb), v_user)
    RETURNING id INTO v_run_id;

    PERFORM ops.workflow_log(v_run_id, NULL, 'run.started', CASE WHEN v_user IS NULL THEN 'SYSTEM' ELSE 'USER' END, v_user,
        'Run started on version ' || v_version.version, jsonb_build_object('input', COALESCE(p_input, '{}'::jsonb)));
    PERFORM ops.workflow_queue_advance(v_run_id, p_client_id, v_user);
    RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_runs_list(
    p_workflow_id UUID DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (to_jsonb(r) - 'context') || jsonb_build_object(
        'workflow_name', w.workflow_name,
        'open_reviews', (SELECT count(*) FROM ops.workflow_reviews AS v WHERE v.run_id = r.id AND v.status = 'OPEN')
    )
    FROM ops.workflow_runs AS r
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    WHERE ops.workflow_can_see(r.client_id)
      AND (p_workflow_id IS NULL OR r.workflow_id = p_workflow_id)
      AND (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

-- Everything about one run: the graph it ran, each step, the audit log, and its reviews.
CREATE OR REPLACE FUNCTION public.workflow_run_get(p_run_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(r) || jsonb_build_object(
        'workflow_name', w.workflow_name,
        'graph', v.graph,
        'can_run', ops.workflow_can(r.client_id, 'workflow.run'),
        'can_review', ops.workflow_can(r.client_id, 'workflow.review'),
        'steps', COALESCE((
            SELECT jsonb_agg((to_jsonb(s) - 'state') ORDER BY s.seq, s.started_at)
            FROM ops.workflow_steps AS s WHERE s.run_id = r.id
        ), '[]'::jsonb),
        'events', COALESCE((
            SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object(
                'actor_name', (SELECT p.display_name FROM tenancy.profiles AS p WHERE p.id = e.actor_id)
            ) ORDER BY e.id)
            FROM ops.workflow_events AS e WHERE e.run_id = r.id
        ), '[]'::jsonb),
        'reviews', COALESCE((
            SELECT jsonb_agg(to_jsonb(q) ORDER BY q.created_at)
            FROM ops.workflow_reviews AS q WHERE q.run_id = r.id
        ), '[]'::jsonb)
    )
    FROM ops.workflow_runs AS r
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    JOIN ops.workflow_versions AS v ON v.id = r.version_id
    WHERE r.id = p_run_id AND ops.workflow_can_see(r.client_id);
$$;

-- Stops a run that has not finished. A step already running is allowed to
-- finish; the worker sees the cancellation before it starts the next one.
CREATE OR REPLACE FUNCTION public.workflow_run_cancel(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_client) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.workflow_can(v_client, 'workflow.run') THEN
        RAISE EXCEPTION 'You cannot manage runs for this client' USING ERRCODE = '42501';
    END IF;
    UPDATE ops.workflow_runs
       SET status = 'CANCELLED', finished_at = NOW(), updated_at = NOW()
     WHERE id = p_run_id AND status IN ('QUEUED', 'RUNNING', 'WAITING');
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    UPDATE ops.workflow_reviews SET status = 'CANCELLED' WHERE run_id = p_run_id AND status = 'OPEN';
    PERFORM ops.workflow_log(p_run_id, NULL, 'run.cancelled', 'USER', auth.uid(), 'Run cancelled');
    RETURN TRUE;
END;
$$;

-- Puts a failed run back in the queue. It picks up at the step that failed;
-- the steps before it are not run again.
CREATE OR REPLACE FUNCTION public.workflow_run_retry(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_run.client_id) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.workflow_can(v_run.client_id, 'workflow.run') THEN
        RAISE EXCEPTION 'You cannot manage runs for this client' USING ERRCODE = '42501';
    END IF;
    UPDATE ops.workflow_runs
       SET status = 'QUEUED', error_message = NULL, finished_at = NULL, locked_by = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE id = p_run_id AND status = 'FAILED';
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    UPDATE ops.workflow_steps
       SET status = 'RUNNING', error_message = NULL, finished_at = NULL, updated_at = NOW()
     WHERE run_id = p_run_id AND status = 'FAILED';
    PERFORM ops.workflow_log(p_run_id, v_run.current_node, 'run.retried', 'USER', auth.uid(), 'Run retried from the failed step');
    PERFORM ops.workflow_queue_advance(p_run_id, v_run.client_id, auth.uid());
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_reviews_list(p_status TEXT DEFAULT 'OPEN', p_limit INTEGER DEFAULT 100)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (to_jsonb(q) - 'proposal' - 'decision') || jsonb_build_object(
        'workflow_name', w.workflow_name,
        'item_count', jsonb_array_length(COALESCE(q.proposal -> 'items', '[]'::jsonb)),
        'can_review', ops.workflow_can(q.client_id, 'workflow.review')
    )
    FROM ops.workflow_reviews AS q
    JOIN ops.workflow_runs AS r ON r.id = q.run_id
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    WHERE ops.workflow_can_see(q.client_id)
      AND (p_status IS NULL OR q.status = p_status)
    ORDER BY q.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

-- One review with its full proposal.
CREATE OR REPLACE FUNCTION public.workflow_review_get(p_review_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(q) || jsonb_build_object(
        'workflow_name', w.workflow_name,
        'can_review', ops.workflow_can(q.client_id, 'workflow.review')
    )
    FROM ops.workflow_reviews AS q
    JOIN ops.workflow_runs AS r ON r.id = q.run_id
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    WHERE q.id = p_review_id AND ops.workflow_can_see(q.client_id);
$$;

-- Records a person's decision and queues the run to continue. p_outcome is
-- APPROVED (at least one change goes ahead) or REJECTED (none do). p_decision
-- holds the choice, answers, and edits for each proposed change.
CREATE OR REPLACE FUNCTION public.workflow_review_decide(
    p_review_id UUID,
    p_outcome TEXT,
    p_decision JSONB DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_review ops.workflow_reviews;
    v_run ops.workflow_runs;
BEGIN
    IF p_outcome NOT IN ('APPROVED', 'REJECTED') THEN
        RAISE EXCEPTION 'A review is approved or rejected' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_review FROM ops.workflow_reviews WHERE id = p_review_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_review.client_id) THEN
        RAISE EXCEPTION 'Review was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.workflow_can(v_review.client_id, 'workflow.review') THEN
        RAISE EXCEPTION 'You cannot review changes for this client' USING ERRCODE = '42501';
    END IF;
    IF v_review.status <> 'OPEN' THEN
        RAISE EXCEPTION 'This review has already been decided' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = v_review.run_id;
    IF v_run.status NOT IN ('WAITING', 'RUNNING', 'QUEUED') THEN
        RAISE EXCEPTION 'The run is no longer waiting for this review' USING ERRCODE = '22023';
    END IF;

    UPDATE ops.workflow_reviews
       SET status = p_outcome, decision = COALESCE(p_decision, '{}'::jsonb), decided_by = auth.uid(), decided_at = NOW()
     WHERE id = p_review_id
    RETURNING * INTO v_review;

    PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.decided', 'USER', auth.uid(),
        CASE WHEN p_outcome = 'APPROVED' THEN 'Review approved' ELSE 'Review rejected' END,
        jsonb_build_object('reviewId', v_review.id, 'outcome', p_outcome, 'decision', COALESCE(p_decision, '{}'::jsonb)));
    PERFORM ops.workflow_queue_advance(v_review.run_id, v_review.client_id, auth.uid());
    RETURN to_jsonb(v_review);
END;
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (service_role only)
-- ---------------------------------------------------------------------------

-- Takes the run for p_owner and returns it with its graph, steps, and reviews.
-- Returns {"busy": true} while another job holds it, and NULL when there is no such run.
CREATE OR REPLACE FUNCTION public.workflow_worker_load(
    p_run_id UUID,
    p_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 900
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
        RETURN jsonb_build_object('done', TRUE, 'status', v_run.status);
    END IF;
    IF v_run.locked_by IS NOT NULL AND v_run.locked_by <> p_owner AND v_run.lease_expires_at > NOW() THEN
        RETURN jsonb_build_object('busy', TRUE);
    END IF;

    UPDATE ops.workflow_runs
       SET locked_by = p_owner,
           lease_expires_at = NOW() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 900), 30)),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
     WHERE id = p_run_id
    RETURNING * INTO v_run;

    RETURN to_jsonb(v_run) || jsonb_build_object(
        'graph', (SELECT v.graph FROM ops.workflow_versions AS v WHERE v.id = v_run.version_id),
        'workflow_name', (SELECT w.workflow_name FROM ops.workflows AS w WHERE w.id = v_run.workflow_id),
        'steps', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.seq) FROM ops.workflow_steps AS s WHERE s.run_id = v_run.id), '[]'::jsonb),
        'reviews', COALESCE((SELECT jsonb_agg(to_jsonb(q)) FROM ops.workflow_reviews AS q WHERE q.run_id = v_run.id), '[]'::jsonb)
    );
END;
$$;

-- Records a step. p_patch may carry nodeType, nodeLabel, status, outcome, input,
-- output, state, error, and countAttempt. Also renews the run's lease. Returns
-- FALSE when p_owner no longer holds the run, and the caller must stop.
CREATE OR REPLACE FUNCTION public.workflow_worker_step(
    p_run_id UUID,
    p_owner TEXT,
    p_node_id TEXT,
    p_patch JSONB,
    p_lease_seconds INTEGER DEFAULT 900
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_status TEXT := p_patch ->> 'status';
BEGIN
    UPDATE ops.workflow_runs
       SET lease_expires_at = NOW() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 900), 30)), updated_at = NOW()
     WHERE id = p_run_id AND locked_by = p_owner AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    INSERT INTO ops.workflow_steps (run_id, node_id, node_type, node_label, seq, status, attempts, outcome, input, output, state, error_message, finished_at)
    VALUES (
        p_run_id, p_node_id, COALESCE(p_patch ->> 'nodeType', 'tool'), p_patch ->> 'nodeLabel',
        (SELECT count(*) FROM ops.workflow_steps WHERE run_id = p_run_id),
        COALESCE(v_status, 'RUNNING'), CASE WHEN (p_patch ->> 'countAttempt')::boolean THEN 1 ELSE 0 END,
        p_patch ->> 'outcome', p_patch -> 'input', p_patch -> 'output', p_patch -> 'state', p_patch ->> 'error',
        CASE WHEN v_status IN ('SUCCEEDED', 'FAILED', 'SKIPPED') THEN NOW() END
    )
    ON CONFLICT (run_id, node_id) DO UPDATE
       SET status = COALESCE(v_status, ops.workflow_steps.status),
           attempts = ops.workflow_steps.attempts + CASE WHEN (p_patch ->> 'countAttempt')::boolean THEN 1 ELSE 0 END,
           outcome = CASE WHEN p_patch ? 'outcome' THEN p_patch ->> 'outcome' ELSE ops.workflow_steps.outcome END,
           input = CASE WHEN p_patch ? 'input' THEN p_patch -> 'input' ELSE ops.workflow_steps.input END,
           output = CASE WHEN p_patch ? 'output' THEN p_patch -> 'output' ELSE ops.workflow_steps.output END,
           state = CASE WHEN p_patch ? 'state' THEN p_patch -> 'state' ELSE ops.workflow_steps.state END,
           error_message = CASE WHEN p_patch ? 'error' THEN p_patch ->> 'error' ELSE ops.workflow_steps.error_message END,
           finished_at = CASE WHEN v_status IN ('SUCCEEDED', 'FAILED', 'SKIPPED') THEN NOW() ELSE ops.workflow_steps.finished_at END,
           updated_at = NOW();
    RETURN TRUE;
END;
$$;

-- Updates the run. p_patch may carry status, currentNode, error, and context
-- (merged into the stored context by step). p_release gives up the lock.
-- Returns the run's status after the update, or NULL when p_owner does not hold it.
-- A cancelled run stays cancelled.
CREATE OR REPLACE FUNCTION public.workflow_worker_run(
    p_run_id UUID,
    p_owner TEXT,
    p_patch JSONB,
    p_release BOOLEAN DEFAULT FALSE
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_status TEXT;
    v_new TEXT := p_patch ->> 'status';
BEGIN
    UPDATE ops.workflow_runs
       SET status = CASE WHEN status = 'CANCELLED' THEN status ELSE COALESCE(v_new, status) END,
           current_node = CASE WHEN p_patch ? 'currentNode' THEN p_patch ->> 'currentNode' ELSE current_node END,
           error_message = CASE WHEN p_patch ? 'error' THEN p_patch ->> 'error' ELSE error_message END,
           context = CASE WHEN p_patch ? 'context' THEN context || (p_patch -> 'context') ELSE context END,
           finished_at = CASE WHEN status <> 'CANCELLED' AND v_new IN ('SUCCEEDED', 'FAILED') THEN NOW() ELSE finished_at END,
           locked_by = CASE WHEN COALESCE(p_release, FALSE) THEN NULL ELSE locked_by END,
           lease_expires_at = CASE WHEN COALESCE(p_release, FALSE) THEN NULL ELSE lease_expires_at END,
           updated_at = NOW()
     WHERE id = p_run_id AND locked_by = p_owner
    RETURNING status INTO v_status;
    RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_worker_event(
    p_run_id UUID,
    p_node_id TEXT,
    p_event_type TEXT,
    p_actor_type TEXT,
    p_actor_id UUID,
    p_summary TEXT,
    p_detail JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT ops.workflow_log(p_run_id, p_node_id, p_event_type, p_actor_type, p_actor_id, p_summary, p_detail);
$$;

-- Opens the review for a step. Asking twice returns the review already there.
CREATE OR REPLACE FUNCTION public.workflow_worker_review(
    p_run_id UUID,
    p_node_id TEXT,
    p_title TEXT,
    p_instructions TEXT,
    p_summary TEXT,
    p_proposal JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_review ops.workflow_reviews;
BEGIN
    INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title, instructions, summary, proposal)
    SELECT r.id, r.client_id, p_node_id, COALESCE(NULLIF(btrim(p_title), ''), 'Review'), p_instructions, p_summary,
           COALESCE(p_proposal, '{"items": []}'::jsonb)
    FROM ops.workflow_runs AS r WHERE r.id = p_run_id
    ON CONFLICT (run_id, node_id) DO NOTHING;
    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    RETURN to_jsonb(v_review);
END;
$$;

-- For the workflow.start job: finds a workflow by code for a client. The
-- client's own workflow wins over a shared one with the same code.
CREATE OR REPLACE FUNCTION public.workflow_worker_find(p_client_id UUID, p_code TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT w.id
    FROM ops.workflows AS w
    WHERE w.is_active AND w.workflow_code = p_code AND (w.client_id = p_client_id OR w.client_id IS NULL)
    ORDER BY w.client_id NULLS LAST
    LIMIT 1;
$$;

-- Why a person can no longer act for a client, or NULL when they can. The
-- worker checks this before it reads as the run's owner or writes as the
-- reviewer. As with jobs that run as their owner, the person must belong to
-- this client only: a step reads everything its person can see, and a run's
-- results must stay with the run's client.
CREATE OR REPLACE FUNCTION public.workflow_worker_member(p_user_id UUID, p_client_id UUID, p_permission TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 'This step has no person to run as.';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, TRUE);

    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
    IF v_clients IS NULL OR NOT (p_client_id = ANY (v_clients)) THEN
        RETURN 'The person this step runs as no longer belongs to this client.';
    END IF;
    IF cardinality(v_clients) > 1 THEN
        RETURN 'The person this step runs as belongs to more than one client. A workflow step needs a person with one client, so what it reads stays with that client.';
    END IF;
    IF NOT tenancy.has_permission(p_client_id, p_permission) THEN
        RETURN 'The person this step runs as does not hold ' || p_permission || ' for this client.';
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.workflow_can(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_can_see(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_log(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_queue_advance(UUID, UUID, UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.workflow_worker_load(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_step(UUID, TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_run(UUID, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_event(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_find(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_member(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_worker_load(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_step(UUID, TEXT, TEXT, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_run(UUID, TEXT, JSONB, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_event(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_find(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_member(UUID, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.workflow_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_get(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_publish(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_archive(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_start(UUID, UUID, JSONB, INTEGER, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_runs_list(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_cancel(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_retry(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_reviews_list(TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_review_get(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workflow_review_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_get(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_publish(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_archive(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_start(UUID, UUID, JSONB, INTEGER, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_runs_list(UUID, TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_cancel(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_retry(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_reviews_list(TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
