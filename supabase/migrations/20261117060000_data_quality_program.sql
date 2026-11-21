-- The data quality program.
--
-- Availability: an attribute every record of its entity must carry is marked
-- required on the attribute, and on the entity's standard template so records
-- on a template are measured the same way. No rule tests for a blank.
--
-- Quality: every rule is a statement that is true of good data. A rule passes
-- when its attribute is blank, so a missing value is counted once, under
-- availability. Rules cover identifier and code formats, ranges, date logic,
-- one field against another, and values that are only needed when another
-- field says so (a defaulted obligation needs its default date).
--
-- Safe to run again.

-- 1. Let a rule compare one attribute with another. The interpreted evaluator
--    already could; the compiled one the dashboard uses could not.
CREATE OR REPLACE FUNCTION data_quality.compile_rule_clause(p_clause text)
 RETURNS TABLE(pred text, msg text, actual text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$

DECLARE

  v_clause text := btrim(p_clause);

  v_m text[];

  v_attr text;

  v_op text;

  v_rhs text;

  v_val text;

  v_items text[] := ARRAY[]::text[];

  v_item text;
  v_other text;

  v_num_like text := '^-?[0-9]+([.][0-9]+)?$';

  v_date_like text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$';

BEGIN

  IF v_clause = '' THEN

    RAISE EXCEPTION 'Rule expression has an empty clause';

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL$', 'i');

  IF v_m IS NULL THEN

    v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NULL$', 'i');

    IF v_m IS NOT NULL THEN

      v_attr := v_m[1];

      v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

      pred := format('(%s IS NULL)', v_val);

      msg := format('%L', v_attr || ' is present');

      actual := v_val;

      RETURN NEXT;

      RETURN;

    END IF;

  ELSE

    v_attr := v_m[1];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%s IS NOT NULL)', v_val);

    msg := format('%L', v_attr || ' is missing');

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*(-?[0-9]+(?:[.][0-9]+)?)$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_rhs := v_m[3];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::numeric %3$s %4$s) END)',

      v_val, v_num_like, v_op, v_rhs

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',

      v_val, v_attr || ' is missing', v_num_like, v_attr || ' is not a number', v_attr || ' failed ' || v_op || ' ' || v_rhs

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*CURRENT_DATE$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s as_of) END)',

      v_val, v_date_like, v_op

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L || '' ('' || as_of::text || '')'' END)',

      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' CURRENT_DATE'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*''([0-9]{4}-[0-9]{2}-[0-9]{2})''$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_rhs := v_m[3];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s DATE %4$L) END)',

      v_val, v_date_like, v_op, v_rhs

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',

      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' ' || v_rhs

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*~[[:space:]]*''((?:[^'']|'')*)''$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_rhs := replace(v_m[2], '''''', '''');

    BEGIN

      PERFORM '' ~ v_rhs;

    EXCEPTION WHEN invalid_regular_expression THEN

      RAISE EXCEPTION 'Invalid regular expression on %', v_attr;

    END;

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%1$s IS NOT NULL AND %1$s ~ %2$L)', v_val, v_rhs);

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',

      v_val, v_attr || ' is missing', v_attr || ' does not match the expected format'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IN[[:space:]]*\((.*)\)[[:space:]]*$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    FOR v_item IN

      SELECT match[1] FROM regexp_matches(v_m[2], '''([^'']*)''', 'g') AS match

    LOOP

      v_items := v_items || format('%L', lower(replace(v_item, '''''', '''')));

    END LOOP;

    IF cardinality(v_items) = 0 THEN

      RAISE EXCEPTION 'IN list on % has no quoted values', v_attr;

    END IF;

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%1$s IS NOT NULL AND lower(%1$s) IN (%2$s))', v_val, array_to_string(v_items, ', '));

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',

      v_val, v_attr || ' is missing', v_attr || ' is not an allowed value'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  -- One attribute compared with another: MATURITY_DATE > ISSUANCE_DATE.
  -- Dates compare as dates, numbers as numbers, anything else as text.
  -- A blank on either side fails, the same as the interpreted evaluator.
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL AND upper(v_m[3]) NOT IN ('NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'YESTERDAY') THEN
    v_attr := v_m[1];
    v_op := CASE WHEN v_m[2] = '!=' THEN '<>' ELSE v_m[2] END;
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    v_other := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_rhs));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %2$s IS NULL THEN false WHEN %1$s ~ %3$L AND %2$s ~ %3$L THEN (%1$s::date %5$s %2$s::date) WHEN %1$s ~ %4$L AND %2$s ~ %4$L THEN (%1$s::numeric %5$s %2$s::numeric) ELSE (%1$s %5$s %2$s) END)',
      v_val, v_other, v_date_like, v_num_like, v_op
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %3$L WHEN %2$s IS NULL THEN %4$L ELSE %5$L END)',
      v_val, v_other, v_attr || ' is missing', v_rhs || ' is missing', v_attr || ' failed ' || v_op || ' ' || v_rhs
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Expression is not supported: %', v_clause;

END;

$function$;

-- 2. Required attributes.
--
-- Each listed attribute must exist on its entity. One that is not in the
-- catalog at all is skipped with a notice: on a fresh database NAV, COUNTRY and
-- the other attributes supabase/seed/001_seed_data.sql adds arrive after the
-- migrations. On the hosted project every one exists, so nothing is skipped
-- there. An attribute that exists on another entity still stops the migration.
DO $$
DECLARE
  v_expected int := 185;
  v_found int;
  v_absent int;
  v_absent_list text;
