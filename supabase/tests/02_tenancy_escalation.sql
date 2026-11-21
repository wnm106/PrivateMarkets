-- Crossing from one client into another through the tenancy tables and helpers:
-- self-promotion, deactivation, roles and grants across clients, support mode.
-- Then the legitimate paths: staff with a second factor, clients that require
-- one, the worker's job sessions, a workflow service account, suspension.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('02_tenancy_escalation');

-- ---------------------------------------------------------------- T1 self-promotion
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('T1 A analyst cannot set is_tenant_admin on own profile',
    $$UPDATE tenancy.profiles SET is_tenant_admin = TRUE WHERE id = auth.uid()$$, '42501');
SELECT tests.expect_error('T1 A analyst cannot set is_active on own profile',
    $$UPDATE tenancy.profiles SET is_active = FALSE WHERE id = auth.uid()$$, '42501');
SELECT tests.expect_value('T1 A analyst is not staff', $$SELECT tenancy.is_tenant_admin()$$, 'false');
SELECT tests.expect_error('T1/T7d A analyst cannot start support mode for client B',
    $$SELECT tenancy.start_impersonation('bbbbbbbb-0000-0000-0000-000000000001', 'self-escalated')$$, '42501');
SELECT tests.expect_rows('T1 A analyst updates no B record',
    $$UPDATE entity_instances.master_entities SET entity_name = entity_name || ' (pwned)'
      WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1' RETURNING 1$$, 0);
SELECT tests.expect_denied('T1 A analyst cannot rename the shared NAV attribute',
    $$UPDATE metadata_register.attribute_register SET attribute_name = attribute_name || ' (pwned)'
      WHERE attribute_code = 'NAV' RETURNING 1$$);
SELECT tests.expect_rows('A analyst may change own display name',
    $$UPDATE tenancy.profiles SET display_name = 'Analyst A' WHERE id = auth.uid() RETURNING 1$$, 1);
SELECT tests.expect_error('A user cannot insert a staff profile',
    $$INSERT INTO tenancy.profiles (id, display_name, is_tenant_admin) VALUES (gen_random_uuid(), 'x', TRUE)$$);

-- ---------------------------------------------------------------- T7c joining another client
SELECT tests.expect_error('T7c A analyst cannot add self to client B',
    $$INSERT INTO tenancy.client_users (client_id, user_id) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', auth.uid())$$);
SELECT tests.expect_error('T7c A analyst cannot grant self CLIENT_ADMIN in client A',
    $$INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
      SELECT 'aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), id FROM tenancy.roles
      WHERE role_code = 'CLIENT_ADMIN' AND client_id IS NULL$$);

-- ---------------------------------------------------------------- T5 deactivated member
SELECT tests.owner();
UPDATE tenancy.client_users SET is_active = FALSE WHERE user_id = 'a0000000-0000-0000-0000-00000000000c';
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_rows('T5 deactivated A admin has no active client',
    $$SELECT 1 FROM tenancy.current_client_ids()$$, 0);
SELECT tests.expect_value('T5 deactivated A admin loses user.manage',
    $$SELECT tenancy.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'user.manage')$$, 'false');
SELECT tests.expect_value('T5 deactivated A admin loses entity_access.manage',
    $$SELECT tenancy.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'entity_access.manage')$$, 'false');
SELECT tests.expect_denied('T5 deactivated A admin cannot reactivate self',
    $$UPDATE tenancy.client_users SET is_active = TRUE WHERE user_id = auth.uid() RETURNING 1$$);
SELECT tests.expect_rows('T5 deactivated A admin reads no record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.owner();
UPDATE tenancy.client_users SET is_active = TRUE WHERE user_id = 'a0000000-0000-0000-0000-00000000000c';

-- ---------------------------------------------------------------- T5b inactive profile, inactive client
UPDATE tenancy.profiles SET is_active = FALSE WHERE id = 'b0000000-0000-0000-0000-00000000000a';
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T5b B analyst with an inactive profile reads no record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.owner();
UPDATE tenancy.profiles SET is_active = TRUE WHERE id = 'b0000000-0000-0000-0000-00000000000a';
UPDATE tenancy.clients SET is_active = FALSE WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T5b member of a suspended client reads no record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.owner();
UPDATE tenancy.clients SET is_active = TRUE WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T5b member of a reactivated client reads its records again',
    $$SELECT 1 FROM entity_instances.master_entities$$, 3);

