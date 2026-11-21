-- Telling people a form or a screen in a workflow run is waiting for them.
--
-- Reviews already tell the people who can decide them, in their briefing and by
-- email and Slack, and again once when they are overdue. A form to answer and a
-- screen to work are decisions of the same kind, and now say so the same way:
--
--   FORM_ASSIGNED    a form opens for people in the firm.
--   FORM_OVERDUE     once, when it passes its due date.
--   STAGE_ASSIGNED   a screen opens.
--   STAGE_RETURNED   a screen is handed back to the person, with the reason.
--   STAGE_OVERDUE    once, when it passes its due date.
--
-- They go to everyone who can act on it now: active people in the client who
-- hold workflow.review and whom it is for (anyone, when it names nobody). A form
-- sent to someone outside the firm is not announced here: the outsider gets the
-- portal link, as before.
--
-- A notice is written by a trigger when a form or a screen opens, so the
-- functions that open them are unchanged. A notice that cannot be written never
-- stops a run: it is logged as a warning.
--
-- A notice about something no longer open is not news. ops.workflow_notice_open
-- says so for a review, a form and a screen, and the briefing, the email and
-- Slack delivery, and the job that re-sends undelivered notes all read it.

ALTER TABLE ops.workflow_forms
    ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
ALTER TABLE ops.workflow_stages
    ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN ops.workflow_forms.overdue_notified_at IS 'When the overdue notice was sent. A form is told it is overdue once.';
COMMENT ON COLUMN ops.workflow_stages.overdue_notified_at IS 'When the overdue notice was sent. A screen is told it is overdue once.';

-- ---------------------------------------------------------------------------
-- Whether a notice is still news
-- ---------------------------------------------------------------------------

-- True unless the notice is about a review, form or screen that is no longer open.
CREATE OR REPLACE FUNCTION ops.workflow_notice_open(p_subject_type TEXT, p_subject_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT CASE p_subject_type
        WHEN 'REVIEW' THEN EXISTS (SELECT 1 FROM ops.workflow_reviews AS q WHERE q.id = p_subject_id AND q.status = 'OPEN')
        WHEN 'FORM' THEN EXISTS (SELECT 1 FROM ops.workflow_forms AS f WHERE f.id = p_subject_id AND f.status = 'OPEN')
        WHEN 'STAGE' THEN EXISTS (SELECT 1 FROM ops.workflow_stages AS s WHERE s.id = p_subject_id AND s.status = 'OPEN')
        ELSE TRUE
    END;
$$;

-- ---------------------------------------------------------------------------
-- Who is told
-- ---------------------------------------------------------------------------

-- The people who can act on a form or a screen now: active in the client,
-- holding workflow.review, and among those it is for. Never a service account,
-- and not p_except (who caused the notice).
CREATE OR REPLACE FUNCTION ops.workflow_step_recipients(
    p_client_id UUID,
    p_users UUID[],
    p_roles TEXT[],
    p_except UUID DEFAULT NULL
) RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT cu.user_id), '{}')
    FROM tenancy.client_users AS cu
    JOIN tenancy.profiles AS pr ON pr.id = cu.user_id AND pr.is_active
    WHERE cu.client_id = p_client_id AND cu.is_active
      AND ops.workflow_user_can_review(p_client_id, cu.user_id)
      AND ops.workflow_review_assigned(p_client_id, cu.user_id, COALESCE(p_users, '{}'), COALESCE(p_roles, '{}'))
      AND NOT EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = cu.user_id)
      AND cu.user_id IS DISTINCT FROM p_except;
$$;

-- ---------------------------------------------------------------------------
-- The notice
-- ---------------------------------------------------------------------------

