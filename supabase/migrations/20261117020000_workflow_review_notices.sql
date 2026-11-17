-- Telling people a workflow review is waiting for them, and when it is overdue.
--
-- An activity event can now name its recipients. A named person gets it as an
-- immediate note in their assistant briefing, whether or not they follow
-- anything and whether or not they turned the assistant on: a review assigned
-- to someone is their work, not something they opted into.
--
-- Two kinds are written:
--   REVIEW_ASSIGNED  when a review opens, and when it is reassigned. Sent to
--                    everyone who can decide it now.
--   REVIEW_OVERDUE   once, when a review passes its due date. Sent to the same
--                    people and to anyone holding a role the step names to
--                    escalate to.
--
-- The platform job workflow.reviews_due runs every 15 minutes. It writes the
-- overdue notices, and queues again any note that was not delivered.

ALTER TABLE ops.activity_events
    ADD COLUMN IF NOT EXISTS recipients UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS activity_events_recipients
    ON ops.activity_events USING GIN (recipients)
    WHERE cardinality(recipients) > 0;

COMMENT ON COLUMN ops.activity_events.recipients IS
    'People this event is addressed to. Each gets it as an immediate note, without a follow.';

ALTER TABLE ops.workflow_reviews
    ADD COLUMN IF NOT EXISTS escalate_roles TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN ops.workflow_reviews.escalate_roles IS 'Role codes told when the review is overdue, besides the people who can decide it.';
COMMENT ON COLUMN ops.workflow_reviews.overdue_notified_at IS 'When the overdue notice was sent. A review is told it is overdue once.';

-- ---------------------------------------------------------------------------
-- Who is told
-- ---------------------------------------------------------------------------

-- The people who can decide a review now, and, when p_escalate, the people
-- holding one of its escalation roles. The person who started the run is left
-- out when the review keeps them apart, and so is p_except (who caused it).
CREATE OR REPLACE FUNCTION ops.workflow_review_recipients(
    p_review ops.workflow_reviews,
    p_started_by UUID,
    p_escalate BOOLEAN DEFAULT FALSE,
    p_except UUID DEFAULT NULL
) RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT x.user_id), '{}')
    FROM (
        SELECT cu.user_id
        FROM tenancy.client_users AS cu
        JOIN tenancy.profiles AS pr ON pr.id = cu.user_id AND pr.is_active
        WHERE cu.client_id = p_review.client_id AND cu.is_active
          AND ops.workflow_user_can_review(p_review.client_id, cu.user_id)
          AND ops.workflow_review_assigned(p_review.client_id, cu.user_id, p_review.assigned_users, p_review.assigned_roles)
        UNION
        SELECT ur.user_id
        FROM tenancy.user_roles AS ur
        JOIN tenancy.roles AS ro ON ro.id = ur.role_id
        JOIN tenancy.client_users AS cu ON cu.client_id = ur.client_id AND cu.user_id = ur.user_id AND cu.is_active
        JOIN tenancy.profiles AS pr ON pr.id = ur.user_id AND pr.is_active
        WHERE COALESCE(p_escalate, FALSE)
          AND ur.client_id = p_review.client_id
          AND ro.role_code = ANY (p_review.escalate_roles)
    ) AS x
    WHERE NOT EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = x.user_id)
      AND NOT (p_review.separate_reviewer AND x.user_id IS NOT DISTINCT FROM p_started_by)
      AND x.user_id IS DISTINCT FROM p_except;
$$;

