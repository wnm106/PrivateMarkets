-- Syndicate book on a deal.
--
-- A lender is an outside institution (bank, insurer, credit fund).
-- A syndicate seat is that lender's place on one deal: its role and the
-- assignment-document status. Role and documents belong to the seat, not to
-- a tranche. Our own funds are a seat too (SEAT_IS_HOUSE), with no lender,
-- related to the portfolios in the book.
-- An order is one seat's order and allocation on one tranche. The cut is
-- the share of the order that was not placed: allocated against the order.
-- Our own amounts are the allocation, not a stored order.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('LENDER', 'Lender', 'Outside institution in a syndicate: a bank, an insurer, or a credit fund'),
    ('SYNDICATE_SEAT', 'Syndicate Seat', 'One lender''s place on a deal, or our own funds as a seat'),
    ('SYNDICATE_ORDER', 'Syndicate Order', 'One seat''s order and allocation on one tranche')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('LENDER', 'DEALS', 100, ''),
    ('SYNDICATE_SEAT', 'DEALS', 110, 'DEAL'),
    ('SYNDICATE_ORDER', 'DEALS', 120, 'SYNDICATE_SEAT')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('LENDER_TYPE', 'Lender Type', 'LENDER', 'Kind of institution in the syndicate'),
    ('SYNDICATE_ROLE', 'Syndicate Role', 'SYNDICATE_SEAT', 'Role a seat plays on the deal'),
    ('ASSIGNMENT_STATUS', 'Assignment Status', 'SYNDICATE_SEAT', 'Where the assignment documents stand'),
    ('SYNDICATE_STATUS', 'Syndicate Status', 'DEAL', 'Where the syndicate book stands')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('LENDER_TYPE', 'BANK', 'Bank', 1),
    ('LENDER_TYPE', 'INSURANCE', 'Insurance', 2),
    ('LENDER_TYPE', 'CREDIT_FUND', 'Credit fund', 3),
    ('SYNDICATE_ROLE', 'PARTICIPANT', 'Participant', 1),
    ('SYNDICATE_ROLE', 'ADMINISTRATIVE_AGENT', 'Administrative agent', 2),
    ('SYNDICATE_ROLE', 'LEAD_ARRANGER', 'Lead arranger', 3),
    ('SYNDICATE_ROLE', 'JOINT_LEAD', 'Joint lead', 4),
    ('ASSIGNMENT_STATUS', 'NOT_ISSUED', 'Not issued', 1),
    ('ASSIGNMENT_STATUS', 'ISSUED', 'Issued', 2),
    ('ASSIGNMENT_STATUS', 'PARTIALLY_SIGNED', 'Partially signed', 3),
    ('ASSIGNMENT_STATUS', 'EXECUTED', 'Executed', 4),
    ('SYNDICATE_STATUS', 'NOT_LAUNCHED', 'Not launched', 1),
    ('SYNDICATE_STATUS', 'LAUNCHED', 'Launched', 2),
    ('SYNDICATE_STATUS', 'ALLOCATED', 'Allocated', 3),
    ('SYNDICATE_STATUS', 'CLOSED', 'Closed', 4)
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
    ('SYNDICATE_STATUS', 'Syndicate Status', 'REFERENCE_LIST', 'Where the syndicate book stands. Not launched until the book goes to lenders.', 'DEAL', 'SYNDICATE_STATUS', 'Syndicate', 1),
    ('LENDER_TYPE', 'Lender Type', 'REFERENCE_LIST', 'Bank, insurer, or credit fund', 'LENDER', 'LENDER_TYPE', 'Profile', 1),
    ('SEAT_ROLE', 'Role', 'REFERENCE_LIST', 'Role this seat plays on the deal', 'SYNDICATE_SEAT', 'SYNDICATE_ROLE', 'Seat', 1),
    ('SEAT_IS_HOUSE', 'Our Funds', 'BOOLEAN', 'True for the seat that holds our own funds. A house seat has no lender.', 'SYNDICATE_SEAT', NULL, 'Seat', 2),
    ('ASSIGNMENT_STATUS', 'Assignment Documents', 'REFERENCE_LIST', 'Whether assignment documents have been issued, signed, or executed', 'SYNDICATE_SEAT', 'ASSIGNMENT_STATUS', 'Documents', 3),
    ('SEAT_DISPLAY_ORDER', 'Display Order', 'INTEGER', 'Order of the seat on the syndicate page. Our funds are first.', 'SYNDICATE_SEAT', NULL, 'Seat', 4),
    ('ORDER_AMOUNT', 'Order Amount', 'CURRENCY', 'Amount the seat ordered on this tranche', 'SYNDICATE_ORDER', NULL, 'Order', 1),
    ('ORDER_ALLOCATED_AMOUNT', 'Allocated Amount', 'CURRENCY', 'Amount placed with the seat on this tranche. The cut is the share of the order that was not placed.', 'SYNDICATE_ORDER', NULL, 'Order', 2)
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
    ('LENDER_STANDARD', 'Standard Lender', 'LENDER', 'An outside syndicate institution'),
    ('SYNDICATE_SEAT_STANDARD', 'Standard Syndicate Seat', 'SYNDICATE_SEAT', 'A lender, or our own funds, on one deal'),
    ('SYNDICATE_ORDER_STANDARD', 'Standard Syndicate Order', 'SYNDICATE_ORDER', 'An order and its allocation on one tranche')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN ('SEAT_ROLE', 'ORDER_AMOUNT', 'ORDER_ALLOCATED_AMOUNT'),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'SYNDICATE_STATUS', 'LENDER_TYPE',
    'SEAT_ROLE', 'SEAT_IS_HOUSE', 'ASSIGNMENT_STATUS', 'SEAT_DISPLAY_ORDER',
    'ORDER_AMOUNT', 'ORDER_ALLOCATED_AMOUNT'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('SEAT_DEAL', 'Seat on deal', 'SYNDICATE_SEAT', 'DEAL', 'The deal this seat belongs to', 'MANY_TO_ONE', TRUE),
    ('SEAT_LENDER', 'Seat lender', 'SYNDICATE_SEAT', 'LENDER', 'The outside lender. Empty on the house seat.', 'MANY_TO_ONE', FALSE),
    ('SEAT_FUND', 'House fund', 'SYNDICATE_SEAT', 'FUND', 'A portfolio in our own book. Used on the house seat.', 'MANY_TO_ONE', FALSE),
    ('ORDER_SEAT', 'Order of seat', 'SYNDICATE_ORDER', 'SYNDICATE_SEAT', 'The seat that placed the order', 'MANY_TO_ONE', TRUE),
    ('ORDER_TRANCHE', 'Order on tranche', 'SYNDICATE_ORDER', 'DEAL_TRANCHE', 'The tranche the order is for', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. The deal record lists the book
-- ============================================================

UPDATE public.record_experiences
SET sections = CASE
        WHEN sections @> '[{"key":"syndicate"}]'::jsonb THEN sections
        ELSE sections || '[{"key":"syndicate","title":"Syndicate","kind":"GRID","placement":"TAB","domainCode":"SYNDICATE_SEAT","relationshipCode":"SEAT_DEAL","direction":"UP","templateCode":"SYNDICATE_SEAT_STANDARD","columns":["SEAT_ROLE","SEAT_IS_HOUSE","ASSIGNMENT_STATUS"]}]'::jsonb
    END,
    updated_at = NOW()
WHERE experience_code = 'DEAL_MANAGEMENT';

UPDATE public.surface_definitions
SET description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, Compliance, and Syndicate are live. Funding, Closing, and Servicing are on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

UPDATE public.surface_page_slots sl
SET description = 'Lenders, their orders, and assignment documents.'
FROM public.surface_definitions s
WHERE sl.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'SYNDICATE';

UPDATE public.surface_page_variants v
SET variant_name = 'Syndicate',
    description = 'Lenders, their orders, and assignment documents.'
FROM public.surface_page_slots sl
JOIN public.surface_definitions s ON s.id = sl.surface_id
WHERE v.slot_id = sl.id AND s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'SYNDICATE';

UPDATE public.surface_components c
SET component_name = 'Syndicate',
    description = 'Lenders, their orders, and assignment documents.'
FROM public.surface_definitions s
WHERE c.surface_id = s.id AND s.surface_code = 'DEAL_PIPELINE' AND c.component_code = 'SYNDICATE';

-- ============================================================
-- 7. Sample book for deals already in allocation, closing, or funded
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
        RAISE NOTICE 'Skipping syndicate sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_lender (
        code text, name text, ltype text, role text, ord int,
        w_funded numeric, w_unfunded numeric, cut_funded numeric, cut_unfunded numeric
    ) ON COMMIT DROP;

    INSERT INTO t_lender VALUES
        ('EASTGATE', 'Eastgate Bank', 'BANK', 'ADMINISTRATIVE_AGENT', 1, 9, 20, 0.00, 0.33),
        ('KINGSLEY', 'Kingsley Life', 'INSURANCE', 'LEAD_ARRANGER', 2, 15, 0, 0.26, 0),
        ('DUNMORE', 'Dunmore Insurance', 'INSURANCE', 'JOINT_LEAD', 3, 7, 0, 0.33, 0),
        ('GREYFIELD', 'Greyfield Partners', 'CREDIT_FUND', 'PARTICIPANT', 4, 14, 21, 0.27, 0.30),
        ('HOLLIS', 'Hollis Lane Capital', 'CREDIT_FUND', 'PARTICIPANT', 5, 16, 15, 0.28, 0.28),
        ('MONROE', 'Monroe Street Bank', 'BANK', 'PARTICIPANT', 6, 17, 12, 0.31, 0.20),
        ('LARKSPUR', 'Larkspur Capital', 'CREDIT_FUND', 'PARTICIPANT', 7, 10, 19, 0.13, 0.30),
        ('ATLAS', 'Atlas Credit Partners', 'CREDIT_FUND', 'PARTICIPANT', 8, 12, 13, 0.27, 0.24);

    CREATE TEMP TABLE t_book ON COMMIT DROP AS
    SELECT DISTINCT ON (d.id)
           d.id AS deal_id,
           d.entity_code AS deal_code,
           d.entity_name AS deal_name,
           replace(d.entity_code, 'HALY-DEAL-', '') AS deal_key,
           st.golden_value AS stage
    FROM entity_instances.master_entities d
    JOIN golden_master.entity_attribute_values st ON st.entity_id = d.id
    JOIN metadata_register.attribute_register ar ON ar.id = st.attribute_id AND ar.attribute_code = 'DEAL_STAGE'
    WHERE d.entity_code LIKE 'HALY-DEAL-%'
      AND st.golden_value IN ('ALLOCATION', 'CLOSING', 'CLOSED')
      AND st.valid_to = DATE '9999-12-31'
    ORDER BY d.id, st.valid_from DESC;

    CREATE TEMP TABLE t_tr ON COMMIT DROP AS
    SELECT b.deal_id, b.deal_code, b.deal_name, b.deal_key, b.stage,
           tr.id AS tranche_id,
           tr.entity_code AS tranche_code,
           tr.entity_name AS tranche_name,
           replace(tr.entity_code, 'HALY-TR-' || b.deal_key || '-', '') AS tranche_key,
           COALESCE(sz.golden_value_numeric, 0) AS size,
           COALESCE(h.golden_value_numeric, 0) AS hold,
           COALESCE(u.golden_value_boolean, FALSE) AS unfunded,
           COALESCE(eq.golden_value_boolean, FALSE) AS equity
    FROM t_book b
    JOIN entity_instances.entity_relationships rel
      ON rel.child_entity_id = b.deal_id AND rel.relationship_code = 'TRANCHE_DEAL'
    JOIN entity_instances.master_entities tr ON tr.id = rel.parent_entity_id
    LEFT JOIN golden_master.entity_attribute_values sz
      ON sz.entity_id = tr.id AND sz.valid_to = DATE '9999-12-31'
     AND sz.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_SIZE')
    LEFT JOIN golden_master.entity_attribute_values h
      ON h.entity_id = tr.id AND h.valid_to = DATE '9999-12-31'
     AND h.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_HOLD_PCT')
    LEFT JOIN golden_master.entity_attribute_values u
      ON u.entity_id = tr.id AND u.valid_to = DATE '9999-12-31'
     AND u.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_UNFUNDED')
    LEFT JOIN golden_master.entity_attribute_values eq
      ON eq.entity_id = tr.id AND eq.valid_to = DATE '9999-12-31'
     AND eq.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_EQUITY_LINKED');

    DELETE FROM t_tr WHERE equity OR size <= 0;

    ALTER TABLE t_tr ADD COLUMN external numeric;
    UPDATE t_tr SET external = round(size * (1 - hold / 100.0), 2);

    CREATE TEMP TABLE t_slice (
        deal_key text,
        tranche_id uuid,
        tranche_key text,
        lender_code text,
        allocated numeric,
        cut numeric,
        ordered numeric
    ) ON COMMIT DROP;

    INSERT INTO t_slice (deal_key, tranche_id, tranche_key, lender_code, allocated, cut)
    SELECT t.deal_key, t.tranche_id, t.tranche_key, l.code,
           round(t.external * (CASE WHEN t.unfunded THEN l.w_unfunded ELSE l.w_funded END) / ws.weight_sum, 2),
           CASE WHEN t.unfunded THEN l.cut_unfunded ELSE l.cut_funded END
    FROM t_tr t
    JOIN t_lender l
      ON (CASE WHEN t.unfunded THEN l.w_unfunded ELSE l.w_funded END) > 0
    JOIN (
        SELECT t2.tranche_id,
               sum(CASE WHEN t2.unfunded THEN l2.w_unfunded ELSE l2.w_funded END) AS weight_sum
        FROM t_tr t2
        JOIN t_lender l2
          ON (CASE WHEN t2.unfunded THEN l2.w_unfunded ELSE l2.w_funded END) > 0
        GROUP BY t2.tranche_id
    ) ws ON ws.tranche_id = t.tranche_id
    WHERE t.external > 0 AND ws.weight_sum > 0;

    UPDATE t_slice s
    SET allocated = s.allocated + gap.delta
    FROM (
        SELECT tr.tranche_id, tr.external - COALESCE(sum(sl.allocated), 0) AS delta
        FROM t_tr tr
        LEFT JOIN t_slice sl ON sl.tranche_id = tr.tranche_id
        GROUP BY tr.tranche_id, tr.external
    ) gap
    WHERE s.tranche_id = gap.tranche_id
      AND gap.delta <> 0
      AND s.lender_code = (
          SELECT s2.lender_code FROM t_slice s2
          WHERE s2.tranche_id = s.tranche_id
          ORDER BY s2.allocated DESC, s2.lender_code
          LIMIT 1
      );

    UPDATE t_slice
    SET ordered = CASE WHEN cut >= 1 THEN allocated ELSE round(allocated / (1 - cut), 2) END;

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent
    SELECT 'HALY-LENDER-' || code, 'LENDER', 'LENDER_STANDARD', name, 'Sample syndicate lender.'
    FROM t_lender;

    INSERT INTO t_ent
    SELECT 'HALY-SEAT-' || deal_key || '-HOUSE', 'SYNDICATE_SEAT', 'SYNDICATE_SEAT_STANDARD',
           'Our funds — ' || deal_name, 'Our own funds on this deal.'
    FROM (SELECT DISTINCT deal_key, deal_name FROM t_tr) d;

    INSERT INTO t_ent
    SELECT 'HALY-SEAT-' || d.deal_key || '-' || l.code, 'SYNDICATE_SEAT', 'SYNDICATE_SEAT_STANDARD',
           l.name || ' — ' || d.deal_name, 'Outside lender on this deal.'
    FROM (SELECT DISTINCT deal_key, deal_name FROM t_tr) d
    CROSS JOIN t_lender l;

    INSERT INTO t_ent
    SELECT 'HALY-ORD-' || s.deal_key || '-' || s.tranche_key || '-' || s.lender_code,
           'SYNDICATE_ORDER', 'SYNDICATE_ORDER_STANDARD',
           l.name || ' order, ' || tr.tranche_name,
           'Order and allocation on one tranche.'
    FROM t_slice s
    JOIN t_lender l ON l.code = s.lender_code
    JOIN t_tr tr ON tr.tranche_id = s.tranche_id
    WHERE s.allocated > 0 OR s.ordered > 0;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"syndicateSample":true}'::jsonb
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
    SELECT 'HALY-LENDER-' || code, 'LENDER_TYPE', ltype FROM t_lender;

    INSERT INTO t_val
    SELECT 'HALY-SEAT-' || deal_key || '-HOUSE', a.attr, a.val
    FROM (SELECT DISTINCT deal_key, stage FROM t_tr) d
    CROSS JOIN LATERAL (VALUES
        ('SEAT_ROLE', 'PARTICIPANT'),
        ('SEAT_IS_HOUSE', 'true'),
        ('SEAT_DISPLAY_ORDER', '0'),
        ('ASSIGNMENT_STATUS', CASE d.stage WHEN 'CLOSED' THEN 'EXECUTED' WHEN 'CLOSING' THEN 'ISSUED' ELSE 'NOT_ISSUED' END)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-SEAT-' || d.deal_key || '-' || l.code, a.attr, a.val
    FROM (SELECT DISTINCT deal_key, stage FROM t_tr) d
    CROSS JOIN t_lender l
    CROSS JOIN LATERAL (VALUES
        ('SEAT_ROLE', l.role),
        ('SEAT_IS_HOUSE', 'false'),
        ('SEAT_DISPLAY_ORDER', l.ord::text),
        ('ASSIGNMENT_STATUS', CASE d.stage WHEN 'CLOSED' THEN 'EXECUTED' WHEN 'CLOSING' THEN 'ISSUED' ELSE 'NOT_ISSUED' END)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-ORD-' || deal_key || '-' || tranche_key || '-' || lender_code, 'ORDER_AMOUNT', ordered::text
    FROM t_slice WHERE ordered > 0;
    INSERT INTO t_val
    SELECT 'HALY-ORD-' || deal_key || '-' || tranche_key || '-' || lender_code, 'ORDER_ALLOCATED_AMOUNT', allocated::text
    FROM t_slice WHERE allocated > 0 OR ordered > 0;

    INSERT INTO t_val
    SELECT deal_code, 'SYNDICATE_STATUS',
           CASE stage WHEN 'CLOSED' THEN 'CLOSED' WHEN 'CLOSING' THEN 'LAUNCHED' ELSE 'NOT_LAUNCHED' END
    FROM (SELECT DISTINCT deal_code, stage FROM t_tr) d;

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
        golden_value_numeric, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"syndicateSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel
    SELECT 'HALY-SEAT-' || deal_key || '-HOUSE', deal_code, 'SEAT_DEAL'
    FROM (SELECT DISTINCT deal_key, deal_code FROM t_tr) d;

    INSERT INTO t_rel
    SELECT 'HALY-SEAT-' || d.deal_key || '-' || l.code, d.deal_code, 'SEAT_DEAL'
    FROM (SELECT DISTINCT deal_key, deal_code FROM t_tr) d
    CROSS JOIN t_lender l;

    INSERT INTO t_rel
    SELECT 'HALY-SEAT-' || d.deal_key || '-' || l.code, 'HALY-LENDER-' || l.code, 'SEAT_LENDER'
    FROM (SELECT DISTINCT deal_key FROM t_tr) d
    CROSS JOIN t_lender l;

    INSERT INTO t_rel
    SELECT DISTINCT 'HALY-SEAT-' || d.deal_key || '-HOUSE',
           COALESCE(port.entity_code, fund.entity_code),
           'SEAT_FUND'
    FROM t_book d
    JOIN entity_instances.entity_relationships td
      ON td.child_entity_id = d.deal_id AND td.relationship_code = 'TRANCHE_DEAL'
    JOIN entity_instances.entity_relationships pt
      ON pt.child_entity_id = td.parent_entity_id AND pt.relationship_code = 'POSITION_TRANCHE'
    JOIN entity_instances.entity_relationships pf
      ON pf.parent_entity_id = pt.parent_entity_id AND pf.relationship_code = 'POSITION_FUND'
    JOIN entity_instances.master_entities fund ON fund.id = pf.child_entity_id
    LEFT JOIN entity_instances.entity_relationships fp
      ON fp.child_entity_id = fund.id AND fp.relationship_code = 'FUND_PARENT'
    LEFT JOIN entity_instances.master_entities port ON port.id = fp.parent_entity_id
    WHERE COALESCE(port.entity_code, fund.entity_code) IS NOT NULL;

    INSERT INTO t_rel
    SELECT 'HALY-ORD-' || s.deal_key || '-' || s.tranche_key || '-' || s.lender_code,
           'HALY-SEAT-' || s.deal_key || '-' || s.lender_code,
           'ORDER_SEAT'
    FROM t_slice s
    WHERE s.allocated > 0 OR s.ordered > 0;

    INSERT INTO t_rel
    SELECT 'HALY-ORD-' || s.deal_key || '-' || s.tranche_key || '-' || s.lender_code,
           tr.tranche_code,
           'ORDER_TRANCHE'
    FROM t_slice s
    JOIN t_tr tr ON tr.tranche_id = s.tranche_id
    WHERE s.allocated > 0 OR s.ordered > 0;

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
