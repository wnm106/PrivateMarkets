-- What a client calls an entity type, and the fields it hides
-- (20261124120000_client_catalog_presentation): one client's name and hidden
-- fields show to that client's sessions only, the catalog itself is unchanged
-- and still writable, and only someone who may edit the client's schema can
-- change them.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('18_client_catalog');

-- Two shared fields on FUND to hide: one optional, one every record must have.
SELECT tests.owner();
INSERT INTO metadata_register.attribute_register (id, attribute_code, attribute_name, data_type, domain_code, is_required) VALUES
    ('18181818-0000-0000-0000-000000000001', 'T18_OPTIONAL', 'Test optional field', 'STRING', 'FUND', FALSE),
    ('18181818-0000-0000-0000-000000000002', 'T18_REQUIRED', 'Test required field', 'STRING', 'FUND', TRUE);

-- ---------------------------------------------------------------- before any setting
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('A person in one client works in that client',
    $$SELECT tenancy.presentation_client_id()$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_value('With no setting the type has its catalog name',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('With no setting the field is visible',
    $$SELECT is_visible::text || '/' || hidden_for_client::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'true/false');
SELECT tests.expect_value('The steward may change the client''s settings',
    $$SELECT public.client_catalog_settings('FUND') ->> 'can_edit'$$, 'true');

-- ---------------------------------------------------------------- client A names FUND and hides a field
SELECT tests.expect_value('The steward names the type for client A',
    $$SELECT public.set_client_domain_label('FUND', '  Portfolio ') ->> 'display_name'$$, 'Portfolio');
SELECT tests.expect_value('Client A now reads its own name, and the catalog name beside it',
    $$SELECT domain_name || '/' || (catalog_domain_name = (SELECT domain_name FROM metadata_register.domain_types WHERE domain_code = 'FUND'))::text
      FROM public.domain_types WHERE domain_code = 'FUND'$$, 'Portfolio/true');
SELECT tests.expect_error('A second type cannot take the same name',
    $$SELECT public.set_client_domain_label('ORDER', 'portfolio')$$, '23505');
SELECT tests.expect_error('A type cannot take another type''s catalog name',
    $$SELECT public.set_client_domain_label('ORDER', (SELECT domain_name FROM metadata_register.domain_types WHERE domain_code = 'FUND'))$$, '23505');
SELECT tests.expect_error('An unknown type cannot be named',
    $$SELECT public.set_client_domain_label('NO_SUCH_TYPE', 'Thing')$$, 'P0002');

SELECT tests.expect_value('The steward hides the optional field',
    $$SELECT public.set_client_attributes_hidden(ARRAY['18181818-0000-0000-0000-000000000001'::uuid], TRUE)$$, '1');
SELECT tests.expect_value('Client A no longer sees it, and the catalog flag is unchanged',
    $$SELECT is_visible::text || '/' || catalog_is_visible::text || '/' || hidden_for_client::text
      FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'false/true/true');
SELECT tests.expect_value('The catalog call says the same',
    $$SELECT (e ->> 'is_visible') || '/' || (e ->> 'catalog_is_visible') || '/' || (e ->> 'hidden_for_client')
      FROM jsonb_array_elements(public.get_attributes_with_aggregation('FUND')) e WHERE e ->> 'attribute_code' = 'T18_OPTIONAL'$$, 'false/true/true');
SELECT tests.expect_error('A field every record must have cannot be hidden',
    $$SELECT public.set_client_attributes_hidden(ARRAY['18181818-0000-0000-0000-000000000002'::uuid], TRUE)$$, '23514');
SELECT tests.expect_value('The settings list the hidden field',
    $$SELECT public.client_catalog_settings('FUND') -> 'hidden_attribute_ids' ->> 0$$, '18181818-0000-0000-0000-000000000001');
SELECT tests.expect_denied('The steward cannot write a setting for client B',
    $$INSERT INTO metadata_register.client_domain_settings (client_id, domain_code, display_name)
      VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'FUND', 'Leak') RETURNING 1$$);
SELECT tests.expect_denied('The steward cannot hide a field for client B',
    $$INSERT INTO metadata_register.client_attribute_settings (client_id, attribute_id)
      VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '18181818-0000-0000-0000-000000000001') RETURNING 1$$);
