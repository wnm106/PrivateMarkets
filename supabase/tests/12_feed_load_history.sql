-- A feed load keeps history, and reverting it puts the earlier state back.
--
-- The loader changes a value through golden_master.supersede_value: the row
-- stops being current knowledge and a changed copy is written. "As known
-- before the load" must still answer with the old value. Reverting the batch
-- must make the old value current again, under any session time zone.
--
-- One transaction, so now() is one instant (see 07_bitemporal_and_audit.sql).
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('12_feed_load_history');

SELECT tests.owner();
CREATE TEMP VIEW nav_rows AS
SELECT v.id, v.golden_value AS v, v.valid_from AS f, v.valid_to AS t, v.system_from AS sf, v.system_to AS st, v.load_batch_id
FROM golden_master.entity_attribute_values v
WHERE v.entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
  AND v.attribute_id = (SELECT id FROM tests.ids WHERE name = 'NAV');
GRANT SELECT ON nav_rows TO authenticated, service_role;

CREATE FUNCTION pg_temp.nav_now(p_date date) RETURNS text LANGUAGE sql AS $$
    SELECT string_agg(v, ',' ORDER BY f) FROM nav_rows WHERE f <= p_date AND t >= p_date AND st = '9999-12-31 23:59:59+00'
$$;
CREATE FUNCTION pg_temp.nav_before(p_date date) RETURNS text LANGUAGE sql AS $$
    SELECT string_agg(v, ',' ORDER BY f) FROM nav_rows
    WHERE f <= p_date AND t >= p_date
      AND sf <= now() - interval '1 millisecond' AND st >= now() - interval '1 millisecond'
$$;
CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid);
GRANT ALL ON ids TO authenticated, service_role;
INSERT INTO ids SELECT 'original', id FROM nav_rows WHERE st = '9999-12-31 23:59:59+00';

INSERT INTO entity_instances.load_batches (id, client_id, file_name, as_of_date, status) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000b9', 'aaaaaaaa-0000-0000-0000-000000000001', 'alpha.csv', DATE '2026-09-30', 'PROMOTED');

SELECT tests.expect_value('Fixture: A-FUND-1 NAV is 111 on 2025-01-01 and today',
    $$SELECT pg_temp.nav_now(DATE '2025-01-01') || ' ' || pg_temp.nav_now(CURRENT_DATE)$$, '111 111');

-- ---------------------------------------------------------------- 1. a load corrects the value
-- As the loader does it: the service role, the batch's id on what it writes.
SELECT tests.service();
INSERT INTO ids SELECT 'corrected', golden_master.supersede_value(
    (SELECT id FROM ids WHERE name = 'original'),
    '{"golden_value": "130", "golden_value_numeric": 130}'::jsonb,
    'aaaaaaaa-0000-0000-0000-0000000000b9');
INSERT INTO entity_instances.load_batch_journal (batch_id, kind, target_id, before, after)
SELECT 'aaaaaaaa-0000-0000-0000-0000000000b9', 'VALUE_SUPERSEDE', (SELECT id FROM ids WHERE name = 'original'),
       '{"golden_value": "111"}', jsonb_build_object('golden_value', '130', 'replacement_id', (SELECT id FROM ids WHERE name = 'corrected'));

SELECT tests.owner();
SELECT tests.expect_value('After the load, NAV is 130 for every date',
    $$SELECT pg_temp.nav_now(DATE '2025-01-01') || ' ' || pg_temp.nav_now(CURRENT_DATE)$$, '130 130');
SELECT tests.expect_value('As known before the load, NAV is still 111',
    $$SELECT pg_temp.nav_before(DATE '2025-01-01')$$, '111');
SELECT tests.expect_value('The original row was kept, unchanged, as past knowledge',
    $$SELECT v || ' ' || f || ' ' || t || ' ' || (st = now())::text FROM nav_rows WHERE id = (SELECT id FROM ids WHERE name = 'original')$$,
    '111 2020-01-01 9999-12-31 true');

