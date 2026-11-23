-- A confirmed assistant change is recorded once, by the person who confirmed it.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('15_held_action_uses');

SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('An A steward records a confirmation for client A',
    $$INSERT INTO public.chat_held_action_uses (hold_id, user_id, client_id, tool)
      VALUES ('11111111-0000-0000-0000-000000000001', auth.uid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'create_entity')$$);
SELECT tests.expect_error('The same confirmation cannot be recorded twice',
    $$INSERT INTO public.chat_held_action_uses (hold_id, user_id, client_id, tool)
      VALUES ('11111111-0000-0000-0000-000000000001', auth.uid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'create_entity')$$, '23505');
SELECT tests.expect_error('Nor recorded for client B',
    $$INSERT INTO public.chat_held_action_uses (hold_id, user_id, client_id, tool)
      VALUES ('11111111-0000-0000-0000-000000000002', auth.uid(), 'bbbbbbbb-0000-0000-0000-000000000001', 'create_entity')$$, '42501');
SELECT tests.expect_error('Nor recorded as someone else',
    $$INSERT INTO public.chat_held_action_uses (hold_id, user_id, client_id, tool)
      VALUES ('11111111-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'create_entity')$$, '42501');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_denied('Another person does not see it',
    $$SELECT 1 FROM public.chat_held_action_uses$$);
SELECT tests.anon();
SELECT tests.expect_error('Anonymous callers cannot record one',
    $$INSERT INTO public.chat_held_action_uses (hold_id, user_id, client_id, tool)
      VALUES ('11111111-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001', 'x')$$, '42501');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