SELECT tests.expect_error('A signed-in person cannot ask for a named client''s names',
    $$SELECT metadata_register.client_domain_labels('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.expect_error('Nor for a named client''s hidden fields',
    $$SELECT metadata_register.client_hidden_attribute_ids('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501');

-- ---------------------------------------------------------------- the rest of client A
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('The client A analyst reads the client''s name',
    $$SELECT domain_name FROM public.domain_types WHERE domain_code = 'FUND'$$, 'Portfolio');
SELECT tests.expect_value('The analyst may not change settings',
    $$SELECT public.client_catalog_settings('FUND') ->> 'can_edit'$$, 'false');
SELECT tests.expect_error('The analyst cannot rename the type',
    $$SELECT public.set_client_domain_label('FUND', 'Vehicle')$$, '42501');
SELECT tests.expect_error('The analyst cannot show the field again',
    $$SELECT public.set_client_attributes_hidden(ARRAY['18181818-0000-0000-0000-000000000001'::uuid], FALSE)$$, '42501');
SELECT tests.expect_denied('The analyst cannot delete the setting directly',
    $$DELETE FROM metadata_register.client_attribute_settings WHERE TRUE RETURNING 1$$);

-- ---------------------------------------------------------------- client B is untouched
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('Client B still reads the catalog name',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('Client B still sees the field',
    $$SELECT is_visible::text || '/' || hidden_for_client::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'true/false');
SELECT tests.expect_rows('Client B reads none of client A''s names',
    $$SELECT 1 FROM metadata_register.client_domain_settings$$, 0);
SELECT tests.expect_rows('Client B reads none of client A''s hidden fields',
    $$SELECT 1 FROM metadata_register.client_attribute_settings$$, 0);
SELECT tests.expect_value('Client B may give the type the same name',
    $$SELECT public.set_client_domain_label('FUND', 'Portfolio') ->> 'display_name'$$, 'Portfolio');

-- ---------------------------------------------------------------- staff and the catalog
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Staff who are not simulating a client work in none',
    $$SELECT tenancy.presentation_client_id()$$, NULL);
SELECT tests.expect_value('Staff read the catalog name',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('Staff see the field',
    $$SELECT is_visible::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'true');
SELECT tests.expect_value('Staff are told there is no single client',
    $$SELECT (public.client_catalog_settings('FUND') -> 'client_id')::text$$, 'null');
SELECT tests.expect_error('Staff cannot set a name without simulating a client',
    $$SELECT public.set_client_domain_label('FUND', 'Vehicle')$$, '42501');
SELECT tests.expect_rows('Another column of the catalog is still written through the view',
    $$UPDATE public.attribute_register SET description = 'changed' WHERE attribute_code = 'T18_OPTIONAL' RETURNING 1$$, 1);
SELECT tests.expect_rows('A new attribute is still added through the view',
    $$INSERT INTO public.attribute_register (attribute_code, attribute_name, data_type, domain_code)
      VALUES ('T18_ADDED', 'Test added field', 'STRING', 'FUND') RETURNING 1$$, 1);
SELECT tests.expect_error('The session''s visible flag cannot be written',
    $$UPDATE public.attribute_register SET is_visible = FALSE WHERE attribute_code = 'T18_OPTIONAL'$$, '0A000');
SELECT tests.expect_rows('The catalog''s visible flag is written on the catalog table',
    $$UPDATE metadata_register.attribute_register SET is_visible = TRUE WHERE attribute_code = 'T18_OPTIONAL' RETURNING 1$$, 1);
SELECT tests.expect_error('The session''s name cannot be written',
    $$UPDATE public.domain_types SET domain_name = 'Changed' WHERE domain_code = 'FUND'$$, '0A000');
SELECT tests.expect_rows('The catalog name is written on the catalog table',
    $$UPDATE metadata_register.domain_types SET domain_name = domain_name WHERE domain_code = 'FUND' RETURNING 1$$, 1);

-- ---------------------------------------------------------------- a session in two clients
SELECT tests.owner();
INSERT INTO tenancy.client_users (client_id, user_id) VALUES
    ('bbbbbbbb-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a');
INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
SELECT 'bbbbbbbb-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', r.id
FROM tenancy.roles r WHERE r.role_code = 'ANALYST' AND r.client_id IS NULL;

SELECT tests.login('a0000000-0000-0000-0000-00000000000a', 'aal1', '{"session_id":"18181818-5e55-0000-0000-000000000001"}');
SELECT tests.expect_value('A session in two clients works in no single one',
    $$SELECT tenancy.presentation_client_id()$$, NULL);
SELECT tests.expect_value('It reads the catalog name',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('It sees every field',
    $$SELECT is_visible::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'true');
SELECT tests.expect_value('The sign-in chooses client A',
    $$SELECT tenancy.choose_session_client('aaaaaaaa-0000-0000-0000-000000000001')$$, 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT tests.expect_value('It then reads client A''s name',
    $$SELECT domain_name FROM public.domain_types WHERE domain_code = 'FUND'$$, 'Portfolio');
SELECT tests.expect_value('And client A''s hidden field',
    $$SELECT is_visible::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'false');

-- ---------------------------------------------------------------- server code and people with no client
SELECT tests.service();
SELECT tests.expect_value('Server code reads the catalog name',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('Server code reads one client''s names when it names the client',
    $$SELECT metadata_register.client_domain_labels('aaaaaaaa-0000-0000-0000-000000000001') ->> 'FUND'$$, 'Portfolio');
SELECT tests.expect_value('And that client''s hidden fields',
    $$SELECT (metadata_register.client_hidden_attribute_ids('aaaaaaaa-0000-0000-0000-000000000001'))[1]$$, '18181818-0000-0000-0000-000000000001');

SELECT tests.login('c0000000-0000-0000-0000-00000000000d');
SELECT tests.expect_value('A person in no client works in none',
    $$SELECT tenancy.presentation_client_id()$$, NULL);
SELECT tests.expect_error('And cannot set a name',
    $$SELECT public.set_client_domain_label('FUND', 'Vehicle')$$, '42501');

SELECT tests.anon();
SELECT tests.expect_denied('A signed-out caller reads no settings',
    $$SELECT 1 FROM metadata_register.client_domain_settings$$);
SELECT tests.expect_denied('A signed-out caller cannot set a name',
    $$SELECT public.set_client_domain_label('FUND', 'Vehicle')$$);

-- ---------------------------------------------------------------- clearing
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('A blank name clears the client''s name',
    $$SELECT (public.set_client_domain_label('FUND', '') -> 'display_name')::text$$, 'null');
SELECT tests.expect_value('Client A reads the catalog name again',
    $$SELECT (domain_name = catalog_domain_name)::text FROM public.domain_types WHERE domain_code = 'FUND'$$, 'true');
SELECT tests.expect_value('The steward shows the field again',
    $$SELECT public.set_client_attributes_hidden(ARRAY['18181818-0000-0000-0000-000000000001'::uuid], FALSE)$$, '1');
SELECT tests.expect_value('Client A sees it again',
    $$SELECT is_visible::text FROM public.attribute_register WHERE attribute_code = 'T18_OPTIONAL'$$, 'true');

SELECT tests.owner();
SELECT tests.check('Client B''s own name is the only setting left',
    (SELECT count(*) FROM metadata_register.client_domain_settings) = 1
    AND (SELECT count(*) FROM metadata_register.client_attribute_settings) = 0);
SELECT tests.done();
ROLLBACK;
