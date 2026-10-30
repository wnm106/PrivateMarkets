-- Fund surface: investors, capital activity, NAV review, pacing, facility, and exposure.
--
-- A commitment is the intersection of an investor and a fund. Like a tranche,
-- it is registered as an intersection and stored as an entity with relationships
-- so the grids and the surface can both read it.
--
-- Administrator and shadow amounts are two attributes on one NAV line. The
-- review has to show both at once, so they are not two sources of one value.
-- Called capital, TVPI, variance, and coverage are assembled by the surface
-- from these facts.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('INVESTOR', 'Investor', 'Limited partner, affiliate, or general partner committed to a fund'),
    ('INVESTOR_COMMITMENT', 'Investor Commitment', 'One investor''s commitment to one fund'),
    ('CAPITAL_ACTIVITY', 'Capital Activity', 'A capital call or distribution of a fund'),
    ('CAPITAL_PLAN', 'Capital Plan', 'Deployment plan for one quarter: percent called, NAV, and any projected call'),
    ('NAV_STATEMENT', 'NAV Statement', 'Administrator NAV package for one period, with the review tolerance and certification'),
    ('NAV_LINE', 'NAV Line', 'One row of a NAV statement, with the administrator amount and our shadow'),
    ('CREDIT_FACILITY', 'Credit Facility', 'Subscription or leverage line of a fund'),
    ('CASH_FORECAST', 'Cash Forecast', 'Projected cash movements for one future quarter'),
    ('EXPOSURE_LIMIT', 'Exposure Limit', 'Concentration limit for one strategy, sector, or issuer')
