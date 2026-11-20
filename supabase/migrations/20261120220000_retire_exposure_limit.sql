-- Concentration limits are compliance rules, not their own entity.
--
-- A strategy, sector, or issuer cap is a threshold on the rule that measures
-- that share of invested market value. Existing exposure-limit records and the
-- fund-level sector and issuer defaults are copied onto those rules, then the
-- exposure-limit entity type is removed.

INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES
    ('FUND_STRATEGY_BOOK_PCT', 'Strategy share of invested book', 'CONCENTRATION', 'FUND', TRUE, TRUE,
     'Share of a fund''s invested market value in one position strategy. Each strategy''s limit is a threshold on this rule.'),
    ('FUND_ISSUER_BOOK_PCT', 'Single-issuer share of invested book', 'CONCENTRATION', 'FUND', TRUE, TRUE,
     'Market value of one issuer as a percent of the fund''s invested market value. The limit is a threshold on this rule.')
ON CONFLICT (rule_code) DO UPDATE
SET rule_name = EXCLUDED.rule_name,
    rule_category = EXCLUDED.rule_category,
    description = EXCLUDED.description,
    is_active = TRUE,
    applies_to_all = TRUE;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, description, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope, denominator_source,
    limit_direction, soft_limit_value, hard_limit_value,
    result_unit
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, v.descr, 'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]'::jsonb,
       v.group_path::jsonb, v.group_attr,
       'MARKET_VALUE', 'SUM',
       'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL', 'BASE',
       'MAX', NULL, NULL,
       'PERCENTAGE'
FROM compliance.rules r
JOIN (VALUES
    ('FUND_STRATEGY_BOOK_PCT',
     'Strategy market value divided by the fund''s total invested market value.',
     '[]',
     'POSITION_STRATEGY'),
    ('FUND_ISSUER_BOOK_PCT',
     'Issuer market value divided by the fund''s total invested market value.',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]',
     'ISSUER_LEGAL_NAME')
) AS v(code, descr, group_path, group_attr) ON v.code = r.rule_code
ON CONFLICT (rule_id, version_number) DO NOTHING;

UPDATE compliance.rule_versions rv
SET consolidate_descendants = TRUE
FROM compliance.rules r
WHERE rv.rule_id = r.id
  AND r.rule_code IN ('FUND_STRATEGY_BOOK_PCT', 'FUND_ISSUER_BOOK_PCT')
  AND rv.version_number = 1;

INSERT INTO compliance.rule_conditions (
    rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, logic_operator
)
SELECT rv.id, 'BASE', 1, 1, 'MARKET_VALUE', 'is_not_null', 'AND'
FROM compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id
WHERE r.rule_code IN ('FUND_STRATEGY_BOOK_PCT', 'FUND_ISSUER_BOOK_PCT')
  AND rv.version_number = 1
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_conditions c
      WHERE c.rule_version_id = rv.id AND c.attribute_code = 'MARKET_VALUE'
  );

INSERT INTO compliance.rule_scope_assignments (rule_id, scope_type, entity_id, include_children, notes)
SELECT r.id, 'EXCLUDE', me.id, FALSE,
       'Bench fixtures store POSITION_FUND with the fund as parent. These rules walk the registry direction.'
FROM compliance.rules r
JOIN entity_instances.master_entities me
  ON me.domain_code = 'FUND' AND me.entity_code LIKE 'BENCH-%'
WHERE r.rule_code IN ('FUND_STRATEGY_BOOK_PCT', 'FUND_ISSUER_BOOK_PCT')
ON CONFLICT (rule_id, scope_type, entity_id) DO NOTHING;

-- Named caps that were exposure-limit records.
INSERT INTO compliance.rule_thresholds (
    rule_id, entity_id, group_value, soft_limit_value, hard_limit_value, applies, limit_direction, notes
)
SELECT DISTINCT ON (r.id, fund.id, btrim(key.golden_value))
       r.id, fund.id, btrim(key.golden_value),
       pct.golden_value_numeric * 0.85, pct.golden_value_numeric,
       TRUE, 'MAX',
       'Moved from an exposure-limit record.'
FROM entity_instances.master_entities lim
JOIN entity_instances.entity_relationships rel
  ON rel.parent_entity_id = lim.id
 AND rel.relationship_code = 'LIMIT_FUND'
 AND rel.valid_to >= CURRENT_DATE
 AND rel.system_to >= NOW()
