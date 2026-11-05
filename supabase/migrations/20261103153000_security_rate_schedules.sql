-- Security schedules: interest contracts, amortization, ABS factors, and calls.
--
-- A security keeps its headline coupon. These children are the schedules.
-- Each row is one period or one date, and a security has many of them.
--
-- Contract follows loan-administration practice (a funded, unfunded, or
-- letter-of-credit piece with its own interest period and rate election):
--   * Day count and business-day rules are the ISDA / ICMA set.
--   * USD loans accrue Actual/360, modified following, in arrears, start
--     included and end excluded. Fixed bonds use 30/360 or Actual/Actual ICMA.
--   * Overnight rates use the ARRC menu: in advance (term SOFR), compounded
--     or simple average in arrears, lookback, observation shift, lockout,
--     payment delay, and last-reset.
--   * ARRC credit adjustment spreads are 11.448 / 26.161 / 42.826 / 71.513 bps
--     for 1M / 3M / 6M / 12M, stored when the contract still carries one.
--   * A PIK toggle is an election for the period. Cash rate, PIK rate, the
--     toggle premium, and the share paid in kind are separate.
--   * Unfunded rate is the commitment fee. Ticking, letter-of-credit,
--     fronting, and utilization fees accrue on the same contract when they
--     apply to that piece.
-- Amortization is each expected principal payment through maturity, including
-- the balloon, an excess-cash-flow sweep, and other mandatory prepayments.
-- Amounts are facility-level, in the security currency.
-- Factor Schedule is one expected (or reported) ABS/MBS pool factor.
-- Current face = original face x factor. Paydown = original face x the
-- decline from the prior factor. Speeds are CPR, PSA, ABS, SMM, PPC, or HEP.
-- Call Schedule is one redemption date. A fixed price is percent of par.
-- Make-whole, equity claw, tax, par call, and ABS cleanup (typically at a
-- 10% factor) are provisions, not extra entity types.

-- ============================================================
-- 1. Domains, listed under Security
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('INTEREST_CONTRACT', 'Contract', 'One interest contract on a security: a funded, unfunded, or letter-of-credit piece with its own effective period, rate, and accrual terms'),
    ('AMORTIZATION', 'Amortization', 'One expected principal payment of a security, from the first installment through the balloon at maturity'),
    ('FACTOR_SCHEDULE', 'Factor Schedule', 'One pool factor on a factor date, used to project or record how an ABS or MBS pays down'),
    ('CALL_SCHEDULE', 'Call Schedule', 'One call date on a bond or ABS, with the fixed price or the formula that applies')
ON CONFLICT (domain_code) DO UPDATE
SET domain_name = EXCLUDED.domain_name,
    description = EXCLUDED.description,
    updated_at = NOW();

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = 'SECURITY',
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('INTEREST_CONTRACT', 21),
    ('AMORTIZATION', 22),
    ('FACTOR_SCHEDULE', 23),
    ('CALL_SCHEDULE', 24)
) AS v(domain_code, display_order)
JOIN metadata_register.domain_groups g ON g.group_code = 'SECURITIES'
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CONTRACT_STATUS', 'Contract Status', 'INTEREST_CONTRACT', 'Whether this interest contract is still accruing'),
    ('CONTRACT_KIND', 'Contract Kind', 'INTEREST_CONTRACT', 'Which piece of the facility this contract accrues'),
    ('CONTRACT_RATE_TYPE', 'Contract Rate Type', 'INTEREST_CONTRACT', 'How the coupon for this period is set'),
    ('CONTRACT_INDEX', 'Base Rate', 'INTEREST_CONTRACT', 'Index or base rate the contract prices off'),
    ('CONTRACT_INDEX_TENOR', 'Index Tenor', 'INTEREST_CONTRACT', 'Tenor of the index fixing when the index name does not already include it'),
    ('CONTRACT_RATE_BOUNDARY', 'Rate Floor or Cap Applies To', 'INTEREST_CONTRACT', 'Whether a floor or cap binds the index or the all-in coupon'),
    ('CONTRACT_PIK_ELECTION', 'PIK Election', 'INTEREST_CONTRACT', 'How much of this period is paid in kind'),
    ('CONTRACT_PIK_CAPITALIZATION', 'PIK Capitalization', 'INTEREST_CONTRACT', 'When pay-in-kind interest is added to principal'),
    ('CONTRACT_DAY_COUNT', 'Day Count', 'INTEREST_CONTRACT', 'Day-count fraction used to accrue this contract'),
    ('CONTRACT_ACCRUAL_METHOD', 'Accrual Method', 'INTEREST_CONTRACT', 'How interest, fees, or discount accrete over the period'),
    ('CONTRACT_RESET_METHOD', 'Reset Method', 'INTEREST_CONTRACT', 'When the index is observed, including the ARRC overnight conventions'),
    ('CONTRACT_DAY_TYPE', 'Day Type', 'INTEREST_CONTRACT', 'Whether a day count of lookback or notice uses business or calendar days'),
    ('CONTRACT_RATE_ROUNDING', 'Rate Rounding', 'INTEREST_CONTRACT', 'How the all-in rate is rounded'),
    ('CONTRACT_PAYMENT_TIMING', 'Payment Timing', 'INTEREST_CONTRACT', 'Whether interest is paid at the end or the start of the period'),
    ('CONTRACT_FREQUENCY', 'Frequency', 'INTEREST_CONTRACT', 'Payment, reset, or compounding frequency'),
    ('CONTRACT_BUSINESS_DAY', 'Business Day Convention', 'INTEREST_CONTRACT', 'How a payment or reset date moves off a weekend or holiday'),
    ('CONTRACT_CALENDAR', 'Business Day Calendar', 'INTEREST_CONTRACT', 'Financial center calendars that define a business day. More than one may apply.'),
    ('CONTRACT_STUB', 'Stub Period', 'INTEREST_CONTRACT', 'Irregular first or last interest period'),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'Accrual Boundary', 'INTEREST_CONTRACT', 'Which endpoint of the period is included in the day count'),
    ('CONTRACT_ACCRUAL_STATUS', 'Accrual Status', 'INTEREST_CONTRACT', 'Whether income is being accrued, suspended, or taken as cash'),
    ('AMORT_TYPE', 'Amortization Type', 'AMORTIZATION', 'Why this principal amount is expected'),
    ('AMORT_STATUS', 'Amortization Status', 'AMORTIZATION', 'Whether the principal payment is still ahead'),
    ('FACTOR_KIND', 'Factor Kind', 'FACTOR_SCHEDULE', 'Whether the factor is a projection, a zero-prepay schedule, or a reported actual'),
    ('FACTOR_SPEED_TYPE', 'Prepayment Speed', 'FACTOR_SCHEDULE', 'Convention used to project the factor'),
    ('FACTOR_SOURCE', 'Factor Source', 'FACTOR_SCHEDULE', 'Where the factor came from'),
    ('CALL_PROVISION', 'Call Provision', 'CALL_SCHEDULE', 'Which redemption right this date belongs to'),
    ('CALL_STYLE', 'Call Style', 'CALL_SCHEDULE', 'Whether the issuer can call only on this date, on or after it, or on this date alone'),
    ('CALL_BENCHMARK', 'Make-whole Benchmark', 'CALL_SCHEDULE', 'Government curve used to discount a make-whole call'),
    ('CALL_NOTICE_DAY_TYPE', 'Notice Day Type', 'CALL_SCHEDULE', 'Whether call notice is counted in business or calendar days'),
    ('CALL_PARTIAL', 'Partial Redemption', 'CALL_SCHEDULE', 'How a partial call is allocated'),
    ('CALL_STATUS', 'Call Status', 'CALL_SCHEDULE', 'Whether this call date is still ahead')
