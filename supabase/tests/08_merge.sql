-- Merging two records: a client's steward merges its own records; nobody
-- merges across clients, a read-only user does not merge, and a caller from
-- another client learns nothing about whether a record id exists.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('08_merge');

-- ---------------------------------------------------------------- refused
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('A steward cannot merge two B records',
    $$SELECT public.merge_entities('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2')$$);
SELECT tests.expect_error('A steward cannot merge a B record into an A record',
    $$SELECT public.merge_entities('aaaaaaaa-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2')$$);
SELECT tests.expect_error('A steward cannot merge an A record into a B record',
    $$SELECT public.merge_entities('bbbbbbbb-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2')$$);

-- The refusal for another client's record reads the same as for an id that
-- does not exist, so it does not confirm the record is there.
DO $$
DECLARE
    v_b text;
    v_missing text;
BEGIN
    BEGIN
        PERFORM public.merge_entities('bbbbbbbb-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2');
    EXCEPTION WHEN OTHERS THEN v_b := SQLERRM;
    END;
    BEGIN
        PERFORM public.merge_entities('99999999-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-0000000000f2');
    EXCEPTION WHEN OTHERS THEN v_missing := SQLERRM;
    END;
    PERFORM tests.check('A merge refusal does not reveal that a B record exists',
        v_b IS NOT NULL AND v_b = v_missing, format('B record: %s / missing id: %s', v_b, v_missing));
END $$;

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A analyst (read only) cannot merge A records',
    $$SELECT public.merge_entities('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2')$$);
SELECT tests.anon();
SELECT tests.expect_error('anon cannot merge',
    $$SELECT public.merge_entities('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2')$$, '42501');

SELECT tests.owner();
SELECT tests.expect_rows('Nothing was merged by the refused calls',
    $$SELECT 1 FROM entity_instances.master_entities WHERE merged_into_id IS NOT NULL
        AND client_id IN ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001')$$, 0);

-- ---------------------------------------------------------------- allowed
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_ok('B steward merges B-FUND-2 into B-FUND-1',
    $$SELECT public.merge_entities('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-0000000000f2')$$);
SELECT tests.owner();
SELECT tests.expect_value('B-FUND-2 is retired into B-FUND-1',
    $$SELECT merged_into_id::text FROM entity_instances.master_entities WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f2'$$,
    'bbbbbbbb-0000-0000-0000-0000000000f1');
SELECT tests.expect_value('B-FUND-2 is no longer active',
    $$SELECT is_active::text FROM entity_instances.master_entities WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000f2'$$, 'false');
SELECT tests.expect_value('B-FUND-1 keeps its own NAV',
    $$SELECT golden_value FROM golden_master.entity_attribute_values
      WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1' AND system_to = '9999-12-31 23:59:59+00'
        AND attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV')
      ORDER BY valid_from DESC LIMIT 1$$, '987654.321');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
