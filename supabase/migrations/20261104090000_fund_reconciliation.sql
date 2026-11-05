-- Fund reconciliation: the monthly or quarterly NAV close.
--
-- A fund that reconciles has a close calendar (frequency and the number of
-- days after period end the NAV is certified by), fee and waterfall terms, an
-- administrator NAV statement per period, a position roll-forward for that
-- period, outside evidence (bank and lender balances), and the capital call
-- and distribution notices that already exist as capital activity.
--
-- What this adds on top of the fund surface model:
--   FUND_CLOSE        one close of one fund: period end, reviewer sign-off, certification
--   REC_DISPOSITION   a reviewer's decision on one open item: accept, adjust, or query the admin
--   REC_EVIDENCE      a bank or lender balance for a period end
--   POSITION_ROLL     one position's activity for a period: the roll-forward the admin reports
-- plus fund close and terms attributes, the received date on a statement, and the
-- prior-period amount on a statement line.
--
-- Funds opt in to the close board by having a close frequency.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('FUND_CLOSE', 'Fund Close', 'One monthly or quarterly close of a fund: sign-off and NAV certification'),
    ('REC_DISPOSITION', 'Rec Disposition', 'A reviewer decision on one open item of a fund close'),
    ('REC_EVIDENCE', 'Rec Evidence', 'A bank or lender balance used to tie the administrator statements'),
    ('POSITION_ROLL', 'Position Roll-forward', 'One position''s activity for one period, as the administrator reports it')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('FUND_CLOSE', 'FUNDS', 20, 'FUND'),
    ('REC_DISPOSITION', 'FUNDS', 21, 'FUND_CLOSE'),
    ('REC_EVIDENCE', 'FUNDS', 22, 'FUND'),
    ('POSITION_ROLL', 'FUNDS', 23, 'POSITION')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CLOSE_FREQUENCY', 'Close Frequency', 'FUND', 'How often the fund closes its books and certifies a NAV'),
    ('CLOSE_STEP_STATE', 'Close Step State', 'FUND_CLOSE', 'Where a manual close step stands'),
    ('REC_DECISION', 'Rec Decision', 'REC_DISPOSITION', 'Accept the admin figure, propose an adjustment, or query the admin'),
    ('EVIDENCE_KIND', 'Evidence Kind', 'REC_EVIDENCE', 'Whose statement the balance comes from')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CLOSE_FREQUENCY', 'MONTHLY', 'Monthly', 1),
    ('CLOSE_FREQUENCY', 'QUARTERLY', 'Quarterly', 2),
    ('CLOSE_STEP_STATE', 'NOT_STARTED', 'Not started', 1),
    ('CLOSE_STEP_STATE', 'IN_PROGRESS', 'In progress', 2),
    ('CLOSE_STEP_STATE', 'BLOCKED', 'Blocked', 3),
    ('CLOSE_STEP_STATE', 'DONE', 'Done', 4),
    ('REC_DECISION', 'ACCEPT', 'Accept', 1),
    ('REC_DECISION', 'ADJUST', 'Adjust', 2),
    ('REC_DECISION', 'QUERY', 'Query admin', 3),
    ('EVIDENCE_KIND', 'BANK', 'Bank statement', 1),
    ('EVIDENCE_KIND', 'LENDER', 'Lender statement', 2)
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
    ('FUND_CLOSE_FREQUENCY', 'Close Frequency', 'REFERENCE_LIST', 'Monthly or quarterly. A fund with a frequency is on the close board.', 'FUND', 'CLOSE_FREQUENCY', 'Close', 1),
    ('FUND_CLOSE_LAG_DAYS', 'Certification Lag (days)', 'INTEGER', 'Calendar days after period end by which the NAV is certified. Close steps are dated from this.', 'FUND', NULL, 'Close', 2),
    ('FUND_MGMT_FEE_RATE_PCT', 'Management Fee Rate', 'PERCENTAGE', 'Annual management fee, percent of the fee base (commitments)', 'FUND', NULL, 'Fees', 1),
    ('FUND_PREF_RETURN_PCT', 'Preferred Return', 'PERCENTAGE', 'Annual preferred return hurdle for the performance fee', 'FUND', NULL, 'Fees', 2),
    ('FUND_CARRY_PCT', 'Carried Interest', 'PERCENTAGE', 'Share of profit paid to the manager once the hurdle is met', 'FUND', NULL, 'Fees', 3),
    ('FUND_CATCH_UP_PCT', 'Catch-up', 'PERCENTAGE', 'Share of profit above the hurdle that goes to the manager until it holds its carry share', 'FUND', NULL, 'Fees', 4),

    ('STATEMENT_RECEIVED_DATE', 'Received', 'DATE', 'Date the administrator pack arrived', 'NAV_STATEMENT', NULL, 'Review', 5),
    ('NAV_LINE_PRIOR', 'Prior Period Amount', 'CURRENCY', 'Amount on the prior period certified statement. Used when no prior statement is loaded.', 'NAV_LINE', NULL, 'Line', 11),

    ('CLOSE_PERIOD_END', 'Period End', 'DATE', 'Period end this close covers', 'FUND_CLOSE', NULL, 'Close', 1),
    ('CLOSE_SIGNOFF', 'Reviewer Sign-off', 'REFERENCE_LIST', 'Manual sign-off step before the NAV is certified', 'FUND_CLOSE', 'CLOSE_STEP_STATE', 'Close', 2),
    ('CLOSE_CERTIFIED_AT', 'Certified On', 'DATE', 'Date the NAV was certified. Blank until certified.', 'FUND_CLOSE', NULL, 'Close', 3),
    ('CLOSE_CERTIFIED_BY', 'Certified By', 'STRING', 'Who certified the NAV', 'FUND_CLOSE', NULL, 'Close', 4),
    ('CLOSE_CERTIFIED_NAV', 'Certified NAV', 'CURRENCY', 'NAV at certification, including any adjustments sent to the administrator', 'FUND_CLOSE', NULL, 'Close', 5),

    ('DISPOSITION_ITEM', 'Item', 'STRING', 'Review item this decision is on, for example fee, perf, int, or pos:<position id>', 'REC_DISPOSITION', NULL, 'Decision', 1),
    ('DISPOSITION_DECISION', 'Decision', 'REFERENCE_LIST', 'Accept, adjust, or query admin', 'REC_DISPOSITION', 'REC_DECISION', 'Decision', 2),
    ('DISPOSITION_NOTE', 'Note', 'STRING', 'Note for the file', 'REC_DISPOSITION', NULL, 'Decision', 3),
    ('DISPOSITION_EFFECT', 'NAV Effect', 'CURRENCY', 'NAV effect of the item when the decision was made', 'REC_DISPOSITION', NULL, 'Decision', 4),

    ('EVIDENCE_KIND', 'Kind', 'REFERENCE_LIST', 'Bank or lender', 'REC_EVIDENCE', 'EVIDENCE_KIND', 'Evidence', 1),
    ('EVIDENCE_DATE', 'Balance Date', 'DATE', 'Date of the balance. Matches a period end.', 'REC_EVIDENCE', NULL, 'Evidence', 2),
    ('EVIDENCE_AMOUNT', 'Balance', 'CURRENCY', 'Balance on the outside statement', 'REC_EVIDENCE', NULL, 'Evidence', 3),
    ('EVIDENCE_SOURCE', 'Source', 'STRING', 'Who issued the statement', 'REC_EVIDENCE', NULL, 'Evidence', 4),

    ('ROLL_BEGIN_FV', 'Beginning Fair Value', 'CURRENCY', 'Fair value at the prior period end', 'POSITION_ROLL', NULL, 'Value', 1),
    ('ROLL_PURCHASES', 'Purchases', 'CURRENCY', 'Fundings in the period', 'POSITION_ROLL', NULL, 'Value', 2),
    ('ROLL_REPAYMENTS', 'Principal Repayments', 'CURRENCY', 'Principal repaid in the period, at cost', 'POSITION_ROLL', NULL, 'Value', 3),
    ('ROLL_SALES', 'Sales at Cost', 'CURRENCY', 'Cost of the portion sold in the period', 'POSITION_ROLL', NULL, 'Value', 4),
    ('ROLL_PIK', 'PIK Capitalized', 'CURRENCY', 'Interest added to principal', 'POSITION_ROLL', NULL, 'Value', 5),
    ('ROLL_AMORTIZATION', 'Net Amortization', 'CURRENCY', 'Net amortization and accretion', 'POSITION_ROLL', NULL, 'Value', 6),
    ('ROLL_UNREALIZED_CHANGE', 'Change in Unrealized', 'CURRENCY', 'Change in unrealized appreciation or depreciation', 'POSITION_ROLL', NULL, 'Value', 7),
    ('ROLL_REALIZED_GAIN', 'Realized Gain', 'CURRENCY', 'Gain realized on repayments and sales', 'POSITION_ROLL', NULL, 'Value', 8),
    ('ROLL_END_FV', 'Ending Fair Value', 'CURRENCY', 'Fair value at period end as the administrator reports it', 'POSITION_ROLL', NULL, 'Value', 9),
    ('ROLL_BEGIN_UNREALIZED', 'Beginning Unrealized', 'CURRENCY', 'Unrealized appreciation at the prior period end', 'POSITION_ROLL', NULL, 'Value', 10),
    ('ROLL_INTEREST_EARNED', 'Interest Earned', 'CURRENCY', 'Cash-pay interest earned in the period', 'POSITION_ROLL', NULL, 'Income', 1),
    ('ROLL_FEE_INCOME', 'Fee and Other Income', 'CURRENCY', 'Fees and other income earned in the period', 'POSITION_ROLL', NULL, 'Income', 2),
    ('ROLL_BEGIN_ACCRUED', 'Beginning Accrued Interest', 'CURRENCY', 'Interest receivable at the prior period end', 'POSITION_ROLL', NULL, 'Income', 3),
    ('ROLL_END_ACCRUED', 'Ending Accrued Interest', 'CURRENCY', 'Interest receivable at period end, administrator', 'POSITION_ROLL', NULL, 'Income', 4),
    ('ROLL_OUR_ACCRUED', 'Our Accrued Interest', 'CURRENCY', 'Interest receivable from our loan-level accrual. Blank when we do not shadow it.', 'POSITION_ROLL', NULL, 'Income', 5)
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
    ('FUND_CLOSE_STANDARD', 'Standard Fund Close', 'FUND_CLOSE', 'One close of one fund'),
    ('REC_DISPOSITION_STANDARD', 'Standard Rec Disposition', 'REC_DISPOSITION', 'A decision on one open review item'),
    ('REC_EVIDENCE_STANDARD', 'Standard Rec Evidence', 'REC_EVIDENCE', 'A bank or lender balance'),
    ('POSITION_ROLL_STANDARD', 'Standard Position Roll-forward', 'POSITION_ROLL', 'One position, one period')
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
    'FUND_CLOSE_FREQUENCY', 'FUND_CLOSE_LAG_DAYS', 'FUND_MGMT_FEE_RATE_PCT', 'FUND_PREF_RETURN_PCT', 'FUND_CARRY_PCT', 'FUND_CATCH_UP_PCT',
    'STATEMENT_RECEIVED_DATE', 'NAV_LINE_PRIOR',
    'CLOSE_PERIOD_END', 'CLOSE_SIGNOFF', 'CLOSE_CERTIFIED_AT', 'CLOSE_CERTIFIED_BY', 'CLOSE_CERTIFIED_NAV',
    'DISPOSITION_ITEM', 'DISPOSITION_DECISION', 'DISPOSITION_NOTE', 'DISPOSITION_EFFECT',
    'EVIDENCE_KIND', 'EVIDENCE_DATE', 'EVIDENCE_AMOUNT', 'EVIDENCE_SOURCE',
    'ROLL_BEGIN_FV', 'ROLL_PURCHASES', 'ROLL_REPAYMENTS', 'ROLL_SALES', 'ROLL_PIK', 'ROLL_AMORTIZATION',
    'ROLL_UNREALIZED_CHANGE', 'ROLL_REALIZED_GAIN', 'ROLL_END_FV', 'ROLL_BEGIN_UNREALIZED',
    'ROLL_INTEREST_EARNED', 'ROLL_FEE_INCOME', 'ROLL_BEGIN_ACCRUED', 'ROLL_END_ACCRUED', 'ROLL_OUR_ACCRUED'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('CLOSE_FUND', 'Close of fund', 'FUND_CLOSE', 'FUND', 'The fund this close belongs to', 'MANY_TO_ONE', TRUE),
    ('DISPOSITION_CLOSE', 'Decision on close', 'REC_DISPOSITION', 'FUND_CLOSE', 'The close this decision was made in', 'MANY_TO_ONE', TRUE),
    ('EVIDENCE_FUND', 'Evidence of fund', 'REC_EVIDENCE', 'FUND', 'The fund the outside balance is for', 'MANY_TO_ONE', TRUE),
    ('ROLL_POSITION', 'Roll-forward of position', 'POSITION_ROLL', 'POSITION', 'The position this roll-forward is for', 'MANY_TO_ONE', TRUE),
    ('ROLL_STATEMENT', 'Roll-forward in statement', 'POSITION_ROLL', 'NAV_STATEMENT', 'The administrator pack this roll-forward came in', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Close calendar and terms
--
-- These funds are on the close board. Halyard also carries its fee and
-- waterfall terms. The others have no terms yet, and the board shows that.
-- ============================================================

DO $$
DECLARE
    v_src uuid;
BEGIN
    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    IF v_src IS NULL THEN
        RAISE NOTICE 'Skipping close calendar sample: no source';
        RETURN;
    END IF;

    CREATE TEMP TABLE t_cal (entity_name text, attribute_code text, val text) ON COMMIT DROP;
    INSERT INTO t_cal VALUES
        ('Halyard Senior Credit Fund II', 'FUND_CLOSE_FREQUENCY', 'QUARTERLY'),
        ('Halyard Senior Credit Fund II', 'FUND_CLOSE_LAG_DAYS', '37'),
        ('Halyard Senior Credit Fund II', 'FUND_MGMT_FEE_RATE_PCT', '1.25'),
        ('Halyard Senior Credit Fund II', 'FUND_PREF_RETURN_PCT', '6'),
        ('Halyard Senior Credit Fund II', 'FUND_CARRY_PCT', '10'),
        ('Halyard Senior Credit Fund II', 'FUND_CATCH_UP_PCT', '100'),
        ('Meridian Credit Fund I', 'FUND_CLOSE_FREQUENCY', 'MONTHLY'),
        ('Meridian Credit Fund I', 'FUND_CLOSE_LAG_DAYS', '20'),
        ('Harbor Street BDC', 'FUND_CLOSE_FREQUENCY', 'QUARTERLY'),
        ('Harbor Street BDC', 'FUND_CLOSE_LAG_DAYS', '40'),
        ('Northline PE Fund III', 'FUND_CLOSE_FREQUENCY', 'QUARTERLY'),
        ('Northline PE Fund III', 'FUND_CLOSE_LAG_DAYS', '45');

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me, metadata_register.attribute_register ar, t_cal c
    WHERE eav.entity_id = me.id
      AND eav.attribute_id = ar.id
      AND me.domain_code = 'FUND'
      AND me.entity_name = c.entity_name
      AND ar.attribute_code = c.attribute_code;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, c.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN c.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN c.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN c.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"fundRecSample":true}'::jsonb
    FROM t_cal c
    JOIN entity_instances.master_entities me ON me.domain_code = 'FUND' AND me.entity_name = c.entity_name
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = c.attribute_code;
END $$;

