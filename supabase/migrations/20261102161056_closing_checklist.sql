-- Closing checklist on a deal.
--
-- A closing condition is one item on the checklist: workstream, owner, due
-- date, and status. A few items point at another tab (compliance, capital
-- structure, funding) and their status is read there, not edited here.
-- A closing document is one agreement, with parties, version, and signatures.
-- The funds flow reuses the deal funding plan: one plan per portfolio, split
-- into cash, the leverage line, and a capital call.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('CLOSING_CONDITION', 'Closing Condition', 'One item on a deal''s closing checklist'),
    ('DEAL_DOCUMENT', 'Deal Document', 'A closing document, its parties, version, and signatures')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('CLOSING_CONDITION', 'DEALS', 130, 'DEAL'),
    ('DEAL_DOCUMENT', 'DEALS', 140, 'DEAL')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CONDITION_WORKSTREAM', 'Closing Workstream', 'CLOSING_CONDITION', 'Section of the closing checklist'),
    ('CONDITION_OWNER', 'Condition Owner', 'CLOSING_CONDITION', 'Who is responsible for a closing condition'),
    ('CONDITION_STATUS', 'Condition Status', 'CLOSING_CONDITION', 'Where a closing condition stands'),
    ('DOCUMENT_STATUS', 'Document Status', 'DEAL_DOCUMENT', 'Where a closing document stands'),
    ('FUNDING_STATUS', 'Funding Status', 'DEAL_FUNDING_PLAN', 'Where a portfolio''s funds flow stands')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CONDITION_WORKSTREAM', 'LEGAL', 'Legal and documentation', 1),
    ('CONDITION_WORKSTREAM', 'DILIGENCE', 'Diligence and approvals', 2),
    ('CONDITION_WORKSTREAM', 'COMPLIANCE', 'Compliance and funding', 3),
    ('CONDITION_WORKSTREAM', 'AGENT', 'Agent and closing', 4),
    ('CONDITION_OWNER', 'COUNSEL', 'Counsel', 1),
    ('CONDITION_OWNER', 'DEAL_TEAM', 'Deal team', 2),
    ('CONDITION_OWNER', 'COMPLIANCE', 'Compliance', 3),
    ('CONDITION_OWNER', 'PORTFOLIO_MANAGER', 'Portfolio manager', 4),
    ('CONDITION_OWNER', 'FINANCE', 'Finance', 5),
    ('CONDITION_OWNER', 'AGENT', 'Agent', 6),
    ('CONDITION_STATUS', 'OPEN', 'Open', 1),
    ('CONDITION_STATUS', 'IN_PROGRESS', 'In progress', 2),
    ('CONDITION_STATUS', 'COMPLETE', 'Complete', 3),
    ('CONDITION_STATUS', 'BLOCKED', 'Blocked', 4),
    ('CONDITION_STATUS', 'WAIVED', 'Waived', 5),
    ('DOCUMENT_STATUS', 'DRAFT', 'Draft', 1),
    ('DOCUMENT_STATUS', 'IN_REVIEW', 'In review', 2),
    ('DOCUMENT_STATUS', 'EXECUTED', 'Executed', 3),
    ('FUNDING_STATUS', 'DRAFT', 'Draft', 1),
    ('FUNDING_STATUS', 'APPROVED', 'Approved', 2),
    ('FUNDING_STATUS', 'ISSUED', 'Issued', 3),
    ('FUNDING_STATUS', 'FUNDED', 'Funded', 4)
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
    ('CONDITION_WORKSTREAM', 'Workstream', 'REFERENCE_LIST', 'Checklist section this condition belongs to', 'CLOSING_CONDITION', 'CONDITION_WORKSTREAM', 'Condition', 1),
    ('CONDITION_OWNER', 'Owner', 'REFERENCE_LIST', 'Who is responsible for clearing the condition', 'CLOSING_CONDITION', 'CONDITION_OWNER', 'Condition', 2),
    ('CONDITION_DUE_DATE', 'Due', 'DATE', 'Date the condition is due', 'CLOSING_CONDITION', NULL, 'Condition', 3),
    ('CONDITION_STATUS', 'Status', 'REFERENCE_LIST', 'Open, in progress, complete, blocked, or waived', 'CLOSING_CONDITION', 'CONDITION_STATUS', 'Condition', 4),
    ('CONDITION_LINK_TAB', 'Linked Tab', 'STRING', 'Deal tab this condition is satisfied from: CAPITAL, COMPLIANCE, or FUNDING', 'CLOSING_CONDITION', NULL, 'Condition', 5),
    ('CONDITION_ORDER', 'Order', 'INTEGER', 'Order of the condition inside its workstream', 'CLOSING_CONDITION', NULL, 'Condition', 6),
    ('DOC_PARTIES', 'Parties', 'STRING', 'Who signs or is named on the document', 'DEAL_DOCUMENT', NULL, 'Document', 1),
    ('DOC_VERSION', 'Version', 'STRING', 'Where drafting stands, for example Not started or Final', 'DEAL_DOCUMENT', NULL, 'Document', 2),
    ('DOC_SIGNATURES_REQUIRED', 'Signatures Required', 'INTEGER', 'Signatures the document needs', 'DEAL_DOCUMENT', NULL, 'Document', 3),
    ('DOC_SIGNATURES_RECEIVED', 'Signatures Received', 'INTEGER', 'Signatures already collected', 'DEAL_DOCUMENT', NULL, 'Document', 4),
    ('DOC_STATUS', 'Status', 'REFERENCE_LIST', 'Draft, in review, or executed', 'DEAL_DOCUMENT', 'DOCUMENT_STATUS', 'Document', 5),
    ('DOC_ORDER', 'Order', 'INTEGER', 'Order of the document on the closing page', 'DEAL_DOCUMENT', NULL, 'Document', 6),
    ('FUNDING_STATUS', 'Status', 'REFERENCE_LIST', 'Draft, approved, issued, or funded', 'DEAL_FUNDING_PLAN', 'FUNDING_STATUS', 'Plan', 8)
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
    ('CLOSING_CONDITION_STANDARD', 'Standard Closing Condition', 'CLOSING_CONDITION', 'One closing checklist item'),
    ('DEAL_DOCUMENT_STANDARD', 'Standard Deal Document', 'DEAL_DOCUMENT', 'One closing document and its signatures')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN ('CONDITION_WORKSTREAM', 'CONDITION_STATUS', 'DOC_STATUS'),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.template_code = CASE a.domain_code
       WHEN 'DEAL_FUNDING_PLAN' THEN 'DEAL_FUNDING_PLAN_STANDARD'
       ELSE a.domain_code || '_STANDARD'
     END
