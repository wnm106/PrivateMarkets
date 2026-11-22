-- One job_run_notify_collect with both later changes.
--
-- Two migrations replaced this function from the same earlier body:
--   * 20261120107000_worker_scope added 'clientId', so the worker sends a
--     notice only for the client its run belongs to.
--   * 20261121150000_workflow_step_notices stopped notices for any review, form
--     or screen finished since (ops.workflow_notice_open), not only reviews.
-- Whichever ran last dropped the other's change: on a fresh database the step
-- notices win, and on the hosted project, where worker_scope is applied after,
-- the client id wins. This is both.
--
-- Grants are unchanged: CREATE OR REPLACE keeps them.

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
        'clientId', v_event.client_id,
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
