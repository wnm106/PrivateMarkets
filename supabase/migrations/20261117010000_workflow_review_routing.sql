-- Who may decide a workflow review.
--
-- A review step can now say:
--   * who it is for: named people, roles, or both. Blank means anyone in the
--     client who holds workflow.review, as before;
--   * that the person who started the run may not decide it (separation of
--     duties). On by default for every review opened from now on;
--   * how long the reviewer has, as a due date.
--
-- The rules are kept in one place, ops.workflow_review_blocker, which the
-- lists, the run page, and workflow_review_decide all call. The API and the
-- page only show what it says.
--
-- A review opened before this migration keeps the rules it was opened under:
-- no assignment, and the starter may decide it.

ALTER TABLE ops.workflow_reviews
    ADD COLUMN IF NOT EXISTS assigned_users UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS assigned_roles TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS separate_reviewer BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assigned_by UUID,
    ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Existing rows keep FALSE. Every review opened from now on says what its step
-- says, and workflow_worker_review always sets it.
ALTER TABLE ops.workflow_reviews ALTER COLUMN separate_reviewer SET DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS workflow_reviews_assigned_users ON ops.workflow_reviews USING GIN (assigned_users) WHERE status = 'OPEN';

COMMENT ON COLUMN ops.workflow_reviews.assigned_users IS 'People the review is for. With assigned_roles empty too, anyone holding workflow.review may decide it.';
COMMENT ON COLUMN ops.workflow_reviews.assigned_roles IS 'Role codes the review is for, held in the run''s client.';
COMMENT ON COLUMN ops.workflow_reviews.separate_reviewer IS 'When true, the person who started the run may not decide this review.';
COMMENT ON COLUMN ops.workflow_reviews.due_at IS 'When the review should be decided by. Shown as overdue after it; nothing is decided automatically.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Whether a person holds workflow.review in a client through one of their roles.
CREATE OR REPLACE FUNCTION ops.workflow_user_can_review(p_client_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tenancy.client_users AS cu
        JOIN tenancy.user_roles AS ur ON ur.client_id = cu.client_id AND ur.user_id = cu.user_id
        JOIN tenancy.role_permissions AS rp ON rp.role_id = ur.role_id
        JOIN tenancy.permissions AS p ON p.id = rp.permission_id
        JOIN tenancy.profiles AS pr ON pr.id = cu.user_id
        WHERE cu.client_id = p_client_id AND cu.user_id = p_user_id AND cu.is_active AND pr.is_active
          AND p.permission_code = 'workflow.review'
    );
$$;