-- ============================================================
-- 7. Halyard Q3 2026: the pack the reviewer is working
-- ============================================================

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
BEGIN
    SELECT client_id INTO v_client
    FROM entity_instances.master_entities
    WHERE entity_code = 'HSCF2-FUND';

    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping fund reconciliation sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    -- Position roll-forward. Millions, in the order the administrator lists them.
    -- begin, purchases, repayments, sales, pik, amort, unrealized change, realized,
    -- interest, fees, beginning unrealized, beginning accrued, ending accrued, ending fair value, our accrual
    CREATE TEMP TABLE t_roll ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1,  50.0,  0,    15, 0, 0,   0,     0.1,  2.1, 1.7, 0,   1.5,  0.6,  0.55, 35.1, 0.55),
        (2,  45.0,  0,    0,  0, 0,   0,     0,    0,   1.4, 0,   0.3,  0.5,  0.55, 45.0, 0.55),
        (3,  55.5,  12,   0,  0, 0,   0.15,  0.05, 0,   1.6, 0.1, 0.45, 0.55, 0.6,  67.7, 0.9),
        (5,  40.0,  0,    8,  0, 0,   0,     0.3,  0.8, 1.2, 0,   0.9,  0.45, 0.4,  32.3, 0.4),
        (6,  38.0,  0,    0,  0, 0,   0,    -0.1,  0,   1.3, 0,   0.3,  0.5,  0.55, 37.9, 0.55),
        (7,  27.0,  10.2, 0,  0, 0,  -0.1,   0.1,  0,   1.0, 0.3, 0.15, 0.35, 0.4,  37.2, 0.4),
        (8,  54.1,  0,    0,  12, 0, -0.2,   0.1,  1.0, 1.2, 0,   1.25, 0.5,  0.35, 42.0, 0.35),
        (4,  30.0,  0,    0,  0, 0.3, 0,    -1.2,  0,   1.2, 0,  -0.1,  0.8,  0.95, 29.1, 0.95),
        (9,  27.3,  0,    0,  0, 0.3, 0,    -0.9,  0,   0.8, 0,   0.05, 0.7,  0.85, 26.7, 0.85),
        (10, 30.5,  0,    0,  0, 0,   0,     0,    0,   0.6, 0,   0.2,  0.25, 0.3,  30.5, 0.3),
        (11, 20.0,  14,   0,  0, 0,   0.15,  -0.05, 0,  0.3, 0.2, 0.1,  0.3,  0.35, 34.1, 0.35),
        (12, 3.9,   8,    0,  0, 0,   0,     0,    0,   0.1, 0.2, 0,    0.2,  0.25, 11.9, 0.25)
    ) AS v(pos, b, pu, rp, sl, pik, am, du, re, ie, fe, bu, ba, ea, ev, ours);

    -- Prior certified amounts (June 30, 2026) for the statement rows, millions.
    CREATE TEMP TABLE t_prior (line_id text, prior_m numeric) ON COMMIT DROP;
    INSERT INTO t_prior VALUES
        ('BS-03', 150.5), ('BS-04', 159.1), ('BS-05', 57.3), ('BS-06', 54.4), ('BS-07', 421.3), ('BS-08', 11.7),
        ('BS-09', 5.7), ('BS-10', 438.7), ('BS-12', 122.1), ('BS-13', 1.88), ('BS-14', 1.12), ('BS-15', 125.1),
        ('BS-17', 330), ('BS-18', -42.5), ('BS-19', 26.1), ('BS-20', 313.6),
        ('OP-02', 11.9), ('OP-03', 0.55), ('OP-04', 0.75), ('OP-05', 13.2), ('OP-07', 1.88), ('OP-08', 2.95),
        ('OP-09', 0.95), ('OP-10', 0.42), ('OP-11', 6.2), ('OP-12', 7.0), ('OP-14', 2.1), ('OP-15', 0.8),
        ('OP-16', 2.9), ('OP-17', 9.9),
        ('CF-02', 9.9), ('CF-04', -2.1), ('CF-05', -0.8), ('CF-06', -0.55), ('CF-07', -38), ('CF-08', 28.4),
        ('CF-09', -0.3), ('CF-10', 0.15), ('CF-11', -3.3), ('CF-13', 25), ('CF-14', -8.5), ('CF-15', -10.9),
        ('CF-16', 5.6), ('CF-18', 2.3), ('CF-19', 9.4), ('CF-20', 11.7);

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent
    SELECT 'HSCF2-ROLL-Q326-' || lpad(pos::text, 2, '0'), 'POSITION_ROLL', 'POSITION_ROLL_STANDARD',
           me.entity_name || ' Q3 2026 roll-forward', 'Roll-forward for the quarter ended September 30, 2026.'
    FROM t_roll r
    JOIN entity_instances.master_entities me ON me.entity_code = 'HSCF2-POS-' || lpad(r.pos::text, 2, '0');

    INSERT INTO t_ent VALUES
        ('HSCF2-EVD-BANK-20260930', 'REC_EVIDENCE', 'REC_EVIDENCE_STANDARD', 'Custodian cash balance, September 30, 2026', 'Closing cash per the bank statement.'),
        ('HSCF2-EVD-LENDER-20260930', 'REC_EVIDENCE', 'REC_EVIDENCE_STANDARD', 'Facility balance, September 30, 2026', 'Drawn balance per the lender statement.'),
        ('HSCF2-CLOSE-20260930', 'FUND_CLOSE', 'FUND_CLOSE_STANDARD', 'Q3 2026 close', 'Close of Halyard Senior Credit Fund II for the quarter ended September 30, 2026.');

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"fundRecSample":true}'::jsonb
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

    INSERT INTO t_val
    SELECT 'HSCF2-ROLL-Q326-' || lpad(r.pos::text, 2, '0'), a.attr, (a.m * 1000000)::text
    FROM t_roll r
    CROSS JOIN LATERAL (VALUES
        ('ROLL_BEGIN_FV', r.b), ('ROLL_PURCHASES', r.pu), ('ROLL_REPAYMENTS', r.rp), ('ROLL_SALES', r.sl),
        ('ROLL_PIK', r.pik), ('ROLL_AMORTIZATION', r.am), ('ROLL_UNREALIZED_CHANGE', r.du), ('ROLL_REALIZED_GAIN', r.re),
        ('ROLL_END_FV', r.ev), ('ROLL_BEGIN_UNREALIZED', r.bu), ('ROLL_INTEREST_EARNED', r.ie), ('ROLL_FEE_INCOME', r.fe),
        ('ROLL_BEGIN_ACCRUED', r.ba), ('ROLL_END_ACCRUED', r.ea), ('ROLL_OUR_ACCRUED', r.ours)
    ) AS a(attr, m);

    INSERT INTO t_val VALUES
        ('HSCF2-EVD-BANK-20260930', 'EVIDENCE_KIND', 'BANK'),
        ('HSCF2-EVD-BANK-20260930', 'EVIDENCE_DATE', '2026-09-30'),
        ('HSCF2-EVD-BANK-20260930', 'EVIDENCE_AMOUNT', '21400000'),
        ('HSCF2-EVD-BANK-20260930', 'EVIDENCE_SOURCE', 'Custodian'),
        ('HSCF2-EVD-LENDER-20260930', 'EVIDENCE_KIND', 'LENDER'),
        ('HSCF2-EVD-LENDER-20260930', 'EVIDENCE_DATE', '2026-09-30'),
        ('HSCF2-EVD-LENDER-20260930', 'EVIDENCE_AMOUNT', '110000000'),
        ('HSCF2-EVD-LENDER-20260930', 'EVIDENCE_SOURCE', 'Facility agent'),
        ('HSCF2-CLOSE-20260930', 'CLOSE_PERIOD_END', '2026-09-30'),
        ('HSCF2-CLOSE-20260930', 'CLOSE_SIGNOFF', 'NOT_STARTED'),
        ('HSCF2-STMT', 'STATEMENT_RECEIVED_DATE', '2026-10-27');

    INSERT INTO t_val
    SELECT 'HSCF2-LINE-' || p.line_id, 'NAV_LINE_PRIOR', (p.prior_m * 1000000)::text
    FROM t_prior p
    JOIN entity_instances.master_entities me ON me.entity_code = 'HSCF2-LINE-' || p.line_id;

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me,
          metadata_register.attribute_register ar,
          t_val v
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
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"fundRecSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel
    SELECT 'HSCF2-ROLL-Q326-' || lpad(pos::text, 2, '0'), 'HSCF2-POS-' || lpad(pos::text, 2, '0'), 'ROLL_POSITION' FROM t_roll;
    INSERT INTO t_rel
    SELECT 'HSCF2-ROLL-Q326-' || lpad(pos::text, 2, '0'), 'HSCF2-STMT', 'ROLL_STATEMENT' FROM t_roll;
    INSERT INTO t_rel VALUES
        ('HSCF2-EVD-BANK-20260930', 'HSCF2-FUND', 'EVIDENCE_FUND'),
        ('HSCF2-EVD-LENDER-20260930', 'HSCF2-FUND', 'EVIDENCE_FUND'),
        ('HSCF2-CLOSE-20260930', 'HSCF2-FUND', 'CLOSE_FUND');

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
