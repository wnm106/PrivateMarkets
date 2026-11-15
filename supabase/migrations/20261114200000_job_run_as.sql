-- Jobs that need a person: data quality and stale-data scans.
--
-- The data quality dashboard and the stale-attribute report decide what a
-- caller may see from who is signed in (client membership, entity.read, entity
-- grants). The worker has no signed-in user, so those reports come back empty
-- for it.
--
-- A job of this kind runs as its owner: the person who created the schedule,
-- or who queued the run. ops.assume_user makes that person the caller for the
-- rest of the transaction, so the existing reports apply their own access
-- rules unchanged. If the owner has left the client, or lost entity.read, the
-- job fails and says so.
--
-- The owner must belong to exactly one client. Both reports cover every client
-- the caller belongs to, and a job's result must stay with the job's client.

-- A scheduled run carries the schedule's creator as its owner.
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

    INSERT INTO ops.job_runs (client_id, schedule_id, job_type, payload, max_attempts, dedupe_key, requested_by)
    VALUES (
        v_schedule.client_id, v_schedule.id, v_schedule.job_type, v_schedule.payload, v_schedule.max_attempts,
        'schedule:' || v_schedule.id::text, v_schedule.created_by
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

-- Makes p_user_id the caller until the transaction ends, after checking that
-- they still belong to p_client_id, to no other client, and may read its records.
CREATE OR REPLACE FUNCTION ops.assume_user(p_user_id UUID, p_client_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'This job needs a client' USING ERRCODE = '22023';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'This job has no owner to run as. Queue it from a schedule or from the Jobs page.' USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text,
        TRUE
    );

    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;

    IF v_clients IS NULL OR NOT (p_client_id = ANY (v_clients)) THEN
        RAISE EXCEPTION 'The person who scheduled this job no longer belongs to this client' USING ERRCODE = '42501';
    END IF;
    IF cardinality(v_clients) > 1 THEN
        RAISE EXCEPTION 'The person who scheduled this job belongs to more than one client. This job needs an owner with one client, so its results stay with that client.'
            USING ERRCODE = '42501';
    END IF;
    IF NOT tenancy.has_permission(p_client_id, 'entity.read') THEN
        RAISE EXCEPTION 'The person who scheduled this job can no longer read this client''s records' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- The data quality dashboard's headline figures for the owner's client.
CREATE OR REPLACE FUNCTION public.job_run_dq_scan(
    p_user_id UUID,
    p_client_id UUID,
    p_domain_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '120s'
SET search_path = ops, public, pg_temp
AS $$
DECLARE
    v_report JSONB;
BEGIN
    PERFORM ops.assume_user(p_user_id, p_client_id);
    v_report := public.data_quality_dashboard(NULLIF(btrim(COALESCE(p_domain_code, '')), ''));
    RETURN jsonb_build_object(
        'fromDate', v_report -> 'fromDate',
        'toDate', v_report -> 'toDate',
        'domainCode', NULLIF(btrim(COALESCE(p_domain_code, '')), ''),
        'summary', COALESCE(v_report -> 'summary', '{}'::jsonb)
    );
END;
$$;

-- How many prevailing values have not been received for p_older_than_days, and the oldest of them.
CREATE OR REPLACE FUNCTION public.job_run_stale_scan(
    p_user_id UUID,
    p_client_id UUID,
    p_older_than_days INTEGER DEFAULT 30,
    p_domain_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '120s'
SET search_path = ops, public, pg_temp
AS $$
DECLARE
    v_report JSONB;
BEGIN
    PERFORM ops.assume_user(p_user_id, p_client_id);
    v_report := public.stale_attributes(NULLIF(btrim(COALESCE(p_domain_code, '')), ''), COALESCE(p_older_than_days, 30));
    RETURN jsonb_build_object(
        'olderThanDays', v_report -> 'olderThanDays',
        'asOfDate', v_report -> 'asOfDate',
        'domainCode', NULLIF(btrim(COALESCE(p_domain_code, '')), ''),
        'count', COALESCE(v_report -> 'count', '0'::jsonb),
        'oldest', COALESCE((
            SELECT jsonb_agg(item.value ORDER BY item.ordinality)
            FROM jsonb_array_elements(COALESCE(v_report -> 'attributes', '[]'::jsonb)) WITH ORDINALITY AS item
            WHERE item.ordinality <= 25
        ), '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION ops.assume_user(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_fire_schedule(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_dq_scan(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_stale_scan(UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_fire_schedule(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_dq_scan(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_stale_scan(UUID, UUID, INTEGER, TEXT) TO service_role;

COMMENT ON FUNCTION ops.assume_user(UUID, UUID) IS
    'Makes a job''s owner the caller for the rest of the transaction. Reachable only from the job functions, which only the service role may run.';

NOTIFY pgrst, 'reload schema';
