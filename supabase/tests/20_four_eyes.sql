-- Four eyes (20261126120000_four_eyes_approvals): for a client that requires
-- it, a manual value waits for someone else to approve it, nobody approves
-- their own, and workflow reviews always need a reviewer other than the
-- person who started the run. Without it, nothing changes.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('20_four_eyes');

SELECT tests.owner();
CREATE TEMP VIEW fe_nav AS
SELECT v.golden_value AS v, v.is_manual_override AS manual, v.created_by, v.system_to
FROM golden_master.entity_attribute_values v
WHERE v.entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
  AND v.attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV')
  AND v.system_to = '9999-12-31 23:59:59+00';
GRANT SELECT ON fe_nav TO authenticated;
CREATE TEMP TABLE fe_ids (name text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT, UPDATE ON fe_ids TO authenticated;

-- ---------------------------------------------------------------- 1. off: as before
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('Without four eyes a manual value is applied at once',
    $$SELECT golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-01',
        '{"golden_value":"200","golden_value_numeric":200,"is_manual_override":true,"override_reason":"Q3 pack"}') ->> 'status'$$,
    'APPLIED');

-- ---------------------------------------------------------------- 2. only staff turn it on
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('A client admin cannot turn four eyes off or on',
    $$SELECT tenancy.set_client_four_eyes('aaaaaaaa-0000-0000-0000-000000000001', TRUE)$$, '42501');
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Staff turn four eyes on for client A',
    $$SELECT tenancy.set_client_four_eyes('aaaaaaaa-0000-0000-0000-000000000001', TRUE)::text$$, 'true');

-- ---------------------------------------------------------------- 3. on: the ledger refuses, submit files a request
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('A steward cannot write a manual value straight to the ledger',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-10',
        '{"golden_value":"250","golden_value_numeric":250,"is_manual_override":true,"override_reason":"x"}')$$, 'FE001');
SELECT tests.expect_error('Nor by inserting the row directly',
    $$INSERT INTO golden_master.entity_attribute_values (entity_id, attribute_id, source_id, golden_value, valid_from, valid_to, is_manual_override, precedence_rank)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), '250', DATE '2026-11-10', DATE '9999-12-31', TRUE, 1)$$, 'FE001');
SELECT tests.expect_ok('A value from a system source is still written at once',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f2', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-10', '{"golden_value":"7","golden_value_numeric":7}')$$);
SELECT tests.expect_ok('Submitting files a request',
    $$INSERT INTO fe_ids SELECT 'request', (golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-10',
        '{"golden_value":"250","golden_value_numeric":250,"is_manual_override":true,"override_reason":"Administrator restated NAV"}') ->> 'requestId')::uuid$$);
SELECT tests.expect_value('The value in force is still the earlier one', $$SELECT v FROM fe_nav WHERE manual ORDER BY v DESC LIMIT 1$$, '200');
SELECT tests.expect_error('A request needs a reason',
    $$SELECT golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-10', '{"golden_value":"1","is_manual_override":true}')$$, '22023');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('An analyst cannot file a request on a record they cannot change',
    $$SELECT golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-10',
        '{"golden_value":"1","is_manual_override":true,"override_reason":"r"}')$$, '42501');

-- ---------------------------------------------------------------- 4. nobody approves their own
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('The steward sees why they cannot approve',
    $$SELECT r ->> 'blocker' FROM jsonb_array_elements(golden_master.override_requests_list('PENDING')) r
      WHERE (r ->> 'id')::uuid = (SELECT id FROM fe_ids WHERE name = 'request')$$,
    'You entered this value, so someone else has to approve it.');
SELECT tests.expect_error('The steward cannot approve their own value',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'request'), TRUE)$$, '42501');
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('An analyst cannot approve',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'request'), TRUE)$$, '42501');
SELECT tests.login('b0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_rows('Client B''s admin does not see client A''s request',
    $$SELECT 1 FROM jsonb_array_elements(golden_master.override_requests_list(NULL)) r WHERE (r ->> 'id')::uuid = (SELECT id FROM fe_ids WHERE name = 'request')$$, 0);
SELECT tests.expect_error('Client B''s admin cannot approve it',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'request'), TRUE)$$);

-- ---------------------------------------------------------------- 5. someone else approves
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_value('Client A''s admin may approve it',
    $$SELECT (r ->> 'canDecide') FROM jsonb_array_elements(golden_master.override_requests_list('PENDING')) r
      WHERE (r ->> 'id')::uuid = (SELECT id FROM fe_ids WHERE name = 'request')$$, 'true');
SELECT tests.expect_value('Approving writes the value',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'request'), TRUE, 'Checked against the pack') ->> 'status'$$, 'APPROVED');
SELECT tests.expect_value('The approved value is in force', $$SELECT v FROM fe_nav WHERE manual AND v = '250'$$, '250');
SELECT tests.expect_value('It is signed by the approver',
    $$SELECT created_by::text FROM fe_nav WHERE manual AND v = '250'$$, 'a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('A decided request cannot be decided again',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'request'), FALSE)$$, '42501');
SELECT tests.owner();
SELECT tests.expect_value('The request records who asked and who approved',
    $$SELECT requested_by::text || ' ' || decided_by::text || ' ' || (applied_value_id IS NOT NULL)::text
      FROM golden_master.override_requests WHERE id = (SELECT id FROM fe_ids WHERE name = 'request')$$,
    'a0000000-0000-0000-0000-00000000000b a0000000-0000-0000-0000-00000000000c true');
SELECT tests.expect_rows('The request is in the audit log',
    $$SELECT 1 FROM tenancy.audit_log WHERE table_name = 'override_requests' AND row_id = (SELECT id::text FROM fe_ids WHERE name = 'request') AND operation = 'UPDATE'$$, 1);

-- ---------------------------------------------------------------- 6. reject and withdraw
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('The steward files two more',
    $$INSERT INTO fe_ids SELECT n, (golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-15',
        jsonb_build_object('golden_value', n, 'is_manual_override', true, 'override_reason', 'r')) ->> 'requestId')::uuid
      FROM unnest(ARRAY['reject', 'withdraw']) n$$);