ON CONFLICT (list_code) DO UPDATE
SET list_name = EXCLUDED.list_name,
    domain_code = EXCLUDED.domain_code,
    description = EXCLUDED.description;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CONTRACT_STATUS', 'PENDING', 'Pending', 1, '[]'),
    ('CONTRACT_STATUS', 'ACTIVE', 'Active', 2, '["Open", "Current"]'),
    ('CONTRACT_STATUS', 'MATURED', 'Matured', 3, '["Expired", "Ended"]'),
    ('CONTRACT_STATUS', 'ROLLED', 'Rolled', 4, '["Rollover", "Continued"]'),
    ('CONTRACT_STATUS', 'CONVERTED', 'Converted', 5, '["Conversion"]'),
    ('CONTRACT_STATUS', 'CANCELLED', 'Cancelled', 6, '["Canceled", "Terminated"]'),

    ('CONTRACT_KIND', 'FUNDED', 'Funded', 1, '["Drawn", "Borrowing", "Funded loan"]'),
    ('CONTRACT_KIND', 'UNFUNDED', 'Unfunded', 2, '["Undrawn", "Commitment", "Unused"]'),
    ('CONTRACT_KIND', 'LETTER_OF_CREDIT', 'Letter of credit', 3, '["LC", "L/C"]'),
    ('CONTRACT_KIND', 'DELAYED_DRAW', 'Delayed draw', 4, '["DDTL", "Delayed draw term loan"]'),

    ('CONTRACT_RATE_TYPE', 'FIXED', 'Fixed', 1, '["Fixed rate"]'),
    ('CONTRACT_RATE_TYPE', 'FLOATING', 'Floating', 2, '["Float", "Index"]'),
    ('CONTRACT_RATE_TYPE', 'BASE_RATE', 'Base rate', 3, '["ABR", "Prime borrowing", "Alternate base rate"]'),
    ('CONTRACT_RATE_TYPE', 'PIK', 'PIK', 4, '["Pay in kind"]'),
    ('CONTRACT_RATE_TYPE', 'MIXED', 'Mixed cash and PIK', 5, '["Cash/PIK", "Split coupon"]'),

    ('CONTRACT_INDEX', 'TERM_SOFR_1M', 'Term SOFR 1 month', 1, '["1M SOFR", "1M Term SOFR", "CME Term SOFR 1M"]'),
    ('CONTRACT_INDEX', 'TERM_SOFR_3M', 'Term SOFR 3 month', 2, '["3M SOFR", "3M Term SOFR", "SOFR"]'),
    ('CONTRACT_INDEX', 'TERM_SOFR_6M', 'Term SOFR 6 month', 3, '["6M SOFR", "6M Term SOFR"]'),
    ('CONTRACT_INDEX', 'TERM_SOFR_12M', 'Term SOFR 12 month', 4, '["12M SOFR", "12M Term SOFR"]'),
    ('CONTRACT_INDEX', 'SOFR_COMPOUNDED', 'Compounded SOFR', 5, '["SOFR compounded in arrears", "Daily compounded SOFR"]'),
    ('CONTRACT_INDEX', 'SOFR_AVERAGE', 'Simple average SOFR', 6, '["Simple SOFR", "Average SOFR"]'),
    ('CONTRACT_INDEX', 'PRIME', 'Prime', 7, '["US Prime", "WSJ Prime", "Bank Prime"]'),
    ('CONTRACT_INDEX', 'BASE_RATE', 'Alternate base rate', 8, '["ABR", "Base Rate", "Alternate Base Rate"]'),
    ('CONTRACT_INDEX', 'FED_FUNDS', 'Fed funds effective', 9, '["Federal Funds", "EFFR", "Fed Funds"]'),
    ('CONTRACT_INDEX', 'AMERIBOR', 'AMERIBOR', 10, '["American Interbank Offered Rate"]'),
    ('CONTRACT_INDEX', 'EURIBOR_1M', 'EURIBOR 1 month', 11, '["1M EURIBOR"]'),
    ('CONTRACT_INDEX', 'EURIBOR_3M', 'EURIBOR 3 month', 12, '["3M EURIBOR", "EURIBOR"]'),
    ('CONTRACT_INDEX', 'EURIBOR_6M', 'EURIBOR 6 month', 13, '["6M EURIBOR"]'),
    ('CONTRACT_INDEX', 'EURIBOR_12M', 'EURIBOR 12 month', 14, '["12M EURIBOR"]'),
    ('CONTRACT_INDEX', 'ESTR', 'Euro short-term rate', 15, '["€STR", "EuroSTR", "ESTR"]'),
    ('CONTRACT_INDEX', 'SONIA', 'SONIA', 16, '["Sterling Overnight Index Average"]'),
    ('CONTRACT_INDEX', 'TERM_SONIA_1M', 'Term SONIA 1 month', 17, '["1M Term SONIA"]'),
    ('CONTRACT_INDEX', 'TERM_SONIA_3M', 'Term SONIA 3 month', 18, '["3M Term SONIA"]'),
    ('CONTRACT_INDEX', 'TERM_SONIA_6M', 'Term SONIA 6 month', 19, '["6M Term SONIA"]'),
    ('CONTRACT_INDEX', 'CORRA', 'CORRA', 20, '["Canadian Overnight Repo Rate Average"]'),
    ('CONTRACT_INDEX', 'TERM_CORRA_1M', 'Term CORRA 1 month', 21, '["1M Term CORRA"]'),
    ('CONTRACT_INDEX', 'TERM_CORRA_3M', 'Term CORRA 3 month', 22, '["3M Term CORRA"]'),
    ('CONTRACT_INDEX', 'CDOR', 'CDOR (legacy)', 23, '["Canadian Dollar Offered Rate"]'),
    ('CONTRACT_INDEX', 'BBSW_1M', 'BBSW 1 month', 24, '["1M BBSW"]'),
    ('CONTRACT_INDEX', 'BBSW_3M', 'BBSW 3 month', 25, '["3M BBSW", "BBSW"]'),
    ('CONTRACT_INDEX', 'BBSW_6M', 'BBSW 6 month', 26, '["6M BBSW"]'),
    ('CONTRACT_INDEX', 'AONIA', 'AONIA', 27, '["AUD Overnight Index Average"]'),
    ('CONTRACT_INDEX', 'TIBOR_3M', 'TIBOR 3 month', 28, '["3M TIBOR", "Yen TIBOR"]'),
    ('CONTRACT_INDEX', 'TONA', 'TONA', 29, '["Tokyo Overnight Average Rate"]'),
    ('CONTRACT_INDEX', 'SARON', 'SARON', 30, '["Swiss Average Rate Overnight"]'),
    ('CONTRACT_INDEX', 'STIBOR_3M', 'STIBOR 3 month', 31, '["3M STIBOR"]'),
    ('CONTRACT_INDEX', 'SWESTR', 'SWESTR', 32, '["Swedish krona Short Term Rate"]'),
    ('CONTRACT_INDEX', 'NIBOR_3M', 'NIBOR 3 month', 33, '["3M NIBOR"]'),
    ('CONTRACT_INDEX', 'NOWA', 'NOWA', 34, '["Norwegian Overnight Weighted Average"]'),
    ('CONTRACT_INDEX', 'CIBOR_3M', 'CIBOR 3 month', 35, '["3M CIBOR"]'),
    ('CONTRACT_INDEX', 'SORA', 'SORA', 36, '["Singapore Overnight Rate Average"]'),
    ('CONTRACT_INDEX', 'HIBOR_3M', 'HIBOR 3 month', 37, '["3M HIBOR"]'),
    ('CONTRACT_INDEX', 'HONIA', 'HONIA', 38, '["Hong Kong Overnight Index Average"]'),
    ('CONTRACT_INDEX', 'BKBM', 'BKBM', 39, '["Bank Bill Benchmark"]'),
    ('CONTRACT_INDEX', 'LIBOR_USD', 'USD LIBOR (legacy)', 40, '["LIBOR", "USD LIBOR"]'),
    ('CONTRACT_INDEX', 'FIXED', 'Fixed (no index)', 41, '["Fixed", "N/A"]'),
    ('CONTRACT_INDEX', 'NONE', 'None', 42, '[]'),

    ('CONTRACT_INDEX_TENOR', 'OVERNIGHT', 'Overnight', 1, '["O/N"]'),
    ('CONTRACT_INDEX_TENOR', '1W', '1 week', 2, '["1 week"]'),
    ('CONTRACT_INDEX_TENOR', '1M', '1 month', 3, '["1 month"]'),
    ('CONTRACT_INDEX_TENOR', '3M', '3 month', 4, '["3 month", "3 months"]'),
    ('CONTRACT_INDEX_TENOR', '6M', '6 month', 5, '["6 month", "6 months"]'),
    ('CONTRACT_INDEX_TENOR', '12M', '12 month', 6, '["12 month", "1 year"]'),
    ('CONTRACT_INDEX_TENOR', 'INTEREST_PERIOD', 'Interest period', 7, '["Period matched", "Matched to period"]'),

    ('CONTRACT_RATE_BOUNDARY', 'INDEX', 'Index', 1, '["Base rate", "Benchmark", "SOFR floor"]'),
    ('CONTRACT_RATE_BOUNDARY', 'ALL_IN', 'All-in rate', 2, '["Coupon", "All in"]'),

    ('CONTRACT_PIK_ELECTION', 'CASH', 'Cash', 1, '["All cash"]'),
    ('CONTRACT_PIK_ELECTION', 'PARTIAL', 'Partial PIK', 2, '["Partial", "Toggle", "Split"]'),
    ('CONTRACT_PIK_ELECTION', 'FULL', 'Full PIK', 3, '["100% PIK", "All PIK"]'),
    ('CONTRACT_PIK_ELECTION', 'MANDATORY', 'Mandatory PIK', 4, '["Required PIK"]'),

    ('CONTRACT_PIK_CAPITALIZATION', 'PAYMENT_DATE', 'Interest payment date', 1, '["On payment date", "Quarterly"]'),
    ('CONTRACT_PIK_CAPITALIZATION', 'DAILY', 'Daily', 2, '[]'),
    ('CONTRACT_PIK_CAPITALIZATION', 'MONTHLY', 'Monthly', 3, '[]'),
    ('CONTRACT_PIK_CAPITALIZATION', 'MATURITY', 'At maturity', 4, '["Bullet PIK"]'),

    ('CONTRACT_DAY_COUNT', 'ACT_360', 'Actual/360', 1, '["Act/360", "A/360", "Actual 360", "Money market"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_365F', 'Actual/365 Fixed', 2, '["Act/365", "A/365", "Actual/365", "Actual/365F"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_365L', 'Actual/365L', 3, '["Act/365L", "Actual/365 Leap"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_ACT_ISDA', 'Actual/Actual ISDA', 4, '["Act/Act ISDA", "Actual/Actual", "Act/Act"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_ACT_ICMA', 'Actual/Actual ICMA', 5, '["Act/Act ICMA", "Actual/Actual Bond", "ISMA", "ICMA"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_ACT_AFB', 'Actual/Actual AFB', 6, '["Act/Act AFB", "Actual/Actual French"]'),
    ('CONTRACT_DAY_COUNT', 'THIRTY_360', '30/360 US', 7, '["30/360", "30/360 NASD", "Bond basis", "360/360"]'),
    ('CONTRACT_DAY_COUNT', 'THIRTY_E_360', '30E/360', 8, '["30E/360", "Eurobond basis", "30/360 ICMA"]'),
    ('CONTRACT_DAY_COUNT', 'THIRTY_E_360_ISDA', '30E/360 ISDA', 9, '["30E/360 ISDA", "German", "30/360 German"]'),
    ('CONTRACT_DAY_COUNT', 'BUS_252', 'Business/252', 10, '["Bus/252", "BU/252", "Brazilian"]'),
    ('CONTRACT_DAY_COUNT', 'ACT_365_25', 'Actual/365.25', 11, '["Act/365.25"]'),

    ('CONTRACT_ACCRUAL_METHOD', 'SIMPLE', 'Simple', 1, '["Simple interest", "Nominal", "Money market"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'COMPOUNDED', 'Compounded', 2, '["Compounded in arrears", "Daily compounded"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'SIMPLE_AVERAGE', 'Simple average', 3, '["Average in arrears", "Simple average SOFR"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'DISCOUNT', 'Discount', 4, '["Discount basis", "Bank discount"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'YIELD_TO_MATURITY', 'Constant yield', 5, '["Effective interest", "Effective interest method", "YTM", "Amortized cost"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'STRAIGHT_LINE', 'Straight line', 6, '["Straight-line"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'PIK_ACCRETION', 'PIK accretion', 7, '["Capitalized interest", "PIK capitalization"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'BANK_365_360', '365/360', 8, '["365/360", "Bank method"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'ADD_ON', 'Add-on', 9, '["Add-on interest"]'),
    ('CONTRACT_ACCRUAL_METHOD', 'NONE', 'No accrual', 10, '["None"]'),

    ('CONTRACT_RESET_METHOD', 'IN_ADVANCE', 'In advance', 1, '["Term rate", "Set in advance"]'),
    ('CONTRACT_RESET_METHOD', 'IN_ARREARS', 'In arrears', 2, '["Backward looking"]'),
    ('CONTRACT_RESET_METHOD', 'LOOKBACK', 'Lookback', 3, '["Lookback without observation shift", "ARRC lookback"]'),
    ('CONTRACT_RESET_METHOD', 'OBSERVATION_SHIFT', 'Observation shift', 4, '["Shifted lookback"]'),
    ('CONTRACT_RESET_METHOD', 'LOCKOUT', 'Lockout', 5, '["Lockout period"]'),
    ('CONTRACT_RESET_METHOD', 'PAYMENT_DELAY', 'Payment delay', 6, '["Lag"]'),
    ('CONTRACT_RESET_METHOD', 'LAST_RESET', 'Last reset', 7, '["SOFR in advance", "Last recent"]'),
    ('CONTRACT_RESET_METHOD', 'NOT_APPLICABLE', 'Not applicable', 8, '["Fixed", "N/A"]'),

    ('CONTRACT_DAY_TYPE', 'BUSINESS', 'Business day', 1, '["Business"]'),
    ('CONTRACT_DAY_TYPE', 'CALENDAR', 'Calendar day', 2, '["Calendar"]'),

    ('CONTRACT_RATE_ROUNDING', 'HALF_UP', 'Half up', 1, '["Commercial", "Arithmetic"]'),
    ('CONTRACT_RATE_ROUNDING', 'HALF_EVEN', 'Half even', 2, '["Banker rounding", "Bankers rounding"]'),
    ('CONTRACT_RATE_ROUNDING', 'HALF_DOWN', 'Half down', 3, '[]'),
    ('CONTRACT_RATE_ROUNDING', 'TRUNCATE', 'Truncate', 4, '["Round toward zero"]'),
    ('CONTRACT_RATE_ROUNDING', 'NONE', 'None', 5, '[]'),

    ('CONTRACT_PAYMENT_TIMING', 'ARREARS', 'In arrears', 1, '["Arrears"]'),
    ('CONTRACT_PAYMENT_TIMING', 'ADVANCE', 'In advance', 2, '["Advance"]'),

    ('CONTRACT_FREQUENCY', 'OVERNIGHT', 'Overnight', 1, '[]'),
    ('CONTRACT_FREQUENCY', 'DAILY', 'Daily', 2, '[]'),
    ('CONTRACT_FREQUENCY', 'WEEKLY', 'Weekly', 3, '[]'),
    ('CONTRACT_FREQUENCY', 'MONTHLY', 'Monthly', 4, '[]'),
    ('CONTRACT_FREQUENCY', 'QUARTERLY', 'Quarterly', 5, '["Quarter"]'),
    ('CONTRACT_FREQUENCY', 'SEMI_ANNUAL', 'Semi-annual', 6, '["Semiannual", "Semi annual"]'),
    ('CONTRACT_FREQUENCY', 'ANNUAL', 'Annual', 7, '["Yearly"]'),
    ('CONTRACT_FREQUENCY', 'AT_MATURITY', 'At maturity', 8, '["Bullet", "Paid at maturity"]'),
    ('CONTRACT_FREQUENCY', 'CUSTOM', 'Custom', 9, '[]'),

    ('CONTRACT_BUSINESS_DAY', 'FOLLOWING', 'Following', 1, '[]'),
    ('CONTRACT_BUSINESS_DAY', 'MODIFIED_FOLLOWING', 'Modified following', 2, '["Modified Following", "Mod following"]'),
    ('CONTRACT_BUSINESS_DAY', 'PRECEDING', 'Preceding', 3, '[]'),
    ('CONTRACT_BUSINESS_DAY', 'MODIFIED_PRECEDING', 'Modified preceding', 4, '[]'),
    ('CONTRACT_BUSINESS_DAY', 'UNADJUSTED', 'Unadjusted', 5, '["No adjustment"]'),

    ('CONTRACT_CALENDAR', 'USNY', 'New York', 1, '["NY", "New York Fed"]'),
    ('CONTRACT_CALENDAR', 'USGS', 'SIFMA', 2, '["US government securities", "SIFMA"]'),
    ('CONTRACT_CALENDAR', 'GBLO', 'London', 3, '["London"]'),
    ('CONTRACT_CALENDAR', 'EUTA', 'TARGET', 4, '["TARGET2", "TARGET"]'),
    ('CONTRACT_CALENDAR', 'CATO', 'Toronto', 5, '["Toronto"]'),
    ('CONTRACT_CALENDAR', 'AUSY', 'Sydney', 6, '["Sydney"]'),
    ('CONTRACT_CALENDAR', 'JPTO', 'Tokyo', 7, '["Tokyo"]'),
    ('CONTRACT_CALENDAR', 'CHZU', 'Zurich', 8, '["Zurich"]'),
    ('CONTRACT_CALENDAR', 'SEST', 'Stockholm', 9, '["Stockholm"]'),
    ('CONTRACT_CALENDAR', 'NOOS', 'Oslo', 10, '["Oslo"]'),
    ('CONTRACT_CALENDAR', 'DKCO', 'Copenhagen', 11, '["Copenhagen"]'),
    ('CONTRACT_CALENDAR', 'NZWE', 'Wellington', 12, '["Wellington"]'),
    ('CONTRACT_CALENDAR', 'SGSI', 'Singapore', 13, '["Singapore"]'),
    ('CONTRACT_CALENDAR', 'HKHK', 'Hong Kong', 14, '["Hong Kong"]'),

    ('CONTRACT_STUB', 'NONE', 'None', 1, '["Regular", "No stub"]'),
    ('CONTRACT_STUB', 'SHORT_INITIAL', 'Short initial', 2, '["Short front", "Short first"]'),
    ('CONTRACT_STUB', 'LONG_INITIAL', 'Long initial', 3, '["Long front", "Long first"]'),
    ('CONTRACT_STUB', 'SHORT_FINAL', 'Short final', 4, '["Short back"]'),
    ('CONTRACT_STUB', 'LONG_FINAL', 'Long final', 5, '["Long back"]'),

    ('CONTRACT_ACCRUAL_BOUNDARY', 'START_INCLUSIVE', 'Include start, exclude end', 1, '["Start inclusive", "Actual"]'),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'END_INCLUSIVE', 'Exclude start, include end', 2, '["End inclusive"]'),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'BOTH', 'Include both', 3, '[]'),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'NEITHER', 'Exclude both', 4, '[]'),

    ('CONTRACT_ACCRUAL_STATUS', 'ACCRUING', 'Accruing', 1, '[]'),
    ('CONTRACT_ACCRUAL_STATUS', 'NON_ACCRUAL', 'Non-accrual', 2, '["Nonaccrual", "NAL"]'),
    ('CONTRACT_ACCRUAL_STATUS', 'CASH_BASIS', 'Cash basis', 3, '["Cash basis"]'),

    ('AMORT_TYPE', 'SCHEDULED', 'Scheduled amortization', 1, '["Mandatory amortization", "Installment", "TLA"]'),
    ('AMORT_TYPE', 'BULLET', 'Bullet at maturity', 2, '["Balloon", "Maturity", "Final payment"]'),
    ('AMORT_TYPE', 'EXCESS_CASH_FLOW', 'Excess cash flow sweep', 3, '["ECF", "Excess cash sweep"]'),
    ('AMORT_TYPE', 'MANDATORY_PREPAY', 'Mandatory prepayment', 4, '["Asset sale", "Insurance proceeds", "Issuance prepayment"]'),
    ('AMORT_TYPE', 'VOLUNTARY', 'Expected voluntary prepayment', 5, '["Optional prepayment"]'),

    ('AMORT_STATUS', 'SCHEDULED', 'Scheduled', 1, '[]'),
    ('AMORT_STATUS', 'PROJECTED', 'Projected', 2, '["Expected"]'),
    ('AMORT_STATUS', 'PAID', 'Paid', 3, '[]'),
    ('AMORT_STATUS', 'WAIVED', 'Waived', 4, '[]'),
    ('AMORT_STATUS', 'RESCHEDULED', 'Rescheduled', 5, '[]'),

    ('FACTOR_KIND', 'PROJECTED', 'Projected', 1, '["Expected", "Modeled"]'),
    ('FACTOR_KIND', 'SCHEDULED', 'Scheduled, zero prepay', 2, '["0 CPR", "Contractual"]'),
    ('FACTOR_KIND', 'REPORTED', 'Reported', 3, '["Actual", "Trustee", "Factor file"]'),

    ('FACTOR_SPEED_TYPE', 'CPR', 'CPR', 1, '["Conditional prepayment rate", "Constant prepayment rate"]'),
    ('FACTOR_SPEED_TYPE', 'PSA', 'PSA', 2, '["Public Securities Association", "100 PSA"]'),
    ('FACTOR_SPEED_TYPE', 'ABS', 'ABS', 3, '["Absolute prepayment speed"]'),
    ('FACTOR_SPEED_TYPE', 'SMM', 'SMM', 4, '["Single monthly mortality"]'),
    ('FACTOR_SPEED_TYPE', 'PPC', 'PPC', 5, '["Prospectus prepayment curve"]'),
    ('FACTOR_SPEED_TYPE', 'HEP', 'HEP', 6, '["Home equity prepayment"]'),
    ('FACTOR_SPEED_TYPE', 'NONE', 'None', 7, '["Not applicable"]'),

    ('FACTOR_SOURCE', 'MODELED', 'Modeled', 1, '[]'),
    ('FACTOR_SOURCE', 'PRICING', 'Pricing assumption', 2, '["Pricing"]'),
    ('FACTOR_SOURCE', 'TRUSTEE', 'Trustee', 3, '[]'),
    ('FACTOR_SOURCE', 'SERVICER', 'Servicer', 4, '[]'),

    ('CALL_PROVISION', 'OPTIONAL', 'Optional call', 1, '["Hard call", "Fixed price call", "Optional redemption"]'),
    ('CALL_PROVISION', 'PAR_CALL', 'Par call', 2, '["Soft call"]'),
    ('CALL_PROVISION', 'MAKE_WHOLE', 'Make-whole', 3, '["Make whole", "MW"]'),
    ('CALL_PROVISION', 'EQUITY_CLAW', 'Equity claw', 4, '["Equity clawback", "Clawback"]'),
    ('CALL_PROVISION', 'TAX', 'Tax redemption', 5, '["Tax call"]'),
    ('CALL_PROVISION', 'CLEANUP', 'Cleanup call', 6, '["Clean-up call", "Clean up"]'),
    ('CALL_PROVISION', 'SPECIAL', 'Other call', 7, '["Special"]'),

    ('CALL_STYLE', 'BERMUDAN', 'Bermudan', 1, '["On listed dates", "On coupon dates"]'),
    ('CALL_STYLE', 'AMERICAN', 'American', 2, '["Any time", "Continuous", "On or after"]'),
    ('CALL_STYLE', 'EUROPEAN', 'European', 3, '["Single date"]'),

    ('CALL_BENCHMARK', 'UST', 'US Treasury', 1, '["Treasury", "Interpolated treasury"]'),
    ('CALL_BENCHMARK', 'GILT', 'UK gilt', 2, '["Gilt"]'),
    ('CALL_BENCHMARK', 'BUND', 'German Bund', 3, '["Bund"]'),
    ('CALL_BENCHMARK', 'OAT', 'French OAT', 4, '["OAT"]'),
    ('CALL_BENCHMARK', 'GOC', 'Government of Canada', 5, '["Canada"]'),

    ('CALL_NOTICE_DAY_TYPE', 'BUSINESS', 'Business day', 1, '[]'),
    ('CALL_NOTICE_DAY_TYPE', 'CALENDAR', 'Calendar day', 2, '[]'),

    ('CALL_PARTIAL', 'NOT_ALLOWED', 'Whole only', 1, '["No partial"]'),
    ('CALL_PARTIAL', 'PRO_RATA', 'Pro rata', 2, '["Pro-rata"]'),
    ('CALL_PARTIAL', 'LOTTERY', 'Lottery', 3, '["Random"]'),

    ('CALL_STATUS', 'UPCOMING', 'Upcoming', 1, '[]'),
    ('CALL_STATUS', 'ANNOUNCED', 'Announced', 2, '[]'),
    ('CALL_STATUS', 'EXERCISED', 'Exercised', 3, '["Called", "Redeemed"]'),
    ('CALL_STATUS', 'EXPIRED', 'Expired', 4, '[]'),
    ('CALL_STATUS', 'WAIVED', 'Waived', 5, '[]')
) AS v(list_code, code, label, ord, syn) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO UPDATE
SET value_label = EXCLUDED.value_label,
    display_order = EXCLUDED.display_order,
    synonyms = EXCLUDED.synonyms;

