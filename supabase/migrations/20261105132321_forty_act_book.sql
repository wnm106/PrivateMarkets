-- Rules, sample book, and the scorecard check for the 1940 Act guidelines.
-- Harbor Senior Income (HALY-FUND-HSI). Assets equal the fund's published NAV.

-- ============================================================
-- 1. Rules
-- ============================================================

INSERT INTO compliance.rules (
    rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description, metadata
) VALUES
    ('ACT40_NO_MARGIN', 'No Margin Purchases', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. A margin purchase is a hard block.',
     '{"guideline":1,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_NO_SHORT', 'No Short Sales', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. A short sale is a hard block unless the fund is explicitly exempt.',
     '{"guideline":2,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_NO_PHYSICAL', 'Real Estate and Commodities Restriction', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. A buy of physical real estate or a physical commodity is a hard block.',
     '{"guideline":3,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_ASSET_COVERAGE', 'Borrowing and Senior Securities (300% Coverage)', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade and end of day. Coverage is (assets + new borrowing) / (debt + new borrowing). Below 3.0 is a hard block.',
     '{"guideline":4,"timing":"PRE_TRADE_AND_EOD"}'::jsonb),
    ('ACT40_UNDERWRITING', 'Underwriting Limits', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. An underwriting buy larger than the fund max underwriting percent is a hard block.',
     '{"guideline":5,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_ISSUER_5_25', 'Diversified Fund: 5% Issuer Cap', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade, diversified funds only. An issuer may exceed 5 percent of assets only while the excess of every such issuer still fits inside 25 percent of assets.',
     '{"guideline":6,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_VOTING_10', 'Diversified Fund: 10% Voting Stock Cap', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. Shares held divided by the issuer voting shares outstanding may not exceed 10 percent.',
     '{"guideline":7,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_SRI_5', '5% Securities-Related Issuer Limit', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. A broker-dealer or adviser issuer may not exceed 5 percent of assets.',
     '{"guideline":8,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_CROSS_OWNERSHIP', '3% Cross-Ownership Cap', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. Ownership of another investment company voting stock may not exceed 3 percent.',
     '{"guideline":9,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_FOF_LIMIT', 'Fund-of-Funds Aggregate Limit (Rule 12d1-4)', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. Investment-company holdings in aggregate may not exceed 10 percent of assets.',
     '{"guideline":10,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_NAME_80', '80% Naming Policy (Rule 35d-1)', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'End of day. Holdings that match the fund name (Senior or Income: senior loans and income securities) must be at least 80 percent of assets.',
     '{"guideline":11,"timing":"EOD"}'::jsonb),
    ('ACT40_FAIR_VALUE', 'Fair Value Pricing Check (Rule 2a-5)', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade and daily. A manual price, or a price older than 24 hours, is fair-valued and blocks the order until a supervisor approves it.',
     '{"guideline":12,"timing":"PRE_TRADE_AND_DAILY"}'::jsonb),
    ('ACT40_DERIVATIVES_VAR', 'Derivatives Risk Max VaR (Rule 18f-4)', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'End of day. Utilization is the worse of absolute VaR over 20 percent and relative VaR over 200 percent of the reference index. Above 1 is a critical risk alert.',
     '{"guideline":13,"timing":"EOD"}'::jsonb),
    ('ACT40_BOARD', 'Independent Board Composition', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'System. Independent directors must be at least 40 percent of the board, or the fund cannot be activated for trading.',
     '{"guideline":14,"timing":"SYSTEM"}'::jsonb),
    ('ACT40_AFFILIATED', 'Affiliated Transactions Block', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. A buy or sell with an affiliated counterparty is a hard block.',
     '{"guideline":15,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_CUSTODIAN', 'Eligible Custodian Check', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Pre-trade. An order routed through a custodian that is not an eligible bank or exchange is a hard block.',
     '{"guideline":16,"timing":"PRE_TRADE"}'::jsonb),
    ('ACT40_ADVISORY_RENEWAL', 'Advisory Fee Renewal Safeguard', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'System. Once the as-of date passes the advisory contract renewal date, trading status is Suspended and the lapse is a hard block.',
     '{"guideline":17,"timing":"SYSTEM"}'::jsonb),
    ('ACT40_SEED_CAPITAL', 'Minimum Seed Capital Verification', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'System. A public offering whose initial net worth is under $100,000 cannot be set to Active.',
     '{"guideline":18,"timing":"SYSTEM"}'::jsonb),
    ('ACT40_12B1_FEE', 'Rule 12b-1 Distribution Fee Cap', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Post-trade. Annualized distribution fees (year-to-date fees times 12/9 at September 30) over net assets may not exceed 0.75 percent.',
     '{"guideline":19,"timing":"POST_TRADE"}'::jsonb),
    ('ACT40_AUDIT_TRAIL', 'Recordkeeping Audit Trail', 'FORTY_ACT', 'FUND', FALSE, TRUE,
     'Event. Every order action writes an immutable snapshot kept for six years. The rule fails if any order has no snapshot.',
     '{"guideline":20,"timing":"EVENT"}'::jsonb)
ON CONFLICT (rule_code) DO UPDATE
SET rule_name = EXCLUDED.rule_name,
    rule_category = EXCLUDED.rule_category,
    description = EXCLUDED.description,
    metadata = EXCLUDED.metadata,
    applies_to_all = FALSE,
    is_active = TRUE,
    anchor_domain_code = EXCLUDED.anchor_domain_code;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, description, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope, denominator_source,
    limit_direction, soft_limit_value, hard_limit_value,
    hard_limit_attribute_code, soft_limit_factor,
    result_unit, metadata
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, v.descr, v.base_domain,
       v.base_path::jsonb, v.group_path::jsonb, v.group_attr,
       v.num_attr, v.num_agg,
       v.den_attr, v.den_agg, v.den_scope, v.den_source,
       v.direction, v.soft, v.hard,
       v.limit_attr, v.soft_factor,
       v.unit, v.meta::jsonb
