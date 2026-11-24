-- One client per sign-in (20261123160000_session_client): a person in two
-- clients chooses one for a session, and that session then reads and writes
-- that client only. Another session of the same person is not narrowed.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('17_session_client');

-- The client A analyst and steward also join client B, and client B gets a
-- record with a code client A already uses.
SELECT tests.owner();
INSERT INTO tenancy.client_users (client_id, user_id) VALUES
    ('bbbbbbbb-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b');
INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
SELECT 'bbbbbbbb-0000-0000-0000-000000000001', v.u::uuid, r.id
FROM (VALUES
    ('a0000000-0000-0000-0000-00000000000a', 'ANALYST'),
    ('a0000000-0000-0000-0000-00000000000b', 'DATA_STEWARD')
) AS v(u, code)
JOIN tenancy.roles r ON r.role_code = v.code AND r.client_id IS NULL;
INSERT INTO entity_instances.master_entities (id, entity_code, domain_code, entity_name, client_id) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000f9', 'A-FUND-1', 'FUND', 'Bravo Twin Fund', 'bbbbbbbb-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- before a choice
SELECT tests.login('a0000000-0000-0000-0000-00000000000a', 'aal1', '{"session_id":"5e551000-0000-0000-0000-000000000001"}');
SELECT tests.expect_rows('A session that chose nothing works in both clients',
    $$SELECT 1 FROM tenancy.current_client_ids()$$, 2);
SELECT tests.expect_rows('It is offered both clients',
    $$SELECT 1 FROM tenancy.session_client_choices() WHERE NOT is_chosen$$, 2);
SELECT tests.expect_rows('A code both clients use matches two records',
    $$SELECT 1 FROM public.tap_entity_matches(ARRAY['A-FUND-1']) WHERE match_kind = 'CODE'$$, 2);
SELECT tests.expect_denied('The choices cannot be read from the table',
    $$SELECT 1 FROM tenancy.session_clients$$);
SELECT tests.expect_error('A choice cannot be written to the table',
    $$INSERT INTO tenancy.session_clients (session_id, user_id, client_id)
      VALUES ('5e551000-0000-0000-0000-000000000001', auth.uid(), 'aaaaaaaa-0000-0000-0000-000000000001')$$);
SELECT tests.expect_error('A client that does not exist cannot be chosen',
    $$SELECT tenancy.choose_session_client('dddddddd-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.expect_error('No client cannot be chosen',
    $$SELECT tenancy.choose_session_client(NULL)$$, '42501');

-- ---------------------------------------------------------------- after choosing client A
SELECT tests.expect_value('The person chooses client A',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_value('The session now works in client A only',
    $$SELECT string_agg(c::text, ',') FROM tenancy.current_client_ids() c$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_value('It is offered the chosen client only',
    $$SELECT string_agg(client_code || ':' || is_chosen::text, ',') FROM tenancy.session_client_choices()$$, 'CLIENT_A:true');
SELECT tests.expect_rows('It reads client A''s records',
    $$SELECT 1 FROM public.master_entities WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 2);
SELECT tests.expect_rows('It reads no record of client B',
    $$SELECT 1 FROM public.master_entities WHERE client_id = 'bbbbbbbb-0000-0000-0000-000000000001'$$, 0);
SELECT tests.expect_rows('It reads no value of client B',
    $$SELECT 1 FROM golden_master.entity_attribute_values WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 0);
SELECT tests.expect_value('It holds no permission in client B',
    $$SELECT tenancy.has_permission('bbbbbbbb-0000-0000-0000-000000000001', 'entity.read')$$, 'false');
SELECT tests.expect_value('It cannot open a client B record',
    $$SELECT tenancy.has_entity_access('bbbbbbbb-0000-0000-0000-0000000000f1', 'READ')$$, 'false');
SELECT tests.expect_value('The code both clients use now names client A''s record',
    $$SELECT string_agg(id::text, ',') FROM public.tap_entity_matches(ARRAY['A-FUND-1']) WHERE match_kind = 'CODE'$$,
    'aaaaaaaa-0000-0000-0000-0000000000f1');
SELECT tests.expect_value('Choosing the same client again changes nothing',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_error('The session cannot move to client B',
    $$SELECT tenancy.choose_session_client('bbbbbbbb-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.expect_denied('The session cannot drop its choice',
    $$DELETE FROM tenancy.session_clients WHERE TRUE RETURNING 1$$);
SELECT tests.expect_value('It still works in client A only',
    $$SELECT string_agg(c::text, ',') FROM tenancy.current_client_ids() c$$, 'aaaaaaaa-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- the same person's other sessions
SELECT tests.login('a0000000-0000-0000-0000-00000000000a', 'aal1', '{"session_id":"5e551000-0000-0000-0000-000000000002"}');
SELECT tests.expect_rows('Another sign-in of the same person still works in both clients',
    $$SELECT 1 FROM tenancy.current_client_ids()$$, 2);
SELECT tests.expect_value('It may choose client B for itself',
    $$SELECT tenancy.choose_session_client('bbbbbbbb-0000-0000-0000-000000000001')$$, 'bbbbbbbb-0000-0000-0000-000000000001');
SELECT tests.expect_value('The code both clients use names client B''s record there',
    $$SELECT string_agg(id::text, ',') FROM public.tap_entity_matches(ARRAY['A-FUND-1']) WHERE match_kind = 'CODE'$$,
    'bbbbbbbb-0000-0000-0000-0000000000f9');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('A token with no session id works in both clients',
    $$SELECT 1 FROM tenancy.current_client_ids()$$, 2);
SELECT tests.expect_error('A token with no session id cannot choose',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501');

-- ---------------------------------------------------------------- writes follow the choice
SELECT tests.login('a0000000-0000-0000-0000-00000000000b', 'aal1', '{"session_id":"5e551000-0000-0000-0000-000000000003"}');
SELECT tests.expect_value('Before a choice the steward may write in client B',
    $$SELECT tenancy.has_entity_access('bbbbbbbb-0000-0000-0000-0000000000f1', 'WRITE')$$, 'true');
SELECT tests.expect_value('The steward chooses client A',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_value('The session may still write in client A',
    $$SELECT tenancy.has_entity_access('aaaaaaaa-0000-0000-0000-0000000000f1', 'WRITE')$$, 'true');
SELECT tests.expect_value('The session may not write in client B',
    $$SELECT tenancy.has_entity_access('bbbbbbbb-0000-0000-0000-0000000000f1', 'WRITE')$$, 'false');
SELECT tests.expect_denied('The session cannot change a client B record',
    $$UPDATE entity_instances.master_entities SET description = 'reached' WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1' RETURNING 1$$);

-- ---------------------------------------------------------------- someone outside the client
SELECT tests.login('b0000000-0000-0000-0000-00000000000a', 'aal1', '{"session_id":"5e551000-0000-0000-0000-000000000004"}');
SELECT tests.expect_error('A client B analyst cannot choose client A',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.expect_value('The client B analyst is offered client B only',
    $$SELECT string_agg(client_code, ',') FROM tenancy.session_client_choices()$$, 'CLIENT_B');

SELECT tests.owner();
SELECT tests.check('Each session that chose has one row',
    (SELECT count(*) FROM tenancy.session_clients) = 3);
SELECT tests.done();
ROLLBACK;
