-- A NAV line is an attribute of the NAV statement. The fund administrator
-- and the internal calculation are two sources of that amount. Section, role,
-- indent, and whether the line can block certification live on the attribute.

INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, precedence_rank)
VALUES ('FUND_ADMIN', 'Fund administrator', 'VENDOR', 40)
ON CONFLICT (source_code) DO UPDATE
SET source_name = EXCLUDED.source_name,
    source_type = EXCLUDED.source_type,
    precedence_rank = EXCLUDED.precedence_rank,
    is_active = TRUE;

UPDATE metadata_register.domain_types
SET description = 'Administrator NAV package for one period. Each statement line is an attribute. The fund administrator and the internal calculation are sources of that amount.'
WHERE domain_code = 'NAV_STATEMENT';

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

CREATE TEMP TABLE nav_chart (
    legacy_id text PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    section text NOT NULL,
    section_name text NOT NULL,
    role text NOT NULL,
    indent integer NOT NULL,
    reviewable boolean NOT NULL,
    composition boolean NOT NULL,
    ord integer NOT NULL
);

INSERT INTO nav_chart (legacy_id, code, name, section, section_name, role, indent, reviewable, composition, ord) VALUES
    ('BS-01', 'NAV_BS_ASSETS', 'Assets', 'BS_ASSET', 'Assets', 'HEADER', 0, FALSE, FALSE, 1),
    ('BS-02', 'NAV_BS_INVESTMENTS_NOTE', 'Investments at fair value (cost $426.0M)', 'BS_ASSET', 'Assets', 'NOTE', 0, FALSE, FALSE, 2),
    ('BS-03', 'NAV_BS_SENIOR', 'Senior secured', 'BS_ASSET', 'Assets', 'DETAIL', 2, FALSE, FALSE, 3),
    ('BS-04', 'NAV_BS_UNITRANCHE', 'Unitranche', 'BS_ASSET', 'Assets', 'DETAIL', 2, FALSE, FALSE, 4),
    ('BS-05', 'NAV_BS_MEZZANINE', 'Mezzanine', 'BS_ASSET', 'Assets', 'DETAIL', 2, FALSE, FALSE, 5),
    ('BS-06', 'NAV_BS_ASSET_BASED', 'Asset-based', 'BS_ASSET', 'Assets', 'DETAIL', 2, FALSE, FALSE, 6),
    ('BS-07', 'NAV_BS_INVESTMENTS', 'Total investments at fair value', 'BS_ASSET', 'Assets', 'SUBTOTAL', 0, TRUE, TRUE, 7),
    ('BS-08', 'NAV_BS_CASH', 'Cash and equivalents', 'BS_ASSET', 'Assets', 'LINE', 0, TRUE, TRUE, 8),
    ('BS-09', 'NAV_BS_RECEIVABLE', 'Interest receivable', 'BS_ASSET', 'Assets', 'LINE', 0, TRUE, TRUE, 9),
    ('BS-10', 'NAV_BS_TOTAL_ASSETS', 'Total assets', 'BS_ASSET', 'Assets', 'TOTAL', 0, FALSE, FALSE, 10),
    ('BS-11', 'NAV_BS_LIABILITIES', 'Liabilities', 'BS_LIABILITY', 'Liabilities', 'HEADER', 0, FALSE, FALSE, 11),
    ('BS-12', 'NAV_BS_FACILITY', 'Credit facility', 'BS_LIABILITY', 'Liabilities', 'LINE', 0, TRUE, TRUE, 12),
    ('BS-13', 'NAV_BS_ACCRUED_FEE', 'Accrued management fee', 'BS_LIABILITY', 'Liabilities', 'LINE', 0, TRUE, TRUE, 13),
    ('BS-14', 'NAV_BS_ACCRUED_EXPENSES', 'Accrued expenses and interest', 'BS_LIABILITY', 'Liabilities', 'LINE', 0, TRUE, TRUE, 14),
    ('BS-15', 'NAV_BS_TOTAL_LIABILITIES', 'Total liabilities', 'BS_LIABILITY', 'Liabilities', 'SUBTOTAL', 0, FALSE, FALSE, 15),
    ('BS-16', 'NAV_BS_NET_HEADER', 'Net assets', 'BS_NET', 'Net assets', 'HEADER', 0, FALSE, FALSE, 16),
    ('BS-17', 'NAV_BS_CONTRIBUTIONS', 'Capital contributions', 'BS_NET', 'Net assets', 'LINE', 0, FALSE, FALSE, 17),
    ('BS-18', 'NAV_BS_DISTRIBUTIONS', 'Cumulative distributions', 'BS_NET', 'Net assets', 'LINE', 0, FALSE, FALSE, 18),
    ('BS-19', 'NAV_BS_ACCUMULATED', 'Accumulated net investment income and gains', 'BS_NET', 'Net assets', 'LINE', 0, FALSE, FALSE, 19),
    ('BS-20', 'NAV_BS_NET_ASSETS', 'Net assets', 'BS_NET', 'Net assets', 'TOTAL', 0, FALSE, FALSE, 20),
    ('OP-01', 'NAV_OP_INCOME_HEADER', 'Investment income', 'OPS', 'Operations', 'HEADER', 0, FALSE, FALSE, 21),
    ('OP-02', 'NAV_OP_CASH_INTEREST', 'Cash interest income', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 22),
    ('OP-03', 'NAV_OP_PIK', 'PIK interest income', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 23),
    ('OP-04', 'NAV_OP_FEE_INCOME', 'Fee and other income', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 24),
    ('OP-05', 'NAV_OP_TOTAL_INCOME', 'Total investment income', 'OPS', 'Operations', 'SUBTOTAL', 0, FALSE, FALSE, 25),
    ('OP-06', 'NAV_OP_EXPENSE_HEADER', 'Expenses', 'OPS', 'Operations', 'HEADER', 0, FALSE, FALSE, 26),
    ('OP-07', 'NAV_OP_MGMT_FEE', 'Management fee', 'OPS', 'Operations', 'LINE', 0, TRUE, FALSE, 27),
    ('OP-08', 'NAV_OP_FACILITY_INTEREST', 'Interest and facility fees', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 28),
    ('OP-09', 'NAV_OP_PROFESSIONAL', 'Professional and administration fees', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 29),
    ('OP-10', 'NAV_OP_OTHER', 'Other operating expenses', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 30),
    ('OP-11', 'NAV_OP_TOTAL_EXPENSES', 'Total expenses', 'OPS', 'Operations', 'SUBTOTAL', 0, FALSE, FALSE, 31),
    ('OP-12', 'NAV_OP_NET_INVESTMENT_INCOME', 'Net investment income', 'OPS', 'Operations', 'TOTAL', 0, FALSE, FALSE, 32),
    ('OP-13', 'NAV_OP_GAIN_HEADER', 'Realized and unrealized gain (loss)', 'OPS', 'Operations', 'HEADER', 0, FALSE, FALSE, 33),
    ('OP-14', 'NAV_OP_REALIZED', 'Net realized gain on investments', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 34),
    ('OP-15', 'NAV_OP_UNREALIZED', 'Net change in unrealized appreciation (depreciation)', 'OPS', 'Operations', 'LINE', 0, FALSE, FALSE, 35),
    ('OP-16', 'NAV_OP_TOTAL_GAIN', 'Net realized and unrealized gain', 'OPS', 'Operations', 'SUBTOTAL', 0, FALSE, FALSE, 36),
    ('OP-17', 'NAV_OP_NET_INCREASE', 'Net increase in net assets from operations', 'OPS', 'Operations', 'TOTAL', 0, FALSE, FALSE, 37),
    ('CH-01', 'NAV_CH_OPERATIONS_HEADER', 'Operations', 'CHANGES', 'Changes in net assets', 'HEADER', 0, FALSE, FALSE, 38),
    ('CH-02', 'NAV_CH_NET_INVESTMENT_INCOME', 'Net investment income', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 39),
    ('CH-03', 'NAV_CH_REALIZED', 'Net realized gain on investments', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 40),
    ('CH-04', 'NAV_CH_UNREALIZED', 'Net change in unrealized appreciation (depreciation)', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 41),
    ('CH-05', 'NAV_CH_NET_OPERATIONS', 'Net increase from operations', 'CHANGES', 'Changes in net assets', 'SUBTOTAL', 0, FALSE, FALSE, 42),
    ('CH-06', 'NAV_CH_CAPITAL_HEADER', 'Capital transactions', 'CHANGES', 'Changes in net assets', 'HEADER', 0, FALSE, FALSE, 43),
    ('CH-07', 'NAV_CH_CONTRIBUTIONS', 'Capital contributions', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 44),
    ('CH-08', 'NAV_CH_DISTRIBUTIONS', 'Distributions to investors', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 45),
    ('CH-09', 'NAV_CH_NET_CAPITAL', 'Net increase from capital transactions', 'CHANGES', 'Changes in net assets', 'SUBTOTAL', 0, FALSE, FALSE, 46),
    ('CH-10', 'NAV_CH_NET_HEADER', 'Net assets', 'CHANGES', 'Changes in net assets', 'HEADER', 0, FALSE, FALSE, 47),
    ('CH-11', 'NAV_CH_TOTAL_INCREASE', 'Total increase in net assets', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 48),
    ('CH-12', 'NAV_CH_BEGINNING', 'Beginning of period', 'CHANGES', 'Changes in net assets', 'LINE', 0, FALSE, FALSE, 49),
    ('CH-13', 'NAV_CH_ENDING', 'End of period', 'CHANGES', 'Changes in net assets', 'TOTAL', 0, FALSE, FALSE, 50),
    ('CF-01', 'NAV_CF_OPERATING_HEADER', 'Operating activities', 'CASH', 'Cash flows', 'HEADER', 0, FALSE, FALSE, 51),
    ('CF-02', 'NAV_CF_NET_OPERATIONS', 'Net increase in net assets from operations', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 52),
    ('CF-03', 'NAV_CF_NOTE', 'Adjustments to reconcile to net cash from operations:', 'CASH', 'Cash flows', 'NOTE', 0, FALSE, FALSE, 53),
    ('CF-04', 'NAV_CF_REALIZED', 'Net realized gain on investments', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 54),
    ('CF-05', 'NAV_CF_UNREALIZED', 'Net change in unrealized (appreciation) depreciation', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 55),
    ('CF-06', 'NAV_CF_PIK', 'PIK interest income', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 56),
    ('CF-07', 'NAV_CF_PURCHASES', 'Purchases of investments', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 57),
    ('CF-08', 'NAV_CF_PROCEEDS', 'Proceeds from sales and repayments', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 58),
    ('CF-09', 'NAV_CF_RECEIVABLE', 'Increase in interest receivable', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 59),
    ('CF-10', 'NAV_CF_ACCRUED', 'Increase in accrued liabilities', 'CASH', 'Cash flows', 'LINE', 1, FALSE, FALSE, 60),
    ('CF-11', 'NAV_CF_NET_OPERATING', 'Net cash from operating activities', 'CASH', 'Cash flows', 'SUBTOTAL', 0, FALSE, FALSE, 61),
    ('CF-12', 'NAV_CF_FINANCING_HEADER', 'Financing activities', 'CASH', 'Cash flows', 'HEADER', 0, FALSE, FALSE, 62),
    ('CF-13', 'NAV_CF_CONTRIBUTIONS', 'Capital contributions', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 63),
    ('CF-14', 'NAV_CF_DISTRIBUTIONS', 'Distributions paid', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 64),
    ('CF-15', 'NAV_CF_FACILITY', 'Repayment of credit facility', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 65),
    ('CF-16', 'NAV_CF_NET_FINANCING', 'Net cash from financing activities', 'CASH', 'Cash flows', 'SUBTOTAL', 0, FALSE, FALSE, 66),
    ('CF-17', 'NAV_CF_CASH_HEADER', 'Cash', 'CASH', 'Cash flows', 'HEADER', 0, FALSE, FALSE, 67),
    ('CF-18', 'NAV_CF_NET_INCREASE', 'Net increase in cash', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 68),
    ('CF-19', 'NAV_CF_BEGINNING', 'Beginning of period', 'CASH', 'Cash flows', 'LINE', 0, FALSE, FALSE, 69),
    ('CF-20', 'NAV_CF_ENDING', 'End of period', 'CASH', 'Cash flows', 'TOTAL', 0, FALSE, FALSE, 70),
    ('RF-01', 'NAV_RF_BEGINNING', 'Beginning NAV', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 71),
    ('RF-02', 'NAV_RF_CONTRIBUTIONS', 'Capital contributions', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 72),
    ('RF-03', 'NAV_RF_DISTRIBUTIONS', 'Distributions', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 73),
    ('RF-04', 'NAV_RF_NET_INVESTMENT_INCOME', 'Net investment income', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 74),
    ('RF-05', 'NAV_RF_REALIZED', 'Realized gain (Fenwick exit)', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 75),
    ('RF-06', 'NAV_RF_UNREALIZED', 'Unrealized change', 'ROLL', 'Roll-forward', 'LINE', 0, FALSE, FALSE, 76),
    ('RF-07', 'NAV_RF_ENDING', 'Ending NAV', 'ROLL', 'Roll-forward', 'TOTAL', 0, FALSE, FALSE, 77);

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, validation_rules
)
SELECT c.code, c.name,
       CASE WHEN c.role IN ('HEADER', 'NOTE') THEN 'STRING' ELSE 'CURRENCY' END,
       'Line of the ' || c.section_name || ' section on a NAV statement.',
       'NAV_STATEMENT', NULL, FALSE, FALSE, 100,
       c.section_name, c.ord, c.role NOT IN ('HEADER', 'NOTE'), TRUE,
       FALSE, 'NONE',
       jsonb_build_object('navLine', jsonb_build_object(
           'section', c.section,
           'role', c.role,
           'indent', c.indent,
           'reviewable', c.reviewable,
           'composition', c.composition,
           'legacyId', c.legacy_id
       ))