-- ============================================================
-- 3. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, numeric_precision
)
SELECT v.code, v.name, v.dtype, v.descr, 'INTEREST_CONTRACT',
       NULLIF(v.list, ''), v.code = 'CONTRACT_CALENDAR', FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE', v.prec
FROM (VALUES
    ('CONTRACT_SEQUENCE', 'Sequence', 'INTEGER', 'Orders contracts that share a start date. The effective date plus this sequence identify the contract on the security.', '', 'Period', 10, NULL::integer),
    ('CONTRACT_LABEL', 'Label', 'STRING', 'Short name for this piece, such as 3-month SOFR or revolver commitment.', '', 'Period', 20, NULL),
    ('CONTRACT_KIND', 'Kind', 'REFERENCE_LIST', 'Funded borrowing, unfunded commitment, letter of credit, or delayed draw.', 'CONTRACT_KIND', 'Period', 30, NULL),
    ('CONTRACT_STATUS', 'Status', 'REFERENCE_LIST', 'Pending, active, matured, rolled into a new contract, converted, or cancelled.', 'CONTRACT_STATUS', 'Period', 40, NULL),
    ('CONTRACT_EFFECTIVE_DATE', 'Effective Date', 'DATE', 'First day of the interest period. Accrual includes this date.', '', 'Period', 50, NULL),
    ('CONTRACT_END_DATE', 'End Date', 'DATE', 'Interest period end, also the repricing date. Accrual excludes this date.', '', 'Period', 60, NULL),
    ('CONTRACT_PAYMENT_DATE', 'Interest Payment Date', 'DATE', 'Date interest or fees on this contract are paid. It can differ from the period end when the payment date is business-day adjusted or delayed.', '', 'Period', 70, NULL),
    ('CONTRACT_CURRENCY', 'Currency', 'STRING', 'ISO 4217 currency of this contract. A multicurrency facility can have contracts in more than one currency.', '', 'Period', 80, NULL),
    ('CONTRACT_AMOUNT', 'Amount', 'CURRENCY', 'Facility amount this contract accrues on. Funded contracts use the drawn amount. Unfunded contracts use the unused commitment.', '', 'Period', 90, NULL),

    ('CONTRACT_RATE_TYPE', 'Rate Type', 'REFERENCE_LIST', 'Fixed, floating, alternate base rate, PIK, or a mix of cash and PIK.', 'CONTRACT_RATE_TYPE', 'Rate', 100, NULL),
    ('CONTRACT_BASE_RATE', 'Base Rate', 'REFERENCE_LIST', 'Index this contract prices off, such as Term SOFR, Prime, EURIBOR, or SONIA. Fixed contracts use Fixed.', 'CONTRACT_INDEX', 'Rate', 110, NULL),
    ('CONTRACT_INDEX_TENOR', 'Index Tenor', 'REFERENCE_LIST', 'Tenor of the fixing when it is not already part of the base rate name.', 'CONTRACT_INDEX_TENOR', 'Rate', 120, NULL),
    ('CONTRACT_BASE_RATE_FIXING', 'Base Rate Fixing', 'PERCENTAGE', 'Observed index level for this period, in percent. 4.30 is 4.30 percent.', '', 'Rate', 130, 6),
    ('CONTRACT_FIXING_DATE', 'Fixing Date', 'DATE', 'Date the base rate was set. For term rates this is at the start of the period. For in-arrears rates it is at the end.', '', 'Rate', 140, NULL),
    ('CONTRACT_SPREAD_BPS', 'Spread (bps)', 'DECIMAL', 'Cash margin over the base rate, in basis points. 375 is 3.75 percent.', '', 'Rate', 150, 4),
    ('CONTRACT_FIXED_RATE', 'Fixed Rate', 'PERCENTAGE', 'All-in annual rate when the contract is fixed, in percent.', '', 'Rate', 160, 6),
    ('CONTRACT_CREDIT_ADJUSTMENT_BPS', 'Credit Adjustment (bps)', 'DECIMAL', 'Spread added to the base rate for the LIBOR-to-SOFR transition or a negotiated credit spread adjustment. ARRC indicated 11.448, 26.161, 42.826, and 71.513 bps for 1-month, 3-month, 6-month, and 12-month.', '', 'Rate', 170, 4),
    ('CONTRACT_FLOOR_RATE', 'Floor', 'PERCENTAGE', 'Minimum rate, in percent. A 0 or 1 percent SOFR floor is stored as 0 or 1.', '', 'Rate', 180, 6),
    ('CONTRACT_FLOOR_APPLIES_TO', 'Floor Applies To', 'REFERENCE_LIST', 'Index floor is the loan-market convention. All-in floor binds the coupon after the spread.', 'CONTRACT_RATE_BOUNDARY', 'Rate', 190, NULL),
    ('CONTRACT_CAP_RATE', 'Cap', 'PERCENTAGE', 'Maximum rate, in percent.', '', 'Rate', 200, 6),
    ('CONTRACT_CAP_APPLIES_TO', 'Cap Applies To', 'REFERENCE_LIST', 'Whether the cap binds the index or the all-in coupon.', 'CONTRACT_RATE_BOUNDARY', 'Rate', 210, NULL),
    ('CONTRACT_CASH_RATE', 'Cash Rate', 'PERCENTAGE', 'Annual rate paid in cash when cash and PIK are both non-zero, in percent.', '', 'Rate', 220, 6),
    ('CONTRACT_ALL_IN_RATE', 'All-in Rate', 'PERCENTAGE', 'Coupon for the period once the index is known, in percent. For a term rate set in advance this is known on the effective date. For a compounded in-arrears rate it is known at the end.', '', 'Rate', 230, 6),

    ('CONTRACT_PIK_TOGGLE', 'PIK Toggled', 'BOOLEAN', 'True when the borrower has elected, or this period requires, pay-in-kind interest.', '', 'PIK', 240, NULL),
    ('CONTRACT_PIK_ELECTION', 'PIK Election', 'REFERENCE_LIST', 'Cash, partial PIK, full PIK, or mandatory PIK for this period.', 'CONTRACT_PIK_ELECTION', 'PIK', 250, NULL),
    ('CONTRACT_PIK_RATE', 'PIK Rate', 'PERCENTAGE', 'Annual rate that accrues in kind, in percent.', '', 'PIK', 260, 6),
    ('CONTRACT_PIK_PREMIUM_BPS', 'PIK Premium (bps)', 'DECIMAL', 'Extra margin added only when the PIK toggle is on, in basis points. Often 25 to 75.', '', 'PIK', 270, 4),
    ('CONTRACT_PIK_PERCENT', 'PIK Percent', 'PERCENTAGE', 'Share of interest paid in kind. 0 is all cash and 100 is full PIK.', '', 'PIK', 280, 4),
    ('CONTRACT_PIK_CAPITALIZATION', 'PIK Capitalization', 'REFERENCE_LIST', 'When unpaid PIK interest is added to principal. Payment date is the usual credit-agreement rule.', 'CONTRACT_PIK_CAPITALIZATION', 'PIK', 290, NULL),

    ('CONTRACT_UNFUNDED_RATE', 'Unfunded Rate', 'PERCENTAGE', 'Annual commitment fee on the unused commitment, in percent. Often 0.25 to 0.50, or half the margin.', '', 'Unfunded', 300, 6),
    ('CONTRACT_TICKING_FEE_RATE', 'Ticking Fee', 'PERCENTAGE', 'Annual fee on amounts committed before closing, in percent. Agreements often step this rate up with time.', '', 'Unfunded', 310, 6),
    ('CONTRACT_LC_FEE_RATE', 'LC Fee', 'PERCENTAGE', 'Annual letter-of-credit participation fee, in percent.', '', 'Unfunded', 320, 6),
    ('CONTRACT_FRONTING_FEE_RATE', 'Fronting Fee', 'PERCENTAGE', 'Annual fee paid to the letter-of-credit issuer, in percent. Often 0.125 to 0.25.', '', 'Unfunded', 330, 6),
    ('CONTRACT_UTILIZATION_FEE_RATE', 'Utilization Fee', 'PERCENTAGE', 'Extra annual fee when line usage exceeds the threshold, in percent.', '', 'Unfunded', 340, 6),
    ('CONTRACT_UTILIZATION_THRESHOLD', 'Utilization Threshold', 'PERCENTAGE', 'Drawn share of the commitment at which the utilization fee starts, in percent. 50 means the fee applies above 50 percent drawn.', '', 'Unfunded', 350, 4),

    ('CONTRACT_DAY_COUNT', 'Day Count', 'REFERENCE_LIST', 'Day-count fraction. USD loans and SOFR contracts use Actual/360. GBP often uses Actual/365 Fixed. US corporate bonds use 30/360. International fixed bonds use Actual/Actual ICMA.', 'CONTRACT_DAY_COUNT', 'Accrual', 360, NULL),
    ('CONTRACT_ACCRUAL_METHOD', 'Accrual Method', 'REFERENCE_LIST', 'Simple interest is the loan and bond coupon method. Compounded and simple average are for overnight rates. Discount, constant yield, straight line, 365/360, add-on, and PIK accretion cover the other ways a balance can grow.', 'CONTRACT_ACCRUAL_METHOD', 'Accrual', 370, NULL),
    ('CONTRACT_RESET_METHOD', 'Reset Method', 'REFERENCE_LIST', 'Term SOFR and EURIBOR are set in advance. Overnight SOFR can compound in arrears with a lookback, an observation shift, a lockout, or a payment delay, or it can reuse the prior period rate.', 'CONTRACT_RESET_METHOD', 'Accrual', 380, NULL),
    ('CONTRACT_LOOKBACK_DAYS', 'Lookback Days', 'INTEGER', 'Business or calendar days of lookback, lockout, or payment delay. SOFR loans commonly use 2, 3, or 5 business days.', '', 'Accrual', 390, NULL),
    ('CONTRACT_LOOKBACK_DAY_TYPE', 'Lookback Day Type', 'REFERENCE_LIST', 'Whether lookback days are business days or calendar days.', 'CONTRACT_DAY_TYPE', 'Accrual', 400, NULL),
    ('CONTRACT_PAYMENT_TIMING', 'Payment Timing', 'REFERENCE_LIST', 'Loans and bonds pay in arrears. Some discount obligations and leases accrue in advance.', 'CONTRACT_PAYMENT_TIMING', 'Accrual', 410, NULL),
    ('CONTRACT_PAYMENT_FREQUENCY', 'Payment Frequency', 'REFERENCE_LIST', 'How often interest or fees are paid.', 'CONTRACT_FREQUENCY', 'Accrual', 420, NULL),
    ('CONTRACT_RESET_FREQUENCY', 'Reset Frequency', 'REFERENCE_LIST', 'How often the base rate is reset. A 3-month term rate resets quarterly. Compounded overnight resets with the interest period.', 'CONTRACT_FREQUENCY', 'Accrual', 430, NULL),
    ('CONTRACT_COMPOUNDING_FREQUENCY', 'Compounding Frequency', 'REFERENCE_LIST', 'How often interest compounds. Daily for compounded SOFR. Payment date for most PIK loans.', 'CONTRACT_FREQUENCY', 'Accrual', 440, NULL),
    ('CONTRACT_BUSINESS_DAY_CONVENTION', 'Business Day Convention', 'REFERENCE_LIST', 'How a date that falls on a weekend or holiday moves. Modified following is the loan and bond standard.', 'CONTRACT_BUSINESS_DAY', 'Accrual', 450, NULL),
    ('CONTRACT_ACCRUAL_ADJUSTED', 'Accrual Dates Adjusted', 'BOOLEAN', 'True when the day count uses the business-day-adjusted dates. Loans usually accrue on the unadjusted period and only move the payment date.', '', 'Accrual', 460, NULL),
    ('CONTRACT_CALENDAR', 'Business Day Calendar', 'REFERENCE_LIST', 'Calendars that define a business day. A New York and London contract selects both.', 'CONTRACT_CALENDAR', 'Accrual', 470, NULL),
    ('CONTRACT_STUB', 'Stub', 'REFERENCE_LIST', 'Irregular first or last period when the dated date does not fall on a regular roll.', 'CONTRACT_STUB', 'Accrual', 480, NULL),
    ('CONTRACT_END_OF_MONTH', 'End of Month', 'BOOLEAN', 'True when periods roll to the last calendar day of the month.', '', 'Accrual', 490, NULL),
    ('CONTRACT_ROLL_DAY', 'Roll Day', 'INTEGER', 'Day of month the interest period rolls, from 1 to 31.', '', 'Accrual', 500, NULL),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'Accrual Boundary', 'REFERENCE_LIST', 'Which endpoint is counted. Loans and bonds include the start date and exclude the end date.', 'CONTRACT_ACCRUAL_BOUNDARY', 'Accrual', 510, NULL),
    ('CONTRACT_RATE_ROUNDING', 'Rate Rounding', 'REFERENCE_LIST', 'Rounding of the all-in rate. Half up is the usual commercial rule.', 'CONTRACT_RATE_ROUNDING', 'Accrual', 520, NULL),
    ('CONTRACT_RATE_DECIMALS', 'Rate Decimals', 'INTEGER', 'Decimal places the all-in rate is rounded to. Credit agreements often use 5 or 6.', '', 'Accrual', 530, NULL),
    ('CONTRACT_DEFAULT_SPREAD_BPS', 'Default Spread (bps)', 'DECIMAL', 'Extra margin on overdue amounts, in basis points. Credit agreements commonly add 200.', '', 'Accrual', 540, 4),
    ('CONTRACT_ACCRUAL_STATUS', 'Accrual Status', 'REFERENCE_LIST', 'Accruing, non-accrual, or cash basis. Non-accrual stops income recognition without deleting the contractual method.', 'CONTRACT_ACCRUAL_STATUS', 'Accrual', 550, NULL)
) AS v(code, name, dtype, descr, list, section, grp, prec)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    numeric_precision = EXCLUDED.numeric_precision,
    is_multi_valued = EXCLUDED.is_multi_valued;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, numeric_precision
)
SELECT v.code, v.name, v.dtype, v.descr, 'AMORTIZATION',
       NULLIF(v.list, ''), FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE', v.prec