-- ---------------------------------------------------------------- T6 grants on another client's record
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('T6 A admin cannot file a grant on a B record',
    $$INSERT INTO tenancy.entity_grants (client_id, entity_id, grantee_type, user_id, access_level, include_children)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'USER',
              'a0000000-0000-0000-0000-00000000000c', 'READ', TRUE)$$);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T6 B analyst still reads B-FUND-1',
    $$SELECT 1 FROM entity_instances.master_entities WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 1);

-- ---------------------------------------------------------------- T7 another client's role
SELECT tests.owner();
INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT 'bbbbbbbb-0000-0000-0000-0000000000e1', id FROM tenancy.permissions WHERE permission_code IN ('client.manage', 'entity.write');
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_rows('T7 A admin cannot see the B custom role',
    $$SELECT 1 FROM tenancy.roles WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000e1'$$, 0);
SELECT tests.expect_error('T7 A admin cannot bind the B custom role inside client A',
    $$INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-0000000000e1')$$);
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('T7 A analyst gained no write permission',
    $$SELECT tenancy.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'entity.write')$$, 'false');

-- T7b: client.manage is the platform-staff permission.
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_ok('T7b A admin may create an A custom role',
    $$INSERT INTO tenancy.roles (id, client_id, role_code, role_name)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A_SUPER', 'A super')$$);
SELECT tests.expect_error('T7b A admin cannot give an A role client.manage',
    $$INSERT INTO tenancy.role_permissions (role_id, permission_id)
      SELECT 'aaaaaaaa-0000-0000-0000-0000000000e1', id FROM tenancy.permissions WHERE permission_code = 'client.manage'$$);

-- ---------------------------------------------------------------- staff and support mode
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal1');
SELECT tests.expect_value('Staff with a password only has no staff powers', $$SELECT tenancy.is_tenant_admin()$$, 'false');
SELECT tests.expect_error('Staff with a password only cannot start support mode',
    $$SELECT tenancy.start_impersonation('bbbbbbbb-0000-0000-0000-000000000001', 'ticket')$$, '42501');
SELECT tests.expect_value('Sign-in decision for staff says a second factor is required',
    $$SELECT (tenancy.current_sign_in_decision()) ->> 'mfa_required'$$, 'true');

SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Staff with a second factor has staff powers', $$SELECT tenancy.is_tenant_admin()$$, 'true');
SELECT tests.expect_ok('Staff with a second factor starts support mode for client B',
    $$SELECT tenancy.start_impersonation('bbbbbbbb-0000-0000-0000-000000000001', 'support ticket 1')$$);
SELECT tests.expect_value('Support mode scopes staff to client B only',
    $$SELECT string_agg(c::text, ',') FROM tenancy.current_client_ids() c$$, 'bbbbbbbb-0000-0000-0000-000000000001');
SELECT tests.expect_rows('Staff in support mode reads client B records',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 3);
SELECT tests.expect_rows('Staff in support mode for B reads no A record',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);

SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal1');
SELECT tests.expect_rows('Support mode stops counting when the session drops to a password only',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);

-- T16: an open session outlives neither expiry nor demotion.
SELECT tests.owner();
UPDATE tenancy.impersonation_sessions SET expires_at = now() - interval '1 minute'
WHERE admin_user_id = 'c0000000-0000-0000-0000-00000000000c' AND ended_at IS NULL;
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('T16 an expired support session is ignored',
    $$SELECT tenancy.active_impersonation_client_id()$$, NULL);
SELECT tests.expect_rows('T16 staff with an expired session reads no B record',
    $$SELECT 1 FROM entity_instances.master_entities WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);

SELECT tests.expect_ok('T16 staff starts a new support session',
    $$SELECT tenancy.start_impersonation('bbbbbbbb-0000-0000-0000-000000000001', 'support ticket 2')$$);
SELECT tests.owner();
UPDATE tenancy.profiles SET is_tenant_admin = FALSE, is_active = FALSE WHERE id = 'c0000000-0000-0000-0000-00000000000c';
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('T16 demoted staff is not staff', $$SELECT tenancy.is_tenant_admin()$$, 'false');
SELECT tests.expect_rows('T16 demoted staff is scoped to no client',
    $$SELECT 1 FROM tenancy.current_client_ids()$$, 0);
SELECT tests.expect_rows('T16 demoted staff reads no B record',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.expect_rows('T16 demoted staff reads no B membership',
    $$SELECT 1 FROM tenancy.client_users$$, 0);
SELECT tests.expect_rows('T16 demoted staff lists no B document',
    $$SELECT 1 FROM storage.objects WHERE bucket_id = 'documents'$$, 0);
SELECT tests.owner();
UPDATE tenancy.profiles SET is_tenant_admin = TRUE, is_active = TRUE WHERE id = 'c0000000-0000-0000-0000-00000000000c';

-- ---------------------------------------------------------------- a client that requires a second factor
INSERT INTO tenancy.client_auth_requirements (client_id, mfa_required)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', TRUE)
ON CONFLICT (client_id) DO UPDATE SET mfa_required = TRUE;

SELECT tests.login('b0000000-0000-0000-0000-00000000000a', 'aal1');
SELECT tests.expect_rows('MFA client: member with a password only reads nothing',
    $$SELECT 1 FROM entity_instances.master_entities$$, 0);
SELECT tests.expect_value('MFA client: sign-in decision says a second factor is required',
    $$SELECT (tenancy.current_sign_in_decision()) ->> 'mfa_required'$$, 'true');
SELECT tests.login('b0000000-0000-0000-0000-00000000000a', 'aal2');
SELECT tests.expect_rows('MFA client: member with aal2 reads its records',
    $$SELECT 1 FROM entity_instances.master_entities$$, 3);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a', 'aal1',
    '{"amr":[{"method":"password"},{"method":"totp"}]}');
SELECT tests.expect_rows('MFA client: member whose amr shows TOTP reads its records',
    $$SELECT 1 FROM entity_instances.master_entities$$, 3);

-- The worker's job session for a member of that client. The worker (service
-- role) calls public.job_run_* functions, which call ops.assume_user as owner.
SELECT tests.service();
SELECT tests.expect_ok('Worker runs a job as a B member of an MFA client',
    $$SELECT public.job_run_stale_scan('b0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000001', 30, NULL)$$);
SELECT tests.owner();
SELECT tests.expect_ok('ops.assume_user opens a job session for a B member',
    $$SELECT ops.assume_user('b0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000001')$$);
SELECT ops.assume_user('b0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000001');
SELECT tests.expect_value('The job session counts as having a second factor', $$SELECT tenancy.session_has_mfa()$$, 'true');
SELECT tests.expect_value('The job session is scoped to client B',
    $$SELECT string_agg(c::text, ',') FROM tenancy.current_client_ids() c$$, 'bbbbbbbb-0000-0000-0000-000000000001');
SELECT tests.service();
SELECT tests.expect_error('The service role cannot call ops.assume_user directly',
    $$SELECT ops.assume_user('b0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A signed-in user cannot open a job session',
    $$SELECT ops.assume_user('b0000000-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000001')$$);

-- The client's workflow service account is not a person and is exempt.
SELECT tests.owner();
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
VALUES ('5e000000-0000-0000-0000-00000000000b', 'workflow-b@svc.internal', 'authenticated', 'authenticated', '{}', '{}', now());
INSERT INTO tenancy.client_users (client_id, user_id) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-00000000000b');
INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
SELECT 'bbbbbbbb-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-00000000000b', id
FROM tenancy.roles WHERE role_code = 'WORKFLOW_SERVICE' AND client_id IS NULL;
INSERT INTO ops.workflow_service_accounts (client_id, user_id) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-00000000000b');
SELECT tests.login('5e000000-0000-0000-0000-00000000000b', 'aal1');
SELECT tests.expect_rows('MFA client: its workflow service account (aal1) reads its records',
    $$SELECT 1 FROM entity_instances.master_entities$$, 3);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