-- ---------------------------------------------------------------- 2. the same load starts a new period
SELECT tests.service();
INSERT INTO ids SELECT 'shortened', golden_master.supersede_value(
    (SELECT id FROM ids WHERE name = 'corrected'), '{"valid_to": "2026-06-30"}'::jsonb, 'aaaaaaaa-0000-0000-0000-0000000000b9');
INSERT INTO entity_instances.load_batch_journal (batch_id, kind, target_id, before, after)
SELECT 'aaaaaaaa-0000-0000-0000-0000000000b9', 'VALUE_SUPERSEDE', (SELECT id FROM ids WHERE name = 'corrected'),
       '{"valid_to": "9999-12-31"}', jsonb_build_object('valid_to', '2026-06-30', 'replacement_id', (SELECT id FROM ids WHERE name = 'shortened'));
INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank, load_batch_id)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', (SELECT id FROM tests.ids WHERE name = 'NAV'), (SELECT id FROM tests.ids WHERE name = 'MANUAL'),
        '140', 140, DATE '2026-07-01', DATE '9999-12-31', 100, 'aaaaaaaa-0000-0000-0000-0000000000b9');

SELECT tests.owner();
SELECT tests.expect_value('After the load: 130 until June 2026, 140 from July',
    $$SELECT pg_temp.nav_now(DATE '2026-06-30') || ' ' || pg_temp.nav_now(DATE '2026-07-01')$$, '130 140');
SELECT tests.expect_value('As known before the load, July 2026 is still 111',
    $$SELECT pg_temp.nav_before(DATE '2026-07-01')$$, '111');

-- ---------------------------------------------------------------- 3. what supersede_value refuses
SELECT tests.service();
SELECT tests.expect_error('It cannot change who wrote a value or from which source',
    $$SELECT golden_master.supersede_value((SELECT id FROM ids WHERE name = 'shortened'), '{"source_id": "00000000-0000-0000-0000-000000000000"}', NULL)$$, '22023');
SELECT tests.expect_error('It cannot end a value before it starts',
    $$SELECT golden_master.supersede_value((SELECT id FROM ids WHERE name = 'shortened'), '{"valid_to": "2019-12-31"}', NULL)$$, '22023');
SELECT tests.expect_error('It cannot replace a row that is already past knowledge',
    $$SELECT golden_master.supersede_value((SELECT id FROM ids WHERE name = 'original'), '{"golden_value": "1"}', NULL)$$, 'P0002');
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_error('A client B steward cannot replace a client A value',
    $$SELECT golden_master.supersede_value((SELECT id FROM ids WHERE name = 'shortened'), '{"golden_value": "1"}', NULL)$$);

-- ---------------------------------------------------------------- 4. reverting the load
-- In a session whose time zone is not UTC: the revert must still find current rows.
SELECT tests.service();
SET LOCAL timezone = 'America/New_York';
CREATE TEMP TABLE reverted ON COMMIT DROP AS
SELECT public.load_batch_revert('aaaaaaaa-0000-0000-0000-0000000000b9', 'aaaaaaaa-0000-0000-0000-000000000001', NULL) AS result;
GRANT SELECT ON reverted TO service_role;
SELECT tests.expect_value('The revert retired what the load wrote and put back one value',
    $$SELECT (result->>'valuesRetired') || ' ' || (result->>'changesRestored') || ' ' || (result->>'changesLeft') FROM reverted$$, '2 1 0');
SET LOCAL timezone = 'UTC';

SELECT tests.owner();
SELECT tests.expect_value('After the revert, NAV is 111 again for every date',
    $$SELECT pg_temp.nav_now(DATE '2025-01-01') || ' ' || pg_temp.nav_now(DATE '2026-07-01') || ' ' || pg_temp.nav_now(CURRENT_DATE)$$, '111 111 111');
SELECT tests.expect_rows('Exactly one current NAV row',
    $$SELECT 1 FROM nav_rows WHERE st = '9999-12-31 23:59:59+00'$$, 1);
SELECT tests.expect_value('Every row the load wrote is kept as past knowledge',
    $$SELECT count(*)::text FROM nav_rows WHERE load_batch_id = 'aaaaaaaa-0000-0000-0000-0000000000b9' AND st < '9999-12-31 23:59:59+00'$$, '3');

SELECT tests.done();
ROLLBACK;
