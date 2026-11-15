-- Job backbone: schedules and a run queue.
--
-- A schedule says "run this job type for this client on this cron". A run is one
-- execution. A worker process (packages/worker) fires due schedules, claims
-- queued runs, and reports the outcome. Several workers may run at once: a
-- schedule fires once because job_fire_schedule compares the next_run_at it read,
-- and a run is claimed once because job_claim skips locked rows.
--
-- The tables live in the ops schema, which the REST API does not expose. All
-- access goes through the public functions below. Worker functions are granted
-- to service_role only. User functions check tenancy permissions.
--
-- client_id NULL marks a platform job (for example the calculation queue, which
-- is not per client). Only tenant admins see or manage those.

CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO service_role;

CREATE TABLE IF NOT EXISTS ops.job_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    schedule_code VARCHAR(100) NOT NULL,
    schedule_name VARCHAR(200) NOT NULL,
    job_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    cron_expression VARCHAR(100) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_run_id UUID,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS job_schedules_client_code
    ON ops.job_schedules (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), schedule_code);
CREATE INDEX IF NOT EXISTS job_schedules_due
    ON ops.job_schedules (next_run_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS ops.job_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    schedule_id UUID REFERENCES ops.job_schedules(id) ON DELETE SET NULL,
    job_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    priority INTEGER NOT NULL DEFAULT 100,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dedupe_key TEXT,
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    result JSONB,
    error_message TEXT,
    requested_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_runs_claimable
    ON ops.job_runs (priority, run_after, created_at) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS job_runs_client_created
    ON ops.job_runs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_schedule_created
    ON ops.job_runs (schedule_id, created_at DESC);
-- One open run per dedupe key. A finished run frees the key.
CREATE UNIQUE INDEX IF NOT EXISTS job_runs_open_dedupe
    ON ops.job_runs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING');

-- No policies: direct access is denied. The functions below own every read and write.
ALTER TABLE ops.job_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.job_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.job_schedules IS 'Recurring jobs. client_id NULL is a platform job.';
COMMENT ON TABLE ops.job_runs IS 'One execution of a job. FAILED is final: retries are exhausted or the error cannot be retried.';
COMMENT ON COLUMN ops.job_runs.lease_expires_at IS 'A RUNNING run whose lease has passed is claimed again, or failed when no attempts remain.';

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('job.manage', 'Create and change job schedules, queue jobs, and retry or cancel runs')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'job.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ops.is_service_role()
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb ->> 'role', '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION ops.can_see(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN tenancy.is_tenant_admin()
        ELSE p_client_id IN (SELECT tenancy.current_client_ids())
    END;
$$;

CREATE OR REPLACE FUNCTION ops.can_manage(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN tenancy.is_tenant_admin()
        ELSE tenancy.has_permission(p_client_id, 'job.manage')
    END;
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (service_role only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_due_schedules(
    p_now TIMESTAMPTZ DEFAULT NOW(),
    p_limit INTEGER DEFAULT 100
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT to_jsonb(s)
    FROM ops.job_schedules AS s
    WHERE s.is_active
      AND (s.next_run_at IS NULL OR s.next_run_at <= p_now)
    ORDER BY s.next_run_at NULLS FIRST
    LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$$;

-- Advances a schedule and queues its run in one step. p_expected_next_run_at is
-- the value the worker read: when another worker already advanced the schedule,
-- nothing matches and NULL comes back. p_queue FALSE only advances (used to give
-- a schedule its first next_run_at without running it).
CREATE OR REPLACE FUNCTION public.job_fire_schedule(
    p_schedule_id UUID,
    p_expected_next_run_at TIMESTAMPTZ,
    p_new_next_run_at TIMESTAMPTZ,
    p_queue BOOLEAN DEFAULT TRUE
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_schedule ops.job_schedules;
    v_run_id UUID;
BEGIN
    UPDATE ops.job_schedules
       SET next_run_at = p_new_next_run_at,
           updated_at = NOW()
     WHERE id = p_schedule_id
       AND is_active
       AND next_run_at IS NOT DISTINCT FROM p_expected_next_run_at
    RETURNING * INTO v_schedule;

    IF NOT FOUND OR NOT COALESCE(p_queue, TRUE) THEN
        RETURN NULL;
    END IF;

    INSERT INTO ops.job_runs (client_id, schedule_id, job_type, payload, max_attempts, dedupe_key)
    VALUES (
        v_schedule.client_id, v_schedule.id, v_schedule.job_type, v_schedule.payload, v_schedule.max_attempts,
        'schedule:' || v_schedule.id::text
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id INTO v_run_id;

    -- The previous run of this schedule is still open: skip this firing rather than stack runs.
    IF v_run_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE ops.job_schedules
       SET last_run_at = NOW(), last_run_id = v_run_id
     WHERE id = v_schedule.id;

    RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_claim(
    p_worker TEXT,
    p_limit INTEGER DEFAULT 5,
    p_lease_seconds INTEGER DEFAULT 300,
    p_job_types TEXT[] DEFAULT NULL
) RETURNS SETOF JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF NULLIF(btrim(COALESCE(p_worker, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A worker name is required' USING ERRCODE = '22023';
    END IF;

    -- A worker died on the last allowed attempt.
    UPDATE ops.job_runs
       SET status = 'FAILED',
           finished_at = NOW(),
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL,
           error_message = 'The worker stopped responding on the last attempt'
     WHERE status = 'RUNNING'
       AND lease_expires_at < NOW()
       AND attempts >= max_attempts;

    RETURN QUERY
    WITH picked AS (
        SELECT r.id
        FROM ops.job_runs AS r
        WHERE (
                (r.status = 'QUEUED' AND r.run_after <= NOW())
             OR (r.status = 'RUNNING' AND r.lease_expires_at < NOW())
              )
          AND (p_job_types IS NULL OR r.job_type = ANY (p_job_types))
        ORDER BY r.priority, r.run_after, r.created_at
        LIMIT GREATEST(COALESCE(p_limit, 5), 1)
        FOR UPDATE SKIP LOCKED
    )
    UPDATE ops.job_runs AS r
       SET status = 'RUNNING',
           attempts = r.attempts + 1,
           locked_by = p_worker,
           lease_expires_at = NOW() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 10)),
           started_at = NOW(),
           finished_at = NULL,
           updated_at = NOW()
      FROM picked
     WHERE r.id = picked.id
    RETURNING to_jsonb(r);
END;
$$;

CREATE OR REPLACE FUNCTION public.job_heartbeat(
    p_run_id UUID,
    p_worker TEXT,
    p_lease_seconds INTEGER DEFAULT 300
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    UPDATE ops.job_runs
       SET lease_expires_at = NOW() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 10)),
           updated_at = NOW()
     WHERE id = p_run_id AND status = 'RUNNING' AND locked_by = p_worker;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_complete(
    p_run_id UUID,
    p_worker TEXT,
    p_result JSONB DEFAULT '{}'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    UPDATE ops.job_runs
       SET status = 'SUCCEEDED',
           result = COALESCE(p_result, '{}'::jsonb),
           error_message = NULL,
           finished_at = NOW(),
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL
     WHERE id = p_run_id AND status = 'RUNNING' AND locked_by = p_worker;
    RETURN FOUND;
END;
$$;

-- Returns the new status: QUEUED when the run will be tried again, FAILED when it
-- will not, NULL when this worker no longer holds the run. The wait doubles from
-- 30 seconds and stops growing at one hour.
CREATE OR REPLACE FUNCTION public.job_fail(
    p_run_id UUID,
    p_worker TEXT,
    p_error TEXT,
    p_retryable BOOLEAN DEFAULT TRUE
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_status TEXT;
BEGIN
    UPDATE ops.job_runs
       SET status = CASE WHEN COALESCE(p_retryable, TRUE) AND attempts < max_attempts THEN 'QUEUED' ELSE 'FAILED' END,
           run_after = CASE
               WHEN COALESCE(p_retryable, TRUE) AND attempts < max_attempts
                   THEN NOW() + make_interval(secs => LEAST(30 * power(2, GREATEST(attempts - 1, 0)), 3600)::double precision)
               ELSE run_after
           END,
           finished_at = CASE WHEN COALESCE(p_retryable, TRUE) AND attempts < max_attempts THEN NULL ELSE NOW() END,
           error_message = left(COALESCE(p_error, 'The job failed'), 4000),
           updated_at = NOW(),
           locked_by = NULL,
           lease_expires_at = NULL
     WHERE id = p_run_id AND status = 'RUNNING' AND locked_by = p_worker
    RETURNING status INTO v_status;
    RETURN v_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- User functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_schedules_list(p_client_id UUID DEFAULT NULL)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(s) || jsonb_build_object(
        'last_run_status', (SELECT r.status FROM ops.job_runs AS r WHERE r.id = s.last_run_id)
    )
    FROM ops.job_schedules AS s
    WHERE ops.can_see(s.client_id)
      AND (p_client_id IS NULL OR s.client_id = p_client_id)
    ORDER BY s.schedule_name;
$$;

CREATE OR REPLACE FUNCTION public.job_schedule_save(
    p_id UUID,
    p_client_id UUID,
    p_schedule_code TEXT,
    p_schedule_name TEXT,
    p_job_type TEXT,
    p_payload JSONB,
    p_cron_expression TEXT,
    p_timezone TEXT,
    p_is_active BOOLEAN,
    p_max_attempts INTEGER,
    p_next_run_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.job_schedules;
BEGIN
    IF NULLIF(btrim(COALESCE(p_schedule_code, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_schedule_name, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_job_type, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_cron_expression, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Code, name, job type, and cron expression are required' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        IF NOT ops.can_manage(p_client_id) THEN
            RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO ops.job_schedules (
            client_id, schedule_code, schedule_name, job_type, payload, cron_expression,
            timezone, is_active, max_attempts, next_run_at, created_by
        ) VALUES (
            p_client_id, btrim(p_schedule_code), btrim(p_schedule_name), btrim(p_job_type),
            COALESCE(p_payload, '{}'::jsonb), btrim(p_cron_expression),
            COALESCE(NULLIF(btrim(COALESCE(p_timezone, '')), ''), 'UTC'),
            COALESCE(p_is_active, TRUE), COALESCE(p_max_attempts, 3), p_next_run_at, auth.uid()
        )
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ops.job_schedules WHERE id = p_id;
        IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
            RAISE EXCEPTION 'Schedule was not found' USING ERRCODE = 'P0002';
        END IF;
        -- A schedule stays with its client.
        IF NOT ops.can_manage(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
        END IF;
        UPDATE ops.job_schedules
           SET schedule_code = btrim(p_schedule_code),
               schedule_name = btrim(p_schedule_name),
               job_type = btrim(p_job_type),
               payload = COALESCE(p_payload, '{}'::jsonb),
               cron_expression = btrim(p_cron_expression),
               timezone = COALESCE(NULLIF(btrim(COALESCE(p_timezone, '')), ''), 'UTC'),
               is_active = COALESCE(p_is_active, TRUE),
               max_attempts = COALESCE(p_max_attempts, 3),
               next_run_at = p_next_run_at,
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.job_schedule_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.job_schedules WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.job_schedules WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- Queues one run. With a dedupe key, an open run for the same key is returned
-- instead of queuing a second one. p_schedule_id runs a schedule now: the job
-- type and payload come from the schedule.
CREATE OR REPLACE FUNCTION public.job_enqueue(
    p_client_id UUID,
    p_job_type TEXT,
    p_payload JSONB DEFAULT '{}',
    p_run_after TIMESTAMPTZ DEFAULT NULL,
    p_dedupe_key TEXT DEFAULT NULL,
    p_max_attempts INTEGER DEFAULT 3,
    p_schedule_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
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
        WHERE dedupe_key = v_key AND status IN ('QUEUED', 'RUNNING');
    ELSIF p_schedule_id IS NOT NULL THEN
        UPDATE ops.job_schedules SET last_run_at = NOW(), last_run_id = v_run_id WHERE id = p_schedule_id;
    END IF;

    RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_runs_list(
    p_client_id UUID DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_schedule_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(r) || jsonb_build_object(
        'schedule_name', (SELECT s.schedule_name FROM ops.job_schedules AS s WHERE s.id = r.schedule_id)
    )
    FROM ops.job_runs AS r
    WHERE ops.can_see(r.client_id)
      AND (p_client_id IS NULL OR r.client_id = p_client_id)
      AND (p_status IS NULL OR r.status = p_status)
      AND (p_schedule_id IS NULL OR r.schedule_id = p_schedule_id)
    ORDER BY r.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

CREATE OR REPLACE FUNCTION public.job_run_get(p_run_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(r) || jsonb_build_object(
        'schedule_name', (SELECT s.schedule_name FROM ops.job_schedules AS s WHERE s.id = r.schedule_id)
    )
    FROM ops.job_runs AS r
    WHERE r.id = p_run_id AND ops.can_see(r.client_id);
$$;

-- Puts a finished run back in the queue with a fresh set of attempts.
CREATE OR REPLACE FUNCTION public.job_run_retry(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.job_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
    END IF;
    UPDATE ops.job_runs
       SET status = 'QUEUED', attempts = 0, run_after = NOW(), finished_at = NULL,
           error_message = NULL, result = NULL, updated_at = NOW()
     WHERE id = p_run_id AND status IN ('FAILED', 'CANCELLED');
    RETURN FOUND;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'The same job is already queued or running' USING ERRCODE = '23505';
END;
$$;

-- Only a queued run can be cancelled. A running job is not interrupted.
CREATE OR REPLACE FUNCTION public.job_run_cancel(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.job_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot manage jobs for this client' USING ERRCODE = '42501';
    END IF;
    UPDATE ops.job_runs
       SET status = 'CANCELLED', finished_at = NOW(), updated_at = NOW()
     WHERE id = p_run_id AND status = 'QUEUED';
    RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.is_service_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.can_see(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.can_manage(UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.job_due_schedules(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_fire_schedule(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_claim(TEXT, INTEGER, INTEGER, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_heartbeat(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_complete(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_fail(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_due_schedules(TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_fire_schedule(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_claim(TEXT, INTEGER, INTEGER, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_heartbeat(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_complete(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_fail(UUID, TEXT, TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.job_schedules_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_schedule_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, BOOLEAN, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_schedule_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_enqueue(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT, INTEGER, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_runs_list(UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_retry(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_cancel(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_schedules_list(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_schedule_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, BOOLEAN, INTEGER, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_schedule_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_enqueue(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT, INTEGER, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_runs_list(UUID, TEXT, UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_get(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_retry(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_cancel(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
