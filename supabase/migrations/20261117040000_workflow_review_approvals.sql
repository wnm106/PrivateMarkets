-- More than one approval on a review, and reassigning a review that is overdue.
--
-- A review step can now say:
--   approvals             how many different people must approve (1 to 5).
--                         Each approves the same set of changes. A later
--                         approver who changes what is approved starts the
--                         count again from them. Anyone who may decide can
--                         reject, and that ends the review.
--   reassignWhenOverdue   when the review passes its due date and the step
--                         names roles to escalate to, the review is handed to
--                         those roles, as well as them being told.
--
-- Builds on 20261117010000 (who may decide) and 20261117020000 (notices).

ALTER TABLE ops.workflow_reviews
    ADD COLUMN IF NOT EXISTS approvals_required INTEGER NOT NULL DEFAULT 1 CHECK (approvals_required BETWEEN 1 AND 5),
    ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS reassign_when_overdue BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ops.workflow_reviews.approvals IS '[{ by, at }] for each approval so far of the decision stored in decision. Cleared when an approver changes the decision.';

-- People who approved so far.
CREATE OR REPLACE FUNCTION ops.workflow_review_approvers(p_review ops.workflow_reviews)
RETURNS UUID[]
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(array_agg((a ->> 'by')::uuid), '{}')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_review.approvals) = 'array' THEN p_review.approvals ELSE '[]'::jsonb END) AS a
    WHERE (a ->> 'by') IS NOT NULL;
$$;

-- As in 20261117010000, plus: someone who already approved cannot approve again.
CREATE OR REPLACE FUNCTION ops.workflow_review_blocker(p_review ops.workflow_reviews, p_started_by UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_names TEXT;
    v_left INTEGER;
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
    IF auth.uid() = ANY (ops.workflow_review_approvers(p_review)) THEN
        v_left := p_review.approvals_required - cardinality(ops.workflow_review_approvers(p_review));
        RETURN format('You approved this. It needs %s more %s from someone else.', v_left, CASE WHEN v_left = 1 THEN 'approval' ELSE 'approvals' END);
    END IF;
    RETURN NULL;
END;
$$;

-- As in 20261117010000, plus the approvals so far.
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
        'started_by_name', (SELECT p.display_name FROM tenancy.profiles AS p WHERE p.id = p_started_by),
        'approval_names', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', a ->> 'by', 'name', COALESCE(p.display_name, 'Someone'), 'at', a ->> 'at') ORDER BY a ->> 'at')
            FROM jsonb_array_elements(p_review.approvals) AS a
            LEFT JOIN tenancy.profiles AS p ON p.id = (a ->> 'by')::uuid
        ), '[]'::jsonb)
    );
END;
$$;

-- As in 20261117020000, without the people who already approved.
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
      AND x.user_id IS DISTINCT FROM p_except
      AND NOT (x.user_id = ANY (ops.workflow_review_approvers(p_review)));
$$;

