-- Configuration changes are written to the audit log against the right client,
-- without secrets or bookkeeping, and each reader sees only what they may.
-- Run by scripts/db-tests/configuration-audit.ts against a database built from
-- supabase/migrations. Everything is rolled back; any failed check raises.
-- See supabase/migrations/20261125100000_configuration_audit.sql.
BEGIN;
DO $$
DECLARE
    v_a UUID := gen_random_uuid();
    v_b UUID := gen_random_uuid();
    v_admin UUID := gen_random_uuid();
    v_analyst UUID := gen_random_uuid();
    v_staff UUID := gen_random_uuid();
    v_attr UUID;
    v_attr_b UUID;
    v_shared_attr UUID;
    v_template UUID;
    v_conn UUID;
    v_schedule UUID;
    v_entry tenancy.audit_log%ROWTYPE;
    v_count INTEGER;
    v_start BIGINT;
    v_read JSONB;
    v_ids TEXT[];
    v_failed BOOLEAN;
BEGIN
    SELECT COALESCE(max(id), 0) INTO v_start FROM tenancy.audit_log;

    INSERT INTO tenancy.clients (id, client_code, client_name) VALUES
        (v_a, 'AUDIT_A', 'Audit A'),
        (v_b, 'AUDIT_B', 'Audit B');
    INSERT INTO auth.users (id, email) VALUES
        (v_admin, 'admin@audit.test'), (v_analyst, 'analyst@audit.test'), (v_staff, 'staff@audit.test');
    INSERT INTO tenancy.profiles (id, display_name, is_active, is_tenant_admin) VALUES
        (v_admin, 'Audit Admin', TRUE, FALSE),
        (v_analyst, 'Audit Analyst', TRUE, FALSE),
        (v_staff, 'Audit Staff', TRUE, TRUE)
        ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = TRUE, is_tenant_admin = EXCLUDED.is_tenant_admin;
    INSERT INTO tenancy.client_users (client_id, user_id, is_active) VALUES
        (v_a, v_admin, TRUE), (v_a, v_analyst, TRUE), (v_a, v_staff, TRUE);
    INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
        SELECT v_a, v_admin, r.id FROM tenancy.roles r WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL;
    INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
        SELECT v_a, v_analyst, r.id FROM tenancy.roles r WHERE r.role_code = 'ANALYST' AND r.client_id IS NULL;

    -- Changes made by the client administrator of A.
    PERFORM set_config('request.jwt.claim.sub', v_admin::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);

    INSERT INTO metadata_register.attribute_register (client_id, attribute_code, attribute_name, data_type)
        VALUES (v_a, 'AUDIT_TEST_A', 'Audit test A', 'STRING') RETURNING id INTO v_attr;
    UPDATE metadata_register.attribute_register SET attribute_name = 'Audit test A renamed' WHERE id = v_attr;

    SELECT * INTO v_entry FROM tenancy.audit_log
        WHERE id > v_start AND table_name = 'attribute_register' AND operation = 'UPDATE' AND row_id = v_attr::TEXT;
    IF NOT FOUND THEN RAISE EXCEPTION 'an attribute rename was not recorded'; END IF;
    IF v_entry.schema_name <> 'metadata_register' THEN RAISE EXCEPTION 'schema recorded as %', v_entry.schema_name; END IF;
    IF v_entry.client_id IS DISTINCT FROM v_a THEN RAISE EXCEPTION 'attribute change recorded against client %', v_entry.client_id; END IF;
    IF v_entry.actor_user_id IS DISTINCT FROM v_admin THEN RAISE EXCEPTION 'attribute change recorded as made by %', v_entry.actor_user_id; END IF;
    IF NOT ('attribute_name' = ANY (v_entry.changed_fields)) THEN RAISE EXCEPTION 'changed fields were %', v_entry.changed_fields; END IF;
    IF 'updated_at' = ANY (v_entry.changed_fields) AND cardinality(v_entry.changed_fields) = 1 THEN RAISE EXCEPTION 'only bookkeeping recorded'; END IF;
    IF v_entry.old_row ->> 'attribute_name' <> 'Audit test A' OR v_entry.new_row ->> 'attribute_name' <> 'Audit test A renamed' THEN
        RAISE EXCEPTION 'before and after were not kept';
    END IF;
    RAISE NOTICE 'ok: an attribute change records who, which client, what changed, before and after';

    -- A row with no client_id of its own takes its parent's client.
    INSERT INTO metadata_register.domain_templates (client_id, domain_code, template_code, template_name)
        VALUES (v_a, 'FUND', 'AUDIT_TEMPLATE', 'Audit template') RETURNING id INTO v_template;
    INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id) VALUES (v_template, v_attr);
    SELECT * INTO v_entry FROM tenancy.audit_log
        WHERE id > v_start AND table_name = 'template_attribute_assignments' AND operation = 'INSERT';
    IF NOT FOUND THEN RAISE EXCEPTION 'a template assignment was not recorded'; END IF;
    IF v_entry.client_id IS DISTINCT FROM v_a THEN RAISE EXCEPTION 'template assignment recorded against client % instead of its template''s', v_entry.client_id; END IF;
    RAISE NOTICE 'ok: a child row is recorded against its parent''s client';

    -- Bookkeeping alone is not a change.
    INSERT INTO ops.job_schedules (client_id, schedule_code, schedule_name, job_type, cron_expression)
        VALUES (v_a, 'AUDIT_SCHEDULE', 'Audit schedule', 'NOOP', '0 * * * *') RETURNING id INTO v_schedule;
    SELECT count(*) INTO v_count FROM tenancy.audit_log WHERE id > v_start AND table_name = 'job_schedules';
    UPDATE ops.job_schedules SET last_run_at = NOW(), next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = v_schedule;
    IF (SELECT count(*) FROM tenancy.audit_log WHERE id > v_start AND table_name = 'job_schedules') <> v_count THEN
        RAISE EXCEPTION 'a schedule running was recorded as a configuration change';
    END IF;
    UPDATE ops.job_schedules SET cron_expression = '30 * * * *' WHERE id = v_schedule;
    IF (SELECT count(*) FROM tenancy.audit_log WHERE id > v_start AND table_name = 'job_schedules') <> v_count + 1 THEN
        RAISE EXCEPTION 'a schedule change was not recorded';
    END IF;
    RAISE NOTICE 'ok: bookkeeping columns alone are not recorded; a real change is';

    -- Secrets are named but never stored.
    INSERT INTO ops.connections (client_id, kind, connection_code, connection_name)
        VALUES (v_a, 'EMAIL', 'AUDIT_CONN', 'Audit connection') RETURNING id INTO v_conn;
    UPDATE ops.connections SET inbound_token = 'audit-test-token-value' WHERE id = v_conn;
    SELECT * INTO v_entry FROM tenancy.audit_log
        WHERE id > v_start AND table_name = 'connections' AND operation = 'UPDATE' AND row_id = v_conn::TEXT;
    IF NOT FOUND THEN RAISE EXCEPTION 'a token rotation was not recorded'; END IF;
    IF NOT ('inbound_token' = ANY (v_entry.changed_fields)) THEN RAISE EXCEPTION 'the rotated token was not named'; END IF;
    IF v_entry.old_row ? 'inbound_token' OR v_entry.new_row ? 'inbound_token' THEN RAISE EXCEPTION 'a token was stored in the log'; END IF;
    IF EXISTS (SELECT 1 FROM tenancy.audit_log WHERE id > v_start AND (old_row::TEXT LIKE '%audit-test-token-value%' OR new_row::TEXT LIKE '%audit-test-token-value%')) THEN
        RAISE EXCEPTION 'the token value reached the log';
    END IF;
    RAISE NOTICE 'ok: secrets are named in changed fields and never stored';

    -- A change in client B, and a shared one, made by the platform.
    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claims', '', TRUE);
    INSERT INTO metadata_register.attribute_register (client_id, attribute_code, attribute_name, data_type)
        VALUES (v_b, 'AUDIT_TEST_B', 'Audit test B', 'STRING') RETURNING id INTO v_attr_b;
    INSERT INTO metadata_register.attribute_register (client_id, attribute_code, attribute_name, data_type)
        VALUES (NULL, 'AUDIT_TEST_SHARED', 'Audit test shared', 'STRING') RETURNING id INTO v_shared_attr;

    -- The log is still append-only.
    v_failed := FALSE;
    BEGIN
        UPDATE tenancy.audit_log SET row_id = 'x' WHERE id = v_entry.id;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'an audit entry was changed'; END IF;
    RAISE NOTICE 'ok: the log stays append-only';

    -- Reading. The client administrator of A reads A only.
    PERFORM set_config('request.jwt.claim.sub', v_admin::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    v_read := public.audit_log_entries('configuration', NULL, NULL, 'metadata_register.attribute_register', NULL, NULL, 'AUDIT_TEST', 100, NULL);
    SELECT array_agg(DISTINCT e ->> 'rowId') INTO v_ids FROM jsonb_array_elements(v_read -> 'entries') e;
    IF v_ids IS DISTINCT FROM ARRAY[v_attr::TEXT] THEN RAISE EXCEPTION 'client admin read attribute entries %', v_ids; END IF;
    IF (v_read -> 'entries' -> 0 ->> 'actorLabel') <> 'Audit Admin' THEN RAISE EXCEPTION 'actor shown as %', v_read -> 'entries' -> 0 ->> 'actorLabel'; END IF;
    IF (v_read -> 'entries' -> 0 ->> 'kind') <> 'configuration' THEN RAISE EXCEPTION 'kind shown as %', v_read -> 'entries' -> 0 ->> 'kind'; END IF;
    -- Paging: one at a time, then the rest.
    v_read := public.audit_log_entries('configuration', NULL, NULL, 'attribute_register', NULL, v_attr::TEXT, NULL, 1, NULL);
    IF jsonb_array_length(v_read -> 'entries') <> 1 OR NOT (v_read ->> 'hasMore')::BOOLEAN THEN RAISE EXCEPTION 'first page was %', v_read; END IF;
    v_read := public.audit_log_entries('configuration', NULL, NULL, 'attribute_register', NULL, v_attr::TEXT, NULL, 1, (v_read -> 'entries' -> 0 ->> 'id')::BIGINT);
    IF jsonb_array_length(v_read -> 'entries') <> 1 OR (v_read ->> 'hasMore')::BOOLEAN THEN RAISE EXCEPTION 'second page was %', v_read; END IF;
    RAISE NOTICE 'ok: a client administrator reads their client''s entries, newest first, by page';

    -- An analyst may not read it.
    PERFORM set_config('request.jwt.claim.sub', v_analyst::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_analyst, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    v_failed := FALSE;
    BEGIN
        PERFORM public.audit_log_entries();
    EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'an analyst read the audit log'; END IF;
    RAISE NOTICE 'ok: a member without user or role management cannot read it';

    -- Staff outside support mode: their client and shared entries, not client B.
    PERFORM set_config('request.jwt.claim.sub', v_staff::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    v_read := public.audit_log_entries('configuration', NULL, NULL, 'attribute_register', NULL, NULL, 'AUDIT_TEST', 100, NULL);
    SELECT array_agg(DISTINCT e ->> 'rowId' ORDER BY e ->> 'rowId') INTO v_ids FROM jsonb_array_elements(v_read -> 'entries') e;
    IF v_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[v_attr::TEXT, v_shared_attr::TEXT]) x) THEN
        RAISE EXCEPTION 'staff outside support mode read attribute entries %', v_ids;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_read -> 'entries') e WHERE e ->> 'rowId' = v_shared_attr::TEXT AND e ->> 'actorLabel' LIKE 'Database (%') THEN
        RAISE EXCEPTION 'a change with no signed-in person was not labelled as the database';
    END IF;

    -- In support mode for B: B only.
    INSERT INTO tenancy.impersonation_sessions (admin_user_id, client_id, expires_at) VALUES (v_staff, v_b, NOW() + INTERVAL '1 hour');
    v_read := public.audit_log_entries(NULL, NULL, NULL, 'attribute_register', NULL, NULL, 'AUDIT_TEST', 100, NULL);
    SELECT array_agg(DISTINCT e ->> 'rowId') INTO v_ids FROM jsonb_array_elements(v_read -> 'entries') e;
    IF v_ids IS DISTINCT FROM ARRAY[v_attr_b::TEXT] THEN RAISE EXCEPTION 'staff in support mode read attribute entries %', v_ids; END IF;
    -- Opening support mode is itself an access entry for B.
    v_read := public.audit_log_entries('access', NULL, NULL, 'impersonation_sessions', NULL, NULL, NULL, 10, NULL);
    IF jsonb_array_length(v_read -> 'entries') < 1 THEN RAISE EXCEPTION 'support mode was not recorded for the client'; END IF;
    IF (v_read -> 'entries' -> 0 ->> 'kind') <> 'access' THEN RAISE EXCEPTION 'support mode recorded as %', v_read -> 'entries' -> 0 ->> 'kind'; END IF;
    RAISE NOTICE 'ok: staff read their clients and shared entries, or only the client they support';
END;
$$;

-- Signed-in users may call the reader; anonymous callers may not.
DO $$
BEGIN
    IF NOT has_function_privilege('authenticated', 'public.audit_log_entries(text, timestamptz, timestamptz, text, uuid, text, text, integer, bigint)', 'EXECUTE') THEN
        RAISE EXCEPTION 'signed-in users cannot call audit_log_entries';
    END IF;
    IF has_function_privilege('anon', 'public.audit_log_entries(text, timestamptz, timestamptz, text, uuid, text, text, integer, bigint)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anonymous callers can call audit_log_entries';
    END IF;
    IF has_function_privilege('authenticated', 'tenancy.audit_change()', 'EXECUTE') THEN
        RAISE EXCEPTION 'signed-in users can call the audit trigger function';
    END IF;
    RAISE NOTICE 'ok: grants';
END;
$$;
ROLLBACK;
