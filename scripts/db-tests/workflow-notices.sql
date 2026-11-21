-- Forms and screens in workflow runs tell the people who can act on them.
-- Run by scripts/db-tests/workflow-notices.ts against a database built from
-- supabase/migrations. Everything is rolled back; any failed check raises.
BEGIN;
DO $$
DECLARE
    v_client UUID := gen_random_uuid();
    v_ada UUID := gen_random_uuid();
    v_bob UUID := gen_random_uuid();
    v_role UUID;
    v_wf UUID;
    v_ver UUID;
    v_run UUID;
    v_stage JSONB;
    v_stage_id UUID;
    v_form UUID;
    v_outside UUID;
    v_n INTEGER;
    v_event ops.activity_events;
    v_due JSONB;
BEGIN
    INSERT INTO tenancy.clients (id, client_code, client_name) VALUES (v_client, 'NOTICE_TEST', 'Notice test');
    INSERT INTO auth.users (id, email) VALUES (v_ada, 'ada@example.test'), (v_bob, 'bob@example.test');
    INSERT INTO tenancy.profiles (id, display_name, is_active) VALUES (v_ada, 'Ada', TRUE), (v_bob, 'Bob', TRUE)
        ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = TRUE;
    INSERT INTO tenancy.client_users (client_id, user_id, is_active) VALUES (v_client, v_ada, TRUE), (v_client, v_bob, TRUE);
    INSERT INTO tenancy.roles (client_id, role_code, role_name) VALUES (v_client, 'WF_REVIEWER', 'Reviewer') RETURNING id INTO v_role;
    INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT v_role, id FROM tenancy.permissions WHERE permission_code = 'workflow.review';
    INSERT INTO tenancy.user_roles (client_id, user_id, role_id) VALUES (v_client, v_ada, v_role);

    INSERT INTO ops.workflows (client_id, workflow_code, workflow_name) VALUES (v_client, 'INTAKE', 'File intake') RETURNING id INTO v_wf;
    INSERT INTO ops.workflow_versions (workflow_id, version, graph) VALUES (v_wf, 1, '{"nodes":[],"edges":[]}') RETURNING id INTO v_ver;
    INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version, status, started_by)
        VALUES (v_client, v_wf, v_ver, 1, 'WAITING', v_bob) RETURNING id INTO v_run;

    -- A screen opens: the person who can review is told, the one who cannot is not.
    v_stage := public.workflow_worker_stage(v_run, 'map', '{"screen":"load.map","title":"Map the file","outcomes":["confirmed","abandoned"],"dueInHours":1}');
    v_stage_id := (v_stage ->> 'id')::uuid;
    SELECT * INTO v_event FROM ops.activity_events WHERE subject_id = v_stage_id AND kind = 'STAGE_ASSIGNED';
    IF NOT FOUND THEN RAISE EXCEPTION 'no STAGE_ASSIGNED notice'; END IF;
    IF v_event.recipients <> ARRAY[v_ada] THEN RAISE EXCEPTION 'wrong recipients %', v_event.recipients; END IF;
    IF v_event.payload ->> 'href' <> '/workflows/runs/' || v_run || '?decision=map' THEN RAISE EXCEPTION 'wrong link %', v_event.payload ->> 'href'; END IF;
    IF v_event.summary NOT LIKE 'Waiting for you: "Map the file" in File intake, due %' THEN RAISE EXCEPTION 'wrong summary %', v_event.summary; END IF;
    IF NOT EXISTS (SELECT 1 FROM ops.job_runs WHERE job_type = 'assistant.watch' AND requested_by = v_ada) THEN RAISE EXCEPTION 'briefing not queued'; END IF;
    SELECT count(*) INTO v_n FROM ops.assistant_pending(v_ada, v_client, 'IMMEDIATE') AS e WHERE e.id = v_event.id;
    IF v_n <> 1 THEN RAISE EXCEPTION 'briefing does not include the screen notice'; END IF;
    RAISE NOTICE 'ok: a screen opening tells who can act, with a link to the decision';

    -- Opening the same screen again writes nothing new.
    PERFORM public.workflow_worker_stage(v_run, 'map', '{"screen":"load.map","title":"Map the file","outcomes":["confirmed"]}');
    SELECT count(*) INTO v_n FROM ops.activity_events WHERE subject_id = v_stage_id;
    IF v_n <> 1 THEN RAISE EXCEPTION 'reopening wrote % notices', v_n; END IF;

    -- Handed back: told again, with the reason.
    UPDATE ops.workflow_stages SET status = 'DONE', outcome = 'confirmed', completed_by = v_ada, completed_at = NOW() WHERE id = v_stage_id;
    PERFORM public.workflow_worker_stage_return(v_stage_id, 'Choose the date these values are as of.');
    SELECT * INTO v_event FROM ops.activity_events WHERE subject_id = v_stage_id AND kind = 'STAGE_RETURNED';
    IF NOT FOUND OR v_event.summary <> 'Came back to you: "Map the file" in File intake. Choose the date these values are as of.' THEN RAISE EXCEPTION 'wrong returned notice %', v_event.summary; END IF;
    RAISE NOTICE 'ok: a screen handed back is announced with the reason';

    -- A form for the firm is announced; one sent outside is not.
    INSERT INTO ops.workflow_forms (run_id, client_id, node_id, title, fields, due_at)
        VALUES (v_run, v_client, 'ask', 'Confirm the period', '[{"key":"a"},{"key":"b"}]', NOW() + INTERVAL '1 hour') RETURNING id INTO v_form;
    INSERT INTO ops.workflow_forms (run_id, client_id, node_id, title, fields, external_email, due_at)
        VALUES (v_run, v_client, 'outside', 'Fee confirmation', '[]', 'admin@example.test', NOW() - INTERVAL '1 hour') RETURNING id INTO v_outside;
    SELECT * INTO v_event FROM ops.activity_events WHERE subject_id = v_form AND kind = 'FORM_ASSIGNED';
    IF NOT FOUND OR v_event.summary NOT LIKE 'Form waiting for you: "Confirm the period" in File intake, 2 questions, due %' THEN RAISE EXCEPTION 'wrong form notice %', v_event.summary; END IF;
    IF EXISTS (SELECT 1 FROM ops.activity_events WHERE subject_id = v_outside) THEN RAISE EXCEPTION 'an outside form was announced'; END IF;
    RAISE NOTICE 'ok: a form for the firm is announced, one sent outside is not';

    -- Overdue: told once each.
    UPDATE ops.workflow_forms SET due_at = NOW() - INTERVAL '5 minutes' WHERE id = v_form;
    UPDATE ops.workflow_stages SET due_at = NOW() - INTERVAL '5 minutes' WHERE id = v_stage_id;
    v_due := public.job_run_workflow_reviews_due(NOW());
    IF (v_due ->> 'overdueForms')::int <> 1 OR (v_due ->> 'overdueStages')::int <> 1 THEN RAISE EXCEPTION 'overdue counts %', v_due; END IF;
    IF NOT EXISTS (SELECT 1 FROM ops.activity_events WHERE subject_id = v_form AND kind = 'FORM_OVERDUE' AND summary LIKE 'Overdue form: "Confirm the period"%') THEN RAISE EXCEPTION 'no FORM_OVERDUE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM ops.activity_events WHERE subject_id = v_stage_id AND kind = 'STAGE_OVERDUE') THEN RAISE EXCEPTION 'no STAGE_OVERDUE'; END IF;
    v_due := public.job_run_workflow_reviews_due(NOW());
    IF (v_due ->> 'overdueForms')::int <> 0 OR (v_due ->> 'overdueStages')::int <> 0 THEN RAISE EXCEPTION 'told twice %', v_due; END IF;
    RAISE NOTICE 'ok: overdue forms and screens are chased once, outside forms are not';

    -- Answered: no longer news, in the briefing or by email and Slack.
    UPDATE ops.workflow_forms SET status = 'SUBMITTED', submitted_at = NOW() WHERE id = v_form;
    SELECT count(*) INTO v_n FROM ops.assistant_pending(v_ada, v_client, 'IMMEDIATE') AS e WHERE e.subject_id = v_form;
    IF v_n <> 0 THEN RAISE EXCEPTION 'an answered form is still in the briefing'; END IF;
    SELECT * INTO v_event FROM ops.activity_events WHERE subject_id = v_form AND kind = 'FORM_ASSIGNED';
    IF NOT COALESCE((public.job_run_notify_collect(v_event.id) ->> 'stale')::boolean, FALSE) THEN RAISE EXCEPTION 'an answered form would still be emailed'; END IF;
    SELECT * INTO v_event FROM ops.activity_events WHERE subject_id = v_stage_id AND kind = 'STAGE_ASSIGNED';
    IF (public.job_run_notify_collect(v_event.id) ->> 'stale') IS NOT NULL THEN RAISE EXCEPTION 'an open screen was treated as stale'; END IF;
    RAISE NOTICE 'ok: a finished form is dropped from the briefing and from email and Slack';

    -- A notice that cannot be written does not stop a screen opening.
    ALTER TABLE ops.activity_events ADD CONSTRAINT notice_test_block CHECK (kind <> 'STAGE_ASSIGNED') NOT VALID;
    PERFORM public.workflow_worker_stage(v_run, 'check', '{"screen":"load.quality","title":"Check the values","outcomes":["approved","discarded"]}');
    IF NOT EXISTS (SELECT 1 FROM ops.workflow_stages WHERE run_id = v_run AND node_id = 'check') THEN RAISE EXCEPTION 'the screen did not open'; END IF;
    RAISE NOTICE 'ok: a failed notice never stops the run';
END;
$$;
ROLLBACK;
