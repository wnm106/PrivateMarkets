-- See report-trigger.ts. Every check runs inside a transaction that is rolled back.
-- A stored report records an event, and a report trigger starts one run with that file.
BEGIN;
DO $$
DECLARE
    v_client UUID;
    v_workflow UUID;
    v_trigger UUID;
    v_file UUID;
    v_other UUID;
    v_events INT;
    v_result JSONB;
    v_payload JSONB;
    v_source UUID;
BEGIN
    SELECT id INTO v_source FROM entity_instances.source_registry WHERE source_code = 'INTERNAL';
    INSERT INTO tenancy.clients (client_code, client_name) VALUES ('TRIGGER_TEST', 'Trigger test') RETURNING id INTO v_client;
    INSERT INTO ops.workflows (client_id, workflow_code, workflow_name, is_active)
    VALUES (v_client, 'NAV_RECONCILIATION', 'NAV reconciliation', TRUE) RETURNING id INTO v_workflow;
    INSERT INTO ops.workflow_triggers (client_id, workflow_id, trigger_name, source, match, input, is_active, cursor_at, created_by)
    VALUES (v_client, v_workflow, 'Reports', 'REPORT', '{"entityNames": ["OHA SELECT"]}', '{"periodEnd": ""}', TRUE, NOW() - interval '1 minute', gen_random_uuid())
    RETURNING id INTO v_trigger;

    -- A file read some other way records nothing.
    INSERT INTO entity_instances.import_instances (client_id, source_id, map_code, file_name, source_base64, headers, parsed_rows, column_mappings, row_count, status, intake_method)
    VALUES (v_client, v_source, 'X', 'positions.csv', '', '[]', '[]', '{}', 0, 'READY', 'tabular');
    -- A filed report of another entity is recorded but does not fit the trigger.
    INSERT INTO entity_instances.import_instances (client_id, source_id, map_code, file_name, source_base64, headers, parsed_rows, column_mappings, row_count, status, intake_method, tables)
    VALUES (v_client, v_source, 'X', 'other-10q.pdf', '', '[]', '[]', '{}', 0, 'READY', 'financial_report',
            '[{"id":"report-about","rows":[{"Field":"Entity","Value":"Harbor Street BDC"},{"Field":"Form","Value":"10-Q"},{"Field":"Period end","Value":"2026-06-30"}]}]')
    RETURNING id INTO v_other;
    -- The report the trigger wants.
    INSERT INTO entity_instances.import_instances (client_id, source_id, map_code, file_name, source_base64, headers, parsed_rows, column_mappings, row_count, status, intake_method, tables)
    VALUES (v_client, v_source, 'X', 'oha-10q.pdf', '', '[]', '[]', '{}', 0, 'READY', 'financial_report',
            '[{"id":"report-about","rows":[{"Field":"Entity","Value":"T. Rowe Price OHA Select Private Credit Fund"},{"Field":"Form","Value":"10-Q"},{"Field":"Period end","Value":"2026-06-30"}]}]')
    RETURNING id INTO v_file;
    -- Read again as a report: no second event.
    UPDATE entity_instances.import_instances SET intake_method = 'financial_report', status = 'SUCCEEDED' WHERE id = v_file;

    SELECT count(*) INTO v_events FROM ops.activity_events WHERE client_id = v_client AND kind = 'REPORT_RECEIVED';
    IF v_events <> 2 THEN RAISE EXCEPTION 'expected 2 report events, got %', v_events; END IF;
    SELECT payload INTO v_payload FROM ops.activity_events WHERE subject_id = v_file;
    IF v_payload ->> 'entityName' <> 'T. Rowe Price OHA Select Private Credit Fund' OR v_payload ->> 'periodEnd' <> '2026-06-30' OR v_payload ->> 'form' <> '10-Q' THEN
        RAISE EXCEPTION 'event payload is wrong: %', v_payload;
    END IF;
    RAISE NOTICE 'ok: a stored report records one event with what it is; other files record none';

    v_result := public.job_run_workflow_triggers(NOW());
    IF (v_result ->> 'fired')::int <> 1 THEN RAISE EXCEPTION 'expected one run started: %', v_result; END IF;
    SELECT payload INTO v_payload FROM ops.job_runs WHERE dedupe_key = 'workflow-trigger:' || v_trigger::text;
    IF v_payload -> 'input' ->> 'importInstanceId' <> v_file::text THEN RAISE EXCEPTION 'the run was not given the report: %', v_payload; END IF;
    IF v_payload -> 'input' ->> 'periodEnd' <> '' OR v_payload -> 'input' -> 'trigger' ->> 'source' <> 'REPORT' THEN RAISE EXCEPTION 'input lost: %', v_payload; END IF;
    RAISE NOTICE 'ok: the trigger starts one run, given the report that fits as importInstanceId, with its own input kept';

    -- A second report waits while the first run is open.
    v_result := public.job_run_workflow_triggers(NOW());
    IF (v_result ->> 'fired')::int <> 0 THEN RAISE EXCEPTION 'a second run started while the first is open: %', v_result; END IF;
    RAISE NOTICE 'ok: nothing more starts while that run is open';
END $$;
ROLLBACK;
