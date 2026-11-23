-- Workflow lists show only the client the caller is working in, for staff too.
-- Run by scripts/db-tests/workflow-client-scope.ts against a database built from
-- supabase/migrations. Everything is rolled back; any failed check raises.
-- See supabase/migrations/20261123130000_workflow_scope_to_open_client.sql.
BEGIN;
DO $$
DECLARE
    v_home UUID := gen_random_uuid();
    v_other UUID := gen_random_uuid();
    v_staff UUID := gen_random_uuid();
    v_home_review UUID;
    v_other_review UUID;
    v_wf UUID;
    v_ver UUID;
    v_run UUID;
    v_ids UUID[];
    v_client UUID;
BEGIN
    INSERT INTO tenancy.clients (id, client_code, client_name) VALUES
        (v_home, 'SCOPE_HOME', 'Scope home'),
        (v_other, 'SCOPE_OTHER', 'Scope other');
    INSERT INTO auth.users (id, email) VALUES (v_staff, 'staff@example.test');
    INSERT INTO tenancy.profiles (id, display_name, is_active, is_tenant_admin) VALUES (v_staff, 'Staff', TRUE, TRUE)
        ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_tenant_admin = TRUE;
    INSERT INTO tenancy.client_users (client_id, user_id, is_active) VALUES (v_home, v_staff, TRUE);

    -- One workflow, run and open review in each client.
    FOREACH v_client IN ARRAY ARRAY[v_home, v_other] LOOP
        INSERT INTO ops.workflows (client_id, workflow_code, workflow_name) VALUES (v_client, 'SCOPE_CHECK', 'Scope check') RETURNING id INTO v_wf;
        INSERT INTO ops.workflow_versions (workflow_id, version, graph) VALUES (v_wf, 1, '{"nodes":[],"edges":[]}') RETURNING id INTO v_ver;
        INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version, status, started_by)
            VALUES (v_client, v_wf, v_ver, 1, 'WAITING', v_staff) RETURNING id INTO v_run;
        INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title) VALUES (v_run, v_client, 'review', 'Review') RETURNING id INTO v_home_review;
        v_ids := COALESCE(v_ids, ARRAY[]::UUID[]) || v_home_review;
    END LOOP;
    v_home_review := v_ids[1];
    v_other_review := v_ids[2];

    -- Signed in as staff with a second factor.
    PERFORM set_config('request.jwt.claim.sub', v_staff::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    IF NOT tenancy.is_tenant_admin() THEN RAISE EXCEPTION 'setup: the caller is not staff'; END IF;

    -- Not in support mode: only the client they belong to.
    SELECT array_agg((v ->> 'id')::uuid) INTO v_ids FROM public.workflow_reviews_list('OPEN', 100, FALSE) AS v
        WHERE (v ->> 'id')::uuid IN (v_home_review, v_other_review);
    IF v_ids IS DISTINCT FROM ARRAY[v_home_review] THEN RAISE EXCEPTION 'staff outside support mode saw reviews %', v_ids; END IF;
    IF public.workflow_review_get(v_other_review) IS NOT NULL THEN RAISE EXCEPTION 'staff read a review of a client they are not in'; END IF;
    IF ops.workflow_can(v_other, 'workflow.review') THEN RAISE EXCEPTION 'staff may review in a client they are not in'; END IF;
    RAISE NOTICE 'ok: staff outside support mode see and act on their own client only';

    -- In support mode for the other client: that client only.
    INSERT INTO tenancy.impersonation_sessions (admin_user_id, client_id, expires_at) VALUES (v_staff, v_other, NOW() + INTERVAL '1 hour');
    SELECT array_agg((v ->> 'id')::uuid) INTO v_ids FROM public.workflow_reviews_list('OPEN', 100, FALSE) AS v
        WHERE (v ->> 'id')::uuid IN (v_home_review, v_other_review);
    IF v_ids IS DISTINCT FROM ARRAY[v_other_review] THEN RAISE EXCEPTION 'staff in support mode saw reviews %', v_ids; END IF;
    IF NOT ops.workflow_can(v_other, 'workflow.review') THEN RAISE EXCEPTION 'staff cannot review in the client they are supporting'; END IF;
    IF ops.workflow_can(v_home, 'workflow.review') THEN RAISE EXCEPTION 'staff in support mode may still review in their own client'; END IF;
    IF EXISTS (SELECT 1 FROM public.workflow_runs_list(NULL, NULL, 100) AS r WHERE (r ->> 'client_id')::uuid = v_home) THEN
        RAISE EXCEPTION 'staff in support mode saw runs of another client';
    END IF;
    RAISE NOTICE 'ok: staff in support mode see and act on the supported client only';

    -- Shared workflows (no client) are still managed by staff only.
    IF NOT ops.workflow_can(NULL, 'workflow.manage') THEN RAISE EXCEPTION 'staff cannot manage a shared workflow'; END IF;
    IF NOT ops.workflow_can_see(NULL) THEN RAISE EXCEPTION 'a shared workflow is hidden from someone working in a client'; END IF;
    RAISE NOTICE 'ok: shared workflows stay visible, and staff still manage them';
END;
$$;
ROLLBACK;