FROM (VALUES
    ('AMORT_DATE', 'Date', 'DATE', 'Date this principal amount is expected to be paid.', '', 'Schedule', 10, NULL::integer),
    ('AMORT_TYPE', 'Type', 'REFERENCE_LIST', 'Scheduled installment, balloon at maturity, excess-cash-flow sweep, other mandatory prepayment, or an expected voluntary prepayment.', 'AMORT_TYPE', 'Schedule', 20, NULL),
    ('AMORT_PRINCIPAL_AMOUNT', 'Principal Amount', 'CURRENCY', 'Facility-level principal expected on this date, in the security currency. A position share is this amount times the hold.', '', 'Schedule', 30, 2),
    ('AMORT_PERCENT_OF_ORIGINAL', 'Percent of Original', 'PERCENTAGE', 'Same payment expressed as a percent of original principal. A 1 percent per year loan paid quarterly is 0.25 on each date.', '', 'Schedule', 40, 6),
    ('AMORT_BALANCE_AFTER', 'Balance After', 'CURRENCY', 'Expected principal outstanding after this payment.', '', 'Schedule', 50, 2),
    ('AMORT_CURRENCY', 'Currency', 'STRING', 'ISO 4217 currency of the principal amount when it differs from the security.', '', 'Schedule', 60, NULL),
    ('AMORT_STATUS', 'Status', 'REFERENCE_LIST', 'Scheduled, projected, paid, waived, or rescheduled.', 'AMORT_STATUS', 'Schedule', 70, NULL)
) AS v(code, name, dtype, descr, list, section, grp, prec)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    numeric_precision = EXCLUDED.numeric_precision;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, numeric_precision
)
SELECT v.code, v.name, v.dtype, v.descr, 'FACTOR_SCHEDULE',
       NULLIF(v.list, ''), FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE', v.prec
