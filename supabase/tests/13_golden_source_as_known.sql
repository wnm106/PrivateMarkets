-- A read as of an earlier Knowledge date uses the winning source known then.
--
-- A-FUND-2 gets a NAV from INTERNAL two days ago, then a MANUAL NAV now, which
-- wins and re-stamps the INTERNAL row. Asked as of yesterday, the answer must
-- still be INTERNAL's value: the MANUAL row did not exist yet.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('13_golden_source_as_known');

SELECT tests.owner();
INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank, system_from)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2', (SELECT id FROM tests.ids WHERE name = 'NAV'), (SELECT id FROM tests.ids WHERE name = 'INTERNAL'),
        '50', 50, DATE '2020-01-01', DATE '9999-12-31', 100, now() - interval '2 days');

CREATE FUNCTION pg_temp.nav_at(p_knowledge timestamptz) RETURNS text LANGUAGE sql AS $$
    SELECT golden_value FROM golden_master.persisted_attribute_values(
        ARRAY['aaaaaaaa-0000-0000-0000-0000000000f2']::uuid[],
        ARRAY[(SELECT id FROM tests.ids WHERE name = 'NAV')]::uuid[],
        CURRENT_DATE, p_knowledge)
$$;
GRANT EXECUTE ON FUNCTION pg_temp.nav_at(timestamptz) TO authenticated;

SELECT tests.expect_value('With one source, INTERNAL is golden now and as of yesterday',
    $$SELECT pg_temp.nav_at(now()) || ' ' || pg_temp.nav_at(now() - interval '1 day')$$, '50 50');

-- A MANUAL value arrives now and wins.
INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2', (SELECT id FROM tests.ids WHERE name = 'NAV'), (SELECT id FROM tests.ids WHERE name = 'MANUAL'),
        '60', 60, DATE '2020-01-01', DATE '9999-12-31', 1);

SELECT tests.expect_value('The INTERNAL row was re-stamped with MANUAL as its winner',
    $$SELECT (golden_source_id = (SELECT id FROM tests.ids WHERE name = 'MANUAL'))::text
      FROM golden_master.entity_attribute_values
      WHERE entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f2' AND source_id = (SELECT id FROM tests.ids WHERE name = 'INTERNAL')$$, 'true');
SELECT tests.expect_value('Now, MANUAL is golden',
    $$SELECT pg_temp.nav_at(now())$$, '60');
SELECT tests.expect_value('As of yesterday, INTERNAL is still golden: MANUAL was not known yet',
    $$SELECT pg_temp.nav_at(now() - interval '1 day')$$, '50');
SELECT tests.expect_value('As of three days ago, there was no NAV',
    $$SELECT coalesce(pg_temp.nav_at(now() - interval '3 days'), 'none')$$, 'none');

-- Signed in, the same read gives the same answers, and the history itself is not readable.
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('An A analyst gets the same answers',
    $$SELECT pg_temp.nav_at(now()) || ' ' || pg_temp.nav_at(now() - interval '1 day')$$, '60 50');
SELECT tests.expect_error('An A analyst cannot read the stamp history directly',
    $$SELECT 1 FROM golden_master.golden_source_history$$, '42501');
SELECT tests.expect_value('explain_golden_source names the winner the stored record uses, and its tier',
    $$SELECT (golden_master.explain_golden_source('aaaaaaaa-0000-0000-0000-0000000000f2', 'NAV') ->> 'winningSource')
          || ' ' || (golden_master.explain_golden_source('aaaaaaaa-0000-0000-0000-0000000000f2', 'NAV') ->> 'tier')$$, 'MANUAL MANUAL_OVERRIDE');
SELECT tests.expect_value('It lists both competing values, the winner first',
    $$SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(golden_master.explain_golden_source('aaaaaaaa-0000-0000-0000-0000000000f2', 'NAV') -> 'candidates') AS c$$, '60,50');
SELECT tests.login('a0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_value('An A steward re-resolves the record and gets the winner',
    $$SELECT winning_source || ' ' || golden_value FROM golden_master.reresolve_golden_sources(ARRAY['aaaaaaaa-0000-0000-0000-0000000000f2']::uuid[], 'NAV')$$,
    'MANUAL 60');
SELECT tests.login('b0000000-0000-0000-0000-00000000000b');
SELECT tests.expect_rows('A B steward re-resolves nothing of client A, and is told nothing',
    $$SELECT * FROM golden_master.reresolve_golden_sources(ARRAY['aaaaaaaa-0000-0000-0000-0000000000f2']::uuid[], 'NAV')$$, 0);
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('A B analyst cannot have a client A record explained',
    $$SELECT golden_master.explain_golden_source('aaaaaaaa-0000-0000-0000-0000000000f2', 'NAV')$$);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
