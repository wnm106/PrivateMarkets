-- The NAV pack: everything an administrator's quarter-end pack holds, so the
-- NAV reconciliation can check each part of it (docs/NAV_PACK.md).
--
-- The statements, the schedule of investments, fees, the waterfall and capital
-- activity already have a home. This adds what did not:
--
--   TRIAL_BALANCE_LINE  one ledger account of a fund at a period end
--   CAPITAL_ACCOUNT     one investor's capital account in a fund for a period (the PCAP)
--   VALUATION_SUPPORT   a valuation document's conclusion for one position
--   FX_TRANSLATION      one currency's translation, gains and hedging in a fund's pack
--
-- plus the fund's base currency, the pack components a fund must have, a
-- management fee step-down, valuation coverage and FX tolerances, a flag for
-- the notes to the financial statements, two capital activity states, and the
-- column headings packs use for these fields. Metadata only: no records.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('TRIAL_BALANCE_LINE', 'Trial Balance Line', 'One ledger account of a fund at a period end, as the administrator''s trial balance gives it'),
    ('CAPITAL_ACCOUNT', 'Capital Account', 'One investor''s capital account in a fund for one period: the partner capital account statement (PCAP)'),
    ('VALUATION_SUPPORT', 'Valuation Support', 'A valuation report, memo or model output for one position at a date, and the value it concludes'),
    ('FX_TRANSLATION', 'FX Translation', 'One currency in a fund''s pack at a period end: the rate applied, the exposure, the FX gains and the hedging')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('TRIAL_BALANCE_LINE', 'FUNDS', 24, 'FUND'),
    ('CAPITAL_ACCOUNT', 'FUNDS', 25, 'FUND'),
    ('VALUATION_SUPPORT', 'FUNDS', 26, 'POSITION'),
    ('FX_TRANSLATION', 'FUNDS', 27, 'FUND')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('TB_ACCOUNT_CLASS', 'Account Class', 'TRIAL_BALANCE_LINE', 'Where a ledger account sits: assets, liabilities, capital, income, expenses, or gains and losses'),
    ('VALUATION_SOURCE', 'Valuation Source', 'VALUATION_SUPPORT', 'Who produced the valuation'),
    ('VALUATION_METHOD', 'Valuation Method', 'VALUATION_SUPPORT', 'How the value was reached'),
    ('NAV_PACK_COMPONENT', 'NAV Pack Component', 'FUND', 'A part of the administrator''s NAV pack the reconciliation checks')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.synonyms::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('TB_ACCOUNT_CLASS', 'ASSET', 'Asset', 1, '["Assets", "Asset accounts"]'),
    ('TB_ACCOUNT_CLASS', 'LIABILITY', 'Liability', 2, '["Liabilities", "Liability accounts"]'),
    ('TB_ACCOUNT_CLASS', 'CAPITAL', 'Capital', 3, '["Equity", "Partners'' capital", "Partners capital", "Net assets", "Members'' capital"]'),
    ('TB_ACCOUNT_CLASS', 'INCOME', 'Income', 4, '["Revenue", "Investment income", "Income accounts"]'),
    ('TB_ACCOUNT_CLASS', 'EXPENSE', 'Expense', 5, '["Expenses", "Fund expenses", "Expense accounts"]'),
    ('TB_ACCOUNT_CLASS', 'GAIN_LOSS', 'Gain or loss', 6, '["Gains and losses", "Realized and unrealized", "Gain/loss", "Gain / loss"]'),
    ('VALUATION_SOURCE', 'THIRD_PARTY', 'Third-party valuation report', 1, '["Third party", "Third-party", "Independent valuation", "Valuation agent"]'),
    ('VALUATION_SOURCE', 'GP_MEMO', 'GP valuation memo', 2, '["GP memo", "Manager memo", "Valuation memo", "Internal memo"]'),
    ('VALUATION_SOURCE', 'MODEL', 'Model output', 3, '["Model", "Internal model"]'),
    ('VALUATION_SOURCE', 'COMPARABLES', 'Comparable company analysis', 4, '["Comparables", "Comps", "Comparable companies"]'),
    ('VALUATION_SOURCE', 'BROKER_QUOTE', 'Broker or dealer quote', 5, '["Broker quote", "Dealer quote", "Pricing service"]'),
    ('VALUATION_SOURCE', 'TRANSACTION', 'Recent transaction', 6, '["Transaction", "Recent financing"]'),
    ('VALUATION_METHOD', 'DCF', 'Discounted cash flow', 1, '["Discounted cash flow", "Income approach"]'),
    ('VALUATION_METHOD', 'MARKET_MULTIPLE', 'Market multiples', 2, '["Market multiple", "EV/EBITDA", "Market approach", "Multiples"]'),
    ('VALUATION_METHOD', 'YIELD_ANALYSIS', 'Yield analysis', 3, '["Yield", "Discounted yield", "Yield method"]'),
    ('VALUATION_METHOD', 'RECENT_TRANSACTION', 'Recent transaction', 4, '["Transaction price", "Recent round"]'),
    ('VALUATION_METHOD', 'QUOTE', 'Quoted price', 5, '["Quote", "Broker quote", "Market price"]'),
    ('VALUATION_METHOD', 'COST', 'Cost', 6, '["At cost", "Cost basis"]'),
    ('VALUATION_METHOD', 'OTHER', 'Other', 7, '[]'),
    ('NAV_PACK_COMPONENT', 'NAV_BRIDGE', 'NAV summary and bridge', 1, '["NAV summary", "NAV bridge"]'),
    ('NAV_PACK_COMPONENT', 'TRIAL_BALANCE', 'Trial balance', 2, '["TB"]'),
    ('NAV_PACK_COMPONENT', 'FINANCIAL_STATEMENTS', 'Financial statements', 3, '["Financials"]'),
    ('NAV_PACK_COMPONENT', 'CAPITAL_ACCOUNTS', 'Capital account summary', 4, '["PCAP", "Partner capital accounts"]'),
    ('NAV_PACK_COMPONENT', 'MANAGEMENT_FEE', 'Management fee calculation', 5, '["Management fee"]'),
    ('NAV_PACK_COMPONENT', 'CARRIED_INTEREST', 'Carried interest and waterfall', 6, '["Carry", "Waterfall"]'),
    ('NAV_PACK_COMPONENT', 'VALUATION', 'Valuation support', 7, '["Valuation reports", "Pricing documentation"]'),
    ('NAV_PACK_COMPONENT', 'CAPITAL_ACTIVITY', 'Capital call and distribution summary', 8, '["Capital calls", "Distributions"]'),
    ('NAV_PACK_COMPONENT', 'COMMITMENTS', 'Commitments and unfunded schedule', 9, '["Unfunded commitments"]'),
    ('NAV_PACK_COMPONENT', 'FX', 'FX translation and exposure', 10, '["FX", "Foreign exchange"]')
) AS v(list_code, code, label, ord, synonyms) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- Invested capital as a fee basis after a step-down, and the two states a
-- notice is in before it settles.
INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.synonyms::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('MGMT_FEE_BASIS', 'INVESTED_CAPITAL', 'Invested capital', 4, '["Invested capital", "Cost of investments", "Net invested capital"]'),
    ('ACTIVITY_STATUS', 'ISSUED', 'Issued, not yet funded', 5, '["Issued", "Called", "Outstanding"]'),
    ('ACTIVITY_STATUS', 'DECLARED', 'Declared, not yet paid', 6, '["Declared", "Payable"]')
) AS v(list_code, code, label, ord, synonyms) ON v.list_code = rl.list_code
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
       v.list, v.multi, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       v.varying, CASE WHEN v.varying THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    -- fund settings
    ('FUND_BASE_CURRENCY', 'Base Currency', 'REFERENCE_LIST', 'The currency the fund reports its NAV in. Blank is USD.', 'FUND', 'ISO_CURRENCY', FALSE, 'Close', 3, FALSE),
    ('FUND_NAV_PACK_REQUIRED', 'NAV Pack Components Required', 'REFERENCE_LIST', 'The parts of the NAV pack the administrator must send. Listing them makes a missing part block certification. Blank: the parts the fund''s terms call for are expected, and a missing one is reported without blocking.', 'FUND', 'NAV_PACK_COMPONENT', TRUE, 'Close', 4, FALSE),
    ('FUND_MGMT_FEE_STEPDOWN_DATE', 'Management Fee Step-down Date', 'DATE', 'From this date the step-down rate and basis apply, usually the end of the investment period', 'FUND', NULL, FALSE, 'Fees', 7, FALSE),
    ('FUND_MGMT_FEE_STEPDOWN_RATE_PCT', 'Management Fee Rate After Step-down', 'PERCENTAGE', 'Annual management fee from the step-down date. Blank keeps the rate.', 'FUND', NULL, FALSE, 'Fees', 8, FALSE),
    ('FUND_MGMT_FEE_STEPDOWN_BASIS', 'Management Fee Basis After Step-down', 'REFERENCE_LIST', 'What the fee is charged on from the step-down date. Blank keeps the basis.', 'FUND', 'MGMT_FEE_BASIS', FALSE, 'Fees', 9, FALSE),
    ('FUND_VALUATION_COVERAGE_PCT', 'Valuation Support Required', 'PERCENTAGE', 'Share of investments at fair value that must have valuation support dated in the period. Blank is 100.', 'FUND', NULL, FALSE, 'Valuation', 1, FALSE),
    ('FUND_THIRD_PARTY_COVERAGE_PCT', 'Third-party Valuation Required', 'PERCENTAGE', 'Share of investments at fair value that must have a third-party valuation in the period. Blank: not checked.', 'FUND', NULL, FALSE, 'Valuation', 2, FALSE),
    ('FUND_FX_RATE_TOLERANCE_PCT', 'FX Rate Tolerance', 'PERCENTAGE', 'How far an applied FX rate may sit from the market rate at the period end. Blank is 0.25.', 'FUND', NULL, FALSE, 'Valuation', 3, FALSE),
    ('FUND_FX_HEDGE_TARGET_PCT', 'FX Hedge Target', 'PERCENTAGE', 'Share of foreign currency exposure the fund means to hedge. Blank: not checked.', 'FUND', NULL, FALSE, 'Valuation', 4, FALSE),
    -- statement
    ('STATEMENT_NOTES_INCLUDED', 'Notes Included', 'BOOLEAN', 'The pack includes the notes to the financial statements', 'NAV_STATEMENT', NULL, FALSE, 'Review', 9, TRUE),
    -- trial balance
    ('TB_PERIOD_END', 'Period End', 'DATE', 'The period end the balance is at', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Account', 1, TRUE),
    ('TB_PERIOD_START', 'Income From', 'DATE', 'The date income and expense balances run from, usually the start of the fiscal year', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Account', 2, TRUE),
    ('TB_ACCOUNT_NUMBER', 'Account Number', 'STRING', 'The ledger account number', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Account', 3, FALSE),
    ('TB_ACCOUNT_NAME', 'Account Name', 'STRING', 'The ledger account name', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Account', 4, FALSE),
    ('TB_ACCOUNT_CLASS', 'Account Class', 'REFERENCE_LIST', 'Asset, liability, capital, income, expense, or gain and loss', 'TRIAL_BALANCE_LINE', 'TB_ACCOUNT_CLASS', FALSE, 'Account', 5, FALSE),
    ('TB_DEBIT', 'Debit', 'CURRENCY', 'Debit balance', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Balance', 1, TRUE),
    ('TB_CREDIT', 'Credit', 'CURRENCY', 'Credit balance, as a positive amount', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Balance', 2, TRUE),
    ('TB_BALANCE', 'Net Balance', 'CURRENCY', 'Debit less credit. Blank: worked from the debit and credit.', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Balance', 3, TRUE),
    ('TB_NAV_LINE', 'NAV Statement Line', 'STRING', 'The NAV statement line the account rolls into, by its attribute code', 'TRIAL_BALANCE_LINE', NULL, FALSE, 'Account', 6, FALSE),
    -- capital account
    ('CAPACCT_PERIOD_END', 'Period End', 'DATE', 'The period end the account is at', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 1, TRUE),
    ('CAPACCT_OPENING', 'Opening Capital', 'CURRENCY', 'Capital at the start of the period', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 2, TRUE),
    ('CAPACCT_CONTRIBUTIONS', 'Contributions', 'CURRENCY', 'Capital contributed in the period', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 3, TRUE),
    ('CAPACCT_DISTRIBUTIONS', 'Distributions', 'CURRENCY', 'Distributions in the period, as a positive amount', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 4, TRUE),
    ('CAPACCT_PNL', 'Allocated Profit or Loss', 'CURRENCY', 'The investor''s share of the net increase from operations before carried interest, after fees and expenses', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 5, TRUE),
    ('CAPACCT_MGMT_FEE', 'Management Fee Charged', 'CURRENCY', 'Management fee charged to the investor in the period, as a positive amount. Already within the allocated profit or loss.', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Fees', 1, TRUE),
    ('CAPACCT_FEE_RATE_PCT', 'Management Fee Rate', 'PERCENTAGE', 'The investor''s annual fee rate when it differs from the fund''s', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Fees', 2, TRUE),
    ('CAPACCT_CARRY', 'Carried Interest Allocation', 'CURRENCY', 'Carried interest reallocated in the period: negative for a limited partner, positive for the general partner', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 6, TRUE),
    ('CAPACCT_CARRY_BALANCE', 'Carried Interest Balance', 'CURRENCY', 'Carried interest held in the general partner''s account at the period end', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 7, TRUE),
    ('CAPACCT_OTHER', 'Other Capital Movements', 'CURRENCY', 'Transfers and other movements in the period', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 8, TRUE),
    ('CAPACCT_CLOSING', 'Closing Capital', 'CURRENCY', 'Capital at the period end', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Capital', 9, TRUE),
    ('CAPACCT_COMMITMENT', 'Commitment', 'CURRENCY', 'The investor''s total commitment', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Commitment', 1, TRUE),
    ('CAPACCT_CONTRIBUTED_ITD', 'Contributed to Date', 'CURRENCY', 'Capital contributed since inception', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Commitment', 2, TRUE),
    ('CAPACCT_UNFUNDED', 'Unfunded Commitment', 'CURRENCY', 'Commitment not yet called', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Commitment', 3, TRUE),
    ('CAPACCT_OWNERSHIP_PCT', 'Ownership', 'PERCENTAGE', 'The investor''s share of the fund', 'CAPITAL_ACCOUNT', NULL, FALSE, 'Commitment', 4, TRUE),
    -- valuation support
    ('VALUATION_DATE', 'Valuation Date', 'DATE', 'The date the value is at', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 1, FALSE),
    ('VALUATION_SOURCE_TYPE', 'Source', 'REFERENCE_LIST', 'Third-party report, GP memo, model, comparables, quote or transaction', 'VALUATION_SUPPORT', 'VALUATION_SOURCE', FALSE, 'Valuation', 2, FALSE),
    ('VALUATION_METHOD', 'Method', 'REFERENCE_LIST', 'DCF, market multiples, yield, transaction, quote or cost', 'VALUATION_SUPPORT', 'VALUATION_METHOD', FALSE, 'Valuation', 3, FALSE),
    ('VALUATION_PROVIDER', 'Provider', 'STRING', 'Who produced it', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 4, FALSE),
    ('VALUATION_FAIR_VALUE', 'Concluded Value', 'CURRENCY', 'The fair value it concludes for the position', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 5, FALSE),
    ('VALUATION_LOW', 'Range Low', 'CURRENCY', 'Low end of the valuation range', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 6, FALSE),
    ('VALUATION_HIGH', 'Range High', 'CURRENCY', 'High end of the valuation range', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 7, FALSE),
    ('VALUATION_DOCUMENT', 'Document', 'STRING', 'The report, memo or model file', 'VALUATION_SUPPORT', NULL, FALSE, 'Valuation', 8, FALSE),
    -- FX translation
    ('FXT_PERIOD_END', 'Period End', 'DATE', 'The period end the translation is at', 'FX_TRANSLATION', NULL, FALSE, 'FX', 1, TRUE),
    ('FXT_CURRENCY', 'Currency', 'REFERENCE_LIST', 'The foreign currency', 'FX_TRANSLATION', 'ISO_CURRENCY', FALSE, 'FX', 2, FALSE),
    ('FXT_RATE_APPLIED', 'Rate Applied', 'DECIMAL', 'Units of the fund''s base currency for one unit of the currency', 'FX_TRANSLATION', NULL, FALSE, 'FX', 3, TRUE),
    ('FXT_EXPOSURE_LOCAL', 'Exposure in Currency', 'DECIMAL', 'Net assets held in the currency, in the currency', 'FX_TRANSLATION', NULL, FALSE, 'FX', 4, TRUE),
    ('FXT_EXPOSURE_BASE', 'Exposure in Base Currency', 'CURRENCY', 'The same exposure translated at the applied rate', 'FX_TRANSLATION', NULL, FALSE, 'FX', 5, TRUE),
    ('FXT_REALIZED', 'Realized FX Gain', 'CURRENCY', 'Realized FX gain or loss in the period', 'FX_TRANSLATION', NULL, FALSE, 'FX', 6, TRUE),
    ('FXT_UNREALIZED', 'Unrealized FX Gain', 'CURRENCY', 'Change in unrealized FX gain or loss in the period', 'FX_TRANSLATION', NULL, FALSE, 'FX', 7, TRUE),
    ('FXT_HEDGE_NOTIONAL', 'Hedged Notional', 'CURRENCY', 'Notional of FX hedges in the currency, in the base currency', 'FX_TRANSLATION', NULL, FALSE, 'FX', 8, TRUE),
    ('FXT_HEDGE_MTM', 'Hedge Fair Value', 'CURRENCY', 'Fair value of those hedges at the period end', 'FX_TRANSLATION', NULL, FALSE, 'FX', 9, TRUE)
) AS v(code, name, dtype, descr, dom, list, multi, section, grp, varying)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    is_multi_valued = EXCLUDED.is_multi_valued,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('TRIAL_BALANCE_LINE_STANDARD', 'Standard Trial Balance Line', 'TRIAL_BALANCE_LINE', 'One ledger account at a period end'),
    ('CAPITAL_ACCOUNT_STANDARD', 'Standard Capital Account', 'CAPITAL_ACCOUNT', 'One investor''s capital account for one period'),
    ('VALUATION_SUPPORT_STANDARD', 'Standard Valuation Support', 'VALUATION_SUPPORT', 'One valuation of one position'),
    ('FX_TRANSLATION_STANDARD', 'Standard FX Translation', 'FX_TRANSLATION', 'One currency at a period end')
ON CONFLICT (template_code) DO NOTHING;

-- The new attributes on their domain's standard template, and the fund and
-- statement settings on the templates funds and statements already use.
INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.domain_code = a.domain_code
WHERE (t.template_code = a.domain_code || '_STANDARD' OR (a.domain_code IN ('FUND', 'NAV_STATEMENT')))
  AND a.attribute_code IN (
    'FUND_BASE_CURRENCY', 'FUND_NAV_PACK_REQUIRED', 'FUND_MGMT_FEE_STEPDOWN_DATE', 'FUND_MGMT_FEE_STEPDOWN_RATE_PCT',
    'FUND_MGMT_FEE_STEPDOWN_BASIS', 'FUND_VALUATION_COVERAGE_PCT', 'FUND_THIRD_PARTY_COVERAGE_PCT',
    'FUND_FX_RATE_TOLERANCE_PCT', 'FUND_FX_HEDGE_TARGET_PCT', 'STATEMENT_NOTES_INCLUDED',
    'TB_PERIOD_END', 'TB_PERIOD_START', 'TB_ACCOUNT_NUMBER', 'TB_ACCOUNT_NAME', 'TB_ACCOUNT_CLASS', 'TB_DEBIT', 'TB_CREDIT', 'TB_BALANCE', 'TB_NAV_LINE',
    'CAPACCT_PERIOD_END', 'CAPACCT_OPENING', 'CAPACCT_CONTRIBUTIONS', 'CAPACCT_DISTRIBUTIONS', 'CAPACCT_PNL', 'CAPACCT_MGMT_FEE',
    'CAPACCT_FEE_RATE_PCT', 'CAPACCT_CARRY', 'CAPACCT_CARRY_BALANCE', 'CAPACCT_OTHER', 'CAPACCT_CLOSING', 'CAPACCT_COMMITMENT',
    'CAPACCT_CONTRIBUTED_ITD', 'CAPACCT_UNFUNDED', 'CAPACCT_OWNERSHIP_PCT',
    'VALUATION_DATE', 'VALUATION_SOURCE_TYPE', 'VALUATION_METHOD', 'VALUATION_PROVIDER', 'VALUATION_FAIR_VALUE',
    'VALUATION_LOW', 'VALUATION_HIGH', 'VALUATION_DOCUMENT',
    'FXT_PERIOD_END', 'FXT_CURRENCY', 'FXT_RATE_APPLIED', 'FXT_EXPOSURE_LOCAL', 'FXT_EXPOSURE_BASE', 'FXT_REALIZED',
    'FXT_UNREALIZED', 'FXT_HEDGE_NOTIONAL', 'FXT_HEDGE_MTM'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('TB_LINE_FUND', 'Trial balance line of fund', 'TRIAL_BALANCE_LINE', 'FUND', 'The fund whose ledger the account is in', 'MANY_TO_ONE', TRUE),
    ('CAPACCT_FUND', 'Capital account in fund', 'CAPITAL_ACCOUNT', 'FUND', 'The fund the capital account is in', 'MANY_TO_ONE', TRUE),
    ('CAPACCT_INVESTOR', 'Capital account of investor', 'CAPITAL_ACCOUNT', 'INVESTOR', 'The investor whose account it is', 'MANY_TO_ONE', FALSE),
    ('VALUATION_POSITION', 'Valuation of position', 'VALUATION_SUPPORT', 'POSITION', 'The position the valuation supports', 'MANY_TO_ONE', TRUE),
    ('FXT_FUND', 'FX translation of fund', 'FX_TRANSLATION', 'FUND', 'The fund whose pack the translation is in', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Column headings packs use
-- ============================================================

INSERT INTO metadata_register.attribute_aliases (attribute_id, alias_label, alias_code, domain_code, match_kind, confidence)
SELECT a.id, v.label, upper(regexp_replace(btrim(v.label), '[^A-Za-z0-9]+', '_', 'g')), a.domain_code, 'semantic', 0.950
FROM (VALUES
    ('TB_ACCOUNT_NUMBER', 'Account'), ('TB_ACCOUNT_NUMBER', 'Account No'), ('TB_ACCOUNT_NUMBER', 'GL Account'),
    ('TB_ACCOUNT_NAME', 'Account Description'),
    ('TB_ACCOUNT_CLASS', 'Account Type'), ('TB_ACCOUNT_CLASS', 'Account Category'),
    ('TB_DEBIT', 'Debits'), ('TB_DEBIT', 'Dr'), ('TB_CREDIT', 'Credits'), ('TB_CREDIT', 'Cr'),
    ('TB_BALANCE', 'Net Balance'), ('TB_BALANCE', 'Ending GL Balance'),
    ('CAPACCT_OPENING', 'Beginning Capital'), ('CAPACCT_OPENING', 'Opening Balance'), ('CAPACCT_OPENING', 'Beginning Balance'),
    ('CAPACCT_CONTRIBUTIONS', 'Capital Contributions'), ('CAPACCT_DISTRIBUTIONS', 'Capital Distributions'),
    ('CAPACCT_PNL', 'Allocation of Profit/Loss'), ('CAPACCT_PNL', 'Net Income Allocation'), ('CAPACCT_PNL', 'Allocated Income'),
    ('CAPACCT_MGMT_FEE', 'Management Fee'), ('CAPACCT_CARRY', 'Carried Interest'), ('CAPACCT_CARRY', 'Carried Interest Reallocation'),
    ('CAPACCT_CLOSING', 'Ending Capital'), ('CAPACCT_CLOSING', 'Closing Balance'), ('CAPACCT_CLOSING', 'Ending Balance'),
    ('CAPACCT_COMMITMENT', 'Total Commitment'), ('CAPACCT_COMMITMENT', 'Commitment Amount'),
    ('CAPACCT_CONTRIBUTED_ITD', 'Contributions to Date'), ('CAPACCT_CONTRIBUTED_ITD', 'Cumulative Contributions'),
    ('CAPACCT_UNFUNDED', 'Unfunded'), ('CAPACCT_UNFUNDED', 'Remaining Commitment'), ('CAPACCT_UNFUNDED', 'Unfunded Commitment'),
    ('CAPACCT_OWNERSHIP_PCT', 'Ownership %'), ('CAPACCT_OWNERSHIP_PCT', 'Percentage Interest'), ('CAPACCT_OWNERSHIP_PCT', 'Pro Rata Share'),
    ('VALUATION_FAIR_VALUE', 'Concluded Fair Value'), ('VALUATION_FAIR_VALUE', 'Point Estimate'),
    ('VALUATION_LOW', 'Valuation Low'), ('VALUATION_HIGH', 'Valuation High'), ('VALUATION_PROVIDER', 'Valuation Agent'),
    ('FXT_RATE_APPLIED', 'FX Rate'), ('FXT_RATE_APPLIED', 'Exchange Rate'), ('FXT_RATE_APPLIED', 'Spot Rate'),
    ('FXT_REALIZED', 'Realized FX'), ('FXT_UNREALIZED', 'Unrealized FX'), ('FXT_HEDGE_NOTIONAL', 'Hedge Notional'),
    ('FXT_HEDGE_MTM', 'Forward MTM'), ('FXT_HEDGE_MTM', 'Hedge MTM')
) AS v(code, label)
JOIN metadata_register.attribute_register a ON a.attribute_code = v.code
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_aliases x
    WHERE x.attribute_id = a.id AND lower(x.alias_label) = lower(v.label)
);

NOTIFY pgrst, 'reload schema';