-- Whether a person is one a review is assigned to. An unassigned review is for everyone.
CREATE OR REPLACE FUNCTION ops.workflow_review_assigned(p_client_id UUID, p_user_id UUID, p_users UUID[], p_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (COALESCE(cardinality(p_users), 0) = 0 AND COALESCE(cardinality(p_roles), 0) = 0)
        OR p_user_id = ANY (COALESCE(p_users, '{}'))
        OR EXISTS (
            SELECT 1
            FROM tenancy.user_roles AS ur
            JOIN tenancy.roles AS ro ON ro.id = ur.role_id
            WHERE ur.user_id = p_user_id AND ur.client_id = p_client_id AND ro.role_code = ANY (COALESCE(p_roles, '{}'))
        );
$$;

-- The names a review is assigned to: each person, then each role.
CREATE OR REPLACE FUNCTION ops.workflow_review_assignees(p_client_id UUID, p_users UUID[], p_roles TEXT[])
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT COALESCE((
        SELECT jsonb_agg(jsonb_build_object('kind', 'person', 'id', u.id, 'name', COALESCE(p.display_name, 'Unknown person')) ORDER BY u.ord)
        FROM unnest(COALESCE(p_users, '{}')) WITH ORDINALITY AS u(id, ord)
        LEFT JOIN tenancy.profiles AS p ON p.id = u.id
    ), '[]'::jsonb) || COALESCE((
        SELECT jsonb_agg(jsonb_build_object('kind', 'role', 'id', c.code, 'name', COALESCE((
            SELECT ro.role_name FROM tenancy.roles AS ro
            WHERE ro.role_code = c.code AND (ro.client_id = p_client_id OR ro.client_id IS NULL)
            ORDER BY ro.client_id NULLS LAST LIMIT 1
        ), c.code)) ORDER BY c.ord)
        FROM unnest(COALESCE(p_roles, '{}')) WITH ORDINALITY AS c(code, ord)
    ), '[]'::jsonb);
$$;

-- Why the signed-in person cannot decide this review, or NULL when they can.
-- workflow_review_decide refuses with this message, and every read shows it.
CREATE OR REPLACE FUNCTION ops.workflow_review_blocker(p_review ops.workflow_reviews, p_started_by UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_names TEXT;
BEGIN
    IF ops.is_service_role() THEN
        RETURN NULL;
    END IF;
    IF NOT ops.workflow_can(p_review.client_id, 'workflow.review') THEN
        RETURN 'You do not hold the review permission for this client.';
    END IF;
    IF p_review.separate_reviewer AND p_started_by IS NOT NULL AND auth.uid() = p_started_by THEN
        RETURN 'You started this run, so someone else has to review it.';
    END IF;
    IF NOT ops.workflow_review_assigned(p_review.client_id, auth.uid(), p_review.assigned_users, p_review.assigned_roles) THEN
        SELECT string_agg(a ->> 'name', ', ') INTO v_names
        FROM jsonb_array_elements(ops.workflow_review_assignees(p_review.client_id, p_review.assigned_users, p_review.assigned_roles)) AS a;
        RETURN 'This review is assigned to ' || COALESCE(v_names, 'someone else') || '.';
    END IF;
    RETURN NULL;
END;
$$;

-- A review as every read returns it: the row, who it is for, and whether the
-- signed-in person can decide it and why not.
CREATE OR REPLACE FUNCTION ops.workflow_review_view(p_review ops.workflow_reviews, p_started_by UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_blocker TEXT := ops.workflow_review_blocker(p_review, p_started_by);
    v_assigned BOOLEAN := COALESCE(cardinality(p_review.assigned_users), 0) > 0 OR COALESCE(cardinality(p_review.assigned_roles), 0) > 0;
BEGIN
    RETURN to_jsonb(p_review) || jsonb_build_object(
        'started_by', p_started_by,
        'can_review', v_blocker IS NULL,
        'blocker', v_blocker,
        'assignees', ops.workflow_review_assignees(p_review.client_id, p_review.assigned_users, p_review.assigned_roles),
        'assigned_to_me', v_assigned AND auth.uid() IS NOT NULL
            AND ops.workflow_review_assigned(p_review.client_id, auth.uid(), p_review.assigned_users, p_review.assigned_roles),
        'decided_by_name', (SELECT p.display_name FROM tenancy.profiles AS p WHERE p.id = p_review.decided_by),
        'started_by_name', (SELECT p.display_name FROM tenancy.profiles AS p WHERE p.id = p_started_by)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.workflow_reviews_list(TEXT, INTEGER);

-- Reviews, the ones due soonest first. p_mine keeps those the signed-in person
-- can decide now.
CREATE OR REPLACE FUNCTION public.workflow_reviews_list(p_status TEXT DEFAULT 'OPEN', p_limit INTEGER DEFAULT 100, p_mine BOOLEAN DEFAULT FALSE)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT v.view
    FROM (
        SELECT (ops.workflow_review_view(q, r.started_by) - 'proposal' - 'decision') || jsonb_build_object(
                   'workflow_name', w.workflow_name,
                   'item_count', jsonb_array_length(COALESCE(q.proposal -> 'items', '[]'::jsonb))
               ) AS view,
               q.due_at, q.created_at
        FROM ops.workflow_reviews AS q
        JOIN ops.workflow_runs AS r ON r.id = q.run_id
        JOIN ops.workflows AS w ON w.id = r.workflow_id
        WHERE ops.workflow_can_see(q.client_id)
          AND (p_status IS NULL OR q.status = p_status)
    ) AS v
    WHERE NOT COALESCE(p_mine, FALSE) OR (v.view ->> 'can_review')::boolean
    ORDER BY v.due_at NULLS LAST, v.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

CREATE OR REPLACE FUNCTION public.workflow_review_get(p_review_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.workflow_review_view(q, r.started_by) || jsonb_build_object('workflow_name', w.workflow_name)
    FROM ops.workflow_reviews AS q
    JOIN ops.workflow_runs AS r ON r.id = q.run_id
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    WHERE q.id = p_review_id AND ops.workflow_can_see(q.client_id);
$$;

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
        'can_manage', ops.workflow_can(r.client_id, 'workflow.manage'),
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
            SELECT jsonb_agg(ops.workflow_review_view(q, r.started_by) ORDER BY q.created_at)
            FROM ops.workflow_reviews AS q WHERE q.run_id = r.id
        ), '[]'::jsonb)
    )
    FROM ops.workflow_runs AS r
    JOIN ops.workflows AS w ON w.id = r.workflow_id
    JOIN ops.workflow_versions AS v ON v.id = r.version_id
    WHERE r.id = p_run_id AND ops.workflow_can_see(r.client_id);
$$;

-- Who a review step can be assigned to in a client: the people who hold
-- workflow.review there, and the roles that grant it. A shared workflow (no
-- client) can only be assigned to roles.
CREATE OR REPLACE FUNCTION public.workflow_reviewer_choices(p_client_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE WHEN p_client_id IS NOT NULL AND NOT ops.workflow_can_see(p_client_id) THEN NULL ELSE jsonb_build_object(
        'people', CASE WHEN p_client_id IS NULL THEN '[]'::jsonb ELSE COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', cu.user_id, 'name', COALESCE(pr.display_name, 'Unnamed person')) ORDER BY pr.display_name)
            FROM tenancy.client_users AS cu
            JOIN tenancy.profiles AS pr ON pr.id = cu.user_id
            WHERE cu.client_id = p_client_id AND cu.is_active AND pr.is_active
              AND ops.workflow_user_can_review(p_client_id, cu.user_id)
              AND NOT EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = cu.user_id)
        ), '[]'::jsonb) END,
        'roles', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('code', x.role_code, 'name', x.role_name) ORDER BY x.role_name)
            FROM (
                SELECT DISTINCT ON (ro.role_code) ro.role_code, ro.role_name
                FROM tenancy.roles AS ro
                JOIN tenancy.role_permissions AS rp ON rp.role_id = ro.id
                JOIN tenancy.permissions AS p ON p.id = rp.permission_id
                WHERE p.permission_code = 'workflow.review'
                  AND (ro.client_id IS NULL OR ro.client_id = p_client_id)
                  AND ro.role_code <> 'WORKFLOW_SERVICE'
                ORDER BY ro.role_code, ro.client_id NULLS LAST
            ) AS x
        ), '[]'::jsonb)
    ) END;
