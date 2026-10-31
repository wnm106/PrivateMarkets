-- Calculated totals for the deal allocation surface, and the role that keeps a
-- portfolio-level lock from being read as a second holding.
--
-- Hold amount, facility size, target hold, available capital, and allocated
-- amount are ordinary calc definitions. The allocation engine still computes
-- the fill. These attributes are what the rest of the app reads.

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group,
    is_editable, is_visible, is_time_varying, time_dimension, is_derived
) VALUES
    ('TRANCHE_HOLD_AMOUNT', 'Our Hold Amount', 'CURRENCY',
     'Tranche size times our hold percent', 'DEAL_TRANCHE',
     FALSE, 100, 'Allocation', 6, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_FACILITY_SIZE', 'Facility Size', 'CURRENCY',
     'Sum of tranche sizes', 'DEAL',
     FALSE, 100, 'Pipeline', 6, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_TARGET_HOLD', 'Target Hold', 'CURRENCY',
     'Sum of our hold across tranches', 'DEAL',
     FALSE, 100, 'Pipeline', 7, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_ALLOCATED_AMOUNT', 'Allocated Amount', 'CURRENCY',
     'Sum of position market value proposed for this deal', 'DEAL',
     FALSE, 100, 'Pipeline', 8, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('FUND_AVAILABLE_CAPITAL', 'Available Capital', 'CURRENCY',
     'Cash plus undrawn commitments plus line headroom, minus the pipeline reserve', 'FUND',
     FALSE, 100, 'Liquidity', 5, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('POSITION_ALLOCATION_ROLE', 'Allocation Role', 'STRING',
     'PROPOSAL is a sleeve holding. LOCK is a portfolio-level override and is not a second holding.', 'POSITION',
     FALSE, 100, 'Allocation', 8, TRUE, TRUE, FALSE, 'NONE', FALSE)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    is_editable = EXCLUDED.is_editable,
    display_section = EXCLUDED.display_section;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'TRANCHE_HOLD_AMOUNT', 'DEAL_FACILITY_SIZE', 'DEAL_TARGET_HOLD', 'DEAL_ALLOCATED_AMOUNT',
    'FUND_AVAILABLE_CAPITAL', 'POSITION_ALLOCATION_ROLE'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT id, 'DEAL_TRANCHE', 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE',
       '{"op":"div","args":[{"op":"mul","args":[{"ref":"TRANCHE_SIZE"},{"ref":"TRANCHE_HOLD_PCT"}]},{"const":100}]}'::jsonb
FROM metadata_register.attribute_register
WHERE attribute_code = 'TRANCHE_HOLD_AMOUNT'
ON CONFLICT (attribute_id) DO UPDATE SET expression = EXCLUDED.expression, evaluation_mode = EXCLUDED.evaluation_mode;

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, v.role, v.code, 'SELF', '{}', v.ord
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id AND ar.attribute_code = 'TRANCHE_HOLD_AMOUNT'
JOIN (VALUES ('OPERAND', 'TRANCHE_SIZE', 1), ('OPERAND', 'TRANCHE_HOLD_PCT', 2)) AS v(role, code, ord) ON TRUE
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT id, 'FUND', 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE',
       '{"op":"sub","args":[{"op":"add","args":[{"op":"add","args":[{"ref":"FUND_CASH_BALANCE"},{"ref":"FUND_UNDRAWN_COMMITMENTS"}]},{"ref":"FUND_CREDIT_LINE_HEADROOM"}]},{"ref":"FUND_PIPELINE_RESERVE"}]}'::jsonb
FROM metadata_register.attribute_register
WHERE attribute_code = 'FUND_AVAILABLE_CAPITAL'
ON CONFLICT (attribute_id) DO UPDATE SET expression = EXCLUDED.expression, evaluation_mode = EXCLUDED.evaluation_mode;

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'OPERAND', v.code, 'SELF', '{}', v.ord
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id AND ar.attribute_code = 'FUND_AVAILABLE_CAPITAL'
JOIN (VALUES
    ('FUND_CASH_BALANCE', 1),
    ('FUND_UNDRAWN_COMMITMENTS', 2),
    ('FUND_CREDIT_LINE_HEADROOM', 3),
    ('FUND_PIPELINE_RESERVE', 4)
) AS v(code, ord) ON TRUE
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, aggregate_fn
)
SELECT id, 'DEAL', 'AGGREGATE', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
FROM metadata_register.attribute_register
WHERE attribute_code = 'DEAL_FACILITY_SIZE'
ON CONFLICT (attribute_id) DO UPDATE SET aggregate_fn = EXCLUDED.aggregate_fn, evaluation_mode = EXCLUDED.evaluation_mode;

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'MEASURE', 'TRANCHE_SIZE', 'UP', ARRAY['TRANCHE_DEAL'], 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id AND ar.attribute_code = 'DEAL_FACILITY_SIZE'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, aggregate_fn
)
SELECT id, 'DEAL', 'AGGREGATE', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
FROM metadata_register.attribute_register
WHERE attribute_code = 'DEAL_TARGET_HOLD'
ON CONFLICT (attribute_id) DO UPDATE SET aggregate_fn = EXCLUDED.aggregate_fn, evaluation_mode = EXCLUDED.evaluation_mode;

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'MEASURE', 'TRANCHE_HOLD_AMOUNT', 'UP', ARRAY['TRANCHE_DEAL'], 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id AND ar.attribute_code = 'DEAL_TARGET_HOLD'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, aggregate_fn
)
SELECT id, 'DEAL', 'AGGREGATE', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
FROM metadata_register.attribute_register
WHERE attribute_code = 'DEAL_ALLOCATED_AMOUNT'
ON CONFLICT (attribute_id) DO UPDATE SET aggregate_fn = EXCLUDED.aggregate_fn, evaluation_mode = EXCLUDED.evaluation_mode;

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'MEASURE', 'MARKET_VALUE', 'UP', ARRAY['TRANCHE_DEAL', 'POSITION_TRANCHE'], 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id AND ar.attribute_code = 'DEAL_ALLOCATED_AMOUNT'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

UPDATE public.record_experiences
SET sections = CASE
        WHEN sections @> '[{"key":"allocation"}]'::jsonb THEN sections
        ELSE sections || '[{"key":"allocation","title":"Capital structure","kind":"ALLOCATION","placement":"TAB"}]'::jsonb
    END,
    updated_at = NOW()
WHERE experience_code = 'DEAL_MANAGEMENT';

NOTIFY pgrst, 'reload schema';
