-- The rule editor's population preview uses the evaluator's own condition
-- matcher, sees only the caller's records, and reads as of the given dates.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('14_population_preview');

SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('With no conditions, an A analyst sees only client A funds',
    $$SELECT string_agg(r ->> 'entityCode', ',' ORDER BY r ->> 'entityCode')
      FROM jsonb_array_elements(compliance.preview_population('FUND', '[]'::jsonb, CURRENT_DATE, now(), 100, 0) -> 'rows') AS r$$,
    'A-FUND-1,A-FUND-2');
SELECT tests.expect_value('A condition on NAV selects the fund that holds it, and shows the value',
    $$SELECT (r ->> 'entityCode') || ' ' || (r -> 'values' ->> 0)
      FROM jsonb_array_elements(compliance.preview_population('FUND',
          '[{"attribute_code": "NAV", "operator": "equals", "value": "111"}]'::jsonb, CURRENT_DATE, now(), 100, 0) -> 'rows') AS r$$,
    'A-FUND-1 111');
SELECT tests.expect_value('Before the value was known, nothing matches',
    $$SELECT (compliance.preview_population('FUND',
          '[{"attribute_code": "NAV", "operator": "equals", "value": "111"}]'::jsonb, CURRENT_DATE, now() - interval '10 years', 100, 0) ->> 'total')$$,
    '0');
SELECT tests.expect_value('OR across condition groups selects either fund',
    $$SELECT (compliance.preview_population('FUND',
          '[{"attribute_code": "NAV", "operator": "equals", "value": "111", "condition_group": 1},
            {"attribute_code": "NAV", "operator": "is_null", "condition_group": 2}]'::jsonb, CURRENT_DATE, now(), 100, 0) ->> 'total')$$,
    '2');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
