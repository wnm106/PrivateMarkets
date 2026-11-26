-- Session rules (20261126140000_session_rules): a client's time limit and
-- idle limit end a sign-in, "sign out everywhere" ends every earlier sign-in,
-- and each holds both for new tokens (evaluate_sign_in, the access-token hook)
-- and for every read of the client's data (client_session_ok).
--
-- A token's sign-in time is the amr timestamp in its claims; the tests set it.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('21_session_rules');

-- Claims for a sign-in that started p_ago before now, in session p_session.
CREATE FUNCTION pg_temp.signed_in(p_ago interval, p_session uuid DEFAULT 'eeeeeeee-0000-0000-0000-000000000001') RETURNS jsonb
LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'session_id', p_session,
        'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch FROM now() - p_ago))::bigint)),
        'email', 'a.steward@a.test')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.signed_in(interval, uuid) TO authenticated;

-- ---------------------------------------------------------------- 1. no rule: as before
SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '10 days'));
SELECT tests.expect_rows('Without a rule, a ten-day-old sign-in still reads its client''s records',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);

-- ---------------------------------------------------------------- 2. time limit
SELECT tests.owner();
UPDATE tenancy.client_auth_requirements SET max_session_minutes = 480 WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001';
INSERT INTO tenancy.client_auth_requirements (client_id, max_session_minutes)
    SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 480
    WHERE NOT EXISTS (SELECT 1 FROM tenancy.client_auth_requirements WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001');

SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '9 hours'));
SELECT tests.expect_rows('A sign-in past the 8-hour limit reads nothing of the client',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_value('The app is told why, and signs the browser out',
    $$SELECT (tenancy.current_sign_in_decision() ->> 'allowed') || ': ' || (tenancy.current_sign_in_decision() ->> 'reason')$$,
    'false: Your sign-in reached its limit of 8 hours. Sign in again.');
SELECT tests.owner();
SELECT tests.expect_value('The access-token hook gives it no new token',
    $$SELECT tenancy.custom_access_token_hook(jsonb_build_object(
        'user_id', 'a0000000-0000-0000-0000-00000000000b',
        'claims', pg_temp.signed_in(interval '9 hours'))) -> 'error' ->> 'http_code'$$, '403');
SELECT tests.expect_value('A fresh sign-in gets its token',
    $$SELECT (tenancy.custom_access_token_hook(jsonb_build_object(
        'user_id', 'a0000000-0000-0000-0000-00000000000b',
        'claims', pg_temp.signed_in(interval '0 seconds'))) ? 'claims')::text$$, 'true');

SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '1 hour'));
SELECT tests.expect_rows('A one-hour-old sign-in reads as before',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);

SELECT tests.login('b0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '9 hours', 'eeeeeeee-0000-0000-0000-00000000000b') || '{"email":"b.steward@b.test"}');
SELECT tests.expect_rows('Client A''s limit does not touch client B',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 1);

-- ---------------------------------------------------------------- 3. idle limit
SELECT tests.owner();
UPDATE tenancy.client_auth_requirements SET max_session_minutes = NULL, idle_timeout_minutes = 30
WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001';
INSERT INTO tenancy.session_activity (session_id, user_id, first_seen_at, last_seen_at) VALUES
    ('eeeeeeee-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', now() - interval '2 hours', now() - interval '45 minutes'),
    ('eeeeeeee-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000b', now() - interval '2 hours', now() - interval '10 minutes');

SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '2 hours', 'eeeeeeee-0000-0000-0000-000000000002'));
SELECT tests.expect_rows('A sign-in idle for 45 minutes against a 30-minute limit reads nothing',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_value('And is told why',
    $$SELECT tenancy.current_sign_in_decision() ->> 'reason'$$, 'You were signed out after 30 minutes without activity. Sign in again.');
SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '2 hours', 'eeeeeeee-0000-0000-0000-000000000003'));
SELECT tests.expect_rows('One active 10 minutes ago reads as before',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '2 hours', 'eeeeeeee-0000-0000-0000-000000000004'));
SELECT tests.expect_rows('A sign-in the web app never saw has no idle limit',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_ok('The web app records activity', $$SELECT tenancy.touch_session()$$);
SELECT tests.owner();
SELECT tests.expect_rows('Activity is recorded for that sign-in',
    $$SELECT 1 FROM tenancy.session_activity WHERE session_id = 'eeeeeeee-0000-0000-0000-000000000004' AND user_id = 'a0000000-0000-0000-0000-00000000000b'$$, 1);
UPDATE tenancy.client_auth_requirements SET idle_timeout_minutes = NULL WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- 4. sign out everywhere
SELECT tests.login('a0000000-0000-0000-0000-00000000000a', 'aal1', pg_temp.signed_in(interval '1 hour'));
SELECT tests.expect_error('An analyst cannot sign out a colleague',
    $$SELECT tenancy.sign_out_everywhere('a0000000-0000-0000-0000-00000000000b')$$, '42501');
SELECT tests.login('b0000000-0000-0000-0000-00000000000c', 'aal1', pg_temp.signed_in(interval '1 hour'));
SELECT tests.expect_error('Another client''s admin cannot sign them out',
    $$SELECT tenancy.sign_out_everywhere('a0000000-0000-0000-0000-00000000000b')$$, '42501');
SELECT tests.login('a0000000-0000-0000-0000-00000000000c', 'aal1', pg_temp.signed_in(interval '1 hour'));
SELECT tests.expect_ok('Their client admin signs them out everywhere',
    $$SELECT tenancy.sign_out_everywhere('a0000000-0000-0000-0000-00000000000b')$$);

SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', pg_temp.signed_in(interval '1 hour'));
SELECT tests.expect_rows('A token from before is refused at once',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_value('And told why', $$SELECT tenancy.current_sign_in_decision() ->> 'reason'$$, 'You were signed out everywhere. Sign in again.');
SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1',
    jsonb_build_object('session_id', 'eeeeeeee-0000-0000-0000-000000000009', 'email', 'a.steward@a.test',
        'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', ceil(extract(epoch FROM now())) + 1))));
SELECT tests.expect_rows('A sign-in after it works',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_ok('Anyone can sign themselves out everywhere', $$SELECT tenancy.sign_out_everywhere()$$);

SELECT tests.owner();
SELECT tests.expect_rows('Signing someone out is in the audit log',
    $$SELECT 1 FROM tenancy.audit_log WHERE table_name = 'session_revocations' AND row_id = 'a0000000-0000-0000-0000-00000000000b'$$, 2);

-- ---------------------------------------------------------------- 5. grants
SELECT tests.check('Signed-in users cannot read session activity', NOT has_table_privilege('authenticated', 'tenancy.session_activity', 'SELECT'));
SELECT tests.check('Signed-in users cannot write cut-offs directly', NOT has_table_privilege('authenticated', 'tenancy.session_revocations', 'INSERT'));
SELECT tests.check('Signed-in users cannot call the rule check directly', NOT has_function_privilege('authenticated', 'tenancy.session_rule_breach(uuid, jsonb, uuid)', 'EXECUTE'));

SELECT tests.done();
ROLLBACK;
