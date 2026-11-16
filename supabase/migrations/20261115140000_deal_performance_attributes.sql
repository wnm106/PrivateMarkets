-- Stored outputs of the deal performance model.
--
-- The Performance tab used to compute IRR, MOIC, yields and both bridges in the
-- browser, so none of those figures pointed back to the entity model. The model
-- now runs on the server (packages/graphql/src/lib/deal-performance-store.ts)
-- and writes its outputs here on the PERFORMANCE_MODEL source.
--
-- Rates are percent points. Multiples are plain numbers. Amounts are dollars.
-- The values are not calc definitions: the model is a monthly cash-flow
-- projection, which the expression library cannot express. They are refreshed
-- when an allocation is committed and by the refreshDealPerformance mutation.

INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, feed_frequency, precedence_rank, is_active, metadata)
VALUES ('PERFORMANCE_MODEL', 'Deal Performance Model', 'CALCULATED', 'ON_DEMAND', 100, TRUE, '{"color":"#475569"}'::jsonb)
ON CONFLICT (source_code) DO NOTHING;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group,
    is_editable, is_visible, is_time_varying, time_dimension, is_derived
) VALUES
    ('DEAL_GROSS_IRR', 'Gross IRR (Modelled)', 'PERCENTAGE', 'Annualised gross return on our allocated debt position over the projected life', 'DEAL', FALSE, 100, 'Performance', 1, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_NET_IRR', 'Net IRR (Modelled)', 'PERCENTAGE', 'Gross IRR after management fee, fund expenses and incentive fee', 'DEAL', FALSE, 100, 'Performance', 2, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_GROSS_MOIC', 'Gross MOIC (Modelled)', 'NUMBER', 'Invested plus gross profit, over invested', 'DEAL', FALSE, 100, 'Performance', 3, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_NET_MOIC', 'Net TVPI (Modelled)', 'NUMBER', 'Invested plus net profit, over invested', 'DEAL', FALSE, 100, 'Performance', 4, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_DPI', 'DPI (Gross)', 'NUMBER', 'Distributions before exit value, over invested', 'DEAL', FALSE, 100, 'Performance', 5, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_RVPI', 'RVPI (Gross)', 'NUMBER', 'Exit value at the mark, over invested', 'DEAL', FALSE, 100, 'Performance', 6, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_GROSS_TO_NET_SPREAD_BPS', 'Gross to Net Spread (bps)', 'NUMBER', 'Gross IRR minus net IRR, in basis points', 'DEAL', FALSE, 100, 'Performance', 7, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_CASH_YIELD', 'Current Cash Yield', 'PERCENTAGE', 'First-quarter cash income, annualised, over funded par', 'DEAL', FALSE, 100, 'Performance', 8, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_ALL_IN_YIELD', 'All-in Yield', 'PERCENTAGE', 'Weighted coupon plus OID spread over the hold', 'DEAL', FALSE, 100, 'Performance', 9, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_WEIGHTED_COUPON', 'Weighted Cash Coupon', 'PERCENTAGE', 'Cash coupon weighted by our position in each tranche', 'DEAL', FALSE, 100, 'Performance', 10, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_WEIGHTED_SPREAD', 'Weighted Spread', 'PERCENTAGE', 'Spread over the index weighted by our position in each tranche', 'DEAL', FALSE, 100, 'Performance', 11, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_PIK_INCOME_SHARE', 'PIK Share of Income', 'PERCENTAGE', 'PIK interest as a share of all income including OID', 'DEAL', FALSE, 100, 'Performance', 12, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INTEREST_COVERAGE', 'Interest Coverage', 'NUMBER', 'One over leverage times the weighted coupon', 'DEAL', FALSE, 100, 'Performance', 13, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_WAL_YEARS', 'Weighted Average Life (Years)', 'NUMBER', 'Principal-weighted years to repayment', 'DEAL', FALSE, 100, 'Performance', 14, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_HELD_POSITION', 'Held Position', 'CURRENCY', 'Our allocated par across the debt tranches', 'DEAL', FALSE, 100, 'Performance', 15, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INVESTED_AMOUNT', 'Invested Amount', 'CURRENCY', 'Cash funded over the projected life, net of OID', 'DEAL', FALSE, 100, 'Performance', 16, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_GROSS_PROFIT', 'Gross Profit', 'CURRENCY', 'Sum of projected cash flows before fees', 'DEAL', FALSE, 100, 'Performance', 17, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_NET_PROFIT', 'Net Profit to Investors', 'CURRENCY', 'Gross profit after management fee, fund expenses and incentive fee', 'DEAL', FALSE, 100, 'Performance', 18, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_MGMT_FEE_AMOUNT', 'Management Fee', 'CURRENCY', 'Management fee over the projected life. Negative: it reduces profit.', 'DEAL', FALSE, 100, 'Performance', 19, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_FUND_EXPENSE_AMOUNT', 'Fund Expenses', 'CURRENCY', 'Fund expenses over the projected life. Negative: it reduces profit.', 'DEAL', FALSE, 100, 'Performance', 20, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INCENTIVE_FEE_AMOUNT', 'Incentive Fee', 'CURRENCY', 'Carry over the hurdle. Negative: it reduces profit.', 'DEAL', FALSE, 100, 'Performance', 21, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INCOME_CASH', 'Cash Interest and Undrawn Fees', 'CURRENCY', 'Projected cash interest plus undrawn fees', 'DEAL', FALSE, 100, 'Performance', 22, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INCOME_PIK', 'PIK Interest', 'CURRENCY', 'Projected PIK interest', 'DEAL', FALSE, 100, 'Performance', 23, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INCOME_OID', 'OID and Upfront Fees', 'CURRENCY', 'Funded par times one minus the OID price', 'DEAL', FALSE, 100, 'Performance', 24, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_INCOME_MARK', 'Mark-to-Market and Equity Kicker', 'CURRENCY', 'Gross profit not explained by interest, fees, PIK or OID', 'DEAL', FALSE, 100, 'Performance', 25, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_PROJECTION_END_DATE', 'Projection End Date', 'DATE', 'Last month of the projected life', 'DEAL', FALSE, 100, 'Performance', 26, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_MODEL_INCOME', 'Income (Modelled)', 'CURRENCY', 'Cash interest, undrawn fees, PIK and OID across the debt tranches', 'DEAL', FALSE, 100, 'Performance', 27, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_HELD_POSITION', 'Held Position', 'CURRENCY', 'Our allocated par in this tranche', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 10, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_CASH_COUPON', 'Cash Coupon (Modelled)', 'PERCENTAGE', 'Index rate plus spread used by the performance model', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 11, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MODEL_INCOME', 'Income (Modelled)', 'CURRENCY', 'Cash interest, undrawn fees, PIK and OID', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 12, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MODEL_MARK_GAIN', 'Mark and Equity (Modelled)', 'CURRENCY', 'Tranche profit not explained by income', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 13, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MODEL_PROFIT', 'Profit (Modelled)', 'CURRENCY', 'Sum of the tranche projected cash flows', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 14, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MODEL_IRR', 'IRR (Modelled)', 'PERCENTAGE', 'Annualised return on the tranche projected cash flows', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 15, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MODEL_MOIC', 'MOIC (Modelled)', 'NUMBER', 'Invested plus profit, over invested', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 16, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_PROFIT_SHARE', 'Share of Deal Profit', 'PERCENTAGE', 'Tranche profit over deal gross profit', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 17, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_IRR_CONTRIBUTION', 'Contribution to Deal IRR', 'PERCENTAGE', 'Share of deal profit times deal gross IRR, in points', 'DEAL_TRANCHE', FALSE, 100, 'Returns', 18, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    domain_code = EXCLUDED.domain_code,
    is_editable = EXCLUDED.is_editable,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'DEAL_GROSS_IRR', 'DEAL_NET_IRR', 'DEAL_GROSS_MOIC', 'DEAL_NET_MOIC', 'DEAL_DPI', 'DEAL_RVPI',
    'DEAL_GROSS_TO_NET_SPREAD_BPS', 'DEAL_CASH_YIELD', 'DEAL_ALL_IN_YIELD', 'DEAL_WEIGHTED_COUPON',
    'DEAL_WEIGHTED_SPREAD', 'DEAL_PIK_INCOME_SHARE', 'DEAL_INTEREST_COVERAGE', 'DEAL_WAL_YEARS',
    'DEAL_HELD_POSITION', 'DEAL_INVESTED_AMOUNT', 'DEAL_GROSS_PROFIT', 'DEAL_NET_PROFIT',
    'DEAL_MGMT_FEE_AMOUNT', 'DEAL_FUND_EXPENSE_AMOUNT', 'DEAL_INCENTIVE_FEE_AMOUNT',
    'DEAL_INCOME_CASH', 'DEAL_INCOME_PIK', 'DEAL_INCOME_OID', 'DEAL_INCOME_MARK', 'DEAL_PROJECTION_END_DATE', 'DEAL_MODEL_INCOME',
    'TRANCHE_HELD_POSITION', 'TRANCHE_CASH_COUPON', 'TRANCHE_MODEL_INCOME', 'TRANCHE_MODEL_MARK_GAIN',
    'TRANCHE_MODEL_PROFIT', 'TRANCHE_MODEL_IRR', 'TRANCHE_MODEL_MOIC', 'TRANCHE_PROFIT_SHARE', 'TRANCHE_IRR_CONTRIBUTION'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;
