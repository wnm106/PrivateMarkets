-- Job queue: one client cannot block or read another client's jobs.
--
-- A dedupe key keeps the same job from being queued twice. Keys were global and
-- a person with job.manage could pick one, so a user of one client could:
--   * queue a job under another client's key (for example document:<id>) with a
--     run time far in the future, which silently dropped that client's real job;
--   * get another client's run id back when the key was already taken.
--
-- A key a person supplies is now filed under their client, so it can only ever
-- collide with that client's own keys. Keys the system sets (a schedule's, a
-- document's, a notice's) are unchanged. The body is otherwise the one already
-- in the database.

CREATE OR REPLACE FUNCTION public.job_enqueue(p_client_id uuid, p_job_type text, p_payload jsonb DEFAULT '{}'::jsonb, p_run_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dedupe_key text DEFAULT NULL::text, p_max_attempts integer DEFAULT 3, p_schedule_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'tenancy', 'pg_temp'
AS $$
DECLARE
    v_schedule ops.job_schedules;
    v_client UUID := p_client_id;
    v_type TEXT := NULLIF(btrim(COALESCE(p_job_type, '')), '');
    v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
    v_attempts INTEGER := COALESCE(p_max_attempts, 3);
    v_key TEXT := NULLIF(btrim(COALESCE(p_dedupe_key, '')), '');
    v_run_id UUID;
BEGIN
    IF p_schedule_id IS NOT NULL THEN
        SELECT * INTO v_schedule FROM ops.job_schedules WHERE id = p_schedule_id;
        IF NOT FOUND OR NOT ops.can_see(v_schedule.client_id) THEN
            RAISE EXCEPTION 'Schedule was not found' USING ERRCODE = 'P0002';
        END IF;
        v_client := v_schedule.client_id;
        v_type := v_schedule.job_type;
        v_payload := v_schedule.payload;
        v_attempts := v_schedule.max_attempts;
        v_key := 'schedule:' || v_schedule.id::text;
    END IF;

    IF v_type IS NULL THEN
        RAISE EXCEPTION 'A job type is required' USING ERRCODE = '22023';
    END IF;
    IF NOT ops.can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
    END IF;

    -- A key chosen by a person is filed under their client. The service role
    -- and a schedule's own key are trusted as they are.
    IF v_key IS NOT NULL AND p_schedule_id IS NULL AND NOT ops.is_service_role() THEN
        v_key := 'client:' || COALESCE(v_client::text, 'platform') || ':' || v_key;
    END IF;

    INSERT INTO ops.job_runs (
        client_id, schedule_id, job_type, payload, max_attempts, run_after, dedupe_key, requested_by
    ) VALUES (
        v_client, p_schedule_id, v_type, v_payload, v_attempts, COALESCE(p_run_after, NOW()), v_key, auth.uid()
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id INTO v_run_id;

    IF v_run_id IS NULL THEN
        SELECT id INTO v_run_id
        FROM ops.job_runs
        WHERE dedupe_key = v_key AND status IN ('QUEUED', 'RUNNING')
          AND client_id IS NOT DISTINCT FROM v_client;
    ELSIF p_schedule_id IS NOT NULL THEN
        UPDATE ops.job_schedules SET last_run_at = NOW(), last_run_id = v_run_id WHERE id = p_schedule_id;
    END IF;

    RETURN v_run_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