FROM nav_chart c
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    data_type = EXCLUDED.data_type,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable,
    is_visible = EXCLUDED.is_visible,
    validation_rules = EXCLUDED.validation_rules,
    updated_at = NOW();

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
VALUES (
    'STATEMENT_ACCEPTED_LINES', 'Accepted lines', 'STRING',
    'JSON array of NAV line attribute codes whose fund-administrator and internal variance has been accepted.',
    'NAV_STATEMENT', NULL, FALSE, FALSE, 100,
    'Review', 5, TRUE, TRUE,
    FALSE, 'NONE'
)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    updated_at = NOW();

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT 'NAV_STATEMENT', v.name, v.ord, dt.client_id
FROM (VALUES
    ('Review', 0),
    ('Assets', 10),
    ('Liabilities', 20),
    ('Net assets', 30),
    ('Operations', 40),
    ('Changes in net assets', 50),
    ('Cash flows', 60),
    ('Roll-forward', 70)
) AS v(name, ord)
JOIN metadata_register.domain_types dt ON dt.domain_code = 'NAV_STATEMENT'
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_sections existing
    WHERE existing.domain_code = 'NAV_STATEMENT'
      AND lower(existing.section_name) = lower(v.name)
);

UPDATE metadata_register.attribute_sections AS section
SET display_order = v.ord, updated_at = NOW()
FROM (VALUES
    ('Review', 0),
    ('Assets', 10),
    ('Liabilities', 20),
    ('Net assets', 30),
    ('Operations', 40),
    ('Changes in net assets', 50),
    ('Cash flows', 60),
    ('Roll-forward', 70)
) AS v(name, ord)
WHERE section.domain_code = 'NAV_STATEMENT'
  AND lower(section.section_name) = lower(v.name);

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order, default_precedence_chain
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0),
       CASE WHEN a.validation_rules ? 'navLine' THEN '["FUND_ADMIN","INTERNAL"]'::jsonb ELSE NULL END
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'NAV_STATEMENT_STANDARD'
WHERE a.domain_code = 'NAV_STATEMENT'
  AND (a.validation_rules ? 'navLine' OR a.attribute_code = 'STATEMENT_ACCEPTED_LINES')