SELECT tests.expect_value('The steward withdraws one',
    $$SELECT golden_master.withdraw_override_request((SELECT id FROM fe_ids WHERE name = 'withdraw')) ->> 'status'$$, 'WITHDRAWN');
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('Only the person who entered it can withdraw it',
    $$SELECT golden_master.withdraw_override_request((SELECT id FROM fe_ids WHERE name = 'reject'))$$, '42501');
SELECT tests.expect_value('The admin rejects the other',
    $$SELECT golden_master.decide_override_request((SELECT id FROM fe_ids WHERE name = 'reject'), FALSE, 'Wrong period') ->> 'status'$$, 'REJECTED');
SELECT tests.expect_rows('Neither value was written', $$SELECT 1 FROM fe_nav WHERE v IN ('reject', 'withdraw')$$, 0);

-- ---------------------------------------------------------------- 7. write_value keeps the approved parts
-- A value on the manual source that is not itself a manual value, over part of
-- the approved one: write_value writes the approved value's earlier part again,
-- which is not a new value.
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('write_value keeps the earlier part of an approved manual value it replaces',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-12-15', '{"golden_value":"260","golden_value_numeric":260}')$$);
SELECT tests.expect_rows('The approved value still holds before that date',
    $$SELECT 1 FROM golden_master.entity_attribute_values WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
      AND attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV') AND golden_value = '250' AND is_manual_override
      AND system_to = '9999-12-31 23:59:59+00' AND valid_to = DATE '2026-12-14'$$, 1);
SELECT tests.expect_error('Re-inserting a manual value by hand is still refused',
    $$SELECT golden_master.reassert_value(e) FROM golden_master.entity_attribute_values e
      WHERE e.entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' AND e.golden_value = '250' AND e.is_manual_override LIMIT 1$$, 'FE001');

-- ---------------------------------------------------------------- 8. the platform service is not blocked
SELECT tests.service();
SELECT tests.expect_value('The service writes a manual value directly (a workflow applying its own approved review)',
    $$SELECT golden_master.submit_manual_override('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-12-01',
        '{"golden_value":"300","golden_value_numeric":300,"is_manual_override":true,"override_reason":"wf"}') ->> 'status'$$, 'APPLIED');

-- ---------------------------------------------------------------- 9. workflow reviews
SELECT tests.owner();
INSERT INTO ops.workflows (id, client_id, workflow_code, workflow_name)
    VALUES ('fe000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'FE_CHECK', 'Four eyes check');
INSERT INTO ops.workflow_versions (id, workflow_id, version, graph)
    VALUES ('fe000000-0000-0000-0000-000000000002', 'fe000000-0000-0000-0000-000000000001', 1, '{"nodes":[],"edges":[]}');
INSERT INTO ops.workflow_runs (id, client_id, workflow_id, version_id, version, status, started_by)
    VALUES ('fe000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001',
            'fe000000-0000-0000-0000-000000000002', 1, 'WAITING', 'a0000000-0000-0000-0000-00000000000c');
INSERT INTO ops.workflow_reviews (id, run_id, client_id, node_id, title, separate_reviewer)
    VALUES ('fe000000-0000-0000-0000-000000000004', 'fe000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'review', 'Review', FALSE);
SELECT tests.expect_value('A review in a four-eyes client always needs a separate reviewer',
    $$SELECT separate_reviewer::text FROM ops.workflow_reviews WHERE id = 'fe000000-0000-0000-0000-000000000004'$$, 'true');
SELECT tests.expect_value('And it cannot be turned off',
    $$UPDATE ops.workflow_reviews SET separate_reviewer = FALSE WHERE id = 'fe000000-0000-0000-0000-000000000004' RETURNING separate_reviewer::text$$, 'true');
INSERT INTO ops.workflow_reviews (id, run_id, client_id, node_id, title, separate_reviewer)
    VALUES ('fe000000-0000-0000-0000-000000000005', 'fe000000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'review-b', 'Review', FALSE);
SELECT tests.expect_value('A client without four eyes keeps the step''s setting',
    $$SELECT separate_reviewer::text FROM ops.workflow_reviews WHERE id = 'fe000000-0000-0000-0000-000000000005'$$, 'false');

-- ---------------------------------------------------------------- 10. grants
SELECT tests.check('Signed-in users cannot read requests directly', NOT has_table_privilege('authenticated', 'golden_master.override_requests', 'SELECT'));
SELECT tests.check('Anonymous callers cannot submit', NOT has_function_privilege('anon', 'golden_master.submit_manual_override(uuid, uuid, uuid, date, jsonb)', 'EXECUTE'));
SELECT tests.check('Signed-in users cannot write requests directly', NOT has_table_privilege('authenticated', 'golden_master.override_requests', 'INSERT'));

SELECT tests.done();
ROLLBACK;