-- Writes one notice about a form or a screen and queues a note for each person
-- it names, in their briefing and by email and Slack where the client sends
-- them. Returns how many people it was sent to.
CREATE OR REPLACE FUNCTION ops.workflow_step_notice(p_kind TEXT, p_id UUID, p_actor UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_form ops.workflow_forms;
    v_stage ops.workflow_stages;
    v_client UUID;
    v_run_id UUID;
    v_node TEXT;
    v_title TEXT;
    v_due_at TIMESTAMPTZ;
    v_subject TEXT;
    v_workflow TEXT;
    v_recipients UUID[];
    v_summary TEXT;
    v_due TEXT;
    v_questions INTEGER;
    v_user UUID;
    v_event UUID;
BEGIN
    IF p_kind IN ('FORM_ASSIGNED', 'FORM_OVERDUE') THEN
        SELECT * INTO v_form FROM ops.workflow_forms WHERE id = p_id;
        -- A form sent outside the firm is the outsider's to answer, by its link.
        IF NOT FOUND OR v_form.status <> 'OPEN' OR v_form.external_email IS NOT NULL THEN
            RETURN 0;
        END IF;
        v_client := v_form.client_id; v_run_id := v_form.run_id; v_node := v_form.node_id;
        v_title := v_form.title; v_due_at := v_form.due_at; v_subject := 'FORM';
        v_recipients := ops.workflow_step_recipients(v_form.client_id, v_form.assigned_users, v_form.assigned_roles, p_actor);
        v_questions := jsonb_array_length(CASE WHEN jsonb_typeof(v_form.fields) = 'array' THEN v_form.fields ELSE '[]'::jsonb END);
    ELSIF p_kind IN ('STAGE_ASSIGNED', 'STAGE_RETURNED', 'STAGE_OVERDUE') THEN
        SELECT * INTO v_stage FROM ops.workflow_stages WHERE id = p_id;
        IF NOT FOUND OR v_stage.status <> 'OPEN' THEN
            RETURN 0;
        END IF;
        v_client := v_stage.client_id; v_run_id := v_stage.run_id; v_node := v_stage.node_id;
        v_title := v_stage.title; v_due_at := v_stage.due_at; v_subject := 'STAGE';
        v_recipients := ops.workflow_step_recipients(v_stage.client_id, v_stage.assigned_users, v_stage.assigned_roles, p_actor);
    ELSE
        RAISE EXCEPTION 'That is not a form or screen notice' USING ERRCODE = '22023';
    END IF;

    IF cardinality(v_recipients) = 0 THEN
        RETURN 0;
    END IF;
    SELECT w.workflow_name INTO v_workflow FROM ops.workflow_runs AS r JOIN ops.workflows AS w ON w.id = r.workflow_id WHERE r.id = v_run_id;
    v_workflow := COALESCE(v_workflow, 'a workflow');
    v_due := to_char(v_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';

    v_summary := CASE p_kind
        WHEN 'FORM_ASSIGNED' THEN
            format('Form waiting for you: "%s" in %s, %s %s', v_title, v_workflow, v_questions, CASE WHEN v_questions = 1 THEN 'question' ELSE 'questions' END)
            || CASE WHEN v_due_at IS NOT NULL THEN ', due ' || v_due ELSE '' END
        WHEN 'FORM_OVERDUE' THEN
            format('Overdue form: "%s" in %s was due %s and is still open', v_title, v_workflow, v_due)
        WHEN 'STAGE_ASSIGNED' THEN
            format('Waiting for you: "%s" in %s', v_title, v_workflow)
            || CASE WHEN v_due_at IS NOT NULL THEN ', due ' || v_due ELSE '' END
        WHEN 'STAGE_RETURNED' THEN
            format('Came back to you: "%s" in %s.', v_title, v_workflow)
            || CASE WHEN v_stage.returned_reason IS NOT NULL THEN ' ' || v_stage.returned_reason ELSE '' END
        ELSE
            format('Overdue: "%s" in %s was due %s and is still open', v_title, v_workflow, v_due)
    END;

    INSERT INTO ops.activity_events (client_id, kind, subject_type, subject_id, subject_code, summary, payload, actor_id, recipients)
    VALUES (
        v_client, p_kind, v_subject, p_id, left(v_title, 100), left(v_summary, 500),
        jsonb_build_object(
            CASE WHEN v_subject = 'FORM' THEN 'formId' ELSE 'stageId' END, p_id,
            'runId', v_run_id,
            'nodeId', v_node,
            'workflowName', v_workflow,
            'dueAt', v_due_at,
            -- The run opens on this decision.
            'href', '/workflows/runs/' || v_run_id || '?decision=' || v_node
        ),
        p_actor, v_recipients
    )
    RETURNING id INTO v_event;

    FOREACH v_user IN ARRAY v_recipients LOOP
        PERFORM ops.assistant_queue(v_client, v_user, 'assistant.watch');
    END LOOP;
    PERFORM ops.notification_queue(v_event, v_client);

    PERFORM ops.workflow_log(v_run_id, v_node,
        CASE WHEN p_kind LIKE '%_OVERDUE' THEN lower(v_subject) || '.overdue' ELSE lower(v_subject) || '.notified' END, 'SYSTEM', NULL,
        format('%s %s %s', CASE WHEN p_kind LIKE '%_OVERDUE' THEN 'Overdue. Told' ELSE 'Told' END,
            cardinality(v_recipients), CASE WHEN cardinality(v_recipients) = 1 THEN 'person' ELSE 'people' END)
        || CASE WHEN p_kind LIKE '%_OVERDUE' THEN '' ELSE ' it is waiting' END,
        jsonb_build_object(CASE WHEN v_subject = 'FORM' THEN 'formId' ELSE 'stageId' END, p_id, 'kind', p_kind, 'recipients', to_jsonb(v_recipients)));
    RETURN cardinality(v_recipients);
END;
$$;

-- ---------------------------------------------------------------------------
-- Written when a form or a screen opens, or a screen comes back
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.workflow_step_notify()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_kind TEXT;
BEGIN
    IF TG_TABLE_NAME = 'workflow_forms' THEN
        v_kind := 'FORM_ASSIGNED';
    ELSIF TG_OP = 'INSERT' THEN
        v_kind := 'STAGE_ASSIGNED';
    ELSE
        v_kind := 'STAGE_RETURNED';
    END IF;
    BEGIN
        PERFORM ops.workflow_step_notice(v_kind, NEW.id, NULL);
    EXCEPTION WHEN others THEN
        -- Telling people is not worth stopping the run for.
        RAISE WARNING 'Could not write the % notice for %: %', v_kind, NEW.id, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workflow_forms_notify ON ops.workflow_forms;
CREATE TRIGGER workflow_forms_notify
    AFTER INSERT ON ops.workflow_forms
    FOR EACH ROW WHEN (NEW.status = 'OPEN')
    EXECUTE FUNCTION ops.workflow_step_notify();

DROP TRIGGER IF EXISTS workflow_stages_notify ON ops.workflow_stages;
CREATE TRIGGER workflow_stages_notify
    AFTER INSERT ON ops.workflow_stages
    FOR EACH ROW WHEN (NEW.status = 'OPEN')
    EXECUTE FUNCTION ops.workflow_step_notify();

DROP TRIGGER IF EXISTS workflow_stages_returned_notify ON ops.workflow_stages;
CREATE TRIGGER workflow_stages_returned_notify
    AFTER UPDATE OF status ON ops.workflow_stages
    FOR EACH ROW WHEN (OLD.status = 'DONE' AND NEW.status = 'OPEN')
    EXECUTE FUNCTION ops.workflow_step_notify();

-- ---------------------------------------------------------------------------
-- The briefing: as in 20261118220000_universe.sql, with every finished
-- workflow decision left out, not only a decided review
-- ---------------------------------------------------------------------------

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
              -- A notice about a review, form or screen that is no longer open is no longer news.
              AND ops.workflow_notice_open(e.subject_type, e.subject_id)
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
          OR (
              p_delivery = 'DIGEST'
              AND e.subject_type = 'ENTITY'
              AND e.occurred_at > NOW() - INTERVAL '14 days'
              AND ops.has_universe(p_user_id, p_client_id)
              AND ops.in_universe(p_user_id, p_client_id, e.subject_id)
          )
      );
$$;

-- ---------------------------------------------------------------------------
-- Email and Slack: as in 20261117050000_notification_delivery.sql, with every
-- finished workflow decision left out
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_run_notify_collect(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_event ops.activity_events;
    v_settings ops.notification_settings;
BEGIN
    SELECT * INTO v_event FROM ops.activity_events WHERE id = p_event_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_settings FROM ops.notification_settings WHERE client_id = v_event.client_id;
    -- A notice about a review, form or screen finished since is not sent.
    IF NOT ops.workflow_notice_open(v_event.subject_type, v_event.subject_id) THEN
        RETURN jsonb_build_object('stale', TRUE);
    END IF;
    RETURN jsonb_build_object(
        'eventId', v_event.id,
        'kind', v_event.kind,
        'summary', v_event.summary,
        'href', v_event.payload ->> 'href',
        'emailEnabled', COALESCE(v_settings.email_enabled, FALSE),
        'slackWebhookUrl', v_settings.slack_webhook_url,
        'slackSent', EXISTS (
            SELECT 1 FROM ops.notification_deliveries AS d
            WHERE d.event_id = v_event.id AND d.channel = 'SLACK' AND d.status = 'SENT'
        ),
        'recipients', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('userId', u.id, 'email', u.email, 'name', p.display_name) ORDER BY u.email)
            FROM unnest(v_event.recipients) AS r(user_id)
            JOIN auth.users AS u ON u.id = r.user_id
            LEFT JOIN tenancy.profiles AS p ON p.id = u.id
            WHERE u.email IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM ops.notification_deliveries AS d
                  WHERE d.event_id = v_event.id AND d.channel = 'EMAIL' AND d.recipient = u.email AND d.status = 'SENT'
              )
        ), '[]'::jsonb)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- The overdue job: as in 20261117040000_workflow_review_approvals.sql, and it