ON CONFLICT (template_id, attribute_id) DO UPDATE
SET display_order = EXCLUDED.display_order,
    default_precedence_chain = EXCLUDED.default_precedence_chain;

-- Move stored amounts onto the statement. Administrator rows become the fund
-- administrator source, including the prior-period window. Shadow rows become
-- the internal source. Validity and system time stay so a prior read still
-- sees the earlier window.
INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
    valid_from, valid_to, system_from, system_to, precedence_rank, metadata
)
SELECT DISTINCT ON (statement.id, attr.id, src.id, amount.valid_from, amount.valid_to, amount.system_from)
    statement.id, attr.id, src.id, amount.golden_value, amount.golden_value_numeric,
    amount.valid_from, amount.valid_to, amount.system_from, amount.system_to,
    src.precedence_rank,
    jsonb_build_object('navStatementLine', true, 'fromLine', line.entity_code, 'source', src.source_code)
FROM entity_instances.master_entities line
JOIN nav_chart c ON right(line.entity_code, length(c.legacy_id) + 1) = '-' || c.legacy_id
JOIN entity_instances.entity_relationships rel
  ON rel.parent_entity_id = line.id
 AND rel.relationship_code = 'LINE_STATEMENT'
JOIN entity_instances.master_entities statement ON statement.id = rel.child_entity_id
JOIN metadata_register.attribute_register attr ON attr.attribute_code = c.code
JOIN metadata_register.attribute_register old_attr
  ON old_attr.attribute_code = 'NAV_LINE_ADMINISTRATOR'
