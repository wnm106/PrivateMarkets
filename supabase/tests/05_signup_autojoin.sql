-- Sign-up joins a client only on proof: a Microsoft sign-in from the client's
-- registered directory, or a confirmed address on the client's email domain.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('05_signup_autojoin');

SELECT tests.owner();
INSERT INTO tenancy.client_identity_providers (client_id, provider, azure_tenant_id, email_domain)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'AZURE', '11111111-2222-3333-4444-555555555555', 'bravo-corp.test');

-- T8 attacker 1: password sign-up with a "tid" typed into the sign-up metadata.
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
VALUES ('e0000000-0000-0000-0000-000000000001', 'mallory@evil.test', 'authenticated', 'authenticated',
        '{"tid":"11111111-2222-3333-4444-555555555555","full_name":"Mallory"}', '{"provider":"email"}', now());
SELECT tests.expect_rows('T8 a tid in sign-up metadata joins no client',
    $$SELECT 1 FROM tenancy.client_users WHERE user_id = 'e0000000-0000-0000-0000-000000000001'$$, 0);

-- T8 attacker 2: an unconfirmed address on client B's domain.
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
VALUES ('e0000000-0000-0000-0000-000000000002', 'not.really.staff@bravo-corp.test', 'authenticated', 'authenticated',
        '{}', '{"provider":"email"}', NULL);
SELECT tests.expect_rows('T8 an unconfirmed address on the client domain joins no client',
    $$SELECT 1 FROM tenancy.client_users WHERE user_id = 'e0000000-0000-0000-0000-000000000002'$$, 0);

-- Azure provider, but the issuer names a different directory.
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
VALUES ('e0000000-0000-0000-0000-000000000003', 'x@other.test', 'authenticated', 'authenticated',
        '{"tid":"11111111-2222-3333-4444-555555555555","iss":"https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0"}',
        '{"provider":"azure"}', now());
SELECT tests.expect_rows('T8 an Azure sign-in whose issuer names another directory joins no client',
    $$SELECT 1 FROM tenancy.client_users WHERE user_id = 'e0000000-0000-0000-0000-000000000003'$$, 0);

SELECT tests.login('e0000000-0000-0000-0000-000000000001');
SELECT tests.expect_rows('T8 attacker 1 reads no B record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.expect_rows('T8 attacker 1 reads no B golden value',
    $$SELECT 1 FROM golden_master.entity_attribute_values$$, 0);
SELECT tests.expect_error('A signed-in user cannot call the auto-join helper',
    $$SELECT tenancy.auto_join_client(auth.uid(), 'x@bravo-corp.test', TRUE, '{}'::jsonb, '{}'::jsonb)$$, '42501');

-- ---------------------------------------------------------------- the legitimate joins
SELECT tests.owner();
UPDATE auth.users SET email_confirmed_at = now() WHERE id = 'e0000000-0000-0000-0000-000000000002';
SELECT tests.expect_value('Confirming the address on the client domain joins client B as VIEWER',
    $$SELECT r.role_code FROM tenancy.client_users cu
      JOIN tenancy.user_roles ur ON ur.user_id = cu.user_id AND ur.client_id = cu.client_id
      JOIN tenancy.roles r ON r.id = ur.role_id
      WHERE cu.user_id = 'e0000000-0000-0000-0000-000000000002' AND cu.client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 'VIEWER');

INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
VALUES ('e0000000-0000-0000-0000-000000000004', 'real.person@elsewhere.test', 'authenticated', 'authenticated',
        '{"tid":"11111111-2222-3333-4444-555555555555","iss":"https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0"}',
        '{"provider":"azure"}', now());
SELECT tests.expect_rows('An Azure sign-in from the registered directory joins client B',
    $$SELECT 1 FROM tenancy.client_users WHERE user_id = 'e0000000-0000-0000-0000-000000000004' AND client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 1);

SELECT tests.check('Every new user got a profile',
    (SELECT count(*) FROM tenancy.profiles WHERE id::text LIKE 'e0000000-%') = 4);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
