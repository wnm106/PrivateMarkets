-- CLO 2.0 indenture model: entity types, attributes, controlled lists.
--
-- A CLO is a FUND (FUND_STRUCTURE = 'CLO'). Three entity types hang off it:
--   CLO_TRANSACTION  the indenture terms and test parameters (one per fund)
--   CLO_NOTE_CLASS   one issued liability class (A, B, C, D, E, F, Sub)
--   CLO_ACCOUNT      one trustee account (principal, interest, ramp-up, ...)
-- All three are children of the fund. Test results are not stored here. They
-- come out of the compliance engine (see 20261106110000_clo_compliance_engine).
--
-- Asset-level facts sit on the existing SECURITY, ISSUER, and POSITION types.
-- Attributes that only mean something inside a CLO carry a CLO_ prefix.
-- Generic loan facts (cov-lite, revolver, lien, default) do not.
--
-- Percent convention: every PERCENTAGE attribute here is stored as a percent
-- (7.5 means 7.5 percent, 125 means 125 percent), matching the compliance
-- engine's PERCENTAGE result unit.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('CLO_TRANSACTION', 'CLO Transaction', 'Indenture terms and test parameters for one CLO'),
    ('CLO_NOTE_CLASS', 'CLO Note Class', 'One issued liability class of a CLO'),
    ('CLO_ACCOUNT', 'CLO Account', 'A trustee account of a CLO')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('CLO_TRANSACTION', 'FUNDS', 40, 'FUND'),
    ('CLO_NOTE_CLASS', 'FUNDS', 41, 'FUND'),
    ('CLO_ACCOUNT', 'FUNDS', 42, 'FUND')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CLO_LOAN_TYPE', 'CLO Loan Type', 'SECURITY', 'Obligation type used by the eligibility criteria'),
    ('CLO_LIEN_PRIORITY', 'Lien Priority', 'SECURITY', 'Where the obligation ranks in the borrower capital structure'),
    ('CLO_ACCOUNT_TYPE', 'CLO Account Type', 'CLO_ACCOUNT', 'What the trustee account holds'),
    ('CLO_SALE_TYPE', 'CLO Sale Type', 'POSITION', 'Why the manager sold. Sale type decides where proceeds may go.'),
    ('CLO_NOTE_CLASS_CODE', 'CLO Note Class', 'CLO_NOTE_CLASS', 'Liability class'),
    ('MOODYS_RATING_SCALE', 'Moody''s Rating Scale', NULL, 'Moody''s long-term scale. Metadata carries the ordinal, the WARF rating factor, and the CCC bucket flag.'),
    ('SP_RATING_SCALE', 'S&P Rating Scale', NULL, 'S&P long-term scale. Metadata carries the ordinal and the CCC bucket flag.'),
    ('FITCH_RATING_SCALE', 'Fitch Rating Scale', NULL, 'Fitch long-term scale. Metadata carries the ordinal and the CCC bucket flag.'),
    ('CLO_RATING_OUTLOOK', 'Rating Outlook', NULL, 'Agency outlook or watch status')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CLO_LOAN_TYPE', 'SENIOR_SECURED', 'Senior secured loan', 1),
    ('CLO_LOAN_TYPE', 'FIRST_LIEN_LAST_OUT', 'First lien last-out loan', 2),
    ('CLO_LOAN_TYPE', 'SECOND_LIEN', 'Second lien loan', 3),
    ('CLO_LOAN_TYPE', 'MEZZANINE', 'Mezzanine', 4),
    ('CLO_LOAN_TYPE', 'SENIOR_UNSECURED', 'Senior unsecured loan', 5),
    ('CLO_LOAN_TYPE', 'HIGH_YIELD_BOND', 'High yield bond', 6),
    ('CLO_LOAN_TYPE', 'DIP', 'Debtor-in-possession loan', 7),
    ('CLO_LOAN_TYPE', 'BRIDGE', 'Bridge loan', 8),
    ('CLO_LOAN_TYPE', 'STRUCTURED_FINANCE', 'Structured finance obligation', 9),
    ('CLO_LOAN_TYPE', 'SYNTHETIC', 'Synthetic security', 10),
    ('CLO_LOAN_TYPE', 'ZERO_COUPON', 'Zero coupon obligation', 11),
    ('CLO_LOAN_TYPE', 'CASH_EQUIVALENT', 'Eligible investment (cash equivalent)', 12),
    ('CLO_LIEN_PRIORITY', 'FIRST_LIEN', 'First lien', 1),
    ('CLO_LIEN_PRIORITY', 'SECOND_LIEN', 'Second lien', 2),
    ('CLO_LIEN_PRIORITY', 'UNSECURED', 'Unsecured', 3),
    ('CLO_ACCOUNT_TYPE', 'PRINCIPAL', 'Principal collection account', 1),
    ('CLO_ACCOUNT_TYPE', 'INTEREST', 'Interest collection account', 2),
    ('CLO_ACCOUNT_TYPE', 'COLLECTION', 'Collection account', 3),
    ('CLO_ACCOUNT_TYPE', 'PAYMENT', 'Payment account', 4),
    ('CLO_ACCOUNT_TYPE', 'EXPENSE_RESERVE', 'Expense reserve account', 5),
    ('CLO_ACCOUNT_TYPE', 'RAMP_UP', 'Ramp-up account', 6),
    ('CLO_ACCOUNT_TYPE', 'CUSTODY', 'Custody account', 7),
    ('CLO_ACCOUNT_TYPE', 'UNFUNDED_REVOLVER', 'Unfunded revolver and delayed draw reserve', 8),
    ('CLO_SALE_TYPE', 'CREDIT_RISK', 'Credit risk obligation', 1),
    ('CLO_SALE_TYPE', 'CREDIT_IMPROVED', 'Credit improved obligation', 2),
    ('CLO_SALE_TYPE', 'DEFAULTED', 'Defaulted obligation', 3),
    ('CLO_SALE_TYPE', 'DISCRETIONARY', 'Discretionary sale', 4),
    ('CLO_SALE_TYPE', 'EQUITY', 'Equity security', 5),
    ('CLO_NOTE_CLASS_CODE', 'A', 'Class A', 1),
    ('CLO_NOTE_CLASS_CODE', 'B', 'Class B', 2),
    ('CLO_NOTE_CLASS_CODE', 'C', 'Class C', 3),
    ('CLO_NOTE_CLASS_CODE', 'D', 'Class D', 4),
    ('CLO_NOTE_CLASS_CODE', 'E', 'Class E', 5),
    ('CLO_NOTE_CLASS_CODE', 'F', 'Class F', 6),
    ('CLO_NOTE_CLASS_CODE', 'SUB', 'Subordinated notes', 7),
    ('CLO_RATING_OUTLOOK', 'STABLE', 'Stable', 1),
    ('CLO_RATING_OUTLOOK', 'POSITIVE', 'Positive', 2),
    ('CLO_RATING_OUTLOOK', 'NEGATIVE', 'Negative', 3),
    ('CLO_RATING_OUTLOOK', 'WATCH_POSITIVE', 'Watch positive', 4),
    ('CLO_RATING_OUTLOOK', 'WATCH_NEGATIVE', 'Watch negative', 5)
) AS v(list_code, code, label, ord) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- Rating scales. ordinal 1 is the best rating. ccc_bucket marks CCC+/Caa1 and below.
-- Moody's rating factors are the standard WARF table.
INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms, metadata)
SELECT rl.id, v.code, v.code, v.ord, '[]'::jsonb,
       jsonb_build_object('ordinal', v.ord, 'ccc_bucket', v.ccc)
       || CASE WHEN v.factor IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('rating_factor', v.factor) END
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('MOODYS_RATING_SCALE', 'Aaa', 1, FALSE, 1),
    ('MOODYS_RATING_SCALE', 'Aa1', 2, FALSE, 10),
    ('MOODYS_RATING_SCALE', 'Aa2', 3, FALSE, 20),
    ('MOODYS_RATING_SCALE', 'Aa3', 4, FALSE, 40),
    ('MOODYS_RATING_SCALE', 'A1', 5, FALSE, 70),
    ('MOODYS_RATING_SCALE', 'A2', 6, FALSE, 120),
    ('MOODYS_RATING_SCALE', 'A3', 7, FALSE, 180),
    ('MOODYS_RATING_SCALE', 'Baa1', 8, FALSE, 260),
    ('MOODYS_RATING_SCALE', 'Baa2', 9, FALSE, 360),
    ('MOODYS_RATING_SCALE', 'Baa3', 10, FALSE, 610),
    ('MOODYS_RATING_SCALE', 'Ba1', 11, FALSE, 940),
    ('MOODYS_RATING_SCALE', 'Ba2', 12, FALSE, 1350),
    ('MOODYS_RATING_SCALE', 'Ba3', 13, FALSE, 1766),
    ('MOODYS_RATING_SCALE', 'B1', 14, FALSE, 2220),
    ('MOODYS_RATING_SCALE', 'B2', 15, FALSE, 2720),
    ('MOODYS_RATING_SCALE', 'B3', 16, FALSE, 3490),
    ('MOODYS_RATING_SCALE', 'Caa1', 17, TRUE, 4770),
    ('MOODYS_RATING_SCALE', 'Caa2', 18, TRUE, 6500),
    ('MOODYS_RATING_SCALE', 'Caa3', 19, TRUE, 8070),
    ('MOODYS_RATING_SCALE', 'Ca', 20, TRUE, 10000),
    ('MOODYS_RATING_SCALE', 'C', 21, TRUE, 10000),
    ('SP_RATING_SCALE', 'AAA', 1, FALSE, NULL),
    ('SP_RATING_SCALE', 'AA+', 2, FALSE, NULL),
    ('SP_RATING_SCALE', 'AA', 3, FALSE, NULL),
    ('SP_RATING_SCALE', 'AA-', 4, FALSE, NULL),
    ('SP_RATING_SCALE', 'A+', 5, FALSE, NULL),
    ('SP_RATING_SCALE', 'A', 6, FALSE, NULL),
    ('SP_RATING_SCALE', 'A-', 7, FALSE, NULL),
    ('SP_RATING_SCALE', 'BBB+', 8, FALSE, NULL),
    ('SP_RATING_SCALE', 'BBB', 9, FALSE, NULL),
    ('SP_RATING_SCALE', 'BBB-', 10, FALSE, NULL),
    ('SP_RATING_SCALE', 'BB+', 11, FALSE, NULL),
    ('SP_RATING_SCALE', 'BB', 12, FALSE, NULL),
    ('SP_RATING_SCALE', 'BB-', 13, FALSE, NULL),
    ('SP_RATING_SCALE', 'B+', 14, FALSE, NULL),
    ('SP_RATING_SCALE', 'B', 15, FALSE, NULL),
    ('SP_RATING_SCALE', 'B-', 16, FALSE, NULL),
    ('SP_RATING_SCALE', 'CCC+', 17, TRUE, NULL),
    ('SP_RATING_SCALE', 'CCC', 18, TRUE, NULL),
    ('SP_RATING_SCALE', 'CCC-', 19, TRUE, NULL),
    ('SP_RATING_SCALE', 'CC', 20, TRUE, NULL),
    ('SP_RATING_SCALE', 'C', 21, TRUE, NULL),
    ('SP_RATING_SCALE', 'D', 22, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'AAA', 1, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'AA+', 2, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'AA', 3, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'AA-', 4, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'A+', 5, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'A', 6, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'A-', 7, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BBB+', 8, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BBB', 9, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BBB-', 10, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BB+', 11, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BB', 12, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'BB-', 13, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'B+', 14, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'B', 15, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'B-', 16, FALSE, NULL),
    ('FITCH_RATING_SCALE', 'CCC+', 17, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'CCC', 18, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'CCC-', 19, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'CC', 20, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'C', 21, TRUE, NULL),
    ('FITCH_RATING_SCALE', 'D', 22, TRUE, NULL)
) AS v(list_code, code, ord, ccc, factor) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- Loader helper: read one metadata key off a list value, for example the
-- Moody's rating factor or the ordinal of a rating. Returns NULL when the
-- rating is not on the scale. Ratings are matched case-insensitively.
CREATE OR REPLACE FUNCTION metadata_register.rating_scale_value(
    p_list_code VARCHAR,
    p_rating TEXT,
    p_key TEXT DEFAULT 'ordinal'
) RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(rlv.metadata ->> p_key, '')::NUMERIC
    FROM metadata_register.reference_lists rl
    JOIN metadata_register.reference_list_values rlv ON rlv.list_id = rl.id
    WHERE rl.list_code = p_list_code
      AND upper(rlv.value_code) = upper(trim(p_rating))
    LIMIT 1;