JOIN golden_master.entity_attribute_values amount
  ON amount.entity_id = line.id
 AND amount.attribute_id = old_attr.id
 AND amount.system_to >= TIMESTAMPTZ '9999-12-31'
 AND amount.golden_value IS NOT NULL
 AND amount.golden_value <> ''
JOIN entity_instances.source_registry src ON src.source_code = 'FUND_ADMIN'
WHERE line.domain_code = 'NAV_LINE'
  AND NOT EXISTS (
      SELECT 1 FROM golden_master.entity_attribute_values existing
      WHERE existing.entity_id = statement.id
        AND existing.attribute_id = attr.id
        AND existing.source_id = src.id
        AND existing.valid_from = amount.valid_from
        AND existing.valid_to = amount.valid_to
        AND existing.system_from = amount.system_from
  )
ORDER BY statement.id, attr.id, src.id, amount.valid_from, amount.valid_to, amount.system_from;

INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
    valid_from, valid_to, system_from, system_to, precedence_rank, metadata
)
SELECT DISTINCT ON (statement.id, attr.id, src.id, amount.valid_from, amount.valid_to, amount.system_from)
    statement.id, attr.id, src.id, amount.golden_value, amount.golden_value_numeric,
    amount.valid_from, amount.valid_to, amount.system_from, amount.system_to,
    src.precedence_rank,
    jsonb_build_object('navStatementLine', true, 'fromLine', line.entity_code, 'source', src.source_code)
