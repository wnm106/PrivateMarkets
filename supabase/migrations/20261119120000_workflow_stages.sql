-- Stage steps: a workflow step that puts one screen in front of a person.
--
-- A Human review shows a table of proposed changes and a form asks for values.
-- A Stage names a screen (mapping a file, checking staged values) and waits
-- until a person leaves it with one of the screen's outcomes. The run's page
-- shows the screen of the stage that is open, so a run that passes through
-- several stages reads as one guided piece of work.
--
-- The screen's outcomes, and what a person must hold to choose each, are kept
-- on the stage when it opens, so the database holds every decision to them.
-- The worker can hand a stage back to the person, with the reason, when what
-- the screen was left with does not hold up.
--
-- Also lets a client's workflow service account promote and revert loads, so a
-- workflow's fixed step can promote the batch a person approved in a stage.
--
-- Safe to run again.

CREATE TABLE IF NOT EXISTS ops.workflow_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    screen TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT,
    args JSONB NOT NULL DEFAULT '{}',
    outcomes TEXT[] NOT NULL DEFAULT '{}',
    permissions JSONB NOT NULL DEFAULT '{}',
    assigned_users UUID[] NOT NULL DEFAULT '{}',
    assigned_roles TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
    outcome TEXT,
    result JSONB,
    -- Why the stage was handed back, when it was.
    returned_reason TEXT,
    returned_count INTEGER NOT NULL DEFAULT 0,
    completed_by UUID,
    completed_at TIMESTAMPTZ,
    due_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS workflow_stages_open ON ops.workflow_stages (client_id, created_at DESC) WHERE status = 'OPEN';
ALTER TABLE ops.workflow_stages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.workflow_stages IS 'A screen a workflow step is waiting on a person to work through. Reached only through the workflow_stage* functions.';

-- Opens a stage for a step, or returns the one already there.
CREATE OR REPLACE FUNCTION public.workflow_worker_stage(p_run_id UUID, p_node_id TEXT, p_spec JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
    v_stage ops.workflow_stages;
    v_spec JSONB := CASE WHEN jsonb_typeof(p_spec) = 'object' THEN p_spec ELSE '{}'::jsonb END;
    v_hours NUMERIC;
    v_users UUID[];
    v_roles TEXT[];
    v_outcomes TEXT[];
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_stage FROM ops.workflow_stages WHERE run_id = p_run_id AND node_id = p_node_id;
    IF FOUND THEN
        RETURN to_jsonb(v_stage) || jsonb_build_object('created', FALSE);
    END IF;

    SELECT COALESCE(array_agg(x), '{}') INTO v_outcomes
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_spec -> 'outcomes') = 'array' THEN v_spec -> 'outcomes' ELSE '[]'::jsonb END) AS x
    WHERE btrim(x) <> '';
    IF NULLIF(btrim(COALESCE(v_spec ->> 'screen', '')), '') IS NULL OR cardinality(v_outcomes) = 0 THEN
        RAISE EXCEPTION 'A stage needs a screen and at least one outcome' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT x::uuid), '{}') INTO v_users
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_spec -> 'people') = 'array' THEN v_spec -> 'people' ELSE '[]'::jsonb END) AS x
    WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND ops.workflow_user_can_review(v_run.client_id, x::uuid);
    SELECT COALESCE(array_agg(DISTINCT upper(btrim(x))), '{}') INTO v_roles
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_spec -> 'roles') = 'array' THEN v_spec -> 'roles' ELSE '[]'::jsonb END) AS x
    WHERE btrim(x) <> '';
    BEGIN
        v_hours := NULLIF(v_spec ->> 'dueInHours', '')::numeric;
    EXCEPTION WHEN others THEN
        v_hours := NULL;
    END;

    INSERT INTO ops.workflow_stages (run_id, client_id, node_id, screen, title, instructions, args, outcomes, permissions,
                                     assigned_users, assigned_roles, due_at)
    VALUES (v_run.id, v_run.client_id, p_node_id, btrim(v_spec ->> 'screen'),
            COALESCE(NULLIF(btrim(v_spec ->> 'title'), ''), 'Your decision is needed'),
            NULLIF(v_spec ->> 'instructions', ''),
            CASE WHEN jsonb_typeof(v_spec -> 'args') = 'object' THEN v_spec -> 'args' ELSE '{}'::jsonb END,
            v_outcomes,
            CASE WHEN jsonb_typeof(v_spec -> 'permissions') = 'object' THEN v_spec -> 'permissions' ELSE '{}'::jsonb END,
            v_users, v_roles,
            CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END)
    ON CONFLICT (run_id, node_id) DO NOTHING
    RETURNING * INTO v_stage;

    PERFORM ops.workflow_log(v_run.id, p_node_id, 'stage.opened', 'SYSTEM', NULL,
        'Waiting for a person at "' || v_stage.title || '"', jsonb_build_object('stageId', v_stage.id, 'screen', v_stage.screen));
    RETURN to_jsonb(v_stage) || jsonb_build_object('created', TRUE);
END;
$$;