$$;

-- ---------------------------------------------------------------------------
-- Decisions
-- ---------------------------------------------------------------------------

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
    v_blocker TEXT;
BEGIN
    IF p_outcome NOT IN ('APPROVED', 'REJECTED') THEN
        RAISE EXCEPTION 'A review is approved or rejected' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_review FROM ops.workflow_reviews WHERE id = p_review_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_review.client_id) THEN
        RAISE EXCEPTION 'Review was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_review.status <> 'OPEN' THEN
        RAISE EXCEPTION 'This review has already been decided' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = v_review.run_id;
    v_blocker := ops.workflow_review_blocker(v_review, v_run.started_by);
    IF v_blocker IS NOT NULL THEN
        RAISE EXCEPTION '%', v_blocker USING ERRCODE = '42501';
    END IF;
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
    RETURN ops.workflow_review_view(v_review, v_run.started_by);
END;
$$;

-- Hands an open review to other people or roles. Allowed to whoever manages
-- the client's workflows, and to anyone who could decide the review now, so a
-- reviewer can pass it on. Every person must hold workflow.review in the
-- client, and every role must grant it. Empty lists make it open to anyone who
-- holds workflow.review.
CREATE OR REPLACE FUNCTION public.workflow_review_reassign(
    p_review_id UUID,
    p_users UUID[] DEFAULT '{}',
    p_roles TEXT[] DEFAULT '{}',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_review ops.workflow_reviews;
    v_run ops.workflow_runs;
    v_user UUID;
    v_role TEXT;
    v_users UUID[] := ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(p_users, '{}')) AS u WHERE u IS NOT NULL);
    v_roles TEXT[] := ARRAY(SELECT DISTINCT btrim(c) FROM unnest(COALESCE(p_roles, '{}')) AS c WHERE btrim(COALESCE(c, '')) <> '');
    v_names TEXT;