FROM (VALUES
    ('FACTOR_DATE', 'Factor Date', 'DATE', 'Date this factor takes effect. Remaining principal is original face times the factor.', '', 'Factor', 10, NULL::integer),
    ('FACTOR_PAYMENT_DATE', 'Payment Date', 'DATE', 'Date the principal from this factor change is paid, when it is not the factor date. Agency MBS often factor on the 1st and pay later in the month.', '', 'Factor', 20, NULL),
    ('FACTOR_VALUE', 'Factor', 'DECIMAL', 'Remaining principal divided by original principal. 1 is the original balance. Agency factors are quoted to 8 or 10 decimals.', '', 'Factor', 30, 10),
    ('FACTOR_KIND', 'Kind', 'REFERENCE_LIST', 'Projected from a speed, scheduled at zero prepayments, or reported by the trustee or servicer.', 'FACTOR_KIND', 'Factor', 40, NULL),
    ('FACTOR_PRINCIPAL_PAYDOWN', 'Principal Paydown', 'CURRENCY', 'Principal paid as the factor steps down from the prior factor. Equals original face times that decline.', '', 'Factor', 50, 2),
    ('FACTOR_CURRENT_FACE', 'Current Face', 'CURRENCY', 'Original face times this factor.', '', 'Factor', 60, 2),
    ('FACTOR_SPEED_TYPE', 'Speed Type', 'REFERENCE_LIST', 'CPR is an annualized prepay rate. PSA ramps to 6 percent CPR over 30 months at 100 PSA. ABS is a monthly percent of original balance. SMM is the single monthly mortality. PPC and HEP are prospectus and home-equity curves.', 'FACTOR_SPEED_TYPE', 'Projection', 70, NULL),
    ('FACTOR_SPEED', 'Speed', 'DECIMAL', 'Speed assumption in the units of the speed type. 15 is 15 CPR, 150 is 150 PSA, 1.50 is 1.50 ABS.', '', 'Projection', 80, 4),
    ('FACTOR_WAC', 'WAC', 'PERCENTAGE', 'Weighted average coupon of the collateral at this factor date, in percent.', '', 'Projection', 90, 6),
    ('FACTOR_WAM', 'WAM', 'INTEGER', 'Weighted average maturity of the collateral, in months.', '', 'Projection', 100, NULL),
    ('FACTOR_WALA', 'WALA', 'INTEGER', 'Weighted average loan age of the collateral, in months.', '', 'Projection', 110, NULL),
    ('FACTOR_SOURCE', 'Source', 'REFERENCE_LIST', 'Modeled, pricing assumption, trustee, or servicer.', 'FACTOR_SOURCE', 'Projection', 120, NULL)
) AS v(code, name, dtype, descr, list, section, grp, prec)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    numeric_precision = EXCLUDED.numeric_precision;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, numeric_precision
)
SELECT v.code, v.name, v.dtype, v.descr, 'CALL_SCHEDULE',
       NULLIF(v.list, ''), FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE', v.prec
