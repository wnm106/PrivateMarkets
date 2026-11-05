-- Cash reconciliation for a fund close.
--
-- Positional cash flows already exist on the position. This adds the bank side
-- and the pairs between them:
--   BANK_ACCOUNT       an account affiliated with the fund
--   BANK_TRANSACTION   one movement on that account
--   CASH_MATCH         one bank transaction paired with one or more cash flows
--   CASH_MATCH_RULE    a match rule and its place in the preference order
--   CASH_ADJUSTMENT    an amount posted so the position book and the bank tie
--
-- Rules run in priority order. The first rule that fits wins. A match may
-- attach several cash flows to one bank transaction.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('BANK_ACCOUNT', 'Bank Account', 'A bank account affiliated with a fund'),
    ('BANK_TRANSACTION', 'Bank Transaction', 'One movement on a fund bank account'),
    ('CASH_MATCH', 'Cash Match', 'One bank transaction paired with one or more positional cash flows'),
    ('CASH_MATCH_RULE', 'Cash Match Rule', 'A cash match rule and where it sits in the preference order'),
    ('CASH_ADJUSTMENT', 'Cash Adjustment', 'An amount posted so positional cash and the bank tie')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('BANK_ACCOUNT', 'FUNDS', 30, 'FUND'),
    ('BANK_TRANSACTION', 'FUNDS', 31, 'BANK_ACCOUNT'),
    ('CASH_MATCH', 'FUNDS', 32, 'FUND'),
    ('CASH_MATCH_RULE', 'FUNDS', 33, 'FUND'),
    ('CASH_ADJUSTMENT', 'FUNDS', 34, 'FUND')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CASH_RULE_KIND', 'Cash Match Rule', 'CASH_MATCH_RULE', 'How a bank transaction is allowed to pair with positional cash flows'),
    ('CASH_MATCH_STATUS', 'Cash Match Status', 'CASH_MATCH', 'Whether a reviewer has accepted the pair'),
    ('CASH_ADJ_SIDE', 'Cash Adjustment Side', 'CASH_ADJUSTMENT', 'Which book the adjustment is added to'),
    ('CASH_ADJ_STATUS', 'Cash Adjustment Status', 'CASH_ADJUSTMENT', 'Whether the adjustment is still a proposal')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CASH_RULE_KIND', 'EXACT', 'Exact date and amount', 1),
    ('CASH_RULE_KIND', 'DATE_DELAY', 'Exact amount, date delay', 2),
    ('CASH_RULE_KIND', 'DOLLAR_VARIANCE', 'Dollar variance', 3),
    ('CASH_RULE_KIND', 'DATE_VARIANCE', 'Date variance', 4),
    ('CASH_RULE_KIND', 'MULTI_POSITION', 'Several cash flows, one position', 5),
    ('CASH_RULE_KIND', 'MULTI', 'Several cash flows, one bank transaction', 6),
    ('CASH_RULE_KIND', 'MANUAL', 'Manual', 7),
    ('CASH_MATCH_STATUS', 'APPROVED', 'Approved', 1),
    ('CASH_MATCH_STATUS', 'REJECTED', 'Rejected', 2),
    ('CASH_ADJ_SIDE', 'POSITION', 'Position book', 1),
    ('CASH_ADJ_SIDE', 'BANK', 'Bank', 2),
    ('CASH_ADJ_STATUS', 'PROPOSED', 'Proposed', 1),
    ('CASH_ADJ_STATUS', 'POSTED', 'Posted', 2)
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
       FALSE, 'NONE'