-- now chases forms and screens too
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_run_workflow_reviews_due(p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
    v_review ops.workflow_reviews;
    v_id UUID;
    v_overdue INTEGER := 0;
    v_told INTEGER := 0;
    v_reassigned INTEGER := 0;
    v_requeued INTEGER := 0;
    v_forms INTEGER := 0;
    v_stages INTEGER := 0;
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

    -- Forms in the firm and screens past their due date, told once each.
    FOR v_id IN
        SELECT f.id
        FROM ops.workflow_forms AS f
        JOIN ops.workflow_runs AS r ON r.id = f.run_id
        WHERE f.status = 'OPEN' AND f.external_email IS NULL
          AND f.due_at IS NOT NULL AND f.due_at <= v_now
          AND f.overdue_notified_at IS NULL
          AND r.status IN ('WAITING', 'RUNNING', 'QUEUED')
        ORDER BY f.due_at
        LIMIT 500
        FOR UPDATE OF f SKIP LOCKED
    LOOP
        v_forms := v_forms + 1;
        v_told := v_told + ops.workflow_step_notice('FORM_OVERDUE', v_id, NULL);
        UPDATE ops.workflow_forms SET overdue_notified_at = v_now WHERE id = v_id;
    END LOOP;
    FOR v_id IN
        SELECT s.id
        FROM ops.workflow_stages AS s
        JOIN ops.workflow_runs AS r ON r.id = s.run_id
        WHERE s.status = 'OPEN'
          AND s.due_at IS NOT NULL AND s.due_at <= v_now
          AND s.overdue_notified_at IS NULL
          AND r.status IN ('WAITING', 'RUNNING', 'QUEUED')
        ORDER BY s.due_at
        LIMIT 500
        FOR UPDATE OF s SKIP LOCKED
    LOOP
        v_stages := v_stages + 1;
        v_told := v_told + ops.workflow_step_notice('STAGE_OVERDUE', v_id, NULL);
        UPDATE ops.workflow_stages SET overdue_notified_at = v_now WHERE id = v_id;
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
          AND ops.workflow_notice_open(e.subject_type, e.subject_id)
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

    RETURN jsonb_build_object('overdue', v_overdue, 'told', v_told, 'reassigned', v_reassigned, 'requeued', v_requeued,
        'overdueForms', v_forms, 'overdueStages', v_stages);
END;
$$;

REVOKE ALL ON FUNCTION ops.workflow_notice_open(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_step_recipients(UUID, UUID[], TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_step_notice(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_step_notify() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_pending(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_run_notify_collect(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_run_notify_collect(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_reviews_due(TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