BEGIN
    SELECT * INTO v_review FROM ops.workflow_reviews WHERE id = p_review_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_review.client_id) THEN
        RAISE EXCEPTION 'Review was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_review.status <> 'OPEN' THEN
        RAISE EXCEPTION 'This review has already been decided' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = v_review.run_id;
    IF NOT ops.workflow_can(v_review.client_id, 'workflow.manage') AND ops.workflow_review_blocker(v_review, v_run.started_by) IS NOT NULL THEN
        RAISE EXCEPTION 'Only someone who manages workflows, or who could decide this review, can reassign it' USING ERRCODE = '42501';
    END IF;

    FOREACH v_user IN ARRAY v_users LOOP
        IF v_review.separate_reviewer AND v_user = v_run.started_by THEN
            RAISE EXCEPTION 'The person who started the run cannot review it' USING ERRCODE = '22023';
        END IF;
        IF NOT ops.workflow_user_can_review(v_review.client_id, v_user) THEN
            RAISE EXCEPTION '% does not hold the review permission for this client',
                COALESCE((SELECT display_name FROM tenancy.profiles WHERE id = v_user), 'That person') USING ERRCODE = '22023';
        END IF;
    END LOOP;
    FOREACH v_role IN ARRAY v_roles LOOP
        IF NOT EXISTS (
            SELECT 1 FROM tenancy.roles AS ro
            JOIN tenancy.role_permissions AS rp ON rp.role_id = ro.id
            JOIN tenancy.permissions AS p ON p.id = rp.permission_id
            WHERE ro.role_code = v_role AND (ro.client_id IS NULL OR ro.client_id = v_review.client_id)
              AND p.permission_code = 'workflow.review'
        ) THEN
            RAISE EXCEPTION 'Role % does not grant the review permission', v_role USING ERRCODE = '22023';
        END IF;
    END LOOP;

    UPDATE ops.workflow_reviews
       SET assigned_users = v_users, assigned_roles = v_roles, assigned_by = auth.uid(), assigned_at = NOW()
     WHERE id = p_review_id
    RETURNING * INTO v_review;

    SELECT string_agg(a ->> 'name', ', ') INTO v_names
    FROM jsonb_array_elements(ops.workflow_review_assignees(v_review.client_id, v_users, v_roles)) AS a;
    PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.assigned', 'USER', auth.uid(),
        CASE WHEN v_names IS NULL THEN 'Review opened to anyone who can review' ELSE 'Review assigned to ' || v_names END,
        jsonb_build_object('reviewId', v_review.id, 'users', to_jsonb(v_users), 'roles', to_jsonb(v_roles), 'note', NULLIF(btrim(COALESCE(p_note, '')), '')));
    RETURN ops.workflow_review_view(v_review, v_run.started_by);
END;
$$;

-- ---------------------------------------------------------------------------
-- Worker
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB);