-- Hands a stage back to the person, with the reason. The run waits on it again.
CREATE OR REPLACE FUNCTION public.workflow_worker_stage_return(p_stage_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_stage ops.workflow_stages;
BEGIN
    UPDATE ops.workflow_stages
       SET status = 'OPEN', outcome = NULL, returned_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
           returned_count = returned_count + 1, completed_by = NULL, completed_at = NULL
     WHERE id = p_stage_id AND status = 'DONE'
    RETURNING * INTO v_stage;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    PERFORM ops.workflow_log(v_stage.run_id, v_stage.node_id, 'stage.returned', 'SYSTEM', NULL,
        '"' || v_stage.title || '" was handed back. ' || COALESCE(v_stage.returned_reason, ''), jsonb_build_object('stageId', v_stage.id));
    RETURN to_jsonb(v_stage) || jsonb_build_object('created', FALSE);
END;
$$;

-- Whether the signed-in person may work a stage, or why not.
CREATE OR REPLACE FUNCTION ops.workflow_stage_blocker(p_stage ops.workflow_stages)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN NULL
        WHEN p_stage.status <> 'OPEN' THEN 'This stage is finished.'
        WHEN NOT ops.workflow_can(p_stage.client_id, 'workflow.review') THEN 'You do not hold the review permission for this client.'
        WHEN NOT ops.workflow_review_assigned(p_stage.client_id, auth.uid(), p_stage.assigned_users, p_stage.assigned_roles) THEN 'This stage is for someone else.'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION ops.workflow_stage_view(p_stage ops.workflow_stages)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(p_stage) || jsonb_build_object(
        'blocker', ops.workflow_stage_blocker(p_stage),
        'can_act', ops.workflow_stage_blocker(p_stage) IS NULL,
        -- The outcomes this person may choose: all of them, less any they lack the permission for.
        'allowed_outcomes', (
            SELECT COALESCE(jsonb_agg(o), '[]'::jsonb)
            FROM unnest(p_stage.outcomes) AS o
            WHERE NOT (p_stage.permissions ? o) OR ops.workflow_can(p_stage.client_id, p_stage.permissions ->> o)
        ),
        'workflow_name', (SELECT w.workflow_name FROM ops.workflow_runs AS r JOIN ops.workflows AS w ON w.id = r.workflow_id WHERE r.id = p_stage.run_id),
        'assignees', ops.workflow_review_assignees(p_stage.client_id, p_stage.assigned_users, p_stage.assigned_roles),
        'completed_by_name', (SELECT display_name FROM tenancy.profiles WHERE id = p_stage.completed_by)
    );
$$;

CREATE OR REPLACE FUNCTION public.workflow_stages_list(p_status TEXT DEFAULT 'OPEN', p_run_id UUID DEFAULT NULL)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.workflow_stage_view(s)
    FROM ops.workflow_stages AS s
    WHERE ops.workflow_can_see(s.client_id)
      AND (p_status IS NULL OR s.status = p_status)
      AND (p_run_id IS NULL OR s.run_id = p_run_id)
    ORDER BY s.due_at NULLS LAST, s.created_at
    LIMIT 200;
$$;

-- A person leaves a stage with one of its outcomes, and the run goes on.
CREATE OR REPLACE FUNCTION public.workflow_stage_complete(p_stage_id UUID, p_outcome TEXT, p_result JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_stage ops.workflow_stages;
    v_blocker TEXT;
    v_needs TEXT;
BEGIN
    SELECT * INTO v_stage FROM ops.workflow_stages WHERE id = p_stage_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_stage.client_id) THEN
        RAISE EXCEPTION 'Stage was not found' USING ERRCODE = 'P0002';
    END IF;
    v_blocker := ops.workflow_stage_blocker(v_stage);
    IF v_blocker IS NOT NULL THEN
        RAISE EXCEPTION '%', v_blocker USING ERRCODE = '42501';
    END IF;
    IF p_outcome IS NULL OR NOT (p_outcome = ANY (v_stage.outcomes)) THEN
        RAISE EXCEPTION 'This stage ends with one of: %', array_to_string(v_stage.outcomes, ', ') USING ERRCODE = '22023';
    END IF;
    v_needs := v_stage.permissions ->> p_outcome;
    IF v_needs IS NOT NULL AND NOT ops.workflow_can(v_stage.client_id, v_needs) THEN
        RAISE EXCEPTION 'You need the % permission to do that. Ask a client admin.', v_needs USING ERRCODE = '42501';
    END IF;
    UPDATE ops.workflow_stages
       SET status = 'DONE', outcome = p_outcome,
           result = CASE WHEN jsonb_typeof(p_result) = 'object' THEN p_result ELSE '{}'::jsonb END,
           returned_reason = NULL, completed_by = auth.uid(), completed_at = NOW()
     WHERE id = p_stage_id
    RETURNING * INTO v_stage;
    PERFORM ops.workflow_log(v_stage.run_id, v_stage.node_id, 'stage.completed', 'USER', auth.uid(),
        '"' || v_stage.title || '": ' || p_outcome, jsonb_build_object('stageId', v_stage.id, 'outcome', p_outcome));
    PERFORM ops.workflow_queue_advance(v_stage.run_id, v_stage.client_id, auth.uid());
    RETURN ops.workflow_stage_view(v_stage);
END;
$$;

-- Cancelling a run also closes its open stages.
CREATE OR REPLACE FUNCTION ops.workflow_stages_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
        UPDATE ops.workflow_stages SET status = 'CANCELLED' WHERE run_id = NEW.id AND status = 'OPEN';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workflow_stages_cancel ON ops.workflow_runs;
CREATE TRIGGER workflow_stages_cancel AFTER UPDATE OF status ON ops.workflow_runs
    FOR EACH ROW EXECUTE FUNCTION ops.workflow_stages_cancel();

REVOKE ALL ON FUNCTION public.workflow_worker_stage(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_stage_return(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.workflow_stage_blocker(ops.workflow_stages) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_stage_view(ops.workflow_stages) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_stages_list(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_stage_complete(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ops.workflow_stages_cancel() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.workflow_worker_stage(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_stage_return(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_stages_list(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_stage_complete(UUID, TEXT, JSONB) TO authenticated, service_role;

-- A workflow's fixed step promotes the batch a person approved, as the client's service account.
INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'load.promote'
WHERE r.role_code = 'WORKFLOW_SERVICE' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
