-- What the job worker needs to keep each client's work to that client.
--
-- The worker runs as the service role, which row security does not limit, so
-- it checks scope itself. Three checks need the database:
--
--   1. A workflow step acts for a person through the client's workflow service
--      account. The step may only touch records that person could. This answers
--      that question as the person, inside one call.
--   2. A notice is delivered only for the client it belongs to. The collector
--      now says which client that is.
--   3. Two runs of the same notice could both send it. A send is now claimed
--      first, so exactly one run sends each notice to each recipient.

-- ============================================================
-- 1. Record access as the person behind a workflow step
-- ============================================================
-- {"denied": n}: how many of the named records the person may not reach at
-- p_level. A record of another client always counts as denied. Codes are
-- looked up within the client only. The person's session lasts for this call's
-- transaction only.
CREATE OR REPLACE FUNCTION public.workflow_worker_entity_access(
    p_user_id UUID,
    p_client_id UUID,
    p_level TEXT,
    p_entity_ids UUID[],
    p_entity_codes TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
DECLARE
    v_level TEXT := upper(COALESCE(p_level, 'READ'));
    v_denied INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('problem', 'This step has no person behind it.');
    END IF;
    IF v_level NOT IN ('READ', 'WRITE') THEN
        RAISE EXCEPTION 'p_level must be READ or WRITE' USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', p_user_id::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'server_session', TRUE)::TEXT,
        TRUE
    );

    SELECT count(*) INTO v_denied
    FROM (
        SELECT id AS entity_id FROM unnest(COALESCE(p_entity_ids, ARRAY[]::UUID[])) AS id
        UNION
        SELECT e.id
        FROM entity_instances.master_entities e
        WHERE e.client_id = p_client_id
          AND e.entity_code = ANY (COALESCE(p_entity_codes, ARRAY[]::TEXT[]))
    ) named
    WHERE NOT EXISTS (
            SELECT 1 FROM entity_instances.master_entities e
            WHERE e.id = named.entity_id AND e.client_id = p_client_id
          )
       OR NOT COALESCE(tenancy.has_entity_access(named.entity_id, v_level), FALSE);

    RETURN jsonb_build_object('denied', v_denied);
END;
$$;
REVOKE ALL ON FUNCTION public.workflow_worker_entity_access(UUID, UUID, TEXT, UUID[], TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_worker_entity_access(UUID, UUID, TEXT, UUID[], TEXT[]) TO service_role;

-- ============================================================
-- 2. The collector says which client a notice belongs to
-- ============================================================
CREATE OR REPLACE FUNCTION public.job_run_notify_collect(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'ops', 'tenancy', 'pg_temp'
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

-- ============================================================
-- 3. One run sends each notice to each recipient
-- ============================================================
ALTER TABLE ops.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;
ALTER TABLE ops.notification_deliveries
    ADD CONSTRAINT notification_deliveries_status_check CHECK (status IN ('SENDING', 'SENT', 'FAILED'));

-- TRUE when this run may send: nobody has, a previous attempt failed, or a
-- claim was left by a run that stopped more than ten minutes ago. FALSE when
-- it was sent, or another run is sending it now. The send is recorded after
-- with job_run_notify_record, which turns the claim into SENT or FAILED.
CREATE OR REPLACE FUNCTION public.job_run_notify_claim(p_event_id UUID, p_channel TEXT, p_recipient TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    WITH claimed AS (
        INSERT INTO ops.notification_deliveries (event_id, channel, recipient, status)
        VALUES (p_event_id, p_channel, p_recipient, 'SENDING')
        ON CONFLICT (event_id, channel, recipient) DO UPDATE
           SET status = 'SENDING', error = NULL, created_at = NOW()
         WHERE ops.notification_deliveries.status = 'FAILED'
            OR (ops.notification_deliveries.status = 'SENDING'
                AND ops.notification_deliveries.created_at < NOW() - INTERVAL '10 minutes')
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION public.job_run_notify_claim(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_run_notify_claim(UUID, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