BEGIN
  WITH req(domain_code, attribute_code) AS (VALUES
    ('ACCOUNT', 'ACCOUNT_LABEL'),
    ('ACCOUNT', 'CUSTODIAN_ID'),
    ('AMORTIZATION', 'AMORT_DATE'),
    ('AMORTIZATION', 'AMORT_PRINCIPAL_AMOUNT'),
    ('AMORTIZATION', 'AMORT_TYPE'),
    ('AMORTIZATION', 'AMORT_STATUS'),
    ('BANK_ACCOUNT', 'BANK_ACCOUNT_LABEL'),
    ('BANK_ACCOUNT', 'BANK_ACCOUNT_NUMBER'),
    ('BANK_ACCOUNT', 'BANK_CURRENCY'),
    ('BANK_ACCOUNT', 'BANK_NAME'),
    ('BANK_TRANSACTION', 'BANK_TXN_AMOUNT'),
    ('BANK_TRANSACTION', 'BANK_TXN_DATE'),
    ('CALL_SCHEDULE', 'CALL_DATE'),
    ('CALL_SCHEDULE', 'CALL_PROVISION'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_AMOUNT'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_DATE'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_KIND'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_STATUS'),
    ('CAPITAL_PLAN', 'PLAN_QUARTER_END'),
    ('CAPITAL_PLAN', 'PLAN_CALLED_PCT'),
    ('CASH_ADJUSTMENT', 'ADJ_AMOUNT'),
    ('CASH_ADJUSTMENT', 'ADJ_PERIOD_END'),
    ('CASH_ADJUSTMENT', 'ADJ_REASON'),
    ('CASH_ADJUSTMENT', 'ADJ_SIDE'),
    ('CASH_ADJUSTMENT', 'ADJ_STATUS'),
    ('CASH_FLOW', 'AMOUNT'),
    ('CASH_FLOW', 'CASHFLOW_DATE'),
    ('CASH_FLOW', 'CASHFLOW_TYPE'),
    ('CASH_FLOW', 'PAYMENT_STATUS'),
    ('CASH_FORECAST', 'FORECAST_QUARTER_END'),
    ('CASH_MATCH', 'MATCH_PERIOD_END'),
    ('CASH_MATCH', 'MATCH_RULE'),
    ('CASH_MATCH', 'MATCH_STATUS'),
    ('CASH_MATCH_RULE', 'RULE_KIND'),
    ('CASH_MATCH_RULE', 'RULE_PRIORITY'),
    ('CASH_MATCH_RULE', 'RULE_ENABLED'),
    ('CLO_ACCOUNT', 'CLO_ACCT_TYPE'),
    ('CLO_ACCOUNT', 'CLO_ACCT_CURRENCY'),
    ('CLO_ACCOUNT', 'CLO_ACCT_BALANCE'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_CODE'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_SENIORITY_RANK'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_ORIGINAL_PAR'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_PAR_OUTSTANDING'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_IS_DEFERRABLE'),
    ('CLO_TRANSACTION', 'CLO_CLOSING_DATE'),
    ('CLO_TRANSACTION', 'CLO_EFFECTIVE_DATE'),
    ('CLO_TRANSACTION', 'CLO_NON_CALL_END'),
    ('CLO_TRANSACTION', 'CLO_REINVESTMENT_PERIOD_END'),
    ('CLO_TRANSACTION', 'CLO_STATED_MATURITY'),
    ('CLO_TRANSACTION', 'CLO_PAYMENT_FREQUENCY'),
    ('CLO_TRANSACTION', 'CLO_TARGET_INITIAL_PAR'),
    ('CLO_TRANSACTION', 'CLO_MAX_WARF'),
    ('CLO_TRANSACTION', 'CLO_MIN_WAS_BPS'),
    ('CLO_TRANSACTION', 'CLO_MIN_DIVERSITY_SCORE'),
    ('CLO_TRANSACTION', 'CLO_MAX_WAL_YEARS'),
    ('CLO_TRANSACTION', 'CLO_MIN_WARR'),
    ('CLO_TRANSACTION', 'CLO_MAX_CCC_PCT'),
    ('CLO_TRANSACTION', 'CLO_MAX_SINGLE_OBLIGOR_PCT'),
    ('CLOSING_CONDITION', 'CONDITION_STATUS'),
    ('CLOSING_CONDITION', 'CONDITION_WORKSTREAM'),
    ('CLOSING_CONDITION', 'CONDITION_OWNER'),
    ('CLOSING_CONDITION', 'CONDITION_DUE_DATE'),
    ('COUNTERPARTY', 'COUNTERPARTY_NAME'),
    ('COUNTERPARTY', 'IS_AFFILIATED_ENTITY'),
    ('CREDIT_FACILITY', 'FACILITY_COMMITMENT'),
    ('CREDIT_FACILITY', 'FACILITY_DRAWN'),
    ('CREDIT_FACILITY', 'FACILITY_MATURITY'),
    ('CUSTODIAN', 'CUSTODIAN_NAME'),
    ('CUSTODIAN', 'IS_ELIGIBLE_BANK_EXCHANGE'),
    ('DEAL', 'DEAL_STAGE'),
    ('DEAL', 'STATUS'),
    ('DEAL', 'DEAL_TYPE'),
    ('DEAL', 'DEAL_STRATEGY'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_AMOUNT'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_LABEL'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_SIDE'),
    ('DEAL_COVENANT', 'COVENANT_DIRECTION'),
    ('DEAL_COVENANT', 'COVENANT_LEVEL'),
    ('DEAL_COVENANT', 'COVENANT_UNIT'),
    ('DEAL_COVENANT', 'COVENANT_FIRST_TEST'),
    ('DEAL_DOCUMENT', 'DOC_STATUS'),
    ('DEAL_DOCUMENT', 'DOC_SIGNATURES_REQUIRED'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_STATUS'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_CASH_AMOUNT'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_LINE_AMOUNT'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_CALL_AMOUNT'),
    ('DEAL_MEMO_POINT', 'MEMO_POINT_KIND'),
    ('DEAL_MEMO_POINT', 'MEMO_POINT_BODY'),
    ('DEAL_OPEN_ITEM', 'OPEN_ITEM_TITLE'),
    ('DEAL_OPEN_ITEM', 'OPEN_ITEM_STATUS'),
    ('DEAL_TRANCHE', 'TRANCHE_SIZE'),
    ('DEAL_TRANCHE', 'TRANCHE_RANK'),
    ('DEAL_TRANCHE', 'TRANCHE_HOLD_PCT'),
    ('DEAL_TRANCHE', 'TRANCHE_SENIORITY'),
    ('DEAL_TRANCHE', 'TRANCHE_IS_UNFUNDED'),
    ('DEAL_TRANCHE', 'TRANCHE_IS_EQUITY_LINKED'),
    ('EXPECTED_DRAW', 'DRAW_AMOUNT'),
    ('EXPECTED_DRAW', 'DRAW_DATE'),
    ('EXPECTED_DRAW', 'DRAW_STATUS'),
    ('EXPOSURE_LIMIT', 'LIMIT_DIMENSION'),
    ('EXPOSURE_LIMIT', 'LIMIT_KEY'),
    ('EXPOSURE_LIMIT', 'LIMIT_PCT'),
    ('FACTOR_SCHEDULE', 'FACTOR_DATE'),
    ('FACTOR_SCHEDULE', 'FACTOR_KIND'),
    ('FACTOR_SCHEDULE', 'FACTOR_VALUE'),
    ('FINANCIAL_PERIOD', 'PERIOD_LABEL'),
    ('FINANCIAL_PERIOD', 'PERIOD_BASIS'),
    ('FINANCIAL_PERIOD', 'PERIOD_REVENUE'),
    ('FINANCIAL_PERIOD', 'PERIOD_EBITDA'),
    ('FORWARD_CURVE', 'CURVE_NAME'),
    ('FORWARD_CURVE', 'CURVE_CURRENCY'),
    ('FORWARD_CURVE', 'CURVE_INDEX'),
    ('FORWARD_CURVE', 'CURVE_AS_OF_DATE'),
    ('FORWARD_CURVE', 'CURVE_SOURCE'),
    ('FORWARD_RATE', 'FORWARD_TENOR'),
    ('FORWARD_RATE', 'FORWARD_RATE_VALUE'),
    ('FORWARD_RATE', 'FORWARD_START_DATE'),
    ('FORWARD_RATE', 'FORWARD_MATURITY_DATE'),
    ('FUND', 'NAV'),
    ('FUND', 'NAV_DATE'),
    ('FUND', 'NAV_CURRENCY'),
    ('FUND', 'FUND_TYPE'),
    ('FUND', 'FUND_STATUS'),
    ('FUND', 'FUND_STRATEGY'),
    ('FUND', 'DOMICILE'),
    ('FUND', 'INCEPTION_DATE'),
    ('FUND_CLOSE', 'CLOSE_PERIOD_END'),
    ('FUND_CLOSE', 'CLOSE_SIGNOFF'),
    ('FX_RATE', 'FX_BASE_CURRENCY'),
    ('FX_RATE', 'FX_QUOTE_CURRENCY'),
    ('FX_RATE', 'FX_MARKET_DATE'),
    ('FX_RATE', 'FX_MARKET_RATE'),
    ('FX_RATE', 'FX_MARKET_TENOR'),
    ('FX_RATE', 'FX_MARKET_SOURCE'),
    ('IC_APPROVAL', 'APPROVAL_MEMBER'),
    ('IC_APPROVAL', 'APPROVAL_ROLE'),
    ('IC_APPROVAL', 'APPROVAL_DECISION'),
    ('INTEREST_CONTRACT', 'CONTRACT_AMOUNT'),
    ('INTEREST_CONTRACT', 'CONTRACT_EFFECTIVE_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_END_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_KIND'),
    ('INTEREST_CONTRACT', 'CONTRACT_PAYMENT_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_SEQUENCE'),
    ('INTEREST_CONTRACT', 'CONTRACT_RATE_TYPE'),
    ('INTEREST_CONTRACT', 'CONTRACT_DAY_COUNT'),
    ('INTEREST_CONTRACT', 'CONTRACT_STATUS'),
    ('INVESTOR', 'INVESTOR_TYPE'),
    ('INVESTOR_COMMITMENT', 'COMMITMENT_AMOUNT'),
    ('INVESTOR_COMMITMENT', 'COMMITMENT_STATUS'),
    ('ISSUER', 'ISSUER_LEGAL_NAME'),
    ('ISSUER', 'COUNTRY'),
    ('ISSUER', 'SECTOR'),
    ('LENDER', 'LENDER_TYPE'),
    ('NAV_STATEMENT', 'STATEMENT_PERIOD_END'),
    ('NAV_STATEMENT', 'STATEMENT_PERIOD_LABEL'),
    ('NAV_STATEMENT', 'STATEMENT_RECEIVED_DATE'),
    ('NAV_STATEMENT', 'NAV_BS_NET_ASSETS'),
    ('NAV_STATEMENT', 'NAV_BS_INVESTMENTS'),
    ('ORDER', 'ORDER_LABEL'),
    ('ORDER', 'TRANSACTION_TYPE'),
    ('ORDER', 'ORDER_QUANTITY'),
    ('ORDER', 'ESTIMATED_VALUE'),
    ('ORDER', 'COMPLIANCE_STATUS'),
    ('POSITION', 'MARKET_VALUE'),
    ('POSITION', 'POSITION_CURRENCY'),
    ('POSITION_ROLL', 'ROLL_END_FV'),
    ('REC_DISPOSITION', 'DISPOSITION_DECISION'),
    ('REC_DISPOSITION', 'DISPOSITION_ITEM'),
    ('REC_EVIDENCE', 'EVIDENCE_AMOUNT'),
    ('REC_EVIDENCE', 'EVIDENCE_DATE'),
    ('REC_EVIDENCE', 'EVIDENCE_KIND'),
    ('REC_EVIDENCE', 'EVIDENCE_SOURCE'),
    ('REPORTING_OBLIGATION', 'REPORT_DUE_DATE'),
    ('SECURITY', 'CURRENCY'),
    ('SECURITY', 'INSTRUMENT_TYPE'),
    ('SPONSOR', 'SPONSOR_NAME'),
    ('SPONSOR', 'SPONSOR_TYPE'),
    ('STATEMENT_PERIOD', 'STATEMENT_END'),
    ('STATEMENT_PERIOD', 'STATEMENT_REVENUE'),
    ('SYNDICATE_ORDER', 'ORDER_AMOUNT'),
    ('SYNDICATE_ORDER', 'ORDER_ALLOCATED_AMOUNT'),
    ('SYNDICATE_SEAT', 'SEAT_ROLE'),
    ('SYNDICATE_SEAT', 'SEAT_IS_HOUSE'),
    ('TRADE', 'TRADE_LABEL'),
    ('TRADE', 'TRADE_STATUS')
  )
  SELECT count(ar.id),
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM metadata_register.attribute_register x WHERE x.attribute_code = r.attribute_code)),
         string_agg(r.domain_code || '.' || r.attribute_code, ', ' ORDER BY r.domain_code, r.attribute_code)
           FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM metadata_register.attribute_register x WHERE x.attribute_code = r.attribute_code))
  INTO v_found, v_absent, v_absent_list
  FROM req r
  LEFT JOIN metadata_register.attribute_register ar
    ON ar.domain_code = r.domain_code AND ar.attribute_code = r.attribute_code;
  IF v_absent > 0 THEN
    RAISE NOTICE 'Required attributes not in the catalog yet, skipped: %', v_absent_list;
  END IF;
  IF v_found + v_absent <> v_expected THEN
    RAISE EXCEPTION 'Expected % required attributes, found %', v_expected, v_found;
  END IF;

  WITH req(domain_code, attribute_code) AS (VALUES
    ('ACCOUNT', 'ACCOUNT_LABEL'),
    ('ACCOUNT', 'CUSTODIAN_ID'),
    ('AMORTIZATION', 'AMORT_DATE'),
    ('AMORTIZATION', 'AMORT_PRINCIPAL_AMOUNT'),
    ('AMORTIZATION', 'AMORT_TYPE'),
    ('AMORTIZATION', 'AMORT_STATUS'),
    ('BANK_ACCOUNT', 'BANK_ACCOUNT_LABEL'),
    ('BANK_ACCOUNT', 'BANK_ACCOUNT_NUMBER'),
    ('BANK_ACCOUNT', 'BANK_CURRENCY'),
    ('BANK_ACCOUNT', 'BANK_NAME'),
    ('BANK_TRANSACTION', 'BANK_TXN_AMOUNT'),
    ('BANK_TRANSACTION', 'BANK_TXN_DATE'),
    ('CALL_SCHEDULE', 'CALL_DATE'),
    ('CALL_SCHEDULE', 'CALL_PROVISION'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_AMOUNT'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_DATE'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_KIND'),
    ('CAPITAL_ACTIVITY', 'ACTIVITY_STATUS'),
    ('CAPITAL_PLAN', 'PLAN_QUARTER_END'),
    ('CAPITAL_PLAN', 'PLAN_CALLED_PCT'),
    ('CASH_ADJUSTMENT', 'ADJ_AMOUNT'),
    ('CASH_ADJUSTMENT', 'ADJ_PERIOD_END'),
    ('CASH_ADJUSTMENT', 'ADJ_REASON'),
    ('CASH_ADJUSTMENT', 'ADJ_SIDE'),
    ('CASH_ADJUSTMENT', 'ADJ_STATUS'),
    ('CASH_FLOW', 'AMOUNT'),
    ('CASH_FLOW', 'CASHFLOW_DATE'),
    ('CASH_FLOW', 'CASHFLOW_TYPE'),
    ('CASH_FLOW', 'PAYMENT_STATUS'),
    ('CASH_FORECAST', 'FORECAST_QUARTER_END'),
    ('CASH_MATCH', 'MATCH_PERIOD_END'),
    ('CASH_MATCH', 'MATCH_RULE'),
    ('CASH_MATCH', 'MATCH_STATUS'),
    ('CASH_MATCH_RULE', 'RULE_KIND'),
    ('CASH_MATCH_RULE', 'RULE_PRIORITY'),
    ('CASH_MATCH_RULE', 'RULE_ENABLED'),
    ('CLO_ACCOUNT', 'CLO_ACCT_TYPE'),
    ('CLO_ACCOUNT', 'CLO_ACCT_CURRENCY'),
    ('CLO_ACCOUNT', 'CLO_ACCT_BALANCE'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_CODE'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_SENIORITY_RANK'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_ORIGINAL_PAR'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_PAR_OUTSTANDING'),
    ('CLO_NOTE_CLASS', 'CLO_NOTE_IS_DEFERRABLE'),
    ('CLO_TRANSACTION', 'CLO_CLOSING_DATE'),
    ('CLO_TRANSACTION', 'CLO_EFFECTIVE_DATE'),
    ('CLO_TRANSACTION', 'CLO_NON_CALL_END'),
    ('CLO_TRANSACTION', 'CLO_REINVESTMENT_PERIOD_END'),
    ('CLO_TRANSACTION', 'CLO_STATED_MATURITY'),
    ('CLO_TRANSACTION', 'CLO_PAYMENT_FREQUENCY'),
    ('CLO_TRANSACTION', 'CLO_TARGET_INITIAL_PAR'),
    ('CLO_TRANSACTION', 'CLO_MAX_WARF'),
    ('CLO_TRANSACTION', 'CLO_MIN_WAS_BPS'),
    ('CLO_TRANSACTION', 'CLO_MIN_DIVERSITY_SCORE'),
    ('CLO_TRANSACTION', 'CLO_MAX_WAL_YEARS'),
    ('CLO_TRANSACTION', 'CLO_MIN_WARR'),
    ('CLO_TRANSACTION', 'CLO_MAX_CCC_PCT'),
    ('CLO_TRANSACTION', 'CLO_MAX_SINGLE_OBLIGOR_PCT'),
    ('CLOSING_CONDITION', 'CONDITION_STATUS'),
    ('CLOSING_CONDITION', 'CONDITION_WORKSTREAM'),
    ('CLOSING_CONDITION', 'CONDITION_OWNER'),
    ('CLOSING_CONDITION', 'CONDITION_DUE_DATE'),
    ('COUNTERPARTY', 'COUNTERPARTY_NAME'),
    ('COUNTERPARTY', 'IS_AFFILIATED_ENTITY'),
    ('CREDIT_FACILITY', 'FACILITY_COMMITMENT'),
    ('CREDIT_FACILITY', 'FACILITY_DRAWN'),
    ('CREDIT_FACILITY', 'FACILITY_MATURITY'),
    ('CUSTODIAN', 'CUSTODIAN_NAME'),
    ('CUSTODIAN', 'IS_ELIGIBLE_BANK_EXCHANGE'),
    ('DEAL', 'DEAL_STAGE'),
    ('DEAL', 'STATUS'),
    ('DEAL', 'DEAL_TYPE'),
    ('DEAL', 'DEAL_STRATEGY'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_AMOUNT'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_LABEL'),
    ('DEAL_CAPITAL_ITEM', 'CAPITAL_SIDE'),
    ('DEAL_COVENANT', 'COVENANT_DIRECTION'),
    ('DEAL_COVENANT', 'COVENANT_LEVEL'),
    ('DEAL_COVENANT', 'COVENANT_UNIT'),
    ('DEAL_COVENANT', 'COVENANT_FIRST_TEST'),
    ('DEAL_DOCUMENT', 'DOC_STATUS'),
    ('DEAL_DOCUMENT', 'DOC_SIGNATURES_REQUIRED'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_STATUS'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_CASH_AMOUNT'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_LINE_AMOUNT'),
    ('DEAL_FUNDING_PLAN', 'FUNDING_CALL_AMOUNT'),
    ('DEAL_MEMO_POINT', 'MEMO_POINT_KIND'),
    ('DEAL_MEMO_POINT', 'MEMO_POINT_BODY'),
    ('DEAL_OPEN_ITEM', 'OPEN_ITEM_TITLE'),
    ('DEAL_OPEN_ITEM', 'OPEN_ITEM_STATUS'),
    ('DEAL_TRANCHE', 'TRANCHE_SIZE'),
    ('DEAL_TRANCHE', 'TRANCHE_RANK'),
    ('DEAL_TRANCHE', 'TRANCHE_HOLD_PCT'),
    ('DEAL_TRANCHE', 'TRANCHE_SENIORITY'),
    ('DEAL_TRANCHE', 'TRANCHE_IS_UNFUNDED'),
    ('DEAL_TRANCHE', 'TRANCHE_IS_EQUITY_LINKED'),
    ('EXPECTED_DRAW', 'DRAW_AMOUNT'),
    ('EXPECTED_DRAW', 'DRAW_DATE'),
    ('EXPECTED_DRAW', 'DRAW_STATUS'),
    ('EXPOSURE_LIMIT', 'LIMIT_DIMENSION'),
    ('EXPOSURE_LIMIT', 'LIMIT_KEY'),
    ('EXPOSURE_LIMIT', 'LIMIT_PCT'),
    ('FACTOR_SCHEDULE', 'FACTOR_DATE'),
    ('FACTOR_SCHEDULE', 'FACTOR_KIND'),
    ('FACTOR_SCHEDULE', 'FACTOR_VALUE'),
    ('FINANCIAL_PERIOD', 'PERIOD_LABEL'),
    ('FINANCIAL_PERIOD', 'PERIOD_BASIS'),
    ('FINANCIAL_PERIOD', 'PERIOD_REVENUE'),
    ('FINANCIAL_PERIOD', 'PERIOD_EBITDA'),
    ('FORWARD_CURVE', 'CURVE_NAME'),
    ('FORWARD_CURVE', 'CURVE_CURRENCY'),
    ('FORWARD_CURVE', 'CURVE_INDEX'),
    ('FORWARD_CURVE', 'CURVE_AS_OF_DATE'),
    ('FORWARD_CURVE', 'CURVE_SOURCE'),
    ('FORWARD_RATE', 'FORWARD_TENOR'),
    ('FORWARD_RATE', 'FORWARD_RATE_VALUE'),
    ('FORWARD_RATE', 'FORWARD_START_DATE'),
    ('FORWARD_RATE', 'FORWARD_MATURITY_DATE'),
    ('FUND', 'NAV'),
    ('FUND', 'NAV_DATE'),
    ('FUND', 'NAV_CURRENCY'),
    ('FUND', 'FUND_TYPE'),
    ('FUND', 'FUND_STATUS'),
    ('FUND', 'FUND_STRATEGY'),
    ('FUND', 'DOMICILE'),
    ('FUND', 'INCEPTION_DATE'),
    ('FUND_CLOSE', 'CLOSE_PERIOD_END'),
    ('FUND_CLOSE', 'CLOSE_SIGNOFF'),
    ('FX_RATE', 'FX_BASE_CURRENCY'),
    ('FX_RATE', 'FX_QUOTE_CURRENCY'),
    ('FX_RATE', 'FX_MARKET_DATE'),
    ('FX_RATE', 'FX_MARKET_RATE'),
    ('FX_RATE', 'FX_MARKET_TENOR'),
    ('FX_RATE', 'FX_MARKET_SOURCE'),
    ('IC_APPROVAL', 'APPROVAL_MEMBER'),
    ('IC_APPROVAL', 'APPROVAL_ROLE'),
    ('IC_APPROVAL', 'APPROVAL_DECISION'),
    ('INTEREST_CONTRACT', 'CONTRACT_AMOUNT'),
    ('INTEREST_CONTRACT', 'CONTRACT_EFFECTIVE_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_END_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_KIND'),
    ('INTEREST_CONTRACT', 'CONTRACT_PAYMENT_DATE'),
    ('INTEREST_CONTRACT', 'CONTRACT_SEQUENCE'),
    ('INTEREST_CONTRACT', 'CONTRACT_RATE_TYPE'),
    ('INTEREST_CONTRACT', 'CONTRACT_DAY_COUNT'),
    ('INTEREST_CONTRACT', 'CONTRACT_STATUS'),
    ('INVESTOR', 'INVESTOR_TYPE'),
    ('INVESTOR_COMMITMENT', 'COMMITMENT_AMOUNT'),
    ('INVESTOR_COMMITMENT', 'COMMITMENT_STATUS'),
    ('ISSUER', 'ISSUER_LEGAL_NAME'),
    ('ISSUER', 'COUNTRY'),
    ('ISSUER', 'SECTOR'),
    ('LENDER', 'LENDER_TYPE'),
    ('NAV_STATEMENT', 'STATEMENT_PERIOD_END'),
    ('NAV_STATEMENT', 'STATEMENT_PERIOD_LABEL'),
    ('NAV_STATEMENT', 'STATEMENT_RECEIVED_DATE'),
    ('NAV_STATEMENT', 'NAV_BS_NET_ASSETS'),
    ('NAV_STATEMENT', 'NAV_BS_INVESTMENTS'),
    ('ORDER', 'ORDER_LABEL'),
    ('ORDER', 'TRANSACTION_TYPE'),
    ('ORDER', 'ORDER_QUANTITY'),
    ('ORDER', 'ESTIMATED_VALUE'),
    ('ORDER', 'COMPLIANCE_STATUS'),
    ('POSITION', 'MARKET_VALUE'),
    ('POSITION', 'POSITION_CURRENCY'),
    ('POSITION_ROLL', 'ROLL_END_FV'),
    ('REC_DISPOSITION', 'DISPOSITION_DECISION'),
    ('REC_DISPOSITION', 'DISPOSITION_ITEM'),
    ('REC_EVIDENCE', 'EVIDENCE_AMOUNT'),
    ('REC_EVIDENCE', 'EVIDENCE_DATE'),
    ('REC_EVIDENCE', 'EVIDENCE_KIND'),
    ('REC_EVIDENCE', 'EVIDENCE_SOURCE'),
    ('REPORTING_OBLIGATION', 'REPORT_DUE_DATE'),
    ('SECURITY', 'CURRENCY'),
    ('SECURITY', 'INSTRUMENT_TYPE'),
    ('SPONSOR', 'SPONSOR_NAME'),
    ('SPONSOR', 'SPONSOR_TYPE'),
    ('STATEMENT_PERIOD', 'STATEMENT_END'),
    ('STATEMENT_PERIOD', 'STATEMENT_REVENUE'),
    ('SYNDICATE_ORDER', 'ORDER_AMOUNT'),
    ('SYNDICATE_ORDER', 'ORDER_ALLOCATED_AMOUNT'),
    ('SYNDICATE_SEAT', 'SEAT_ROLE'),
    ('SYNDICATE_SEAT', 'SEAT_IS_HOUSE'),
    ('TRADE', 'TRADE_LABEL'),
    ('TRADE', 'TRADE_STATUS')
  ),
  wanted AS (
    SELECT ar.id,
           EXISTS (
             SELECT 1 FROM req r
             WHERE r.domain_code = ar.domain_code AND r.attribute_code = ar.attribute_code
           ) AS is_required
    FROM metadata_register.attribute_register ar
  )
  UPDATE metadata_register.attribute_register ar
  SET is_required = w.is_required,
      updated_at = NOW()
  FROM wanted w
  WHERE w.id = ar.id
    AND COALESCE(ar.is_required, false) IS DISTINCT FROM w.is_required;

  UPDATE metadata_register.template_attribute_assignments taa
  SET is_required = COALESCE(ar.is_required, false)
  FROM metadata_register.attribute_register ar
  WHERE ar.id = taa.attribute_id
    AND COALESCE(taa.is_required, false) IS DISTINCT FROM COALESCE(ar.is_required, false);
END $$;

-- 3. Rules that do not belong: a blank check, and a rule on an entity with no attributes.
DELETE FROM data_quality.dq_exceptions
WHERE rule_id IN (SELECT id FROM data_quality.dq_rules WHERE rule_code IN ('FUND_NAV_NOT_NULL', 'PRICE_NOT_NEGATIVE'));
DELETE FROM data_quality.dq_rules WHERE rule_code IN ('FUND_NAV_NOT_NULL', 'PRICE_NOT_NEGATIVE');

-- 4. The rules. Existing rules keep their id, so accepted exceptions stay attached.
--
-- As in 2, a rule whose attribute is not in the catalog at all (on a fresh
-- database, one supabase/seed adds after the migrations) is skipped with a
-- notice; a rule whose attribute sits on another entity stops the migration.
DO $$
DECLARE
  v_expected int := 177;
  v_found int;
  v_absent int;
  v_absent_list text;
BEGIN
  CREATE TEMP TABLE _dq_program_rules ON COMMIT DROP AS
  SELECT v.*, ar.id AS attribute_id
  FROM (VALUES
    ('ISSUER_LEI_FORMAT', 'LEI Format', 'ISSUER', 'LEI', 'VALIDITY', 'HIGH', 'LEI IS NULL OR LEI ~ ''^[A-Z0-9]{18}[0-9]{2}$''', 'A Legal Entity Identifier is 20 characters, and the last two are check digits. Private borrowers often have no LEI, so a blank passes.'),
    ('ISSUER_COUNTRY_ISO', 'Country Is ISO Code', 'ISSUER', 'COUNTRY', 'VALIDITY', 'HIGH', 'COUNTRY IS NULL OR COUNTRY ~ ''^[A-Z]{2}$''', 'Country should be a two-letter ISO 3166 code such as US, not a country name.'),
    ('ISSUER_DOMICILE_ISO', 'Domicile Is ISO Code', 'ISSUER', 'COUNTRY_OF_DOMICILE', 'VALIDITY', 'HIGH', 'COUNTRY_OF_DOMICILE IS NULL OR COUNTRY_OF_DOMICILE ~ ''^[A-Z]{2}$''', 'Country of domicile is tested against a CLO''s permitted jurisdictions, so it has to be a two-letter ISO code.'),
    ('ISSUER_RISK_COUNTRY_ISO', 'Country of Risk Is ISO Code', 'ISSUER', 'COUNTRY_OF_RISK', 'VALIDITY', 'MEDIUM', 'COUNTRY_OF_RISK IS NULL OR COUNTRY_OF_RISK ~ ''^[A-Z]{2}$''', 'Country of risk should be a two-letter ISO code.'),
    ('ISSUER_SECTOR_GICS', 'Sector Is GICS', 'ISSUER', 'SECTOR', 'VALIDITY', 'MEDIUM', 'SECTOR IS NULL OR SECTOR IN (''INDUSTRIALS'',''INFORMATION_TECHNOLOGY'',''ENERGY'',''MATERIALS'',''FINANCIALS'',''COMMUNICATION_SERVICES'',''UTILITIES'',''REAL_ESTATE'',''HEALTH_CARE'',''CONSUMER_STAPLES'',''CONSUMER_DISCRETIONARY'')', 'Sector should be a GICS sector so concentration reports group the same way every time.'),
    ('ISSUER_RATING_SCALE', 'Credit Rating on Scale', 'ISSUER', 'CREDIT_RATING', 'VALIDITY', 'HIGH', 'CREDIT_RATING IS NULL OR CREDIT_RATING IN (''AAA'',''AA+'',''AA'',''AA-'',''A+'',''A'',''A-'',''BBB+'',''BBB'',''BBB-'',''BB+'',''BB'',''BB-'',''B+'',''B'',''B-'',''CCC+'',''CCC'',''CCC-'',''CC'',''C'',''D'',''NR'',''AA_PLUS'',''AA_MINUS'',''A_PLUS'',''A_MINUS'',''BBB_PLUS'',''BBB_MINUS'',''BB_PLUS'',''BB_MINUS'',''B_PLUS'',''B_MINUS'',''CCC_PLUS'',''CCC_MINUS'')', 'Credit rating should be a known scale point, including NR when the issuer is unrated.'),
    ('ISSUER_MOODYS_RATING_SCALE', 'Moody''s Rating on Scale', 'ISSUER', 'MOODYS_ISSUER_RATING', 'VALIDITY', 'HIGH', 'MOODYS_ISSUER_RATING IS NULL OR MOODYS_ISSUER_RATING IN (''Aaa'',''Aa1'',''Aa2'',''Aa3'',''A1'',''A2'',''A3'',''Baa1'',''Baa2'',''Baa3'',''Ba1'',''Ba2'',''Ba3'',''B1'',''B2'',''B3'',''Caa1'',''Caa2'',''Caa3'',''Ca'',''C'',''NR'',''WR'')', 'Moody''s issuer rating drives WARF and the CCC bucket, so it has to be a point on the Moody''s scale.'),
    ('ISSUER_SP_RATING_SCALE', 'S&P Rating on Scale', 'ISSUER', 'SP_ISSUER_RATING', 'VALIDITY', 'HIGH', 'SP_ISSUER_RATING IS NULL OR SP_ISSUER_RATING IN (''AAA'',''AA+'',''AA'',''AA-'',''A+'',''A'',''A-'',''BBB+'',''BBB'',''BBB-'',''BB+'',''BB'',''BB-'',''B+'',''B'',''B-'',''CCC+'',''CCC'',''CCC-'',''CC'',''C'',''D'',''NR'')', 'S&P issuer rating should be a point on the S&P scale.'),
    ('ISSUER_FITCH_RATING_SCALE', 'Fitch Rating on Scale', 'ISSUER', 'FITCH_ISSUER_RATING', 'VALIDITY', 'MEDIUM', 'FITCH_ISSUER_RATING IS NULL OR FITCH_ISSUER_RATING IN (''AAA'',''AA+'',''AA'',''AA-'',''A+'',''A'',''A-'',''BBB+'',''BBB'',''BBB-'',''BB+'',''BB'',''BB-'',''B+'',''B'',''B-'',''CCC+'',''CCC'',''CCC-'',''CC'',''C'',''D'',''NR'')', 'Fitch issuer rating should be a point on the Fitch scale.'),
    ('ISSUER_MARKET_CAP_NONNEGATIVE', 'Market Cap Not Negative', 'ISSUER', 'MARKET_CAP', 'VALIDITY', 'MEDIUM', 'MARKET_CAP IS NULL OR MARKET_CAP >= 0', 'Market capitalization cannot be negative. Private borrowers have none, so a blank passes.'),
    ('ISSUER_LEVERAGE_NONNEGATIVE', 'Leverage Not Negative', 'ISSUER', 'TOTAL_NET_LEVERAGE_RATIO', 'VALIDITY', 'MEDIUM', 'TOTAL_NET_LEVERAGE_RATIO IS NULL OR TOTAL_NET_LEVERAGE_RATIO >= 0', 'Total net leverage is a ratio of debt to EBITDA and should not be stored as a negative number.'),
    ('ISSUER_COVERAGE_NONNEGATIVE', 'Interest Coverage Not Negative', 'ISSUER', 'INTEREST_COVERAGE_RATIO', 'VALIDITY', 'MEDIUM', 'INTEREST_COVERAGE_RATIO IS NULL OR INTEREST_COVERAGE_RATIO >= 0', 'Interest coverage should not be stored as a negative number.'),
    ('ISSUER_SENIOR_WITHIN_TOTAL_LEVERAGE', 'Senior Leverage Within Total', 'ISSUER', 'SENIOR_NET_LEVERAGE_RATIO', 'CONSISTENCY', 'HIGH', 'SENIOR_NET_LEVERAGE_RATIO IS NULL OR TOTAL_NET_LEVERAGE_RATIO IS NULL OR SENIOR_NET_LEVERAGE_RATIO <= TOTAL_NET_LEVERAGE_RATIO', 'Senior leverage is part of total leverage, so it cannot be the larger number.'),
    ('ISSUER_FINANCIALS_NOT_FUTURE', 'Financials Not Future Dated', 'ISSUER', 'FINANCIAL_REPORTING_PERIOD_DATE', 'VALIDITY', 'HIGH', 'FINANCIAL_REPORTING_PERIOD_DATE IS NULL OR FINANCIAL_REPORTING_PERIOD_DATE <= CURRENT_DATE', 'The latest financial statement date cannot be in the future.'),
    ('ISSUER_CREDIT_ESTIMATE_HAS_EXPIRY', 'Credit Estimate Has Expiry', 'ISSUER', 'CREDIT_ESTIMATE_RATING', 'COMPLETENESS', 'HIGH', 'CREDIT_ESTIMATE_RATING IS NULL OR CREDIT_ESTIMATE_EXPIRATION_DATE IS NOT NULL', 'A credit estimate lapses, and an expired one is downgraded. An estimate without an expiry date cannot be monitored.'),
    ('ISSUER_CREDIT_ESTIMATE_CURRENT', 'Credit Estimate Not Expired', 'ISSUER', 'CREDIT_ESTIMATE_EXPIRATION_DATE', 'TIMELINESS', 'HIGH', 'CREDIT_ESTIMATE_EXPIRATION_DATE IS NULL OR CREDIT_ESTIMATE_EXPIRATION_DATE >= CURRENT_DATE', 'The credit estimate has expired and needs to be renewed with the agency.'),
    ('ISSUER_CREDIT_ESTIMATE_DATES_ORDERED', 'Credit Estimate Dates in Order', 'ISSUER', 'CREDIT_ESTIMATE_EXPIRATION_DATE', 'CONSISTENCY', 'MEDIUM', 'CREDIT_ESTIMATE_EXPIRATION_DATE IS NULL OR CREDIT_ESTIMATE_EFFECTIVE_DATE IS NULL OR CREDIT_ESTIMATE_EXPIRATION_DATE > CREDIT_ESTIMATE_EFFECTIVE_DATE', 'A credit estimate expires after it takes effect.'),
    ('ISSUER_AFFILIATE_CONTROL_RANGE', 'Affiliate Control Percent in Range', 'ISSUER', 'AFFILIATE_CONTROL_PERCENTAGE', 'VALIDITY', 'HIGH', 'AFFILIATE_CONTROL_PERCENTAGE IS NULL OR AFFILIATE_CONTROL_PERCENTAGE >= 0 AND AFFILIATE_CONTROL_PERCENTAGE <= 100', 'Share of voting securities held by the manager or fund family, from 0 to 100. It decides 1940 Act affiliate status.'),
    ('SECURITY_ISIN_FORMAT', 'ISIN Format', 'SECURITY', 'ISIN', 'VALIDITY', 'HIGH', 'ISIN IS NULL OR ISIN ~ ''^[A-Z]{2}[A-Z0-9]{9}[0-9]$''', 'When an ISIN is present it must be 12 characters: two letters, nine letters or digits, and a numeric check digit.'),
    ('SECURITY_CUSIP_FORMAT', 'CUSIP Format', 'SECURITY', 'CUSIP', 'VALIDITY', 'HIGH', 'CUSIP IS NULL OR CUSIP ~ ''^[A-Z0-9]{9}$''', 'A CUSIP is nine letters or digits.'),
    ('SECURITY_CUSIP_144A_FORMAT', '144A CUSIP Format', 'SECURITY', 'CUSIP_144A_CODE', 'VALIDITY', 'MEDIUM', 'CUSIP_144A_CODE IS NULL OR CUSIP_144A_CODE ~ ''^[A-Z0-9]{9}$''', 'A 144A CUSIP is nine letters or digits.'),
    ('SECURITY_CURRENCY_ISO', 'Currency Is ISO Code', 'SECURITY', 'CURRENCY', 'VALIDITY', 'HIGH', 'CURRENCY IS NULL OR CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('SECURITY_DENOMINATION_MATCHES_CURRENCY', 'Denomination Matches Currency', 'SECURITY', 'DENOMINATION_CURRENCY', 'CONSISTENCY', 'HIGH', 'DENOMINATION_CURRENCY IS NULL OR CURRENCY IS NULL OR DENOMINATION_CURRENCY = CURRENCY', 'Currency and denomination currency describe the same thing. When both are filled in they have to agree.'),
    ('SECURITY_INSTRUMENT_TYPE', 'Instrument Type Allowed', 'SECURITY', 'INSTRUMENT_TYPE', 'VALIDITY', 'HIGH', 'INSTRUMENT_TYPE IS NULL OR INSTRUMENT_TYPE IN (''BOND'',''LOAN'',''EQUITY'',''DERIVATIVE'',''UNITRANCHE'',''REVOLVING_CREDIT'',''MEZZANINE'',''PREFERRED_EQUITY'',''DELAYED_DRAW_TERM_LOAN'',''SECOND_LIEN_LOAN'',''WARRANT'')', 'Instrument type should be one of the standard classifications used for exposure reports and fund mandates.'),
    ('SECURITY_DEBT_HAS_MATURITY', 'Debt Has a Maturity Date', 'SECURITY', 'INSTRUMENT_TYPE', 'COMPLETENESS', 'HIGH', 'INSTRUMENT_TYPE IS NULL OR INSTRUMENT_TYPE IN (''EQUITY'',''PREFERRED_EQUITY'',''DERIVATIVE'',''WARRANT'') OR MATURITY_DATE IS NOT NULL', 'Every loan and bond matures. Equity, warrants, and derivatives are exempt.'),
    ('SECURITY_MATURITY_PLAUSIBLE', 'Maturity Date Plausible', 'SECURITY', 'MATURITY_DATE', 'VALIDITY', 'MEDIUM', 'MATURITY_DATE IS NULL OR MATURITY_DATE >= ''1990-01-01''', 'Maturity should be a real date on or after 1990. Dates before that are almost always a bad load.'),
    ('SECURITY_MATURITY_AFTER_ISSUANCE', 'Maturity After Issuance', 'SECURITY', 'MATURITY_DATE', 'CONSISTENCY', 'HIGH', 'MATURITY_DATE IS NULL OR ISSUANCE_DATE IS NULL OR MATURITY_DATE > ISSUANCE_DATE', 'A security matures after it is issued.'),
    ('SECURITY_ISSUANCE_NOT_FUTURE', 'Issuance Not Future Dated', 'SECURITY', 'ISSUANCE_DATE', 'VALIDITY', 'HIGH', 'ISSUANCE_DATE IS NULL OR ISSUANCE_DATE <= CURRENT_DATE', 'Issuance date cannot be in the future.'),
    ('SECURITY_PRINCIPAL_POSITIVE', 'Original Principal Positive', 'SECURITY', 'ORIGINAL_PRINCIPAL_AMOUNT', 'VALIDITY', 'HIGH', 'ORIGINAL_PRINCIPAL_AMOUNT IS NULL OR ORIGINAL_PRINCIPAL_AMOUNT > 0', 'Original principal, when present, has to be greater than zero.'),
    ('SECURITY_OUTSTANDING_NONNEGATIVE', 'Outstanding Amount Not Negative', 'SECURITY', 'CURRENT_OUTSTANDING_AMOUNT', 'VALIDITY', 'HIGH', 'CURRENT_OUTSTANDING_AMOUNT IS NULL OR CURRENT_OUTSTANDING_AMOUNT >= 0', 'Principal outstanding cannot be negative.'),
    ('SECURITY_COUPON_NONNEGATIVE', 'Coupon Not Negative', 'SECURITY', 'COUPON_RATE', 'VALIDITY', 'MEDIUM', 'COUPON_RATE IS NULL OR COUPON_RATE >= 0', 'Coupon rate cannot be negative.'),
    ('SECURITY_SPREAD_NONNEGATIVE', 'Spread Not Negative', 'SECURITY', 'SPREAD_BPS', 'VALIDITY', 'MEDIUM', 'SPREAD_BPS IS NULL OR SPREAD_BPS >= 0', 'Credit spread in basis points cannot be negative.'),
    ('SECURITY_PRICE_NONNEGATIVE', 'Price Not Negative', 'SECURITY', 'PRICE', 'VALIDITY', 'HIGH', 'PRICE IS NULL OR PRICE >= 0', 'A security price cannot be negative.'),
    ('SECURITY_FLOATING_HAS_SPREAD', 'Floating Rate Has a Spread', 'SECURITY', 'IS_FIXED_RATE', 'COMPLETENESS', 'HIGH', 'IS_FIXED_RATE IS NULL OR IS_FIXED_RATE IN (''true'') OR SPREAD_BPS IS NOT NULL', 'A floating-rate obligation pays an index plus a spread. Without the spread, income and weighted average spread are wrong.'),
    ('SECURITY_FIXED_HAS_COUPON', 'Fixed Rate Has a Coupon', 'SECURITY', 'IS_FIXED_RATE', 'COMPLETENESS', 'HIGH', 'IS_FIXED_RATE IS NULL OR IS_FIXED_RATE IN (''false'') OR COUPON_RATE IS NOT NULL', 'A fixed-rate obligation needs its coupon rate.'),
    ('SECURITY_DEFAULT_HAS_DATE', 'Defaulted Obligation Has a Default Date', 'SECURITY', 'IS_DEFAULTED', 'COMPLETENESS', 'HIGH', 'IS_DEFAULTED IS NULL OR IS_DEFAULTED IN (''false'') OR DEFAULT_DATE IS NOT NULL', 'The default date starts the clock on how a CLO carries a defaulted obligation, so a defaulted obligation needs one.'),
    ('SECURITY_DEFAULT_NOT_FUTURE', 'Default Date Not Future Dated', 'SECURITY', 'DEFAULT_DATE', 'VALIDITY', 'HIGH', 'DEFAULT_DATE IS NULL OR DEFAULT_DATE <= CURRENT_DATE', 'A default date cannot be in the future.'),
    ('SECURITY_MOODYS_FACILITY_RATING_SCALE', 'Moody''s Facility Rating on Scale', 'SECURITY', 'CLO_MOODYS_FACILITY_RATING', 'VALIDITY', 'HIGH', 'CLO_MOODYS_FACILITY_RATING IS NULL OR CLO_MOODYS_FACILITY_RATING IN (''Aaa'',''Aa1'',''Aa2'',''Aa3'',''A1'',''A2'',''A3'',''Baa1'',''Baa2'',''Baa3'',''Ba1'',''Ba2'',''Ba3'',''B1'',''B2'',''B3'',''Caa1'',''Caa2'',''Caa3'',''Ca'',''C'',''NR'',''WR'')', 'Moody''s facility rating should be a point on the Moody''s scale.'),
    ('SECURITY_SP_FACILITY_RATING_SCALE', 'S&P Facility Rating on Scale', 'SECURITY', 'CLO_SP_FACILITY_RATING', 'VALIDITY', 'HIGH', 'CLO_SP_FACILITY_RATING IS NULL OR CLO_SP_FACILITY_RATING IN (''AAA'',''AA+'',''AA'',''AA-'',''A+'',''A'',''A-'',''BBB+'',''BBB'',''BBB-'',''BB+'',''BB'',''BB-'',''B+'',''B'',''B-'',''CCC+'',''CCC'',''CCC-'',''CC'',''C'',''D'',''NR'')', 'S&P facility rating should be a point on the S&P scale.'),
    ('SECURITY_MOODYS_RECOVERY_RANGE', 'Moody''s Recovery Rate in Range', 'SECURITY', 'CLO_MOODYS_RECOVERY_RATE', 'VALIDITY', 'HIGH', 'CLO_MOODYS_RECOVERY_RATE IS NULL OR CLO_MOODYS_RECOVERY_RATE >= 0 AND CLO_MOODYS_RECOVERY_RATE <= 100', 'Recovery rate is a percent from 0 to 100.'),
    ('SECURITY_SP_RECOVERY_RANGE', 'S&P Recovery Rate in Range', 'SECURITY', 'CLO_SP_RECOVERY_RATE', 'VALIDITY', 'HIGH', 'CLO_SP_RECOVERY_RATE IS NULL OR CLO_SP_RECOVERY_RATE >= 0 AND CLO_SP_RECOVERY_RATE <= 100', 'Recovery rate is a percent from 0 to 100.'),
    ('SECURITY_OID_RANGE', 'OID in Range', 'SECURITY', 'ORIGINAL_ISSUE_DISCOUNT', 'VALIDITY', 'MEDIUM', 'ORIGINAL_ISSUE_DISCOUNT IS NULL OR ORIGINAL_ISSUE_DISCOUNT >= 0 AND ORIGINAL_ISSUE_DISCOUNT <= 50', 'Original issue discount is a percent of par. More than 50 is almost always a price loaded as a discount.'),
    ('POSITION_MARKET_VALUE_NONNEGATIVE', 'Market Value Not Negative', 'POSITION', 'MARKET_VALUE', 'VALIDITY', 'HIGH', 'MARKET_VALUE IS NULL OR MARKET_VALUE >= 0', 'Position market value cannot be negative in this long-only book.'),
    ('POSITION_QUANTITY_NONNEGATIVE', 'Quantity Not Negative', 'POSITION', 'QUANTITY', 'VALIDITY', 'HIGH', 'QUANTITY IS NULL OR QUANTITY >= 0', 'Position quantity cannot be negative in this long-only book.'),
    ('POSITION_COST_NONNEGATIVE', 'Cost Basis Not Negative', 'POSITION', 'COST_BASIS', 'VALIDITY', 'HIGH', 'COST_BASIS IS NULL OR COST_BASIS >= 0', 'Cost basis cannot be negative.'),
    ('POSITION_FUNDED_PAR_NONNEGATIVE', 'Funded Par Not Negative', 'POSITION', 'FUNDED_PAR_AMOUNT', 'VALIDITY', 'HIGH', 'FUNDED_PAR_AMOUNT IS NULL OR FUNDED_PAR_AMOUNT >= 0', 'Funded par cannot be negative.'),
    ('POSITION_UNFUNDED_NONNEGATIVE', 'Unfunded Commitment Not Negative', 'POSITION', 'UNFUNDED_COMMITMENT_AMOUNT', 'VALIDITY', 'HIGH', 'UNFUNDED_COMMITMENT_AMOUNT IS NULL OR UNFUNDED_COMMITMENT_AMOUNT >= 0', 'An unfunded commitment cannot be negative. It feeds the liquidity coverage test.'),
    ('POSITION_PRICE_NONNEGATIVE', 'Fair Market Price Not Negative', 'POSITION', 'FAIR_MARKET_PRICE', 'VALIDITY', 'HIGH', 'FAIR_MARKET_PRICE IS NULL OR FAIR_MARKET_PRICE >= 0', 'Fair market price cannot be negative.'),
    ('POSITION_MARK_RANGE', 'Administrator Mark in Range', 'POSITION', 'POSITION_MARK', 'VALIDITY', 'HIGH', 'POSITION_MARK IS NULL OR POSITION_MARK >= 1 AND POSITION_MARK <= 150', 'A mark is a percent of par. Zero, or more than 150, is usually a mark that was not loaded or a price loaded in the wrong units.'),
    ('POSITION_AGENT_MARK_RANGE', 'Agent Mark in Range', 'POSITION', 'POSITION_AGENT_MARK', 'VALIDITY', 'HIGH', 'POSITION_AGENT_MARK IS NULL OR POSITION_AGENT_MARK >= 1 AND POSITION_AGENT_MARK <= 150', 'The valuation agent''s mark is a percent of par, expected between 1 and 150.'),
    ('POSITION_CURRENCY_ISO', 'Position Currency Is ISO Code', 'POSITION', 'POSITION_CURRENCY', 'VALIDITY', 'HIGH', 'POSITION_CURRENCY IS NULL OR POSITION_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('POSITION_TYPE_ALLOWED', 'Position Type Allowed', 'POSITION', 'POSITION_TYPE', 'VALIDITY', 'MEDIUM', 'POSITION_TYPE IS NULL OR POSITION_TYPE IN (''EQUITY'',''DEBT'',''OTHER'')', 'Position type should be Equity, Debt, or Other.'),
    ('POSITION_VALUATION_LEVEL', 'Fair Value Level Allowed', 'POSITION', 'VALUATION_HIERARCHY_LEVEL', 'VALIDITY', 'HIGH', 'VALUATION_HIERARCHY_LEVEL IS NULL OR VALUATION_HIERARCHY_LEVEL IN (''Level_1'',''Level_2'',''Level_3'')', 'GAAP fair-value level should be Level 1, Level 2, or Level 3.'),
    ('POSITION_LEVEL_HAS_SOURCE', 'Fair Value Level Has a Source', 'POSITION', 'VALUATION_HIERARCHY_LEVEL', 'COMPLETENESS', 'HIGH', 'VALUATION_HIERARCHY_LEVEL IS NULL OR VALUATION_SOURCE IS NOT NULL', 'A fair-value level is a statement about where the price came from, so the valuation source has to be recorded with it.'),
    ('POSITION_DAILY_RETURN_RANGE', 'Daily Return in Range', 'POSITION', 'DAILY_RETURN', 'VALIDITY', 'MEDIUM', 'DAILY_RETURN IS NULL OR DAILY_RETURN >= -100 AND DAILY_RETURN <= 100', 'Daily return is a percent and should sit between -100 and 100. A larger number is usually a units error.'),
    ('POSITION_METRIC_NOT_FUTURE', 'Metric Date Not Future Dated', 'POSITION', 'METRIC_DATE', 'VALIDITY', 'HIGH', 'METRIC_DATE IS NULL OR METRIC_DATE <= CURRENT_DATE', 'The date the position metrics were measured cannot be in the future.'),
    ('POSITION_TRADE_NOT_FUTURE', 'Trade Date Not Future Dated', 'POSITION', 'TRADE_DATE', 'VALIDITY', 'HIGH', 'TRADE_DATE IS NULL OR TRADE_DATE <= CURRENT_DATE', 'Trade date cannot be in the future.'),
    ('POSITION_SETTLE_AFTER_TRADE', 'Settlement On or After Trade', 'POSITION', 'SETTLEMENT_DATE', 'CONSISTENCY', 'HIGH', 'SETTLEMENT_DATE IS NULL OR TRADE_DATE IS NULL OR SETTLEMENT_DATE >= TRADE_DATE', 'A trade settles on or after the day it was executed.'),
    ('POSITION_NON_ACCRUAL_HAS_DATE', 'Non-Accrual Has an Effective Date', 'POSITION', 'IS_NON_ACCRUAL', 'COMPLETENESS', 'HIGH', 'IS_NON_ACCRUAL IS NULL OR IS_NON_ACCRUAL IN (''false'') OR NON_ACCRUAL_EFFECTIVE_DATE IS NOT NULL', 'Income stops being recognised from the non-accrual date, so a position on non-accrual needs one.'),
    ('POSITION_NON_ACCRUAL_NOT_FUTURE', 'Non-Accrual Date Not Future Dated', 'POSITION', 'NON_ACCRUAL_EFFECTIVE_DATE', 'VALIDITY', 'HIGH', 'NON_ACCRUAL_EFFECTIVE_DATE IS NULL OR NON_ACCRUAL_EFFECTIVE_DATE <= CURRENT_DATE', 'A position cannot be placed on non-accrual in the future.'),
    ('POSITION_PLEDGED_HAS_FACILITY', 'Pledged Position Names Its Facility', 'POSITION', 'IS_PLEDGED_COLLATERAL', 'COMPLETENESS', 'HIGH', 'IS_PLEDGED_COLLATERAL IS NULL OR IS_PLEDGED_COLLATERAL IN (''false'') OR PLEDGED_FACILITY_ID IS NOT NULL', 'A pledged position has to say which credit facility it secures, or the borrowing base cannot be tied.'),
    ('POSITION_ACCRUED_INTEREST_NONNEGATIVE', 'Accrued Interest Not Negative', 'POSITION', 'ACCRUED_CASH_INTEREST_AMOUNT', 'VALIDITY', 'HIGH', 'ACCRUED_CASH_INTEREST_AMOUNT IS NULL OR ACCRUED_CASH_INTEREST_AMOUNT >= 0', 'Interest receivable cannot be negative.'),
    ('POSITION_PIK_BALANCE_NONNEGATIVE', 'Capitalized PIK Not Negative', 'POSITION', 'CAPITALIZED_PIK_PRINCIPAL_BALANCE', 'VALIDITY', 'HIGH', 'CAPITALIZED_PIK_PRINCIPAL_BALANCE IS NULL OR CAPITALIZED_PIK_PRINCIPAL_BALANCE >= 0', 'Capitalized PIK only ever adds to principal.'),
    ('CASHFLOW_PAYMENT_STATUS_ALLOWED', 'Payment Status Allowed', 'CASH_FLOW', 'PAYMENT_STATUS', 'VALIDITY', 'HIGH', 'PAYMENT_STATUS IS NULL OR PAYMENT_STATUS IN (''EXPECTED'',''RECEIVED'',''PAID'')', 'Payment status should be Expected, Received, or Paid.'),
    ('CASHFLOW_AMOUNT_NONZERO', 'Amount Not Zero', 'CASH_FLOW', 'AMOUNT', 'VALIDITY', 'MEDIUM', 'AMOUNT IS NULL OR AMOUNT <> 0', 'A cash flow of zero is not a cash flow. It usually means the amount failed to load.'),
    ('CASHFLOW_SETTLED_NOT_FUTURE', 'Settled Cash Flow Not Future Dated', 'CASH_FLOW', 'CASHFLOW_DATE', 'CONSISTENCY', 'HIGH', 'CASHFLOW_DATE IS NULL OR PAYMENT_STATUS IS NULL OR PAYMENT_STATUS IN (''EXPECTED'') OR CASHFLOW_DATE <= CURRENT_DATE', 'Cash that is marked received or paid cannot be dated in the future.'),
    ('CASHFLOW_EXPECTED_NOT_OVERDUE', 'Expected Cash Flow Not Overdue', 'CASH_FLOW', 'CASHFLOW_DATE', 'TIMELINESS', 'HIGH', 'CASHFLOW_DATE IS NULL OR PAYMENT_STATUS IS NULL OR PAYMENT_STATUS IN (''RECEIVED'',''PAID'') OR CASHFLOW_DATE >= CURRENT_DATE', 'A cash flow whose date has passed is still marked expected. Either the cash arrived and was not recorded, or it is late.'),
    ('FUND_NAV_NONNEGATIVE', 'NAV Not Negative', 'FUND', 'NAV', 'VALIDITY', 'CRITICAL', 'NAV IS NULL OR NAV >= 0', 'Net asset value cannot be negative.'),
    ('FUND_NAV_DATE_NOT_FUTURE', 'NAV Date Not Future Dated', 'FUND', 'NAV_DATE', 'VALIDITY', 'CRITICAL', 'NAV_DATE IS NULL OR NAV_DATE <= CURRENT_DATE', 'A NAV cannot be struck for a date that has not happened.'),
    ('FUND_NAV_CURRENCY_ISO', 'NAV Currency Is ISO Code', 'FUND', 'NAV_CURRENCY', 'VALIDITY', 'HIGH', 'NAV_CURRENCY IS NULL OR NAV_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('FUND_DOMICILE_ISO', 'Domicile Is ISO Code', 'FUND', 'DOMICILE', 'VALIDITY', 'MEDIUM', 'DOMICILE IS NULL OR DOMICILE ~ ''^[A-Z]{2}$''', 'Fund domicile should be a two-letter ISO country code.'),
    ('FUND_INCEPTION_NOT_FUTURE', 'Inception Not Future Dated', 'FUND', 'INCEPTION_DATE', 'VALIDITY', 'MEDIUM', 'INCEPTION_DATE IS NULL OR INCEPTION_DATE <= CURRENT_DATE', 'Inception date cannot be in the future.'),
    ('FUND_INVESTMENT_PERIOD_AFTER_INCEPTION', 'Investment Period Ends After Inception', 'FUND', 'FUND_INVESTMENT_PERIOD_END', 'CONSISTENCY', 'MEDIUM', 'FUND_INVESTMENT_PERIOD_END IS NULL OR INCEPTION_DATE IS NULL OR FUND_INVESTMENT_PERIOD_END > INCEPTION_DATE', 'The investment period ends after the fund starts.'),
    ('FUND_COMMITMENTS_POSITIVE', 'Total Commitments Positive', 'FUND', 'FUND_TOTAL_COMMITMENTS', 'VALIDITY', 'HIGH', 'FUND_TOTAL_COMMITMENTS IS NULL OR FUND_TOTAL_COMMITMENTS > 0', 'Total commitments, when recorded, have to be greater than zero. They are the fee base and the denominator of percent called.'),
    ('FUND_MGMT_FEE_RANGE', 'Management Fee in Range', 'FUND', 'FUND_MGMT_FEE_PCT', 'VALIDITY', 'HIGH', 'FUND_MGMT_FEE_PCT IS NULL OR FUND_MGMT_FEE_PCT >= 0 AND FUND_MGMT_FEE_PCT <= 5', 'Annual management fee in percent. More than 5 is almost always a fee entered in basis points.'),
    ('FUND_CARRY_RANGE', 'Carried Interest in Range', 'FUND', 'FUND_CARRY_PCT', 'VALIDITY', 'HIGH', 'FUND_CARRY_PCT IS NULL OR FUND_CARRY_PCT >= 0 AND FUND_CARRY_PCT <= 50', 'Carried interest in percent, from 0 to 50.'),
    ('FUND_HURDLE_RANGE', 'Preferred Return in Range', 'FUND', 'FUND_HURDLE_PCT', 'VALIDITY', 'HIGH', 'FUND_HURDLE_PCT IS NULL OR FUND_HURDLE_PCT >= 0 AND FUND_HURDLE_PCT <= 20', 'Annual preferred return in percent, from 0 to 20.'),
    ('FUND_ISSUER_LIMIT_RANGE', 'Single-Issuer Limit in Range', 'FUND', 'FUND_SINGLE_ISSUER_LIMIT_PCT', 'VALIDITY', 'HIGH', 'FUND_SINGLE_ISSUER_LIMIT_PCT IS NULL OR FUND_SINGLE_ISSUER_LIMIT_PCT > 0 AND FUND_SINGLE_ISSUER_LIMIT_PCT <= 100', 'A concentration limit is a percent of NAV greater than 0 and no more than 100. A limit of zero blocks every allocation.'),
    ('FUND_INDEPENDENT_WITHIN_BOARD', 'Independent Directors Within Board', 'FUND', 'INDEPENDENT_MEMBER_COUNT', 'CONSISTENCY', 'HIGH', 'INDEPENDENT_MEMBER_COUNT IS NULL OR BOARD_MEMBER_COUNT IS NULL OR INDEPENDENT_MEMBER_COUNT <= BOARD_MEMBER_COUNT', 'Independent directors are a subset of the board.'),
    ('FUND_CASH_NONNEGATIVE', 'Cash on Hand Not Negative', 'FUND', 'FUND_CASH_BALANCE', 'VALIDITY', 'HIGH', 'FUND_CASH_BALANCE IS NULL OR FUND_CASH_BALANCE >= 0', 'Cash available to deploy cannot be negative. An overdraft belongs on the credit facility.'),
    ('NAVSTMT_PERIOD_NOT_FUTURE', 'Period End Not Future Dated', 'NAV_STATEMENT', 'STATEMENT_PERIOD_END', 'VALIDITY', 'CRITICAL', 'STATEMENT_PERIOD_END IS NULL OR STATEMENT_PERIOD_END <= CURRENT_DATE', 'An administrator statement cannot cover a period that has not ended.'),
    ('NAVSTMT_RECEIVED_AFTER_PERIOD', 'Received After Period End', 'NAV_STATEMENT', 'STATEMENT_RECEIVED_DATE', 'CONSISTENCY', 'HIGH', 'STATEMENT_RECEIVED_DATE IS NULL OR STATEMENT_PERIOD_END IS NULL OR STATEMENT_RECEIVED_DATE >= STATEMENT_PERIOD_END', 'The administrator pack arrives after the period it reports on.'),
    ('NAVSTMT_ROLLFORWARD_TIES', 'Roll-forward Ties to Net Assets', 'NAV_STATEMENT', 'NAV_RF_ENDING', 'CONSISTENCY', 'CRITICAL', 'NAV_RF_ENDING IS NULL OR NAV_BS_NET_ASSETS IS NULL OR NAV_RF_ENDING = NAV_BS_NET_ASSETS', 'Ending NAV on the roll-forward has to equal net assets on the balance sheet.'),
    ('NAVSTMT_CHANGES_TIE', 'Changes in Net Assets Ties', 'NAV_STATEMENT', 'NAV_CH_ENDING', 'CONSISTENCY', 'CRITICAL', 'NAV_CH_ENDING IS NULL OR NAV_BS_NET_ASSETS IS NULL OR NAV_CH_ENDING = NAV_BS_NET_ASSETS', 'End of period on the statement of changes has to equal net assets on the balance sheet.'),
    ('NAVSTMT_CASH_TIES', 'Cash Flow Statement Ties to Cash', 'NAV_STATEMENT', 'NAV_CF_ENDING', 'CONSISTENCY', 'CRITICAL', 'NAV_CF_ENDING IS NULL OR NAV_BS_CASH IS NULL OR NAV_CF_ENDING = NAV_BS_CASH', 'Ending cash on the cash flow statement has to equal cash on the balance sheet.'),
    ('NAVSTMT_OPERATIONS_TIE', 'Operations Ties to Changes in Net Assets', 'NAV_STATEMENT', 'NAV_OP_NET_INCREASE', 'CONSISTENCY', 'CRITICAL', 'NAV_OP_NET_INCREASE IS NULL OR NAV_CH_NET_OPERATIONS IS NULL OR NAV_OP_NET_INCREASE = NAV_CH_NET_OPERATIONS', 'The net increase from operations is the same number on the statement of operations and the statement of changes.'),
    ('NAVSTMT_OPENING_TIES', 'Opening NAV Agrees Across Statements', 'NAV_STATEMENT', 'NAV_RF_BEGINNING', 'CONSISTENCY', 'CRITICAL', 'NAV_RF_BEGINNING IS NULL OR NAV_CH_BEGINNING IS NULL OR NAV_RF_BEGINNING = NAV_CH_BEGINNING', 'Beginning NAV is the same number on the roll-forward and the statement of changes.'),
    ('NAVSTMT_TOLERANCE_RANGE', 'Review Tolerance in Range', 'NAV_STATEMENT', 'STATEMENT_TOLERANCE_PCT', 'VALIDITY', 'HIGH', 'STATEMENT_TOLERANCE_PCT IS NULL OR STATEMENT_TOLERANCE_PCT >= 0 AND STATEMENT_TOLERANCE_PCT <= 5', 'Review tolerance is a percent of the shadow NAV. A tolerance above 5 would wave through material breaks.'),
    ('STMT_REVENUE_NONNEGATIVE', 'Revenue Not Negative', 'STATEMENT_PERIOD', 'STATEMENT_REVENUE', 'VALIDITY', 'HIGH', 'STATEMENT_REVENUE IS NULL OR STATEMENT_REVENUE >= 0', 'Revenue cannot be negative.'),
    ('STMT_CASH_NONNEGATIVE', 'Cash Not Negative', 'STATEMENT_PERIOD', 'STATEMENT_CASH', 'VALIDITY', 'HIGH', 'STATEMENT_CASH IS NULL OR STATEMENT_CASH >= 0', 'Cash and equivalents cannot be negative.'),
    ('STMT_DEBT_NONNEGATIVE', 'Term Loan Not Negative', 'STATEMENT_PERIOD', 'STATEMENT_DEBT', 'VALIDITY', 'HIGH', 'STATEMENT_DEBT IS NULL OR STATEMENT_DEBT >= 0', 'The term loan balance cannot be negative.'),
    ('FINPERIOD_REVENUE_NONNEGATIVE', 'Revenue Not Negative', 'FINANCIAL_PERIOD', 'PERIOD_REVENUE', 'VALIDITY', 'HIGH', 'PERIOD_REVENUE IS NULL OR PERIOD_REVENUE >= 0', 'Revenue cannot be negative.'),
    ('FINPERIOD_MARGIN_RANGE', 'EBITDA Margin in Range', 'FINANCIAL_PERIOD', 'PERIOD_EBITDA_MARGIN', 'VALIDITY', 'MEDIUM', 'PERIOD_EBITDA_MARGIN IS NULL OR PERIOD_EBITDA_MARGIN >= -100 AND PERIOD_EBITDA_MARGIN <= 100', 'EBITDA margin is a percent of revenue.'),
    ('FINPERIOD_EBITDA_WITHIN_REVENUE', 'EBITDA Within Revenue', 'FINANCIAL_PERIOD', 'PERIOD_EBITDA', 'CONSISTENCY', 'HIGH', 'PERIOD_EBITDA IS NULL OR PERIOD_REVENUE IS NULL OR PERIOD_EBITDA <= PERIOD_REVENUE', 'EBITDA cannot be larger than revenue. When it is, the two are usually in different units.'),
    ('DEAL_DATE_NOT_FUTURE', 'Deal Date Not Future Dated', 'DEAL', 'DEAL_DATE', 'VALIDITY', 'MEDIUM', 'DEAL_DATE IS NULL OR DEAL_DATE <= CURRENT_DATE', 'Deal date cannot be in the future.'),
    ('DEAL_MATURITY_AFTER_CLOSE', 'Maturity After Close', 'DEAL', 'DEAL_MATURITY_DATE', 'CONSISTENCY', 'HIGH', 'DEAL_MATURITY_DATE IS NULL OR DEAL_TARGET_CLOSE_DATE IS NULL OR DEAL_MATURITY_DATE > DEAL_TARGET_CLOSE_DATE', 'The financing matures after it closes.'),
    ('DEAL_OID_PRICE_RANGE', 'OID Price in Range', 'DEAL', 'DEAL_OID_PRICE', 'VALIDITY', 'HIGH', 'DEAL_OID_PRICE IS NULL OR DEAL_OID_PRICE >= 50 AND DEAL_OID_PRICE <= 100', 'Original issue price is a percent of par, at or below 100.'),
    ('DEAL_SENIOR_WITHIN_TOTAL_LEVERAGE', 'Senior Leverage Within Total', 'DEAL', 'DEAL_LEVERAGE_SENIOR', 'CONSISTENCY', 'HIGH', 'DEAL_LEVERAGE_SENIOR IS NULL OR DEAL_LEVERAGE_TOTAL IS NULL OR DEAL_LEVERAGE_SENIOR <= DEAL_LEVERAGE_TOTAL', 'Senior leverage is part of total leverage, so it cannot be the larger number.'),
    ('DEAL_MARK_HAS_DATE', 'Mark Has a Date', 'DEAL', 'SERVICING_MARK', 'COMPLETENESS', 'HIGH', 'SERVICING_MARK IS NULL OR SERVICING_MARK_DATE IS NOT NULL', 'An internal mark without the date it was set cannot be judged for staleness.'),
    ('DEAL_MARK_RANGE', 'Internal Mark in Range', 'DEAL', 'SERVICING_MARK', 'VALIDITY', 'HIGH', 'SERVICING_MARK IS NULL OR SERVICING_MARK >= 1 AND SERVICING_MARK <= 150', 'The internal mark is a percent of par, expected between 1 and 150.'),
    ('DEAL_MARK_DATE_NOT_FUTURE', 'Mark Date Not Future Dated', 'DEAL', 'SERVICING_MARK_DATE', 'VALIDITY', 'HIGH', 'SERVICING_MARK_DATE IS NULL OR SERVICING_MARK_DATE <= CURRENT_DATE', 'A mark cannot be set in the future.'),
    ('DEAL_REALIZED_LOSS_NONNEGATIVE', 'Realised Loss Not Negative', 'DEAL', 'SERVICING_REALIZED_LOSS', 'VALIDITY', 'MEDIUM', 'SERVICING_REALIZED_LOSS IS NULL OR SERVICING_REALIZED_LOSS >= 0', 'A realised loss is stored as a positive amount.'),
    ('DEAL_VALUE_NONNEGATIVE', 'Deal Value Not Negative', 'DEAL', 'DEAL_VALUE', 'VALIDITY', 'MEDIUM', 'DEAL_VALUE IS NULL OR DEAL_VALUE >= 0', 'Total deal value cannot be negative.'),
    ('TRANCHE_SIZE_POSITIVE', 'Tranche Size Positive', 'DEAL_TRANCHE', 'TRANCHE_SIZE', 'VALIDITY', 'HIGH', 'TRANCHE_SIZE IS NULL OR TRANCHE_SIZE > 0', 'A tranche has a size greater than zero.'),
    ('TRANCHE_HOLD_RANGE', 'Hold Percent in Range', 'DEAL_TRANCHE', 'TRANCHE_HOLD_PCT', 'VALIDITY', 'HIGH', 'TRANCHE_HOLD_PCT IS NULL OR TRANCHE_HOLD_PCT >= 0 AND TRANCHE_HOLD_PCT <= 100', 'Our hold is a share of the tranche, from 0 to 100 percent.'),
    ('TRANCHE_RANK_VALID', 'Seniority Rank Valid', 'DEAL_TRANCHE', 'TRANCHE_RANK', 'VALIDITY', 'MEDIUM', 'TRANCHE_RANK IS NULL OR TRANCHE_RANK >= 1', 'Seniority rank starts at 1 for the most senior tranche.'),
    ('DOC_SIGNATURES_WITHIN_REQUIRED', 'Signatures Within Required', 'DEAL_DOCUMENT', 'DOC_SIGNATURES_RECEIVED', 'CONSISTENCY', 'MEDIUM', 'DOC_SIGNATURES_RECEIVED IS NULL OR DOC_SIGNATURES_REQUIRED IS NULL OR DOC_SIGNATURES_RECEIVED <= DOC_SIGNATURES_REQUIRED', 'A document cannot have more signatures than it needs.'),
    ('DOC_EXECUTED_FULLY_SIGNED', 'Executed Document Is Fully Signed', 'DEAL_DOCUMENT', 'DOC_STATUS', 'CONSISTENCY', 'HIGH', 'DOC_STATUS IS NULL OR DOC_STATUS IN (''DRAFT'',''IN_REVIEW'') OR DOC_SIGNATURES_RECEIVED >= DOC_SIGNATURES_REQUIRED', 'A document marked executed has every signature it requires.'),
    ('IC_DECISION_HAS_DATE', 'Decision Has a Date', 'IC_APPROVAL', 'APPROVAL_DECISION', 'COMPLETENESS', 'HIGH', 'APPROVAL_DECISION IS NULL OR APPROVAL_DECISION IN (''PENDING'') OR APPROVAL_DATE IS NOT NULL', 'An approval, decline, or abstention has to carry the date it was given. It is the audit record of the committee.'),
    ('IC_DECISION_NOT_FUTURE', 'Decision Not Future Dated', 'IC_APPROVAL', 'APPROVAL_DATE', 'VALIDITY', 'HIGH', 'APPROVAL_DATE IS NULL OR APPROVAL_DATE <= CURRENT_DATE', 'A committee decision cannot be dated in the future.'),
    ('SYNDICATE_ORDER_NONNEGATIVE', 'Order Amount Not Negative', 'SYNDICATE_ORDER', 'ORDER_AMOUNT', 'VALIDITY', 'HIGH', 'ORDER_AMOUNT IS NULL OR ORDER_AMOUNT >= 0', 'An order amount cannot be negative.'),
    ('SYNDICATE_ALLOCATION_WITHIN_ORDER', 'Allocation Within Order', 'SYNDICATE_ORDER', 'ORDER_ALLOCATED_AMOUNT', 'CONSISTENCY', 'HIGH', 'ORDER_ALLOCATED_AMOUNT IS NULL OR ORDER_AMOUNT IS NULL OR ORDER_ALLOCATED_AMOUNT <= ORDER_AMOUNT', 'A seat cannot be allocated more than it ordered.'),
    ('COVENANT_LEVEL_POSITIVE', 'Covenant Level Positive', 'DEAL_COVENANT', 'COVENANT_LEVEL', 'VALIDITY', 'HIGH', 'COVENANT_LEVEL IS NULL OR COVENANT_LEVEL > 0', 'A maintenance covenant is set at a level greater than zero.'),
    ('COMMITMENT_POSITIVE', 'Commitment Positive', 'INVESTOR_COMMITMENT', 'COMMITMENT_AMOUNT', 'VALIDITY', 'CRITICAL', 'COMMITMENT_AMOUNT IS NULL OR COMMITMENT_AMOUNT > 0', 'An investor commitment is greater than zero.'),
    ('COMMITMENT_PAST_DUE_WITHIN', 'Past Due Within Commitment', 'INVESTOR_COMMITMENT', 'COMMITMENT_PAST_DUE', 'CONSISTENCY', 'HIGH', 'COMMITMENT_PAST_DUE IS NULL OR COMMITMENT_AMOUNT IS NULL OR COMMITMENT_PAST_DUE <= COMMITMENT_AMOUNT', 'The amount past due cannot exceed the commitment.'),
    ('ACTIVITY_AMOUNT_POSITIVE', 'Amount Positive', 'CAPITAL_ACTIVITY', 'ACTIVITY_AMOUNT', 'VALIDITY', 'CRITICAL', 'ACTIVITY_AMOUNT IS NULL OR ACTIVITY_AMOUNT > 0', 'Calls and distributions are stored as positive amounts. The kind carries the direction.'),
    ('ACTIVITY_OUTSTANDING_WITHIN', 'Outstanding Within Amount', 'CAPITAL_ACTIVITY', 'ACTIVITY_OUTSTANDING', 'CONSISTENCY', 'HIGH', 'ACTIVITY_OUTSTANDING IS NULL OR ACTIVITY_AMOUNT IS NULL OR ACTIVITY_OUTSTANDING <= ACTIVITY_AMOUNT', 'The unpaid part of a call cannot exceed the call.'),
    ('ACTIVITY_SETTLED_NOT_FUTURE', 'Funded Activity Not Future Dated', 'CAPITAL_ACTIVITY', 'ACTIVITY_DATE', 'CONSISTENCY', 'HIGH', 'ACTIVITY_DATE IS NULL OR ACTIVITY_STATUS IS NULL OR ACTIVITY_STATUS IN (''PROJECTED'',''SCHEDULED'') OR ACTIVITY_DATE <= CURRENT_DATE', 'A call marked funded or a distribution marked paid cannot be dated in the future.'),
    ('PLAN_CALLED_RANGE', 'Plan Called in Range', 'CAPITAL_PLAN', 'PLAN_CALLED_PCT', 'VALIDITY', 'MEDIUM', 'PLAN_CALLED_PCT IS NULL OR PLAN_CALLED_PCT >= 0 AND PLAN_CALLED_PCT <= 100', 'Cumulative percent called runs from 0 to 100.'),
    ('FACILITY_DRAWN_NONNEGATIVE', 'Drawn Not Negative', 'CREDIT_FACILITY', 'FACILITY_DRAWN', 'VALIDITY', 'HIGH', 'FACILITY_DRAWN IS NULL OR FACILITY_DRAWN >= 0', 'The drawn balance cannot be negative.'),
    ('FACILITY_DRAWN_WITHIN_COMMITMENT', 'Drawn Within Commitment', 'CREDIT_FACILITY', 'FACILITY_DRAWN', 'CONSISTENCY', 'CRITICAL', 'FACILITY_DRAWN IS NULL OR FACILITY_COMMITMENT IS NULL OR FACILITY_DRAWN <= FACILITY_COMMITMENT', 'A facility cannot be drawn past its commitment.'),
    ('FACILITY_DRAWN_WITHIN_BASE', 'Drawn Within Borrowing Base', 'CREDIT_FACILITY', 'FACILITY_DRAWN', 'CONSISTENCY', 'CRITICAL', 'FACILITY_DRAWN IS NULL OR FACILITY_BORROWING_BASE IS NULL OR FACILITY_DRAWN <= FACILITY_BORROWING_BASE', 'Borrowings above the borrowing base are a facility default, or a stale borrowing base.'),
    ('LIMIT_PCT_RANGE', 'Limit in Range', 'EXPOSURE_LIMIT', 'LIMIT_PCT', 'VALIDITY', 'HIGH', 'LIMIT_PCT IS NULL OR LIMIT_PCT > 0 AND LIMIT_PCT <= 100', 'A concentration limit is a percent of fair value greater than 0 and no more than 100.'),
    ('BANK_TXN_NOT_FUTURE', 'Transaction Not Future Dated', 'BANK_TRANSACTION', 'BANK_TXN_DATE', 'VALIDITY', 'HIGH', 'BANK_TXN_DATE IS NULL OR BANK_TXN_DATE <= CURRENT_DATE', 'Cash cannot have moved at the bank on a future date.'),
    ('BANK_TXN_NONZERO', 'Amount Not Zero', 'BANK_TRANSACTION', 'BANK_TXN_AMOUNT', 'VALIDITY', 'MEDIUM', 'BANK_TXN_AMOUNT IS NULL OR BANK_TXN_AMOUNT <> 0', 'A bank transaction of zero usually means the amount failed to load.'),
    ('BANK_ACCOUNT_CURRENCY_ISO', 'Currency Is ISO Code', 'BANK_ACCOUNT', 'BANK_CURRENCY', 'VALIDITY', 'HIGH', 'BANK_CURRENCY IS NULL OR BANK_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('MATCH_CONFIDENCE_RANGE', 'Confidence in Range', 'CASH_MATCH', 'MATCH_CONFIDENCE', 'VALIDITY', 'LOW', 'MATCH_CONFIDENCE IS NULL OR MATCH_CONFIDENCE >= 0 AND MATCH_CONFIDENCE <= 100', 'Match confidence runs from 0 to 100.'),
    ('ADJ_AMOUNT_NONZERO', 'Amount Not Zero', 'CASH_ADJUSTMENT', 'ADJ_AMOUNT', 'VALIDITY', 'MEDIUM', 'ADJ_AMOUNT IS NULL OR ADJ_AMOUNT <> 0', 'An adjustment of zero adjusts nothing.'),
    ('EVIDENCE_NOT_FUTURE', 'Balance Date Not Future Dated', 'REC_EVIDENCE', 'EVIDENCE_DATE', 'VALIDITY', 'HIGH', 'EVIDENCE_DATE IS NULL OR EVIDENCE_DATE <= CURRENT_DATE', 'An outside balance cannot be dated in the future.'),
    ('CLOSE_CERTIFIED_HAS_CERTIFIER', 'Certification Names Who Certified', 'FUND_CLOSE', 'CLOSE_CERTIFIED_AT', 'COMPLETENESS', 'CRITICAL', 'CLOSE_CERTIFIED_AT IS NULL OR CLOSE_CERTIFIED_BY IS NOT NULL', 'A certified NAV has to record who certified it.'),
    ('CLOSE_CERTIFIED_HAS_NAV', 'Certification Records the NAV', 'FUND_CLOSE', 'CLOSE_CERTIFIED_AT', 'COMPLETENESS', 'CRITICAL', 'CLOSE_CERTIFIED_AT IS NULL OR CLOSE_CERTIFIED_NAV IS NOT NULL', 'A certified close has to record the NAV that was certified.'),
    ('CLOSE_CERTIFIED_AFTER_PERIOD', 'Certified After Period End', 'FUND_CLOSE', 'CLOSE_CERTIFIED_AT', 'CONSISTENCY', 'CRITICAL', 'CLOSE_CERTIFIED_AT IS NULL OR CLOSE_PERIOD_END IS NULL OR CLOSE_CERTIFIED_AT >= CLOSE_PERIOD_END', 'A NAV cannot be certified before the period it covers has ended.'),
    ('ROLL_END_FV_NONNEGATIVE', 'Ending Fair Value Not Negative', 'POSITION_ROLL', 'ROLL_END_FV', 'VALIDITY', 'HIGH', 'ROLL_END_FV IS NULL OR ROLL_END_FV >= 0', 'Fair value at period end cannot be negative.'),
    ('CLO_EFFECTIVE_AFTER_CLOSING', 'Effective Date On or After Closing', 'CLO_TRANSACTION', 'CLO_EFFECTIVE_DATE', 'CONSISTENCY', 'HIGH', 'CLO_EFFECTIVE_DATE IS NULL OR CLO_CLOSING_DATE IS NULL OR CLO_EFFECTIVE_DATE >= CLO_CLOSING_DATE', 'The ramp-up ends on or after the closing date.'),
    ('CLO_NON_CALL_AFTER_CLOSING', 'Non-Call Ends After Closing', 'CLO_TRANSACTION', 'CLO_NON_CALL_END', 'CONSISTENCY', 'HIGH', 'CLO_NON_CALL_END IS NULL OR CLO_CLOSING_DATE IS NULL OR CLO_NON_CALL_END > CLO_CLOSING_DATE', 'The non-call period ends after the notes are issued.'),
    ('CLO_REINVESTMENT_AFTER_CLOSING', 'Reinvestment Period Ends After Closing', 'CLO_TRANSACTION', 'CLO_REINVESTMENT_PERIOD_END', 'CONSISTENCY', 'HIGH', 'CLO_REINVESTMENT_PERIOD_END IS NULL OR CLO_CLOSING_DATE IS NULL OR CLO_REINVESTMENT_PERIOD_END > CLO_CLOSING_DATE', 'The reinvestment period ends after the notes are issued.'),
    ('CLO_MATURITY_AFTER_REINVESTMENT', 'Maturity After Reinvestment Period', 'CLO_TRANSACTION', 'CLO_STATED_MATURITY', 'CONSISTENCY', 'HIGH', 'CLO_STATED_MATURITY IS NULL OR CLO_REINVESTMENT_PERIOD_END IS NULL OR CLO_STATED_MATURITY > CLO_REINVESTMENT_PERIOD_END', 'The notes mature after the reinvestment period ends.'),
    ('CLO_PAYMENT_AFTER_DETERMINATION', 'Payment Date After Determination Date', 'CLO_TRANSACTION', 'CLO_NEXT_PAYMENT_DATE', 'CONSISTENCY', 'HIGH', 'CLO_NEXT_PAYMENT_DATE IS NULL OR CLO_NEXT_DETERMINATION_DATE IS NULL OR CLO_NEXT_PAYMENT_DATE >= CLO_NEXT_DETERMINATION_DATE', 'The trustee tests the portfolio on the determination date, then the waterfall pays.'),
    ('CLO_NEXT_PAYMENT_CURRENT', 'Next Payment Date Is Current', 'CLO_TRANSACTION', 'CLO_NEXT_PAYMENT_DATE', 'TIMELINESS', 'HIGH', 'CLO_NEXT_PAYMENT_DATE IS NULL OR CLO_NEXT_PAYMENT_DATE >= CURRENT_DATE', 'The next payment date has passed, so the payment calendar has not been rolled forward.'),
    ('CLO_CCC_CAP_RANGE', 'CCC Cap in Range', 'CLO_TRANSACTION', 'CLO_MAX_CCC_PCT', 'VALIDITY', 'HIGH', 'CLO_MAX_CCC_PCT IS NULL OR CLO_MAX_CCC_PCT >= 0 AND CLO_MAX_CCC_PCT <= 100', 'The CCC bucket cap is a percent from 0 to 100.'),
    ('CLO_SINGLE_OBLIGOR_CAP_RANGE', 'Single Obligor Cap in Range', 'CLO_TRANSACTION', 'CLO_MAX_SINGLE_OBLIGOR_PCT', 'VALIDITY', 'HIGH', 'CLO_MAX_SINGLE_OBLIGOR_PCT IS NULL OR CLO_MAX_SINGLE_OBLIGOR_PCT >= 0 AND CLO_MAX_SINGLE_OBLIGOR_PCT <= 100', 'The single obligor cap is a percent from 0 to 100.'),
    ('CLO_TARGET_PAR_POSITIVE', 'Target Par Positive', 'CLO_TRANSACTION', 'CLO_TARGET_INITIAL_PAR', 'VALIDITY', 'HIGH', 'CLO_TARGET_INITIAL_PAR IS NULL OR CLO_TARGET_INITIAL_PAR > 0', 'Target initial par is greater than zero.'),
    ('CLO_NOTE_PAR_NONNEGATIVE', 'Par Outstanding Not Negative', 'CLO_NOTE_CLASS', 'CLO_NOTE_PAR_OUTSTANDING', 'VALIDITY', 'CRITICAL', 'CLO_NOTE_PAR_OUTSTANDING IS NULL OR CLO_NOTE_PAR_OUTSTANDING >= 0', 'Outstanding principal of a note class cannot be negative.'),
    ('CLO_NOTE_ORIGINAL_PAR_POSITIVE', 'Original Par Positive', 'CLO_NOTE_CLASS', 'CLO_NOTE_ORIGINAL_PAR', 'VALIDITY', 'HIGH', 'CLO_NOTE_ORIGINAL_PAR IS NULL OR CLO_NOTE_ORIGINAL_PAR > 0', 'A note class is issued with par greater than zero.'),
    ('CLO_NOTE_OC_TRIGGER_VALID', 'OC Trigger At Least 100', 'CLO_NOTE_CLASS', 'CLO_NOTE_OC_TRIGGER', 'VALIDITY', 'HIGH', 'CLO_NOTE_OC_TRIGGER IS NULL OR CLO_NOTE_OC_TRIGGER >= 100', 'An overcollateralization trigger is a percent at or above 100. A trigger entered as 1.18 instead of 118 would never fail.'),
    ('CLO_NOTE_IC_TRIGGER_VALID', 'IC Trigger At Least 100', 'CLO_NOTE_CLASS', 'CLO_NOTE_IC_TRIGGER', 'VALIDITY', 'HIGH', 'CLO_NOTE_IC_TRIGGER IS NULL OR CLO_NOTE_IC_TRIGGER >= 100', 'An interest coverage trigger is a percent at or above 100.'),
    ('CLO_NOTE_RANK_VALID', 'Seniority Rank Valid', 'CLO_NOTE_CLASS', 'CLO_NOTE_SENIORITY_RANK', 'VALIDITY', 'HIGH', 'CLO_NOTE_SENIORITY_RANK IS NULL OR CLO_NOTE_SENIORITY_RANK >= 1', 'Seniority rank starts at 1 for the most senior class. Coverage tests are built from it.'),
    ('CLO_ACCT_BALANCE_NONNEGATIVE', 'Balance Not Negative', 'CLO_ACCOUNT', 'CLO_ACCT_BALANCE', 'VALIDITY', 'HIGH', 'CLO_ACCT_BALANCE IS NULL OR CLO_ACCT_BALANCE >= 0', 'A trustee account cannot be overdrawn.'),
    ('CLO_ACCT_CURRENCY_ISO', 'Currency Is ISO Code', 'CLO_ACCOUNT', 'CLO_ACCT_CURRENCY', 'VALIDITY', 'HIGH', 'CLO_ACCT_CURRENCY IS NULL OR CLO_ACCT_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('AMORT_PERCENT_RANGE', 'Percent of Original in Range', 'AMORTIZATION', 'AMORT_PERCENT_OF_ORIGINAL', 'VALIDITY', 'HIGH', 'AMORT_PERCENT_OF_ORIGINAL IS NULL OR AMORT_PERCENT_OF_ORIGINAL >= -100 AND AMORT_PERCENT_OF_ORIGINAL <= 100', 'A principal payment is at most the whole of original principal.'),
    ('CONTRACT_END_AFTER_EFFECTIVE', 'Period Ends After It Starts', 'INTEREST_CONTRACT', 'CONTRACT_END_DATE', 'CONSISTENCY', 'CRITICAL', 'CONTRACT_END_DATE IS NULL OR CONTRACT_EFFECTIVE_DATE IS NULL OR CONTRACT_END_DATE > CONTRACT_EFFECTIVE_DATE', 'An interest period ends after it starts. Accrual is calculated from these two dates.'),
    ('CONTRACT_PAYMENT_AFTER_EFFECTIVE', 'Payment After Period Start', 'INTEREST_CONTRACT', 'CONTRACT_PAYMENT_DATE', 'CONSISTENCY', 'HIGH', 'CONTRACT_PAYMENT_DATE IS NULL OR CONTRACT_EFFECTIVE_DATE IS NULL OR CONTRACT_PAYMENT_DATE >= CONTRACT_EFFECTIVE_DATE', 'Interest is paid after the period starts.'),
    ('CONTRACT_AMOUNT_NONNEGATIVE', 'Amount Not Negative', 'INTEREST_CONTRACT', 'CONTRACT_AMOUNT', 'VALIDITY', 'CRITICAL', 'CONTRACT_AMOUNT IS NULL OR CONTRACT_AMOUNT >= 0', 'The amount a contract accrues on cannot be negative.'),
    ('CONTRACT_CURRENCY_ISO', 'Currency Is ISO Code', 'INTEREST_CONTRACT', 'CONTRACT_CURRENCY', 'VALIDITY', 'HIGH', 'CONTRACT_CURRENCY IS NULL OR CONTRACT_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('CONTRACT_PIK_PERCENT_RANGE', 'PIK Percent in Range', 'INTEREST_CONTRACT', 'CONTRACT_PIK_PERCENT', 'VALIDITY', 'HIGH', 'CONTRACT_PIK_PERCENT IS NULL OR CONTRACT_PIK_PERCENT >= 0 AND CONTRACT_PIK_PERCENT <= 100', 'Share of interest paid in kind, from 0 to 100.'),
    ('CONTRACT_ROLL_DAY_RANGE', 'Roll Day in Range', 'INTEREST_CONTRACT', 'CONTRACT_ROLL_DAY', 'VALIDITY', 'MEDIUM', 'CONTRACT_ROLL_DAY IS NULL OR CONTRACT_ROLL_DAY >= 1 AND CONTRACT_ROLL_DAY <= 31', 'Roll day is a day of the month.'),
    ('CONTRACT_CAP_ABOVE_FLOOR', 'Cap At or Above Floor', 'INTEREST_CONTRACT', 'CONTRACT_CAP_RATE', 'CONSISTENCY', 'HIGH', 'CONTRACT_CAP_RATE IS NULL OR CONTRACT_FLOOR_RATE IS NULL OR CONTRACT_CAP_RATE >= CONTRACT_FLOOR_RATE', 'A rate cap sits at or above the floor.'),
    ('CONTRACT_FLOATING_HAS_BASE_RATE', 'Floating Contract Names Its Index', 'INTEREST_CONTRACT', 'CONTRACT_RATE_TYPE', 'COMPLETENESS', 'CRITICAL', 'CONTRACT_RATE_TYPE IS NULL OR CONTRACT_RATE_TYPE IN (''FIXED'',''PIK'') OR CONTRACT_BASE_RATE IS NOT NULL', 'A floating or base-rate contract cannot accrue without the index it prices off.'),
    ('CONTRACT_FIXED_HAS_RATE', 'Fixed Contract Has Its Rate', 'INTEREST_CONTRACT', 'CONTRACT_RATE_TYPE', 'COMPLETENESS', 'CRITICAL', 'CONTRACT_RATE_TYPE IS NULL OR CONTRACT_RATE_TYPE IN (''FLOATING'',''BASE_RATE'',''PIK'',''MIXED'') OR CONTRACT_FIXED_RATE IS NOT NULL', 'A fixed contract cannot accrue without its rate.'),
    ('CALL_END_AFTER_START', 'Price Through On or After Call Date', 'CALL_SCHEDULE', 'CALL_END_DATE', 'CONSISTENCY', 'MEDIUM', 'CALL_END_DATE IS NULL OR CALL_DATE IS NULL OR CALL_END_DATE >= CALL_DATE', 'A call price applies from the call date through its end date.'),
    ('CALL_NOTICE_NONNEGATIVE', 'Notice Days Not Negative', 'CALL_SCHEDULE', 'CALL_NOTICE_DAYS', 'VALIDITY', 'LOW', 'CALL_NOTICE_DAYS IS NULL OR CALL_NOTICE_DAYS >= 0', 'Notice days cannot be negative.'),
    ('CALL_PRICE_POSITIVE', 'Call Price Positive', 'CALL_SCHEDULE', 'CALL_PRICE', 'VALIDITY', 'HIGH', 'CALL_PRICE IS NULL OR CALL_PRICE > 0', 'A call price is a percent of par greater than zero.'),
    ('FACTOR_NONNEGATIVE', 'Factor Not Negative', 'FACTOR_SCHEDULE', 'FACTOR_VALUE', 'VALIDITY', 'HIGH', 'FACTOR_VALUE IS NULL OR FACTOR_VALUE >= 0', 'A pool factor cannot be negative.'),
    ('FACTOR_PAYMENT_AFTER_FACTOR', 'Payment On or After Factor Date', 'FACTOR_SCHEDULE', 'FACTOR_PAYMENT_DATE', 'CONSISTENCY', 'MEDIUM', 'FACTOR_PAYMENT_DATE IS NULL OR FACTOR_DATE IS NULL OR FACTOR_PAYMENT_DATE >= FACTOR_DATE', 'Principal from a factor change is paid on or after the factor date.'),
    ('FX_RATE_POSITIVE', 'Rate Positive', 'FX_RATE', 'FX_MARKET_RATE', 'VALIDITY', 'CRITICAL', 'FX_MARKET_RATE IS NULL OR FX_MARKET_RATE > 0', 'An exchange rate is greater than zero.'),
    ('FX_BASE_CURRENCY_ISO', 'Base Currency Is ISO Code', 'FX_RATE', 'FX_BASE_CURRENCY', 'VALIDITY', 'CRITICAL', 'FX_BASE_CURRENCY IS NULL OR FX_BASE_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('FX_QUOTE_CURRENCY_ISO', 'Quote Currency Is ISO Code', 'FX_RATE', 'FX_QUOTE_CURRENCY', 'VALIDITY', 'CRITICAL', 'FX_QUOTE_CURRENCY IS NULL OR FX_QUOTE_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('FX_CURRENCIES_DIFFER', 'Base and Quote Differ', 'FX_RATE', 'FX_BASE_CURRENCY', 'CONSISTENCY', 'HIGH', 'FX_BASE_CURRENCY IS NULL OR FX_QUOTE_CURRENCY IS NULL OR FX_BASE_CURRENCY <> FX_QUOTE_CURRENCY', 'A currency pair has two different currencies.'),
    ('FX_QUOTE_NOT_FUTURE', 'Quote Not Future Dated', 'FX_RATE', 'FX_MARKET_DATE', 'VALIDITY', 'HIGH', 'FX_MARKET_DATE IS NULL OR FX_MARKET_DATE <= CURRENT_DATE', 'A quote cannot be observed in the future.'),
    ('CURVE_CURRENCY_ISO', 'Currency Is ISO Code', 'FORWARD_CURVE', 'CURVE_CURRENCY', 'VALIDITY', 'HIGH', 'CURVE_CURRENCY IS NULL OR CURVE_CURRENCY ~ ''^[A-Z]{3}$''', 'Currency should be a three-letter ISO 4217 code such as USD.'),
    ('CURVE_NOT_FUTURE', 'As-of Date Not Future Dated', 'FORWARD_CURVE', 'CURVE_AS_OF_DATE', 'VALIDITY', 'HIGH', 'CURVE_AS_OF_DATE IS NULL OR CURVE_AS_OF_DATE <= CURRENT_DATE', 'A curve cannot be observed in the future.'),
    ('FORWARD_MATURITY_AFTER_START', 'Maturity After Start', 'FORWARD_RATE', 'FORWARD_MATURITY_DATE', 'CONSISTENCY', 'HIGH', 'FORWARD_MATURITY_DATE IS NULL OR FORWARD_START_DATE IS NULL OR FORWARD_MATURITY_DATE > FORWARD_START_DATE', 'A forward period ends after it starts.'),
    ('FORWARD_RATE_RANGE', 'Forward Rate in Range', 'FORWARD_RATE', 'FORWARD_RATE_VALUE', 'VALIDITY', 'HIGH', 'FORWARD_RATE_VALUE IS NULL OR FORWARD_RATE_VALUE >= -5 AND FORWARD_RATE_VALUE <= 25', 'Forward rates are percent points. Outside -5 to 25 is almost always a rate loaded as a decimal or in basis points.'),
    ('ORDER_QUANTITY_POSITIVE', 'Quantity Positive', 'ORDER', 'ORDER_QUANTITY', 'VALIDITY', 'HIGH', 'ORDER_QUANTITY IS NULL OR ORDER_QUANTITY > 0', 'An order is for a quantity greater than zero.'),
    ('ORDER_VALUE_NONNEGATIVE', 'Estimated Value Not Negative', 'ORDER', 'ESTIMATED_VALUE', 'VALIDITY', 'HIGH', 'ESTIMATED_VALUE IS NULL OR ESTIMATED_VALUE >= 0', 'The dollar value of an order cannot be negative.'),
    ('ORDER_TRANSACTION_TYPE_ALLOWED', 'Transaction Type Allowed', 'ORDER', 'TRANSACTION_TYPE', 'VALIDITY', 'HIGH', 'TRANSACTION_TYPE IS NULL OR TRANSACTION_TYPE IN (''Margin_Purchase'',''Short_Sale'',''Buy'',''Sell'',''Borrow'')', 'The compliance rules branch on the transaction type, so it has to be one they know.'),
    ('ORDER_COMPLIANCE_STATUS_ALLOWED', 'Compliance Status Allowed', 'ORDER', 'COMPLIANCE_STATUS', 'VALIDITY', 'HIGH', 'COMPLIANCE_STATUS IS NULL OR COMPLIANCE_STATUS IN (''CLEAR'',''BLOCKED'')', 'Compliance status is Clear or Blocked.')
  ) AS v(rule_code, rule_name, domain_code, attribute_code, rule_type, rule_severity, rule_expression, rule_description)
  LEFT JOIN metadata_register.attribute_register ar
    ON ar.domain_code = v.domain_code AND ar.attribute_code = v.attribute_code;

  SELECT count(*) FILTER (WHERE p.attribute_id IS NOT NULL),
         count(*) FILTER (WHERE p.attribute_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM metadata_register.attribute_register x WHERE x.attribute_code = p.attribute_code)),
         string_agg(p.rule_code, ', ' ORDER BY p.rule_code)
           FILTER (WHERE p.attribute_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM metadata_register.attribute_register x WHERE x.attribute_code = p.attribute_code))
  INTO v_found, v_absent, v_absent_list
  FROM _dq_program_rules p;
  IF v_absent > 0 THEN
    RAISE NOTICE 'Rules on attributes not in the catalog yet, skipped: %', v_absent_list;
  END IF;
  IF v_found + v_absent <> v_expected THEN
    RAISE EXCEPTION 'Expected % rules, matched % to an attribute', v_expected, v_found;
  END IF;
  DELETE FROM _dq_program_rules WHERE attribute_id IS NULL;

  INSERT INTO data_quality.dq_rules
    (rule_code, rule_name, domain_code, attribute_id, rule_type, rule_severity, rule_expression, rule_description, is_active)
  SELECT rule_code, rule_name, domain_code, attribute_id, rule_type, rule_severity, rule_expression, rule_description, true
  FROM _dq_program_rules
  ON CONFLICT (rule_code) DO UPDATE
  SET rule_name = EXCLUDED.rule_name,
      domain_code = EXCLUDED.domain_code,
      attribute_id = EXCLUDED.attribute_id,
      rule_type = EXCLUDED.rule_type,
      rule_severity = EXCLUDED.rule_severity,
      rule_expression = EXCLUDED.rule_expression,
      rule_description = EXCLUDED.rule_description,
      is_active = true,
      updated_at = NOW();

  DROP TABLE _dq_program_rules;
END $$;
