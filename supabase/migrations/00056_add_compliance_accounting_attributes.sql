-- Migration 00056: Add Issuer, Security, and Position Attributes
-- Description: Adds comprehensive attributes for the Issuer, Security, and Position
--              entity types based on the enterprise compliance & accounting data model.

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

-- ISSUER ATTRIBUTES (23 new attributes)
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible
) VALUES
    ('ISSUER_LEGAL_NAME', 'Issuer Legal Name', 'STRING', 'Full legal entity name of the borrower/issuer.', 'ISSUER', FALSE, 100, 'Identity', 1, TRUE, TRUE),
    ('ULTIMATE_PARENT_ISSUER_ID', 'Ultimate Parent Issuer ID', 'REFERENCE', 'Self-referencing link to top-tier corporate parent.', 'ISSUER', FALSE, 100, 'Identity', 2, TRUE, TRUE),
    ('JURISDICTION_STATE_CODE', 'State / Region Code', 'STRING', 'State or province of incorporation (e.g., DE, NY).', 'ISSUER', FALSE, 100, 'Identity', 3, TRUE, TRUE),
    ('SP_INDUSTRY_CODE', 'S&P Industry Classification', 'STRING', 'S&P Industry Classification for CLO Industry Concentration Limits.', 'ISSUER', FALSE, 100, 'Classification', 10, TRUE, TRUE),
    ('FITCH_INDUSTRY_CODE', 'Fitch Industry Classification', 'STRING', 'Fitch Industry Classification System.', 'ISSUER', FALSE, 100, 'Classification', 11, TRUE, TRUE),
    ('GICS_SUB_INDUSTRY_CODE', 'GICS Sub-Industry Code', 'STRING', 'Detailed GICS sub-industry identifier.', 'ISSUER', FALSE, 100, 'Classification', 12, TRUE, TRUE),
    ('NACE_INDUSTRY_CODE', 'NACE Industry Code', 'STRING', 'European standard classification of economic activities.', 'ISSUER', FALSE, 100, 'Classification', 13, TRUE, TRUE),
    ('IS_1940_ACT_ELIGIBLE_PORTFOLIO_CO', '1940 Act Eligible Portfolio Co Flag', 'BOOLEAN', 'True if meeting 1940 Act 2(a)(46) requirements.', 'ISSUER', FALSE, 100, 'Regulatory', 20, TRUE, TRUE),
    ('IS_1940_ACT_AFFILIATED_ENTITY', '1940 Act Affiliated Entity Flag', 'BOOLEAN', 'True if affiliate under 2(a)(3) triggering 57 co-investment.', 'ISSUER', FALSE, 100, 'Regulatory', 21, TRUE, TRUE),
    ('AFFILIATE_CONTROL_PERCENTAGE', 'Affiliate Control Percentage', 'PERCENTAGE', 'Percentage of voting securities owned by the manager or fund family.', 'ISSUER', FALSE, 100, 'Regulatory', 22, TRUE, TRUE),
    ('SP_ISSUER_RATING', 'S&P Issuer Rating', 'STRING', 'Issuer Credit Rating (ICR) from S&P.', 'ISSUER', FALSE, 100, 'Ratings', 30, TRUE, TRUE),
    ('FITCH_ISSUER_RATING', 'Fitch Issuer Rating', 'STRING', 'Long-Term Issuer Default Rating (IDR) from Fitch.', 'ISSUER', FALSE, 100, 'Ratings', 31, TRUE, TRUE),
    ('CREDIT_ESTIMATE_RATING', 'Credit Estimate Rating', 'STRING', 'Shadow/Credit Estimate rating for unrated direct lending assets.', 'ISSUER', FALSE, 100, 'Ratings', 32, TRUE, TRUE),
    ('CREDIT_ESTIMATE_EFFECTIVE_DATE', 'Credit Estimate Effective Date', 'DATE', 'Date when the credit estimate was issued.', 'ISSUER', FALSE, 100, 'Ratings', 33, TRUE, TRUE),
    ('CREDIT_ESTIMATE_EXPIRATION_DATE', 'Credit Estimate Expiration Date', 'DATE', 'Expiration date triggering automatic downgrades if expired.', 'ISSUER', FALSE, 100, 'Ratings', 34, TRUE, TRUE),
    ('EBITDA_LTM', 'LTM EBITDA', 'CURRENCY', 'Last Twelve Months EBITDA in issuer base reporting currency.', 'ISSUER', FALSE, 100, 'Financials', 40, TRUE, TRUE),
    ('REVENUE_LTM', 'LTM Revenue', 'CURRENCY', 'Last Twelve Months Revenue.', 'ISSUER', FALSE, 100, 'Financials', 41, TRUE, TRUE),
    ('TOTAL_DEBT_AMOUNT', 'Total Debt Amount', 'CURRENCY', 'Total funded debt across all capital structure tiers.', 'ISSUER', FALSE, 100, 'Financials', 42, TRUE, TRUE),
    ('CASH_AND_EQUIVALENTS_AMOUNT', 'Cash and Cash Equivalents', 'CURRENCY', 'Unrestricted cash on the borrowers balance sheet.', 'ISSUER', FALSE, 100, 'Financials', 43, TRUE, TRUE),
    ('TOTAL_NET_LEVERAGE_RATIO', 'Total Net Leverage Ratio', 'DECIMAL', '(Total Debt - Cash) / LTM EBITDA ratio.', 'ISSUER', FALSE, 100, 'Ratios', 50, TRUE, TRUE),
    ('SENIOR_NET_LEVERAGE_RATIO', 'Senior Net Leverage Ratio', 'DECIMAL', 'First Lien / Senior Debt Net Leverage ratio.', 'ISSUER', FALSE, 100, 'Ratios', 51, TRUE, TRUE),
    ('INTEREST_COVERAGE_RATIO', 'Interest Coverage Ratio', 'DECIMAL', 'LTM EBITDA / LTM Interest Expense ratio.', 'ISSUER', FALSE, 100, 'Ratios', 52, TRUE, TRUE),
    ('FINANCIAL_REPORTING_PERIOD_DATE', 'Financial Reporting Period Date', 'DATE', 'As-of date for the borrowers latest financial statement.', 'ISSUER', FALSE, 100, 'Reporting', 60, TRUE, TRUE)
