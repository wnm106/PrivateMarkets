-- The position roll-forward sums cash flows by type. These rows are the
-- HSCF2 quarter's activity, one flow per non-zero roll bucket, so the
-- aggregation reproduces the administrator roll.

DO $$
DECLARE
    v_client uuid;
    v_template uuid;
    v_src uuid;
    v_rel_name text;
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'HSCF2-FUND';
    SELECT id INTO v_template FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW';
    SELECT id INTO v_src FROM entity_instances.source_registry WHERE source_code = 'INTERNAL';
    SELECT relationship_name INTO v_rel_name FROM metadata_register.relationship_types WHERE relationship_code = 'POSITION_CASHFLOW';
    IF v_client IS NULL OR v_template IS NULL OR v_src IS NULL OR v_rel_name IS NULL THEN
        RAISE EXCEPTION 'HSCF2 cash flow seed is missing the fund, template, source, or relationship';
    END IF;

    CREATE TEMP TABLE t_flow ON COMMIT DROP AS
    SELECT pos.id AS position_id,
           pos.entity_code AS position_code,
           pos.entity_name AS position_name,
           map.flow_type,
           eav.golden_value_numeric AS amount
    FROM entity_instances.entity_relationships rel
    JOIN entity_instances.master_entities roll ON roll.id = rel.parent_entity_id AND roll.domain_code = 'POSITION_ROLL'
    JOIN entity_instances.master_entities pos ON pos.id = rel.child_entity_id AND pos.domain_code = 'POSITION'
    JOIN golden_master.entity_attribute_values eav ON eav.entity_id = roll.id
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    JOIN (VALUES
        ('ROLL_PURCHASES', 'PURCHASE'),
        ('ROLL_REPAYMENTS', 'REPAYMENT'),
        ('ROLL_SALES', 'SALE'),
        ('ROLL_PIK', 'PIK'),
        ('ROLL_AMORTIZATION', 'AMORTIZATION'),
        ('ROLL_UNREALIZED_CHANGE', 'UNREALIZED'),
        ('ROLL_REALIZED_GAIN', 'REALIZED_GAIN'),
        ('ROLL_INTEREST_EARNED', 'INTEREST'),
        ('ROLL_FEE_INCOME', 'FEE')
    ) AS map(attribute_code, flow_type) ON map.attribute_code = ar.attribute_code
    WHERE rel.relationship_code = 'ROLL_POSITION'
      AND pos.entity_code LIKE 'HSCF2-POS-%'
      AND eav.golden_value_numeric IS NOT NULL
      AND eav.golden_value_numeric <> 0
      AND eav.valid_from <= DATE '2026-09-30'
      AND eav.valid_to >= DATE '2026-09-30'
      AND COALESCE(eav.system_to, 'infinity') > NOW();

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT 'HSCF2-CF-' || regexp_replace(position_code, '^HSCF2-POS-', '') || '-' || flow_type,
           'CASH_FLOW', v_template,
           position_name || ' ' || replace(flow_type, '_', ' ') || ' 2026-09-30',
           'Cash flow for the quarter ended September 30, 2026.',
           v_client, '{"fundRecSample":true}'::jsonb
    FROM t_flow
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        template_id = EXCLUDED.template_id,
        domain_code = EXCLUDED.domain_code,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id
      AND me.entity_code LIKE 'HSCF2-CF-%'
      AND me.metadata ->> 'fundRecSample' = 'true';

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, payload.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN payload.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN payload.val::date END,
           DATE '2020-01-01', DATE '9999-12-31',
           (SELECT precedence_rank FROM entity_instances.source_registry WHERE id = v_src),
           '{"fundRecSample":true}'::jsonb
    FROM t_flow f
    JOIN entity_instances.master_entities me
      ON me.entity_code = 'HSCF2-CF-' || regexp_replace(f.position_code, '^HSCF2-POS-', '') || '-' || f.flow_type
    CROSS JOIN LATERAL (VALUES
        ('CASHFLOW_DATE', '2026-09-30'),
        ('CASHFLOW_TYPE', f.flow_type),
        ('CURRENCY', 'USD'),
        ('AMOUNT', f.amount::text),
        ('PAYMENT_STATUS', 'RECEIVED')
    ) AS payload(attribute_code, val)
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = payload.attribute_code;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT f.position_id, me.id, v_rel_name, 'POSITION_CASHFLOW', TRUE, DATE '2020-01-01'
    FROM t_flow f
    JOIN entity_instances.master_entities me
      ON me.entity_code = 'HSCF2-CF-' || regexp_replace(f.position_code, '^HSCF2-POS-', '') || '-' || f.flow_type
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
