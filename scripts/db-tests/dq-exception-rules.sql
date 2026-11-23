-- See dq-exception-rules.ts. Every check runs inside a transaction that is rolled back.
-- A rule expression describes the exception, and a blank value meets no condition about its value.
BEGIN;
DO $$
DECLARE
    v_case record;
    v_result jsonb;
    v_passed boolean;
BEGIN
    FOR v_case IN
        SELECT * FROM (VALUES
            -- expression, values, expect passed
            ('MARKET_CAP < 0', '{"market_cap": "-5"}', false),
            ('MARKET_CAP < 0', '{"market_cap": "10"}', true),
            ('MARKET_CAP < 0', '{}', true),
            ('MARKET_CAP >= 0', '{}', true),
            ('MARKET_CAP IS NULL', '{}', false),
            ('MARKET_CAP IS NULL', '{"market_cap": "1"}', true),
            -- AND: every condition must be met.
            ('IS_DEFAULTED NOT IN (''false'') AND DEFAULT_DATE IS NULL', '{"is_defaulted": "true"}', false),
            ('IS_DEFAULTED NOT IN (''false'') AND DEFAULT_DATE IS NULL', '{"is_defaulted": "true", "default_date": "2026-01-02"}', true),
            ('IS_DEFAULTED NOT IN (''false'') AND DEFAULT_DATE IS NULL', '{"is_defaulted": "false"}', true),
            ('IS_DEFAULTED NOT IN (''false'') AND DEFAULT_DATE IS NULL', '{}', true),
            -- OR: any one group in full.
            ('PCT < -100 OR PCT > 100', '{"pct": "150"}', false),
            ('PCT < -100 OR PCT > 100', '{"pct": "-150"}', false),
            ('PCT < -100 OR PCT > 100', '{"pct": "50"}', true),
            ('PCT < -100 OR PCT > 100', '{}', true),
            -- Negated forms.
            ('CCY !~ ''^[A-Z]{3}$''', '{"ccy": "usd"}', false),
            ('CCY !~ ''^[A-Z]{3}$''', '{"ccy": "USD"}', true),
            ('CCY !~ ''^[A-Z]{3}$''', '{}', true),
            ('END_DATE < START_DATE', '{"end_date": "2026-01-01", "start_date": "2026-02-01"}', false),
            ('END_DATE < START_DATE', '{"end_date": "2026-01-01"}', true),
            ('DEAL_DATE > CURRENT_DATE', '{"deal_date": "2026-12-31"}', false),
            ('DEAL_DATE > CURRENT_DATE', '{"deal_date": "2026-01-31"}', true)
        ) AS t(expr, vals, expect_passed)
    LOOP
        EXECUTE format('SELECT %s FROM (SELECT $1::jsonb AS vals, DATE ''2026-06-30'' AS as_of) s',
                       data_quality.compile_rule_expression(v_case.expr))
        INTO v_result USING v_case.vals;
        v_passed := (v_result->>'passed')::boolean;
        IF v_passed IS DISTINCT FROM v_case.expect_passed THEN
            RAISE EXCEPTION 'Rule "%" on % passed=%, expected %', v_case.expr, v_case.vals, v_passed, v_case.expect_passed;
        END IF;
        IF NOT v_passed AND v_result->>'message' IS NULL THEN
            RAISE EXCEPTION 'Rule "%" on % failed without a message', v_case.expr, v_case.vals;
        END IF;
        IF v_passed AND v_result->>'message' IS NOT NULL THEN
            RAISE EXCEPTION 'Rule "%" on % passed with a message', v_case.expr, v_case.vals;
        END IF;
    END LOOP;

    -- An old good-data expression becomes the conditions of its exception.
    FOR v_case IN
        SELECT * FROM (VALUES
            ('MARKET_CAP IS NULL OR MARKET_CAP >= 0', 'MARKET_CAP < 0'),
            ('MARKET_CAP IS NOT NULL AND MARKET_CAP >= 0', 'MARKET_CAP < 0'),
            ('MARKET_CAP >= 0', 'MARKET_CAP < 0'),
            ('NAME IS NOT NULL', 'NAME IS NULL'),
            ('PCT IS NULL OR PCT >= -100 AND PCT <= 100', 'PCT < -100 OR PCT > 100'),
            ('CCY IS NULL OR CCY ~ ''^[A-Z]{3}$''', 'CCY !~ ''^[A-Z]{3}$'''),
            ('END_DATE IS NULL OR START_DATE IS NULL OR END_DATE >= START_DATE', 'END_DATE < START_DATE'),
            ('S IS NULL OR S IN (''A'',''B'') OR D <= CURRENT_DATE', 'S NOT IN (''A'',''B'') AND D > CURRENT_DATE'),
            ('F IS NULL OR F IN (''false'') OR D IS NOT NULL', 'F NOT IN (''false'') AND D IS NULL'),
            ('C IS NULL OR P IS NULL OR C IS UNDER P', 'C IS NOT UNDER P')
        ) AS t(old_expr, expect_new)
    LOOP
        IF data_quality.exception_from_pass_expression(v_case.old_expr) IS DISTINCT FROM v_case.expect_new THEN
            RAISE EXCEPTION 'Rewrite of "%" gave "%", expected "%"', v_case.old_expr,
                data_quality.exception_from_pass_expression(v_case.old_expr), v_case.expect_new;
        END IF;
    END LOOP;

    -- The quick pass for a record that lacks the attribute is taken only when the rule cannot fire.
    IF NOT data_quality.rule_passes_when_blank('MARKET_CAP < 0', 'MARKET_CAP') THEN
        RAISE EXCEPTION 'MARKET_CAP < 0 should pass a blank market cap';
    END IF;
    IF data_quality.rule_passes_when_blank('MARKET_CAP IS NULL OR MARKET_CAP < 0', 'MARKET_CAP') THEN
        RAISE EXCEPTION 'MARKET_CAP IS NULL OR MARKET_CAP < 0 should not pass a blank market cap';
    END IF;
    IF data_quality.rule_passes_when_blank('F NOT IN (''false'') AND D IS NULL', 'D') THEN
        RAISE EXCEPTION 'A rule that tests D IS NULL should not pass a blank D';
    END IF;

    -- Every saved rule compiles and no function still looks for the old blank shape.
    IF EXISTS (SELECT 1 FROM data_quality.dq_rules WHERE is_active AND compiled_sql IS NULL) THEN
        RAISE EXCEPTION 'An active rule has no compiled SQL';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'data_quality') AND p.prosrc LIKE '%IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]%'
    ) THEN
        RAISE EXCEPTION 'A function still treats "ATTRIBUTE IS NULL OR" as passing a blank';
    END IF;
END $$;
ROLLBACK;
