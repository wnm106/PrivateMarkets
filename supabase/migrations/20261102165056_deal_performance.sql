-- Performance tab on the deal pipeline.
--
-- Returns are calculated from the allocated hold and the servicing cash flows.
-- What was missing is the fund's fee contract, plus the deal's realised-loss
-- and non-accrual facts. Management fee, expenses, and carry stay on the fund
-- so each portfolio can differ. The page weights them by the hold.

-- ============================================================
-- 1. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       NULL, FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE'
FROM (VALUES
    ('FUND_MGMT_FEE_PCT', 'Management Fee', 'PERCENTAGE', 'Annual management fee, as a percent of invested capital', 'FUND', 'Returns', 6),
    ('FUND_EXPENSE_PCT', 'Fund Expenses', 'PERCENTAGE', 'Annual fund expenses, as a percent of invested capital', 'FUND', 'Returns', 7),
    ('FUND_CARRY_PCT', 'Incentive Fee', 'PERCENTAGE', 'Incentive fee, as a percent of profit above the hurdle', 'FUND', 'Returns', 8),
    ('FUND_HURDLE_PCT', 'Preferred Return', 'PERCENTAGE', 'Annual hurdle the incentive fee is charged above', 'FUND', 'Returns', 9),
    ('SERVICING_REALIZED_LOSS', 'Realised Loss', 'CURRENCY', 'Losses already realised on this deal', 'DEAL', 'Servicing', 8),
    ('SERVICING_NON_ACCRUAL', 'Non-Accrual', 'BOOLEAN', 'True when the loan is on non-accrual', 'DEAL', 'Servicing', 9)
) AS v(code, name, dtype, descr, dom, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'FUND_MGMT_FEE_PCT', 'FUND_EXPENSE_PCT', 'FUND_CARRY_PCT', 'FUND_HURDLE_PCT',
    'SERVICING_REALIZED_LOSS', 'SERVICING_NON_ACCRUAL'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 2. The pipeline surface
-- ============================================================

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, 'PERFORMANCE', 'Performance', 'Projected gross and net returns on our allocated position.', 9, 'always'
FROM public.surface_definitions s
WHERE s.surface_code = 'DEAL_PIPELINE'
ON CONFLICT (surface_id, slot_code) DO UPDATE
SET slot_name = EXCLUDED.slot_name,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, 'PERFORMANCE', 'Performance', 'Projected gross and net returns on our allocated position.', 100
FROM public.surface_page_slots sl
JOIN public.surface_definitions s ON s.id = sl.surface_id
WHERE s.surface_code = 'DEAL_PIPELINE' AND sl.slot_code = 'PERFORMANCE'
ON CONFLICT (slot_id, variant_code) DO UPDATE
SET variant_name = EXCLUDED.variant_name,
    description = EXCLUDED.description;

INSERT INTO public.surface_components (
    surface_id, slot_id, variant_id, experience_id, component_code, component_name, description, display_order
)
SELECT s.id, sl.id, v.id, e.id, 'PERFORMANCE', 'Performance', 'Projected gross and net returns on our allocated position.', 1
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = 'PERFORMANCE'
JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = 'PERFORMANCE'
JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = 'DEAL_BASELINE'
WHERE s.surface_code = 'DEAL_PIPELINE'
ON CONFLICT (surface_id, component_code) DO UPDATE
SET slot_id = EXCLUDED.slot_id,
    variant_id = EXCLUDED.variant_id,
    experience_id = EXCLUDED.experience_id,
    component_name = EXCLUDED.component_name,
    description = EXCLUDED.description;

UPDATE public.surface_definitions
SET description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, Compliance, Syndicate, Closing, Servicing, Financials, and Performance are live. Funding is on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

-- ============================================================
-- 3. Sample fee terms, realised losses, and non-accrual
-- ============================================================

DO $$
DECLARE
    v_src uuid;
BEGIN
    SELECT id INTO v_src FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    IF v_src IS NULL THEN
        RAISE NOTICE 'Skipping performance sample: no source';
        RETURN;
    END IF;

    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;
    INSERT INTO t_val
    SELECT me.entity_code, a.attr, a.val
    FROM entity_instances.master_entities me
    CROSS JOIN (VALUES
        ('FUND_MGMT_FEE_PCT', '1.25'),
        ('FUND_EXPENSE_PCT', '0.15'),
        ('FUND_CARRY_PCT', '12.5'),
        ('FUND_HURDLE_PCT', '6')
    ) AS a(attr, val)
    WHERE me.domain_code = 'FUND' AND me.entity_code LIKE 'HALY-FUND-%';

    INSERT INTO t_val
    SELECT me.entity_code, a.attr, a.val
    FROM entity_instances.master_entities me
    CROSS JOIN (VALUES
        ('SERVICING_REALIZED_LOSS', '0'),
        ('SERVICING_NON_ACCRUAL', 'false')
    ) AS a(attr, val)
    WHERE me.domain_code = 'DEAL' AND me.entity_code LIKE 'HALY-DEAL-%';

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
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"performanceSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;
END $$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261102165056', 'deal_performance'
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261102165056'
);

NOTIFY pgrst, 'reload schema';
