-- Servicing on a deal.
--
-- The monthly roll-forward and the quarterly payment schedule are computed
-- from the facility terms, our hold, and the expected draws. What is stored
-- is the terms (index, undrawn fee, amortization, rating, mark), each
-- expected draw, each covenant, and each reporting date.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('EXPECTED_DRAW', 'Expected Draw', 'A future draw on an unfunded tranche, and our share of it'),
    ('DEAL_COVENANT', 'Deal Covenant', 'A maintenance covenant on a deal and its latest reading'),
    ('REPORTING_OBLIGATION', 'Reporting Obligation', 'A financial statement or compliance certificate the borrower owes')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('EXPECTED_DRAW', 'DEALS', 150, 'DEAL'),
    ('DEAL_COVENANT', 'DEALS', 160, 'DEAL'),
    ('REPORTING_OBLIGATION', 'DEALS', 170, 'DEAL')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('SERVICING_RATING', 'Servicing Rating', 'DEAL', 'Internal performing scale used on the servicing page'),
    ('DRAW_STATUS', 'Draw Status', 'EXPECTED_DRAW', 'Whether a draw is still a projection'),
    ('COVENANT_DIRECTION', 'Covenant Direction', 'DEAL_COVENANT', 'Whether the covenant is a maximum or a minimum'),
    ('COVENANT_UNIT', 'Covenant Unit', 'DEAL_COVENANT', 'How a covenant level is expressed')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('SERVICING_RATING', 'R1', '1 Exceptional', 1),
    ('SERVICING_RATING', 'R2', '2 Performing', 2),
    ('SERVICING_RATING', 'R3', '3 Watch', 3),
    ('SERVICING_RATING', 'R4', '4 Special mention', 4),
    ('SERVICING_RATING', 'R5', '5 Default', 5),
    ('DRAW_STATUS', 'PROJECTED', 'Projected', 1),
    ('DRAW_STATUS', 'ACTUAL', 'Actual', 2),
    ('COVENANT_DIRECTION', 'MAX', 'Maximum', 1),
    ('COVENANT_DIRECTION', 'MIN', 'Minimum', 2),
    ('COVENANT_UNIT', 'MULTIPLE', 'Multiple', 1),
    ('COVENANT_UNIT', 'CURRENCY', 'Currency', 2)
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
    ('SERVICING_INDEX_RATE', 'Index Rate', 'PERCENTAGE', 'Base rate, such as SOFR, used to project cash interest', 'DEAL', NULL, 'Servicing', 1),
    ('SERVICING_UNDRAWN_FEE_PCT', 'Undrawn Fee', 'PERCENTAGE', 'Annual fee on the undrawn commitment', 'DEAL', NULL, 'Servicing', 2),
    ('SERVICING_PIK_RATE', 'PIK Rate', 'PERCENTAGE', 'Annual pay-in-kind rate. Zero when the coupon is all cash.', 'DEAL', NULL, 'Servicing', 3),
    ('SERVICING_AMORTIZATION_PCT', 'Quarterly Amortization', 'PERCENTAGE', 'Principal repaid each quarter, as a percent of the original funded amount', 'DEAL', NULL, 'Servicing', 4),
    ('SERVICING_RATING', 'Internal Rating', 'REFERENCE_LIST', 'Internal performing rating', 'DEAL', 'SERVICING_RATING', 'Servicing', 5),
    ('SERVICING_MARK', 'Mark', 'DECIMAL', 'Internal mark, as a percent of par', 'DEAL', NULL, 'Servicing', 6),
    ('SERVICING_MARK_DATE', 'Mark Date', 'DATE', 'Date the internal mark was set', 'DEAL', NULL, 'Servicing', 7),
    ('DRAW_DATE', 'Date', 'DATE', 'Date the draw is expected', 'EXPECTED_DRAW', NULL, 'Draw', 1),
    ('DRAW_PURPOSE', 'Purpose', 'STRING', 'What the draw funds', 'EXPECTED_DRAW', NULL, 'Draw', 2),
    ('DRAW_AMOUNT', 'Our Share', 'CURRENCY', 'Our share of the draw at the hold when it was recorded', 'EXPECTED_DRAW', NULL, 'Draw', 3),
    ('DRAW_SHARE_PCT', 'Share of Commitment', 'PERCENTAGE', 'Percent of the unfunded commitment this draw takes', 'EXPECTED_DRAW', NULL, 'Draw', 5),
    ('DRAW_STATUS', 'Status', 'REFERENCE_LIST', 'Projected until the draw funds', 'EXPECTED_DRAW', 'DRAW_STATUS', 'Draw', 4),
    ('COVENANT_DIRECTION', 'Direction', 'REFERENCE_LIST', 'Maximum or minimum', 'DEAL_COVENANT', 'COVENANT_DIRECTION', 'Covenant', 1),
    ('COVENANT_LEVEL', 'Level', 'DECIMAL', 'The covenant level', 'DEAL_COVENANT', NULL, 'Covenant', 2),
    ('COVENANT_CURRENT', 'Current', 'DECIMAL', 'The latest reading', 'DEAL_COVENANT', NULL, 'Covenant', 3),
    ('COVENANT_UNIT', 'Unit', 'REFERENCE_LIST', 'Multiple or currency', 'DEAL_COVENANT', 'COVENANT_UNIT', 'Covenant', 4),
    ('COVENANT_FIRST_TEST', 'First Test', 'DATE', 'Date of the first covenant test', 'DEAL_COVENANT', NULL, 'Covenant', 5),
    ('REPORT_DUE_DATE', 'Due', 'DATE', 'Date the report is due', 'REPORTING_OBLIGATION', NULL, 'Report', 1)
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
    ('EXPECTED_DRAW_STANDARD', 'Standard Expected Draw', 'EXPECTED_DRAW', 'One projected or actual draw'),
    ('DEAL_COVENANT_STANDARD', 'Standard Deal Covenant', 'DEAL_COVENANT', 'One maintenance covenant'),
    ('REPORTING_OBLIGATION_STANDARD', 'Standard Reporting Obligation', 'REPORTING_OBLIGATION', 'One borrower report')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN ('DRAW_DATE', 'DRAW_AMOUNT', 'COVENANT_DIRECTION', 'COVENANT_LEVEL', 'REPORT_DUE_DATE'),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'SERVICING_INDEX_RATE', 'SERVICING_UNDRAWN_FEE_PCT', 'SERVICING_PIK_RATE', 'SERVICING_AMORTIZATION_PCT',
    'SERVICING_RATING', 'SERVICING_MARK', 'SERVICING_MARK_DATE',
    'DRAW_DATE', 'DRAW_PURPOSE', 'DRAW_AMOUNT', 'DRAW_SHARE_PCT', 'DRAW_STATUS',
    'COVENANT_DIRECTION', 'COVENANT_LEVEL', 'COVENANT_CURRENT', 'COVENANT_UNIT', 'COVENANT_FIRST_TEST',
    'REPORT_DUE_DATE'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('DRAW_DEAL', 'Draw of deal', 'EXPECTED_DRAW', 'DEAL', 'The deal this draw belongs to', 'MANY_TO_ONE', TRUE),
    ('DRAW_TRANCHE', 'Draw of tranche', 'EXPECTED_DRAW', 'DEAL_TRANCHE', 'The tranche being drawn', 'MANY_TO_ONE', TRUE),
    ('COVENANT_DEAL', 'Covenant of deal', 'DEAL_COVENANT', 'DEAL', 'The deal this covenant belongs to', 'MANY_TO_ONE', TRUE),
    ('REPORT_DEAL', 'Report of deal', 'REPORTING_OBLIGATION', 'DEAL', 'The deal this report belongs to', 'MANY_TO_ONE', TRUE)
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
        WHEN sections @> '[{"key":"servicing"}]'::jsonb THEN sections
        ELSE sections || '[{"key":"servicing","title":"Servicing","kind":"GRID","placement":"TAB","domainCode":"DEAL_COVENANT","relationshipCode":"COVENANT_DEAL","direction":"UP","templateCode":"DEAL_COVENANT_STANDARD","columns":["COVENANT_DIRECTION","COVENANT_LEVEL","COVENANT_CURRENT","COVENANT_FIRST_TEST"]}]'::jsonb
    END,
    updated_at = NOW()
