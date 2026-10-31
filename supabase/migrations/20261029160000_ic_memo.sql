-- Investment committee memo.
--
-- The memo is not a document blob. Each section is entities the deal already
-- has, or entities added here and joined to the deal (or to its borrower):
--   DEAL_MEMO_POINT   thesis bullets and risks with mitigants
--   DEAL_CAPITAL_ITEM sources and uses
--   FINANCIAL_PERIOD  one column of the financial summary, on the issuer
--   IC_APPROVAL       a committee member's decision
--   DEAL_OPEN_ITEM    a condition still open before close
-- Deal-level facts (team, IC date, base rate, hold, MOIC, IRR, memo status)
-- are attributes on DEAL. Tranche seniority and an optional gross-yield
-- override sit on DEAL_TRANCHE. The allocation grid is not stored again; the
-- memo reads the same allocation the capital-structure tab computes.
--
-- Sample rows fill Project Harbor to the worked example and give every other
-- HALY deal a memo of the same shape, scaled from that deal's EBITDA.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('DEAL_MEMO_POINT', 'IC Memo Point', 'One investment-thesis bullet or one risk and its mitigant'),
    ('DEAL_CAPITAL_ITEM', 'Sources and Uses Line', 'One source or one use in the deal sources and uses'),
    ('FINANCIAL_PERIOD', 'Financial Period', 'One period of borrower revenue, EBITDA, cash flow, and credit ratios'),
    ('IC_APPROVAL', 'IC Approval', 'One investment committee member decision on a deal'),
    ('DEAL_OPEN_ITEM', 'Deal Open Item', 'A condition that is still open before a deal can close')