$$;

COMMENT ON FUNCTION metadata_register.rating_scale_value(VARCHAR, TEXT, TEXT) IS
    'Reads a numeric metadata key (ordinal, rating_factor) for a rating on a rating scale list. Loaders use it to fill CLO_MOODYS_RATING_FACTOR and the rating ordinals.';

GRANT EXECUTE ON FUNCTION metadata_register.rating_scale_value(VARCHAR, TEXT, TEXT) TO authenticated, service_role;

-- ============================================================
-- 3. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

-- Existing attribute codes are never overwritten (ON CONFLICT DO NOTHING).
-- tv: 'T' varies over time, 'S' is fixed at the grain it is stored.
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       v.list, v.multi, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       v.tv = 'T', CASE WHEN v.tv = 'T' THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    -- ---------------- CLO_TRANSACTION: dates ----------------
    ('CLO_CLOSING_DATE', 'Closing Date', 'DATE', 'Date the notes were issued', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 1, 'S'),
    ('CLO_EFFECTIVE_DATE', 'Effective Date', 'DATE', 'Date the ramp-up requirements were met', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 2, 'S'),
    ('CLO_REINVESTMENT_PERIOD_END', 'Reinvestment Period End', 'DATE', 'Last day the manager may reinvest principal proceeds', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 3, 'S'),
    ('CLO_NON_CALL_END', 'Non-Call Period End', 'DATE', 'First date the equity may call the notes', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 4, 'S'),
    ('CLO_STATED_MATURITY', 'Stated Maturity', 'DATE', 'Stated maturity of the notes. No asset may mature later.', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 5, 'S'),
    ('CLO_NEXT_DETERMINATION_DATE', 'Next Determination Date', 'DATE', 'Next date the trustee tests the portfolio', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 6, 'T'),
    ('CLO_NEXT_PAYMENT_DATE', 'Next Payment Date', 'DATE', 'Next date the waterfall pays', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 7, 'T'),
    ('CLO_PAYMENT_FREQUENCY', 'Payment Frequency', 'STRING', 'Quarterly or Semi-Annual', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 8, 'S'),
    ('CLO_BENCHMARK_FALLBACK', 'Benchmark Fallback', 'STRING', 'Rate used if the benchmark is unavailable', 'CLO_TRANSACTION', NULL, FALSE, 'Dates', 9, 'S'),

    -- ---------------- CLO_TRANSACTION: size and eligibility ----------------
    ('CLO_TARGET_INITIAL_PAR', 'Target Initial Par', 'CURRENCY', 'Target initial par amount of the portfolio', 'CLO_TRANSACTION', NULL, FALSE, 'Size', 10, 'S'),
    ('CLO_PERMITTED_JURISDICTIONS', 'Permitted Jurisdictions', 'STRING', 'ISO-2 countries an obligor may be domiciled in', 'CLO_TRANSACTION', NULL, TRUE, 'Size', 11, 'S'),
    ('CLO_SENIOR_EXPENSES', 'Senior Expenses', 'CURRENCY', 'Trustee, administrative and other fees ranking ahead of the notes for the period', 'CLO_TRANSACTION', NULL, FALSE, 'Size', 12, 'T'),

    -- ---------------- CLO_TRANSACTION: concentration limits (percent of collateral principal amount) ----------------
    ('CLO_MAX_SINGLE_OBLIGOR_PCT', 'Max Single Obligor', 'PERCENTAGE', 'Cap on any one obligor group', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 20, 'S'),
    ('CLO_MAX_CCC_PCT', 'Max CCC Bucket', 'PERCENTAGE', 'Cap on CCC+/Caa1-and-below obligations. Excess is haircut in the OC numerator.', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 21, 'S'),
    ('CLO_MAX_COV_LITE_PCT', 'Max Covenant-Lite', 'PERCENTAGE', 'Cap on covenant-lite loans', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 22, 'S'),
    ('CLO_MAX_SECOND_LIEN_PCT', 'Max Second Lien', 'PERCENTAGE', 'Cap on second lien loans', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 23, 'S'),
    ('CLO_MAX_FIXED_RATE_PCT', 'Max Fixed Rate', 'PERCENTAGE', 'Cap on fixed rate obligations', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 24, 'S'),
    ('CLO_MAX_DISCOUNT_PCT', 'Max Discount Obligations', 'PERCENTAGE', 'Cap on discount obligations', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 25, 'S'),
    ('CLO_MAX_NON_USD_PCT', 'Max Non-USD', 'PERCENTAGE', 'Cap on non-USD obligations', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 26, 'S'),
    ('CLO_MAX_DELAYED_DRAW_REVOLVER_PCT', 'Max Revolver and Delayed Draw', 'PERCENTAGE', 'Cap on revolving and delayed draw obligations', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 27, 'S'),
    ('CLO_MAX_PARTICIPATION_PCT', 'Max Participations', 'PERCENTAGE', 'Cap on participation interests', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 28, 'S'),
    ('CLO_MAX_DEFERRING_PCT', 'Max Deferring Obligations', 'PERCENTAGE', 'Cap on obligations deferring or capitalizing interest', 'CLO_TRANSACTION', NULL, FALSE, 'Concentration Limits', 29, 'S'),

    -- ---------------- CLO_TRANSACTION: collateral quality parameters ----------------
    ('CLO_MOODYS_MATRIX', 'Moody''s Matrix', 'JSON', 'Max WARF by diversity score row and WAS column', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 30, 'S'),
    ('CLO_MOODYS_MATRIX_ROW', 'Selected Matrix Row', 'INTEGER', 'Diversity score row of the selected Moody''s matrix cell', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 31, 'T'),
    ('CLO_MOODYS_MATRIX_COLUMN', 'Selected Matrix Column', 'DECIMAL', 'WAS column (bps) of the selected Moody''s matrix cell', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 32, 'T'),
    ('CLO_MAX_WARF', 'Max WARF', 'DECIMAL', 'Maximum weighted average rating factor. Resolved from the selected matrix cell.', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 33, 'T'),
    ('CLO_MIN_WAS_BPS', 'Min WAS (bps)', 'DECIMAL', 'Minimum weighted average spread in basis points', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 34, 'T'),
    ('CLO_MIN_WARR', 'Min WARR', 'PERCENTAGE', 'Minimum weighted average recovery rate (Moody''s)', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 35, 'S'),
    ('CLO_MIN_DIVERSITY_SCORE', 'Min Diversity Score', 'DECIMAL', 'Minimum Moody''s diversity score', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 36, 'T'),
    ('CLO_WAL_STEPDOWN_SCHEDULE', 'WAL Step-Down Schedule', 'JSON', 'Array of {from_date, max_wal_years}', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 37, 'S'),
    ('CLO_MAX_WAL_YEARS', 'Max WAL (years)', 'DECIMAL', 'Maximum weighted average life now in force. Resolved from the step-down schedule.', 'CLO_TRANSACTION', NULL, FALSE, 'Collateral Quality', 38, 'T'),

    -- ---------------- CLO_NOTE_CLASS ----------------
    ('CLO_NOTE_CLASS_CODE', 'Class', 'STRING', 'Liability class', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_CODE', FALSE, 'Class', 1, 'S'),
    ('CLO_NOTE_SENIORITY_RANK', 'Seniority Rank', 'INTEGER', '1 is the most senior. A coverage test for rank N covers every class of rank N or better.', 'CLO_NOTE_CLASS', NULL, FALSE, 'Class', 2, 'S'),
    ('CLO_NOTE_IS_DEFERRABLE', 'Deferrable', 'BOOLEAN', 'True when missed interest defers rather than defaults', 'CLO_NOTE_CLASS', NULL, FALSE, 'Class', 3, 'S'),
    ('CLO_NOTE_ORIGINAL_PAR', 'Original Par', 'CURRENCY', 'Par at issuance', 'CLO_NOTE_CLASS', NULL, FALSE, 'Balances', 10, 'S'),
    ('CLO_NOTE_PAR_OUTSTANDING', 'Par Outstanding', 'CURRENCY', 'Current outstanding principal of the class', 'CLO_NOTE_CLASS', NULL, FALSE, 'Balances', 11, 'T'),
    ('CLO_NOTE_DEFERRED_INTEREST', 'Deferred Interest', 'CURRENCY', 'Deferred interest capitalized on the class', 'CLO_NOTE_CLASS', NULL, FALSE, 'Balances', 12, 'T'),
    ('CLO_NOTE_INTEREST_DUE', 'Interest Due', 'CURRENCY', 'Scheduled interest on the class for the period', 'CLO_NOTE_CLASS', NULL, FALSE, 'Balances', 13, 'T'),
    ('CLO_NOTE_SPREAD_BPS', 'Coupon Spread (bps)', 'DECIMAL', 'Spread over the benchmark', 'CLO_NOTE_CLASS', NULL, FALSE, 'Terms', 20, 'S'),
    ('CLO_NOTE_OC_TRIGGER', 'OC Trigger', 'PERCENTAGE', 'Minimum overcollateralization ratio for this class, as a percent', 'CLO_NOTE_CLASS', NULL, FALSE, 'Triggers', 30, 'S'),
    ('CLO_NOTE_IC_TRIGGER', 'IC Trigger', 'PERCENTAGE', 'Minimum interest coverage ratio for this class, as a percent', 'CLO_NOTE_CLASS', NULL, FALSE, 'Triggers', 31, 'S'),
    ('CLO_NOTE_RATING_SP', 'S&P Rating', 'STRING', 'S&P rating of the class', 'CLO_NOTE_CLASS', 'SP_RATING_SCALE', FALSE, 'Ratings', 40, 'T'),
    ('CLO_NOTE_RATING_MOODYS', 'Moody''s Rating', 'STRING', 'Moody''s rating of the class', 'CLO_NOTE_CLASS', 'MOODYS_RATING_SCALE', FALSE, 'Ratings', 41, 'T'),
    ('CLO_NOTE_RATING_FITCH', 'Fitch Rating', 'STRING', 'Fitch rating of the class', 'CLO_NOTE_CLASS', 'FITCH_RATING_SCALE', FALSE, 'Ratings', 42, 'T'),

    -- ---------------- CLO_ACCOUNT ----------------
    ('CLO_ACCT_TYPE', 'Account Type', 'STRING', 'What the account holds. Principal and ramp-up cash count in the OC numerator.', 'CLO_ACCOUNT', 'CLO_ACCOUNT_TYPE', FALSE, 'Account', 1, 'S'),
    ('CLO_ACCT_CURRENCY', 'Currency', 'STRING', 'Currency of the account', 'CLO_ACCOUNT', NULL, FALSE, 'Account', 2, 'S'),
    ('CLO_ACCT_BALANCE', 'Balance', 'CURRENCY', 'Cash balance at the as-of date', 'CLO_ACCOUNT', NULL, FALSE, 'Balances', 10, 'T'),
    ('CLO_ACCT_UNINVESTED_PROCEEDS', 'Uninvested Proceeds', 'CURRENCY', 'Principal proceeds not yet reinvested', 'CLO_ACCOUNT', NULL, FALSE, 'Balances', 11, 'T'),

    -- ---------------- SECURITY: classification and eligibility ----------------
    ('CLO_LOAN_TYPE', 'CLO Loan Type', 'STRING', 'Obligation type for the eligibility criteria', 'SECURITY', 'CLO_LOAN_TYPE', FALSE, 'CLO Eligibility', 100, 'S'),
    ('LIEN_PRIORITY', 'Lien Priority', 'STRING', 'First lien, second lien or unsecured', 'SECURITY', 'CLO_LIEN_PRIORITY', FALSE, 'CLO Eligibility', 101, 'S'),
    ('IS_COV_LITE', 'Covenant-Lite', 'BOOLEAN', 'True when the loan has no maintenance covenant', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 102, 'S'),
    ('IS_REVOLVER', 'Revolver', 'BOOLEAN', 'True for a revolving credit facility', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 103, 'S'),
    ('IS_DELAYED_DRAW', 'Delayed Draw', 'BOOLEAN', 'True for a delayed draw term loan', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 104, 'S'),
    ('IS_PARTICIPATION', 'Participation', 'BOOLEAN', 'True when held as a participation rather than by assignment', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 105, 'S'),
    ('IS_FIXED_RATE', 'Fixed Rate', 'BOOLEAN', 'True when the coupon is fixed', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 106, 'S'),
    ('IS_DIP', 'Debtor-in-Possession', 'BOOLEAN', 'True for a DIP loan', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 107, 'S'),
    ('IS_BRIDGE', 'Bridge Loan', 'BOOLEAN', 'True for a bridge loan', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 108, 'S'),
    ('IS_CONVERTIBLE', 'Convertible', 'BOOLEAN', 'True when convertible into equity or another currency', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 109, 'S'),
    ('IS_STRUCTURED_FINANCE', 'Structured Finance', 'BOOLEAN', 'True for a structured finance obligation', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 110, 'S'),
    ('IS_DEFERRING_INTEREST', 'Deferring Interest', 'BOOLEAN', 'True when the obligor defers or capitalizes interest', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 111, 'T'),
    ('IS_DEFAULTED', 'Defaulted Obligation', 'BOOLEAN', 'True when the obligation is a Defaulted Obligation under the indenture', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 112, 'T'),
    ('DEFAULT_DATE', 'Default Date', 'DATE', 'Date the obligation became defaulted', 'SECURITY', NULL, FALSE, 'CLO Eligibility', 113, 'T'),

    -- ---------------- SECURITY: asset-level ratings and recoveries ----------------
    ('CLO_MOODYS_FACILITY_RATING', 'Moody''s Facility Rating', 'STRING', 'Moody''s rating of the facility', 'SECURITY', 'MOODYS_RATING_SCALE', FALSE, 'CLO Ratings', 120, 'T'),
    ('CLO_MOODYS_CFR', 'Moody''s CFR', 'STRING', 'Moody''s corporate family rating', 'SECURITY', 'MOODYS_RATING_SCALE', FALSE, 'CLO Ratings', 121, 'T'),
    ('CLO_MOODYS_DPR', 'Moody''s Default Probability Rating', 'STRING', 'Moody''s probability of default rating', 'SECURITY', 'MOODYS_RATING_SCALE', FALSE, 'CLO Ratings', 122, 'T'),
    ('CLO_MOODYS_RATING_FACTOR', 'Moody''s Rating Factor', 'NUMBER', 'WARF rating factor of the rating used by the indenture. Filled from the MOODYS_RATING_SCALE list.', 'SECURITY', NULL, FALSE, 'CLO Ratings', 123, 'T'),
    ('CLO_MOODYS_RATING_ORDINAL', 'Moody''s Rating Ordinal', 'INTEGER', 'Position on the Moody''s scale. 1 is Aaa. Used by rating floors.', 'SECURITY', NULL, FALSE, 'CLO Ratings', 124, 'T'),
    ('CLO_SP_FACILITY_RATING', 'S&P Facility Rating', 'STRING', 'S&P rating of the facility', 'SECURITY', 'SP_RATING_SCALE', FALSE, 'CLO Ratings', 125, 'T'),
    ('CLO_SP_RECOVERY_RATING', 'S&P Recovery Rating', 'STRING', 'S&P recovery rating, 1+ to 6', 'SECURITY', NULL, FALSE, 'CLO Ratings', 126, 'T'),
    ('CLO_SP_RATING_ORDINAL', 'S&P Rating Ordinal', 'INTEGER', 'Position on the S&P scale. 1 is AAA. Used by rating floors.', 'SECURITY', NULL, FALSE, 'CLO Ratings', 127, 'T'),
    ('CLO_FITCH_FACILITY_RATING', 'Fitch Facility Rating', 'STRING', 'Fitch rating of the facility', 'SECURITY', 'FITCH_RATING_SCALE', FALSE, 'CLO Ratings', 128, 'T'),
    ('CLO_RATING_OUTLOOK', 'Rating Outlook', 'STRING', 'Outlook or watch status of the controlling rating', 'SECURITY', 'CLO_RATING_OUTLOOK', FALSE, 'CLO Ratings', 129, 'T'),
    ('CLO_IS_CCC', 'In CCC Bucket', 'BOOLEAN', 'True when the controlling rating is CCC+/Caa1 or lower', 'SECURITY', NULL, FALSE, 'CLO Ratings', 130, 'T'),
    ('CLO_MOODYS_RECOVERY_RATE', 'Moody''s Recovery Rate', 'PERCENTAGE', 'Moody''s recovery rate assigned by the indenture tables', 'SECURITY', NULL, FALSE, 'CLO Recovery', 131, 'T'),
    ('CLO_SP_RECOVERY_RATE', 'S&P Recovery Rate', 'PERCENTAGE', 'S&P recovery rate assigned by the indenture tables', 'SECURITY', NULL, FALSE, 'CLO Recovery', 132, 'T'),
    ('CLO_FITCH_RECOVERY_RATE', 'Fitch Recovery Rate', 'PERCENTAGE', 'Fitch recovery rate assigned by the indenture tables', 'SECURITY', NULL, FALSE, 'CLO Recovery', 133, 'T'),

    -- ---------------- ISSUER ----------------
    ('MOODYS_ISSUER_RATING', 'Moody''s Issuer Rating', 'STRING', 'Moody''s issuer or corporate family rating', 'ISSUER', 'MOODYS_RATING_SCALE', FALSE, 'Ratings', 35, 'T'),
    ('MOODYS_INDUSTRY_CODE', 'Moody''s Industry Classification', 'STRING', 'Moody''s 33 industry category for the industry concentration limit and diversity score', 'ISSUER', NULL, FALSE, 'Classification', 14, 'S'),
    ('COUNTRY_OF_DOMICILE', 'Country of Domicile', 'STRING', 'ISO-2 country of the obligor domicile. Tested against the permitted jurisdictions.', 'ISSUER', NULL, FALSE, 'Identity', 4, 'S'),
    ('COUNTRY_OF_RISK', 'Country of Risk', 'STRING', 'ISO-2 country where the obligor earns most of its revenue', 'ISSUER', NULL, FALSE, 'Identity', 5, 'S'),
    ('OBLIGOR_GROUP_ID', 'Obligor Group', 'STRING', 'Key shared by affiliated obligors. The single-obligor cap groups on it.', 'ISSUER', NULL, FALSE, 'Identity', 6, 'S'),
    ('IS_AFFILIATED_WITH_MANAGER', 'Affiliated With Manager', 'BOOLEAN', 'True when the obligor is an affiliate of the collateral manager', 'ISSUER', NULL, FALSE, 'Regulatory', 23, 'T'),

    -- ---------------- POSITION: adjusted par inputs and trade lifecycle ----------------
    ('CLO_DEFAULT_CARRY_VALUE', 'Defaulted Carry Value', 'CURRENCY', 'Value a defaulted obligation carries in the OC numerator: the lesser of market value and recovery times par', 'POSITION', NULL, FALSE, 'CLO Adjusted Par', 80, 'T'),
    ('CLO_DISCOUNT_HAIRCUT', 'Discount Haircut', 'CURRENCY', 'Par less purchase price for a discount obligation', 'POSITION', NULL, FALSE, 'CLO Adjusted Par', 81, 'T'),
    ('CLO_IS_DISCOUNT_OBLIGATION', 'Discount Obligation', 'BOOLEAN', 'True when bought below the discount threshold price', 'POSITION', NULL, FALSE, 'CLO Adjusted Par', 82, 'T'),
    ('CLO_DISCOUNT_THRESHOLD_PRICE', 'Discount Threshold Price', 'DECIMAL', 'Price below which the obligation is a discount obligation', 'POSITION', NULL, FALSE, 'CLO Adjusted Par', 83, 'S'),
    ('CLO_EXPECTED_INTEREST', 'Expected Interest Collections', 'CURRENCY', 'Interest this position is expected to pay in the period. Defaulted and deferring positions are zero.', 'POSITION', NULL, FALSE, 'CLO Adjusted Par', 84, 'T'),
    ('CLO_IS_CREDIT_RISK', 'Credit Risk Obligation', 'BOOLEAN', 'Manager has determined this is a credit risk obligation', 'POSITION', NULL, FALSE, 'CLO Trading', 90, 'T'),
    ('CLO_IS_CREDIT_IMPROVED', 'Credit Improved Obligation', 'BOOLEAN', 'Manager has determined this is a credit improved obligation', 'POSITION', NULL, FALSE, 'CLO Trading', 91, 'T'),
    ('CLO_ACQUISITION_DATE', 'Acquisition Date', 'DATE', 'Date the CLO acquired the obligation', 'POSITION', NULL, FALSE, 'CLO Trading', 92, 'S'),
    ('CLO_SALE_TYPE', 'Sale Type', 'STRING', 'Why the position was or will be sold', 'POSITION', 'CLO_SALE_TYPE', FALSE, 'CLO Trading', 93, 'T'),
    ('CLO_REINVESTMENT_ELIGIBLE', 'Reinvestment Eligible', 'BOOLEAN', 'True when proceeds of this position may be reinvested', 'POSITION', NULL, FALSE, 'CLO Trading', 94, 'T'),
    ('CLO_IS_UNSETTLED', 'Unsettled Trade', 'BOOLEAN', 'True when the trade has not settled', 'POSITION', NULL, FALSE, 'CLO Trading', 95, 'T')
) AS v(code, name, dtype, descr, dom, list, multi, section, grp, tv)
ON CONFLICT (attribute_code) DO NOTHING;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('CLO_TRANSACTION_STANDARD', 'Standard CLO Transaction', 'CLO_TRANSACTION', 'Indenture terms and test parameters'),
    ('CLO_NOTE_CLASS_STANDARD', 'Standard CLO Note Class', 'CLO_NOTE_CLASS', 'One issued liability class'),
    ('CLO_ACCOUNT_STANDARD', 'Standard CLO Account', 'CLO_ACCOUNT', 'A trustee account')