FROM (VALUES
    ('CALL_DATE', 'Call Date', 'DATE', 'First date this price or formula can be used. On a Bermudan schedule this is the exercise date. On an American schedule it is the start of the window.', '', 'Call', 10, NULL::integer),
    ('CALL_END_DATE', 'Price Through', 'DATE', 'Last date this price applies. The next row usually starts the following day. Leave blank when the price runs to maturity.', '', 'Call', 20, NULL),
    ('CALL_PRICE', 'Call Price', 'DECIMAL', 'Redemption price as a percent of par. 100 is par and 103.5 is 103.5 percent of principal. Blank on a make-whole row, where the price is computed.', '', 'Call', 30, 4),
    ('CALL_PROVISION', 'Provision', 'REFERENCE_LIST', 'Optional hard call, par call, make-whole, equity claw, tax redemption, ABS cleanup, or another call.', 'CALL_PROVISION', 'Call', 40, NULL),
    ('CALL_STYLE', 'Style', 'REFERENCE_LIST', 'Bermudan is only on listed dates. American is any day on or after the call date until the end date. European is a single date.', 'CALL_STYLE', 'Call', 50, NULL),
    ('CALL_NOTICE_DAYS', 'Notice Days', 'INTEGER', 'How far ahead the issuer must notify holders. Often 10 to 60 days, commonly 30.', '', 'Call', 60, NULL),
    ('CALL_NOTICE_DAY_TYPE', 'Notice Day Type', 'REFERENCE_LIST', 'Whether notice days are business days or calendar days.', 'CALL_NOTICE_DAY_TYPE', 'Call', 70, NULL),
    ('CALL_PARTIAL', 'Partial Redemption', 'REFERENCE_LIST', 'Whole call only, pro rata, or lottery.', 'CALL_PARTIAL', 'Call', 80, NULL),
    ('CALL_PLUS_ACCRUED', 'Plus Accrued', 'BOOLEAN', 'True when the call price is clean and the issuer also pays accrued interest. That is the usual bond term.', '', 'Call', 90, NULL),
    ('CALL_STATUS', 'Status', 'REFERENCE_LIST', 'Upcoming, announced, exercised, expired, or waived.', 'CALL_STATUS', 'Call', 100, NULL),
    ('CALL_MAKE_WHOLE_SPREAD_BPS', 'Make-whole Spread (bps)', 'DECIMAL', 'Spread added to the benchmark when discounting remaining payments for a make-whole price, in basis points. Treasury plus 50 is 50.', '', 'Make-whole', 110, 4),
    ('CALL_MAKE_WHOLE_BENCHMARK', 'Make-whole Benchmark', 'REFERENCE_LIST', 'Government curve used in the make-whole discount. US high yield and investment grade use the interpolated US Treasury.', 'CALL_BENCHMARK', 'Make-whole', 120, NULL),
    ('CALL_EQUITY_CLAW_PCT', 'Equity Claw Percent', 'PERCENTAGE', 'Maximum share of original principal the equity claw can redeem, in percent. High-yield claws are often 35 or 40.', '', 'Redemption', 130, 4),
    ('CALL_CLEANUP_FACTOR', 'Cleanup Factor', 'DECIMAL', 'Pool factor at or below which an ABS or MBS cleanup call is available. 0.10 is the common 10 percent cleanup.', '', 'Redemption', 140, 8)
) AS v(code, name, dtype, descr, list, section, grp, prec)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    numeric_precision = EXCLUDED.numeric_precision;

