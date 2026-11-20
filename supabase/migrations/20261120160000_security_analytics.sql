-- Risk, performance, and structure analytics on a security.
--
-- One Analytics section holds the profile a risk or performance process
-- reads: bond yields and spreads, rate and credit sensitivities, loan and
-- pool life, equity risk, and total return. Contractual terms stay where
-- they are. Spread (bps) is the contractual margin. Benchmark Spread is the
-- traded spread.
--
-- Units, stored the way the screen formats them:
--   PERCENTAGE  percent points. 4.25 is 4.25 percent, not 0.0425.
--   bps         basis points. 142.50 is 142.50 bps.
--   years       years. 7.2531 is 7.2531 years.
--   months      months.
--   multiple    a ratio shown with an x. 1.25 is 1.25x. 18.4 is 18.4x.
--   price       points per 100 of face. DV01 and CS01 are the price change
--               for a 1 basis point move. 0.075234 is about 7.5 cents per
--               100 of face. A clean price of 99.25 is 99.25 percent of par.
--   Max drawdown is negative. Value at risk and jump to default are positive
--   losses. Key-rate durations sum to interest rate duration. Partial DV01s
--   sum to rate DV01. Partial CS01s sum to CS01.
--
-- Every figure is valid-time, because a profile is a snapshot on a date.
-- Yields, spreads, durations, DV01, CS01, and loan life roll up by current
-- outstanding amount. Equity and performance roll up by issue market value.
-- Issue market value itself sums.

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, column_count)
SELECT 'SECURITY', 'Analytics', 200, 4
WHERE NOT EXISTS (
    SELECT 1
    FROM metadata_register.attribute_sections existing
    WHERE existing.domain_code = 'SECURITY'
      AND lower(existing.section_name) = 'analytics'
);

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('ANALYTICS_PRICE_BASIS', 'Analytics Price Basis', 'SECURITY', 'The quote the analytics price is'),
    ('YIELD_COMPOUNDING', 'Yield Compounding', 'SECURITY', 'How a yield in the analytics profile is compounded'),
    ('PREPAY_MODEL', 'Prepayment Model', 'SECURITY', 'The prepayment assumption used by the analytics')
ON CONFLICT (list_code) DO UPDATE
SET list_name = EXCLUDED.list_name,
    domain_code = EXCLUDED.domain_code,
    description = EXCLUDED.description;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT l.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists l
JOIN (VALUES
    ('ANALYTICS_PRICE_BASIS', 'CLEAN', 'Clean', 1, '["Clean price"]'),
    ('ANALYTICS_PRICE_BASIS', 'DIRTY', 'Dirty', 2, '["Dirty price", "Invoice"]'),
    ('ANALYTICS_PRICE_BASIS', 'MID', 'Mid', 3, '["Mid market"]'),
    ('ANALYTICS_PRICE_BASIS', 'BID', 'Bid', 4, '[]'),
    ('ANALYTICS_PRICE_BASIS', 'OFFER', 'Offer', 5, '["Ask"]'),
    ('ANALYTICS_PRICE_BASIS', 'MARK', 'Mark', 6, '["Fair value", "Valuation"]'),
    ('YIELD_COMPOUNDING', 'STREET', 'Street', 1, '["US street", "Street convention", "Semi-annual bond basis"]'),
    ('YIELD_COMPOUNDING', 'SEMI_ANNUAL', 'Semi-annual', 2, '["Semiannual", "Semi annual"]'),
    ('YIELD_COMPOUNDING', 'ANNUAL', 'Annual', 3, '["Annually"]'),
    ('YIELD_COMPOUNDING', 'QUARTERLY', 'Quarterly', 4, '[]'),
    ('YIELD_COMPOUNDING', 'MONTHLY', 'Monthly', 5, '[]'),
    ('YIELD_COMPOUNDING', 'CONTINUOUS', 'Continuous', 6, '[]'),
    ('YIELD_COMPOUNDING', 'SIMPLE', 'Simple', 7, '["Money market simple"]'),
    ('YIELD_COMPOUNDING', 'MONEY_MARKET', 'Money market', 8, '[]'),
    ('PREPAY_MODEL', 'NONE', 'None', 1, '["No prepay", "Zero CPR"]'),
    ('PREPAY_MODEL', 'CPR', 'CPR', 2, '["Constant prepayment rate"]'),
    ('PREPAY_MODEL', 'PSA', 'PSA', 3, '["Public Securities Association"]'),
    ('PREPAY_MODEL', 'SMM', 'SMM', 4, '["Single monthly mortality"]'),
    ('PREPAY_MODEL', 'PPC', 'PPC', 5, '["Prospectus prepayment curve"]'),
    ('PREPAY_MODEL', 'ABS', 'ABS', 6, '["Absolute prepayment speed"]'),
    ('PREPAY_MODEL', 'MODEL', 'Vendor model', 7, '["Intex", "Bloomberg", "Yield Book"]')
) AS v(list_code, code, label, ord, syn) ON v.list_code = l.list_code
ON CONFLICT (list_id, value_code) DO UPDATE
SET value_label = EXCLUDED.value_label,
    display_order = EXCLUDED.display_order,
    synonyms = EXCLUDED.synonyms;

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    unit_of_measure, display_format, numeric_precision, reference_list_code,
    domain_code, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, aggregation_type, weight_attribute_code
)
SELECT v.code, v.name, v.dtype, v.descr,
       v.unit, v.fmt, v.prec, v.list,
       'SECURITY', FALSE, 100,
       'Analytics', v.grp, TRUE, TRUE,
       TRUE, 'VALID_TIME',
       'NONE', NULL