ON CONFLICT (attribute_code) DO NOTHING;

-- SECURITY ATTRIBUTES Part 1 (Identity, Issuance, Coupon Terms)
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    reference_domain_code, display_section, display_group, is_editable, is_visible
) VALUES
    ('ISSUER_ID', 'Issuer ID', 'REFERENCE', 'Reference to the issuing legal entity.', 'SECURITY', FALSE, 100, 'ISSUER', 'Identity', 1, TRUE, TRUE),
    ('COMMON_CODE', 'Common Code', 'STRING', 'Euroclear/Clearstream common code.', 'SECURITY', FALSE, 100, NULL, 'Identity', 2, TRUE, TRUE),
    ('SECURITY_DESCRIPTION', 'Security Description', 'STRING', 'Full text description of the security.', 'SECURITY', FALSE, 100, NULL, 'Identity', 3, TRUE, TRUE),
    ('INSTRUMENT_TYPE', 'Instrument Type', 'STRING', 'Detailed instrument classification.', 'SECURITY', FALSE, 100, NULL, 'Identity', 4, TRUE, TRUE),
    ('ASSET_CLASS', 'Asset Class', 'STRING', 'Broad asset class: Senior Loans, HY, Mezzanine, Equity.', 'SECURITY', FALSE, 100, NULL, 'Identity', 5, TRUE, TRUE),
    ('DENOMINATION_CURRENCY', 'Denomination Currency', 'STRING', 'Currency in which the security is denominated.', 'SECURITY', FALSE, 100, NULL, 'Issuance', 10, TRUE, TRUE),
    ('ISSUANCE_COUNTRY_CODE', 'Issuance Country Code', 'STRING', 'Country where the security was issued (ISO-2).', 'SECURITY', FALSE, 100, NULL, 'Issuance', 11, TRUE, TRUE),
    ('ISSUANCE_DATE', 'Issuance Date', 'DATE', 'Original issue / closing date of the security.', 'SECURITY', FALSE, 100, NULL, 'Issuance', 12, TRUE, TRUE),
    ('MATURITY_DATE', 'Maturity Date', 'DATE', 'Final maturity / legal final date.', 'SECURITY', FALSE, 100, NULL, 'Issuance', 13, TRUE, TRUE),
    ('ORIGINAL_PRINCIPAL_AMOUNT', 'Original Principal Amount', 'CURRENCY', 'Original principal / facility amount at closing.', 'SECURITY', FALSE, 100, NULL, 'Issuance', 14, TRUE, TRUE),
    ('CURRENT_OUTSTANDING_AMOUNT', 'Current Outstanding Amount', 'CURRENCY', 'Current aggregate principal amount outstanding.', 'SECURITY', FALSE, 100, NULL, 'Issuance', 15, TRUE, TRUE),
    ('COUPON_RATE', 'Coupon Rate', 'PERCENTAGE', 'Annual coupon / interest rate.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 20, TRUE, TRUE),
    ('COUPON_TYPE', 'Coupon Type', 'STRING', 'Fixed, Floating, PIK, Step-Up, etc.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 21, TRUE, TRUE),
    ('INTEREST_PAYMENT_FREQUENCY', 'Interest Payment Frequency', 'STRING', 'Monthly, Quarterly, Semi-Annual, Annual.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 22, TRUE, TRUE),
    ('DAY_COUNT_CONVENTION', 'Day Count Convention', 'STRING', 'Actual/360, Actual/365, 30/360, etc.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 23, TRUE, TRUE),
    ('BENCHMARK_REFERENCE_RATE', 'Benchmark Reference Rate', 'STRING', 'SOFR, EURIBOR, SONIA, etc.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 24, TRUE, TRUE),
    ('SPREAD_BPS', 'Spread (bps)', 'DECIMAL', 'Credit spread over benchmark in basis points.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 25, TRUE, TRUE),
    ('PIK_TOGGLE_FLAG', 'PIK Toggle Flag', 'BOOLEAN', 'True if the security has a PIK toggle option.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 26, TRUE, TRUE),
    ('PIK_MARGIN', 'PIK Margin', 'PERCENTAGE', 'Additional margin applied when PIK option is elected.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 27, TRUE, TRUE),
    ('ORIGINAL_ISSUE_DISCOUNT', 'Original Issue Discount', 'PERCENTAGE', 'OID expressed as a percentage of par.', 'SECURITY', FALSE, 100, NULL, 'Coupon Terms', 28, TRUE, TRUE)
ON CONFLICT (attribute_code) DO NOTHING;


-- SECURITY ATTRIBUTES Part 2 (Trading, Regulatory, Call/Put, FX)
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    reference_domain_code, display_section, display_group, is_editable, is_visible
) VALUES
    ('MINIMUM_INCREMENT', 'Minimum Increment', 'DECIMAL', 'Minimum trading increment.', 'SECURITY', FALSE, 100, NULL, 'Trading', 30, TRUE, TRUE),
    ('MINIMUM_DENOMINATION', 'Minimum Denomination', 'CURRENCY', 'Minimum denomination amount.', 'SECURITY', FALSE, 100, NULL, 'Trading', 31, TRUE, TRUE),
    ('PRIMARY_EXCHANGE_CODE', 'Primary Exchange Code', 'STRING', 'Primary listing/exchange code.', 'SECURITY', FALSE, 100, NULL, 'Trading', 32, TRUE, TRUE),
    ('LISTING_COUNTRY_CODE', 'Listing Country Code', 'STRING', 'Country of primary listing (ISO-2).', 'SECURITY', FALSE, 100, NULL, 'Trading', 33, TRUE, TRUE),
    ('SETTLEMENT_CYCLE_DAYS', 'Settlement Cycle Days', 'INTEGER', 'Standard settlement cycle (e.g., T+2).', 'SECURITY', FALSE, 100, NULL, 'Trading', 34, TRUE, TRUE),
    ('CLEARING_SYSTEM', 'Clearing System', 'STRING', 'Euroclear, Clearstream, DTC, etc.', 'SECURITY', FALSE, 100, NULL, 'Trading', 35, TRUE, TRUE),
    ('RULE_144A_FLAG', 'Rule 144A Flag', 'BOOLEAN', 'True if qualifies under SEC Rule 144A (QIB-eligible).', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 40, TRUE, TRUE),
    ('REG_S_FLAG', 'Reg S Flag', 'BOOLEAN', 'True if issued under Regulation S (offshore).', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 41, TRUE, TRUE),
    ('IS_RESTRICTED_SECURITY', 'Restricted Security Flag', 'BOOLEAN', 'True if security has transfer/sale restrictions.', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 42, TRUE, TRUE),
    ('CUSIP_144A_CODE', 'CUSIP 144A Code', 'STRING', 'Separate CUSIP for 144A tranche if applicable.', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 43, TRUE, TRUE),
    ('LOAN_X_CODE', 'Loan-X Code', 'STRING', 'Loan-X participant code for syndicated loans.', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 44, TRUE, TRUE),
    ('SYNDICATED_LOAN_FLAG', 'Syndicated Loan Flag', 'BOOLEAN', 'True if the security is a syndicated loan.', 'SECURITY', FALSE, 100, NULL, 'Regulatory', 45, TRUE, TRUE),
    ('NEXT_CALL_DATE', 'Next Call Date', 'DATE', 'Next callable date.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 50, TRUE, TRUE),
    ('NEXT_PUT_DATE', 'Next Put Date', 'DATE', 'Next puttable date.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 51, TRUE, TRUE),
    ('NEXT_COUPON_DATE', 'Next Coupon Date', 'DATE', 'Next scheduled coupon payment date.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 52, TRUE, TRUE),
    ('COUPON_STEP_UP_FLAG', 'Coupon Step-Up Flag', 'BOOLEAN', 'True if the coupon has a step-up feature.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 53, TRUE, TRUE),
    ('HAS_PAR_VALUE', 'Has Par Value', 'BOOLEAN', 'True if the security trades at par.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 54, TRUE, TRUE),
    ('ISIN_SUCCESSOR', 'ISIN Successor', 'STRING', 'Successor ISIN if restructured.', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 55, TRUE, TRUE),
    ('PRICE_LOT_CONVENTION', 'Price Lot Convention', 'STRING', 'Price lot convention (e.g., per 100, per 1000).', 'SECURITY', FALSE, 100, NULL, 'Call/Put', 56, TRUE, TRUE),
    ('MARKET_VALUE_CURRENCY', 'Market Value Currency', 'CURRENCY', 'Currency of the market value.', 'SECURITY', FALSE, 100, NULL, 'FX', 60, TRUE, TRUE),
    ('HAS_FX_EXPOSURE', 'Has FX Exposure', 'BOOLEAN', 'True if denomination differs from base reporting currency.', 'SECURITY', FALSE, 100, NULL, 'FX', 61, TRUE, TRUE),
    ('BASE_CURRENCY', 'Base Currency', 'STRING', 'Base reporting currency for the fund/portfolio.', 'SECURITY', FALSE, 100, NULL, 'FX', 62, TRUE, TRUE),
    ('FX_RATE_TO_BASE', 'FX Rate to Base', 'DECIMAL', 'FX conversion rate to base currency.', 'SECURITY', FALSE, 100, NULL, 'FX', 63, TRUE, TRUE),
    ('FX_RATE_SOURCE', 'FX Rate Source', 'STRING', 'Source of the FX rate.', 'SECURITY', FALSE, 100, NULL, 'FX', 64, TRUE, TRUE),
    ('FX_RATE_DATE', 'FX Rate Date', 'DATE', 'As-of date for the FX rate.', 'SECURITY', FALSE, 100, NULL, 'FX', 65, TRUE, TRUE)
ON CONFLICT (attribute_code) DO NOTHING;


-- POSITION ATTRIBUTES (23 new attributes)
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    reference_domain_code, display_section, display_group, is_editable, is_visible
) VALUES
    ('PORTFOLIO_FUND_ID', 'Portfolio / Fund Structure ID', 'REFERENCE', 'References the specific legal entity (BDC, CLO SPV, etc.).', 'POSITION', FALSE, 100, 'FUND', 'References', 1, TRUE, TRUE),
    ('SECURITY_ID', 'Security ID', 'REFERENCE', 'References the security_id of the asset.', 'POSITION', FALSE, 100, 'SECURITY', 'References', 2, TRUE, TRUE),
    ('CUSTODY_ACCOUNT_ID', 'Custody Account ID', 'STRING', 'Identifies the physical custodian account (1940 Act segregation).', 'POSITION', FALSE, 100, NULL, 'References', 3, TRUE, TRUE),
    ('FUNDED_PAR_AMOUNT', 'Funded Par Amount', 'CURRENCY', 'Current principal balance outstanding (excluding capitalized PIK).', 'POSITION', FALSE, 100, NULL, 'Principal', 10, TRUE, TRUE),
    ('UNFUNDED_COMMITMENT_AMOUNT', 'Unfunded Commitment Amount', 'CURRENCY', 'Total committed but undrawn principal amount.', 'POSITION', FALSE, 100, NULL, 'Principal', 11, TRUE, TRUE),
    ('CAPITALIZED_PIK_PRINCIPAL_BALANCE', 'Capitalized PIK Principal Balance', 'CURRENCY', 'Accumulated PIK interest added to the underlying principal.', 'POSITION', FALSE, 100, NULL, 'Principal', 12, TRUE, TRUE),
    ('SHARE_QUANTITY', 'Share / Unit Quantity', 'DECIMAL', 'Quantity of shares or units held.', 'POSITION', FALSE, 100, NULL, 'Principal', 13, TRUE, TRUE),
    ('TRADE_DATE', 'Trade Date', 'DATE', 'Original trade execution date.', 'POSITION', FALSE, 100, NULL, 'Trade', 20, TRUE, TRUE),
    ('SETTLEMENT_DATE', 'Settlement Date', 'DATE', 'Actual or estimated settlement date.', 'POSITION', FALSE, 100, NULL, 'Trade', 21, TRUE, TRUE),
    ('COST_BASIS_PRICE', 'Cost Basis Price', 'DECIMAL', 'Acquisition price as percent of par or price per share.', 'POSITION', FALSE, 100, NULL, 'Cost Basis', 30, TRUE, TRUE),
    ('ORIGINAL_AMORTIZED_COST_AMOUNT', 'Original Amortized Cost Amount', 'CURRENCY', 'Historical cost basis adjusted for OID/premium amortization.', 'POSITION', FALSE, 100, NULL, 'Cost Basis', 31, TRUE, TRUE),
    ('UNAMORTIZED_DISCOUNT_PREMIUM_AMOUNT', 'Unamortized Discount / Premium', 'CURRENCY', 'Remaining OID or premium balance to amortize.', 'POSITION', FALSE, 100, NULL, 'Cost Basis', 32, TRUE, TRUE),
    ('CARRYING_AMORTIZED_COST_AMOUNT', 'Carrying Amortized Cost', 'CURRENCY', 'Current book value under GAAP / Statutory Accounting.', 'POSITION', FALSE, 100, NULL, 'Cost Basis', 33, TRUE, TRUE),
    ('FAIR_MARKET_PRICE', 'Fair Market Price', 'DECIMAL', 'Latest verified market price or fair valuation price.', 'POSITION', FALSE, 100, NULL, 'Valuation', 40, TRUE, TRUE),
    ('VALUATION_SOURCE', 'Valuation Source', 'STRING', 'Markit_Loan_Pricing, Refinitiv, Third_Party, Internal_Model.', 'POSITION', FALSE, 100, NULL, 'Valuation', 41, TRUE, TRUE),
    ('VALUATION_HIERARCHY_LEVEL', 'Valuation Hierarchy Level', 'STRING', 'GAAP Fair Value Hierarchy: Level_1, Level_2, Level_3.', 'POSITION', FALSE, 100, NULL, 'Valuation', 42, TRUE, TRUE),
    ('TOTAL_FAIR_MARKET_VALUE_AMOUNT', 'Total Fair Market Value', 'CURRENCY', 'Calculated fair market value.', 'POSITION', FALSE, 100, NULL, 'Valuation', 43, TRUE, TRUE),
    ('ACCRUED_CASH_INTEREST_AMOUNT', 'Accrued Cash Interest Amount', 'CURRENCY', 'Earned but unpaid cash interest since last payment date.', 'POSITION', FALSE, 100, NULL, 'Accruals', 50, TRUE, TRUE),
    ('ACCRUED_PIK_INTEREST_AMOUNT', 'Accrued PIK Interest Amount', 'CURRENCY', 'Earned but un-capitalized PIK interest for the current period.', 'POSITION', FALSE, 100, NULL, 'Accruals', 51, TRUE, TRUE),
    ('IS_NON_ACCRUAL', 'Non-Accrual Status Flag', 'BOOLEAN', 'True if interest accrual is suspended due to impairment.', 'POSITION', FALSE, 100, NULL, 'Non-Accrual', 60, TRUE, TRUE),
    ('NON_ACCRUAL_EFFECTIVE_DATE', 'Non-Accrual Effective Date', 'DATE', 'Date asset was placed on non-accrual status.', 'POSITION', FALSE, 100, NULL, 'Non-Accrual', 61, TRUE, TRUE),
    ('IS_PLEDGED_COLLATERAL', 'Pledged / Encumbered Status Flag', 'BOOLEAN', 'True if the position is pledged to a credit facility.', 'POSITION', FALSE, 100, NULL, 'Pledge', 70, TRUE, TRUE),
    ('PLEDGED_FACILITY_ID', 'Pledged Facility ID', 'REFERENCE', 'References the leverage/credit facility securing the position.', 'POSITION', FALSE, 100, NULL, 'Pledge', 71, TRUE, TRUE)
ON CONFLICT (attribute_code) DO NOTHING;


-- Re-enable derived attribute trigger
ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- Create POSITION_STANDARD template
INSERT INTO metadata_register.domain_templates (template_code, domain_code, template_name, description)
VALUES ('POSITION_STANDARD', 'POSITION', 'Standard Position', 'Standard template for portfolio positions and holdings')
ON CONFLICT (template_code) DO NOTHING;

-- Assign new ISSUER attributes to ISSUER_STANDARD template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'ISSUER_STANDARD'),
    ar.id,
    ar.is_required,
    ROW_NUMBER() OVER (ORDER BY ar.display_group, ar.attribute_code)
FROM metadata_register.attribute_register ar
WHERE ar.domain_code = 'ISSUER'
  AND ar.attribute_code NOT IN ('LEI', 'COUNTRY', 'SECTOR', 'INDUSTRY', 'MARKET_CAP', 'CREDIT_RATING', 'ISSUER_RATING')
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.template_attribute_assignments taa
      WHERE taa.template_id = (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'ISSUER_STANDARD')
        AND taa.attribute_id = ar.id
  );

-- Assign new SECURITY attributes to SECURITY_STANDARD template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'SECURITY_STANDARD'),
    ar.id,
    ar.is_required,
    ROW_NUMBER() OVER (ORDER BY ar.display_group, ar.attribute_code)
FROM metadata_register.attribute_register ar
WHERE ar.domain_code = 'SECURITY'
  AND ar.attribute_code NOT IN ('ISIN', 'CUSIP', 'TICKER', 'SECURITY_TYPE', 'CURRENCY', 'EXCHANGE', 'PRICE', 'PRICE_DATE', 'CURRENT_PRICE', 'EFFECTIVE_DURATION', 'CURRENT_YIELD', 'UNREALIZED_PNL')
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.template_attribute_assignments taa
      WHERE taa.template_id = (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'SECURITY_STANDARD')
        AND taa.attribute_id = ar.id
  );

-- Assign POSITION attributes to POSITION_STANDARD template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'POSITION_STANDARD'),
    ar.id,
    ar.is_required,
    ROW_NUMBER() OVER (ORDER BY ar.display_group, ar.attribute_code)
FROM metadata_register.attribute_register ar
WHERE ar.domain_code = 'POSITION'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.template_attribute_assignments taa
      WHERE taa.template_id = (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'POSITION_STANDARD')
        AND taa.attribute_id = ar.id
  );

-- Composite Identifiers
INSERT INTO metadata_register.entity_identifier_definitions (domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description)
VALUES
    ('ISSUER', 'ISSUER_ID', 'Issuer ID', ARRAY['ISSUER_LEGAL_NAME', 'LEI'], TRUE, 'Primary composite identifier: legal name + LEI code'),
    ('SECURITY', 'SECURITY_ISIN_CUSIP', 'ISIN + CUSIP', ARRAY['ISIN', 'CUSIP'], TRUE, 'Primary composite identifier: ISIN + CUSIP'),
    ('SECURITY', 'SECURITY_COMMON_CODE', 'Common Code', ARRAY['COMMON_CODE'], FALSE, 'Euroclear/Clearstream common code identifier'),
    ('POSITION', 'POSITION_COMPOSITE', 'Fund + Security + Trade Date', ARRAY['PORTFOLIO_FUND_ID', 'SECURITY_ID', 'TRADE_DATE'], TRUE, 'Primary composite identifier: fund + security + trade date')
ON CONFLICT (domain_code, identifier_code) DO NOTHING;

-- Relationship Types
INSERT INTO metadata_register.relationship_types (relationship_code, relationship_name, parent_domain_code, child_domain_code, cardinality, description)
VALUES
    ('ISSUER_SECURITY', 'Issuer Securities', 'ISSUER', 'SECURITY', 'ONE_TO_MANY', 'One issuer can have multiple securities'),
    ('SECURITY_POSITION', 'Security Positions', 'SECURITY', 'POSITION', 'ONE_TO_MANY', 'One security can be held in multiple positions across portfolios')
ON CONFLICT (relationship_code) DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