-- Opens a review. p_routing is the step's { people, roles, separateReviewer,
-- dueInHours }. A person who cannot review in this client, or who started the
-- run when the step keeps them apart, is left off and named in "unassignable"
-- for the run's history. If nobody named is left, the review is open to anyone
-- who can review. Opening the same review again returns the one already open.
CREATE OR REPLACE FUNCTION public.workflow_worker_review(
    p_run_id UUID,
    p_node_id TEXT,
    p_title TEXT,
    p_instructions TEXT,
    p_summary TEXT,
    p_proposal JSONB,
    p_routing JSONB DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
    v_review ops.workflow_reviews;
    v_routing JSONB := CASE WHEN jsonb_typeof(p_routing) = 'object' THEN p_routing ELSE '{}'::jsonb END;
    v_separate BOOLEAN := COALESCE((v_routing ->> 'separateReviewer')::boolean, TRUE);
    v_hours NUMERIC;
    v_users UUID[] := '{}';
    v_roles TEXT[] := '{}';
    v_unassignable JSONB := '[]'::jsonb;
    v_entry TEXT;
    v_user UUID;
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    IF FOUND THEN
        RETURN to_jsonb(v_review) || jsonb_build_object('unassignable', '[]'::jsonb);
    END IF;

    IF jsonb_typeof(v_routing -> 'people') = 'array' THEN
        FOR v_entry IN SELECT DISTINCT btrim(x) FROM jsonb_array_elements_text(v_routing -> 'people') AS x LOOP
            IF v_entry !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                IF v_entry <> '' THEN
                    v_unassignable := v_unassignable || jsonb_build_object('person', v_entry, 'reason', 'is not a person');
                END IF;
                CONTINUE;
            END IF;
            v_user := v_entry::uuid;
            IF v_separate AND v_user = v_run.started_by THEN
                v_unassignable := v_unassignable || jsonb_build_object('person', v_user, 'reason', 'started the run');
            ELSIF NOT ops.workflow_user_can_review(v_run.client_id, v_user) THEN
                v_unassignable := v_unassignable || jsonb_build_object('person', v_user, 'reason', 'cannot review for this client');
            ELSE
                v_users := v_users || v_user;
            END IF;
        END LOOP;
    END IF;

    IF jsonb_typeof(v_routing -> 'roles') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT btrim(x)), '{}') INTO v_roles
        FROM jsonb_array_elements_text(v_routing -> 'roles') AS x
        WHERE btrim(x) <> '';
    END IF;

    BEGIN
        v_hours := NULLIF(v_routing ->> 'dueInHours', '')::numeric;
    EXCEPTION WHEN others THEN
        v_hours := NULL;
    END;

    INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title, instructions, summary, proposal, assigned_users, assigned_roles, separate_reviewer, due_at, assigned_at)
    VALUES (
        v_run.id, v_run.client_id, p_node_id, COALESCE(NULLIF(btrim(p_title), ''), 'Review'), p_instructions, p_summary,
        COALESCE(p_proposal, '{"items": []}'::jsonb), v_users, v_roles, v_separate,
        CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END,
        CASE WHEN cardinality(v_users) > 0 OR cardinality(v_roles) > 0 THEN NOW() END
    )
    ON CONFLICT (run_id, node_id) DO NOTHING;

    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    RETURN to_jsonb(v_review)
        || jsonb_build_object('assignees', ops.workflow_review_assignees(v_review.client_id, v_review.assigned_users, v_review.assigned_roles))
        || jsonb_build_object('unassignable', v_unassignable);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.workflow_user_can_review(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_assigned(UUID, UUID, UUID[], TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_assignees(UUID, UUID[], TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_blocker(ops.workflow_reviews, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_view(ops.workflow_reviews, UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.workflow_reviews_list(TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_review_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_reviewer_choices(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_review_reassign(UUID, UUID[], TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.workflow_reviews_list(TEXT, INTEGER, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_review_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_reviewer_choices(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_review_reassign(UUID, UUID[], TEXT[], TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
