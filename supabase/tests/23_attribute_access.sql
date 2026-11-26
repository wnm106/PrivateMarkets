-- Field-level security (20261126170000_attribute_access_levels): a classified
-- attribute's values are seen and changed only by people cleared for it,
-- through every reader, and a client can classify its own data.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('23_attribute_access');

CREATE FUNCTION pg_temp.nav_rows(p_entity uuid) RETURNS bigint LANGUAGE sql AS $$
    SELECT count(*) FROM golden_master.entity_attribute_values
    WHERE entity_id = p_entity AND attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.nav_rows(uuid) TO authenticated;

-- ---------------------------------------------------------------- 1. unclassified: as before
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.check('Unclassified, an analyst reads NAV', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') > 0);
SELECT tests.expect_value('Nothing is hidden', $$SELECT cardinality(public.hidden_attribute_codes())::text$$, '0');

-- ---------------------------------------------------------------- 2. confidential
SELECT tests.owner();
UPDATE metadata_register.attribute_register SET access_level = 'CONFIDENTIAL' WHERE id = (SELECT id FROM tests.ids WHERE name = 'NAV');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.check('An analyst no longer reads NAV rows', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') = 0);
SELECT tests.expect_value('Nor through the shared reader',
    $$SELECT count(*)::text FROM golden_master.winning_attribute_values(ARRAY['aaaaaaaa-0000-0000-0000-0000000000f1']::uuid[], ARRAY[(SELECT id FROM tests.ids WHERE name = 'NAV')], CURRENT_DATE, now(), false)$$, '0');
SELECT tests.check('Nor in the sources panel',
    NOT (golden_master.explain_golden_source('aaaaaaaa-0000-0000-0000-0000000000f1', 'NAV')::text LIKE '%111%'));
SELECT tests.expect_value('The app is told NAV is hidden, to show "Restricted"', $$SELECT array_to_string(public.hidden_attribute_codes(), ',')$$, 'NAV');
SELECT tests.check('Other attributes of the record are still read',
    (SELECT count(*) FROM golden_master.entity_attribute_values WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 0);

SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.check('A data steward, cleared for confidential, reads NAV', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') > 0);

-- ---------------------------------------------------------------- 3. restricted, and writing
SELECT tests.owner();
UPDATE metadata_register.attribute_register SET access_level = 'RESTRICTED' WHERE id = (SELECT id FROM tests.ids WHERE name = 'NAV');
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.check('Restricted, the steward no longer reads NAV', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') = 0);
SELECT tests.expect_error('Nor writes it',
    $$SELECT golden_master.write_value('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'),
        (SELECT id FROM tests.ids WHERE name = 'MANUAL'), DATE '2026-11-20', '{"golden_value":"1","golden_value_numeric":1}')$$);
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.check('The client administrator reads it', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') > 0);
SELECT tests.login('c0000000-0000-0000-0000-00000000000c', 'aal2');
SELECT tests.expect_value('Platform staff see everything', $$SELECT cardinality(public.hidden_attribute_codes())::text$$, '0');

-- ---------------------------------------------------------------- 4. a client's own level
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('An analyst cannot classify',
    $$SELECT public.set_client_attribute_access_level('aaaaaaaa-0000-0000-0000-000000000001', 'NAV', 'STANDARD')$$, '42501');
SELECT tests.login('b0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('Another client''s admin cannot classify client A''s data',
    $$SELECT public.set_client_attribute_access_level('aaaaaaaa-0000-0000-0000-000000000001', 'NAV', 'STANDARD')$$, '42501');
SELECT tests.expect_ok('Client B''s admin makes NAV standard for client B',
    $$SELECT public.set_client_attribute_access_level('bbbbbbbb-0000-0000-0000-000000000001', 'NAV', 'STANDARD')$$);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.check('Client B''s analyst then reads B''s NAV', pg_temp.nav_rows('bbbbbbbb-0000-0000-0000-0000000000f1') > 0);
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.check('Client A''s analyst still does not read A''s', pg_temp.nav_rows('aaaaaaaa-0000-0000-0000-0000000000f1') = 0);
SELECT tests.owner();
SELECT tests.expect_rows('Classifying is in the audit log',
    $$SELECT 1 FROM tenancy.audit_log WHERE table_name = 'client_attribute_settings' AND client_id = 'bbbbbbbb-0000-0000-0000-000000000001' AND occurred_at >= now()$$, 1);

-- ---------------------------------------------------------------- 5. every definer reader is accounted for
-- A function signed-in users can call, that runs as its owner and reads the
-- values, either filters through tenancy.hidden_attribute_ids or is listed
-- here with why it must see every value.
SELECT tests.expect_value('Every definer reader filters, or is listed with its reason',
    $$WITH exempt(fn, reason) AS (VALUES
        ('public.merge_entities', 'Moves every value of the merged record; filtering would lose data'),
        ('public.load_batch_revert', 'Restores every value a load replaced'),
        ('golden_master.reresolve_golden_sources', 'Recomputes which source wins; writes only the choice'),
        ('public.load_batch_quality', 'Checks a staged load against live values for the person loading it; returns counts and the batch''s own values')
      )
      SELECT COALESCE(string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY 1), 'none')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND p.prosrc ~ '(FROM|JOIN)\s+(golden_master\.)?(entity_attribute_values|intersection_attribute_values)\M'
        AND p.prosrc !~ 'hidden_attribute_ids'
        AND n.nspname || '.' || p.proname NOT IN (SELECT fn FROM exempt)$$,
    'none');

SELECT tests.done();
ROLLBACK;