FROM entity_instances.master_entities line
JOIN nav_chart c ON right(line.entity_code, length(c.legacy_id) + 1) = '-' || c.legacy_id
JOIN entity_instances.entity_relationships rel
  ON rel.parent_entity_id = line.id
 AND rel.relationship_code = 'LINE_STATEMENT'
JOIN entity_instances.master_entities statement ON statement.id = rel.child_entity_id
JOIN metadata_register.attribute_register attr ON attr.attribute_code = c.code
JOIN metadata_register.attribute_register old_attr
  ON old_attr.attribute_code = 'NAV_LINE_SHADOW'
JOIN golden_master.entity_attribute_values amount
  ON amount.entity_id = line.id
 AND amount.attribute_id = old_attr.id
 AND amount.system_to >= TIMESTAMPTZ '9999-12-31'
 AND amount.golden_value IS NOT NULL
 AND amount.golden_value <> ''
JOIN entity_instances.source_registry src ON src.source_code = 'INTERNAL'
WHERE line.domain_code = 'NAV_LINE'
  AND NOT EXISTS (
      SELECT 1 FROM golden_master.entity_attribute_values existing
      WHERE existing.entity_id = statement.id
        AND existing.attribute_id = attr.id
        AND existing.source_id = src.id
        AND existing.valid_from = amount.valid_from
        AND existing.valid_to = amount.valid_to
        AND existing.system_from = amount.system_from
  )