ON CONFLICT (domain_code) DO NOTHING;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('IC_MEMO_STATUS', 'IC Memo Status', 'DEAL', 'Where the investment committee memorandum sits'),
    ('MEMO_POINT_KIND', 'Memo Point Kind', 'DEAL_MEMO_POINT', 'Thesis bullet or risk'),
    ('CAPITAL_SIDE', 'Sources and Uses Side', 'DEAL_CAPITAL_ITEM', 'Whether a line is a source or a use'),
    ('PERIOD_BASIS', 'Financial Period Basis', 'FINANCIAL_PERIOD', 'Actual results or a forecast'),
    ('IC_ROLE', 'IC Role', 'IC_APPROVAL', 'Role of a committee member on the memo'),
    ('IC_DECISION', 'IC Decision', 'IC_APPROVAL', 'How a committee member voted'),
    ('OPEN_ITEM_STATUS', 'Open Item Status', 'DEAL_OPEN_ITEM', 'Whether a closing condition is still open')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('IC_MEMO_STATUS', 'DRAFT', 'Draft', 1, '[]'),
    ('IC_MEMO_STATUS', 'CIRCULATED', 'Circulated', 2, '[]'),
    ('IC_MEMO_STATUS', 'APPROVED', 'Approved', 3, '[]'),
    ('MEMO_POINT_KIND', 'THESIS', 'Thesis', 1, '[]'),
    ('MEMO_POINT_KIND', 'RISK', 'Risk', 2, '[]'),
    ('CAPITAL_SIDE', 'SOURCE', 'Source', 1, '[]'),
    ('CAPITAL_SIDE', 'USE', 'Use', 2, '[]'),
    ('PERIOD_BASIS', 'ACTUAL', 'Actual', 1, '["LTM"]'),
    ('PERIOD_BASIS', 'ESTIMATE', 'Estimate', 2, '["Forecast","E"]'),
    ('IC_ROLE', 'CHAIR', 'Chair', 1, '[]'),
    ('IC_ROLE', 'MEMBER', 'Member', 2, '[]'),
    ('IC_ROLE', 'RISK', 'Risk', 3, '[]'),
    ('IC_DECISION', 'PENDING', 'Pending', 1, '[]'),
    ('IC_DECISION', 'APPROVED', 'Approved', 2, '[]'),
    ('IC_DECISION', 'DECLINED', 'Declined', 3, '[]'),
    ('IC_DECISION', 'ABSTAINED', 'Abstained', 4, '[]'),
    ('OPEN_ITEM_STATUS', 'OPEN', 'Open', 1, '[]'),
    ('OPEN_ITEM_STATUS', 'DONE', 'Done', 2, '[]')
) AS v(list_code, code, label, ord, syn) ON v.list_code = rl.list_code
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
       v.tv, CASE WHEN v.tv THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    ('DEAL_MEMO_STATUS', 'IC Memo Status', 'REFERENCE_LIST', 'Draft, circulated, or approved', 'DEAL', 'IC_MEMO_STATUS', FALSE, 'Memo', 1, FALSE),
    ('DEAL_TEAM', 'Deal Team', 'STRING', 'People who prepared the memorandum', 'DEAL', NULL, FALSE, 'Memo', 2, FALSE),
    ('DEAL_BASE_RATE', 'Base Rate Assumption', 'NUMBER', 'Base rate, in percent, used to quote gross yield', 'DEAL', NULL, FALSE, 'Memo', 3, FALSE),
    ('DEAL_HOLD_YEARS', 'Expected Hold (years)', 'NUMBER', 'Hold period assumed in the returns case', 'DEAL', NULL, FALSE, 'Memo', 4, FALSE),
    ('DEAL_EXPECTED_MOIC', 'Expected Gross MOIC', 'NUMBER', 'Expected gross multiple of invested capital over the hold', 'DEAL', NULL, FALSE, 'Memo', 5, FALSE),
    ('DEAL_BLENDED_GROSS_IRR', 'Blended Gross IRR', 'NUMBER', 'Blended gross IRR in percent, including OID amortization', 'DEAL', NULL, FALSE, 'Memo', 6, FALSE),
    ('DEAL_RECOMMENDATION', 'Recommendation', 'STRING', 'Recommendation wording. Blank uses the live hold and allocation.', 'DEAL', NULL, FALSE, 'Memo', 7, FALSE),
    ('TRANCHE_GROSS_YIELD', 'Gross Yield', 'PERCENTAGE', 'Gross yield override. Blank uses the base rate plus the spread.', 'DEAL_TRANCHE', NULL, FALSE, 'Returns', 12, FALSE),
    ('TRANCHE_SENIORITY', 'Seniority', 'STRING', 'Lien and security described in the memorandum', 'DEAL_TRANCHE', NULL, FALSE, 'Structure', 2, FALSE),
    ('MEMO_POINT_KIND', 'Kind', 'REFERENCE_LIST', 'Thesis or risk', 'DEAL_MEMO_POINT', 'MEMO_POINT_KIND', FALSE, 'Point', 1, FALSE),
    ('MEMO_POINT_TITLE', 'Title', 'STRING', 'Risk name. Blank on a thesis bullet.', 'DEAL_MEMO_POINT', NULL, FALSE, 'Point', 2, FALSE),
    ('MEMO_POINT_BODY', 'Body', 'STRING', 'Thesis bullet, or the mitigant for a risk', 'DEAL_MEMO_POINT', NULL, FALSE, 'Point', 3, FALSE),
    ('MEMO_POINT_ORDER', 'Order', 'INTEGER', 'Display order inside the section', 'DEAL_MEMO_POINT', NULL, FALSE, 'Point', 4, FALSE),
    ('CAPITAL_SIDE', 'Side', 'REFERENCE_LIST', 'Source or use', 'DEAL_CAPITAL_ITEM', 'CAPITAL_SIDE', FALSE, 'Line', 1, FALSE),
    ('CAPITAL_LABEL', 'Label', 'STRING', 'Name of the source or use', 'DEAL_CAPITAL_ITEM', NULL, FALSE, 'Line', 2, FALSE),
    ('CAPITAL_AMOUNT', 'Amount', 'CURRENCY', 'Amount in deal currency', 'DEAL_CAPITAL_ITEM', NULL, FALSE, 'Line', 3, FALSE),
    ('CAPITAL_ORDER', 'Order', 'INTEGER', 'Display order on its side of the table', 'DEAL_CAPITAL_ITEM', NULL, FALSE, 'Line', 4, FALSE),
    ('PERIOD_LABEL', 'Period', 'STRING', 'Column heading, such as LTM or FY27E', 'FINANCIAL_PERIOD', NULL, FALSE, 'Period', 1, FALSE),
    ('PERIOD_BASIS', 'Basis', 'REFERENCE_LIST', 'Actual or estimate', 'FINANCIAL_PERIOD', 'PERIOD_BASIS', FALSE, 'Period', 2, FALSE),
    ('PERIOD_ORDER', 'Order', 'INTEGER', 'Left-to-right column order', 'FINANCIAL_PERIOD', NULL, FALSE, 'Period', 3, FALSE),
    ('PERIOD_REVENUE', 'Revenue', 'CURRENCY', 'Revenue for the period', 'FINANCIAL_PERIOD', NULL, FALSE, 'Financials', 4, FALSE),
    ('PERIOD_EBITDA', 'EBITDA', 'CURRENCY', 'EBITDA for the period', 'FINANCIAL_PERIOD', NULL, FALSE, 'Financials', 5, FALSE),
    ('PERIOD_EBITDA_MARGIN', 'EBITDA Margin', 'PERCENTAGE', 'EBITDA as a percent of revenue', 'FINANCIAL_PERIOD', NULL, FALSE, 'Financials', 6, FALSE),
    ('PERIOD_FREE_CASH_FLOW', 'Free Cash Flow', 'CURRENCY', 'Free cash flow after interest', 'FINANCIAL_PERIOD', NULL, FALSE, 'Financials', 7, FALSE),
    ('PERIOD_FUNDED_DEBT_TO_EBITDA', 'Funded Debt / EBITDA', 'NUMBER', 'Funded debt to EBITDA', 'FINANCIAL_PERIOD', NULL, FALSE, 'Credit', 8, FALSE),
    ('PERIOD_EBITDA_TO_CASH_INTEREST', 'EBITDA / Cash Interest', 'NUMBER', 'EBITDA coverage of cash interest', 'FINANCIAL_PERIOD', NULL, FALSE, 'Credit', 9, FALSE),
    ('APPROVAL_MEMBER', 'Member', 'STRING', 'Committee member name', 'IC_APPROVAL', NULL, FALSE, 'Decision', 1, FALSE),
    ('APPROVAL_ROLE', 'Role', 'REFERENCE_LIST', 'Chair, member, or risk', 'IC_APPROVAL', 'IC_ROLE', FALSE, 'Decision', 2, FALSE),
    ('APPROVAL_DECISION', 'Decision', 'REFERENCE_LIST', 'Pending, approved, declined, or abstained', 'IC_APPROVAL', 'IC_DECISION', FALSE, 'Decision', 3, FALSE),
    ('APPROVAL_DATE', 'Decision Date', 'DATE', 'Date the decision was recorded', 'IC_APPROVAL', NULL, FALSE, 'Decision', 4, FALSE),
    ('APPROVAL_ORDER', 'Order', 'INTEGER', 'Display order on the memorandum', 'IC_APPROVAL', NULL, FALSE, 'Decision', 5, FALSE),
    ('OPEN_ITEM_TITLE', 'Item', 'STRING', 'What still has to be done', 'DEAL_OPEN_ITEM', NULL, FALSE, 'Item', 1, FALSE),
    ('OPEN_ITEM_STATUS', 'Status', 'REFERENCE_LIST', 'Open or done', 'DEAL_OPEN_ITEM', 'OPEN_ITEM_STATUS', FALSE, 'Item', 2, FALSE),
    ('OPEN_ITEM_ORDER', 'Order', 'INTEGER', 'Display order', 'DEAL_OPEN_ITEM', NULL, FALSE, 'Item', 3, FALSE)
) AS v(code, name, dtype, descr, dom, list, multi, section, grp, tv)
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
    ('DEAL_MEMO_POINT_STANDARD', 'Standard IC Memo Point', 'DEAL_MEMO_POINT', 'A thesis bullet or a risk and its mitigant'),
    ('DEAL_CAPITAL_ITEM_STANDARD', 'Standard Sources and Uses Line', 'DEAL_CAPITAL_ITEM', 'One line of sources and uses'),
    ('FINANCIAL_PERIOD_STANDARD', 'Standard Financial Period', 'FINANCIAL_PERIOD', 'Revenue, EBITDA, cash flow, and credit ratios for one period'),
    ('IC_APPROVAL_STANDARD', 'Standard IC Approval', 'IC_APPROVAL', 'One committee member decision'),
    ('DEAL_OPEN_ITEM_STANDARD', 'Standard Open Item', 'DEAL_OPEN_ITEM', 'One condition still open on a deal')
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
    'DEAL_MEMO_STATUS','DEAL_TEAM','DEAL_BASE_RATE','DEAL_HOLD_YEARS','DEAL_EXPECTED_MOIC',
    'DEAL_BLENDED_GROSS_IRR','DEAL_RECOMMENDATION','TRANCHE_GROSS_YIELD','TRANCHE_SENIORITY',
    'MEMO_POINT_KIND','MEMO_POINT_TITLE','MEMO_POINT_BODY','MEMO_POINT_ORDER',
    'CAPITAL_SIDE','CAPITAL_LABEL','CAPITAL_AMOUNT','CAPITAL_ORDER',
    'PERIOD_LABEL','PERIOD_BASIS','PERIOD_ORDER','PERIOD_REVENUE','PERIOD_EBITDA','PERIOD_EBITDA_MARGIN',
    'PERIOD_FREE_CASH_FLOW','PERIOD_FUNDED_DEBT_TO_EBITDA','PERIOD_EBITDA_TO_CASH_INTEREST',
    'APPROVAL_MEMBER','APPROVAL_ROLE','APPROVAL_DECISION','APPROVAL_DATE','APPROVAL_ORDER',
    'OPEN_ITEM_TITLE','OPEN_ITEM_STATUS','OPEN_ITEM_ORDER'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('MEMO_POINT_DEAL', 'Memo point on deal', 'DEAL_MEMO_POINT', 'DEAL', 'The deal this thesis bullet or risk belongs to', 'MANY_TO_ONE', TRUE),
    ('CAPITAL_ITEM_DEAL', 'Capital item on deal', 'DEAL_CAPITAL_ITEM', 'DEAL', 'The deal this sources or uses line belongs to', 'MANY_TO_ONE', TRUE),
    ('PERIOD_ISSUER', 'Financial period of issuer', 'FINANCIAL_PERIOD', 'ISSUER', 'The borrower this financial period describes', 'MANY_TO_ONE', TRUE),
    ('APPROVAL_DEAL', 'IC approval of deal', 'IC_APPROVAL', 'DEAL', 'The deal this committee decision is about', 'MANY_TO_ONE', TRUE),
    ('OPEN_ITEM_DEAL', 'Open item on deal', 'DEAL_OPEN_ITEM', 'DEAL', 'The deal this open item belongs to', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    relationship_name = EXCLUDED.relationship_name,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Project Harbor and a memo for every sample deal
-- ============================================================

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
BEGIN
    SELECT client_id INTO v_client
    FROM entity_instances.master_entities
    WHERE entity_code = 'HALY-DEAL-HALYARD';
    IF v_client IS NULL THEN
        SELECT client_id INTO v_client
        FROM entity_instances.master_entities
        WHERE entity_code = 'PIPE-DEAL-NORTHWIND';
    END IF;
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;

    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping IC memo sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_ent (entity_code text, domain_code text, template_code text, entity_name text, description text) ON COMMIT DROP;
    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;
    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    -- Project Harbor: the worked example. A $260mm unitranche, 65% hold.
    INSERT INTO t_ent VALUES
        ('HALY-DEAL-HARBOR', 'DEAL', 'DEAL_STANDARD', 'Project Harbor', 'Unitranche with delayed draw for Harbor Labs.'),
        ('HALY-ISS-HARBOR', 'ISSUER', 'ISSUER_STANDARD', 'Harbor Labs', 'Borrower on Project Harbor.'),
        ('HALY-SPONSOR-OAKLINE-PARTNERS', 'SPONSOR', 'SPONSOR_STANDARD', 'Oakline Partners', 'Sponsor of Harbor Labs.'),
        ('HALY-SEC-HARBOR-TL', 'SECURITY', 'SECURITY_STANDARD', 'Harbor Labs Term Loan', 'Term loan for Project Harbor.'),
        ('HALY-SEC-HARBOR-DDTL', 'SECURITY', 'SECURITY_STANDARD', 'Harbor Labs Delayed Draw Term Loan', 'Delayed draw term loan for Project Harbor.'),
        ('HALY-TR-HARBOR-TL', 'DEAL_TRANCHE', 'DEAL_TRANCHE_STANDARD', 'Project Harbor: Term Loan', 'Funded term loan of Project Harbor.'),
        ('HALY-TR-HARBOR-DDTL', 'DEAL_TRANCHE', 'DEAL_TRANCHE_STANDARD', 'Project Harbor: Delayed Draw Term Loan', 'Unfunded delayed draw of Project Harbor.');

    INSERT INTO t_val VALUES
        ('HALY-DEAL-HARBOR', 'DEAL_STAGE', 'DILIGENCE'),
        ('HALY-DEAL-HARBOR', 'STATUS', 'Active'),
        ('HALY-DEAL-HARBOR', 'DEAL_TYPE', 'Financing'),
        ('HALY-DEAL-HARBOR', 'DEAL_VALUE', '260000000'),
        ('HALY-DEAL-HARBOR', 'DEAL_STRATEGY', 'DIRECT_LENDING'),
        ('HALY-DEAL-HARBOR', 'DEAL_DESCRIPTION', 'Unitranche with delayed draw for Harbor Labs'),
        ('HALY-DEAL-HARBOR', 'DEAL_SECTOR', 'Consumer brands'),
        ('HALY-DEAL-HARBOR', 'DEAL_EBITDA', '40000000'),
        ('HALY-DEAL-HARBOR', 'DEAL_PRICING_SUMMARY', 'SOFR + 500'),
        ('HALY-DEAL-HARBOR', 'DEAL_OID_PRICE', '97.5'),
        ('HALY-DEAL-HARBOR', 'DEAL_LEVERAGE_SENIOR', '4.3'),
        ('HALY-DEAL-HARBOR', 'DEAL_LEVERAGE_TOTAL', '5.0'),
        ('HALY-DEAL-HARBOR', 'DEAL_MATURITY_DATE', '2031-03-31'),
        ('HALY-DEAL-HARBOR', 'DEAL_TARGET_CLOSE_DATE', '2027-03-17'),
        ('HALY-ISS-HARBOR', 'ISSUER_LEGAL_NAME', 'Harbor Labs'),
        ('HALY-ISS-HARBOR', 'SECTOR', 'Consumer brands'),
        ('HALY-SPONSOR-OAKLINE-PARTNERS', 'SPONSOR_NAME', 'Oakline Partners'),
        ('HALY-SPONSOR-OAKLINE-PARTNERS', 'SPONSOR_TYPE', 'Private equity sponsor'),
        ('HALY-SEC-HARBOR-TL', 'INSTRUMENT_TYPE', 'LOAN'),
        ('HALY-SEC-HARBOR-TL', 'ORIGINAL_PRINCIPAL_AMOUNT', '210000000'),
        ('HALY-SEC-HARBOR-TL', 'CURRENCY', 'USD'),
        ('HALY-SEC-HARBOR-TL', 'MATURITY_DATE', '2031-03-31'),
        ('HALY-SEC-HARBOR-TL', 'SPREAD_BPS', '500'),
        ('HALY-SEC-HARBOR-DDTL', 'INSTRUMENT_TYPE', 'DELAYED_DRAW_TERM_LOAN'),
        ('HALY-SEC-HARBOR-DDTL', 'ORIGINAL_PRINCIPAL_AMOUNT', '50000000'),
        ('HALY-SEC-HARBOR-DDTL', 'CURRENCY', 'USD'),
        ('HALY-SEC-HARBOR-DDTL', 'MATURITY_DATE', '2031-03-31'),
        ('HALY-SEC-HARBOR-DDTL', 'SPREAD_BPS', '500'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_SIZE', '210000000'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_RANK', '1'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_IS_UNFUNDED', 'false'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_IS_EQUITY_LINKED', 'false'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_HOLD_PCT', '65'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_PRICING', 'SOFR + 500'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_CALL_PROTECTION', '102 / 101'),
        ('HALY-TR-HARBOR-TL', 'TRANCHE_SENIORITY', '1st lien senior secured'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_SIZE', '50000000'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_RANK', '1'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_IS_UNFUNDED', 'true'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_IS_EQUITY_LINKED', 'false'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_HOLD_PCT', '65'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_PRICING', 'SOFR + 500'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_CALL_PROTECTION', '102 / 101'),
        ('HALY-TR-HARBOR-DDTL', 'TRANCHE_SENIORITY', '1st lien senior secured');

    INSERT INTO t_rel VALUES
        ('HALY-DEAL-HARBOR', 'HALY-ISS-HARBOR', 'DEAL_ISSUER'),
        ('HALY-DEAL-HARBOR', 'HALY-SPONSOR-OAKLINE-PARTNERS', 'DEAL_SPONSOR'),
        ('HALY-DEAL-HARBOR', 'HALY-SEC-HARBOR-TL', 'DEAL_SECURITY'),
        ('HALY-DEAL-HARBOR', 'HALY-SEC-HARBOR-DDTL', 'DEAL_SECURITY'),
        ('HALY-SEC-HARBOR-TL', 'HALY-ISS-HARBOR', 'SECURITY_ISSUER'),
        ('HALY-SEC-HARBOR-DDTL', 'HALY-ISS-HARBOR', 'SECURITY_ISSUER'),
        ('HALY-TR-HARBOR-TL', 'HALY-DEAL-HARBOR', 'TRANCHE_DEAL'),
        ('HALY-TR-HARBOR-DDTL', 'HALY-DEAL-HARBOR', 'TRANCHE_DEAL'),
        ('HALY-TR-HARBOR-TL', 'HALY-SEC-HARBOR-TL', 'TRANCHE_SECURITY'),
        ('HALY-TR-HARBOR-DDTL', 'HALY-SEC-HARBOR-DDTL', 'TRANCHE_SECURITY');

    -- Flush Harbor so the memo section below can read it the same way as the other deals.
    INSERT INTO entity_instances.master_entities (entity_code, domain_code, template_id, entity_name, description, client_id, metadata)
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client, '{"icMemoSample":true}'::jsonb
    FROM t_ent e
    JOIN metadata_register.domain_templates t ON t.template_code = e.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        is_active = TRUE,
        metadata = COALESCE(entity_instances.master_entities.metadata, '{}'::jsonb) || '{"icMemoSample":true}'::jsonb;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND v.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND v.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' AND v.val IN ('true', 'false') THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"icMemoSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
    WHERE NOT EXISTS (
        SELECT 1 FROM golden_master.entity_attribute_values e
        WHERE e.entity_id = me.id AND e.attribute_id = ar.id
          AND (e.system_to IS NULL OR e.system_to >= TIMESTAMP '9999-01-01')
    );

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT DISTINCT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01'
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;

    DELETE FROM t_ent;
    DELETE FROM t_val;
    DELETE FROM t_rel;

    -- Open attribute values already on the sample book, plus Harbor.
    CREATE TEMP TABLE t_open ON COMMIT DROP AS
    SELECT DISTINCT ON (e.entity_id, e.attribute_id)
           me.entity_code, ar.attribute_code, e.golden_value, e.golden_value_numeric, e.golden_value_boolean
    FROM golden_master.entity_attribute_values e
    JOIN entity_instances.master_entities me ON me.id = e.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = e.attribute_id
    WHERE me.entity_code LIKE 'HALY-%'
      AND (e.system_to IS NULL OR e.system_to >= TIMESTAMP '9999-01-01')
      AND ar.attribute_code IN (
          'DEAL_STAGE','DEAL_EBITDA','DEAL_LEVERAGE_TOTAL','DEAL_PRICING_SUMMARY','DEAL_OID_PRICE',
          'DEAL_TARGET_CLOSE_DATE','TRANCHE_SIZE','TRANCHE_IS_UNFUNDED','TRANCHE_RANK','INSTRUMENT_TYPE'
      )
    ORDER BY e.entity_id, e.attribute_id, e.precedence_rank ASC, e.valid_from DESC;

    CREATE TEMP TABLE t_deal ON COMMIT DROP AS
    SELECT me.id, me.entity_code,
           replace(me.entity_code, 'HALY-DEAL-', '') AS suffix,
           me.entity_name,
           stage.golden_value AS stage,
           COALESCE(ebitda.golden_value_numeric, 40000000) AS ebitda,
           lev.golden_value_numeric AS leverage,
           price.golden_value AS pricing,
           oid.golden_value_numeric AS oid,
           close_dt.golden_value AS close_date,
           iss.entity_code AS issuer_code,
           iss.entity_name AS issuer_name
    FROM entity_instances.master_entities me
    LEFT JOIN t_open stage ON stage.entity_code = me.entity_code AND stage.attribute_code = 'DEAL_STAGE'
    LEFT JOIN t_open ebitda ON ebitda.entity_code = me.entity_code AND ebitda.attribute_code = 'DEAL_EBITDA'
    LEFT JOIN t_open lev ON lev.entity_code = me.entity_code AND lev.attribute_code = 'DEAL_LEVERAGE_TOTAL'
    LEFT JOIN t_open price ON price.entity_code = me.entity_code AND price.attribute_code = 'DEAL_PRICING_SUMMARY'
    LEFT JOIN t_open oid ON oid.entity_code = me.entity_code AND oid.attribute_code = 'DEAL_OID_PRICE'
    LEFT JOIN t_open close_dt ON close_dt.entity_code = me.entity_code AND close_dt.attribute_code = 'DEAL_TARGET_CLOSE_DATE'
    LEFT JOIN LATERAL (
        SELECT child.entity_code, child.entity_name
        FROM entity_instances.entity_relationships ir
        JOIN entity_instances.master_entities child ON child.id = ir.child_entity_id
        WHERE ir.parent_entity_id = me.id
          AND ir.relationship_code = 'DEAL_ISSUER'
          AND (ir.system_to IS NULL OR ir.system_to >= TIMESTAMP '9999-01-01')
        ORDER BY ir.is_primary DESC, child.entity_code
        LIMIT 1
    ) iss ON TRUE
    WHERE me.domain_code = 'DEAL' AND me.entity_code LIKE 'HALY-DEAL-%' AND me.is_active;

    -- Header facts. The recommendation stays blank so the memo writes it from the live hold.
    INSERT INTO t_val
    SELECT d.entity_code, a.attr, a.val
    FROM t_deal d
    CROSS JOIN LATERAL (VALUES
        ('DEAL_MEMO_STATUS', CASE d.stage
            WHEN 'COMMITTEE' THEN 'CIRCULATED'
            WHEN 'ALLOCATION' THEN 'APPROVED'
            WHEN 'CLOSING' THEN 'APPROVED'
            WHEN 'CLOSED' THEN 'APPROVED'
            ELSE 'DRAFT' END),
        ('DEAL_TEAM', 'S. Okafor, H. Lindqvist, R. Patel'),
        ('DEAL_IC_DATE', CASE
            WHEN d.entity_code = 'HALY-DEAL-HARBOR' THEN '2027-02-24'
            WHEN d.close_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (d.close_date::date - 21)::text
            ELSE '2027-02-24' END),
        ('DEAL_BASE_RATE', '4.30'),
        ('DEAL_HOLD_YEARS', '3'),
        ('DEAL_EXPECTED_MOIC', '1.30'),
        ('DEAL_BLENDED_GROSS_IRR', CASE
            WHEN d.entity_code = 'HALY-DEAL-HARBOR' THEN '10.1'
            ELSE round(4.30 + COALESCE(substring(d.pricing FROM 'SOFR \+ ([0-9]+)')::numeric, 500) / 100.0 + 0.5, 1)::text
            END)
    ) AS a(attr, val);

    -- Thesis and risks.
    INSERT INTO t_ent
    SELECT 'HALY-POINT-' || d.suffix || '-' || p.kind || p.n::text,
           'DEAL_MEMO_POINT', 'DEAL_MEMO_POINT_STANDARD',
           CASE WHEN p.kind = 'T' THEN 'Thesis ' || p.n::text ELSE p.title END,
           'IC memo point for ' || d.entity_name || '.'
    FROM t_deal d
    CROSS JOIN (VALUES
        ('T', 1, NULL::text, 'Recurring, contracted revenue with low customer churn supports steady cash generation.', NULL::text),
        ('T', 2, NULL, 'The sponsor has committed a meaningful equity cushion beneath our tranche.', NULL),
        ('T', 3, NULL, 'Senior secured position with covenant protection and a conservative attachment point.', NULL),
        ('T', 4, NULL, 'The Delayed Draw Term Loan funds add-on acquisitions with pre-agreed leverage tests.', 'Unfunded capacity funds add-on acquisitions with pre-agreed leverage tests.'),
        ('R', 1, 'Customer concentration', 'Top 10 customers are under 30% of revenue; covenant on minimum liquidity.', NULL),
        ('R', 2, 'Sponsor add-on pace', 'Acquisition draws require leverage and coverage tests at each draw.', NULL),
        ('R', 3, 'Rate sensitivity', 'Interest coverage above 2.0x at base case; hedging requirement in documents.', NULL),
        ('R', 4, 'Sector slowdown', 'Diversified end markets and 25% EBITDA cushion to covenants.', NULL)
    ) AS p(kind, n, title, harbor_body, generic_body);

    INSERT INTO t_val
    SELECT 'HALY-POINT-' || d.suffix || '-' || p.kind || p.n::text, a.attr, a.val
    FROM t_deal d
    CROSS JOIN (VALUES
        ('T', 1, NULL::text, 'Recurring, contracted revenue with low customer churn supports steady cash generation.', NULL::text),
        ('T', 2, NULL, 'The sponsor has committed a meaningful equity cushion beneath our tranche.', NULL),
        ('T', 3, NULL, 'Senior secured position with covenant protection and a conservative attachment point.', NULL),
        ('T', 4, NULL, 'The Delayed Draw Term Loan funds add-on acquisitions with pre-agreed leverage tests.', 'Unfunded capacity funds add-on acquisitions with pre-agreed leverage tests.'),
        ('R', 1, 'Customer concentration', 'Top 10 customers are under 30% of revenue; covenant on minimum liquidity.', NULL),
        ('R', 2, 'Sponsor add-on pace', 'Acquisition draws require leverage and coverage tests at each draw.', NULL),
        ('R', 3, 'Rate sensitivity', 'Interest coverage above 2.0x at base case; hedging requirement in documents.', NULL),
        ('R', 4, 'Sector slowdown', 'Diversified end markets and 25% EBITDA cushion to covenants.', NULL)
    ) AS p(kind, n, title, harbor_body, generic_body)
    CROSS JOIN LATERAL (VALUES
        ('MEMO_POINT_KIND', CASE WHEN p.kind = 'T' THEN 'THESIS' ELSE 'RISK' END),
        ('MEMO_POINT_TITLE', COALESCE(p.title, '')),
        ('MEMO_POINT_BODY', CASE WHEN d.entity_code = 'HALY-DEAL-HARBOR' OR p.generic_body IS NULL THEN p.harbor_body ELSE p.generic_body END),
        ('MEMO_POINT_ORDER', p.n::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL AND a.val <> '';

    INSERT INTO t_rel
    SELECT 'HALY-POINT-' || d.suffix || '-' || p.kind || p.n::text, d.entity_code, 'MEMO_POINT_DEAL'
    FROM t_deal d
    CROSS JOIN (VALUES ('T', 1), ('T', 2), ('T', 3), ('T', 4), ('R', 1), ('R', 2), ('R', 3), ('R', 4)) AS p(kind, n);

    -- Committee and open items. Closed deals are already approved and cleared.
    INSERT INTO t_ent
    SELECT 'HALY-IC-' || d.suffix || '-' || m.n::text, 'IC_APPROVAL', 'IC_APPROVAL_STANDARD',
           m.member || ' on ' || d.entity_name, 'Committee decision for ' || d.entity_name || '.'
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'Dana Whitfield', 'CHAIR'),
        (2, 'Marcus Oyelaran', 'MEMBER'),
        (3, 'Priya Raman', 'MEMBER'),
        (4, 'Elena Sokolova', 'MEMBER'),
        (5, 'Tom Hargrove', 'RISK')
    ) AS m(n, member, role);

    INSERT INTO t_val
    SELECT 'HALY-IC-' || d.suffix || '-' || m.n::text, a.attr, a.val
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'Dana Whitfield', 'CHAIR'),
        (2, 'Marcus Oyelaran', 'MEMBER'),
        (3, 'Priya Raman', 'MEMBER'),
        (4, 'Elena Sokolova', 'MEMBER'),
        (5, 'Tom Hargrove', 'RISK')
    ) AS m(n, member, role)
    CROSS JOIN LATERAL (VALUES
        ('APPROVAL_MEMBER', m.member),
        ('APPROVAL_ROLE', m.role),
        ('APPROVAL_DECISION', CASE WHEN d.stage = 'CLOSED' THEN 'APPROVED' ELSE 'PENDING' END),
        ('APPROVAL_DATE', CASE WHEN d.stage = 'CLOSED' THEN d.close_date END),
        ('APPROVAL_ORDER', m.n::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_rel
    SELECT 'HALY-IC-' || d.suffix || '-' || m.n::text, d.entity_code, 'APPROVAL_DEAL'
    FROM t_deal d
    CROSS JOIN generate_series(1, 5) AS m(n);

    INSERT INTO t_ent
    SELECT 'HALY-OPEN-' || d.suffix || '-' || i.n::text, 'DEAL_OPEN_ITEM', 'DEAL_OPEN_ITEM_STANDARD',
           i.title, 'Open item for ' || d.entity_name || '.'
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'Quality of earnings review'),
        (2, 'Legal diligence and final documents'),
        (3, 'Compliance sign-off on allocation'),
        (4, 'Funding plan approved by Finance'),
        (5, 'Closing conditions satisfied')
    ) AS i(n, title);

    INSERT INTO t_val
    SELECT 'HALY-OPEN-' || d.suffix || '-' || i.n::text, a.attr, a.val
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'Quality of earnings review'),
        (2, 'Legal diligence and final documents'),
        (3, 'Compliance sign-off on allocation'),
        (4, 'Funding plan approved by Finance'),
        (5, 'Closing conditions satisfied')
    ) AS i(n, title)
    CROSS JOIN LATERAL (VALUES
        ('OPEN_ITEM_TITLE', i.title),
        ('OPEN_ITEM_STATUS', CASE WHEN d.stage = 'CLOSED' THEN 'DONE' ELSE 'OPEN' END),
        ('OPEN_ITEM_ORDER', i.n::text)
    ) AS a(attr, val);

    INSERT INTO t_rel
    SELECT 'HALY-OPEN-' || d.suffix || '-' || i.n::text, d.entity_code, 'OPEN_ITEM_DEAL'
    FROM t_deal d
    CROSS JOIN generate_series(1, 5) AS i(n);

    -- Sources and uses. Unfunded tranches stay out. Harbor is the worked example.
    INSERT INTO t_ent VALUES
        ('HALY-CAP-HARBOR-S1', 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'Term Loan', 'Source of Project Harbor.'),
        ('HALY-CAP-HARBOR-S2', 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'Sponsor equity', 'Source of Project Harbor.'),
        ('HALY-CAP-HARBOR-U1', 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'Purchase of equity and refinancing', 'Use of Project Harbor.'),
        ('HALY-CAP-HARBOR-U2', 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'Transaction fees and expenses', 'Use of Project Harbor.');
    INSERT INTO t_val VALUES
        ('HALY-CAP-HARBOR-S1', 'CAPITAL_SIDE', 'SOURCE'),
        ('HALY-CAP-HARBOR-S1', 'CAPITAL_LABEL', 'Term Loan'),
        ('HALY-CAP-HARBOR-S1', 'CAPITAL_AMOUNT', '210000000'),
        ('HALY-CAP-HARBOR-S1', 'CAPITAL_ORDER', '1'),
        ('HALY-CAP-HARBOR-S2', 'CAPITAL_SIDE', 'SOURCE'),
        ('HALY-CAP-HARBOR-S2', 'CAPITAL_LABEL', 'Sponsor equity'),
        ('HALY-CAP-HARBOR-S2', 'CAPITAL_AMOUNT', '212200000'),
        ('HALY-CAP-HARBOR-S2', 'CAPITAL_ORDER', '2'),
        ('HALY-CAP-HARBOR-U1', 'CAPITAL_SIDE', 'USE'),
        ('HALY-CAP-HARBOR-U1', 'CAPITAL_LABEL', 'Purchase of equity and refinancing'),
        ('HALY-CAP-HARBOR-U1', 'CAPITAL_AMOUNT', '417000000'),
        ('HALY-CAP-HARBOR-U1', 'CAPITAL_ORDER', '1'),
        ('HALY-CAP-HARBOR-U2', 'CAPITAL_SIDE', 'USE'),
        ('HALY-CAP-HARBOR-U2', 'CAPITAL_LABEL', 'Transaction fees and expenses'),
        ('HALY-CAP-HARBOR-U2', 'CAPITAL_AMOUNT', '5200000'),
        ('HALY-CAP-HARBOR-U2', 'CAPITAL_ORDER', '2');
    INSERT INTO t_rel VALUES
        ('HALY-CAP-HARBOR-S1', 'HALY-DEAL-HARBOR', 'CAPITAL_ITEM_DEAL'),
        ('HALY-CAP-HARBOR-S2', 'HALY-DEAL-HARBOR', 'CAPITAL_ITEM_DEAL'),
        ('HALY-CAP-HARBOR-U1', 'HALY-DEAL-HARBOR', 'CAPITAL_ITEM_DEAL'),
        ('HALY-CAP-HARBOR-U2', 'HALY-DEAL-HARBOR', 'CAPITAL_ITEM_DEAL');

    CREATE TEMP TABLE t_funded ON COMMIT DROP AS
    SELECT d.entity_code AS deal_code, d.suffix,
           COALESCE(NULLIF(split_part(tr.entity_name, ': ', 2), ''), 'Term Loan') AS label,
           sz.golden_value_numeric AS amount,
           row_number() OVER (PARTITION BY d.id ORDER BY COALESCE(rk.golden_value_numeric, 99), tr.entity_name) AS ord
    FROM t_deal d
    JOIN entity_instances.entity_relationships rel
      ON rel.child_entity_id = d.id AND rel.relationship_code = 'TRANCHE_DEAL'
     AND (rel.system_to IS NULL OR rel.system_to >= TIMESTAMP '9999-01-01')
    JOIN entity_instances.master_entities tr ON tr.id = rel.parent_entity_id
    JOIN t_open sz ON sz.entity_code = tr.entity_code AND sz.attribute_code = 'TRANCHE_SIZE'
    LEFT JOIN t_open unf ON unf.entity_code = tr.entity_code AND unf.attribute_code = 'TRANCHE_IS_UNFUNDED'
    LEFT JOIN t_open rk ON rk.entity_code = tr.entity_code AND rk.attribute_code = 'TRANCHE_RANK'
    WHERE d.entity_code <> 'HALY-DEAL-HARBOR'
      AND COALESCE(unf.golden_value_boolean, false) = false
      AND COALESCE(sz.golden_value_numeric, 0) > 0;

    INSERT INTO t_ent
    SELECT 'HALY-CAP-' || f.suffix || '-S' || f.ord::text, 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD',
           f.label, 'Funded source for ' || f.deal_code || '.'
    FROM t_funded f;
    INSERT INTO t_val
    SELECT 'HALY-CAP-' || f.suffix || '-S' || f.ord::text, a.attr, a.val
    FROM t_funded f
    CROSS JOIN LATERAL (VALUES
        ('CAPITAL_SIDE', 'SOURCE'),
        ('CAPITAL_LABEL', f.label),
        ('CAPITAL_AMOUNT', f.amount::text),
        ('CAPITAL_ORDER', f.ord::text)
    ) AS a(attr, val);
    INSERT INTO t_rel
    SELECT 'HALY-CAP-' || f.suffix || '-S' || f.ord::text, f.deal_code, 'CAPITAL_ITEM_DEAL' FROM t_funded f;

    INSERT INTO t_ent
    SELECT 'HALY-CAP-' || s.suffix || '-' || x.kind, 'DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', x.label, x.label || ' for ' || s.deal_code || '.'
    FROM (
        SELECT deal_code, suffix, sum(amount) AS funded FROM t_funded GROUP BY deal_code, suffix
    ) s
    CROSS JOIN LATERAL (VALUES
        ('EQ', 'Sponsor equity', round(s.funded * 0.45 / 100000) * 100000, 90),
        ('UF', 'Transaction fees and expenses', round(s.funded * 0.025 / 100000) * 100000, 2),
        ('UP', 'Purchase of equity and refinancing',
            s.funded + round(s.funded * 0.45 / 100000) * 100000 - round(s.funded * 0.025 / 100000) * 100000, 1)
    ) AS x(kind, label, amount, ord)
    WHERE x.amount > 0;
    INSERT INTO t_val
    SELECT 'HALY-CAP-' || s.suffix || '-' || x.kind, a.attr, a.val
    FROM (
        SELECT deal_code, suffix, sum(amount) AS funded FROM t_funded GROUP BY deal_code, suffix
    ) s
    CROSS JOIN LATERAL (VALUES
        ('EQ', 'SOURCE', 'Sponsor equity', round(s.funded * 0.45 / 100000) * 100000, 90),
        ('UF', 'USE', 'Transaction fees and expenses', round(s.funded * 0.025 / 100000) * 100000, 2),
        ('UP', 'USE', 'Purchase of equity and refinancing',
            s.funded + round(s.funded * 0.45 / 100000) * 100000 - round(s.funded * 0.025 / 100000) * 100000, 1)
    ) AS x(kind, side, label, amount, ord)
    CROSS JOIN LATERAL (VALUES
        ('CAPITAL_SIDE', x.side),
        ('CAPITAL_LABEL', x.label),
        ('CAPITAL_AMOUNT', x.amount::text),
        ('CAPITAL_ORDER', x.ord::text)
    ) AS a(attr, val)
    WHERE x.amount > 0;
    INSERT INTO t_rel
    SELECT 'HALY-CAP-' || s.suffix || '-' || x.kind, s.deal_code, 'CAPITAL_ITEM_DEAL'
    FROM (
        SELECT deal_code, suffix, sum(amount) AS funded FROM t_funded GROUP BY deal_code, suffix
    ) s
    CROSS JOIN LATERAL (VALUES
        ('EQ', round(s.funded * 0.45 / 100000) * 100000),
        ('UF', round(s.funded * 0.025 / 100000) * 100000),
        ('UP', s.funded)
    ) AS x(kind, amount)
    WHERE x.amount > 0;

    -- Borrower financials. Harbor's EBITDA of $40mm reproduces the worked example.
    INSERT INTO t_ent
    SELECT 'HALY-FIN-' || replace(d.issuer_code, 'HALY-ISS-', '') || '-' || p.code,
           'FINANCIAL_PERIOD', 'FINANCIAL_PERIOD_STANDARD',
           d.issuer_name || ' ' || p.label,
           'Financial period for ' || d.issuer_name || '.'
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'LTM', 'LTM', 'ACTUAL'),
        (2, 'FY27', 'FY27E', 'ESTIMATE'),
        (3, 'FY28', 'FY28E', 'ESTIMATE'),
        (4, 'FY29', 'FY29E', 'ESTIMATE')
    ) AS p(ord, code, label, basis)
    WHERE d.issuer_code IS NOT NULL
      AND d.entity_code = (
          SELECT pick.entity_code FROM t_deal pick
          WHERE pick.issuer_code = d.issuer_code
          ORDER BY (pick.entity_code = 'HALY-DEAL-HARBOR') DESC, pick.entity_code
          LIMIT 1
      );

    INSERT INTO t_val
    SELECT 'HALY-FIN-' || replace(d.issuer_code, 'HALY-ISS-', '') || '-' || p.code, a.attr, a.val
    FROM t_deal d
    CROSS JOIN (VALUES
        (1, 'LTM', 'LTM', 'ACTUAL', 3.405, 1.0, 29.4, 0.08),
        (2, 'FY27', 'FY27E', 'ESTIMATE', 3.6675, 1.1, 30.0, 0.14),
        (3, 'FY28', 'FY28E', 'ESTIMATE', 3.9525, 1.2075, 30.6, 0.2075),
        (4, 'FY29', 'FY29E', 'ESTIMATE', 4.2575, 1.3275, 31.2, 0.2825)
    ) AS p(ord, code, label, basis, rev_x, ebitda_x, margin, fcf_x)
    CROSS JOIN LATERAL (
        SELECT CASE WHEN d.entity_code = 'HALY-DEAL-HARBOR' THEN 5.3 ELSE COALESCE(d.leverage, 5.0) END AS lev0
    ) lev
    CROSS JOIN LATERAL (VALUES
        ('PERIOD_LABEL', p.label),
        ('PERIOD_BASIS', p.basis),
        ('PERIOD_ORDER', p.ord::text),
        ('PERIOD_REVENUE', round(d.ebitda * p.rev_x, 2)::text),
        ('PERIOD_EBITDA', round(d.ebitda * p.ebitda_x, 2)::text),
        ('PERIOD_EBITDA_MARGIN', p.margin::text),
        ('PERIOD_FREE_CASH_FLOW', round(d.ebitda * p.fcf_x, 2)::text),
        ('PERIOD_FUNDED_DEBT_TO_EBITDA', round(lev.lev0 * (ARRAY[1.0, 4.4/5.3, 3.7/5.3, 3.1/5.3])[p.ord], 1)::text),
        ('PERIOD_EBITDA_TO_CASH_INTEREST', (ARRAY[1.8, 2.0, 2.2, 2.5])[p.ord]::text)
    ) AS a(attr, val)
    WHERE d.issuer_code IS NOT NULL
      AND d.entity_code = (
          SELECT pick.entity_code FROM t_deal pick
          WHERE pick.issuer_code = d.issuer_code
          ORDER BY (pick.entity_code = 'HALY-DEAL-HARBOR') DESC, pick.entity_code
          LIMIT 1
      );

    INSERT INTO t_rel
    SELECT DISTINCT 'HALY-FIN-' || replace(d.issuer_code, 'HALY-ISS-', '') || '-' || p.code, d.issuer_code, 'PERIOD_ISSUER'
    FROM t_deal d
    CROSS JOIN (VALUES ('LTM'), ('FY27'), ('FY28'), ('FY29')) AS p(code)
    WHERE d.issuer_code IS NOT NULL
      AND d.entity_code = (
          SELECT pick.entity_code FROM t_deal pick
          WHERE pick.issuer_code = d.issuer_code
          ORDER BY (pick.entity_code = 'HALY-DEAL-HARBOR') DESC, pick.entity_code
          LIMIT 1
      );

    -- Seniority for tranches that do not already say.
    INSERT INTO t_val
    SELECT tr.entity_code, 'TRANCHE_SENIORITY',
           CASE inst.golden_value
               WHEN 'SECOND_LIEN_LOAN' THEN '2nd lien'
               WHEN 'MEZZANINE' THEN 'Subordinated'
               WHEN 'WARRANT' THEN 'Equity-linked'
               WHEN 'PREFERRED_EQUITY' THEN 'Equity-linked'
               ELSE '1st lien senior secured'
           END
    FROM entity_instances.master_entities tr
    JOIN entity_instances.entity_relationships rel
      ON rel.parent_entity_id = tr.id AND rel.relationship_code = 'TRANCHE_SECURITY'
     AND (rel.system_to IS NULL OR rel.system_to >= TIMESTAMP '9999-01-01')
    JOIN entity_instances.master_entities sec ON sec.id = rel.child_entity_id
    JOIN t_open inst ON inst.entity_code = sec.entity_code AND inst.attribute_code = 'INSTRUMENT_TYPE'
    WHERE tr.entity_code LIKE 'HALY-TR-%'
      AND NOT EXISTS (
          SELECT 1 FROM t_open have
          WHERE have.entity_code = tr.entity_code AND have.attribute_code = 'TRANCHE_SENIORITY'
      );

    INSERT INTO entity_instances.master_entities (entity_code, domain_code, template_id, entity_name, description, client_id, metadata)
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client, '{"icMemoSample":true}'::jsonb
    FROM t_ent e
    JOIN metadata_register.domain_templates t ON t.template_code = e.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        is_active = TRUE;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND v.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND v.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' AND v.val IN ('true', 'false') THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"icMemoSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
    WHERE v.val IS NOT NULL AND v.val <> ''
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values e
          WHERE e.entity_id = me.id AND e.attribute_id = ar.id
            AND (e.system_to IS NULL OR e.system_to >= TIMESTAMP '9999-01-01')
      );

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
