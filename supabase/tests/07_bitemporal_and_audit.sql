-- The golden ledger answers "what was the value on a date" and "what did we
-- know on a date". golden_master.write_value keeps both; API callers cannot
-- rewrite or delete history, or sign a row as someone else. Access changes are
-- logged, append-only.
--
-- Everything runs in one transaction, so now() is one instant: rows ended by a
-- write have system_to = now(). "Current knowledge" is the open rows
-- (system_to = 9999-12-31 23:59:59+00); "as known before the edits" is a
-- timestamp just before this transaction, after the fixture was written.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('07_bitemporal_and_audit');

SELECT tests.owner();
CREATE TEMP VIEW nav_rows AS
SELECT v.golden_value AS v, v.valid_from AS f, v.valid_to AS t, v.system_from AS sf, v.system_to AS st, v.created_by
FROM golden_master.entity_attribute_values v
WHERE v.entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
  AND v.attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV');
GRANT SELECT ON nav_rows TO authenticated;

-- NAV value of A-FUND-1 on a date: current knowledge, and as known before the edits.
CREATE FUNCTION pg_temp.nav_now(p_date date) RETURNS text LANGUAGE sql AS $$
    SELECT v FROM nav_rows WHERE f <= p_date AND t >= p_date AND st = '9999-12-31 23:59:59+00' ORDER BY f DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.nav_before(p_date date) RETURNS text LANGUAGE sql AS $$
    SELECT v FROM nav_rows
    WHERE f <= p_date AND t >= p_date
      AND sf <= now() - interval '1 millisecond' AND st >= now() - interval '1 millisecond'
    ORDER BY f DESC LIMIT 1
$$;

SELECT tests.expect_value('Fixture: A-FUND-1 NAV is 111 today', $$SELECT pg_temp.nav_now(CURRENT_DATE)$$, '111');
SELECT tests.check('Fixture rows were written before this transaction',
    (SELECT max(sf) FROM nav_rows) < now() - interval '1 millisecond');

-- ---------------------------------------------------------------- 1. a forward edit
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('A steward writes NAV 120 from 2026-11-20',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-20',
        '{"golden_value":"120","golden_value_numeric":120,"is_manual_override":true}')$$);
SELECT tests.owner();
SELECT tests.expect_value('NAV on 2025-12-31 is still 111 (the earlier part was kept)', $$SELECT pg_temp.nav_now(DATE '2025-12-31')$$, '111');
SELECT tests.expect_value('NAV on 2026-12-01 is 120', $$SELECT pg_temp.nav_now(DATE '2026-12-01')$$, '120');
SELECT tests.expect_value('NAV on 2026-12-01 as known before the edit is 111', $$SELECT pg_temp.nav_before(DATE '2026-12-01')$$, '111');

-- ---------------------------------------------------------------- 2. a backdated correction
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('A steward writes NAV 90 from 2025-06-01, no end date',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2025-06-01',
        '{"golden_value":"90","golden_value_numeric":90}')$$);
SELECT tests.owner();
SELECT tests.expect_value('Current timeline after the correction',
    $$SELECT string_agg(d || '=' || COALESCE(pg_temp.nav_now(d::date), '-'), ' ' ORDER BY d)
      FROM unnest(ARRAY['2020-06-01', '2025-05-31', '2025-06-01', '2026-11-19', '2026-11-20', '2027-01-01']) d$$,
    '2020-06-01=111 2025-05-31=111 2025-06-01=90 2026-11-19=90 2026-11-20=120 2027-01-01=120');
SELECT tests.expect_rows('Current rows do not overlap',
    $$SELECT 1 FROM nav_rows a JOIN nav_rows b ON a.f < b.f AND a.t >= b.f
      WHERE a.st = '9999-12-31 23:59:59+00' AND b.st = '9999-12-31 23:59:59+00'$$, 0);
SELECT tests.expect_rows('No row runs backwards in valid or system time',
    $$SELECT 1 FROM nav_rows WHERE f > t OR sf > st$$, 0);
SELECT tests.expect_value('As known before the edits, 2026-06-01 was still 111', $$SELECT pg_temp.nav_before(DATE '2026-06-01')$$, '111');
SELECT tests.expect_rows('Rows written by the steward are signed by the steward',
    $$SELECT 1 FROM nav_rows WHERE sf = now() AND created_by IS DISTINCT FROM 'a0000000-0000-0000-0000-00000000000b'$$, 0);

