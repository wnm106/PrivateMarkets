-- A client's own words (20261124130000_client_aliases): a client's alias is
-- read by that client only and wins over a shared alias with the same words,
-- the name a client gives an entity type is one of its words, and the shared
-- lists are unchanged for everyone else.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('19_client_aliases');

-- A shared alias to replace, and a shared field alias on a field only client B owns.
SELECT tests.owner();
INSERT INTO metadata_register.domain_aliases (domain_code, alias_label, alias_code) VALUES
    ('ORDER', 'T19 Ticket', 'T19_TICKET');
INSERT INTO metadata_register.entity_name_aliases (domain_code, alias_label, alias_code) VALUES
    ('ORDER', 'T19 Ticket name', 'T19_TICKET_NAME');
INSERT INTO metadata_register.attribute_register (id, attribute_code, attribute_name, data_type, domain_code, client_id) VALUES
    ('19191919-0000-0000-0000-000000000001', 'T19_SHARED', 'Test shared field', 'STRING', 'FUND', NULL),
    ('19191919-0000-0000-0000-000000000002', 'T19_B_ONLY', 'Test client B field', 'STRING', 'FUND', 'bbbbbbbb-0000-0000-0000-000000000001');
INSERT INTO metadata_register.attribute_aliases (attribute_id, alias_label, alias_code, domain_code) VALUES
    ('19191919-0000-0000-0000-000000000001', 'T19 Shared Words', 'T19_SHARED_WORDS', 'FUND'),
    ('19191919-0000-0000-0000-000000000002', 'T19 B Words', 'T19_B_WORDS', 'FUND');

CREATE FUNCTION pg_temp.word_type(p_words jsonb, p_list text, p_phrase text) RETURNS text
LANGUAGE sql AS $$
    SELECT string_agg((e ->> 'domain_code') || CASE WHEN (e ->> 'client')::boolean THEN '*' ELSE '' END, ',' ORDER BY e ->> 'domain_code')
    FROM jsonb_array_elements(p_words -> p_list) AS e
    WHERE metadata_register.alias_phrase(e ->> 'alias_label') = metadata_register.alias_phrase(p_phrase);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.word_type(jsonb, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------- before any client word
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('The shared alias means its type',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'ORDER');
SELECT tests.expect_value('The session has no client names yet',
    $$SELECT (public.session_alias_words() -> 'labels')::text$$, '{}');
SELECT tests.expect_value('The alias views carry the client column',
    $$SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'client_id'
        AND table_name IN ('domain_aliases', 'entity_name_aliases', 'attribute_aliases')$$, '3');

-- ---------------------------------------------------------------- client A takes the word for another type
SELECT tests.expect_value('The steward adds the word for FUND',
    $$SELECT jsonb_array_length(public.add_client_domain_alias('FUND', ' t19 ticket ') -> 'aliases')::text$$,
    (SELECT (count(*) + 1)::text FROM metadata_register.domain_aliases WHERE domain_code = 'FUND' AND client_id IS NULL AND is_active));
SELECT tests.expect_value('For client A the word now means FUND only',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'FUND*');
SELECT tests.expect_value('And "<word> name" is the name of a FUND record',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'names', 'T19 Ticket name')$$, 'FUND*');
SELECT tests.expect_value('Adding the same word again keeps one alias',
    $$SELECT (SELECT count(*) FROM jsonb_array_elements(public.add_client_domain_alias('FUND', 'T19 TICKET') -> 'aliases') e WHERE (e ->> 'client')::boolean)::text$$, '1');
SELECT tests.expect_error('The word cannot also mean a second type for the client',
    $$SELECT public.add_client_domain_alias('ORDER', 'T19-Ticket')$$, '23505');
SELECT tests.expect_error('A word cannot be another type''s name',
    $$SELECT public.add_client_domain_alias('ORDER', (SELECT domain_name FROM metadata_register.domain_types WHERE domain_code = 'FUND'))$$, '23505');
SELECT tests.expect_error('A word needs a letter or a digit',
    $$SELECT public.add_client_domain_alias('FUND', ' -- ')$$, '22023');
SELECT tests.expect_error('An unknown type takes no word',
    $$SELECT public.add_client_domain_alias('NO_SUCH_TYPE', 'Thing')$$, 'P0002');

-- The name a client gives a type is one of its words, and the catalog name stays one.
SELECT tests.expect_value('The steward names FUND for client A',
    $$SELECT public.set_client_domain_label('FUND', 'T19 Sleeve') ->> 'display_name'$$, 'T19 Sleeve');