JOIN entity_instances.master_entities fund ON fund.id = rel.child_entity_id
JOIN metadata_register.attribute_register dim_attr ON dim_attr.attribute_code = 'LIMIT_DIMENSION'
JOIN metadata_register.attribute_register key_attr ON key_attr.attribute_code = 'LIMIT_KEY'
JOIN metadata_register.attribute_register pct_attr ON pct_attr.attribute_code = 'LIMIT_PCT'
JOIN golden_master.entity_attribute_values dim
  ON dim.entity_id = lim.id AND dim.attribute_id = dim_attr.id
 AND dim.valid_to >= CURRENT_DATE AND dim.system_to >= NOW()
JOIN golden_master.entity_attribute_values key
  ON key.entity_id = lim.id AND key.attribute_id = key_attr.id
 AND key.valid_to >= CURRENT_DATE AND key.system_to >= NOW()
JOIN golden_master.entity_attribute_values pct
  ON pct.entity_id = lim.id AND pct.attribute_id = pct_attr.id
 AND pct.valid_to >= CURRENT_DATE AND pct.system_to >= NOW()
 AND pct.golden_value_numeric IS NOT NULL
JOIN compliance.rules r ON r.rule_code = CASE upper(btrim(dim.golden_value))
    WHEN 'STRATEGY' THEN 'FUND_STRATEGY_BOOK_PCT'
    WHEN 'SECTOR' THEN 'FUND_SECTOR_BOOK_PCT'
    WHEN 'ISSUER' THEN 'FUND_ISSUER_BOOK_PCT'
END
WHERE lim.domain_code = 'EXPOSURE_LIMIT'
  AND lim.is_active
  AND btrim(coalesce(key.golden_value, '')) <> ''
ORDER BY r.id, fund.id, btrim(key.golden_value), pct.system_from DESC
ON CONFLICT DO NOTHING;

-- Fund-wide defaults that the exposure chart used when a name had no record.
INSERT INTO compliance.rule_thresholds (
    rule_id, entity_id, group_value, soft_limit_value, hard_limit_value, applies, limit_direction, notes
)
SELECT DISTINCT ON (r.id, eav.entity_id)
       r.id, eav.entity_id, NULL,
       eav.golden_value_numeric * 0.85, eav.golden_value_numeric,
       TRUE, 'MAX',
       'Fund concentration default previously stored on the fund.'
FROM golden_master.entity_attribute_values eav
JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
JOIN compliance.rules r ON r.rule_code = CASE ar.attribute_code
    WHEN 'FUND_SECTOR_LIMIT_PCT' THEN 'FUND_SECTOR_BOOK_PCT'
    WHEN 'FUND_ISSUER_LIMIT_PCT' THEN 'FUND_ISSUER_BOOK_PCT'
END
WHERE ar.attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT')
  AND eav.valid_to >= CURRENT_DATE
  AND eav.system_to >= NOW()
  AND eav.golden_value_numeric IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM compliance.rule_thresholds t
      WHERE t.rule_id = r.id
        AND t.entity_id = eav.entity_id
        AND t.group_value IS NULL
        AND t.rank_from IS NULL
        AND t.valid_to = DATE '9999-12-31'
  )
ORDER BY r.id, eav.entity_id, eav.system_from DESC;

-- The fund attributes were the chart's fallback. The thresholds above are the record now.
DELETE FROM golden_master.intersection_attribute_values AS amount
USING metadata_register.attribute_register AS attr
WHERE amount.attribute_id = attr.id
  AND attr.attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM metadata_register.calc_inputs
WHERE attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM golden_master.entity_attribute_values AS amount
USING metadata_register.attribute_register AS attr
WHERE amount.attribute_id = attr.id
  AND attr.attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM entity_instances.source_attribute_values AS amount
USING metadata_register.attribute_register AS attr
WHERE amount.attribute_id = attr.id
  AND attr.attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM metadata_register.template_attribute_assignments AS assignment
USING metadata_register.attribute_register AS attr
WHERE assignment.attribute_id = attr.id
  AND attr.attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM metadata_register.attribute_register
WHERE attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT');

DELETE FROM metadata_register.attribute_sections AS section
WHERE section.domain_code = 'FUND'
  AND lower(btrim(COALESCE(section.section_name, ''))) = 'exposure'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.attribute_register AS attr
      WHERE attr.domain_code = section.domain_code
        AND lower(btrim(COALESCE(attr.display_section, ''))) = lower(section.section_name)
  );