-- Writes one notice about a review and queues a note for each person it names.
-- Returns how many people it was sent to.
CREATE OR REPLACE FUNCTION ops.workflow_review_notice(p_review_id UUID, p_kind TEXT, p_actor UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_review ops.workflow_reviews;
    v_run ops.workflow_runs;
    v_workflow TEXT;
    v_recipients UUID[];
    v_summary TEXT;
    v_due TEXT;
    v_items INTEGER;
    v_user UUID;
BEGIN
    IF p_kind NOT IN ('REVIEW_ASSIGNED', 'REVIEW_OVERDUE') THEN
        RAISE EXCEPTION 'That is not a review notice' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_review FROM ops.workflow_reviews WHERE id = p_review_id;
    IF NOT FOUND OR v_review.status <> 'OPEN' THEN
        RETURN 0;
    END IF;
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = v_review.run_id;
    SELECT workflow_name INTO v_workflow FROM ops.workflows WHERE id = v_run.workflow_id;

    v_recipients := ops.workflow_review_recipients(v_review, v_run.started_by, p_kind = 'REVIEW_OVERDUE', p_actor);
    IF cardinality(v_recipients) = 0 THEN
        RETURN 0;
    END IF;

    v_items := jsonb_array_length(COALESCE(v_review.proposal -> 'items', '[]'::jsonb));
    v_due := to_char(v_review.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
    v_summary := CASE p_kind
        WHEN 'REVIEW_ASSIGNED' THEN
            format('Review waiting for you: "%s" in %s, %s proposed %s', v_review.title, COALESCE(v_workflow, 'a workflow'),
                v_items, CASE WHEN v_items = 1 THEN 'change' ELSE 'changes' END)
            || CASE WHEN v_review.due_at IS NOT NULL THEN ', due ' || v_due ELSE '' END
        ELSE
            format('Overdue review: "%s" in %s was due %s and is still open', v_review.title, COALESCE(v_workflow, 'a workflow'), v_due)
    END;

    INSERT INTO ops.activity_events (client_id, kind, subject_type, subject_id, subject_code, summary, payload, actor_id, recipients)
    VALUES (
        v_review.client_id, p_kind, 'REVIEW', v_review.id, left(v_review.title, 100), left(v_summary, 500),
        jsonb_build_object(
            'reviewId', v_review.id,
            'runId', v_review.run_id,
            'workflowName', v_workflow,
            'dueAt', v_review.due_at,
            'href', '/workflows/runs/' || v_review.run_id
        ),
        p_actor, v_recipients
    );

    FOREACH v_user IN ARRAY v_recipients LOOP
        PERFORM ops.assistant_queue(v_review.client_id, v_user, 'assistant.watch');
    END LOOP;

    PERFORM ops.workflow_log(v_review.run_id, v_review.node_id,
        CASE WHEN p_kind = 'REVIEW_OVERDUE' THEN 'review.overdue' ELSE 'review.notified' END, 'SYSTEM', NULL,
        CASE WHEN p_kind = 'REVIEW_OVERDUE'
            THEN format('Review is overdue. Told %s %s', cardinality(v_recipients), CASE WHEN cardinality(v_recipients) = 1 THEN 'person' ELSE 'people' END)
            ELSE format('Told %s %s the review is waiting', cardinality(v_recipients), CASE WHEN cardinality(v_recipients) = 1 THEN 'person' ELSE 'people' END)
        END,
        jsonb_build_object('reviewId', v_review.id, 'recipients', to_jsonb(v_recipients)));
    RETURN cardinality(v_recipients);
END;
$$;

-- ---------------------------------------------------------------------------
-- The assistant reads addressed events
-- ---------------------------------------------------------------------------

-- As before, plus events addressed to this person, which are always immediate.
CREATE OR REPLACE FUNCTION ops.assistant_pending(
    p_user_id UUID,
    p_client_id UUID,
    p_delivery TEXT
) RETURNS SETOF ops.activity_events
LANGUAGE sql STABLE
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT e.*
    FROM ops.activity_events AS e
    WHERE e.client_id = p_client_id
      AND NOT EXISTS (
          SELECT 1 FROM ops.assistant_receipts AS r
          WHERE r.user_id = p_user_id AND r.event_id = e.id
      )
      AND (
          e.subject_type <> 'ENTITY'
          OR e.subject_id IN (SELECT tenancy.readable_entity_ids())
      )
      AND (
          (
              p_delivery = 'IMMEDIATE' AND p_user_id = ANY (e.recipients)
              -- A notice about a review that has since been decided is no longer news.
              AND (e.subject_type <> 'REVIEW' OR EXISTS (
                  SELECT 1 FROM ops.workflow_reviews AS q WHERE q.id = e.subject_id AND q.status = 'OPEN'
              ))
          )
          OR EXISTS (
              SELECT 1 FROM ops.assistant_follows AS f
              WHERE f.user_id = p_user_id
                AND f.client_id = p_client_id
                AND f.delivery = p_delivery
                AND (
                    (f.subject_type = 'KIND' AND f.subject_code = e.kind)
                    OR (f.subject_type = e.subject_type AND f.subject_id IS NOT NULL AND f.subject_id = e.subject_id)
                )
          )
      );
$$;

-- As before, with each event's link when it has one.
CREATE OR REPLACE FUNCTION public.job_run_assistant_collect(
    p_user_id UUID,
    p_client_id UUID,
    p_delivery TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_delivery TEXT := upper(btrim(COALESCE(p_delivery, '')));
    v_events JSONB;
    v_more BOOLEAN;
BEGIN
    IF v_delivery NOT IN ('DIGEST', 'IMMEDIATE') THEN
        RAISE EXCEPTION 'Delivery must be DIGEST or IMMEDIATE' USING ERRCODE = '22023';
    END IF;
    PERFORM ops.assume_user(p_user_id, p_client_id);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', picked.id,
        'kind', picked.kind,
        'summary', picked.summary,
        'occurredAt', picked.occurred_at,
        'subjectType', picked.subject_type,
        'subjectCode', picked.subject_code,
        'href', picked.payload ->> 'href'
    ) ORDER BY picked.occurred_at, picked.id), '[]'::jsonb)
    INTO v_events
    FROM (
        SELECT e.id, e.kind, e.summary, e.occurred_at, e.subject_type, e.subject_code, e.payload
        FROM ops.assistant_pending(p_user_id, p_client_id, v_delivery) AS e
        ORDER BY e.occurred_at, e.id
        LIMIT 40
    ) AS picked;

    SELECT EXISTS (
        SELECT 1
        FROM ops.assistant_pending(p_user_id, p_client_id, v_delivery)
        OFFSET 40
    ) INTO v_more;

    RETURN jsonb_build_object('events', v_events, 'truncated', COALESCE(v_more, FALSE));