-- A decision. A rejection ends the review. An approval is counted; the review
-- is approved once enough different people have approved the same decision.
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
    v_decision JSONB := COALESCE(p_decision, '{}'::jsonb);
    v_approvals JSONB;
    v_restarted BOOLEAN := FALSE;
    v_count INTEGER;
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

    IF p_outcome = 'REJECTED' THEN
        UPDATE ops.workflow_reviews
           SET status = 'REJECTED', decision = v_decision, decided_by = auth.uid(), decided_at = NOW()
         WHERE id = p_review_id
        RETURNING * INTO v_review;
        PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.decided', 'USER', auth.uid(), 'Review rejected',
            jsonb_build_object('reviewId', v_review.id, 'outcome', 'REJECTED', 'decision', v_decision));
        PERFORM ops.workflow_queue_advance(v_review.run_id, v_review.client_id, auth.uid());
        RETURN ops.workflow_review_view(v_review, v_run.started_by);
    END IF;

    -- An approval of a different decision from the one already approved starts the count again.
    v_approvals := CASE WHEN jsonb_typeof(v_review.approvals) = 'array' THEN v_review.approvals ELSE '[]'::jsonb END;
    IF jsonb_array_length(v_approvals) > 0 AND v_review.decision IS DISTINCT FROM v_decision THEN
        v_approvals := '[]'::jsonb;
        v_restarted := TRUE;
    END IF;
    v_approvals := v_approvals || jsonb_build_array(jsonb_build_object('by', auth.uid(), 'at', NOW()));
    v_count := jsonb_array_length(v_approvals);

    IF v_count >= v_review.approvals_required THEN
        UPDATE ops.workflow_reviews
           SET status = 'APPROVED', decision = v_decision, approvals = v_approvals, decided_by = auth.uid(), decided_at = NOW()
         WHERE id = p_review_id
        RETURNING * INTO v_review;
        PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.decided', 'USER', auth.uid(),
            CASE WHEN v_review.approvals_required > 1 THEN format('Review approved (%s of %s approvals)', v_count, v_review.approvals_required) ELSE 'Review approved' END,
            jsonb_build_object('reviewId', v_review.id, 'outcome', 'APPROVED', 'decision', v_decision, 'approvals', v_approvals));
        PERFORM ops.workflow_queue_advance(v_review.run_id, v_review.client_id, auth.uid());
    ELSE
        UPDATE ops.workflow_reviews
           SET decision = v_decision, approvals = v_approvals
         WHERE id = p_review_id
        RETURNING * INTO v_review;
        PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.approved', 'USER', auth.uid(),
            format('Approved (%s of %s)%s', v_count, v_review.approvals_required,
                   CASE WHEN v_restarted THEN '. The changes approved differ from the earlier approval, so the count started again' ELSE '' END),
            jsonb_build_object('reviewId', v_review.id, 'decision', v_decision, 'restarted', v_restarted));
        -- Tell the people who can still approve.
        PERFORM ops.workflow_review_notice(v_review.id, 'REVIEW_ASSIGNED', auth.uid());
    END IF;
    RETURN ops.workflow_review_view(v_review, v_run.started_by);
END;
$$;

-- As in 20261117020000, plus approvals and reassignWhenOverdue.
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
    v_reassign BOOLEAN := COALESCE((v_routing ->> 'reassignWhenOverdue')::boolean, FALSE);
    v_needed INTEGER;
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
    BEGIN
        v_needed := LEAST(GREATEST(COALESCE(NULLIF(v_routing ->> 'approvals', '')::numeric::int, 1), 1), 5);
    EXCEPTION WHEN others THEN
        v_needed := 1;
    END;

    INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title, instructions, summary, proposal, assigned_users, assigned_roles,
                                      separate_reviewer, due_at, assigned_at, escalate_roles, approvals_required, reassign_when_overdue)
    VALUES (
        v_run.id, v_run.client_id, p_node_id, COALESCE(NULLIF(btrim(p_title), ''), 'Review'), p_instructions, p_summary,
        COALESCE(p_proposal, '{"items": []}'::jsonb), v_users, v_roles, v_separate,
        CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END,
        CASE WHEN cardinality(v_users) > 0 OR cardinality(v_roles) > 0 THEN NOW() END,
        v_escalate, v_needed, v_reassign
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

-- As in 20261117020000, plus handing an overdue review to its escalation roles
-- when the step says to.
CREATE OR REPLACE FUNCTION public.job_run_workflow_reviews_due(p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
    v_review ops.workflow_reviews;
    v_overdue INTEGER := 0;
    v_told INTEGER := 0;
    v_reassigned INTEGER := 0;
    v_requeued INTEGER := 0;
    v_pending RECORD;
BEGIN
    FOR v_review IN
        SELECT q.*
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
        IF v_review.reassign_when_overdue AND cardinality(v_review.escalate_roles) > 0 THEN
            UPDATE ops.workflow_reviews
               SET assigned_users = '{}', assigned_roles = escalate_roles, assigned_by = NULL, assigned_at = v_now
             WHERE id = v_review.id;
            PERFORM ops.workflow_log(v_review.run_id, v_review.node_id, 'review.assigned', 'SYSTEM', NULL,
                'Overdue, so handed to ' || array_to_string(v_review.escalate_roles, ', '),
                jsonb_build_object('reviewId', v_review.id, 'roles', to_jsonb(v_review.escalate_roles), 'reason', 'overdue'));
            v_reassigned := v_reassigned + 1;
        END IF;
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

    RETURN jsonb_build_object('overdue', v_overdue, 'told', v_told, 'reassigned', v_reassigned, 'requeued', v_requeued);
END;
$$;

REVOKE ALL ON FUNCTION ops.workflow_review_approvers(ops.workflow_reviews) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_blocker(ops.workflow_reviews, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_view(ops.workflow_reviews, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_recipients(ops.workflow_reviews, UUID, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_review_decide(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