-- Remove the entity type once its limits have a rule to live on.
DELETE FROM data_quality.dq_exceptions
WHERE rule_id IN (
    SELECT id FROM data_quality.dq_rules
    WHERE domain_code = 'EXPOSURE_LIMIT' OR rule_code = 'LIMIT_PCT_RANGE'
)
OR attribute_id IN (
    SELECT id FROM metadata_register.attribute_register
    WHERE domain_code = 'EXPOSURE_LIMIT'
       OR attribute_code IN ('FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT', 'LIMIT_DIMENSION', 'LIMIT_KEY', 'LIMIT_PCT')
);
DELETE FROM data_quality.dq_rules
WHERE domain_code = 'EXPOSURE_LIMIT' OR rule_code = 'LIMIT_PCT_RANGE';

DELETE FROM golden_master.intersection_attribute_values AS amount
USING metadata_register.attribute_register AS attr
WHERE amount.attribute_id = attr.id
  AND attr.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.calc_inputs
WHERE attribute_code IN ('LIMIT_DIMENSION', 'LIMIT_KEY', 'LIMIT_PCT');

DELETE FROM golden_master.entity_attribute_values AS amount
USING entity_instances.master_entities AS lim
WHERE amount.entity_id = lim.id
  AND lim.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM entity_instances.source_attribute_values AS amount
USING entity_instances.master_entities AS lim
WHERE amount.entity_id = lim.id
  AND lim.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM entity_instances.entity_relationships AS rel
USING entity_instances.master_entities AS lim
WHERE lim.domain_code = 'EXPOSURE_LIMIT'
  AND (rel.parent_entity_id = lim.id OR rel.child_entity_id = lim.id);

DELETE FROM entity_instances.master_entities
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.template_attribute_assignments AS assignment
USING metadata_register.attribute_register AS attr
WHERE assignment.attribute_id = attr.id
  AND attr.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.template_attribute_assignments AS assignment
USING metadata_register.domain_templates AS template
WHERE assignment.template_id = template.id
  AND template.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.template_sections AS section
USING metadata_register.domain_templates AS template
WHERE section.template_id = template.id
  AND template.domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.template_sources AS source
USING metadata_register.domain_templates AS template
WHERE source.template_id = template.id
  AND template.domain_code = 'EXPOSURE_LIMIT';

DO $$
BEGIN
  IF to_regclass('metadata_register.entity_template_bindings') IS NOT NULL THEN
    DELETE FROM metadata_register.entity_template_bindings AS binding
    USING metadata_register.domain_templates AS template
    WHERE binding.data_template_id = template.id
      AND template.domain_code = 'EXPOSURE_LIMIT';
  END IF;
END $$;

DELETE FROM metadata_register.attribute_aliases
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.attribute_register
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.attribute_sections
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.domain_templates
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.relationship_types
WHERE parent_domain_code = 'EXPOSURE_LIMIT'
   OR child_domain_code = 'EXPOSURE_LIMIT'
   OR relationship_code = 'LIMIT_FUND';

DO $$
BEGIN
  IF to_regclass('metadata_register.display_layouts') IS NOT NULL THEN
    DELETE FROM metadata_register.display_layouts
    WHERE domain_code = 'EXPOSURE_LIMIT'
       OR owner_domain_code = 'EXPOSURE_LIMIT';
  END IF;
END $$;

DELETE FROM metadata_register.intersection_type_members
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM public.dashboard_templates
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM public.narrative_templates
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM public.record_experiences
WHERE anchor_domain_code = 'EXPOSURE_LIMIT';

DELETE FROM public.surface_definitions
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.reconciliation_definitions
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.entity_identifier_definitions
WHERE domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.reference_list_values AS value
USING metadata_register.reference_lists AS list
WHERE value.list_id = list.id
  AND list.list_code = 'LIMIT_DIMENSION';

DELETE FROM metadata_register.reference_lists
WHERE list_code = 'LIMIT_DIMENSION';

UPDATE metadata_register.domain_types
SET parent_domain_code = NULL
WHERE parent_domain_code = 'EXPOSURE_LIMIT';

DELETE FROM metadata_register.domain_types
WHERE domain_code = 'EXPOSURE_LIMIT';

SELECT compliance.evaluate_rule('FUND_STRATEGY_BOOK_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_SECTOR_BOOK_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_ISSUER_BOOK_PCT', DATE '2026-09-30');

NOTIFY pgrst, 'reload schema';
