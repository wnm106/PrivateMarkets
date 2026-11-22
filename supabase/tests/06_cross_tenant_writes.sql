-- Writes that reached into another client: joining its intersection, planting
-- files in its folder, writing the shared catalog, writing aliases without
-- write permission. Then the same kinds of writes on the caller's own data.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('06_cross_tenant_writes');

-- ---------------------------------------------------------------- T9 another client's intersection
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('T9 A steward cannot add an A record to a B intersection',
    $$INSERT INTO entity_instances.intersection_members (intersection_id, entity_id, member_role, valid_from)
      VALUES ('bbbbbbbb-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'TRANCHE', DATE '2020-01-01')$$);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T9 B analyst still sees its intersection',
    $$SELECT 1 FROM entity_instances.intersection_instances WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c1'$$, 1);

-- ---------------------------------------------------------------- T10 another client's folder
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('T10 A analyst cannot store a file under client B''s folder',
    $$INSERT INTO storage.objects (bucket_id, name, owner)
      VALUES ('documents', 'bbbbbbbb-0000-0000-0000-000000000001/planted.pdf', auth.uid())$$);
SELECT tests.expect_rows('T10 A analyst cannot rename a B file',
    $$UPDATE storage.objects SET name = name || '.x' WHERE name LIKE 'bbbbbbbb-0000-0000-0000-000000000001/%' RETURNING 1$$, 0);
SELECT tests.expect_rows('T10 A analyst cannot delete a B file',
    $$DELETE FROM storage.objects WHERE name LIKE 'bbbbbbbb-0000-0000-0000-000000000001/%' RETURNING 1$$, 0);

-- ---------------------------------------------------------------- T12 the shared catalog
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_rows('T12 A steward cannot rename the shared NAV attribute',
    $$UPDATE metadata_register.attribute_register SET attribute_name = 'x' WHERE attribute_code = 'NAV' RETURNING 1$$, 0);
SELECT tests.expect_error('T12 A steward cannot create an attribute owned by client B',
    $$INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, domain_code, client_id)
      VALUES ('B_SQUAT', 'squat', 'STRING', 'FUND', 'bbbbbbbb-0000-0000-0000-000000000001')$$);
SELECT tests.expect_denied('T12 A steward cannot relabel shared reference list values',
    $$UPDATE metadata_register.reference_list_values SET value_label = 'x' WHERE TRUE RETURNING 1$$);
SELECT tests.expect_ok('T12 A steward may create an attribute owned by client A',
    $$INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, domain_code, client_id)
      VALUES ('A_PRIVATE_ATTR', 'A private', 'STRING', 'FUND', 'aaaaaaaa-0000-0000-0000-000000000001')$$);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_rows('T12 B analyst does not see client A''s attribute',
    $$SELECT 1 FROM metadata_register.attribute_register WHERE attribute_code = 'A_PRIVATE_ATTR'$$, 0);

-- ---------------------------------------------------------------- T15 aliases need write permission
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('T15 A analyst (read only) cannot add an alias to an A record',
    $$INSERT INTO entity_instances.entity_aliases (entity_id, alias_label, alias_code, alias_kind)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', 'alias-by-readonly-user', 'RO_ALIAS', 'NAME')$$);
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('T15 A steward may add an alias to an A record',
    $$INSERT INTO entity_instances.entity_aliases (entity_id, alias_label, alias_code, alias_kind)
      VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', 'Alpha One', 'ALPHA_ONE', 'NAME')$$);
SELECT tests.expect_error('T15 A steward cannot add an alias to a B record',
    $$INSERT INTO entity_instances.entity_aliases (entity_id, alias_label, alias_code, alias_kind)
      VALUES ('bbbbbbbb-0000-0000-0000-0000000000f1', 'Bravo alias', 'BRAVO_ALIAS', 'NAME')$$);

-- ---------------------------------------------------------------- records
SELECT tests.expect_error('A steward cannot create a record in client B',
    $$INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, client_id)
      VALUES ('A-INTO-B', 'FUND', 'probe', 'bbbbbbbb-0000-0000-0000-000000000001')$$);
SELECT tests.expect_rows('A steward cannot move a B record into client A',
    $$UPDATE entity_instances.master_entities SET client_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f1' RETURNING 1$$, 0);
SELECT tests.expect_error('A steward cannot move an A record into client B',
    $$UPDATE entity_instances.master_entities SET client_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f2'$$);
SELECT tests.expect_ok('A steward may create a record in client A',
    $$INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, client_id)
      VALUES ('A-FUND-NEW', 'FUND', 'Alpha new', 'aaaaaaaa-0000-0000-0000-000000000001')$$);
-- Codes are unique within a client. A code client B uses tells client A nothing:
-- client A can use it too, and its own second use is still refused.
SELECT tests.expect_ok('A steward may use a code that client B already uses',
    $$INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, client_id)
      VALUES ('B-FUND-1', 'FUND', 'Alpha copy of a Bravo code', 'aaaaaaaa-0000-0000-0000-000000000001')$$);
SELECT tests.expect_error('A steward cannot use one code twice in client A',
    $$INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, client_id)
      VALUES ('A-FUND-NEW', 'FUND', 'Alpha duplicate', 'aaaaaaaa-0000-0000-0000-000000000001')$$, '23505');
SELECT tests.expect_value('A code read by an A steward names the A record, not the B one',
    $$SELECT (entity_instances.entity_id_for_code('B-FUND-1', NULL) <> 'bbbbbbbb-0000-0000-0000-0000000000f1')::text$$, 'true');
SELECT tests.expect_denied('A pro-forma leg naming a B security id is refused',
    $$SELECT * FROM compliance.proforma_snapshot('aaaaaaaa-0000-0000-0000-0000000000f1',
        '[{"security_id": "bbbbbbbb-0000-0000-0000-0000000000f1", "par": 1}]'::jsonb)$$);
SELECT tests.expect_rows('A steward may rename an A record',
    $$UPDATE entity_instances.master_entities SET entity_name = 'Alpha Fund One (renamed)'
      WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1' RETURNING 1$$, 1);
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A analyst (read only) cannot create a record',
    $$INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, client_id)
      VALUES ('A-RO', 'FUND', 'read only', 'aaaaaaaa-0000-0000-0000-000000000001')$$);
SELECT tests.expect_rows('A analyst (read only) cannot rename a record',
    $$UPDATE entity_instances.master_entities SET entity_name = 'x' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f2' RETURNING 1$$, 0);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