SELECT tests.expect_value('The client''s name is a word for the type',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Sleeve')$$, 'FUND*');
SELECT tests.expect_value('So is "<name> name"',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'names', 'T19 Sleeve name')$$, 'FUND*');
SELECT tests.expect_value('The catalog name still means the type',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', (SELECT domain_name FROM metadata_register.domain_types WHERE domain_code = 'FUND'))$$, 'FUND*');
SELECT tests.expect_value('The words carry the client''s names',
    $$SELECT public.session_alias_words() -> 'labels' ->> 'FUND'$$, 'T19 Sleeve');
SELECT tests.expect_error('A word cannot be what the client calls another type',
    $$SELECT public.add_client_domain_alias('ORDER', 't19 sleeve')$$, '23505');

-- Field aliases: client A reads the shared one, not the one on client B's field.
SELECT tests.expect_rows('Client A reads the shared field alias',
    $$SELECT 1 FROM jsonb_array_elements(public.session_alias_words() -> 'attributes') e WHERE e ->> 'alias_code' = 'T19_SHARED_WORDS'$$, 1);
SELECT tests.expect_rows('Client A does not read an alias of client B''s field',
    $$SELECT 1 FROM jsonb_array_elements(public.session_alias_words() -> 'attributes') e WHERE e ->> 'alias_code' = 'T19_B_WORDS'$$, 0);

-- Direct writes.
SELECT tests.expect_denied('The steward cannot write an alias for client B',
    $$INSERT INTO metadata_register.domain_aliases (domain_code, alias_label, alias_code, client_id)
      VALUES ('FUND', 'Leak', 'T19_LEAK', 'bbbbbbbb-0000-0000-0000-000000000001') RETURNING 1$$);
SELECT tests.expect_denied('The steward cannot write a shared alias',
    $$INSERT INTO metadata_register.domain_aliases (domain_code, alias_label, alias_code)
      VALUES ('FUND', 'Everyone', 'T19_EVERYONE') RETURNING 1$$);
SELECT tests.expect_denied('The steward cannot remove a shared alias',
    $$DELETE FROM metadata_register.domain_aliases WHERE alias_code = 'T19_TICKET' AND client_id IS NULL RETURNING 1$$);
SELECT tests.expect_value('Removing a shared alias through the function removes nothing',
    $$SELECT public.remove_client_domain_alias((SELECT id FROM metadata_register.domain_aliases WHERE alias_code = 'T19_TICKET' AND client_id IS NULL))$$, '0');

-- ---------------------------------------------------------------- the client A analyst
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('The analyst reads client A''s word',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'FUND*');
SELECT tests.expect_error('The analyst cannot add a word',
    $$SELECT public.add_client_domain_alias('FUND', 'T19 Other')$$, '42501');
SELECT tests.expect_error('The analyst cannot remove a word',
    $$SELECT public.remove_client_domain_alias((SELECT id FROM metadata_register.domain_aliases WHERE alias_code = 'T19_TICKET' AND client_id IS NOT NULL))$$, '42501');

-- ---------------------------------------------------------------- client B is untouched
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('For client B the word still means the shared type',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'ORDER');
SELECT tests.expect_value('And its name alias too',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'names', 'T19 Ticket name')$$, 'ORDER');
SELECT tests.expect_rows('Client B reads none of client A''s aliases',
    $$SELECT 1 FROM public.domain_aliases WHERE client_id IS NOT NULL$$, 0);
SELECT tests.expect_rows('Client B reads the alias of its own field',
    $$SELECT 1 FROM jsonb_array_elements(public.session_alias_words() -> 'attributes') e WHERE e ->> 'alias_code' = 'T19_B_WORDS'$$, 1);
SELECT tests.expect_value('Client B may use the same word for a type of its own choosing',
    $$SELECT (SELECT count(*) FROM jsonb_array_elements(public.add_client_domain_alias('ORDER', 'T19 Sleeve') -> 'aliases') e WHERE (e ->> 'client')::boolean)::text$$, '1');

-- ---------------------------------------------------------------- staff and server code
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Staff not simulating a client read the shared meaning',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'ORDER');
SELECT tests.expect_error('Staff cannot add a client word without simulating a client',
    $$SELECT public.add_client_domain_alias('FUND', 'T19 Other')$$, '42501');

SELECT tests.service();
SELECT tests.expect_value('Server code reads client A''s meaning when it names client A',
    $$SELECT pg_temp.word_type(metadata_register.alias_words('aaaaaaaa-0000-0000-0000-000000000001'), 'types', 'T19 Ticket')$$, 'FUND*');
SELECT tests.expect_value('And the shared meaning when it names no client',
    $$SELECT pg_temp.word_type(metadata_register.alias_words(NULL), 'types', 'T19 Ticket')$$, 'ORDER');
SELECT tests.expect_rows('Naming client A leaves out an alias of client B''s field',
    $$SELECT 1 FROM jsonb_array_elements(metadata_register.alias_words('aaaaaaaa-0000-0000-0000-000000000001') -> 'attributes') e WHERE e ->> 'alias_code' = 'T19_B_WORDS'$$, 0);
SELECT tests.expect_rows('Naming client B includes it',
    $$SELECT 1 FROM jsonb_array_elements(metadata_register.alias_words('bbbbbbbb-0000-0000-0000-000000000001') -> 'attributes') e WHERE e ->> 'alias_code' = 'T19_B_WORDS'$$, 1);

SELECT tests.anon();
SELECT tests.expect_denied('A signed-out caller reads no words',
    $$SELECT public.session_alias_words()$$);

-- ---------------------------------------------------------------- removing
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('The steward removes the client''s word',
    $$SELECT public.remove_client_domain_alias((SELECT id FROM metadata_register.domain_aliases WHERE alias_code = 'T19_TICKET' AND client_id IS NOT NULL))$$, '1');
SELECT tests.expect_value('The word means the shared type again',
    $$SELECT pg_temp.word_type(public.session_alias_words(), 'types', 'T19 Ticket')$$, 'ORDER');

SELECT tests.owner();
SELECT tests.check('The shared aliases are as they were',
    (SELECT count(*) FROM metadata_register.domain_aliases WHERE alias_code = 'T19_TICKET' AND client_id IS NULL) = 1
    AND (SELECT count(*) FROM metadata_register.entity_name_aliases WHERE alias_code = 'T19_TICKET_NAME' AND client_id IS NULL) = 1);
SELECT tests.done();
ROLLBACK;
