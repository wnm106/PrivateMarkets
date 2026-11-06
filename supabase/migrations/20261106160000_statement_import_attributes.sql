-- Attributes a NAV statement or a company financial statement can land on,
-- plus permission for the importer to register a line it has not seen before.

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible
) VALUES
    ('INVESTMENTS_AT_FAIR_VALUE', 'Investments at Fair Value', 'CURRENCY', 'Portfolio investments carried at fair value.', NULL, FALSE, 100, 'Assets', 10, TRUE, TRUE),
    ('CASH', 'Cash', 'CURRENCY', 'Cash balance.', NULL, FALSE, 100, 'Assets', 20, TRUE, TRUE),
    ('CASH_AND_EQUIVALENTS', 'Cash and Cash Equivalents', 'CURRENCY', 'Cash and short-term equivalents.', NULL, FALSE, 100, 'Assets', 30, TRUE, TRUE),
    ('TOTAL_ASSETS', 'Total Assets', 'CURRENCY', 'Total assets.', NULL, FALSE, 100, 'Assets', 40, TRUE, TRUE),
    ('TOTAL_LIABILITIES', 'Total Liabilities', 'CURRENCY', 'Total liabilities.', NULL, FALSE, 100, 'Liabilities', 10, TRUE, TRUE),
    ('ACCRUED_EXPENSES', 'Accrued Expenses', 'CURRENCY', 'Expenses incurred and not yet paid.', NULL, FALSE, 100, 'Liabilities', 20, TRUE, TRUE),
    ('CONTRIBUTIONS', 'Contributions', 'CURRENCY', 'Capital contributed during the period.', NULL, FALSE, 100, 'Capital', 10, TRUE, TRUE),
    ('DISTRIBUTIONS', 'Distributions', 'CURRENCY', 'Capital distributed during the period.', NULL, FALSE, 100, 'Capital', 20, TRUE, TRUE),
    ('MANAGEMENT_FEE', 'Management Fee', 'CURRENCY', 'Management fee for the period.', NULL, FALSE, 100, 'Fees', 10, TRUE, TRUE),
    ('INCENTIVE_FEE', 'Incentive Fee', 'CURRENCY', 'Performance or incentive allocation.', NULL, FALSE, 100, 'Fees', 20, TRUE, TRUE),
    ('REVENUE', 'Revenue', 'CURRENCY', 'Revenue for the period.', NULL, FALSE, 100, 'Income', 10, TRUE, TRUE),
    ('COST_OF_GOODS', 'Cost of Goods Sold', 'CURRENCY', 'Cost of goods or cost of sales.', NULL, FALSE, 100, 'Income', 20, TRUE, TRUE),
    ('GROSS_PROFIT', 'Gross Profit', 'CURRENCY', 'Revenue less cost of goods.', NULL, FALSE, 100, 'Income', 30, TRUE, TRUE),
    ('OPERATING_INCOME', 'Operating Income', 'CURRENCY', 'Income from operations.', NULL, FALSE, 100, 'Income', 40, TRUE, TRUE),
    ('EBITDA', 'EBITDA', 'CURRENCY', 'Earnings before interest, tax, depreciation, and amortization.', NULL, FALSE, 100, 'Income', 50, TRUE, TRUE),
    ('NET_INCOME', 'Net Income', 'CURRENCY', 'Profit for the period.', NULL, FALSE, 100, 'Income', 60, TRUE, TRUE),
    ('TOTAL_EQUITY', 'Total Equity', 'CURRENCY', 'Total equity or shareholders equity.', NULL, FALSE, 100, 'Equity', 10, TRUE, TRUE),
    ('INTEREST_EXPENSE', 'Interest Expense', 'CURRENCY', 'Interest or finance cost.', NULL, FALSE, 100, 'Income', 70, TRUE, TRUE),
    ('REPORTING_CURRENCY', 'Reporting Currency', 'STRING', 'Currency the statement amounts are reported in.', NULL, FALSE, 100, 'Statement', 10, TRUE, TRUE)
ON CONFLICT (attribute_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order, display_label)
SELECT t.id, a.id, FALSE, a.display_group, a.attribute_name
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a ON a.attribute_code IN (
    'INVESTMENTS_AT_FAIR_VALUE', 'CASH', 'CASH_AND_EQUIVALENTS', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES',
    'ACCRUED_EXPENSES', 'CONTRIBUTIONS', 'DISTRIBUTIONS', 'MANAGEMENT_FEE', 'INCENTIVE_FEE', 'NAV'
)
WHERE t.template_code = 'FUND_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order, display_label)
SELECT t.id, a.id, FALSE, a.display_group, a.attribute_name
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a ON a.attribute_code IN (
    'REVENUE', 'COST_OF_GOODS', 'GROSS_PROFIT', 'OPERATING_INCOME', 'EBITDA', 'NET_INCOME',
    'TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'TOTAL_EQUITY', 'CASH', 'CASH_AND_EQUIVALENTS',
    'ACCRUED_EXPENSES', 'INTEREST_EXPENSE', 'MANAGEMENT_FEE', 'REPORTING_CURRENCY', 'MARKET_CAP'
)
WHERE t.template_code = 'ISSUER_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

GRANT INSERT, UPDATE ON metadata_register.attribute_register TO service_role;
GRANT INSERT, UPDATE ON metadata_register.template_attribute_assignments TO service_role;
GRANT SELECT ON metadata_register.domain_templates TO service_role;
