-- Sending review notices by email and to Slack, as well as the assistant note.
--
-- A client turns each channel on for itself:
--   email  sent to each person's sign-in address, through the provider the
--          worker is set up with (RESEND_API_KEY, NOTIFY_EMAIL_FROM). Off
--          until a client turns it on.
--   Slack  posted to one incoming webhook for the client. Only a
--          https://hooks.slack.com/ address is accepted. The address is a
--          secret: it is stored for the worker and never returned to a page.
--
-- Each review notice (ops.workflow_review_notice) now also queues the job
-- notify.deliver for its event when the client has a channel on. Each send is
-- recorded once per event, channel, and recipient, so a retried job never
-- sends twice.

CREATE TABLE IF NOT EXISTS ops.notification_settings (
    client_id UUID PRIMARY KEY REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    slack_webhook_url TEXT CHECK (slack_webhook_url IS NULL OR slack_webhook_url ~ '^https://hooks\.slack\.com/[A-Za-z0-9/_-]+$'),
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops.notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES ops.activity_events(id) ON DELETE CASCADE,
    channel VARCHAR(10) NOT NULL CHECK (channel IN ('EMAIL', 'SLACK')),
    recipient TEXT NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('SENT', 'FAILED')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, channel, recipient)
);

ALTER TABLE ops.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.notification_deliveries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.notification_settings IS 'Which channels a client sends review notices to. The Slack address is never returned to a page.';
COMMENT ON TABLE ops.notification_deliveries IS 'One row per notice sent, per channel and recipient. A FAILED row is tried again by the next job; a SENT row never is.';

-- ---------------------------------------------------------------------------
-- What people use
-- ---------------------------------------------------------------------------

-- The single client this session acts in, or an error.
CREATE OR REPLACE FUNCTION ops.notification_client()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
    IF v_clients IS NULL OR cardinality(v_clients) <> 1 THEN
        RAISE EXCEPTION 'Choose one client to change where notices go' USING ERRCODE = '22023';
    END IF;
    RETURN v_clients[1];
END;
$$;

CREATE OR REPLACE FUNCTION public.notification_settings_get()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID := ops.notification_client();
    v_row ops.notification_settings;
BEGIN
    SELECT * INTO v_row FROM ops.notification_settings WHERE client_id = v_client;
    RETURN jsonb_build_object(
        'client_id', v_client,
        'email_enabled', COALESCE(v_row.email_enabled, FALSE),
        'slack_configured', v_row.slack_webhook_url IS NOT NULL,
        'can_manage', ops.workflow_can(v_client, 'workflow.manage'),
        'updated_at', v_row.updated_at,
        'sent_last_7_days', (
            SELECT count(*) FROM ops.notification_deliveries AS d
            JOIN ops.activity_events AS e ON e.id = d.event_id
            WHERE e.client_id = v_client AND d.status = 'SENT' AND d.created_at > NOW() - INTERVAL '7 days'
        ),
        'failed_last_7_days', (
            SELECT count(*) FROM ops.notification_deliveries AS d
            JOIN ops.activity_events AS e ON e.id = d.event_id
            WHERE e.client_id = v_client AND d.status = 'FAILED' AND d.created_at > NOW() - INTERVAL '7 days'
        )
    );
END;
$$;

-- Saves the caller's client's channels. p_slack_webhook_url NULL leaves the
-- saved address as it is; an empty string removes it.
CREATE OR REPLACE FUNCTION public.notification_settings_save(p_email_enabled BOOLEAN, p_slack_webhook_url TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID := ops.notification_client();
    v_url TEXT := btrim(COALESCE(p_slack_webhook_url, ''));
BEGIN
    IF NOT ops.workflow_can(v_client, 'workflow.manage') THEN
        RAISE EXCEPTION 'Changing where notices go needs permission to manage workflows' USING ERRCODE = '42501';
    END IF;
    IF p_slack_webhook_url IS NOT NULL AND v_url <> '' AND v_url !~ '^https://hooks\.slack\.com/[A-Za-z0-9/_-]+$' THEN
        RAISE EXCEPTION 'A Slack address starts https://hooks.slack.com/' USING ERRCODE = '22023';
    END IF;
    INSERT INTO ops.notification_settings (client_id, email_enabled, slack_webhook_url, updated_by, updated_at)
    VALUES (v_client, COALESCE(p_email_enabled, FALSE), NULLIF(v_url, ''), auth.uid(), NOW())
    ON CONFLICT (client_id) DO UPDATE
       SET email_enabled = EXCLUDED.email_enabled,
           slack_webhook_url = CASE WHEN p_slack_webhook_url IS NULL THEN ops.notification_settings.slack_webhook_url ELSE EXCLUDED.slack_webhook_url END,
           updated_by = auth.uid(),
           updated_at = NOW();
    RETURN public.notification_settings_get();
END;
$$;

-- ---------------------------------------------------------------------------
-- What the worker runs
-- ---------------------------------------------------------------------------

-- Everything the worker needs to send one event: its text and link, the
-- client's channels, and each recipient not yet sent to on each channel.
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
    -- A notice about a review decided since is not sent.
    IF v_event.subject_type = 'REVIEW' AND NOT EXISTS (
        SELECT 1 FROM ops.workflow_reviews AS q WHERE q.id = v_event.subject_id AND q.status = 'OPEN'
    ) THEN
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

-- Records what was sent: [{ channel, recipient, status, error }].
CREATE OR REPLACE FUNCTION public.job_run_notify_record(p_event_id UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    WITH saved AS (
        INSERT INTO ops.notification_deliveries (event_id, channel, recipient, status, error)
        SELECT p_event_id, r ->> 'channel', r ->> 'recipient', r ->> 'status', NULLIF(left(r ->> 'error', 500), '')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END) AS r
        WHERE r ->> 'channel' IN ('EMAIL', 'SLACK') AND r ->> 'status' IN ('SENT', 'FAILED') AND COALESCE(r ->> 'recipient', '') <> ''
        ON CONFLICT (event_id, channel, recipient) DO UPDATE
           SET status = EXCLUDED.status, error = EXCLUDED.error, created_at = NOW()
         WHERE ops.notification_deliveries.status <> 'SENT'
        RETURNING 1
    )
    SELECT count(*)::int FROM saved;
$$;

-- Queues notify.deliver for an event when its client sends anywhere.
CREATE OR REPLACE FUNCTION ops.notification_queue(p_event_id UUID, p_client_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM ops.notification_settings
        WHERE client_id = p_client_id AND (email_enabled OR slack_webhook_url IS NOT NULL)
    ) THEN
        INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key)
        VALUES (p_client_id, 'notify.deliver', jsonb_build_object('eventId', p_event_id), 3, 'notify:' || p_event_id::text)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING;
    END IF;
END;
$$;

-- As in 20261117020000, plus queuing delivery by email and Slack.
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
    v_event UUID;
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
    )
    RETURNING id INTO v_event;

    FOREACH v_user IN ARRAY v_recipients LOOP
        PERFORM ops.assistant_queue(v_review.client_id, v_user, 'assistant.watch');
    END LOOP;
    PERFORM ops.notification_queue(v_event, v_review.client_id);

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

REVOKE ALL ON FUNCTION ops.notification_client() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.notification_queue(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_review_notice(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_settings_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notification_settings_save(BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_notify_collect(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_notify_record(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_settings_get() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notification_settings_save(BOOLEAN, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_notify_collect(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_notify_record(UUID, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