ON CONFLICT (template_code) DO NOTHING;

-- The three CLO domains get a template of their own attributes.
INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.domain_code IN ('CLO_TRANSACTION', 'CLO_NOTE_CLASS', 'CLO_ACCOUNT')
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- New SECURITY, ISSUER and POSITION attributes join their standard templates.
INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.display_section IN ('CLO Eligibility', 'CLO Ratings', 'CLO Recovery', 'CLO Adjusted Par', 'CLO Trading')
   OR a.attribute_code IN (
        'MOODYS_ISSUER_RATING', 'MOODYS_INDUSTRY_CODE', 'COUNTRY_OF_DOMICILE',
        'COUNTRY_OF_RISK', 'OBLIGOR_GROUP_ID', 'IS_AFFILIATED_WITH_MANAGER'
   )
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships (the CLO types are children of the fund)
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('FUND_CLO_TRANSACTION', 'CLO transaction of fund', 'FUND', 'CLO_TRANSACTION', 'The indenture terms of the CLO fund', 'ONE_TO_MANY', FALSE),
    ('FUND_CLO_NOTE_CLASS', 'Note class of fund', 'FUND', 'CLO_NOTE_CLASS', 'A liability class issued by the CLO fund', 'ONE_TO_MANY', FALSE),
    ('FUND_CLO_ACCOUNT', 'Account of fund', 'FUND', 'CLO_ACCOUNT', 'A trustee account of the CLO fund', 'ONE_TO_MANY', FALSE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

NOTIFY pgrst, 'reload schema';