FROM (VALUES
    ('ANALYTICS_AS_OF_DATE', 'Analytics As-of Date', 'DATE', 'Date this risk profile was calculated.', NULL::text, NULL::text, NULL::integer, NULL::text, 10, NULL::text),
    ('ANALYTICS_SETTLEMENT_DATE', 'Analytics Settlement Date', 'DATE', 'Settlement date assumed by the yields, accrued interest, and day count.', NULL::text, NULL::text, NULL::integer, NULL::text, 20, NULL::text),
    ('CLEAN_PRICE', 'Clean Price', 'DECIMAL', 'Clean price the analytics were struck on, as a percent of par. 99.25 is 99.25 percent of principal.', 'price', 'price', 6, NULL::text, 30, 'PAR'),
    ('DIRTY_PRICE', 'Dirty Price', 'DECIMAL', 'Clean price plus accrued interest, as a percent of par.', 'price', 'price', 6, NULL::text, 40, 'PAR'),
    ('ACCRUED_INTEREST_PER_100', 'Accrued Interest per 100', 'DECIMAL', 'Accrued interest per 100 of face used to reach the dirty price.', 'price', 'price', 6, NULL::text, 50, 'PAR'),
    ('ANALYTICS_PRICE_BASIS', 'Price Basis', 'REFERENCE_LIST', 'Whether the analytics price is clean, dirty, mid, bid, offer, or a mark.', NULL::text, NULL::text, NULL::integer, 'ANALYTICS_PRICE_BASIS', 60, NULL::text),
    ('YIELD_COMPOUNDING', 'Yield Compounding', 'REFERENCE_LIST', 'How the yields in this profile are compounded. US street convention is a semi-annual bond basis.', NULL::text, NULL::text, NULL::integer, 'YIELD_COMPOUNDING', 70, NULL::text),
    ('DISCOUNT_CURVE', 'Discount Curve', 'STRING', 'Curve used to discount cash flows, such as USD SOFR or the government curve.', NULL::text, NULL::text, NULL::integer, NULL::text, 80, NULL::text),
    ('SPREAD_BENCHMARK', 'Spread Benchmark', 'STRING', 'Curve the market spreads are measured against.', NULL::text, NULL::text, NULL::integer, NULL::text, 90, NULL::text),
    ('ANALYTICS_MODEL', 'Analytics Model', 'STRING', 'Model that produced this profile, such as Bloomberg YAS, ICE, Intex, or an internal model.', NULL::text, NULL::text, NULL::integer, NULL::text, 100, NULL::text),
    ('PREPAY_MODEL', 'Prepayment Model', 'REFERENCE_LIST', 'Prepayment assumption used for average life, option-adjusted spread, and effective duration.', NULL::text, NULL::text, NULL::integer, 'PREPAY_MODEL', 110, NULL::text),
    ('ISSUE_MARKET_VALUE', 'Issue Market Value', 'CURRENCY', 'Market value used to weight equity and performance analytics. Price times principal for a bond, price times shares for equity.', 'USD', 'currency', 2, NULL::text, 120, 'SUM'),
    ('YIELD_TO_MATURITY', 'Yield to Maturity', 'PERCENTAGE', 'Annualized discount rate that equates the dirty price to the remaining cash flows through final maturity.', '%', 'percentage', 4, NULL::text, 200, 'PAR'),
    ('YIELD_TO_WORST', 'Yield to Worst', 'PERCENTAGE', 'Lowest annualized yield across final maturity and every call and put.', '%', 'percentage', 4, NULL::text, 210, 'PAR'),
    ('YIELD_TO_CALL', 'Yield to Call', 'PERCENTAGE', 'Annualized yield to the next call date, using the call price.', '%', 'percentage', 4, NULL::text, 220, 'PAR'),
    ('YIELD_TO_PUT', 'Yield to Put', 'PERCENTAGE', 'Annualized yield to the next put date, using the put price.', '%', 'percentage', 4, NULL::text, 230, 'PAR'),
    ('YIELD_TO_AVERAGE_LIFE', 'Yield to Average Life', 'PERCENTAGE', 'Annualized yield to the weighted average life rather than legal final maturity.', '%', 'percentage', 4, NULL::text, 240, 'PAR'),
    ('YIELD_TO_RESET', 'Yield to Reset', 'PERCENTAGE', 'Annualized yield of a floating-rate security measured to the next rate reset.', '%', 'percentage', 4, NULL::text, 250, 'PAR'),
    ('BOND_EQUIVALENT_YIELD', 'Bond Equivalent Yield', 'PERCENTAGE', 'Yield restated onto a semi-annual bond basis so it compares with a Treasury.', '%', 'percentage', 4, NULL::text, 260, 'PAR'),
    ('REAL_YIELD', 'Real Yield', 'PERCENTAGE', 'Yield after expected inflation.', '%', 'percentage', 4, NULL::text, 270, 'PAR'),
    ('BREAKEVEN_INFLATION', 'Breakeven Inflation', 'PERCENTAGE', 'Inflation rate that equates the nominal yield with the real yield.', '%', 'percentage', 4, NULL::text, 280, 'PAR'),
    ('YIELD_TO_WORST_DATE', 'Yield to Worst Date', 'DATE', 'Call, put, or maturity date that produces the yield to worst.', NULL::text, NULL::text, NULL::integer, NULL::text, 300, NULL::text),
    ('EXPECTED_MATURITY_DATE', 'Expected Maturity Date', 'DATE', 'Maturity the model expects after calls, puts, and prepayments.', NULL::text, NULL::text, NULL::integer, NULL::text, 310, NULL::text),
    ('G_SPREAD_BPS', 'G-Spread', 'DECIMAL', 'Spread over the interpolated government yield, in basis points.', 'bps', 'bps', 2, NULL::text, 400, 'PAR'),
    ('I_SPREAD_BPS', 'I-Spread', 'DECIMAL', 'Spread over the interpolated swap rate, in basis points.', 'bps', 'bps', 2, NULL::text, 410, 'PAR'),
    ('Z_SPREAD_BPS', 'Z-Spread', 'DECIMAL', 'Constant spread over the spot curve that reprices the security, in basis points.', 'bps', 'bps', 2, NULL::text, 420, 'PAR'),
    ('OAS_BPS', 'Option-Adjusted Spread', 'DECIMAL', 'Z-spread after the value of embedded calls, puts, and prepayments, in basis points.', 'bps', 'bps', 2, NULL::text, 430, 'PAR'),
    ('ASSET_SWAP_SPREAD_BPS', 'Asset Swap Spread', 'DECIMAL', 'Par asset-swap spread, in basis points.', 'bps', 'bps', 2, NULL::text, 440, 'PAR'),
    ('DISCOUNT_MARGIN_BPS', 'Discount Margin', 'DECIMAL', 'Margin over the forward curve that reprices a floating-rate loan or note, in basis points.', 'bps', 'bps', 2, NULL::text, 450, 'PAR'),
    ('SPREAD_TO_MATURITY_BPS', 'Spread to Maturity', 'DECIMAL', 'Yield to maturity minus the benchmark yield of the same date, in basis points.', 'bps', 'bps', 2, NULL::text, 460, 'PAR'),
    ('SPREAD_TO_WORST_BPS', 'Spread to Worst', 'DECIMAL', 'Yield to worst minus the benchmark yield of the same date, in basis points.', 'bps', 'bps', 2, NULL::text, 470, 'PAR'),
    ('CDS_SPREAD_BPS', 'CDS Spread', 'DECIMAL', 'Par credit default swap spread of the issuer at a matching tenor, in basis points.', 'bps', 'bps', 2, NULL::text, 480, 'PAR'),
    ('OPTION_COST_BPS', 'Option Cost', 'DECIMAL', 'Z-spread minus the option-adjusted spread, in basis points. This is the cost of the embedded option.', 'bps', 'bps', 2, NULL::text, 490, 'PAR'),
    ('BENCHMARK_SPREAD_BPS', 'Benchmark Spread', 'DECIMAL', 'Traded spread versus the spread benchmark, in basis points. The contractual margin is Spread (bps), which is a term of the security and not this field.', 'bps', 'bps', 2, NULL::text, 500, 'PAR'),
    ('WAL_YEARS', 'Weighted Average Life', 'NUMBER', 'Principal-weighted years from the analytics settlement date to each principal repayment.', 'years', 'years', 4, NULL::text, 600, 'PAR'),
    ('YEARS_TO_MATURITY', 'Years to Maturity', 'NUMBER', 'Years from the analytics settlement date to legal final maturity.', 'years', 'years', 4, NULL::text, 610, 'PAR'),
    ('YEARS_TO_WORST', 'Years to Worst', 'NUMBER', 'Years from the analytics settlement date to the yield-to-worst date.', 'years', 'years', 4, NULL::text, 620, 'PAR'),
    ('YEARS_TO_CALL', 'Years to Call', 'NUMBER', 'Years from the analytics settlement date to the next call.', 'years', 'years', 4, NULL::text, 630, 'PAR'),
    ('WAM_MONTHS', 'Weighted Average Maturity', 'NUMBER', 'Principal-weighted remaining term of the collateral, in months.', 'months', 'months', 1, NULL::text, 640, 'PAR'),
    ('WALA_MONTHS', 'Weighted Average Loan Age', 'NUMBER', 'Principal-weighted age of the collateral loans, in months.', 'months', 'months', 1, NULL::text, 650, 'PAR'),
    ('WAC', 'Weighted Average Coupon', 'PERCENTAGE', 'Principal-weighted coupon of the collateral.', '%', 'percentage', 4, NULL::text, 660, 'PAR'),
    ('CURRENT_FACTOR', 'Current Factor', 'DECIMAL', 'Pool factor. 1 is a full pool. 0.82 means 82 percent of original principal is still outstanding.', 'factor', 'price', 8, NULL::text, 670, 'PAR'),
    ('PRINCIPAL_WINDOW_START', 'Principal Window Start', 'DATE', 'First date the model expects principal to be repaid.', NULL::text, NULL::text, NULL::integer, NULL::text, 680, NULL::text),
    ('PRINCIPAL_WINDOW_END', 'Principal Window End', 'DATE', 'Last date the model expects principal to be repaid.', NULL::text, NULL::text, NULL::integer, NULL::text, 690, NULL::text),
    ('ASSUMED_CPR', 'Assumed CPR', 'PERCENTAGE', 'Constant prepayment rate assumed by the model.', '%', 'percentage', 4, NULL::text, 700, 'PAR'),
    ('ASSUMED_PSA', 'Assumed PSA', 'NUMBER', 'PSA prepayment speed. 100 is the standard PSA ramp.', 'PSA', NULL::text, 1, NULL::text, 710, 'PAR'),
    ('ASSUMED_SMM', 'Assumed SMM', 'PERCENTAGE', 'Single monthly mortality assumed by the model.', '%', 'percentage', 4, NULL::text, 720, 'PAR'),
    ('FACILITY_LTV', 'Facility LTV', 'PERCENTAGE', 'Loan to value of this facility.', '%', 'percentage', 4, NULL::text, 730, 'PAR'),
    ('FACILITY_DSCR', 'Facility DSCR', 'NUMBER', 'Debt service coverage of this facility. Cash flow over cash debt service.', 'x', 'multiple', 2, NULL::text, 740, 'PAR'),
    ('FACILITY_DEBT_YIELD', 'Facility Debt Yield', 'PERCENTAGE', 'Cash flow over the facility amount.', '%', 'percentage', 4, NULL::text, 750, 'PAR'),
    ('MACAULAY_DURATION', 'Macaulay Duration', 'NUMBER', 'Present-value-weighted years until the cash flows are received.', 'years', 'years', 4, NULL::text, 800, 'PAR'),
    ('MODIFIED_DURATION', 'Modified Duration', 'NUMBER', 'Percent price decline for a 1 percent rise in yield, before embedded options. Macaulay duration divided by one plus the yield per period.', 'years', 'years', 4, NULL::text, 810, 'PAR'),
    ('MODIFIED_DURATION_TO_WORST', 'Modified Duration to Worst', 'NUMBER', 'Modified duration measured to the yield-to-worst date.', 'years', 'years', 4, NULL::text, 830, 'PAR'),
    ('SPREAD_DURATION', 'Spread Duration', 'NUMBER', 'Percent price decline for a 1 percent widening of the credit spread.', 'years', 'years', 4, NULL::text, 840, 'PAR'),
    ('OAS_DURATION', 'OAS Duration', 'NUMBER', 'Option-adjusted sensitivity of price to the option-adjusted spread, in years.', 'years', 'years', 4, NULL::text, 850, 'PAR'),
    ('CREDIT_DURATION', 'Credit Duration', 'NUMBER', 'Sensitivity of price to the issuer credit curve, in years.', 'years', 'years', 4, NULL::text, 860, 'PAR'),
    ('RATE_DURATION', 'Interest Rate Duration', 'NUMBER', 'Sensitivity of price to the discount curve with the credit spread held fixed, in years.', 'years', 'years', 4, NULL::text, 870, 'PAR'),
    ('INFLATION_DURATION', 'Inflation Duration', 'NUMBER', 'Sensitivity of price to breakeven inflation, in years.', 'years', 'years', 4, NULL::text, 880, 'PAR'),
    ('EMPIRICAL_DURATION', 'Empirical Duration', 'NUMBER', 'Duration estimated from realized price changes rather than from the cash-flow model.', 'years', 'years', 4, NULL::text, 890, 'PAR'),
    ('PREPAY_DURATION', 'Prepayment Duration', 'NUMBER', 'Sensitivity of price to the prepayment assumption, in years.', 'years', 'years', 4, NULL::text, 900, 'PAR'),
    ('INDEX_DURATION', 'Index Duration', 'NUMBER', 'Duration of a floating-rate security to its index. It is near zero between resets.', 'years', 'years', 4, NULL::text, 910, 'PAR'),
    ('KRD_3M', 'Key Rate Duration 3M', 'NUMBER', 'Partial duration to the 3-month point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 920, 'PAR'),
    ('KRD_6M', 'Key Rate Duration 6M', 'NUMBER', 'Partial duration to the 6-month point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 930, 'PAR'),
    ('KRD_1Y', 'Key Rate Duration 1Y', 'NUMBER', 'Partial duration to the 1-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 940, 'PAR'),
    ('KRD_2Y', 'Key Rate Duration 2Y', 'NUMBER', 'Partial duration to the 2-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 950, 'PAR'),
    ('KRD_3Y', 'Key Rate Duration 3Y', 'NUMBER', 'Partial duration to the 3-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 960, 'PAR'),
    ('KRD_5Y', 'Key Rate Duration 5Y', 'NUMBER', 'Partial duration to the 5-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 970, 'PAR'),
    ('KRD_7Y', 'Key Rate Duration 7Y', 'NUMBER', 'Partial duration to the 7-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 980, 'PAR'),
    ('KRD_10Y', 'Key Rate Duration 10Y', 'NUMBER', 'Partial duration to the 10-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 990, 'PAR'),
    ('KRD_15Y', 'Key Rate Duration 15Y', 'NUMBER', 'Partial duration to the 15-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 1000, 'PAR'),
    ('KRD_20Y', 'Key Rate Duration 20Y', 'NUMBER', 'Partial duration to the 20-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 1010, 'PAR'),
    ('KRD_30Y', 'Key Rate Duration 30Y', 'NUMBER', 'Partial duration to the 30-year point of the discount curve, in years. The key-rate durations sum to the interest rate duration.', 'years', 'years', 4, NULL::text, 1020, 'PAR'),
    ('CONVEXITY', 'Convexity', 'NUMBER', 'Modified convexity, the curvature of price versus yield. Positive for an option-free bond.', 'years^2', NULL::text, 4, NULL::text, 1100, 'PAR'),
    ('EFFECTIVE_CONVEXITY', 'Effective Convexity', 'NUMBER', 'Option-adjusted convexity. Negative when the security is a mortgage pool or is trading to a call.', 'years^2', NULL::text, 4, NULL::text, 1110, 'PAR'),
    ('SPREAD_CONVEXITY', 'Spread Convexity', 'NUMBER', 'Convexity of price versus the credit spread.', 'years^2', NULL::text, 4, NULL::text, 1120, 'PAR'),
    ('OAS_CONVEXITY', 'OAS Convexity', 'NUMBER', 'Option-adjusted convexity versus the option-adjusted spread.', 'years^2', NULL::text, 4, NULL::text, 1130, 'PAR'),
    ('DV01', 'DV01', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 basis point rise in yield. 0.075 means the price falls about 0.075 points.', 'price/bp', 'price', 6, NULL::text, 1200, 'PAR'),
    ('PV01', 'PV01', 'DECIMAL', 'Present value of a 1 basis point change in the discount rate, in points per 100 of face. Equals DV01 for an option-free fixed bond.', 'price/bp', 'price', 6, NULL::text, 1210, 'PAR'),
    ('RATE_DV01', 'Rate DV01', 'DECIMAL', 'DV01 to the interest-rate curve with the credit spread held fixed, in points per 100 of face.', 'price/bp', 'price', 6, NULL::text, 1220, 'PAR'),
    ('GOVT_DV01', 'Government DV01', 'DECIMAL', 'DV01 to the government curve, in points per 100 of face.', 'price/bp', 'price', 6, NULL::text, 1230, 'PAR'),
    ('SWAP_DV01', 'Swap DV01', 'DECIMAL', 'DV01 to the swap curve, in points per 100 of face.', 'price/bp', 'price', 6, NULL::text, 1240, 'PAR'),
    ('OIS_DV01', 'OIS DV01', 'DECIMAL', 'DV01 to the overnight index swap curve, in points per 100 of face.', 'price/bp', 'price', 6, NULL::text, 1250, 'PAR'),
    ('INFLATION_DV01', 'Inflation DV01', 'DECIMAL', 'DV01 to the breakeven inflation curve, in points per 100 of face.', 'price/bp', 'price', 6, NULL::text, 1260, 'PAR'),
    ('DV01_1M', 'DV01 1M', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 1-month point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1300, 'PAR'),
    ('DV01_3M', 'DV01 3M', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 3-month point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1310, 'PAR'),
    ('DV01_6M', 'DV01 6M', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 6-month point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1320, 'PAR'),
    ('DV01_1Y', 'DV01 1Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 1-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1330, 'PAR'),
    ('DV01_2Y', 'DV01 2Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 2-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1340, 'PAR'),
    ('DV01_3Y', 'DV01 3Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 3-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1350, 'PAR'),
    ('DV01_5Y', 'DV01 5Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 5-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1360, 'PAR'),
    ('DV01_7Y', 'DV01 7Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 7-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1370, 'PAR'),
    ('DV01_10Y', 'DV01 10Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 10-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1380, 'PAR'),
    ('DV01_12Y', 'DV01 12Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 12-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1390, 'PAR'),
    ('DV01_15Y', 'DV01 15Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 15-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1400, 'PAR'),
    ('DV01_20Y', 'DV01 20Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 20-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1410, 'PAR'),
    ('DV01_25Y', 'DV01 25Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 25-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1420, 'PAR'),
    ('DV01_30Y', 'DV01 30Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 30-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1430, 'PAR'),
    ('DV01_40Y', 'DV01 40Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 40-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1440, 'PAR'),
    ('DV01_50Y', 'DV01 50Y', 'DECIMAL', 'Partial DV01 to a 1 basis point bump of the 50-year point, in price points per 100 of face. The partials sum to the rate DV01.', 'price/bp', 'price', 6, NULL::text, 1450, 'PAR'),
    ('CS01', 'CS01', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 basis point widening of the credit spread.', 'price/bp', 'price', 6, NULL::text, 1500, 'PAR'),
    ('CDS_CS01', 'CDS CS01', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 basis point widening of the credit default swap curve.', 'price/bp', 'price', 6, NULL::text, 1510, 'PAR'),
    ('RECOVERY_01', 'Recovery 01', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 percentage point increase in assumed recovery.', 'price/bp', 'price', 6, NULL::text, 1520, 'PAR'),
    ('JUMP_TO_DEFAULT', 'Jump to Default', 'PERCENTAGE', 'Percent of par lost if the issuer defaults immediately and recovery is realized at the assumed recovery. A loss of 60 percent of par is 60.', '%', 'percentage', 4, NULL::text, 1530, 'PAR'),
    ('ASSUMED_RECOVERY_RATE', 'Assumed Recovery', 'PERCENTAGE', 'Recovery the credit model assumes, as a percent of par.', '%', 'percentage', 4, NULL::text, 1540, 'PAR'),
    ('IMPLIED_PD', 'Implied Default Probability', 'PERCENTAGE', 'Annualized probability of default implied by the credit spread and the assumed recovery.', '%', 'percentage', 4, NULL::text, 1550, 'PAR'),
    ('HAZARD_RATE', 'Hazard Rate', 'PERCENTAGE', 'Instantaneous annualized default intensity used by the credit model.', '%', 'percentage', 4, NULL::text, 1560, 'PAR'),
    ('CS01_6M', 'CS01 6M', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 6-month credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1600, 'PAR'),
    ('CS01_1Y', 'CS01 1Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 1-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1610, 'PAR'),
    ('CS01_2Y', 'CS01 2Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 2-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1620, 'PAR'),
    ('CS01_3Y', 'CS01 3Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 3-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1630, 'PAR'),
    ('CS01_5Y', 'CS01 5Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 5-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1640, 'PAR'),
    ('CS01_7Y', 'CS01 7Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 7-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1650, 'PAR'),
    ('CS01_10Y', 'CS01 10Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 10-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1660, 'PAR'),
    ('CS01_15Y', 'CS01 15Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 15-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1670, 'PAR'),
    ('CS01_20Y', 'CS01 20Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 20-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1680, 'PAR'),
    ('CS01_30Y', 'CS01 30Y', 'DECIMAL', 'Partial CS01 to a 1 basis point widening of the 30-year credit point, in price points per 100 of face. The partials sum to CS01.', 'price/bp', 'price', 6, NULL::text, 1690, 'PAR'),
    ('BETA', 'Beta', 'NUMBER', 'Sensitivity of return to the named benchmark. 1 moves with the benchmark.', 'beta', NULL::text, 4, NULL::text, 1800, 'MV'),
    ('ALPHA', 'Alpha', 'PERCENTAGE', 'Annualized return not explained by beta, versus the same benchmark.', '%', 'percentage', 4, NULL::text, 1810, 'MV'),
    ('BETA_BENCHMARK', 'Beta Benchmark', 'STRING', 'Benchmark used for beta, alpha, tracking error, and the capture ratios.', NULL::text, NULL::text, NULL::integer, NULL::text, 1820, NULL::text),
    ('BETA_WINDOW', 'Beta Window', 'STRING', 'History and frequency of the beta, such as 5-year monthly.', NULL::text, NULL::text, NULL::integer, NULL::text, 1830, NULL::text),
    ('R_SQUARED', 'R-Squared', 'PERCENTAGE', 'Share of return variance explained by the benchmark.', '%', 'percentage', 4, NULL::text, 1840, 'MV'),
    ('CORRELATION', 'Correlation', 'NUMBER', 'Correlation of returns with the benchmark, from -1 to 1.', 'correlation', NULL::text, 4, NULL::text, 1850, 'MV'),
    ('TRACKING_ERROR', 'Tracking Error', 'PERCENTAGE', 'Annualized standard deviation of return in excess of the benchmark.', '%', 'percentage', 4, NULL::text, 1860, 'MV'),
    ('INFORMATION_RATIO', 'Information Ratio', 'NUMBER', 'Annualized excess return divided by tracking error.', 'ratio', NULL::text, 2, NULL::text, 1870, 'MV'),
    ('SHARPE_RATIO', 'Sharpe Ratio', 'NUMBER', 'Annualized excess return over the risk-free rate, divided by volatility.', 'ratio', NULL::text, 2, NULL::text, 1880, 'MV'),
    ('SORTINO_RATIO', 'Sortino Ratio', 'NUMBER', 'Annualized excess return over the risk-free rate, divided by downside deviation.', 'ratio', NULL::text, 2, NULL::text, 1890, 'MV'),
    ('TREYNOR_RATIO', 'Treynor Ratio', 'PERCENTAGE', 'Annualized excess return over the risk-free rate, divided by beta.', '%', 'percentage', 4, NULL::text, 1900, 'MV'),
    ('ANNUALIZED_VOLATILITY', 'Annualized Volatility', 'PERCENTAGE', 'Annualized standard deviation of total return.', '%', 'percentage', 4, NULL::text, 1910, 'MV'),
    ('IMPLIED_VOLATILITY', 'Implied Volatility', 'PERCENTAGE', 'Option-implied volatility of the underlying, annualized.', '%', 'percentage', 4, NULL::text, 1920, 'MV'),
    ('REALIZED_VOLATILITY_30D', 'Realized Volatility 30 Day', 'PERCENTAGE', 'Annualized standard deviation of daily returns over 30 days.', '%', 'percentage', 4, NULL::text, 1930, 'MV'),
    ('REALIZED_VOLATILITY_90D', 'Realized Volatility 90 Day', 'PERCENTAGE', 'Annualized standard deviation of daily returns over 90 days.', '%', 'percentage', 4, NULL::text, 1940, 'MV'),
    ('REALIZED_VOLATILITY_1Y', 'Realized Volatility 1 Year', 'PERCENTAGE', 'Annualized standard deviation of daily returns over one year.', '%', 'percentage', 4, NULL::text, 1950, 'MV'),
    ('DIVIDEND_YIELD', 'Dividend Yield', 'PERCENTAGE', 'Indicated annual dividends over price.', '%', 'percentage', 4, NULL::text, 1960, 'MV'),
    ('EARNINGS_YIELD', 'Earnings Yield', 'PERCENTAGE', 'Earnings over price.', '%', 'percentage', 4, NULL::text, 1970, 'MV'),
    ('FREE_CASH_FLOW_YIELD', 'Free Cash Flow Yield', 'PERCENTAGE', 'Free cash flow over price.', '%', 'percentage', 4, NULL::text, 1980, 'MV'),
    ('UPSIDE_CAPTURE', 'Upside Capture', 'PERCENTAGE', 'Participation in benchmark gains. 110 means the security captured 110 percent of the up-market return.', '%', 'percentage', 4, NULL::text, 1990, 'MV'),
    ('DOWNSIDE_CAPTURE', 'Downside Capture', 'PERCENTAGE', 'Participation in benchmark losses. 80 means the security captured 80 percent of the down-market loss.', '%', 'percentage', 4, NULL::text, 2000, 'MV'),
    ('MAX_DRAWDOWN', 'Max Drawdown', 'PERCENTAGE', 'Largest peak-to-trough decline. A 23.4 percent decline is stored as -23.4.', '%', 'percentage', 4, NULL::text, 2010, 'MV'),
    ('EQUITY_DELTA', 'Delta', 'NUMBER', 'Option or convertible delta versus the underlying. Convertible delta is between 0 and 1.', 'delta', NULL::text, 4, NULL::text, 2020, 'MV'),
    ('EQUITY_GAMMA', 'Gamma', 'NUMBER', 'Change in delta for a 1 point move in the underlying.', 'gamma', 'price', 6, NULL::text, 2030, 'MV'),
    ('EQUITY_VEGA', 'Vega', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 percentage point increase in implied volatility.', 'price/vol', 'price', 4, NULL::text, 2040, 'MV'),
    ('EQUITY_THETA', 'Theta', 'DECIMAL', 'Price change, in points per 100 of face, for one day of time decay.', 'price/day', 'price', 4, NULL::text, 2050, 'MV'),
    ('EQUITY_RHO', 'Rho', 'DECIMAL', 'Price change, in points per 100 of face, for a 1 percentage point increase in the discount rate.', 'price/pct', 'price', 4, NULL::text, 2060, 'MV'),
    ('CONVERTIBLE_PREMIUM', 'Conversion Premium', 'PERCENTAGE', 'Convertible price over parity, as a percent of parity.', '%', 'percentage', 4, NULL::text, 2070, 'MV'),
    ('CONVERSION_PARITY', 'Parity', 'DECIMAL', 'Value of the shares the security converts into, as a percent of par.', 'price', 'price', 4, NULL::text, 2080, 'MV'),
    ('INVESTMENT_VALUE', 'Bond Floor', 'DECIMAL', 'Value of a convertible as a straight bond, as a percent of par.', 'price', 'price', 4, NULL::text, 2090, 'MV'),
    ('PREMIUM_OVER_BOND_FLOOR', 'Premium over Bond Floor', 'PERCENTAGE', 'Convertible price over the bond floor, as a percent of the bond floor.', '%', 'percentage', 4, NULL::text, 2100, 'MV'),
    ('PE_RATIO', 'P/E', 'NUMBER', 'Price over earnings.', 'x', 'multiple', 2, NULL::text, 2110, 'MV'),
    ('PB_RATIO', 'P/B', 'NUMBER', 'Price over book value.', 'x', 'multiple', 2, NULL::text, 2120, 'MV'),
    ('PS_RATIO', 'Price to Sales', 'NUMBER', 'Price over sales.', 'x', 'multiple', 2, NULL::text, 2130, 'MV'),
    ('EV_EBITDA', 'EV / EBITDA', 'NUMBER', 'Enterprise value over EBITDA.', 'x', 'multiple', 2, NULL::text, 2140, 'MV'),
    ('EV_SALES', 'EV / Sales', 'NUMBER', 'Enterprise value over sales.', 'x', 'multiple', 2, NULL::text, 2150, 'MV'),
    ('TOTAL_RETURN_1D', 'Total Return 1 Day', 'PERCENTAGE', 'Cumulative total return over one day, price change plus income.', '%', 'percentage', 4, NULL::text, 2200, 'MV'),
    ('TOTAL_RETURN_MTD', 'Total Return MTD', 'PERCENTAGE', 'Cumulative total return over the month to date, price change plus income.', '%', 'percentage', 4, NULL::text, 2210, 'MV'),
    ('TOTAL_RETURN_QTD', 'Total Return QTD', 'PERCENTAGE', 'Cumulative total return over the quarter to date, price change plus income.', '%', 'percentage', 4, NULL::text, 2220, 'MV'),
    ('TOTAL_RETURN_YTD', 'Total Return YTD', 'PERCENTAGE', 'Cumulative total return over the year to date, price change plus income.', '%', 'percentage', 4, NULL::text, 2230, 'MV'),
    ('TOTAL_RETURN_1M', 'Total Return 1 Month', 'PERCENTAGE', 'Cumulative total return over one month, price change plus income.', '%', 'percentage', 4, NULL::text, 2240, 'MV'),
    ('TOTAL_RETURN_3M', 'Total Return 3 Month', 'PERCENTAGE', 'Cumulative total return over three months, price change plus income.', '%', 'percentage', 4, NULL::text, 2250, 'MV'),
    ('TOTAL_RETURN_6M', 'Total Return 6 Month', 'PERCENTAGE', 'Cumulative total return over six months, price change plus income.', '%', 'percentage', 4, NULL::text, 2260, 'MV'),
    ('TOTAL_RETURN_1Y', 'Total Return 1 Year', 'PERCENTAGE', 'Cumulative total return over one year, price change plus income.', '%', 'percentage', 4, NULL::text, 2270, 'MV'),
    ('TOTAL_RETURN_3Y', 'Total Return 3 Year', 'PERCENTAGE', 'Annualized total return over three years, price change plus income.', '%', 'percentage', 4, NULL::text, 2280, 'MV'),
    ('TOTAL_RETURN_5Y', 'Total Return 5 Year', 'PERCENTAGE', 'Annualized total return over five years, price change plus income.', '%', 'percentage', 4, NULL::text, 2290, 'MV'),
    ('TOTAL_RETURN_10Y', 'Total Return 10 Year', 'PERCENTAGE', 'Annualized total return over ten years, price change plus income.', '%', 'percentage', 4, NULL::text, 2300, 'MV'),
    ('TOTAL_RETURN_ITD', 'Total Return Inception to Date', 'PERCENTAGE', 'Cumulative total return from issuance, or from the first available price, through the analytics date.', '%', 'percentage', 4, NULL::text, 2310, 'MV'),
    ('EXCESS_RETURN_YTD', 'Excess Return YTD', 'PERCENTAGE', 'Cumulative total return in excess of the beta benchmark, year to date.', '%', 'percentage', 4, NULL::text, 2320, 'MV'),
    ('EXCESS_RETURN_1Y', 'Excess Return 1 Year', 'PERCENTAGE', 'Cumulative total return in excess of the beta benchmark over one year.', '%', 'percentage', 4, NULL::text, 2330, 'MV'),
    ('EXCESS_RETURN_3Y', 'Excess Return 3 Year', 'PERCENTAGE', 'Annualized total return in excess of the beta benchmark over three years.', '%', 'percentage', 4, NULL::text, 2340, 'MV'),
    ('PRICE_RETURN_1Y', 'Price Return 1 Year', 'PERCENTAGE', 'Cumulative price change over one year, excluding coupons and dividends.', '%', 'percentage', 4, NULL::text, 2350, 'MV'),
    ('INCOME_RETURN_1Y', 'Income Return 1 Year', 'PERCENTAGE', 'Coupons, dividends, and accrued income over one year, as a percent of starting price.', '%', 'percentage', 4, NULL::text, 2360, 'MV'),
    ('CARRY_BPS', 'Carry', 'DECIMAL', 'Yield carry over one year from the passage of time, in basis points, if the yield is unchanged.', 'bps', 'bps', 2, NULL::text, 2370, 'PAR'),
    ('ROLLDOWN_BPS', 'Rolldown', 'DECIMAL', 'Return over one year from rolling down the curve, in basis points, if the spread is unchanged.', 'bps', 'bps', 2, NULL::text, 2380, 'PAR'),
    ('HORIZON_RETURN_6M', 'Horizon Return 6 Month', 'PERCENTAGE', 'Expected total return over six months from carry and rolldown, assuming the spread is unchanged.', '%', 'percentage', 4, NULL::text, 2390, 'PAR'),
    ('VAR_1D_95', 'VaR 1 Day 95', 'PERCENTAGE', 'One-day 95 percent value at risk, as a percent of price. A loss of 1.2 percent of price is 1.2. Stated as a positive loss.', '%', 'percentage', 4, NULL::text, 2500, 'MV'),
    ('VAR_1D_99', 'VaR 1 Day 99', 'PERCENTAGE', 'One-day 99 percent value at risk, as a percent of price. Stated as a positive loss.', '%', 'percentage', 4, NULL::text, 2510, 'MV'),
    ('VAR_10D_99', 'VaR 10 Day 99', 'PERCENTAGE', 'Ten-day 99 percent value at risk, as a percent of price. Stated as a positive loss.', '%', 'percentage', 4, NULL::text, 2520, 'MV'),
    ('EXPECTED_SHORTFALL_1D_95', 'Expected Shortfall 1 Day 95', 'PERCENTAGE', 'Average loss in the worst 5 percent of one-day outcomes, as a percent of price. Stated as a positive loss.', '%', 'percentage', 4, NULL::text, 2530, 'MV'),
    ('EXPECTED_SHORTFALL_1D_99', 'Expected Shortfall 1 Day 99', 'PERCENTAGE', 'Average loss in the worst 1 percent of one-day outcomes, as a percent of price. Stated as a positive loss.', '%', 'percentage', 4, NULL::text, 2540, 'MV'),
    ('DOWNSIDE_DEVIATION', 'Downside Deviation', 'PERCENTAGE', 'Annualized standard deviation of returns below the risk-free rate.', '%', 'percentage', 4, NULL::text, 2550, 'MV'),
    ('FX_DELTA_PCT', 'FX Delta', 'PERCENTAGE', 'Percent change in the dirty price for a 1 percent rise in the denomination currency. About 100 for an unhedged foreign bond.', '%', 'percentage', 4, NULL::text, 2560, 'MV'),
    ('THETA_1D', 'Time Decay 1 Day', 'DECIMAL', 'Price change, in points per 100 of face, from one calendar day passing with the curve unchanged.', 'price/day', 'price', 6, NULL::text, 2570, 'PAR')
) AS v(code, name, dtype, descr, unit, fmt, prec, list, grp, w)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    data_type = EXCLUDED.data_type,
    description = EXCLUDED.description,
    unit_of_measure = EXCLUDED.unit_of_measure,
    display_format = EXCLUDED.display_format,
    numeric_precision = EXCLUDED.numeric_precision,
    reference_list_code = EXCLUDED.reference_list_code,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable,
    is_visible = EXCLUDED.is_visible,
    is_time_varying = EXCLUDED.is_time_varying,
    time_dimension = EXCLUDED.time_dimension;

-- Weights are applied after every row exists. A weighted average cannot
-- point at issue market value until that attribute has been inserted.
UPDATE metadata_register.attribute_register AS a
SET aggregation_type = CASE v.w
        WHEN 'PAR' THEN 'WEIGHTED_AVG'
        WHEN 'MV' THEN 'WEIGHTED_AVG'
        WHEN 'SUM' THEN 'SUM'
        ELSE 'NONE'
    END,
    weight_attribute_code = CASE v.w
        WHEN 'PAR' THEN 'CURRENT_OUTSTANDING_AMOUNT'
        WHEN 'MV' THEN 'ISSUE_MARKET_VALUE'
        ELSE NULL
    END
FROM (VALUES
    ('CLEAN_PRICE', 'PAR'),
    ('DIRTY_PRICE', 'PAR'),
    ('ACCRUED_INTEREST_PER_100', 'PAR'),
    ('ISSUE_MARKET_VALUE', 'SUM'),
    ('YIELD_TO_MATURITY', 'PAR'),
    ('YIELD_TO_WORST', 'PAR'),
    ('YIELD_TO_CALL', 'PAR'),
    ('YIELD_TO_PUT', 'PAR'),
    ('YIELD_TO_AVERAGE_LIFE', 'PAR'),
    ('YIELD_TO_RESET', 'PAR'),
    ('BOND_EQUIVALENT_YIELD', 'PAR'),
    ('REAL_YIELD', 'PAR'),
    ('BREAKEVEN_INFLATION', 'PAR'),
    ('G_SPREAD_BPS', 'PAR'),
    ('I_SPREAD_BPS', 'PAR'),
    ('Z_SPREAD_BPS', 'PAR'),
    ('OAS_BPS', 'PAR'),
    ('ASSET_SWAP_SPREAD_BPS', 'PAR'),
    ('DISCOUNT_MARGIN_BPS', 'PAR'),
    ('SPREAD_TO_MATURITY_BPS', 'PAR'),
    ('SPREAD_TO_WORST_BPS', 'PAR'),
    ('CDS_SPREAD_BPS', 'PAR'),
    ('OPTION_COST_BPS', 'PAR'),
    ('BENCHMARK_SPREAD_BPS', 'PAR'),
    ('WAL_YEARS', 'PAR'),
    ('YEARS_TO_MATURITY', 'PAR'),
    ('YEARS_TO_WORST', 'PAR'),
    ('YEARS_TO_CALL', 'PAR'),
    ('WAM_MONTHS', 'PAR'),
    ('WALA_MONTHS', 'PAR'),
    ('WAC', 'PAR'),
    ('CURRENT_FACTOR', 'PAR'),
    ('ASSUMED_CPR', 'PAR'),
    ('ASSUMED_PSA', 'PAR'),
    ('ASSUMED_SMM', 'PAR'),
    ('FACILITY_LTV', 'PAR'),
    ('FACILITY_DSCR', 'PAR'),
    ('FACILITY_DEBT_YIELD', 'PAR'),
    ('MACAULAY_DURATION', 'PAR'),
    ('MODIFIED_DURATION', 'PAR'),
    ('MODIFIED_DURATION_TO_WORST', 'PAR'),
    ('SPREAD_DURATION', 'PAR'),
    ('OAS_DURATION', 'PAR'),
    ('CREDIT_DURATION', 'PAR'),
    ('RATE_DURATION', 'PAR'),
    ('INFLATION_DURATION', 'PAR'),
    ('EMPIRICAL_DURATION', 'PAR'),
    ('PREPAY_DURATION', 'PAR'),
    ('INDEX_DURATION', 'PAR'),
    ('KRD_3M', 'PAR'),
    ('KRD_6M', 'PAR'),
    ('KRD_1Y', 'PAR'),
    ('KRD_2Y', 'PAR'),
    ('KRD_3Y', 'PAR'),
    ('KRD_5Y', 'PAR'),
    ('KRD_7Y', 'PAR'),
    ('KRD_10Y', 'PAR'),
    ('KRD_15Y', 'PAR'),
    ('KRD_20Y', 'PAR'),
    ('KRD_30Y', 'PAR'),
    ('CONVEXITY', 'PAR'),
    ('EFFECTIVE_CONVEXITY', 'PAR'),
    ('SPREAD_CONVEXITY', 'PAR'),
    ('OAS_CONVEXITY', 'PAR'),
    ('DV01', 'PAR'),
    ('PV01', 'PAR'),
    ('RATE_DV01', 'PAR'),
    ('GOVT_DV01', 'PAR'),
    ('SWAP_DV01', 'PAR'),
    ('OIS_DV01', 'PAR'),
    ('INFLATION_DV01', 'PAR'),
    ('DV01_1M', 'PAR'),
    ('DV01_3M', 'PAR'),
    ('DV01_6M', 'PAR'),
    ('DV01_1Y', 'PAR'),
    ('DV01_2Y', 'PAR'),
    ('DV01_3Y', 'PAR'),
    ('DV01_5Y', 'PAR'),
    ('DV01_7Y', 'PAR'),
    ('DV01_10Y', 'PAR'),
    ('DV01_12Y', 'PAR'),
    ('DV01_15Y', 'PAR'),
    ('DV01_20Y', 'PAR'),
    ('DV01_25Y', 'PAR'),
    ('DV01_30Y', 'PAR'),
    ('DV01_40Y', 'PAR'),
    ('DV01_50Y', 'PAR'),
    ('CS01', 'PAR'),
    ('CDS_CS01', 'PAR'),
    ('RECOVERY_01', 'PAR'),
    ('JUMP_TO_DEFAULT', 'PAR'),
    ('ASSUMED_RECOVERY_RATE', 'PAR'),
    ('IMPLIED_PD', 'PAR'),
    ('HAZARD_RATE', 'PAR'),
    ('CS01_6M', 'PAR'),
    ('CS01_1Y', 'PAR'),
    ('CS01_2Y', 'PAR'),
    ('CS01_3Y', 'PAR'),
    ('CS01_5Y', 'PAR'),
    ('CS01_7Y', 'PAR'),
    ('CS01_10Y', 'PAR'),
    ('CS01_15Y', 'PAR'),
    ('CS01_20Y', 'PAR'),
    ('CS01_30Y', 'PAR'),
    ('BETA', 'MV'),
    ('ALPHA', 'MV'),
    ('R_SQUARED', 'MV'),
    ('CORRELATION', 'MV'),
    ('TRACKING_ERROR', 'MV'),
    ('INFORMATION_RATIO', 'MV'),
    ('SHARPE_RATIO', 'MV'),
    ('SORTINO_RATIO', 'MV'),
    ('TREYNOR_RATIO', 'MV'),
    ('ANNUALIZED_VOLATILITY', 'MV'),
    ('IMPLIED_VOLATILITY', 'MV'),
    ('REALIZED_VOLATILITY_30D', 'MV'),
    ('REALIZED_VOLATILITY_90D', 'MV'),
    ('REALIZED_VOLATILITY_1Y', 'MV'),
    ('DIVIDEND_YIELD', 'MV'),
    ('EARNINGS_YIELD', 'MV'),
    ('FREE_CASH_FLOW_YIELD', 'MV'),
    ('UPSIDE_CAPTURE', 'MV'),
    ('DOWNSIDE_CAPTURE', 'MV'),
    ('MAX_DRAWDOWN', 'MV'),
    ('EQUITY_DELTA', 'MV'),
    ('EQUITY_GAMMA', 'MV'),
    ('EQUITY_VEGA', 'MV'),
    ('EQUITY_THETA', 'MV'),
    ('EQUITY_RHO', 'MV'),
    ('CONVERTIBLE_PREMIUM', 'MV'),
    ('CONVERSION_PARITY', 'MV'),
    ('INVESTMENT_VALUE', 'MV'),
    ('PREMIUM_OVER_BOND_FLOOR', 'MV'),
    ('PE_RATIO', 'MV'),
    ('PB_RATIO', 'MV'),
    ('PS_RATIO', 'MV'),
    ('EV_EBITDA', 'MV'),
    ('EV_SALES', 'MV'),
    ('TOTAL_RETURN_1D', 'MV'),
    ('TOTAL_RETURN_MTD', 'MV'),
    ('TOTAL_RETURN_QTD', 'MV'),
    ('TOTAL_RETURN_YTD', 'MV'),
    ('TOTAL_RETURN_1M', 'MV'),
    ('TOTAL_RETURN_3M', 'MV'),
    ('TOTAL_RETURN_6M', 'MV'),
    ('TOTAL_RETURN_1Y', 'MV'),
    ('TOTAL_RETURN_3Y', 'MV'),
    ('TOTAL_RETURN_5Y', 'MV'),
    ('TOTAL_RETURN_10Y', 'MV'),
    ('TOTAL_RETURN_ITD', 'MV'),
    ('EXCESS_RETURN_YTD', 'MV'),
    ('EXCESS_RETURN_1Y', 'MV'),
    ('EXCESS_RETURN_3Y', 'MV'),
    ('PRICE_RETURN_1Y', 'MV'),
    ('INCOME_RETURN_1Y', 'MV'),
    ('CARRY_BPS', 'PAR'),
    ('ROLLDOWN_BPS', 'PAR'),
    ('HORIZON_RETURN_6M', 'PAR'),
    ('VAR_1D_95', 'MV'),
    ('VAR_1D_99', 'MV'),
    ('VAR_10D_99', 'MV'),
    ('EXPECTED_SHORTFALL_1D_95', 'MV'),
    ('EXPECTED_SHORTFALL_1D_99', 'MV'),
    ('DOWNSIDE_DEVIATION', 'MV'),
    ('FX_DELTA_PCT', 'MV'),
    ('THETA_1D', 'PAR')
) AS v(code, w)
WHERE a.attribute_code = v.code;

-- Current yield and effective duration already exist. They belong in this profile.
UPDATE metadata_register.attribute_register
SET attribute_name = 'Current Yield',
    description = 'Coupon income divided by the clean price. This is a calculated yield, not a discounting yield.',
    domain_code = 'SECURITY',
    display_section = 'Analytics',
    display_group = 190,
    display_format = 'percentage',
    numeric_precision = 4,
    unit_of_measure = '%',
    is_visible = TRUE,
    is_time_varying = TRUE,
    time_dimension = 'VALID_TIME',
    aggregation_type = 'WEIGHTED_AVG',
    weight_attribute_code = 'CURRENT_OUTSTANDING_AMOUNT',
    updated_at = NOW()
WHERE attribute_code = 'CURRENT_YIELD';

UPDATE metadata_register.attribute_register
SET description = 'Option-adjusted duration, in years. Price sensitivity to a curve move after embedded calls, puts, and prepayments.',
    domain_code = 'SECURITY',
    display_section = 'Analytics',
    display_group = 820,
    display_format = 'years',
    numeric_precision = 4,
    unit_of_measure = 'years',
    is_visible = TRUE,
    is_time_varying = TRUE,
    time_dimension = 'VALID_TIME',
    aggregation_type = 'WEIGHTED_AVG',
    weight_attribute_code = 'CURRENT_OUTSTANDING_AMOUNT',
    updated_at = NOW()
WHERE attribute_code = 'EFFECTIVE_DURATION';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.domain_templates (template_code, domain_code, template_name, description)
VALUES ('SECURITY_STANDARD', 'SECURITY', 'Standard Security', 'Standard template for securities')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'SECURITY_STANDARD'
WHERE a.domain_code = 'SECURITY'
  AND a.display_section = 'Analytics'
ON CONFLICT (template_id, attribute_id) DO UPDATE
SET display_order = EXCLUDED.display_order;

INSERT INTO metadata_register.attribute_aliases (attribute_id, alias_label, alias_code, domain_code, match_kind, confidence)
SELECT a.id, v.label, v.alias_code, 'SECURITY', 'semantic', 0.960
FROM (VALUES
    ('DV01', 'DVO1', 'DVO1'),
    ('DV01', 'Dollar duration', 'DOLLAR_DURATION'),
    ('CS01', 'CSO1', 'CSO1'),
    ('CS01', 'Spread DV01', 'SPREAD_DV01'),
    ('YIELD_TO_MATURITY', 'YTM', 'YTM'),
    ('YIELD_TO_WORST', 'YTW', 'YTW'),
    ('YIELD_TO_CALL', 'YTC', 'YTC'),
    ('YIELD_TO_PUT', 'YTP', 'YTP'),
    ('WAL_YEARS', 'WAL', 'WAL'),
    ('WAL_YEARS', 'Weighted average life', 'WEIGHTED_AVERAGE_LIFE'),
    ('WAL_YEARS', 'Average life', 'AVERAGE_LIFE'),
    ('WAM_MONTHS', 'WAM', 'WAM'),
    ('WALA_MONTHS', 'WALA', 'WALA'),
    ('OAS_BPS', 'OAS', 'OAS'),
    ('Z_SPREAD_BPS', 'Z-spread', 'Z_SPREAD'),
    ('G_SPREAD_BPS', 'G-spread', 'G_SPREAD'),
    ('I_SPREAD_BPS', 'I-spread', 'I_SPREAD'),
    ('DISCOUNT_MARGIN_BPS', 'Discount margin', 'DM'),
    ('JUMP_TO_DEFAULT', 'JTD', 'JTD'),
    ('SHARPE_RATIO', 'Sharpe', 'SHARPE'),
    ('MACAULAY_DURATION', 'Macaulay', 'MACAULAY')
) AS v(code, label, alias_code)
JOIN metadata_register.attribute_register a ON a.attribute_code = v.code
WHERE NOT EXISTS (
    SELECT 1
    FROM metadata_register.attribute_aliases existing
    WHERE existing.alias_code = v.alias_code
      AND COALESCE(existing.domain_code, '') = 'SECURITY'
      AND existing.template_id IS NULL
);

NOTIFY pgrst, 'reload schema';
