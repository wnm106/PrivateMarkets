-- Allowed networks (20261126150000_ip_allowlist): a client that lists
-- networks refuses its people from any other address; clients without a list,
-- and people outside the client, are unaffected.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('22_ip_allowlist');

-- ---------------------------------------------------------------- 1. no list: any address
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('Without a list, any address is allowed', $$SELECT tenancy.ip_refusal('198.51.100.7')$$, NULL);
SELECT tests.expect_value('Even an unreadable one', $$SELECT tenancy.ip_refusal(NULL)$$, NULL);

-- ---------------------------------------------------------------- 2. client A lists two networks
SELECT tests.owner();
INSERT INTO tenancy.client_auth_requirements (client_id, allowed_ip_ranges)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', ARRAY['203.0.113.0/24', '2001:db8::/32']::cidr[])
ON CONFLICT (client_id) DO UPDATE SET allowed_ip_ranges = EXCLUDED.allowed_ip_ranges;

SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('An address inside the network is allowed', $$SELECT tenancy.ip_refusal('203.0.113.45')$$, NULL);
SELECT tests.expect_value('An IPv6 address inside the network is allowed', $$SELECT tenancy.ip_refusal('2001:db8::1')$$, NULL);
SELECT tests.expect_value('Any other address is refused, and told why',
    $$SELECT tenancy.ip_refusal('198.51.100.7')$$,
    'Your organization allows access only from its own networks. This address (198.51.100.7) is not one of them.');
SELECT tests.check('An unreadable address is refused', (SELECT tenancy.ip_refusal('not an address') IS NOT NULL));
SELECT tests.check('A missing address is refused', (SELECT tenancy.ip_refusal(NULL) IS NOT NULL));
SELECT tests.check('The middleware''s call refuses the same way', (SELECT tenancy.check_request('198.51.100.7') IS NOT NULL));

SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', '{"session_id":"eeeeeeee-0000-0000-0000-0000000000aa"}');
SELECT tests.expect_value('An allowed request is recorded as activity', $$SELECT tenancy.check_request('203.0.113.45')$$, NULL);
SELECT tests.owner();
SELECT tests.expect_rows('Activity recorded for it',
    $$SELECT 1 FROM tenancy.session_activity WHERE session_id = 'eeeeeeee-0000-0000-0000-0000000000aa'$$, 1);

-- ---------------------------------------------------------------- 3. other people
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('Client B''s people are unaffected', $$SELECT tenancy.ip_refusal('198.51.100.7')$$, NULL);
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Staff outside the client are unaffected', $$SELECT tenancy.ip_refusal('198.51.100.7')$$, NULL);

-- ---------------------------------------------------------------- 4. the list is bounded and audited
SELECT tests.owner();
SELECT tests.expect_error('At most 50 networks',
    $$UPDATE tenancy.client_auth_requirements SET allowed_ip_ranges = (SELECT array_agg(('10.' || g || '.0.0/16')::cidr) FROM generate_series(1, 51) g)
      WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, '23514');
SELECT tests.expect_rows('Changing the list is in the audit log',
    $$SELECT 1 FROM tenancy.audit_log WHERE table_name = 'client_auth_requirements' AND client_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND new_row ? 'allowed_ip_ranges' AND occurred_at >= now()$$, 1);

-- ---------------------------------------------------------------- 5. grants
SELECT tests.check('Anonymous callers cannot ask', NOT has_function_privilege('anon', 'tenancy.ip_refusal(text)', 'EXECUTE'));
SELECT tests.check('Signed-in users can ask about themselves', has_function_privilege('authenticated', 'tenancy.ip_refusal(text)', 'EXECUTE'));

SELECT tests.done();
ROLLBACK;