END;
$$;

-- ---------------------------------------------------------------------------
-- Opening and reassigning a review now tell people
-- ---------------------------------------------------------------------------

-- As in 20261117010000, plus escalateRoles, and a notice when the review is new.
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
    v_escalate TEXT[] := '{}';
    v_unassignable JSONB := '[]'::jsonb;
    v_entry TEXT;
    v_user UUID;
    v_new UUID;
    v_told INTEGER := 0;
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

    IF jsonb_typeof(v_routing -> 'escalateRoles') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT btrim(x)), '{}') INTO v_escalate
        FROM jsonb_array_elements_text(v_routing -> 'escalateRoles') AS x
        WHERE btrim(x) <> '';
    END IF;

    BEGIN
        v_hours := NULLIF(v_routing ->> 'dueInHours', '')::numeric;
    EXCEPTION WHEN others THEN
        v_hours := NULL;
    END;

    INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title, instructions, summary, proposal, assigned_users, assigned_roles, separate_reviewer, due_at, assigned_at, escalate_roles)
    VALUES (
        v_run.id, v_run.client_id, p_node_id, COALESCE(NULLIF(btrim(p_title), ''), 'Review'), p_instructions, p_summary,
        COALESCE(p_proposal, '{"items": []}'::jsonb), v_users, v_roles, v_separate,
        CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END,
        CASE WHEN cardinality(v_users) > 0 OR cardinality(v_roles) > 0 THEN NOW() END,
        v_escalate
    )
    ON CONFLICT (run_id, node_id) DO NOTHING
    RETURNING id INTO v_new;

    IF v_new IS NOT NULL THEN
        v_told := ops.workflow_review_notice(v_new, 'REVIEW_ASSIGNED', NULL);
    END IF;

    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    RETURN to_jsonb(v_review)
        || jsonb_build_object('assignees', ops.workflow_review_assignees(v_review.client_id, v_review.assigned_users, v_review.assigned_roles))
        || jsonb_build_object('unassignable', v_unassignable)
        || jsonb_build_object('notified', v_told);