UPDATE metadata_register.attribute_register AS a
SET default_value = v.val
FROM (VALUES
    ('CONTRACT_STATUS', 'ACTIVE'),
    ('CONTRACT_DAY_COUNT', 'ACT_360'),
    ('CONTRACT_ACCRUAL_METHOD', 'SIMPLE'),
    ('CONTRACT_RESET_METHOD', 'IN_ADVANCE'),
    ('CONTRACT_PAYMENT_TIMING', 'ARREARS'),
    ('CONTRACT_PAYMENT_FREQUENCY', 'QUARTERLY'),
    ('CONTRACT_BUSINESS_DAY_CONVENTION', 'MODIFIED_FOLLOWING'),
    ('CONTRACT_ACCRUAL_BOUNDARY', 'START_INCLUSIVE'),
    ('CONTRACT_ACCRUAL_ADJUSTED', 'false'),
    ('CONTRACT_PIK_TOGGLE', 'false'),
    ('CONTRACT_RATE_ROUNDING', 'HALF_UP'),
    ('CONTRACT_RATE_DECIMALS', '5'),
    ('CONTRACT_ACCRUAL_STATUS', 'ACCRUING'),
    ('CONTRACT_END_OF_MONTH', 'false'),
    ('CALL_PLUS_ACCRUED', 'true'),
    ('CALL_STYLE', 'BERMUDAN'),
    ('CALL_STATUS', 'UPCOMING'),
    ('AMORT_STATUS', 'SCHEDULED'),
    ('FACTOR_KIND', 'PROJECTED')
) AS v(code, val)
WHERE a.attribute_code = v.code;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Sections
-- ============================================================

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, column_count)
SELECT v.domain_code, v.section_name, v.display_order, 4
FROM (VALUES
    ('INTEREST_CONTRACT', 'Period', 0),
    ('INTEREST_CONTRACT', 'Rate', 10),
    ('INTEREST_CONTRACT', 'PIK', 20),
    ('INTEREST_CONTRACT', 'Unfunded', 30),
    ('INTEREST_CONTRACT', 'Accrual', 40),
    ('AMORTIZATION', 'Schedule', 0),
    ('FACTOR_SCHEDULE', 'Factor', 0),
    ('FACTOR_SCHEDULE', 'Projection', 10),
    ('CALL_SCHEDULE', 'Call', 0),
    ('CALL_SCHEDULE', 'Make-whole', 10),
    ('CALL_SCHEDULE', 'Redemption', 20)
) AS v(domain_code, section_name, display_order)
WHERE NOT EXISTS (
    SELECT 1
    FROM metadata_register.attribute_sections existing
    WHERE existing.domain_code = v.domain_code
      AND lower(existing.section_name) = lower(v.section_name)
);

