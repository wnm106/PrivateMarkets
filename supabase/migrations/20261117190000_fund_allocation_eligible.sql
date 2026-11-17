-- Which funds appear on the allocation grid is a flag on the fund.
-- Is Allocation Eligible replaces the old screen rule (a top-level fund with a
-- single-issuer limit and at least one child fund, plus those child funds).
-- Funds that already match that rule are marked eligible here.

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT 'FUND_IS_ALLOCATION_ELIGIBLE', 'Is Allocation Eligible', 'BOOLEAN',
       'When true, this fund is shown on the deal allocation grid. Child funds with the flag are shown under their parent.',
       'FUND', NULL, FALSE, FALSE, 100,
       'Mandate', 0, TRUE, TRUE,
       FALSE, 'NONE'
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, 0
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a ON a.attribute_code = 'FUND_IS_ALLOCATION_ELIGIBLE'
WHERE t.template_code = 'FUND_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_boolean,
    valid_from, valid_to, precedence_rank, metadata
)
WITH open_parent AS (
    SELECT er.parent_entity_id AS parent_id, er.child_entity_id AS child_id
    FROM entity_instances.entity_relationships er
    WHERE er.relationship_code = 'FUND_PARENT'
      AND er.system_to >= TIMESTAMP '9999-01-01'
),
active_fund AS (
    SELECT id, client_id
    FROM entity_instances.master_entities
    WHERE domain_code = 'FUND'
      AND is_active
),
has_issuer_limit AS (
    SELECT DISTINCT eav.entity_id
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE ar.attribute_code = 'FUND_SINGLE_ISSUER_LIMIT_PCT'
      AND eav.valid_to >= CURRENT_DATE
      AND eav.system_to >= NOW()
      AND (eav.golden_value_numeric IS NOT NULL OR NULLIF(btrim(eav.golden_value), '') IS NOT NULL)
),
qualifying_parent AS (
    SELECT parent.id
    FROM active_fund parent
    JOIN has_issuer_limit lim ON lim.entity_id = parent.id
    WHERE NOT EXISTS (SELECT 1 FROM open_parent op WHERE op.child_id = parent.id)
      AND EXISTS (
          SELECT 1
          FROM open_parent op
          JOIN active_fund child ON child.id = op.child_id
          WHERE op.parent_id = parent.id
            AND child.client_id IS NOT DISTINCT FROM parent.client_id
      )
),
eligible AS (
    SELECT id FROM qualifying_parent
    UNION
    SELECT child.id
    FROM qualifying_parent parent
    JOIN open_parent op ON op.parent_id = parent.id
    JOIN active_fund child ON child.id = op.child_id
    JOIN active_fund parent_fund ON parent_fund.id = parent.id
    WHERE child.client_id IS NOT DISTINCT FROM parent_fund.client_id
)
SELECT eligible.id, a.id, src.id, 'true', TRUE,
       CURRENT_DATE, DATE '9999-12-31', 100,
       '{"allocationEligibleBackfill":true}'::jsonb
FROM eligible
JOIN metadata_register.attribute_register a ON a.attribute_code = 'FUND_IS_ALLOCATION_ELIGIBLE'
JOIN (
    SELECT id
    FROM entity_instances.source_registry
    WHERE source_code IN ('MANUAL', 'TEST')
    ORDER BY CASE source_code WHEN 'MANUAL' THEN 0 ELSE 1 END
    LIMIT 1
) src ON TRUE
WHERE NOT EXISTS (
    SELECT 1
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = eligible.id
      AND eav.attribute_id = a.id
      AND eav.valid_to >= CURRENT_DATE
      AND eav.system_to >= NOW()
);

NOTIFY pgrst, 'reload schema';
