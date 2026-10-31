-- The fluid surface was seeded as qualification profiles only. These two funds
-- are real FUND records so they show on the fund list, and the same four
-- profiles (native type and swapped type) are attached to the Fund surface.

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code, is_visible, display_section
)
VALUES
    ('FUND_STRUCTURE', 'Fund structure', 'STRING', 'Classifier for the fund surface. PUBLIC_BDC or CLOSED_END.', 'FUND', TRUE, 'General'),
    ('LISTING_STATUS', 'Listing status', 'STRING', 'LISTED or PRIVATE.', 'FUND', TRUE, 'General'),
    ('ACCOUNTING_BASIS', 'Accounting basis', 'STRING', 'GAAP or FAIR_VALUE.', 'FUND', TRUE, 'General')
ON CONFLICT (attribute_code) DO UPDATE
SET domain_code = COALESCE(metadata_register.attribute_register.domain_code, EXCLUDED.domain_code),
    is_visible = TRUE;

INSERT INTO metadata_register.domain_templates (template_code, domain_code, template_name, description)
VALUES
    ('FUND_NAV_BDC', 'FUND', 'BDC NAV', 'NAV chart of accounts for a public BDC.'),
    ('FUND_NAV_PE', 'FUND', 'Private equity NAV', 'NAV chart of accounts for a closed-end fund.')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, precedence_rank, is_active)
VALUES ('MANUAL', 'Manual Override', 'MANUAL', 90, TRUE)
ON CONFLICT (source_code) DO NOTHING;

-- One pair of funds per tenant, so each fund surface can see them.
INSERT INTO entity_instances.master_entities (
    entity_code, domain_code, template_id, entity_name, description, is_active, client_id
)
SELECT
    v.entity_code || '-' || c.client_code,
    'FUND',
    t.id,
    v.entity_name,
    v.description,
    TRUE,
    c.id
FROM tenancy.clients c
JOIN (VALUES
    ('HARBOR-BDC', 'Harbor Street BDC', 'FUND_NAV_BDC', 'Public BDC used by the fluid surface. Fund structure PUBLIC_BDC.'),
    ('NORTHLINE-PE-III', 'Northline PE Fund III', 'FUND_NAV_PE', 'Closed-end fund used by the fluid surface. Fund structure CLOSED_END.')
) AS v(entity_code, entity_name, template_code, description) ON TRUE
JOIN metadata_register.domain_templates t ON t.template_code = v.template_code
WHERE c.is_active IS DISTINCT FROM FALSE
ON CONFLICT (entity_code) DO NOTHING;

INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, valid_from, precedence_rank, is_manual_override
)
SELECT me.id, ar.id, src.id, v.golden_value, DATE '2024-01-01', 90, TRUE
FROM (VALUES
    ('HARBOR-BDC', 'FUND_STRUCTURE', 'PUBLIC_BDC'),
    ('HARBOR-BDC', 'LISTING_STATUS', 'LISTED'),
    ('HARBOR-BDC', 'ACCOUNTING_BASIS', 'GAAP'),
    ('HARBOR-BDC', 'FUND_TYPE', 'Public BDC'),
    ('NORTHLINE-PE-III', 'FUND_STRUCTURE', 'CLOSED_END'),
    ('NORTHLINE-PE-III', 'LISTING_STATUS', 'PRIVATE'),
    ('NORTHLINE-PE-III', 'ACCOUNTING_BASIS', 'FAIR_VALUE'),
    ('NORTHLINE-PE-III', 'FUND_TYPE', 'Closed-end')
) AS v(entity_prefix, attribute_code, golden_value)
JOIN entity_instances.master_entities me
    ON me.entity_code = v.entity_prefix || '-' || (
        SELECT c.client_code FROM tenancy.clients c WHERE c.id = me.client_id
    )
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
JOIN entity_instances.source_registry src ON src.source_code = 'MANUAL'
WHERE NOT EXISTS (
    SELECT 1
    FROM golden_master.entity_attribute_values existing
    WHERE existing.entity_id = me.id
      AND existing.attribute_id = ar.id
      AND existing.valid_to = DATE '9999-12-31'
      AND existing.system_to = TIMESTAMP '9999-12-31 23:59:59'
);

-- Show the fluid-surface profiles on the Fund surface the qualification screen opens.
INSERT INTO public.surface_sample_profiles (
    surface_id, profile_code, profile_name, description, template_code, facts, display_order
)
SELECT fund.id, sample.profile_code, sample.profile_name, sample.description,
       sample.template_code, sample.facts, sample.display_order + 10
FROM public.surface_sample_profiles sample
JOIN public.surface_definitions fluid ON fluid.id = sample.surface_id AND fluid.surface_code = 'FUND_FLUID_SURFACE'
JOIN public.surface_definitions fund ON fund.surface_code = 'FUND_SURFACE'
ON CONFLICT (surface_id, profile_code) DO NOTHING;