-- ============================================================
-- 5. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('INTEREST_CONTRACT_STANDARD', 'Standard Contract', 'INTEREST_CONTRACT', 'One interest period: dates, base rate, spread, PIK, unfunded rate, and accrual conventions'),
    ('AMORTIZATION_STANDARD', 'Standard Amortization', 'AMORTIZATION', 'One expected principal payment'),
    ('FACTOR_SCHEDULE_STANDARD', 'Standard Factor', 'FACTOR_SCHEDULE', 'One factor date and factor'),
    ('CALL_SCHEDULE_STANDARD', 'Standard Call', 'CALL_SCHEDULE', 'One call date and price or formula')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN (
           'CONTRACT_SEQUENCE', 'CONTRACT_KIND', 'CONTRACT_EFFECTIVE_DATE', 'CONTRACT_END_DATE',
           'CONTRACT_PAYMENT_DATE', 'CONTRACT_AMOUNT',
           'AMORT_DATE', 'AMORT_TYPE', 'AMORT_PRINCIPAL_AMOUNT',
           'FACTOR_DATE', 'FACTOR_VALUE', 'FACTOR_KIND',
           'CALL_DATE', 'CALL_PROVISION'
       ),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.domain_code IN ('INTEREST_CONTRACT', 'AMORTIZATION', 'FACTOR_SCHEDULE', 'CALL_SCHEDULE')
ON CONFLICT (template_id, attribute_id) DO UPDATE
SET is_required = EXCLUDED.is_required,
    display_order = EXCLUDED.display_order;

-- ============================================================
-- 6. Identifiers and relationships
-- ============================================================

INSERT INTO metadata_register.entity_identifier_definitions (
    domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description
) VALUES
    ('INTEREST_CONTRACT', 'CONTRACT_PERIOD', 'Effective date and sequence',
     ARRAY['CONTRACT_EFFECTIVE_DATE', 'CONTRACT_SEQUENCE'], TRUE,
     'Distinguishes contracts on one security that start on the same day'),
    ('AMORTIZATION', 'AMORT_DATE_TYPE', 'Date and type',
     ARRAY['AMORT_DATE', 'AMORT_TYPE'], TRUE,
     'One row per date and reason. A scheduled installment and a sweep can share a date.'),
    ('FACTOR_SCHEDULE', 'FACTOR_DATE_KIND', 'Factor date and kind',
     ARRAY['FACTOR_DATE', 'FACTOR_KIND'], TRUE,
     'A projected factor and a reported factor can share a date'),
    ('CALL_SCHEDULE', 'CALL_DATE_PROVISION', 'Call date and provision',
     ARRAY['CALL_DATE', 'CALL_PROVISION'], TRUE,
     'A make-whole and a fixed-price call can share a date')
ON CONFLICT (domain_code, identifier_code) DO UPDATE
SET identifier_name = EXCLUDED.identifier_name,
    attribute_codes = EXCLUDED.attribute_codes,
    is_primary = EXCLUDED.is_primary,
    description = EXCLUDED.description;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('SECURITY_CONTRACT', 'Security contracts', 'SECURITY', 'INTEREST_CONTRACT',
     'Interest contracts outstanding on a security', 'ONE_TO_MANY', FALSE),
    ('SECURITY_AMORTIZATION', 'Security amortization', 'SECURITY', 'AMORTIZATION',
     'Expected principal payments of a security through maturity', 'ONE_TO_MANY', FALSE),
    ('SECURITY_FACTOR', 'Security factor schedule', 'SECURITY', 'FACTOR_SCHEDULE',
     'Expected and reported pool factors of an ABS or MBS', 'ONE_TO_MANY', FALSE),
    ('SECURITY_CALL', 'Security call schedule', 'SECURITY', 'CALL_SCHEDULE',
     'Call dates and call prices of a bond or ABS', 'ONE_TO_MANY', FALSE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 7. Working screen on the security
-- ============================================================

INSERT INTO public.record_experiences (
    experience_code, experience_name, description, anchor_domain_code,
    sections, pipeline, is_default, is_active
) VALUES (
    'SECURITY_TERMS',
    'Security terms',
    'Interest contracts, amortization, factor schedule, and call schedule for this security.',
    'SECURITY',
    '[
      {"key":"security","title":"Security","kind":"FORM","placement":"CANVAS","domainCode":"SECURITY","templateCode":"SECURITY_STANDARD"},
      {"key":"contracts","title":"Contracts","kind":"GRID","placement":"TAB","domainCode":"INTEREST_CONTRACT","relationshipCode":"SECURITY_CONTRACT","direction":"DOWN","templateCode":"INTEREST_CONTRACT_STANDARD","columns":["CONTRACT_EFFECTIVE_DATE","CONTRACT_END_DATE","CONTRACT_PAYMENT_DATE","CONTRACT_BASE_RATE","CONTRACT_SPREAD_BPS","CONTRACT_PIK_TOGGLE","CONTRACT_PIK_RATE","CONTRACT_UNFUNDED_RATE","CONTRACT_DAY_COUNT","CONTRACT_AMOUNT"]},
      {"key":"amortization","title":"Amortization","kind":"GRID","placement":"TAB","domainCode":"AMORTIZATION","relationshipCode":"SECURITY_AMORTIZATION","direction":"DOWN","templateCode":"AMORTIZATION_STANDARD","columns":["AMORT_DATE","AMORT_TYPE","AMORT_PRINCIPAL_AMOUNT","AMORT_PERCENT_OF_ORIGINAL","AMORT_BALANCE_AFTER","AMORT_STATUS"]},
      {"key":"factors","title":"Factor schedule","kind":"GRID","placement":"TAB","domainCode":"FACTOR_SCHEDULE","relationshipCode":"SECURITY_FACTOR","direction":"DOWN","templateCode":"FACTOR_SCHEDULE_STANDARD","columns":["FACTOR_DATE","FACTOR_PAYMENT_DATE","FACTOR_VALUE","FACTOR_KIND","FACTOR_PRINCIPAL_PAYDOWN","FACTOR_SPEED_TYPE","FACTOR_SPEED"]},
      {"key":"calls","title":"Call schedule","kind":"GRID","placement":"TAB","domainCode":"CALL_SCHEDULE","relationshipCode":"SECURITY_CALL","direction":"DOWN","templateCode":"CALL_SCHEDULE_STANDARD","columns":["CALL_DATE","CALL_END_DATE","CALL_PRICE","CALL_PROVISION","CALL_STYLE","CALL_STATUS"]}
    ]'::jsonb,
    NULL,
    TRUE,
    TRUE
)
ON CONFLICT (experience_code) DO UPDATE
SET experience_name = EXCLUDED.experience_name,
    description = EXCLUDED.description,
    anchor_domain_code = EXCLUDED.anchor_domain_code,
    sections = EXCLUDED.sections,
    is_default = EXCLUDED.is_default,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

NOTIFY pgrst, 'reload schema';