-- ---------------------------------------------------------------- 3. history cannot be rewritten
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_denied('A steward cannot change a stored value in place',
    $$UPDATE golden_master.entity_attribute_values SET golden_value = '999'
      WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' RETURNING 1$$);
SELECT tests.expect_denied('A steward cannot move a current row''s end date',
    $$UPDATE golden_master.entity_attribute_values SET valid_to = DATE '2021-01-01'
      WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' AND system_to = '9999-12-31 23:59:59+00' RETURNING 1$$);
SELECT tests.expect_denied('A steward cannot reopen an ended row',
    $$UPDATE golden_master.entity_attribute_values SET system_to = '9999-12-31 23:59:59+00'
      WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' AND system_to < '9999-01-01' RETURNING 1$$);
SELECT tests.expect_denied('A steward cannot delete value history',
    $$DELETE FROM golden_master.entity_attribute_values WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' RETURNING 1$$);
SELECT tests.expect_denied('A steward cannot insert a row dated in past knowledge',
    $$INSERT INTO golden_master.entity_attribute_values
        (entity_id, attribute_id, source_id, golden_value, valid_from, precedence_rank, system_from, system_to)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'), (SELECT id FROM tests.ids WHERE name = 'MANUAL'),
              '5', DATE '2020-01-01', 1, TIMESTAMPTZ '2020-01-01', TIMESTAMPTZ '2020-12-31') RETURNING 1$$);
SELECT tests.expect_value('A spoofed created_by is replaced with the caller',
    $$INSERT INTO golden_master.entity_attribute_values
        (entity_id, attribute_id, source_id, golden_value, valid_from, precedence_rank, created_by)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'), (SELECT id FROM tests.ids WHERE name = 'INTERNAL'),
              '7', DATE '2026-01-01', 50, 'b0000000-0000-0000-0000-00000000000c')
      RETURNING created_by$$, 'a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_denied('A steward cannot delete a record that has history',
    $$DELETE FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1' RETURNING 1$$);

-- ---------------------------------------------------------------- 4. read-only users and other clients
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A analyst (read only) cannot write a value',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-21', '{"golden_value":"1"}')$$);
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('B steward cannot write a value on an A record',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-21', '{"golden_value":"1"}')$$);
SELECT tests.anon();
SELECT tests.expect_error('anon cannot write a value',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-21', '{"golden_value":"1"}')$$, '42501');

-- ---------------------------------------------------------------- 5. access changes are logged
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_ok('A admin makes the A analyst a steward',
    $$INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
      SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', id
      FROM tenancy.roles WHERE role_code = 'DATA_STEWARD' AND client_id IS NULL$$);
SELECT tests.expect_value('The role grant is in the access log, signed by the A admin',
    $$SELECT actor_user_id::text FROM tenancy.audit_log
      WHERE table_name = 'user_roles' AND operation = 'INSERT'
        AND new_row ->> 'user_id' = 'a0000000-0000-0000-0000-00000000000a'
      ORDER BY id DESC LIMIT 1$$, 'a0000000-0000-0000-0000-00000000000c');
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('A analyst (no user.manage) reads no access log entry',
    $$SELECT 1 FROM tenancy.audit_log$$, 0);
SELECT tests.login('b0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_rows('B admin reads no client A access log entry',
    $$SELECT 1 FROM tenancy.audit_log WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_denied('A admin cannot edit the access log',
    $$UPDATE tenancy.audit_log SET actor_user_id = NULL WHERE TRUE RETURNING 1$$);
SELECT tests.expect_denied('A admin cannot delete from the access log',
    $$DELETE FROM tenancy.audit_log WHERE TRUE RETURNING 1$$);
SELECT tests.service();
SELECT tests.expect_error('Even the service role cannot edit the access log',
    $$UPDATE tenancy.audit_log SET actor_user_id = NULL WHERE TRUE$$, '42501');
SELECT tests.expect_error('Even the service role cannot delete from the access log',
    $$DELETE FROM tenancy.audit_log WHERE TRUE$$, '42501');

-- Support mode is logged with the client being impersonated.
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_ok('Staff starts support mode for client B',
    $$SELECT tenancy.start_impersonation('bbbbbbbb-0000-0000-0000-000000000001', 'audit test')$$);
SELECT tests.owner();
SELECT tests.expect_rows('The support session is in the access log',
    $$SELECT 1 FROM tenancy.audit_log WHERE table_name = 'impersonation_sessions' AND operation = 'INSERT'
        AND actor_user_id = 'c0000000-0000-0000-0000-00000000000c' AND client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 1);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