ORDER BY statement.id, attr.id, src.id, amount.valid_from, amount.valid_to, amount.system_from;

-- The line domain goes away. Its rows have been copied onto the statement.
DELETE FROM golden_master.entity_attribute_values AS amount
USING entity_instances.master_entities AS line
WHERE amount.entity_id = line.id
  AND line.domain_code = 'NAV_LINE';

DELETE FROM golden_master.entity_attribute_values AS amount
USING metadata_register.attribute_register AS attr
WHERE amount.attribute_id = attr.id
  AND attr.domain_code = 'NAV_LINE';

DELETE FROM entity_instances.source_attribute_values AS amount
USING entity_instances.master_entities AS line
WHERE amount.entity_id = line.id
  AND line.domain_code = 'NAV_LINE';

DELETE FROM entity_instances.entity_relationships AS rel
USING entity_instances.master_entities AS line
WHERE line.domain_code = 'NAV_LINE'
  AND (rel.parent_entity_id = line.id OR rel.child_entity_id = line.id);

DELETE FROM entity_instances.master_entities
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.template_attribute_assignments AS assignment
USING metadata_register.attribute_register AS attr
WHERE assignment.attribute_id = attr.id
  AND attr.domain_code = 'NAV_LINE';

DELETE FROM metadata_register.template_attribute_assignments AS assignment
USING metadata_register.domain_templates AS template
WHERE assignment.template_id = template.id
  AND template.domain_code = 'NAV_LINE';

DELETE FROM metadata_register.template_sections AS section
USING metadata_register.domain_templates AS template
WHERE section.template_id = template.id
  AND template.domain_code = 'NAV_LINE';

DELETE FROM metadata_register.template_sources AS source
USING metadata_register.domain_templates AS template
WHERE source.template_id = template.id
  AND template.domain_code = 'NAV_LINE';

DELETE FROM metadata_register.entity_template_bindings AS binding
USING metadata_register.domain_templates AS template
WHERE binding.data_template_id = template.id
  AND template.domain_code = 'NAV_LINE';

DELETE FROM metadata_register.attribute_aliases
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.attribute_register
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.attribute_sections
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.domain_templates
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.relationship_types
WHERE parent_domain_code = 'NAV_LINE'
   OR child_domain_code = 'NAV_LINE';

DELETE FROM metadata_register.display_layouts
WHERE domain_code = 'NAV_LINE'
   OR owner_domain_code = 'NAV_LINE';

DELETE FROM metadata_register.entity_identifier_definitions
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.domain_types
WHERE domain_code = 'NAV_LINE';

DELETE FROM metadata_register.attribute_sections AS section
WHERE section.domain_code = 'NAV_STATEMENT'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.attribute_register AS attr
      WHERE attr.domain_code = section.domain_code
        AND lower(btrim(COALESCE(attr.display_section, ''))) = lower(section.section_name)
  );

NOTIFY pgrst, 'reload schema';