FROM (VALUES
    ('BANK_NAME', 'Bank', 'STRING', 'Institution that holds the account', 'BANK_ACCOUNT', NULL, 'Account', 1),
    ('BANK_ACCOUNT_NUMBER', 'Account Number', 'STRING', 'Account number, or the last digits of it', 'BANK_ACCOUNT', NULL, 'Account', 2),
    ('BANK_ACCOUNT_LABEL', 'Account Label', 'STRING', 'Name the fund uses for this account', 'BANK_ACCOUNT', NULL, 'Account', 3),
    ('BANK_CURRENCY', 'Currency', 'STRING', 'Currency of the account', 'BANK_ACCOUNT', NULL, 'Account', 4),

    ('BANK_TXN_DATE', 'Transaction Date', 'DATE', 'Date the cash moved at the bank', 'BANK_TRANSACTION', NULL, 'Transaction', 1),
    ('BANK_TXN_AMOUNT', 'Amount', 'CURRENCY', 'Signed amount. Money received is positive and money paid is negative.', 'BANK_TRANSACTION', NULL, 'Transaction', 2),
    ('BANK_TXN_DESCRIPTION', 'Description', 'STRING', 'Narrative from the bank statement', 'BANK_TRANSACTION', NULL, 'Transaction', 3),
    ('BANK_TXN_REFERENCE', 'Reference', 'STRING', 'Wire or statement reference', 'BANK_TRANSACTION', NULL, 'Transaction', 4),
    ('BANK_TXN_COUNTERPARTY', 'Counterparty', 'STRING', 'The other bank or paying agent on the wire', 'BANK_TRANSACTION', NULL, 'Transaction', 5),

    ('MATCH_RULE', 'Rule', 'REFERENCE_LIST', 'The rule that paired this bank transaction, or Manual', 'CASH_MATCH', 'CASH_RULE_KIND', 'Match', 1),
    ('MATCH_STATUS', 'Status', 'REFERENCE_LIST', 'Approved pairs are kept. Anything else is proposed again.', 'CASH_MATCH', 'CASH_MATCH_STATUS', 'Match', 2),
    ('MATCH_CONFIDENCE', 'Confidence', 'INTEGER', 'How strongly the rule fitted, from 0 to 100', 'CASH_MATCH', NULL, 'Match', 3),
    ('MATCH_VARIANCE', 'Variance', 'CURRENCY', 'Bank amount minus the paired cash flows', 'CASH_MATCH', NULL, 'Match', 4),
    ('MATCH_PERIOD_END', 'Period End', 'DATE', 'Close period this pair belongs to', 'CASH_MATCH', NULL, 'Match', 5),

    ('RULE_KIND', 'Kind', 'REFERENCE_LIST', 'What the rule compares', 'CASH_MATCH_RULE', 'CASH_RULE_KIND', 'Rule', 1),
    ('RULE_PRIORITY', 'Priority', 'INTEGER', 'Lower numbers run first. The first rule that fits wins.', 'CASH_MATCH_RULE', NULL, 'Rule', 2),
    ('RULE_ENABLED', 'Enabled', 'BOOLEAN', 'A disabled rule is skipped', 'CASH_MATCH_RULE', NULL, 'Rule', 3),
    ('RULE_DATE_DAYS', 'Date Window (business days)', 'INTEGER', 'How many business days the bank date may differ from the cash flow', 'CASH_MATCH_RULE', NULL, 'Rule', 4),
    ('RULE_AMOUNT_TOLERANCE', 'Amount Tolerance', 'CURRENCY', 'How far the amounts may differ, in dollars', 'CASH_MATCH_RULE', NULL, 'Rule', 5),
    ('RULE_MAX_ITEMS', 'Max Cash Flows', 'INTEGER', 'How many positional cash flows one bank transaction may take', 'CASH_MATCH_RULE', NULL, 'Rule', 6),

    ('ADJ_AMOUNT', 'Amount', 'CURRENCY', 'Signed amount added to the chosen book', 'CASH_ADJUSTMENT', NULL, 'Adjustment', 1),
    ('ADJ_SIDE', 'Side', 'REFERENCE_LIST', 'Position book or bank', 'CASH_ADJUSTMENT', 'CASH_ADJ_SIDE', 'Adjustment', 2),
    ('ADJ_REASON', 'Reason', 'STRING', 'Why the books need this amount to tie', 'CASH_ADJUSTMENT', NULL, 'Adjustment', 3),
    ('ADJ_PERIOD_END', 'Period End', 'DATE', 'Close period this adjustment belongs to', 'CASH_ADJUSTMENT', NULL, 'Adjustment', 4),
    ('ADJ_STATUS', 'Status', 'REFERENCE_LIST', 'Proposed or posted', 'CASH_ADJUSTMENT', 'CASH_ADJ_STATUS', 'Adjustment', 5)
) AS v(code, name, dtype, descr, dom, list, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('BANK_ACCOUNT_STANDARD', 'Standard Bank Account', 'BANK_ACCOUNT', 'A fund bank account'),
    ('BANK_TRANSACTION_STANDARD', 'Standard Bank Transaction', 'BANK_TRANSACTION', 'One bank movement'),
    ('CASH_MATCH_STANDARD', 'Standard Cash Match', 'CASH_MATCH', 'A bank transaction paired with positional cash flows'),
    ('CASH_MATCH_RULE_STANDARD', 'Standard Cash Match Rule', 'CASH_MATCH_RULE', 'One rule in the preference order'),
    ('CASH_ADJUSTMENT_STANDARD', 'Standard Cash Adjustment', 'CASH_ADJUSTMENT', 'An amount that ties the books')
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
    'BANK_NAME', 'BANK_ACCOUNT_NUMBER', 'BANK_ACCOUNT_LABEL', 'BANK_CURRENCY',
    'BANK_TXN_DATE', 'BANK_TXN_AMOUNT', 'BANK_TXN_DESCRIPTION', 'BANK_TXN_REFERENCE', 'BANK_TXN_COUNTERPARTY',
    'MATCH_RULE', 'MATCH_STATUS', 'MATCH_CONFIDENCE', 'MATCH_VARIANCE', 'MATCH_PERIOD_END',
    'RULE_KIND', 'RULE_PRIORITY', 'RULE_ENABLED', 'RULE_DATE_DAYS', 'RULE_AMOUNT_TOLERANCE', 'RULE_MAX_ITEMS',
    'ADJ_AMOUNT', 'ADJ_SIDE', 'ADJ_REASON', 'ADJ_PERIOD_END', 'ADJ_STATUS'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('FUND_BANK_ACCOUNT', 'Bank account of fund', 'FUND', 'BANK_ACCOUNT', 'A bank account affiliated with the fund', 'ONE_TO_MANY', FALSE),
    ('ACCOUNT_BANK_TXN', 'Transaction on account', 'BANK_ACCOUNT', 'BANK_TRANSACTION', 'A movement on the bank account', 'ONE_TO_MANY', FALSE),
    ('FUND_CASH_RULE', 'Match rule of fund', 'FUND', 'CASH_MATCH_RULE', 'A cash match rule for the fund, in preference order', 'ONE_TO_MANY', FALSE),
    ('MATCH_BANK_TXN', 'Match to bank transaction', 'CASH_MATCH', 'BANK_TRANSACTION', 'The one bank transaction in the pair', 'MANY_TO_ONE', TRUE),
    ('MATCH_CASHFLOW', 'Match to cash flow', 'CASH_MATCH', 'CASH_FLOW', 'A positional cash flow in the pair. One match may have several.', 'ONE_TO_MANY', TRUE),
    ('ADJUSTMENT_FUND', 'Adjustment of fund', 'CASH_ADJUSTMENT', 'FUND', 'The fund whose books this adjustment ties', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Halyard Q3 2026: accounts, transactions, rules, and the tie-out
--
-- The bank side is shaped so the preference order produces one of each rule:
-- exact date and amount, a one-business-day delay, a dollar variance, a
-- three-business-day date variance, several cash flows on one position, and
-- several cash flows across positions. Two interest flows and one incoming
-- wire stay open. A posted bank adjustment of 57,350 closes the residual.
-- ============================================================

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'HSCF2-FUND';
    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL', 'INTERNAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 WHEN 'MANUAL' THEN 1 ELSE 2 END
    LIMIT 1;
    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping cash reconciliation sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent VALUES
        ('HSCF2-BANK-JPM', 'BANK_ACCOUNT', 'BANK_ACCOUNT_STANDARD', 'JP Morgan operating', 'Operating account for fundings.'),
        ('HSCF2-BANK-BNY', 'BANK_ACCOUNT', 'BANK_ACCOUNT_STANDARD', 'BNY Mellon collections', 'Collections account for interest, fees, and repayments.'),
        ('HSCF2-BTX-01', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Cobalt Software funding', 'Purchase wire.'),
        ('HSCF2-BTX-02', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Pinecrest Education funding', 'Purchase wire.'),
        ('HSCF2-BTX-03', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Vantage Payments funding', 'Purchase wire.'),
        ('HSCF2-BTX-04', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Kestrel Aerospace funding', 'Purchase wire.'),
        ('HSCF2-BTX-05', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Northwind Logistics principal', 'Principal repayment.'),
        ('HSCF2-BTX-06', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Quillon Health interest', 'Interest, same day.'),
        ('HSCF2-BTX-07', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Cobalt Software interest', 'Interest, same day.'),
        ('HSCF2-BTX-08', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Cobalt Software fee', 'Fee, same day.'),
        ('HSCF2-BTX-09', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Pinecrest Education interest', 'Interest, same day.'),
        ('HSCF2-BTX-10', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Pinecrest Education fee', 'Fee, same day.'),
        ('HSCF2-BTX-11', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Sable Energy repayment and interest', 'One wire for the position repayment and interest.'),
        ('HSCF2-BTX-12', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Atlas Industrial sale and interest', 'One wire for the sale proceeds and interest.'),
        ('HSCF2-BTX-13', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Bluewater Marine interest', 'Interest received three business days early.'),
        ('HSCF2-BTX-14', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Ridgeline Dental interest', 'Interest net of a wire fee.'),
        ('HSCF2-BTX-15', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Vantage and Kestrel interest and fees', 'One wire covering two positions.'),
        ('HSCF2-BTX-16', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Meridian Specialty Finance interest', 'Interest received the next business day.'),
        ('HSCF2-BTX-17', 'BANK_TRANSACTION', 'BANK_TRANSACTION_STANDARD', 'Unidentified incoming wire', 'No positional cash flow.'),
        ('HSCF2-RULE-EXACT', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Exact date and amount', 'Same date and the same amount to the cent.'),
        ('HSCF2-RULE-DATE-DELAY', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Exact amount, date delay', 'Same amount, one business day apart.'),
        ('HSCF2-RULE-DOLLAR', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Dollar variance', 'Same date, amounts within 10,000.'),
        ('HSCF2-RULE-DATE', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Date variance', 'Same amount, up to three business days apart.'),
        ('HSCF2-RULE-MULTI-POS', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Several cash flows, one position', 'Cash flows on one position that sum to the wire.'),
        ('HSCF2-RULE-MULTI', 'CASH_MATCH_RULE', 'CASH_MATCH_RULE_STANDARD', 'Several cash flows, one bank transaction', 'Cash flows across positions that sum to the wire.'),
        ('HSCF2-CASH-ADJ-20260930', 'CASH_ADJUSTMENT', 'CASH_ADJUSTMENT_STANDARD', 'Wire fee and unidentified receipt', 'Closes the quarter so the position book and the bank tie.');

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"cashRecSample":true}'::jsonb
    FROM t_ent e
    JOIN metadata_register.domain_templates t ON t.template_code = e.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        template_id = EXCLUDED.template_id,
        domain_code = EXCLUDED.domain_code,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;
    INSERT INTO t_val VALUES
        ('HSCF2-BANK-JPM', 'BANK_NAME', 'JP Morgan'),
        ('HSCF2-BANK-JPM', 'BANK_ACCOUNT_NUMBER', '4421'),
        ('HSCF2-BANK-JPM', 'BANK_ACCOUNT_LABEL', 'Operating'),
        ('HSCF2-BANK-JPM', 'BANK_CURRENCY', 'USD'),
        ('HSCF2-BANK-BNY', 'BANK_NAME', 'BNY Mellon'),
        ('HSCF2-BANK-BNY', 'BANK_ACCOUNT_NUMBER', '7780'),
        ('HSCF2-BANK-BNY', 'BANK_ACCOUNT_LABEL', 'Collections'),
        ('HSCF2-BANK-BNY', 'BANK_CURRENCY', 'USD');

    INSERT INTO t_val
    SELECT code, attr, val
    FROM (VALUES
        ('HSCF2-BTX-01', '2026-09-30', '-12000000', 'Cobalt Software funding', 'JPM-4421', 'JP Morgan'),
        ('HSCF2-BTX-02', '2026-09-30', '-10200000', 'Pinecrest Education funding', 'JPM-4421', 'JP Morgan'),
        ('HSCF2-BTX-03', '2026-09-30', '-14000000', 'Vantage Payments funding', 'JPM-4421', 'JP Morgan'),
        ('HSCF2-BTX-04', '2026-09-30', '-8000000', 'Kestrel Aerospace funding', 'JPM-4421', 'JP Morgan'),
        ('HSCF2-BTX-05', '2026-09-30', '15000000', 'Northwind Logistics principal', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-06', '2026-09-30', '1400000', 'Quillon Health interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-07', '2026-09-30', '1600000', 'Cobalt Software interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-08', '2026-09-30', '100000', 'Cobalt Software fee', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-09', '2026-09-30', '1000000', 'Pinecrest Education interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-10', '2026-09-30', '300000', 'Pinecrest Education fee', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-11', '2026-09-30', '9200000', 'Sable Energy repayment and interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-12', '2026-09-30', '13200000', 'Atlas Industrial sale and interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-13', '2026-09-25', '800000', 'Bluewater Marine interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-14', '2026-09-30', '595000', 'Ridgeline Dental interest, net of wire fee', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-15', '2026-09-30', '800000', 'Vantage and Kestrel interest and fees', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-16', '2026-10-01', '1300000', 'Meridian Specialty Finance interest', 'BNY-7780', 'BNY Mellon'),
        ('HSCF2-BTX-17', '2026-09-30', '2847650', 'Unidentified incoming wire', 'BNY-7780', '')
    ) AS w(code, txn_date, amount, descr, reference, counterparty)
    CROSS JOIN LATERAL (VALUES
        ('BANK_TXN_DATE', w.txn_date),
        ('BANK_TXN_AMOUNT', w.amount),
        ('BANK_TXN_DESCRIPTION', w.descr),
        ('BANK_TXN_REFERENCE', w.reference),
        ('BANK_TXN_COUNTERPARTY', w.counterparty)
    ) AS payload(attr, val);

    INSERT INTO t_val VALUES
        ('HSCF2-RULE-EXACT', 'RULE_KIND', 'EXACT'),
        ('HSCF2-RULE-EXACT', 'RULE_PRIORITY', '10'),
        ('HSCF2-RULE-EXACT', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-EXACT', 'RULE_DATE_DAYS', '0'),
        ('HSCF2-RULE-EXACT', 'RULE_AMOUNT_TOLERANCE', '0.01'),
        ('HSCF2-RULE-EXACT', 'RULE_MAX_ITEMS', '1'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_KIND', 'DATE_DELAY'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_PRIORITY', '20'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_DATE_DAYS', '1'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_AMOUNT_TOLERANCE', '0.01'),
        ('HSCF2-RULE-DATE-DELAY', 'RULE_MAX_ITEMS', '1'),
        ('HSCF2-RULE-DOLLAR', 'RULE_KIND', 'DOLLAR_VARIANCE'),
        ('HSCF2-RULE-DOLLAR', 'RULE_PRIORITY', '30'),
        ('HSCF2-RULE-DOLLAR', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-DOLLAR', 'RULE_DATE_DAYS', '0'),
        ('HSCF2-RULE-DOLLAR', 'RULE_AMOUNT_TOLERANCE', '10000'),
        ('HSCF2-RULE-DOLLAR', 'RULE_MAX_ITEMS', '1'),
        ('HSCF2-RULE-DATE', 'RULE_KIND', 'DATE_VARIANCE'),
        ('HSCF2-RULE-DATE', 'RULE_PRIORITY', '40'),
        ('HSCF2-RULE-DATE', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-DATE', 'RULE_DATE_DAYS', '3'),
        ('HSCF2-RULE-DATE', 'RULE_AMOUNT_TOLERANCE', '0.01'),
        ('HSCF2-RULE-DATE', 'RULE_MAX_ITEMS', '1'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_KIND', 'MULTI_POSITION'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_PRIORITY', '50'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_DATE_DAYS', '1'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_AMOUNT_TOLERANCE', '0.01'),
        ('HSCF2-RULE-MULTI-POS', 'RULE_MAX_ITEMS', '5'),
        ('HSCF2-RULE-MULTI', 'RULE_KIND', 'MULTI'),
        ('HSCF2-RULE-MULTI', 'RULE_PRIORITY', '60'),
        ('HSCF2-RULE-MULTI', 'RULE_ENABLED', 'true'),
        ('HSCF2-RULE-MULTI', 'RULE_DATE_DAYS', '1'),
        ('HSCF2-RULE-MULTI', 'RULE_AMOUNT_TOLERANCE', '0.01'),
        ('HSCF2-RULE-MULTI', 'RULE_MAX_ITEMS', '5'),
        ('HSCF2-CASH-ADJ-20260930', 'ADJ_AMOUNT', '57350'),
        ('HSCF2-CASH-ADJ-20260930', 'ADJ_SIDE', 'BANK'),
        ('HSCF2-CASH-ADJ-20260930', 'ADJ_REASON', 'Wire fee on the Ridgeline interest and the unidentified incoming wire.'),
        ('HSCF2-CASH-ADJ-20260930', 'ADJ_PERIOD_END', '2026-09-30'),
        ('HSCF2-CASH-ADJ-20260930', 'ADJ_STATUS', 'POSTED');

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me, metadata_register.attribute_register ar, t_val v
    WHERE eav.entity_id = me.id
      AND me.entity_code = v.entity_code
      AND eav.attribute_id = ar.id
      AND ar.attribute_code = v.attribute_code;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"cashRecSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;
    INSERT INTO t_rel VALUES
        ('HSCF2-FUND', 'HSCF2-BANK-JPM', 'FUND_BANK_ACCOUNT'),
        ('HSCF2-FUND', 'HSCF2-BANK-BNY', 'FUND_BANK_ACCOUNT'),
        ('HSCF2-BANK-JPM', 'HSCF2-BTX-01', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-JPM', 'HSCF2-BTX-02', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-JPM', 'HSCF2-BTX-03', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-JPM', 'HSCF2-BTX-04', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-05', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-06', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-07', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-08', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-09', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-10', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-11', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-12', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-13', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-14', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-15', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-16', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-BANK-BNY', 'HSCF2-BTX-17', 'ACCOUNT_BANK_TXN'),
        ('HSCF2-FUND', 'HSCF2-RULE-EXACT', 'FUND_CASH_RULE'),
        ('HSCF2-FUND', 'HSCF2-RULE-DATE-DELAY', 'FUND_CASH_RULE'),
        ('HSCF2-FUND', 'HSCF2-RULE-DOLLAR', 'FUND_CASH_RULE'),
        ('HSCF2-FUND', 'HSCF2-RULE-DATE', 'FUND_CASH_RULE'),
        ('HSCF2-FUND', 'HSCF2-RULE-MULTI-POS', 'FUND_CASH_RULE'),
        ('HSCF2-FUND', 'HSCF2-RULE-MULTI', 'FUND_CASH_RULE'),
        ('HSCF2-CASH-ADJ-20260930', 'HSCF2-FUND', 'ADJUSTMENT_FUND');

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT DISTINCT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01'
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