FROM compliance.rules r
JOIN (VALUES
    ('ACT40_NO_MARGIN', 'Count of margin purchases. Any one is a hard block. None is a pass.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'ESTIMATED_VALUE', 'COUNT', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{"pass_if_empty":true}'),
    ('ACT40_NO_SHORT', 'Count of short sales. Any one is a hard block unless the fund is exempt.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'ESTIMATED_VALUE', 'COUNT', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{"pass_if_empty":true}'),
    ('ACT40_NO_PHYSICAL', 'Count of buys of physical real estate or physical commodities.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'ESTIMATED_VALUE', 'COUNT', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{"pass_if_empty":true}'),
    ('ACT40_ASSET_COVERAGE', 'Assets plus new borrowing, divided by debt plus that same borrowing.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'ESTIMATED_VALUE', 'SUM', 'TOTAL_DEBT', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MIN', 3.5::numeric, 3::numeric, NULL::varchar, NULL::numeric, 'RATIO',
     '{"logic":"asset_coverage","assets_attribute":"TOTAL_AUM","debt_attribute":"TOTAL_DEBT","addend_attribute":"ESTIMATED_VALUE"}'),
    ('ACT40_UNDERWRITING', 'Each underwriting buy as a percent of assets, against the fund cap.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', 'ORDER_LABEL',
     'ESTIMATED_VALUE', 'VALUE', 'TOTAL_AUM', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', NULL::numeric, 5::numeric, 'MAX_UNDERWRITE_PCT', 0.8::numeric, 'PERCENTAGE', '{"pass_if_empty":true}'),
    ('ACT40_ISSUER_5_25', 'Issuer value over assets. Excess above 5 percent must total 25 percent or less.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]',
     'ISSUER_LEGAL_NAME',
     'CURRENT_VALUE', 'SUM', 'TOTAL_AUM', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', NULL::numeric, 5::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE',
     '{"exception_basket":{"per_group_limit":5,"basket_limit":25}}'),
    ('ACT40_VOTING_10', 'Shares held over the security voting shares outstanding.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]',
     'SECURITY_ISSUER_NAME',
     'SHARES_HELD', 'SUM', 'VOTING_SHARES_OUTSTANDING', 'VALUE', 'SAME_GROUP', 'GROUP',
     'MAX', 8::numeric, 10::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{}'),
    ('ACT40_SRI_5', 'Broker-dealer and adviser issuers as a percent of assets.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]',
     'ISSUER_LEGAL_NAME',
     'CURRENT_VALUE', 'SUM', 'TOTAL_AUM', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', 4::numeric, 5::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{"pass_if_empty":true}'),
    ('ACT40_CROSS_OWNERSHIP', 'Shares of another investment company over its voting shares outstanding.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]',
     'SECURITY_ISSUER_NAME',
     'SHARES_HELD', 'SUM', 'VOTING_SHARES_OUTSTANDING', 'VALUE', 'SAME_GROUP', 'GROUP',
     'MAX', 2.5::numeric, 3::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{"pass_if_empty":true}'),
    ('ACT40_FOF_LIMIT', 'Aggregate investment-company value over assets.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'CURRENT_VALUE', 'SUM', 'TOTAL_AUM', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', 8::numeric, 10::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{"pass_if_empty":true}'),
    ('ACT40_NAME_80', 'Senior-loan and income-security value over assets. The fund name is Harbor Senior Income.',
     'POSITION', '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'CURRENT_VALUE', 'SUM', 'TOTAL_AUM', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MIN', 85::numeric, 80::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{}'),
    ('ACT40_FAIR_VALUE', '1 when a security is manual or more than 24 hours stale and has no supervisor override.',
     'SECURITY',
     '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false},{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]',
     '[]', 'SECURITY_LABEL',
     'FAIR_VALUE_BLOCK', 'VALUE', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{}'),
    ('ACT40_DERIVATIVES_VAR', 'Worse of absolute VaR / 20 percent and relative VaR / 200 percent.',
     'FUND', '[]', '[]', NULL,
     'VAR_LIMIT_UTILIZATION', 'VALUE', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', 0.9::numeric, 1::numeric, NULL::varchar, NULL::numeric, 'RATIO', '{}'),
    ('ACT40_BOARD', 'Independent directors divided by board members.',
     'FUND', '[]', '[]', NULL,
     'INDEPENDENT_MEMBER_COUNT', 'VALUE', 'BOARD_MEMBER_COUNT', 'VALUE', 'SAME_GROUP', 'BASE',
     'MIN', 0.50::numeric, 0.40::numeric, NULL::varchar, NULL::numeric, 'RATIO', '{}'),
    ('ACT40_AFFILIATED', 'Count of buys and sells with an affiliated counterparty.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'ESTIMATED_VALUE', 'COUNT', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{"pass_if_empty":true}'),
    ('ACT40_CUSTODIAN', 'Count of accounts whose custodian is not an eligible bank or exchange.',
     'ACCOUNT', '[{"relationship_code":"ACCOUNT_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'CUSTODIAN_ID', 'COUNT', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{"pass_if_empty":true}'),
    ('ACT40_ADVISORY_RENEWAL', '1 when the as-of date is past the advisory contract renewal date.',
     'FUND', '[]', '[]', NULL,
     'CONTRACT_LAPSED', 'VALUE', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, 0::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{}'),
    ('ACT40_SEED_CAPITAL', 'Initial net worth of a public offering. The floor is $100,000.',
     'FUND', '[]', '[]', NULL,
     'INITIAL_NET_WORTH', 'VALUE', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MIN', 120000::numeric, 100000::numeric, NULL::varchar, NULL::numeric, 'CURRENCY', '{}'),
    ('ACT40_12B1_FEE', 'Annualized distribution fees as a percent of net assets.',
     'FUND', '[]', '[]', NULL,
     'ANNUALIZED_DISTRIBUTION_FEES', 'VALUE', 'FUND_NET_ASSETS', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', 0.60::numeric, 0.75::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE', '{}'),
    ('ACT40_AUDIT_TRAIL', 'Smallest audit-snapshot count on the fund orders. Each order needs at least one.',
     'ORDER', '[{"relationship_code":"ORDER_FUND","direction":"UP","recursive":false}]', '[]', NULL,
     'AUDIT_EVENT_COUNT', 'MIN', NULL, NULL, 'SAME_GROUP', 'BASE',
     'MIN', NULL::numeric, 1::numeric, NULL::varchar, NULL::numeric, 'COUNT', '{}')
) AS v(code, descr, base_domain, base_path, group_path, group_attr, num_attr, num_agg, den_attr, den_agg, den_scope, den_source, direction, soft, hard, limit_attr, soft_factor, unit, meta)
  ON v.code = r.rule_code
ON CONFLICT (rule_id, version_number) DO UPDATE
SET description = EXCLUDED.description,
    base_domain_code = EXCLUDED.base_domain_code,
    base_rollup_path = EXCLUDED.base_rollup_path,
    group_by_path = EXCLUDED.group_by_path,
    group_by_attribute_code = EXCLUDED.group_by_attribute_code,
    numerator_attribute_code = EXCLUDED.numerator_attribute_code,
    numerator_aggregation = EXCLUDED.numerator_aggregation,
    denominator_attribute_code = EXCLUDED.denominator_attribute_code,
    denominator_aggregation = EXCLUDED.denominator_aggregation,
    denominator_scope = EXCLUDED.denominator_scope,
    denominator_source = EXCLUDED.denominator_source,
    limit_direction = EXCLUDED.limit_direction,
    soft_limit_value = EXCLUDED.soft_limit_value,
    hard_limit_value = EXCLUDED.hard_limit_value,
    hard_limit_attribute_code = EXCLUDED.hard_limit_attribute_code,
    soft_limit_factor = EXCLUDED.soft_limit_factor,
    result_unit = EXCLUDED.result_unit,
    metadata = EXCLUDED.metadata,
    rule_name = EXCLUDED.rule_name;

DELETE FROM compliance.rule_conditions c
USING compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id
WHERE c.rule_version_id = rv.id
  AND r.rule_code LIKE 'ACT40_%'
  AND rv.version_number = 1;

INSERT INTO compliance.rule_conditions (
    rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, value, logic_operator, attribute_dimension
)
SELECT rv.id, v.applies, v.grp, v.ord, v.attr, v.op, v.val, 'AND', v.dim::jsonb
FROM compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id AND rv.version_number = 1
JOIN (VALUES
    ('ACT40_NO_MARGIN', 'BASE', 1, 1, 'TRANSACTION_TYPE', 'equals', 'Margin_Purchase', '{}'),
    ('ACT40_NO_SHORT', 'ANCHOR', 1, 1, 'SHORT_SALE_EXEMPT', 'not_equals', 'true', '{}'),
    ('ACT40_NO_SHORT', 'BASE', 1, 1, 'TRANSACTION_TYPE', 'equals', 'Short_Sale', '{}'),
    ('ACT40_NO_PHYSICAL', 'BASE', 1, 1, 'TRANSACTION_TYPE', 'equals', 'Buy', '{}'),
    ('ACT40_NO_PHYSICAL', 'BASE', 1, 2, 'ASSET_CLASS', 'in', '["Physical_Real_Estate","Physical_Commodity"]',
     '{"relationship_path":[{"relationship_code":"ORDER_SECURITY","direction":"DOWN","recursive":false}]}'),
    ('ACT40_ASSET_COVERAGE', 'BASE', 1, 1, 'TRANSACTION_TYPE', 'equals', 'Borrow', '{}'),
    ('ACT40_UNDERWRITING', 'BASE', 1, 1, 'TRANSACTION_TYPE', 'equals', 'Buy', '{}'),
    ('ACT40_UNDERWRITING', 'BASE', 1, 2, 'IS_UNDERWRITING_ALLOCATION', 'equals', 'true', '{}'),
    ('ACT40_ISSUER_5_25', 'ANCHOR', 1, 1, 'IS_DIVERSIFIED', 'equals', 'true', '{}'),
    ('ACT40_SRI_5', 'BASE', 1, 1, 'ISSUER_INDUSTRY_SECTOR', 'equals', 'Broker_Dealer_Advisor',
     '{"relationship_path":[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]}'),
    ('ACT40_CROSS_OWNERSHIP', 'BASE', 1, 1, 'IS_INVESTMENT_COMPANY', 'equals', 'true',
     '{"relationship_path":[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]}'),
    ('ACT40_FOF_LIMIT', 'BASE', 1, 1, 'IS_INVESTMENT_COMPANY', 'equals', 'true',
     '{"relationship_path":[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]}'),
    ('ACT40_NAME_80', 'BASE', 1, 1, 'ASSET_CLASS', 'in', '["Senior_Loan","Income_Security"]',
     '{"relationship_path":[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]}'),
    ('ACT40_AFFILIATED', 'BASE', 1, 1, 'IS_AFFILIATED_ENTITY', 'equals', 'true',
     '{"relationship_path":[{"relationship_code":"ORDER_COUNTERPARTY","direction":"DOWN","recursive":false}]}'),
    ('ACT40_AFFILIATED', 'BASE', 1, 2, 'TRANSACTION_TYPE', 'in', '["Buy","Sell"]', '{}'),
    ('ACT40_CUSTODIAN', 'BASE', 1, 1, 'IS_ELIGIBLE_BANK_EXCHANGE', 'equals', 'false',
     '{"relationship_path":[{"relationship_code":"ACCOUNT_CUSTODIAN","direction":"DOWN","recursive":false}]}'),
    ('ACT40_SEED_CAPITAL', 'ANCHOR', 1, 1, 'IS_PUBLIC_OFFERING', 'equals', 'true', '{}')
) AS v(code, applies, grp, ord, attr, op, val, dim) ON v.code = r.rule_code;

-- ============================================================
-- 2. Sample book on Harbor Senior Income
-- ============================================================

DO $$
DECLARE
    v_fund UUID;
    v_sleeve UUID;
    v_client UUID;
    v_src UUID;
    v_aum NUMERIC := 2000000000;
    v_asof DATE := DATE '2026-09-30';
    v_renewal DATE := DATE '2026-06-30';
    v_fees NUMERIC;
    v_annual NUMERIC;
    v_util NUMERIC;
    v_event TIMESTAMPTZ := TIMESTAMPTZ '2026-09-30 15:00:00+00';
    v_order UUID;
    v_trade UUID;
    v_snap JSONB;
    v_action TEXT;
BEGIN
    SELECT id, client_id INTO v_fund, v_client
    FROM entity_instances.master_entities
    WHERE entity_code = 'HALY-FUND-HSI';
    IF v_fund IS NULL THEN
        RAISE EXCEPTION 'HALY-FUND-HSI (Harbor Senior Income) was not found';
    END IF;
    SELECT id INTO v_sleeve FROM entity_instances.master_entities WHERE entity_code = 'HALY-FUND-HSI-INST';
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;
    SELECT id INTO v_src FROM entity_instances.source_registry WHERE source_code = 'MANUAL';
    IF v_src IS NULL THEN
        SELECT id INTO v_src FROM entity_instances.source_registry WHERE source_code = 'TEST';
    END IF;
    IF v_src IS NULL THEN
        RAISE EXCEPTION 'No MANUAL or TEST source is registered';
    END IF;

    v_fees := v_aum * 0.006;
    v_annual := v_fees * 12 / 9;
    v_util := greatest(0.22 / 0.20, 150.0 / 200.0);

    CREATE TEMP TABLE t_pos (
        key TEXT, name TEXT, asset_class TEXT, sector TEXT, weight NUMERIC,
        shares NUMERIC, outstanding NUMERIC, is_ic BOOLEAN,
        price_source TEXT, price_age NUMERIC, approved BOOLEAN, notional NUMERIC
    ) ON COMMIT DROP;

    INSERT INTO t_pos VALUES
        ('apex', 'Apex Industries', 'Senior_Loan', 'Corporate', 0.20, 1200000, 10000000, FALSE, 'Market', 2, FALSE, 100000000),
        ('birch', 'Birch Manufacturing', 'Senior_Loan', 'Corporate', 0.18, 400000, 10000000, FALSE, 'Manual', 2, TRUE, 0),
        ('cedar', 'Cedar Markets', 'Equity', 'Broker_Dealer_Advisor', 0.06, 100000, 10000000, FALSE, 'Market', 30, FALSE, 0),
        ('delta', 'Delta Opportunities Fund', 'Investment_Company', 'Fund', 0.07, 400000, 10000000, TRUE, 'Market', 1, FALSE, 0),
        ('echo', 'Echo Balanced Fund', 'Investment_Company', 'Fund', 0.05, 200000, 10000000, TRUE, 'Market', 1, FALSE, 0);
    INSERT INTO t_pos
    SELECT 'inc' || lpad(g::text, 2, '0'), 'Harbor Income ' || lpad(g::text, 2, '0'),
           'Senior_Loan', 'Corporate', 0.04, 100000, 10000000, FALSE, 'Market', 1, FALSE, 0
    FROM generate_series(1, 11) AS g;

    IF (SELECT round(SUM(weight), 6) FROM t_pos) <> 1 THEN
        RAISE EXCEPTION 'Sample weights sum to %, not 1', (SELECT SUM(weight) FROM t_pos);
    END IF;

    CREATE TEMP TABLE t_ord (
        key TEXT, label TEXT, txn TEXT, weight NUMERIC, underwriting BOOLEAN,
        sec_key TEXT, cp_key TEXT, acct_key TEXT, status TEXT
    ) ON COMMIT DROP;
    INSERT INTO t_ord VALUES
        ('margin', 'Margin purchase', 'Margin_Purchase', 0.01, FALSE, NULL, NULL, NULL, 'BLOCKED'),
        ('short', 'Short sale', 'Short_Sale', 0.01, FALSE, NULL, NULL, NULL, 'BLOCKED'),
        ('re', 'Physical real estate buy', 'Buy', 0.01, FALSE, 're', NULL, NULL, 'BLOCKED'),
        ('borrow', 'New borrowing', 'Borrow', 0.25, FALSE, NULL, NULL, NULL, 'BLOCKED'),
        ('uwbig', 'Large underwriting', 'Buy', 0.08, TRUE, 'apex', 'clean', 'ok', 'BLOCKED'),
        ('uwok', 'Small underwriting', 'Buy', 0.02, TRUE, 'birch', 'clean', 'ok', 'CLEAR'),
        ('affil', 'Affiliated buy', 'Buy', 0.01, FALSE, 'apex', 'affil', 'ok', 'BLOCKED'),
        ('clean', 'Clean senior loan buy', 'Buy', 0.01, FALSE, 'inc01', 'clean', 'ok', 'CLEAR');

    CREATE TEMP TABLE t_ent (entity_code TEXT, domain_code TEXT, template_code TEXT, entity_name TEXT) ON COMMIT DROP;
    INSERT INTO t_ent
    SELECT 'HSI40-ISS-' || key, 'ISSUER', 'ISSUER_STANDARD', name FROM t_pos;
    INSERT INTO t_ent VALUES ('HSI40-ISS-RE', 'ISSUER', 'ISSUER_STANDARD', 'Physical Real Estate Lot');
    INSERT INTO t_ent
    SELECT 'HSI40-SEC-' || key, 'SECURITY', 'SECURITY_STANDARD', name FROM t_pos;
    INSERT INTO t_ent VALUES ('HSI40-SEC-RE', 'SECURITY', 'SECURITY_STANDARD', 'Physical Real Estate Lot');
    INSERT INTO t_ent
    SELECT 'HSI40-POS-' || key, 'POSITION', 'POSITION_STANDARD', name FROM t_pos;
    INSERT INTO t_ent
    SELECT 'HSI40-ORD-' || key, 'ORDER', 'ORDER_STANDARD', label FROM t_ord;
    INSERT INTO t_ent VALUES
        ('HSI40-ACCT-OK', 'ACCOUNT', 'ACCOUNT_STANDARD', 'Eligible custody account'),
        ('HSI40-ACCT-BAD', 'ACCOUNT', 'ACCOUNT_STANDARD', 'Ineligible custody account'),
        ('HSI40-CUST-OK', 'CUSTODIAN', 'CUSTODIAN_STANDARD', 'Harbor Bank NA'),
        ('HSI40-CUST-BAD', 'CUSTODIAN', 'CUSTODIAN_STANDARD', 'Unregistered Lot'),
        ('HSI40-CP-CLEAN', 'COUNTERPARTY', 'COUNTERPARTY_STANDARD', 'Street Broker'),
        ('HSI40-CP-AFFIL', 'COUNTERPARTY', 'COUNTERPARTY_STANDARD', 'Harbor Affiliate'),
        ('HSI40-TRD-CLEAN', 'TRADE', 'TRADE_STANDARD', 'Clean senior loan fill');

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name,
           '40 Act sample for Harbor Senior Income.', v_client, '{"fortyAct":true}'::jsonb
    FROM t_ent e
    JOIN metadata_register.domain_templates t ON t.template_code = e.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        domain_code = EXCLUDED.domain_code,
        template_id = EXCLUDED.template_id,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    CREATE TEMP TABLE t_val (entity_code TEXT, attribute_code TEXT, val TEXT) ON COMMIT DROP;

    INSERT INTO t_val VALUES
        ('HALY-FUND-HSI', 'TOTAL_AUM', v_aum::text),
        ('HALY-FUND-HSI', 'FUND_NET_ASSETS', v_aum::text),
        ('HALY-FUND-HSI', 'TOTAL_DEBT', (v_aum * 0.20)::text),
        ('HALY-FUND-HSI', 'IS_DIVERSIFIED', 'true'),
        ('HALY-FUND-HSI', 'SHORT_SALE_EXEMPT', 'false'),
        ('HALY-FUND-HSI', 'MAX_UNDERWRITE_PCT', '5'),
        ('HALY-FUND-HSI', 'FUND_VAR', '0.22'),
        ('HALY-FUND-HSI', 'RELATIVE_VAR_PCT', '150'),
        ('HALY-FUND-HSI', 'ABSOLUTE_VAR_LIMIT', '0.20'),
        ('HALY-FUND-HSI', 'RELATIVE_VAR_LIMIT', '200'),
        ('HALY-FUND-HSI', 'VAR_LIMIT_UTILIZATION', v_util::text),
        ('HALY-FUND-HSI', 'BOARD_MEMBER_COUNT', '6'),
        ('HALY-FUND-HSI', 'INDEPENDENT_MEMBER_COUNT', '2'),
        ('HALY-FUND-HSI', 'CONTRACT_RENEWAL_DATE', v_renewal::text),
        ('HALY-FUND-HSI', 'CONTRACT_LAPSED', CASE WHEN v_asof > v_renewal THEN '1' ELSE '0' END),
        ('HALY-FUND-HSI', 'FUND_TRADING_STATUS', CASE WHEN v_asof > v_renewal THEN 'Suspended' ELSE 'Active' END),
        ('HALY-FUND-HSI', 'IS_PUBLIC_OFFERING', 'true'),
        ('HALY-FUND-HSI', 'INITIAL_NET_WORTH', '75000'),
        ('HALY-FUND-HSI', 'TOTAL_DISTRIBUTION_FEES_YTD', v_fees::text),
        ('HALY-FUND-HSI', 'ANNUALIZED_DISTRIBUTION_FEES', v_annual::text),
        ('HALY-FUND-HSI', 'FUND_NAME_POLICY_KEYWORDS', 'Senior,Income'),
        ('HALY-FUND-HSI', 'FUND_DERIVATIVE_NOTIONAL', '100000000');

    INSERT INTO t_val
    SELECT 'HSI40-ISS-' || key, x.attr, x.val
    FROM t_pos
    CROSS JOIN LATERAL (VALUES
        ('ISSUER_LEGAL_NAME', name),
        ('ISSUER_INDUSTRY_SECTOR', sector),
        ('SECTOR', sector)
    ) AS x(attr, val);

    INSERT INTO t_val
    SELECT 'HSI40-SEC-' || p.key, x.attr, x.val
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('ASSET_CLASS', p.asset_class),
        ('SECURITY_ISSUER_NAME', p.name),
        ('SECURITY_LABEL', p.name),
        ('VOTING_SHARES_OUTSTANDING', p.outstanding::text),
        ('IS_INVESTMENT_COMPANY', CASE WHEN p.is_ic THEN 'true' ELSE 'false' END),
        ('PRICE_SOURCE', p.price_source),
        ('PRICE_AGE_HOURS', p.price_age::text),
        ('LAST_PRICE_TIMESTAMP', (TIMESTAMPTZ '2026-09-30 16:00:00+00' - make_interval(hours => p.price_age::int))::text),
        ('IS_FAIR_VALUED', CASE WHEN p.price_source = 'Manual' OR p.price_age > 24 THEN 'true' ELSE 'false' END),
        ('FAIR_VALUE_OVERRIDE', CASE WHEN p.approved THEN 'true' ELSE 'false' END),
        ('FAIR_VALUE_BLOCK', CASE WHEN (p.price_source = 'Manual' OR p.price_age > 24) AND NOT p.approved THEN '1' ELSE '0' END)
    ) AS x(attr, val);

    INSERT INTO t_val VALUES
        ('HSI40-SEC-RE', 'ASSET_CLASS', 'Physical_Real_Estate'),
        ('HSI40-SEC-RE', 'SECURITY_LABEL', 'Physical Real Estate Lot'),
        ('HSI40-SEC-RE', 'SECURITY_ISSUER_NAME', 'Physical Real Estate Lot'),
        ('HSI40-SEC-RE', 'IS_INVESTMENT_COMPANY', 'false'),
        ('HSI40-ISS-RE', 'ISSUER_LEGAL_NAME', 'Physical Real Estate Lot'),
        ('HSI40-ISS-RE', 'ISSUER_INDUSTRY_SECTOR', 'Real_Estate'),
        ('HSI40-ISS-RE', 'SECTOR', 'Real_Estate');

    INSERT INTO t_val
    SELECT 'HSI40-POS-' || key, x.attr, x.val
    FROM t_pos
    CROSS JOIN LATERAL (VALUES
        ('CURRENT_VALUE', (weight * v_aum)::text),
        ('SHARES_HELD', shares::text),
        ('POSITION_NOTIONAL_VALUE', notional::text)
    ) AS x(attr, val);

    INSERT INTO t_val
    SELECT 'HSI40-ORD-' || key, x.attr, x.val
    FROM t_ord
    CROSS JOIN LATERAL (VALUES
        ('TRANSACTION_TYPE', txn),
        ('ESTIMATED_VALUE', (weight * v_aum)::text),
        ('ORDER_QUANTITY', '1000'),
        ('IS_UNDERWRITING_ALLOCATION', CASE WHEN underwriting THEN 'true' ELSE 'false' END),
        ('ORDER_LABEL', label),
        ('ORDER_COUNTERPARTY_CODE', cp_key),
        ('COMPLIANCE_STATUS', status)
    ) AS x(attr, val)
    WHERE x.val IS NOT NULL;

    INSERT INTO t_val VALUES
        ('HSI40-ACCT-OK', 'ACCOUNT_LABEL', 'Eligible custody account'),
        ('HSI40-ACCT-OK', 'CUSTODIAN_ID', 'HSI40-CUST-OK'),
        ('HSI40-ACCT-BAD', 'ACCOUNT_LABEL', 'Ineligible custody account'),
        ('HSI40-ACCT-BAD', 'CUSTODIAN_ID', 'HSI40-CUST-BAD'),
        ('HSI40-CUST-OK', 'CUSTODIAN_NAME', 'Harbor Bank NA'),
        ('HSI40-CUST-OK', 'IS_ELIGIBLE_BANK_EXCHANGE', 'true'),
        ('HSI40-CUST-BAD', 'CUSTODIAN_NAME', 'Unregistered Lot'),
        ('HSI40-CUST-BAD', 'IS_ELIGIBLE_BANK_EXCHANGE', 'false'),
        ('HSI40-CP-CLEAN', 'COUNTERPARTY_NAME', 'Street Broker'),
        ('HSI40-CP-CLEAN', 'IS_AFFILIATED_ENTITY', 'false'),
        ('HSI40-CP-AFFIL', 'COUNTERPARTY_NAME', 'Harbor Affiliate'),
        ('HSI40-CP-AFFIL', 'IS_AFFILIATED_ENTITY', 'true'),
        ('HSI40-TRD-CLEAN', 'TRADE_LABEL', 'Clean senior loan fill'),
        ('HSI40-TRD-CLEAN', 'TRADE_STATUS', 'FILLED');

    UPDATE golden_master.entity_attribute_values eav
    SET system_to = eav.system_from
    FROM entity_instances.master_entities me,
         metadata_register.attribute_register ar,
         t_val v
    WHERE eav.entity_id = me.id
      AND eav.attribute_id = ar.id
      AND me.entity_code = v.entity_code
      AND ar.attribute_code = v.attribute_code
      AND eav.system_to > eav.system_from;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND v.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND v.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"fortyAct":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code TEXT, child_code TEXT, rel_code TEXT) ON COMMIT DROP;
    INSERT INTO t_rel
    SELECT 'HSI40-POS-' || key, 'HALY-FUND-HSI', 'POSITION_FUND' FROM t_pos;
    INSERT INTO t_rel
    SELECT 'HSI40-POS-' || key, 'HSI40-SEC-' || key, 'POSITION_SECURITY' FROM t_pos;
    INSERT INTO t_rel
    SELECT 'HSI40-SEC-' || key, 'HSI40-ISS-' || key, 'SECURITY_ISSUER' FROM t_pos;
    INSERT INTO t_rel VALUES ('HSI40-SEC-RE', 'HSI40-ISS-RE', 'SECURITY_ISSUER');
    INSERT INTO t_rel
    SELECT 'HSI40-ORD-' || key, 'HALY-FUND-HSI', 'ORDER_FUND' FROM t_ord;
    INSERT INTO t_rel
    SELECT 'HSI40-ORD-' || o.key, 'HSI40-SEC-' || o.sec_key, 'ORDER_SECURITY'
    FROM t_ord o WHERE o.sec_key IS NOT NULL;
    INSERT INTO t_rel
    SELECT 'HSI40-ORD-' || o.key, 'HSI40-CP-' || upper(o.cp_key), 'ORDER_COUNTERPARTY'
    FROM t_ord o WHERE o.cp_key IS NOT NULL;
    INSERT INTO t_rel
    SELECT 'HSI40-ORD-' || o.key, 'HSI40-ACCT-' || upper(o.acct_key), 'ORDER_ACCOUNT'
    FROM t_ord o WHERE o.acct_key IS NOT NULL;
    INSERT INTO t_rel VALUES
        ('HSI40-ACCT-OK', 'HALY-FUND-HSI', 'ACCOUNT_FUND'),
        ('HSI40-ACCT-BAD', 'HALY-FUND-HSI', 'ACCOUNT_FUND'),
        ('HSI40-ACCT-OK', 'HSI40-CUST-OK', 'ACCOUNT_CUSTODIAN'),
        ('HSI40-ACCT-BAD', 'HSI40-CUST-BAD', 'ACCOUNT_CUSTODIAN'),
        ('HSI40-TRD-CLEAN', 'HSI40-ORD-CLEAN', 'TRADE_ORDER');

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, metadata
    )
    SELECT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01', '{"fortyAct":true}'::jsonb
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    WHERE NOT EXISTS (
        SELECT 1 FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = p.id
          AND er.child_entity_id = c.id
          AND er.relationship_code = r.rel_code
          AND er.valid_from = DATE '2020-01-01'
    );

    -- Audit snapshots. CREATE on every order. The clean order is then
    -- modified, routed, and filled. The margin order is cancelled.
    FOR v_order, v_snap IN
        SELECT me.id, jsonb_build_object(
            'order_code', me.entity_code,
            'order', o.label,
            'transaction_type', o.txn,
            'estimated_value', (o.weight * v_aum),
            'quantity', 1000,
            'underwriting', o.underwriting,
            'compliance_status', o.status,
            'user_id', NULL,
            'timestamp', v_event
        )
        FROM t_ord o
        JOIN entity_instances.master_entities me ON me.entity_code = 'HSI40-ORD-' || o.key
    LOOP
        PERFORM compliance.record_order_audit(v_order, NULL, 'CREATE', v_snap, NULL, v_snap->>'compliance_status', v_event);
    END LOOP;

    SELECT id INTO v_order FROM entity_instances.master_entities WHERE entity_code = 'HSI40-ORD-CLEAN';
    SELECT id INTO v_trade FROM entity_instances.master_entities WHERE entity_code = 'HSI40-TRD-CLEAN';
    v_snap := jsonb_build_object('order_code', 'HSI40-ORD-CLEAN', 'transaction_type', 'Buy', 'compliance_status', 'CLEAR', 'timestamp', v_event, 'user_id', NULL);
    FOREACH v_action IN ARRAY ARRAY['MODIFY', 'ROUTE', 'FILL'] LOOP
        PERFORM compliance.record_order_audit(
            v_order,
            CASE WHEN v_action = 'FILL' THEN v_trade ELSE NULL END,
            v_action, v_snap || jsonb_build_object('action', v_action), NULL, 'CLEAR', v_event
        );
    END LOOP;
    SELECT id INTO v_order FROM entity_instances.master_entities WHERE entity_code = 'HSI40-ORD-MARGIN';
    PERFORM compliance.record_order_audit(
        v_order, NULL, 'CANCEL',
        jsonb_build_object('order_code', 'HSI40-ORD-MARGIN', 'transaction_type', 'Margin_Purchase', 'compliance_status', 'BLOCKED', 'timestamp', v_event, 'action', 'CANCEL'),
        NULL, 'BLOCKED', v_event
    );

    BEGIN
        UPDATE compliance.compliance_audit_log
        SET compliance_status = 'MUTATED'
        WHERE id = (SELECT id FROM compliance.compliance_audit_log LIMIT 1);
        RAISE EXCEPTION 'Audit log allowed an update';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%immutable%' THEN
            RAISE;
        END IF;
    END;

    INSERT INTO t_val (entity_code, attribute_code, val)
    SELECT me.entity_code, 'AUDIT_EVENT_COUNT', count(l.id)::text
    FROM entity_instances.master_entities me
    JOIN compliance.compliance_audit_log l ON l.order_entity_id = me.id
    WHERE me.entity_code LIKE 'HSI40-ORD-%'
    GROUP BY me.entity_code;

    UPDATE golden_master.entity_attribute_values eav
    SET system_to = eav.system_from
    FROM entity_instances.master_entities me,
         metadata_register.attribute_register ar,
         t_val v
    WHERE eav.entity_id = me.id
      AND eav.attribute_id = ar.id
      AND me.entity_code = v.entity_code
      AND ar.attribute_code = 'AUDIT_EVENT_COUNT'
      AND v.attribute_code = 'AUDIT_EVENT_COUNT'
      AND eav.system_to > eav.system_from;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val, v.val::numeric,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"fortyAct":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
    WHERE v.attribute_code = 'AUDIT_EVENT_COUNT';

    INSERT INTO compliance.rule_scope_assignments (rule_id, scope_type, entity_id, include_children, notes)
    SELECT r.id, 'INCLUDE', v_fund, FALSE, '40 Act guidelines on Harbor Senior Income'
    FROM compliance.rules r
    WHERE r.rule_code LIKE 'ACT40_%'
    ON CONFLICT (rule_id, scope_type, entity_id) DO NOTHING;

    IF v_sleeve IS NOT NULL THEN
        INSERT INTO compliance.rule_scope_assignments (rule_id, scope_type, entity_id, include_children, notes)
        SELECT r.id, 'INCLUDE', v_sleeve, FALSE, 'No orders, so a prohibition with nothing to block is a pass'
        FROM compliance.rules r
        WHERE r.rule_code = 'ACT40_NO_MARGIN'
        ON CONFLICT (rule_id, scope_type, entity_id) DO NOTHING;
    END IF;
END $$;

-- ============================================================
-- 3. Evaluate, then refuse the migration if the scorecard is wrong
-- ============================================================

DO $$
DECLARE
    v_code TEXT;
    v_problems TEXT;
BEGIN
    FOREACH v_code IN ARRAY ARRAY[
        'ACT40_NO_MARGIN', 'ACT40_NO_SHORT', 'ACT40_NO_PHYSICAL', 'ACT40_ASSET_COVERAGE',
        'ACT40_UNDERWRITING', 'ACT40_ISSUER_5_25', 'ACT40_VOTING_10', 'ACT40_SRI_5',
        'ACT40_CROSS_OWNERSHIP', 'ACT40_FOF_LIMIT', 'ACT40_NAME_80', 'ACT40_FAIR_VALUE',
        'ACT40_DERIVATIVES_VAR', 'ACT40_BOARD', 'ACT40_AFFILIATED', 'ACT40_CUSTODIAN',
        'ACT40_ADVISORY_RENEWAL', 'ACT40_SEED_CAPITAL', 'ACT40_12B1_FEE', 'ACT40_AUDIT_TRAIL'
    ] LOOP
        PERFORM compliance.evaluate_rule(v_code, DATE '2026-09-30');
    END LOOP;

    CREATE TEMP TABLE t_got ON COMMIT DROP AS
    SELECT r.rule_code, me.entity_code, COALESCE(res.group_by_value, '') AS group_value,
           res.status, res.computed_value, res.numerator_value, res.denominator_value, run.run_status
    FROM compliance.rules r
    JOIN LATERAL (
        SELECT run.id, run.run_status
        FROM compliance.rule_evaluation_runs run
        WHERE run.rule_id = r.id
        ORDER BY run.started_at DESC
        LIMIT 1
    ) run ON TRUE
    JOIN compliance.rule_evaluation_results res ON res.run_id = run.id
    JOIN entity_instances.master_entities me ON me.id = res.anchor_entity_id
    WHERE r.rule_code LIKE 'ACT40_%';

    CREATE TEMP TABLE t_expect (
        rule_code TEXT, entity_code TEXT, group_value TEXT, status TEXT, expected NUMERIC
    ) ON COMMIT DROP;
    INSERT INTO t_expect VALUES
        ('ACT40_NO_MARGIN', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_NO_MARGIN', 'HALY-FUND-HSI-INST', '', 'PASS', 0),
        ('ACT40_NO_SHORT', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_NO_PHYSICAL', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_ASSET_COVERAGE', 'HALY-FUND-HSI', '', 'HARD_BREACH', 2500000000::numeric / 900000000),
        ('ACT40_UNDERWRITING', 'HALY-FUND-HSI', 'Large underwriting', 'HARD_BREACH', 8),
        ('ACT40_UNDERWRITING', 'HALY-FUND-HSI', 'Small underwriting', 'PASS', 2),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Apex Industries', 'HARD_BREACH', 20),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Birch Manufacturing', 'HARD_BREACH', 18),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Cedar Markets', 'HARD_BREACH', 6),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Delta Opportunities Fund', 'HARD_BREACH', 7),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Echo Balanced Fund', 'PASS', 5),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Harbor Income 01', 'PASS', 4),
        ('ACT40_ISSUER_5_25', 'HALY-FUND-HSI', 'Exception basket', 'HARD_BREACH', 31),
        ('ACT40_VOTING_10', 'HALY-FUND-HSI', 'Apex Industries', 'HARD_BREACH', 12),
        ('ACT40_VOTING_10', 'HALY-FUND-HSI', 'Birch Manufacturing', 'PASS', 4),
        ('ACT40_SRI_5', 'HALY-FUND-HSI', 'Cedar Markets', 'HARD_BREACH', 6),
        ('ACT40_CROSS_OWNERSHIP', 'HALY-FUND-HSI', 'Delta Opportunities Fund', 'HARD_BREACH', 4),
        ('ACT40_CROSS_OWNERSHIP', 'HALY-FUND-HSI', 'Echo Balanced Fund', 'PASS', 2),
        ('ACT40_FOF_LIMIT', 'HALY-FUND-HSI', '', 'HARD_BREACH', 12),
        ('ACT40_NAME_80', 'HALY-FUND-HSI', '', 'SOFT_BREACH', 82),
        ('ACT40_FAIR_VALUE', 'HALY-FUND-HSI', 'Cedar Markets', 'HARD_BREACH', 1),
        ('ACT40_FAIR_VALUE', 'HALY-FUND-HSI', 'Apex Industries', 'PASS', 0),
        ('ACT40_FAIR_VALUE', 'HALY-FUND-HSI', 'Birch Manufacturing', 'PASS', 0),
        ('ACT40_DERIVATIVES_VAR', 'HALY-FUND-HSI', '', 'HARD_BREACH', greatest(0.22 / 0.20, 150.0 / 200.0)),
        ('ACT40_BOARD', 'HALY-FUND-HSI', '', 'HARD_BREACH', 2.0 / 6.0),
        ('ACT40_AFFILIATED', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_CUSTODIAN', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_ADVISORY_RENEWAL', 'HALY-FUND-HSI', '', 'HARD_BREACH', 1),
        ('ACT40_SEED_CAPITAL', 'HALY-FUND-HSI', '', 'HARD_BREACH', 75000),
        ('ACT40_12B1_FEE', 'HALY-FUND-HSI', '', 'HARD_BREACH', 0.8),
        ('ACT40_AUDIT_TRAIL', 'HALY-FUND-HSI', '', 'PASS', 1);

    SELECT string_agg(format(
        '%s [%s] expected %s %s got %s %s',
        e.rule_code, e.group_value, e.status, round(e.expected, 4),
        COALESCE(g.status, 'MISSING'), COALESCE(round(g.computed_value, 4)::text, 'null')
    ), ' | ')
    INTO v_problems
    FROM t_expect e
    LEFT JOIN t_got g
      ON g.rule_code = e.rule_code
     AND g.entity_code = e.entity_code
     AND g.group_value = e.group_value
    WHERE g.status IS DISTINCT FROM e.status
       OR g.computed_value IS NULL
       OR round(g.computed_value, 4) IS DISTINCT FROM round(e.expected, 4)
       OR g.run_status IS DISTINCT FROM 'COMPLETED';

    IF v_problems IS NOT NULL THEN
        RAISE EXCEPTION '40 Act scorecard failed: %', v_problems;
    END IF;

    IF EXISTS (
        SELECT 1 FROM compliance.compliance_audit_log
        WHERE retain_until <> event_at + INTERVAL '6 years'
    ) THEN
        RAISE EXCEPTION 'Audit retention is not six years';
    END IF;

    IF (SELECT count(DISTINCT action) FROM compliance.compliance_audit_log l
        JOIN entity_instances.master_entities me ON me.id = l.order_entity_id
        WHERE me.entity_code LIKE 'HSI40-ORD-%') <> 5 THEN
        RAISE EXCEPTION 'Audit log is missing one of CREATE, MODIFY, ROUTE, FILL, CANCEL';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM golden_master.entity_attribute_values eav
        JOIN entity_instances.master_entities me ON me.id = eav.entity_id
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        WHERE me.entity_code LIKE 'HSI40-SEC-%'
          AND me.entity_code <> 'HSI40-SEC-RE'
          AND ar.attribute_code = 'FAIR_VALUE_BLOCK'
          AND eav.system_to > eav.system_from
          AND eav.golden_value IS DISTINCT FROM (
              SELECT CASE
                  WHEN src.golden_value = 'Manual' OR age.golden_value_numeric > 24 THEN
                      CASE WHEN ov.golden_value = 'true' THEN '0' ELSE '1' END
                  ELSE '0'
              END
              FROM golden_master.entity_attribute_values src
              JOIN metadata_register.attribute_register sa ON sa.id = src.attribute_id AND sa.attribute_code = 'PRICE_SOURCE'
              JOIN golden_master.entity_attribute_values age ON age.entity_id = eav.entity_id
              JOIN metadata_register.attribute_register aa ON aa.id = age.attribute_id AND aa.attribute_code = 'PRICE_AGE_HOURS'
              JOIN golden_master.entity_attribute_values ov ON ov.entity_id = eav.entity_id
              JOIN metadata_register.attribute_register oa ON oa.id = ov.attribute_id AND oa.attribute_code = 'FAIR_VALUE_OVERRIDE'
              WHERE src.entity_id = eav.entity_id
                AND src.system_to > src.system_from
                AND age.system_to > age.system_from
                AND ov.system_to > ov.system_from
          )
    ) THEN
        RAISE EXCEPTION 'Fair-value block does not match the manual-or-stale rule';
    END IF;
END $$;
