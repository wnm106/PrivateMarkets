-- See provisional-scopes.ts. Every check runs inside a transaction that is rolled back.
-- entity_instances.scope_for_caller hands a scope only to who may read it, and only while it is open.
BEGIN;
DO $$
DECLARE
    v_client UUID;
    v_other_client UUID;
    v_workflow UUID;
    v_version UUID;
    v_run UUID;
    v_run_scope UUID;
    v_batch_scope UUID;
    v_service UUID := gen_random_uuid();   -- the client's workflow service account
    v_ada UUID := gen_random_uuid();       -- entity.read and workflow.review
    v_bob UUID := gen_random_uuid();       -- entity.read only; staged the batch
    v_cy UUID := gen_random_uuid();        -- entity.read only
    v_eve UUID := gen_random_uuid();       -- another client's reviewer
    v_reader UUID;
    v_reviewer UUID;
    v_other_reviewer UUID;
BEGIN
    INSERT INTO tenancy.clients (client_code, client_name) VALUES ('SCOPE_TEST', 'Scope test') RETURNING id INTO v_client;
    INSERT INTO tenancy.clients (client_code, client_name) VALUES ('SCOPE_OTHER', 'Scope other') RETURNING id INTO v_other_client;
    INSERT INTO auth.users (id, email) VALUES
        (v_service, 'service@example.test'), (v_ada, 'ada@example.test'), (v_bob, 'bob@example.test'),
        (v_cy, 'cy@example.test'), (v_eve, 'eve@example.test');
    INSERT INTO tenancy.profiles (id, display_name, is_active) VALUES
        (v_service, 'Service', TRUE), (v_ada, 'Ada', TRUE), (v_bob, 'Bob', TRUE), (v_cy, 'Cy', TRUE), (v_eve, 'Eve', TRUE)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO tenancy.client_users (client_id, user_id, is_active) VALUES
        (v_client, v_service, TRUE), (v_client, v_ada, TRUE), (v_client, v_bob, TRUE), (v_client, v_cy, TRUE),
        (v_other_client, v_eve, TRUE);

    INSERT INTO tenancy.roles (client_id, role_code, role_name) VALUES (v_client, 'SCOPE_READER', 'Reader') RETURNING id INTO v_reader;
    INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT v_reader, id FROM tenancy.permissions WHERE permission_code = 'entity.read';
    INSERT INTO tenancy.roles (client_id, role_code, role_name) VALUES (v_client, 'SCOPE_REVIEWER', 'Reviewer') RETURNING id INTO v_reviewer;
    INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT v_reviewer, id FROM tenancy.permissions WHERE permission_code IN ('entity.read', 'workflow.review');
    INSERT INTO tenancy.roles (client_id, role_code, role_name) VALUES (v_other_client, 'SCOPE_OTHER_REVIEWER', 'Reviewer') RETURNING id INTO v_other_reviewer;
    INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT v_other_reviewer, id FROM tenancy.permissions WHERE permission_code IN ('entity.read', 'workflow.review', 'load.promote');
    INSERT INTO tenancy.user_roles (client_id, user_id, role_id) VALUES
        (v_client, v_service, v_reader), (v_client, v_ada, v_reviewer), (v_client, v_bob, v_reader), (v_client, v_cy, v_reader),
        (v_other_client, v_eve, v_other_reviewer);
    INSERT INTO ops.workflow_service_accounts (client_id, user_id) VALUES (v_client, v_service);

    INSERT INTO ops.workflows (client_id, workflow_code, workflow_name) VALUES (v_client, 'SCOPE_TEST', 'Scope test') RETURNING id INTO v_workflow;
    INSERT INTO ops.workflow_versions (workflow_id, version, graph) VALUES (v_workflow, 1, '{}') RETURNING id INTO v_version;
    INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version) VALUES (v_client, v_workflow, v_version, 1) RETURNING id INTO v_run;

    INSERT INTO entity_instances.provisional_scopes (client_id, kind, workflow_run_id) VALUES (v_client, 'WORKFLOW_RUN', v_run) RETURNING id INTO v_run_scope;
    INSERT INTO entity_instances.provisional_scopes (client_id, kind) VALUES (v_client, 'LOAD_BATCH') RETURNING id INTO v_batch_scope;
    INSERT INTO entity_instances.load_batches (client_id, file_name, as_of_date, staged_by, scope_id)
    VALUES (v_client, 'positions.csv', '2026-09-30', v_bob, v_batch_scope);

    -- Who asks. Each check sets the caller for the rest of the transaction.
    CREATE TEMP TABLE callers (name TEXT PRIMARY KEY, user_id UUID, role TEXT) ON COMMIT DROP;
    INSERT INTO callers VALUES
        ('nobody', NULL, 'anon'), ('service role', NULL, 'service_role'), ('service account', v_service, 'authenticated'),
        ('ada', v_ada, 'authenticated'), ('bob', v_bob, 'authenticated'), ('cy', v_cy, 'authenticated'), ('eve', v_eve, 'authenticated');

    CREATE TEMP TABLE expected (caller TEXT, scope TEXT, sees BOOLEAN) ON COMMIT DROP;
    INSERT INTO expected VALUES
        ('nobody', 'run', FALSE), ('nobody', 'batch', FALSE),
        ('service role', 'run', TRUE), ('service role', 'batch', TRUE),
        ('service account', 'run', TRUE), ('service account', 'batch', FALSE),
        ('ada', 'run', TRUE), ('ada', 'batch', FALSE),
        ('bob', 'run', FALSE), ('bob', 'batch', TRUE),
        ('cy', 'run', FALSE), ('cy', 'batch', FALSE),
        ('eve', 'run', FALSE), ('eve', 'batch', FALSE);

    DECLARE
        r RECORD;
        v_got UUID;
        v_scope UUID;
    BEGIN
        FOR r IN SELECT e.*, c.user_id, c.role FROM expected e JOIN callers c ON c.name = e.caller LOOP
            PERFORM set_config('request.jwt.claim.sub', COALESCE(r.user_id::TEXT, ''), TRUE);
            PERFORM set_config('request.jwt.claim.role', r.role, TRUE);
            PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r.user_id, 'role', r.role)::TEXT, TRUE);
            v_scope := CASE r.scope WHEN 'run' THEN v_run_scope ELSE v_batch_scope END;
            v_got := entity_instances.scope_for_caller(v_scope);
            IF (v_got IS NOT NULL) <> r.sees OR (v_got IS NOT NULL AND v_got <> v_scope) THEN
                RAISE EXCEPTION '% asking for the % scope: expected %, got %', r.caller, r.scope,
                    CASE WHEN r.sees THEN 'the scope' ELSE 'null' END, COALESCE(v_got::TEXT, 'null');
            END IF;
        END LOOP;
        RAISE NOTICE 'ok: a run scope goes to its service account and reviewers, a batch scope to who staged it, and to no one else';

        -- Ada may read the run scope. Not once it has closed, expired, or with no scope at all.
        PERFORM set_config('request.jwt.claim.sub', v_ada::TEXT, TRUE);
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_ada, 'role', 'authenticated')::TEXT, TRUE);
        IF entity_instances.scope_for_caller(NULL) IS NOT NULL THEN RAISE EXCEPTION 'no scope gave a scope'; END IF;
        IF entity_instances.scope_for_caller(gen_random_uuid()) IS NOT NULL THEN RAISE EXCEPTION 'an unknown scope gave a scope'; END IF;
        UPDATE entity_instances.provisional_scopes SET expires_at = NOW() - INTERVAL '1 second' WHERE id = v_run_scope;
        IF entity_instances.scope_for_caller(v_run_scope) IS NOT NULL THEN RAISE EXCEPTION 'an expired scope was handed out'; END IF;
        UPDATE entity_instances.provisional_scopes SET expires_at = NOW() + INTERVAL '1 day', status = 'RESOLVED' WHERE id = v_run_scope;
        IF entity_instances.scope_for_caller(v_run_scope) IS NOT NULL THEN RAISE EXCEPTION 'a resolved scope was handed out'; END IF;
        RAISE NOTICE 'ok: no scope, an unknown, expired or resolved scope all mean live data only';
    END;

    -- A held record must say what it is assumed to be. Other records carry none of it.
    PERFORM set_config('request.jwt.claims', '{"role": "service_role"}', TRUE);
    DECLARE
        v_batch UUID;
        v_failed BOOLEAN;
    BEGIN
        SELECT id INTO v_batch FROM entity_instances.load_batches WHERE scope_id = v_batch_scope;
        INSERT INTO entity_instances.load_batch_records (batch_id, domain_code, file_code, action, provisional_entity_id, assumed_action)
        VALUES (v_batch, 'ISSUER', 'ACME-2', 'PROVISIONAL', gen_random_uuid(), 'create');
        BEGIN
            v_failed := FALSE;
            INSERT INTO entity_instances.load_batch_records (batch_id, domain_code, file_code, action, provisional_entity_id, assumed_action)
            VALUES (v_batch, 'ISSUER', 'ACME-3', 'PROVISIONAL', gen_random_uuid(), 'map');
        EXCEPTION WHEN check_violation THEN v_failed := TRUE;
        END;
        IF NOT v_failed THEN RAISE EXCEPTION 'a map assumption with no record was accepted'; END IF;
        BEGIN
            v_failed := FALSE;
            INSERT INTO entity_instances.load_batch_records (batch_id, domain_code, file_code, action, assumed_action)
            VALUES (v_batch, 'ISSUER', 'ACME-4', 'CREATE', 'create');
        EXCEPTION WHEN check_violation THEN v_failed := TRUE;
        END;
        IF NOT v_failed THEN RAISE EXCEPTION 'a record that is not held carried an assumption'; END IF;
        RAISE NOTICE 'ok: held records carry an assumption, and only held records do';
    END;
END $$;
ROLLBACK;