ON CONFLICT (domain_code) DO NOTHING;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('INVESTOR_TYPE', 'Investor Type', 'INVESTOR', 'Kind of investor'),
    ('COMMITMENT_STATUS', 'Commitment Status', 'INVESTOR_COMMITMENT', 'Whether the investor is current on calls'),
    ('ACTIVITY_KIND', 'Capital Activity Kind', 'CAPITAL_ACTIVITY', 'Call or distribution'),
    ('ACTIVITY_STATUS', 'Capital Activity Status', 'CAPITAL_ACTIVITY', 'Where the call or distribution stands'),
    ('LIMIT_DIMENSION', 'Exposure Dimension', 'EXPOSURE_LIMIT', 'What a concentration limit groups by'),
    ('POSITION_STRATEGY', 'Position Strategy', 'POSITION', 'Sleeve a holding sits in on the fund surface')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('INVESTOR_TYPE', 'PENSION', 'Pension', 1),
    ('INVESTOR_TYPE', 'INSURANCE', 'Insurance', 2),
    ('INVESTOR_TYPE', 'FAMILY_OFFICE', 'Family office', 3),
    ('INVESTOR_TYPE', 'ENDOWMENT', 'Endowment', 4),
    ('INVESTOR_TYPE', 'FUND_OF_FUNDS', 'Fund of funds', 5),
    ('INVESTOR_TYPE', 'FOUNDATION', 'Foundation', 6),
    ('INVESTOR_TYPE', 'GENERAL_PARTNER', 'General partner', 7),
    ('COMMITMENT_STATUS', 'CURRENT', 'Current', 1),
    ('COMMITMENT_STATUS', 'PAST_DUE', 'Past due', 2),
    ('ACTIVITY_KIND', 'CAPITAL_CALL', 'Capital call', 1),
    ('ACTIVITY_KIND', 'DISTRIBUTION', 'Distribution', 2),
    ('ACTIVITY_STATUS', 'FUNDED', 'Funded', 1),
    ('ACTIVITY_STATUS', 'PAID', 'Paid', 2),
    ('ACTIVITY_STATUS', 'PROJECTED', 'Projected', 3),
    ('ACTIVITY_STATUS', 'SCHEDULED', 'Scheduled', 4),
    ('LIMIT_DIMENSION', 'STRATEGY', 'Strategy', 1),
    ('LIMIT_DIMENSION', 'SECTOR', 'Sector', 2),
    ('LIMIT_DIMENSION', 'ISSUER', 'Issuer', 3),
    ('POSITION_STRATEGY', 'SENIOR_SECURED', 'Senior secured', 1),
    ('POSITION_STRATEGY', 'UNITRANCHE', 'Unitranche', 2),
    ('POSITION_STRATEGY', 'MEZZANINE', 'Mezzanine', 3),
    ('POSITION_STRATEGY', 'ASSET_BASED', 'Asset-based', 4)
) AS v(list_code, code, label, ord) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- ============================================================
-- 3. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       v.list, FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       v.tv, CASE WHEN v.tv THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    ('FUND_STRATEGY', 'Strategy', 'REFERENCE_LIST', 'Investment strategy of the fund', 'FUND', 'DEAL_STRATEGY', 'Profile', 1, FALSE),
    ('FUND_VINTAGE', 'Vintage', 'STRING', 'Year the fund closed', 'FUND', NULL, 'Profile', 2, FALSE),
    ('FUND_REPORTING_DATE', 'Reporting Date', 'DATE', 'Date the fund surface is reporting', 'FUND', NULL, 'Profile', 3, TRUE),
    ('FUND_TOTAL_COMMITMENTS', 'Total Commitments', 'CURRENCY', 'Investor commitments, including the general partner', 'FUND', NULL, 'Capital', 1, TRUE),
    ('FUND_COMMITMENTS_CLOSED', 'Commitments Closed', 'DATE', 'Date the commitment period closed', 'FUND', NULL, 'Capital', 2, FALSE),
    ('FUND_INVESTMENT_PERIOD_END', 'Investment Period End', 'DATE', 'Last day of the investment period', 'FUND', NULL, 'Capital', 3, FALSE),
    ('FUND_TARGET_CALLED_PCT', 'Target Called', 'PERCENTAGE', 'Called percent the pacing plan aims to reach by the investment period end', 'FUND', NULL, 'Capital', 4, FALSE),
    ('FUND_GROSS_IRR', 'Gross IRR', 'PERCENTAGE', 'Since-inception gross IRR, before fees and carry', 'FUND', NULL, 'Returns', 1, TRUE),
    ('FUND_NET_IRR', 'Net IRR', 'PERCENTAGE', 'Since-inception net IRR stored for the golden record. The surface shows the bridge result.', 'FUND', NULL, 'Returns', 2, TRUE),
    ('FUND_FEE_DRAG_PTS', 'Management Fee Drag', 'NUMBER', 'Gross-to-net bridge: management fee, in percentage points', 'FUND', NULL, 'Returns', 3, FALSE),
    ('FUND_EXPENSE_DRAG_PTS', 'Fund Expense Drag', 'NUMBER', 'Gross-to-net bridge: fund expenses, in percentage points', 'FUND', NULL, 'Returns', 4, FALSE),
    ('FUND_CARRY_DRAG_PTS', 'Carry Drag', 'NUMBER', 'Gross-to-net bridge: accrued carry, in percentage points', 'FUND', NULL, 'Returns', 5, FALSE),
    ('FUND_UNFUNDED_BORROWER_COMMITMENTS', 'Unfunded Borrower Commitments', 'CURRENCY', 'Delayed draws and revolvers the fund still has to fund', 'FUND', NULL, 'Liquidity', 6, TRUE),
    ('FUND_LIQUIDITY_COVERAGE_MIN', 'Liquidity Coverage Minimum', 'NUMBER', 'Minimum cash plus facility availability, as a multiple of unfunded borrower commitments', 'FUND', NULL, 'Liquidity', 7, FALSE),
    ('FUND_SECTOR_LIMIT_PCT', 'Sector Limit', 'PERCENTAGE', 'Default sector concentration limit, as a percent of fair value', 'FUND', NULL, 'Exposure', 1, FALSE),
    ('FUND_ISSUER_LIMIT_PCT', 'Issuer Limit', 'PERCENTAGE', 'Default single-issuer concentration limit, as a percent of fair value', 'FUND', NULL, 'Exposure', 2, FALSE),

    ('INVESTOR_TYPE', 'Investor Type', 'REFERENCE_LIST', 'Pension, insurance, family office, and the rest', 'INVESTOR', 'INVESTOR_TYPE', 'Profile', 1, FALSE),

    ('COMMITMENT_AMOUNT', 'Commitment', 'CURRENCY', 'Amount this investor committed to the fund', 'INVESTOR_COMMITMENT', NULL, 'Capital', 1, TRUE),
    ('COMMITMENT_STATUS', 'Status', 'REFERENCE_LIST', 'Current, or past due on a call', 'INVESTOR_COMMITMENT', 'COMMITMENT_STATUS', 'Capital', 2, FALSE),
    ('COMMITMENT_PAST_DUE', 'Past Due', 'CURRENCY', 'Amount of the commitment still unpaid on a call', 'INVESTOR_COMMITMENT', NULL, 'Capital', 3, TRUE),

    ('ACTIVITY_DATE', 'Activity Date', 'DATE', 'Call due date or distribution date', 'CAPITAL_ACTIVITY', NULL, 'Activity', 1, FALSE),
    ('ACTIVITY_KIND', 'Kind', 'REFERENCE_LIST', 'Capital call or distribution', 'CAPITAL_ACTIVITY', 'ACTIVITY_KIND', 'Activity', 2, FALSE),
    ('ACTIVITY_AMOUNT', 'Amount', 'CURRENCY', 'Call or distribution amount. Always stored positive; the kind carries the direction.', 'CAPITAL_ACTIVITY', NULL, 'Activity', 3, FALSE),
    ('ACTIVITY_STATUS', 'Status', 'REFERENCE_LIST', 'Funded, paid, projected, or scheduled', 'CAPITAL_ACTIVITY', 'ACTIVITY_STATUS', 'Activity', 4, FALSE),
    ('ACTIVITY_OUTSTANDING', 'Outstanding', 'CURRENCY', 'Portion of a funded call the investor has not yet paid', 'CAPITAL_ACTIVITY', NULL, 'Activity', 5, FALSE),
    ('ACTIVITY_NOTICE', 'Notice', 'STRING', 'Notice timing shown for a projected call', 'CAPITAL_ACTIVITY', NULL, 'Activity', 6, FALSE),

    ('STATEMENT_PERIOD_END', 'Period End', 'DATE', 'Balance-sheet date of the NAV package', 'NAV_STATEMENT', NULL, 'Review', 1, FALSE),
    ('STATEMENT_PERIOD_LABEL', 'Period Label', 'STRING', 'How the period is named on the statements', 'NAV_STATEMENT', NULL, 'Review', 2, FALSE),
    ('STATEMENT_TOLERANCE_PCT', 'Review Tolerance', 'PERCENTAGE', 'Variance, in percent of the shadow, that still counts as within tolerance', 'NAV_STATEMENT', NULL, 'Review', 3, FALSE),
    ('STATEMENT_CERTIFIED', 'Certified', 'BOOLEAN', 'True once the open review items are resolved and the NAV is certified', 'NAV_STATEMENT', NULL, 'Review', 4, FALSE),

    ('NAV_LINE_CODE', 'Line Code', 'STRING', 'Stable code for a statement row, such as the interest receivable', 'NAV_LINE', NULL, 'Line', 1, FALSE),
    ('NAV_LINE_STATEMENT', 'Statement', 'STRING', 'Which statement the row belongs to: BS_ASSET, BS_LIABILITY, BS_NET, OPS, CHANGES, CASH, ROLL', 'NAV_LINE', NULL, 'Line', 2, FALSE),
    ('NAV_LINE_ROLE', 'Role', 'STRING', 'HEADER, NOTE, DETAIL, LINE, SUBTOTAL, or TOTAL', 'NAV_LINE', NULL, 'Line', 3, FALSE),
    ('NAV_LINE_INDENT', 'Indent', 'INTEGER', 'How far the label is indented', 'NAV_LINE', NULL, 'Line', 4, FALSE),
    ('NAV_LINE_ORDER', 'Order', 'INTEGER', 'Order of the row inside its statement', 'NAV_LINE', NULL, 'Line', 5, FALSE),
    ('NAV_LINE_ADMINISTRATOR', 'Administrator Amount', 'CURRENCY', 'Amount on the administrator statement', 'NAV_LINE', NULL, 'Line', 6, FALSE),
    ('NAV_LINE_SHADOW', 'Shadow Amount', 'CURRENCY', 'Amount from our calculation. Blank when we do not shadow the row.', 'NAV_LINE', NULL, 'Line', 7, FALSE),
    ('NAV_LINE_RESOLVED', 'Resolved', 'BOOLEAN', 'True when a flagged variance has been accepted', 'NAV_LINE', NULL, 'Line', 8, FALSE),
    ('NAV_LINE_REVIEWABLE', 'Reviewable', 'BOOLEAN', 'True when a variance on this row can block certification', 'NAV_LINE', NULL, 'Line', 9, FALSE),
    ('NAV_LINE_IN_COMPOSITION', 'In Composition', 'BOOLEAN', 'True when the row is a line of the NAV composition', 'NAV_LINE', NULL, 'Line', 10, FALSE),

    ('PLAN_QUARTER_END', 'Quarter End', 'DATE', 'Last day of the plan quarter', 'CAPITAL_PLAN', NULL, 'Plan', 1, FALSE),
    ('PLAN_CALLED_PCT', 'Plan Called', 'PERCENTAGE', 'Cumulative percent of commitments the plan says should be called', 'CAPITAL_PLAN', NULL, 'Plan', 2, FALSE),
    ('PLAN_NAV', 'Quarter-end NAV', 'CURRENCY', 'NAV at the quarter end. Blank for a future quarter.', 'CAPITAL_PLAN', NULL, 'Plan', 3, FALSE),
    ('PLAN_CALL_AMOUNT', 'Projected Call', 'CURRENCY', 'Call the pipeline projects for a future quarter', 'CAPITAL_PLAN', NULL, 'Plan', 4, FALSE),
    ('PLAN_ORDER', 'Order', 'INTEGER', 'Order of the quarter on the pacing chart', 'CAPITAL_PLAN', NULL, 'Plan', 5, FALSE),

    ('FACILITY_COMMITMENT', 'Facility Commitment', 'CURRENCY', 'Size of the credit facility', 'CREDIT_FACILITY', NULL, 'Facility', 1, TRUE),
    ('FACILITY_DRAWN', 'Drawn', 'CURRENCY', 'Amount currently drawn', 'CREDIT_FACILITY', NULL, 'Facility', 2, TRUE),
    ('FACILITY_BORROWING_BASE', 'Borrowing Base', 'CURRENCY', 'Borrowing base that can limit availability', 'CREDIT_FACILITY', NULL, 'Facility', 3, TRUE),
    ('FACILITY_MATURITY', 'Maturity', 'DATE', 'Facility maturity', 'CREDIT_FACILITY', NULL, 'Facility', 4, FALSE),

    ('LIMIT_DIMENSION', 'Dimension', 'REFERENCE_LIST', 'Strategy, sector, or issuer', 'EXPOSURE_LIMIT', 'LIMIT_DIMENSION', 'Limit', 1, FALSE),
    ('LIMIT_KEY', 'Limit Key', 'STRING', 'Strategy code, sector name, or issuer name the limit applies to', 'EXPOSURE_LIMIT', NULL, 'Limit', 2, FALSE),
    ('LIMIT_PCT', 'Limit', 'PERCENTAGE', 'Maximum share of fair value', 'EXPOSURE_LIMIT', NULL, 'Limit', 3, FALSE),

    ('FORECAST_QUARTER_END', 'Quarter End', 'DATE', 'Quarter the forecast covers', 'CASH_FORECAST', NULL, 'Forecast', 1, FALSE),
    ('FORECAST_ORDER', 'Order', 'INTEGER', 'Column order', 'CASH_FORECAST', NULL, 'Forecast', 2, FALSE),
    ('FORECAST_INTEREST', 'Interest Income', 'CURRENCY', 'Projected interest income', 'CASH_FORECAST', NULL, 'Forecast', 3, FALSE),
    ('FORECAST_REPAYMENTS', 'Repayments', 'CURRENCY', 'Projected investment repayments', 'CASH_FORECAST', NULL, 'Forecast', 4, FALSE),
    ('FORECAST_NEW_FUNDINGS', 'New Fundings', 'CURRENCY', 'Projected new fundings. Stored negative when it is a use of cash.', 'CASH_FORECAST', NULL, 'Forecast', 5, FALSE),
    ('FORECAST_FEES', 'Fees and Interest', 'CURRENCY', 'Projected fees, expenses, and interest. Stored negative when it is a use of cash.', 'CASH_FORECAST', NULL, 'Forecast', 6, FALSE),
    ('FORECAST_DISTRIBUTIONS', 'Distributions', 'CURRENCY', 'Projected distributions. Stored negative when it is a use of cash.', 'CASH_FORECAST', NULL, 'Forecast', 7, FALSE),
    ('FORECAST_CAPITAL_CALLS', 'Capital Calls', 'CURRENCY', 'Projected capital calls', 'CASH_FORECAST', NULL, 'Forecast', 8, FALSE),
    ('FORECAST_FACILITY_PAYDOWN', 'Facility Paydown', 'CURRENCY', 'Projected facility repayment. Stored negative when it reduces the drawn balance.', 'CASH_FORECAST', NULL, 'Forecast', 9, FALSE),

    ('POSITION_STRATEGY', 'Strategy', 'REFERENCE_LIST', 'Senior secured, unitranche, mezzanine, or asset-based', 'POSITION', 'POSITION_STRATEGY', 'Holding', 1, FALSE),
    ('POSITION_COST', 'Cost', 'CURRENCY', 'Cost of the position', 'POSITION', NULL, 'Holding', 2, TRUE),
    ('POSITION_INCOME', 'Income', 'CURRENCY', 'Income collected on the position', 'POSITION', NULL, 'Holding', 3, TRUE),
    ('POSITION_REALIZED_GAIN', 'Realized Gain', 'CURRENCY', 'Realized gain, including an exit', 'POSITION', NULL, 'Holding', 4, TRUE),
    ('POSITION_GROSS_IRR', 'Gross IRR', 'PERCENTAGE', 'Gross IRR of the position since inception', 'POSITION', NULL, 'Holding', 5, TRUE),
    ('POSITION_MARK', 'Administrator Mark', 'NUMBER', 'Administrator mark, as a percent of par', 'POSITION', NULL, 'Valuation', 1, TRUE),
    ('POSITION_AGENT_MARK', 'Agent Mark', 'NUMBER', 'Valuation agent price, as a percent of par', 'POSITION', NULL, 'Valuation', 2, TRUE),
    ('POSITION_COUPON', 'Coupon', 'STRING', 'Coupon or spread, as written on the tear sheet', 'POSITION', NULL, 'Terms', 1, FALSE),
    ('POSITION_LEVERAGE', 'Leverage', 'NUMBER', 'Net debt to EBITDA at close', 'POSITION', NULL, 'Terms', 2, TRUE),
    ('POSITION_IS_FLOATING', 'Floating Rate', 'BOOLEAN', 'True when the coupon floats', 'POSITION', NULL, 'Terms', 3, FALSE),
    ('POSITION_MARK_RESOLVED', 'Mark Resolved', 'BOOLEAN', 'True when a mark difference has been accepted', 'POSITION', NULL, 'Valuation', 3, FALSE)
) AS v(code, name, dtype, descr, dom, list, section, grp, tv)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('INVESTOR_STANDARD', 'Standard Investor', 'INVESTOR', 'Investor profile'),
    ('INVESTOR_COMMITMENT_STANDARD', 'Standard Investor Commitment', 'INVESTOR_COMMITMENT', 'Commitment of one investor to one fund'),
    ('CAPITAL_ACTIVITY_STANDARD', 'Standard Capital Activity', 'CAPITAL_ACTIVITY', 'A call or distribution'),
    ('CAPITAL_PLAN_STANDARD', 'Standard Capital Plan', 'CAPITAL_PLAN', 'One quarter of the deployment plan'),
    ('NAV_STATEMENT_STANDARD', 'Standard NAV Statement', 'NAV_STATEMENT', 'One period NAV package'),
    ('NAV_LINE_STANDARD', 'Standard NAV Line', 'NAV_LINE', 'One statement row'),
    ('CREDIT_FACILITY_STANDARD', 'Standard Credit Facility', 'CREDIT_FACILITY', 'A fund credit facility'),
    ('CASH_FORECAST_STANDARD', 'Standard Cash Forecast', 'CASH_FORECAST', 'One quarter of the cash forecast'),
    ('EXPOSURE_LIMIT_STANDARD', 'Standard Exposure Limit', 'EXPOSURE_LIMIT', 'One concentration limit')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'FUND_STRATEGY','FUND_VINTAGE','FUND_REPORTING_DATE','FUND_TOTAL_COMMITMENTS','FUND_COMMITMENTS_CLOSED',
    'FUND_INVESTMENT_PERIOD_END','FUND_TARGET_CALLED_PCT','FUND_GROSS_IRR','FUND_NET_IRR',
    'FUND_FEE_DRAG_PTS','FUND_EXPENSE_DRAG_PTS','FUND_CARRY_DRAG_PTS',
    'FUND_UNFUNDED_BORROWER_COMMITMENTS','FUND_LIQUIDITY_COVERAGE_MIN','FUND_SECTOR_LIMIT_PCT','FUND_ISSUER_LIMIT_PCT',
    'INVESTOR_TYPE',
    'COMMITMENT_AMOUNT','COMMITMENT_STATUS','COMMITMENT_PAST_DUE',
    'ACTIVITY_DATE','ACTIVITY_KIND','ACTIVITY_AMOUNT','ACTIVITY_STATUS','ACTIVITY_OUTSTANDING','ACTIVITY_NOTICE',
    'STATEMENT_PERIOD_END','STATEMENT_PERIOD_LABEL','STATEMENT_TOLERANCE_PCT','STATEMENT_CERTIFIED',
    'NAV_LINE_CODE','NAV_LINE_STATEMENT','NAV_LINE_ROLE','NAV_LINE_INDENT','NAV_LINE_ORDER',
    'NAV_LINE_ADMINISTRATOR','NAV_LINE_SHADOW','NAV_LINE_RESOLVED','NAV_LINE_REVIEWABLE','NAV_LINE_IN_COMPOSITION',
    'PLAN_QUARTER_END','PLAN_CALLED_PCT','PLAN_NAV','PLAN_CALL_AMOUNT','PLAN_ORDER',
    'FACILITY_COMMITMENT','FACILITY_DRAWN','FACILITY_BORROWING_BASE','FACILITY_MATURITY',
    'LIMIT_DIMENSION','LIMIT_KEY','LIMIT_PCT',
    'FORECAST_QUARTER_END','FORECAST_ORDER','FORECAST_INTEREST','FORECAST_REPAYMENTS','FORECAST_NEW_FUNDINGS',
    'FORECAST_FEES','FORECAST_DISTRIBUTIONS','FORECAST_CAPITAL_CALLS','FORECAST_FACILITY_PAYDOWN',
    'POSITION_STRATEGY','POSITION_COST','POSITION_INCOME','POSITION_REALIZED_GAIN','POSITION_GROSS_IRR',
    'POSITION_MARK','POSITION_AGENT_MARK','POSITION_COUPON','POSITION_LEVERAGE','POSITION_IS_FLOATING','POSITION_MARK_RESOLVED'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('COMMITMENT_INVESTOR', 'Commitment of investor', 'INVESTOR_COMMITMENT', 'INVESTOR', 'The investor who made the commitment', 'MANY_TO_ONE', TRUE),
    ('COMMITMENT_FUND', 'Commitment to fund', 'INVESTOR_COMMITMENT', 'FUND', 'The fund the commitment is to', 'MANY_TO_ONE', TRUE),
    ('ACTIVITY_FUND', 'Activity of fund', 'CAPITAL_ACTIVITY', 'FUND', 'The fund the call or distribution belongs to', 'MANY_TO_ONE', TRUE),
    ('STATEMENT_FUND', 'Statement of fund', 'NAV_STATEMENT', 'FUND', 'The fund the NAV package reports', 'MANY_TO_ONE', TRUE),
    ('LINE_STATEMENT', 'Line of statement', 'NAV_LINE', 'NAV_STATEMENT', 'The NAV package the row belongs to', 'MANY_TO_ONE', TRUE),
    ('PLAN_FUND', 'Plan of fund', 'CAPITAL_PLAN', 'FUND', 'The fund the quarter belongs to', 'MANY_TO_ONE', TRUE),
    ('FACILITY_FUND', 'Facility of fund', 'CREDIT_FACILITY', 'FUND', 'The fund that borrows on the facility', 'MANY_TO_ONE', TRUE),
    ('FORECAST_FUND', 'Forecast of fund', 'CASH_FORECAST', 'FUND', 'The fund the quarter is forecast for', 'MANY_TO_ONE', TRUE),
    ('LIMIT_FUND', 'Limit of fund', 'EXPOSURE_LIMIT', 'FUND', 'The fund the concentration limit binds', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Intersection: a commitment is an investor x a fund
-- ============================================================

INSERT INTO metadata_register.intersection_types (intersection_code, intersection_name, description) VALUES
    ('INVESTOR_COMMITMENT', 'Investor Commitment', 'An investor''s commitment to a fund')
ON CONFLICT (intersection_code) DO NOTHING;

INSERT INTO metadata_register.intersection_type_members (intersection_type_id, domain_code, member_role, is_required, display_order)
SELECT it.id, v.domain_code, v.member_role, TRUE, v.ord
FROM metadata_register.intersection_types it
CROSS JOIN (VALUES ('INVESTOR', 'INVESTOR', 1), ('FUND', 'FUND', 2)) AS v(domain_code, member_role, ord)
WHERE it.intersection_code = 'INVESTOR_COMMITMENT'
ON CONFLICT (intersection_type_id, member_role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
