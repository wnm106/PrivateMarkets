-- Quarterly borrower statements for the deal Financials tab.
--
-- A statement period is one quarter of the borrower. The income-statement
-- drivers and the balance-sheet balances are stored. Gross profit, EBITDA,
-- equity, the cash-flow statement, and the trailing twelve months are
-- computed when the page is read, so the three statements stay in balance.
-- These periods are separate from the IC memo's FINANCIAL_PERIOD summaries.

-- ============================================================
-- 1. Domain
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('STATEMENT_PERIOD', 'Statement Period', 'One quarter of a borrower''s income statement and balance sheet')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = 180,
    parent_domain_code = 'ISSUER',
    is_core = FALSE,
    updated_at = NOW()
FROM metadata_register.domain_groups g
WHERE g.group_code = 'DEALS' AND dt.domain_code = 'STATEMENT_PERIOD';

-- ============================================================
-- 2. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, 'STATEMENT_PERIOD',
       NULL, FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE'
FROM (VALUES
    ('STATEMENT_END', 'Period End', 'DATE', 'Quarter-end date', 'Period', 1),
    ('STATEMENT_REVENUE', 'Revenue', 'CURRENCY', 'Revenue for the quarter', 'Income', 2),
    ('STATEMENT_COGS', 'Cost of Revenue', 'CURRENCY', 'Cost of revenue for the quarter', 'Income', 3),
    ('STATEMENT_SM', 'Sales and Marketing', 'CURRENCY', 'Sales and marketing expense for the quarter', 'Income', 4),
    ('STATEMENT_RD', 'Research and Development', 'CURRENCY', 'Research and development expense for the quarter', 'Income', 5),
    ('STATEMENT_GA', 'General and Administrative', 'CURRENCY', 'General and administrative expense for the quarter', 'Income', 6),
    ('STATEMENT_DA', 'Depreciation and Amortization', 'CURRENCY', 'Depreciation and amortization for the quarter', 'Income', 7),
    ('STATEMENT_INTEREST', 'Interest Expense', 'CURRENCY', 'Interest expense for the quarter', 'Income', 8),
    ('STATEMENT_TAX', 'Income Tax', 'CURRENCY', 'Income tax expense for the quarter', 'Income', 9),
    ('STATEMENT_CASH', 'Cash', 'CURRENCY', 'Cash and equivalents at quarter end', 'Balance sheet', 10),
    ('STATEMENT_AR', 'Accounts Receivable', 'CURRENCY', 'Accounts receivable at quarter end', 'Balance sheet', 11),
    ('STATEMENT_PREPAID', 'Prepaid Expenses', 'CURRENCY', 'Prepaid expenses at quarter end', 'Balance sheet', 12),
    ('STATEMENT_PPE', 'Property and Equipment', 'CURRENCY', 'Property and equipment, net, at quarter end', 'Balance sheet', 13),
    ('STATEMENT_GOODWILL', 'Goodwill and Intangibles', 'CURRENCY', 'Goodwill and intangibles at quarter end', 'Balance sheet', 14),
    ('STATEMENT_AP', 'Accounts Payable', 'CURRENCY', 'Accounts payable at quarter end', 'Balance sheet', 15),
    ('STATEMENT_ACCRUED', 'Accrued Liabilities', 'CURRENCY', 'Accrued liabilities at quarter end', 'Balance sheet', 16),
    ('STATEMENT_DEFERRED', 'Deferred Revenue', 'CURRENCY', 'Deferred revenue at quarter end', 'Balance sheet', 17),
    ('STATEMENT_DEBT', 'Term Loan', 'CURRENCY', 'Term loan at quarter end', 'Balance sheet', 18),
    ('STATEMENT_CONTRIBUTED', 'Contributed Capital', 'CURRENCY', 'Contributed capital and opening reserves', 'Balance sheet', 19)
) AS v(code, name, dtype, descr, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 3. Template and relationship
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('STATEMENT_PERIOD_STANDARD', 'Standard Statement Period', 'STATEMENT_PERIOD', 'One quarter of income-statement drivers and balance-sheet balances')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, a.attribute_code IN ('STATEMENT_END', 'STATEMENT_REVENUE'), 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'STATEMENT_PERIOD_STANDARD'
WHERE a.attribute_code LIKE 'STATEMENT_%'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('STATEMENT_ISSUER', 'Statement of issuer', 'STATEMENT_PERIOD', 'ISSUER', 'The borrower this quarter describes', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 4. The pipeline surface
-- ============================================================

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, 'FINANCIALS', 'Financials', 'Borrower income statement, balance sheet, and cash flow.', 8, 'always'
FROM public.surface_definitions s
WHERE s.surface_code = 'DEAL_PIPELINE'
ON CONFLICT (surface_id, slot_code) DO UPDATE
SET slot_name = EXCLUDED.slot_name,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, 'FINANCIALS', 'Financials', 'Borrower income statement, balance sheet, and cash flow.', 100
FROM public.surface_page_slots sl
JOIN public.surface_definitions s ON s.id = sl.surface_id
WHERE s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'FINANCIALS'
ON CONFLICT (slot_id, variant_code) DO UPDATE
SET variant_name = EXCLUDED.variant_name,
    description = EXCLUDED.description;

INSERT INTO public.surface_components (
    surface_id, slot_id, variant_id, experience_id, component_code, component_name, description, display_order
)
SELECT s.id, sl.id, v.id, e.id, 'FINANCIALS', 'Financials', 'Borrower income statement, balance sheet, and cash flow.', 1
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = 'FINANCIALS'
JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = 'FINANCIALS'
JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = 'DEAL_BASELINE'
WHERE s.surface_code = 'DEAL_PIPELINE'
ON CONFLICT (surface_id, component_code) DO UPDATE
SET slot_id = EXCLUDED.slot_id,
    variant_id = EXCLUDED.variant_id,
    experience_id = EXCLUDED.experience_id,
    component_name = EXCLUDED.component_name,
    description = EXCLUDED.description;

UPDATE public.surface_definitions
SET description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, Compliance, Syndicate, Closing, Servicing, and Financials are live. Funding is on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

-- ============================================================
-- 5. Sample quarters, scaled to each borrower's LTM EBITDA
-- ============================================================

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'HALY-DEAL-HALYARD';
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;
    SELECT id INTO v_src FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping statements: client % source %', v_client, v_src;
        RETURN;
    END IF;

    -- Prefer the IC memo's LTM EBITDA. Issuers without a memo period use the
    -- deal's borrower EBITDA, so every sample borrower gets a statement set.
    CREATE TEMP TABLE t_iss ON COMMIT DROP AS
    SELECT i.entity_code AS issuer_code,
           replace(i.entity_code, 'HALY-ISS-', '') AS iss_key,
           i.entity_name AS issuer_name,
           COALESCE(eb.golden_value_numeric, de.golden_value_numeric) AS ebitda
    FROM entity_instances.master_entities i
    LEFT JOIN LATERAL (
        SELECT eb.golden_value_numeric
        FROM entity_instances.entity_relationships r
        JOIN entity_instances.master_entities p ON p.id = r.parent_entity_id
        JOIN golden_master.entity_attribute_values eb
          ON eb.entity_id = p.id AND eb.valid_to = DATE '9999-12-31'
         AND eb.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'PERIOD_EBITDA')
        WHERE r.child_entity_id = i.id
          AND r.relationship_code = 'PERIOD_ISSUER'
          AND p.entity_code LIKE 'HALY-FIN-%-LTM'
          AND eb.golden_value_numeric > 0
        LIMIT 1
    ) eb ON TRUE
    LEFT JOIN LATERAL (
        SELECT de.golden_value_numeric
        FROM entity_instances.entity_relationships dr
        JOIN golden_master.entity_attribute_values de
          ON de.entity_id = dr.parent_entity_id AND de.valid_to = DATE '9999-12-31'
         AND de.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DEAL_EBITDA')
        WHERE dr.child_entity_id = i.id
          AND dr.relationship_code = 'DEAL_ISSUER'
          AND de.golden_value_numeric > 0
        ORDER BY de.golden_value_numeric DESC
        LIMIT 1
    ) de ON TRUE
    WHERE i.domain_code = 'ISSUER'
      AND i.entity_code LIKE 'HALY-ISS-%'
      AND COALESCE(eb.golden_value_numeric, de.golden_value_numeric) > 0;

    CREATE TEMP TABLE t_q ON COMMIT DROP AS
    WITH factors AS (
        SELECT (power(1.03, 5) + power(1.03, 6) + power(1.03, 7) + power(1.03, 8)) AS factor_sum
    ),
    base AS (
        SELECT s.*,
               g.idx,
               (DATE '2024-09-30' + make_interval(months => g.idx * 3))::date AS end_date,
               (s.ebitda / 0.294) / f.factor_sum * power(1.03, g.idx) AS revenue
        FROM t_iss s
        CROSS JOIN factors f
        CROSS JOIN generate_series(0, 12) AS g(idx)
    ),
    income AS (
        SELECT b.*,
               b.revenue * 0.306 AS cogs,
               (b.revenue - b.revenue * 0.306 - b.revenue * 0.294) * 0.425 AS sm,
               (b.revenue - b.revenue * 0.306 - b.revenue * 0.294) * 0.350 AS rd,
               (b.revenue - b.revenue * 0.306 - b.revenue * 0.294) * 0.225 AS ga,
               b.revenue * 0.294 * 0.085 AS da,
               b.revenue * 0.294 * 0.356 AS interest,
               b.revenue * 0.028 AS capex
        FROM base b
    ),
    taxed AS (
        SELECT i.*,
               GREATEST((i.revenue * 0.294) - i.da - i.interest, 0) * 0.25 AS tax
        FROM income i
    ),
    rolled AS (
        SELECT t.*,
               (t.revenue - t.cogs - t.sm - t.rd - t.ga - t.da - t.interest - t.tax) AS net_income,
               (t.ebitda / 0.294) * 0.241
                 + COALESCE(sum(t.capex - t.da) OVER (PARTITION BY t.iss_key ORDER BY t.idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS ppe,
               sum(t.revenue - t.cogs - t.sm - t.rd - t.ga - t.da - t.interest - t.tax)
                 OVER (PARTITION BY t.iss_key ORDER BY t.idx) AS retained,
               t.ebitda * 3.7 * (1 - 0.0025 * (t.idx - 8)) AS debt,
               (t.ebitda / 0.294) * 0.871 AS goodwill,
               (t.ebitda / 0.294) * 0.10 AS contributed
        FROM taxed t
    )
    SELECT r.iss_key, r.issuer_code, r.issuer_name, r.idx, r.end_date,
           round(r.revenue, 2) AS revenue,
           round(r.cogs, 2) AS cogs,
           round(r.sm, 2) AS sm,
           round(r.rd, 2) AS rd,
           round(r.ga, 2) AS ga,
           round(r.da, 2) AS da,
           round(r.interest, 2) AS interest,
           round(r.tax, 2) AS tax,
           round(r.revenue * 0.30, 2) AS ar,
           round(r.revenue * 0.133, 2) AS prepaid,
           round(r.ppe, 2) AS ppe,
           round(r.goodwill, 2) AS goodwill,
           round(r.revenue * 0.213, 2) AS ap,
           round(r.revenue * 0.107, 2) AS accrued,
           round(r.revenue * 0.301, 2) AS deferred,
           round(r.debt, 2) AS debt,
           round(r.contributed, 2) AS contributed,
           round(r.retained, 2) AS retained
    FROM rolled r;

    ALTER TABLE t_q ADD COLUMN cash numeric;
    UPDATE t_q
    SET cash = round(
        (ap + accrued + deferred + debt + contributed + retained)
        - (ar + prepaid + ppe + goodwill),
        2);

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;
    INSERT INTO t_ent
    SELECT 'HALY-STMT-' || iss_key || '-' || to_char(end_date, 'YYYYMM'),
           'STATEMENT_PERIOD', 'STATEMENT_PERIOD_STANDARD',
           issuer_name || ' ' || to_char(end_date, 'Mon YYYY'),
           'Quarterly statement for ' || issuer_name || '.'
    FROM t_q;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"statementSample":true}'::jsonb
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
    SELECT 'HALY-STMT-' || iss_key || '-' || to_char(end_date, 'YYYYMM'), a.attr, a.val
    FROM t_q q
    CROSS JOIN LATERAL (VALUES
        ('STATEMENT_END', q.end_date::text),
        ('STATEMENT_REVENUE', q.revenue::text),
        ('STATEMENT_COGS', q.cogs::text),
        ('STATEMENT_SM', q.sm::text),
        ('STATEMENT_RD', q.rd::text),
        ('STATEMENT_GA', q.ga::text),
        ('STATEMENT_DA', q.da::text),
        ('STATEMENT_INTEREST', q.interest::text),
        ('STATEMENT_TAX', q.tax::text),
        ('STATEMENT_CASH', q.cash::text),
        ('STATEMENT_AR', q.ar::text),
        ('STATEMENT_PREPAID', q.prepaid::text),
        ('STATEMENT_PPE', q.ppe::text),
        ('STATEMENT_GOODWILL', q.goodwill::text),
        ('STATEMENT_AP', q.ap::text),
        ('STATEMENT_ACCRUED', q.accrued::text),
        ('STATEMENT_DEFERRED', q.deferred::text),
        ('STATEMENT_DEBT', q.debt::text),
        ('STATEMENT_CONTRIBUTED', q.contributed::text)
    ) AS a(attr, val);

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
           NULL,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"statementSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT DISTINCT p.id, c.id, rt.relationship_name, 'STATEMENT_ISSUER', TRUE, DATE '2020-01-01'
    FROM t_q q
    JOIN entity_instances.master_entities p ON p.entity_code = 'HALY-STMT-' || q.iss_key || '-' || to_char(q.end_date, 'YYYYMM')
    JOIN entity_instances.master_entities c ON c.entity_code = q.issuer_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = 'STATEMENT_ISSUER'
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