END;
$$;

-- As in 20261117010000, then tells the people it now goes to.
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
    PERFORM ops.workflow_review_notice(v_review.id, 'REVIEW_ASSIGNED', auth.uid());
    RETURN ops.workflow_review_view(v_review, v_run.started_by);
END;
$$;

-- ---------------------------------------------------------------------------
-- The overdue sweep
-- ---------------------------------------------------------------------------

-- Platform job: across every client, tells people about reviews that passed
-- their due date, once each, and queues again any addressed note that was not
-- delivered in the last two weeks.
CREATE OR REPLACE FUNCTION public.job_run_workflow_reviews_due(p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
    v_review RECORD;
    v_overdue INTEGER := 0;
    v_told INTEGER := 0;
    v_requeued INTEGER := 0;
    v_pending RECORD;
BEGIN
    FOR v_review IN
        SELECT q.id
        FROM ops.workflow_reviews AS q
        JOIN ops.workflow_runs AS r ON r.id = q.run_id
        WHERE q.status = 'OPEN'
          AND q.due_at IS NOT NULL AND q.due_at <= v_now
          AND q.overdue_notified_at IS NULL
          AND r.status IN ('WAITING', 'RUNNING', 'QUEUED')
        ORDER BY q.due_at
        LIMIT 500
        FOR UPDATE OF q SKIP LOCKED
    LOOP
        v_overdue := v_overdue + 1;
        v_told := v_told + ops.workflow_review_notice(v_review.id, 'REVIEW_OVERDUE', NULL);
        UPDATE ops.workflow_reviews SET overdue_notified_at = v_now WHERE id = v_review.id;
    END LOOP;

    FOR v_pending IN
        SELECT DISTINCT e.client_id, u.user_id
        FROM ops.activity_events AS e
        CROSS JOIN LATERAL unnest(e.recipients) AS u(user_id)
        WHERE cardinality(e.recipients) > 0
          AND e.occurred_at > v_now - INTERVAL '14 days'
          AND e.occurred_at < v_now - INTERVAL '5 minutes'
          AND NOT EXISTS (
              SELECT 1 FROM ops.assistant_receipts AS rc
              WHERE rc.user_id = u.user_id AND rc.event_id = e.id
          )
          AND (e.subject_type <> 'REVIEW' OR EXISTS (
              SELECT 1 FROM ops.workflow_reviews AS q WHERE q.id = e.subject_id AND q.status = 'OPEN'
          ))
          -- Only someone a note can be written for: still in this client, and in no other.
          AND EXISTS (
              SELECT 1 FROM tenancy.client_users AS cu
              WHERE cu.client_id = e.client_id AND cu.user_id = u.user_id AND cu.is_active
          )
          AND (SELECT count(*) FROM tenancy.client_users AS cu WHERE cu.user_id = u.user_id AND cu.is_active) = 1
    LOOP
        IF ops.assistant_queue(v_pending.client_id, v_pending.user_id, 'assistant.watch') IS NOT NULL THEN
            v_requeued := v_requeued + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('overdue', v_overdue, 'told', v_told, 'requeued', v_requeued);
END;
$$;

-- The platform schedule. It belongs to no client and is not edited by people.
INSERT INTO ops.job_schedules (
    client_id, schedule_code, schedule_name, job_type, payload, cron_expression,
    timezone, is_active, max_attempts, next_run_at, created_by
)
SELECT NULL, 'WORKFLOW_REVIEWS_DUE', 'Overdue workflow reviews', 'workflow.reviews_due', '{}'::jsonb,
       '*/15 * * * *', 'UTC', TRUE, 3, NOW(), NULL
WHERE NOT EXISTS (
    SELECT 1 FROM ops.job_schedules WHERE client_id IS NULL AND schedule_code = 'WORKFLOW_REVIEWS_DUE'
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.workflow_review_recipients(ops.workflow_reviews, UUID, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_notice(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_pending(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_run_assistant_collect(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_review_reassign(UUID, UUID[], TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.job_run_assistant_collect(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_review_reassign(UUID, UUID[], TEXT[], TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