WHERE experience_code = 'DEAL_MANAGEMENT';

UPDATE public.surface_definitions
SET description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, Compliance, Syndicate, Closing, and Servicing are live. Funding is on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

UPDATE public.surface_page_slots sl
SET description = 'Cash flow roll-forward, payment schedule, draws, commitment usage, covenants, and reporting.'
FROM public.surface_definitions s
WHERE sl.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'SERVICING';

UPDATE public.surface_page_variants v
SET variant_name = 'Servicing',
    description = 'Cash flow roll-forward, payment schedule, draws, commitment usage, covenants, and reporting.'
FROM public.surface_page_slots sl
JOIN public.surface_definitions s ON s.id = sl.surface_id
WHERE v.slot_id = sl.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'SERVICING';

UPDATE public.surface_components c
SET component_name = 'Servicing',
    description = 'Cash flow roll-forward, payment schedule, draws, commitment usage, covenants, and reporting.'
FROM public.surface_definitions s
WHERE c.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND c.component_code = 'SERVICING';

-- ============================================================
-- 7. Sample terms, draws, covenants, and reports
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
        RAISE NOTICE 'Skipping servicing sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_deal ON COMMIT DROP AS
    SELECT DISTINCT ON (d.id)
           d.id AS deal_id,
           d.entity_code AS deal_code,
           replace(d.entity_code, 'HALY-DEAL-', '') AS deal_key,
           st.golden_value AS stage,
           COALESCE(sg.golden_value, '') AS strategy,
           COALESCE(cl.golden_value_date, CURRENT_DATE) AS close_date,
           lev.golden_value_numeric AS leverage
    FROM entity_instances.master_entities d
    JOIN golden_master.entity_attribute_values st ON st.entity_id = d.id AND st.valid_to = DATE '9999-12-31'
    JOIN metadata_register.attribute_register ar ON ar.id = st.attribute_id AND ar.attribute_code = 'DEAL_STAGE'
    LEFT JOIN golden_master.entity_attribute_values sg
      ON sg.entity_id = d.id AND sg.valid_to = DATE '9999-12-31'
     AND sg.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DEAL_STRATEGY')
    LEFT JOIN golden_master.entity_attribute_values cl
      ON cl.entity_id = d.id AND cl.valid_to = DATE '9999-12-31'
     AND cl.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DEAL_TARGET_CLOSE_DATE')
    LEFT JOIN golden_master.entity_attribute_values lev
      ON lev.entity_id = d.id AND lev.valid_to = DATE '9999-12-31'
     AND lev.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DEAL_LEVERAGE_TOTAL')
    WHERE d.entity_code LIKE 'HALY-DEAL-%'
      AND st.golden_value IN ('ALLOCATION', 'CLOSING', 'CLOSED')
    ORDER BY d.id, st.valid_from DESC;

    CREATE TEMP TABLE t_line ON COMMIT DROP AS
    SELECT x.deal_key, sum(x.amount) AS unfunded
    FROM (
        SELECT d.deal_key,
               port.entity_code AS fund_code,
               sum(mv.golden_value_numeric) AS amount
        FROM t_deal d
        JOIN entity_instances.entity_relationships td
          ON td.child_entity_id = d.deal_id AND td.relationship_code = 'TRANCHE_DEAL'
        JOIN entity_instances.master_entities tr ON tr.id = td.parent_entity_id
        JOIN golden_master.entity_attribute_values unf
          ON unf.entity_id = tr.id AND unf.valid_to = DATE '9999-12-31'
         AND unf.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_UNFUNDED')
         AND unf.golden_value_boolean IS TRUE
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
        LEFT JOIN entity_instances.entity_relationships fp
          ON fp.child_entity_id = sleeve.id AND fp.relationship_code = 'FUND_PARENT'
        JOIN entity_instances.master_entities port ON port.id = COALESCE(fp.parent_entity_id, sleeve.id)
        WHERE COALESCE(role.golden_value, '') <> 'LOCK'
          AND mv.golden_value_numeric > 0
        GROUP BY d.deal_key, port.entity_code
    ) x
    GROUP BY x.deal_key;

    CREATE TEMP TABLE t_ddtl ON COMMIT DROP AS
    SELECT DISTINCT ON (d.deal_key)
           d.deal_key,
           tr.entity_code AS tranche_code,
           sz.golden_value_numeric * COALESCE(hd.golden_value_numeric, 100) / 100.0 AS our_unfunded
    FROM t_deal d
    JOIN entity_instances.entity_relationships td
      ON td.child_entity_id = d.deal_id AND td.relationship_code = 'TRANCHE_DEAL'
    JOIN entity_instances.master_entities tr ON tr.id = td.parent_entity_id
    JOIN golden_master.entity_attribute_values unf
      ON unf.entity_id = tr.id AND unf.valid_to = DATE '9999-12-31'
     AND unf.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_UNFUNDED')
     AND unf.golden_value_boolean IS TRUE
    JOIN golden_master.entity_attribute_values sz
      ON sz.entity_id = tr.id AND sz.valid_to = DATE '9999-12-31'
     AND sz.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_SIZE')
    LEFT JOIN golden_master.entity_attribute_values hd
      ON hd.entity_id = tr.id AND hd.valid_to = DATE '9999-12-31'
     AND hd.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_HOLD_PCT')
    ORDER BY d.deal_key, sz.golden_value_numeric DESC NULLS LAST;

    CREATE TEMP TABLE t_draw ON COMMIT DROP AS
    SELECT t.deal_key,
           n.ord,
           (d.close_date + make_interval(months => n.months::int))::date AS draw_date,
           round(t.our_unfunded * n.share, 2) AS amount,
           round(n.share * 100, 2) AS share_pct,
           t.tranche_code
    FROM t_ddtl t
    JOIN t_deal d ON d.deal_key = t.deal_key
    CROSS JOIN (VALUES (1, 10, 0.40), (2, 16, 0.30)) AS n(ord, months, share)
    WHERE t.our_unfunded > 0;

    CREATE TEMP TABLE t_cov ON COMMIT DROP AS
    SELECT d.deal_key, c.ord, c.title, c.direction, c.unit, c.level, c.current,
           (d.close_date + interval '3 months')::date AS first_test
    FROM t_deal d
    CROSS JOIN LATERAL (VALUES
        (1, 'Maximum total leverage', 'MAX', 'MULTIPLE',
            round(GREATEST(COALESCE(d.leverage, 4.5) + 2.5, COALESCE(d.leverage, 4.5) * 1.4), 1),
            round(COALESCE(d.leverage, 4.5), 1)),
        (2, 'Minimum interest coverage', 'MIN', 'MULTIPLE', 1.75::numeric, 1.84::numeric),
        (3, 'Minimum liquidity', 'MIN', 'CURRENCY', 7000000::numeric, 14000000::numeric)
    ) AS c(ord, title, direction, unit, level, current);

    CREATE TEMP TABLE t_report ON COMMIT DROP AS
    SELECT d.deal_key, r.ord, r.title, r.due_date
    FROM t_deal d
    CROSS JOIN LATERAL (
        SELECT n AS ord,
               'Monthly financials' AS title,
               ((date_trunc('month', d.close_date) + interval '19 days')::date
                 + CASE WHEN (date_trunc('month', d.close_date) + interval '19 days')::date < d.close_date
                        THEN interval '1 month' ELSE interval '0' END
                 + make_interval(months => n - 1))::date AS due_date
        FROM generate_series(1, 6) AS n
        UNION ALL
        SELECT 7, 'Compliance certificate', (d.close_date + interval '33 days')::date
        UNION ALL
        SELECT 8, 'Compliance certificate and audited financials', (d.close_date + interval '94 days')::date
    ) AS r;

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent
    SELECT 'HALY-DRAW-' || deal_key || '-' || ord, 'EXPECTED_DRAW', 'EXPECTED_DRAW_STANDARD',
           'Add-on acquisition', 'Expected draw on the delayed-draw tranche.'
    FROM t_draw;

    INSERT INTO t_ent
    SELECT 'HALY-COV-' || deal_key || '-' || ord, 'DEAL_COVENANT', 'DEAL_COVENANT_STANDARD',
           title, 'Maintenance covenant.'
    FROM t_cov;

    INSERT INTO t_ent
    SELECT 'HALY-RPT-' || deal_key || '-' || ord, 'REPORTING_OBLIGATION', 'REPORTING_OBLIGATION_STANDARD',
           title, 'Borrower reporting date.'
    FROM t_report;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"servicingSample":true}'::jsonb
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
    SELECT d.deal_code, a.attr, a.val
    FROM t_deal d
    LEFT JOIN t_line u ON u.deal_key = d.deal_key
    CROSS JOIN LATERAL (VALUES
        ('SERVICING_INDEX_RATE', '4.30'),
        ('SERVICING_UNDRAWN_FEE_PCT', CASE WHEN COALESCE(u.unfunded, 0) > 0 THEN '1.50' ELSE '0' END),
        ('SERVICING_PIK_RATE', '0'),
        ('SERVICING_AMORTIZATION_PCT', '0.25'),
        ('SERVICING_RATING', CASE WHEN d.strategy = 'SPECIAL_SITUATIONS' THEN 'R3' ELSE 'R2' END),
        ('SERVICING_MARK', CASE WHEN d.strategy = 'SPECIAL_SITUATIONS' THEN '98.5' ELSE '99.8' END),
        ('SERVICING_MARK_DATE', (date_trunc('month', CURRENT_DATE)::date - 1)::text)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-DRAW-' || deal_key || '-' || ord, a.attr, a.val
    FROM t_draw dr
    CROSS JOIN LATERAL (VALUES
        ('DRAW_DATE', dr.draw_date::text),
        ('DRAW_PURPOSE', 'Add-on acquisition'),
        ('DRAW_AMOUNT', dr.amount::text),
        ('DRAW_SHARE_PCT', dr.share_pct::text),
        ('DRAW_STATUS', CASE WHEN dr.draw_date <= CURRENT_DATE THEN 'ACTUAL' ELSE 'PROJECTED' END)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-COV-' || deal_key || '-' || ord, a.attr, a.val
    FROM t_cov c
    CROSS JOIN LATERAL (VALUES
        ('COVENANT_DIRECTION', c.direction),
        ('COVENANT_LEVEL', c.level::text),
        ('COVENANT_CURRENT', c.current::text),
        ('COVENANT_UNIT', c.unit),
        ('COVENANT_FIRST_TEST', c.first_test::text)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-RPT-' || deal_key || '-' || ord, 'REPORT_DUE_DATE', due_date::text
    FROM t_report;

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
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"servicingSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel
    SELECT 'HALY-DRAW-' || deal_key || '-' || ord, 'HALY-DEAL-' || deal_key, 'DRAW_DEAL' FROM t_draw;
    INSERT INTO t_rel
    SELECT 'HALY-DRAW-' || deal_key || '-' || ord, tranche_code, 'DRAW_TRANCHE' FROM t_draw;
    INSERT INTO t_rel
    SELECT 'HALY-COV-' || deal_key || '-' || ord, 'HALY-DEAL-' || deal_key, 'COVENANT_DEAL' FROM t_cov;
    INSERT INTO t_rel
    SELECT 'HALY-RPT-' || deal_key || '-' || ord, 'HALY-DEAL-' || deal_key, 'REPORT_DEAL' FROM t_report;

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
