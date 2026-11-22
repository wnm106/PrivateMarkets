-- Platform tables with no client column, the job queue, and the worker's
-- "as this person" record check.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('11_platform_tables_and_jobs');

-- ---------------------------------------------------------------- platform tables
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_denied('Client admin reads no vendor connection (auth_config)',
    $$SELECT 1 FROM entity_instances.data_connections$$);
SELECT tests.expect_denied('Client admin reads no data loader',
    $$SELECT 1 FROM entity_instances.data_loaders$$);
SELECT tests.expect_denied('Client admin reads no feed lineage',
    $$SELECT 1 FROM entity_instances.feed_lineage$$);
SELECT tests.expect_denied('Client admin reads no import map made by someone else',
    $$SELECT 1 FROM entity_instances.import_maps WHERE created_by::text IS DISTINCT FROM auth.uid()::text$$);
SELECT tests.expect_denied('Client admin reads no import execution run by someone else',
    $$SELECT 1 FROM entity_instances.import_executions WHERE created_by::text IS DISTINCT FROM auth.uid()::text$$);

-- ---------------------------------------------------------------- the job queue
-- Client B's real job, queued by the worker under a system key.
SELECT tests.service();
CREATE TEMP TABLE b_job ON COMMIT DROP AS
SELECT public.job_enqueue('bbbbbbbb-0000-0000-0000-000000000001', 'dq_scan', '{}'::jsonb, NULL, 'document:bravo-1') AS id;
GRANT SELECT ON b_job TO authenticated;
SELECT tests.check('The worker queued a client B job', (SELECT id FROM b_job) IS NOT NULL);

SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('A admin cannot queue a job for client B',
    $$SELECT public.job_enqueue('bbbbbbbb-0000-0000-0000-000000000001', 'dq_scan')$$, '42501');
SELECT tests.expect_value('A admin queuing under B''s key gets its own run, not B''s',
    $$SELECT (public.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'dq_scan', '{}'::jsonb,
                                now() + interval '30 days', 'document:bravo-1') IS DISTINCT FROM (SELECT id FROM b_job))::text$$, 'true');
SELECT tests.expect_denied('A admin reads no client B job (table)',
    $$SELECT 1 FROM ops.job_runs WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$);
SELECT tests.expect_denied('A admin lists no client B job (job_runs_list)',
    $$SELECT * FROM public.job_runs_list('bbbbbbbb-0000-0000-0000-000000000001') AS r
      WHERE r::text LIKE '%' || (SELECT id FROM b_job)::text || '%'$$);
SELECT tests.expect_denied('A admin cannot read the client B job (job_run_get)',
    $$SELECT 1 WHERE public.job_run_get((SELECT id FROM b_job)) IS NOT NULL$$);
SELECT tests.expect_denied('A admin cannot cancel the client B job',
    $$SELECT 1 WHERE public.job_run_cancel((SELECT id FROM b_job))$$);
SELECT tests.owner();
SELECT tests.expect_value('Client B''s job is still queued, to run now',
    $$SELECT status || ' ' || (run_after <= now())::text FROM ops.job_runs WHERE id = (SELECT id FROM b_job)$$, 'QUEUED true');
SELECT tests.expect_value('The A admin''s key was filed under client A',
    $$SELECT dedupe_key FROM ops.job_runs WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND dedupe_key LIKE '%bravo-1'$$,
    'client:aaaaaaaa-0000-0000-0000-000000000001:document:bravo-1');

-- ---------------------------------------------------------------- the worker's record check
SELECT tests.service();
SELECT tests.expect_value('Worker: an A person may not touch a B record',
    $$SELECT public.workflow_worker_entity_access('a0000000-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
        'WRITE', ARRAY['bbbbbbbb-0000-0000-0000-0000000000f1']::uuid[], NULL) ->> 'denied'$$, '1');
SELECT tests.expect_value('Worker: B codes are not looked up for client A',
    $$SELECT public.workflow_worker_entity_access('a0000000-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
        'READ', NULL, ARRAY['B-FUND-1']) ->> 'denied'$$, '0');
SELECT tests.expect_value('Worker: an A steward may write an A record',
    $$SELECT public.workflow_worker_entity_access('a0000000-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
        'WRITE', ARRAY['aaaaaaaa-0000-0000-0000-0000000000f1']::uuid[], ARRAY['A-FUND-2']) ->> 'denied'$$, '0');
SELECT tests.expect_value('Worker: an A analyst may not write an A record',
    $$SELECT public.workflow_worker_entity_access('a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001',
        'WRITE', ARRAY['aaaaaaaa-0000-0000-0000-0000000000f1']::uuid[], NULL) ->> 'denied'$$, '1');
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('A signed-in user cannot call the worker''s record check',
    $$SELECT public.workflow_worker_entity_access(auth.uid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'READ', NULL, NULL)$$, '42501');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