WHERE a.attribute_code IN (
    'CONDITION_WORKSTREAM', 'CONDITION_OWNER', 'CONDITION_DUE_DATE', 'CONDITION_STATUS', 'CONDITION_LINK_TAB', 'CONDITION_ORDER',
    'DOC_PARTIES', 'DOC_VERSION', 'DOC_SIGNATURES_REQUIRED', 'DOC_SIGNATURES_RECEIVED', 'DOC_STATUS', 'DOC_ORDER',
    'FUNDING_STATUS'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('CONDITION_DEAL', 'Condition of deal', 'CLOSING_CONDITION', 'DEAL', 'The deal this closing condition belongs to', 'MANY_TO_ONE', TRUE),
    ('DOC_DEAL', 'Document of deal', 'DEAL_DOCUMENT', 'DEAL', 'The deal this closing document belongs to', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. The deal record and the pipeline surface
-- ============================================================

UPDATE public.record_experiences
SET sections = CASE
        WHEN sections @> '[{"key":"closing"}]'::jsonb THEN sections
        ELSE sections || '[{"key":"closing","title":"Closing","kind":"GRID","placement":"TAB","domainCode":"CLOSING_CONDITION","relationshipCode":"CONDITION_DEAL","direction":"UP","templateCode":"CLOSING_CONDITION_STANDARD","columns":["CONDITION_WORKSTREAM","CONDITION_OWNER","CONDITION_DUE_DATE","CONDITION_STATUS"]}]'::jsonb
    END,
    updated_at = NOW()
WHERE experience_code = 'DEAL_MANAGEMENT';

UPDATE public.surface_definitions
SET description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, Compliance, Syndicate, and Closing are live. Funding and Servicing are on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

UPDATE public.surface_page_slots sl
SET description = 'Closing checklist, documents, and funds flow.'
FROM public.surface_definitions s
WHERE sl.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'CLOSING';

UPDATE public.surface_page_variants v
SET variant_name = 'Closing',
    description = 'Closing checklist, documents, and funds flow.'
FROM public.surface_page_slots sl
JOIN public.surface_definitions s ON s.id = sl.surface_id
WHERE v.slot_id = sl.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'CLOSING';

UPDATE public.surface_components c
SET component_name = 'Closing',
    description = 'Closing checklist, documents, and funds flow.'
FROM public.surface_definitions s
WHERE c.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND c.component_code = 'CLOSING';

-- ============================================================
-- 7. Sample checklist, documents, and funds flow
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
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;

    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping closing sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_deal ON COMMIT DROP AS
    SELECT DISTINCT ON (d.id)
           d.id AS deal_id,
           d.entity_code AS deal_code,
           d.entity_name AS deal_name,
           replace(d.entity_code, 'HALY-DEAL-', '') AS deal_key,
           st.golden_value AS stage,
           COALESCE(cl.golden_value_date, CURRENT_DATE) AS close_date
    FROM entity_instances.master_entities d
    JOIN golden_master.entity_attribute_values st ON st.entity_id = d.id AND st.valid_to = DATE '9999-12-31'
    JOIN metadata_register.attribute_register ar ON ar.id = st.attribute_id AND ar.attribute_code = 'DEAL_STAGE'
    LEFT JOIN golden_master.entity_attribute_values cl
      ON cl.entity_id = d.id AND cl.valid_to = DATE '9999-12-31'
     AND cl.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DEAL_TARGET_CLOSE_DATE')
    WHERE d.entity_code LIKE 'HALY-DEAL-%'
      AND st.golden_value IN ('ALLOCATION', 'CLOSING', 'CLOSED')
    ORDER BY d.id, st.valid_from DESC;

    CREATE TEMP TABLE t_item (
        ord int, stream text, title text, owner text, offset_days int, link_tab text
    ) ON COMMIT DROP;
    INSERT INTO t_item VALUES
        (1, 'LEGAL', 'Credit agreement in agreed form', 'COUNSEL', 14, ''),
        (2, 'LEGAL', 'Fee letter executed', 'DEAL_TEAM', 7, ''),
        (3, 'LEGAL', 'Security and collateral agreements', 'COUNSEL', 5, ''),
        (4, 'LEGAL', 'Legal opinions delivered', 'COUNSEL', 2, ''),
        (5, 'DILIGENCE', 'Quality of earnings review', 'DEAL_TEAM', 40, ''),
        (6, 'DILIGENCE', 'Legal and tax diligence', 'COUNSEL', 25, ''),
        (7, 'DILIGENCE', 'Investment committee approval', 'DEAL_TEAM', 30, ''),
        (8, 'DILIGENCE', 'KYC and sanctions checks', 'COMPLIANCE', 14, ''),
        (9, 'COMPLIANCE', 'Compliance sign-off on allocation', 'COMPLIANCE', 10, 'COMPLIANCE'),
        (10, 'COMPLIANCE', 'Allocation approved and within hold', 'PORTFOLIO_MANAGER', 10, 'CAPITAL'),
        (11, 'COMPLIANCE', 'Funding plan approved by Finance', 'FINANCE', 7, 'FUNDING'),
        (12, 'COMPLIANCE', 'Capital call and line draw notices issued', 'FINANCE', 14, ''),
        (13, 'COMPLIANCE', 'Funds flow memorandum agreed', 'FINANCE', 3, ''),
        (14, 'COMPLIANCE', 'Wire instructions verified by call-back', 'FINANCE', 2, ''),
        (15, 'AGENT', 'Assignment agreements signed by lenders', 'AGENT', 3, ''),
        (16, 'AGENT', 'Borrowing notice delivered to agent', 'AGENT', 3, ''),
        (17, 'AGENT', 'Closing certificate and conditions satisfied', 'COUNSEL', 0, '');

    CREATE TEMP TABLE t_doc (
        ord int, title text, parties text
    ) ON COMMIT DROP;
    INSERT INTO t_doc VALUES
        (1, 'Credit agreement', 'Borrower, agent'),
        (2, 'Fee letter', 'Borrower'),
        (3, 'Security and collateral agreements', 'Borrower, guarantors'),
        (4, 'Assignment agreements', 'Lenders, agent'),
        (5, 'Legal opinions', 'Counsel'),
        (6, 'Closing certificate', 'Borrower');

    CREATE TEMP TABLE t_cond ON COMMIT DROP AS
    SELECT d.deal_key, d.deal_code, d.stage, i.ord, i.stream, i.title, i.owner, i.link_tab,
           CASE
             WHEN d.stage = 'CLOSED' THEN d.close_date - i.offset_days
             WHEN d.close_date <= CURRENT_DATE THEN d.close_date
             WHEN d.close_date - i.offset_days < CURRENT_DATE
               THEN CURRENT_DATE + LEAST(GREATEST((d.close_date - CURRENT_DATE) - (i.offset_days / 4), 0), d.close_date - CURRENT_DATE)
             ELSE d.close_date - i.offset_days
           END AS due_date,
           CASE
             WHEN d.stage = 'CLOSED' THEN 'COMPLETE'
             WHEN d.stage = 'CLOSING' AND i.ord <= 6 THEN 'COMPLETE'
             ELSE 'OPEN'
           END AS status
    FROM t_deal d
    CROSS JOIN t_item i;

    CREATE TEMP TABLE t_flow ON COMMIT DROP AS
    SELECT d.deal_key,
           d.deal_code,
           d.stage,
           port.entity_code AS fund_code,
           port.entity_name AS fund_name,
           replace(port.entity_code, 'HALY-FUND-', '') AS fund_key,
           round(sum(mv.golden_value_numeric), 2) AS funded,
           round(sum(mv.golden_value_numeric * COALESCE(cash.golden_value_numeric, 100) / 100.0), 2) AS cash_amt,
           round(sum(mv.golden_value_numeric * COALESCE(line.golden_value_numeric, 0) / 100.0), 2) AS line_amt,
           round(sum(mv.golden_value_numeric * COALESCE(callamt.golden_value_numeric, 0) / 100.0), 2) AS call_amt
    FROM t_deal d
    JOIN entity_instances.entity_relationships td
      ON td.child_entity_id = d.deal_id AND td.relationship_code = 'TRANCHE_DEAL'
    JOIN entity_instances.master_entities tr ON tr.id = td.parent_entity_id
    JOIN golden_master.entity_attribute_values unf
      ON unf.entity_id = tr.id AND unf.valid_to = DATE '9999-12-31'
     AND unf.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_UNFUNDED')
     AND unf.golden_value_boolean IS NOT TRUE
    JOIN golden_master.entity_attribute_values eq
      ON eq.entity_id = tr.id AND eq.valid_to = DATE '9999-12-31'
     AND eq.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_EQUITY_LINKED')
     AND eq.golden_value_boolean IS NOT TRUE
    JOIN entity_instances.entity_relationships pt
      ON pt.child_entity_id = tr.id AND pt.relationship_code = 'POSITION_TRANCHE'
    JOIN entity_instances.master_entities pos ON pos.id = pt.parent_entity_id
    JOIN golden_master.entity_attribute_values mv
      ON mv.entity_id = pos.id AND mv.valid_to = DATE '9999-12-31'
     AND mv.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'MARKET_VALUE')
    LEFT JOIN golden_master.entity_attribute_values role
      ON role.entity_id = pos.id AND role.valid_to = DATE '9999-12-31'
     AND role.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'POSITION_ALLOCATION_ROLE')
    JOIN entity_instances.entity_relationships pf
      ON pf.parent_entity_id = pos.id AND pf.relationship_code = 'POSITION_FUND'
    JOIN entity_instances.master_entities sleeve ON sleeve.id = pf.child_entity_id
    LEFT JOIN golden_master.entity_attribute_values cash
      ON cash.entity_id = sleeve.id AND cash.valid_to = DATE '9999-12-31'
     AND cash.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'FUND_FUNDING_MIX_CASH_PCT')
    LEFT JOIN golden_master.entity_attribute_values line
      ON line.entity_id = sleeve.id AND line.valid_to = DATE '9999-12-31'
     AND line.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'FUND_FUNDING_MIX_LINE_PCT')
    LEFT JOIN golden_master.entity_attribute_values callamt
      ON callamt.entity_id = sleeve.id AND callamt.valid_to = DATE '9999-12-31'
     AND callamt.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'FUND_FUNDING_MIX_CALL_PCT')
    LEFT JOIN entity_instances.entity_relationships fp
      ON fp.child_entity_id = sleeve.id AND fp.relationship_code = 'FUND_PARENT'
    JOIN entity_instances.master_entities port ON port.id = COALESCE(fp.parent_entity_id, sleeve.id)
    WHERE COALESCE(role.golden_value, '') <> 'LOCK'
      AND mv.golden_value_numeric > 0
    GROUP BY d.deal_key, d.deal_code, d.stage, port.entity_code, port.entity_name;

    -- Put any rounding remainder on the cash leg so the three sources match the funded amount.
    UPDATE t_flow
    SET cash_amt = cash_amt + (funded - cash_amt - line_amt - call_amt);

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent
    SELECT 'HALY-COND-' || deal_key || '-' || lpad(ord::text, 2, '0'),
           'CLOSING_CONDITION', 'CLOSING_CONDITION_STANDARD', title, 'Closing checklist item.'
    FROM t_cond;

    INSERT INTO t_ent
    SELECT 'HALY-DOC-' || d.deal_key || '-' || lpad(doc.ord::text, 2, '0'),
           'DEAL_DOCUMENT', 'DEAL_DOCUMENT_STANDARD', doc.title, 'Closing document.'
    FROM t_deal d
    CROSS JOIN t_doc doc;

    INSERT INTO t_ent
    SELECT 'HALY-FLOW-' || deal_key || '-' || fund_key,
           'DEAL_FUNDING_PLAN', 'DEAL_FUNDING_PLAN_STANDARD',
           fund_name || ' funds flow', 'How this portfolio funds its share at close.'
    FROM t_flow;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"closingSample":true}'::jsonb
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
    SELECT 'HALY-COND-' || deal_key || '-' || lpad(ord::text, 2, '0'), a.attr, a.val
    FROM t_cond c
    CROSS JOIN LATERAL (VALUES
        ('CONDITION_WORKSTREAM', c.stream),
        ('CONDITION_OWNER', c.owner),
        ('CONDITION_DUE_DATE', c.due_date::text),
        ('CONDITION_STATUS', c.status),
        ('CONDITION_LINK_TAB', NULLIF(c.link_tab, '')),
        ('CONDITION_ORDER', c.ord::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HALY-DOC-' || d.deal_key || '-' || lpad(doc.ord::text, 2, '0'), a.attr, a.val
    FROM t_deal d
    CROSS JOIN t_doc doc
    CROSS JOIN LATERAL (VALUES
        ('DOC_PARTIES', doc.parties),
        ('DOC_VERSION', CASE WHEN d.stage = 'CLOSED' THEN 'Final' WHEN d.stage = 'CLOSING' THEN 'In review' ELSE 'Not started' END),
        ('DOC_SIGNATURES_REQUIRED', '6'),
        ('DOC_SIGNATURES_RECEIVED', CASE WHEN d.stage = 'CLOSED' THEN '6' WHEN d.stage = 'CLOSING' THEN '2' ELSE '0' END),
        ('DOC_STATUS', CASE WHEN d.stage = 'CLOSED' THEN 'EXECUTED' WHEN d.stage = 'CLOSING' THEN 'IN_REVIEW' ELSE 'DRAFT' END),
        ('DOC_ORDER', doc.ord::text)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-FLOW-' || deal_key || '-' || fund_key, a.attr, a.val
    FROM t_flow f
    CROSS JOIN LATERAL (VALUES
        ('FUNDING_CASH_AMOUNT', f.cash_amt::text),
        ('FUNDING_LINE_AMOUNT', f.line_amt::text),
        ('FUNDING_CALL_AMOUNT', f.call_amt::text),
        ('FUNDING_STATUS', CASE f.stage WHEN 'CLOSED' THEN 'FUNDED' WHEN 'CLOSING' THEN 'APPROVED' ELSE 'DRAFT' END),
        ('FUNDING_ORDER_POLICY', 'POLICY'),
        ('FUNDING_IS_MANUAL', 'false')
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

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
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"closingSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel
    SELECT 'HALY-COND-' || deal_key || '-' || lpad(ord::text, 2, '0'), deal_code, 'CONDITION_DEAL'
    FROM t_cond;

    INSERT INTO t_rel
    SELECT 'HALY-DOC-' || d.deal_key || '-' || lpad(doc.ord::text, 2, '0'), d.deal_code, 'DOC_DEAL'
    FROM t_deal d
    CROSS JOIN t_doc doc;

    INSERT INTO t_rel
    SELECT 'HALY-FLOW-' || deal_key || '-' || fund_key, deal_code, 'FUNDING_DEAL'
    FROM t_flow;

    INSERT INTO t_rel
    SELECT 'HALY-FLOW-' || deal_key || '-' || fund_key, fund_code, 'FUNDING_FUND'
    FROM t_flow;

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
