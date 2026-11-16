-- Calculated totals for the deal allocation surface, and the role that keeps a
-- portfolio-level lock from being read as a second holding.
--
-- Hold amount, facility size, target hold, available capital, and allocated
-- amount are ordinary calc definitions. The allocation engine still computes
-- the fill. These attributes are what the rest of the app reads.
--
-- The deal totals are aggregates, and aggregates are materialized. Hold amount
-- feeds one of them, so it is materialized too. Available capital stays on read.
-- Allocated amount sums every position on the tranche. A portfolio-level LOCK
-- position would be counted twice. None exists today. Excluding it needs a
-- filtered aggregate.

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
SELECT id, 'DEAL_TRANCHE', 'EXPRESSION', 'MATERIALIZED', 'FORWARD', 'ON_INPUT_CHANGE',
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
SELECT id, 'DEAL', 'AGGREGATE', 'MATERIALIZED', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
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
SELECT id, 'DEAL', 'AGGREGATE', 'MATERIALIZED', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
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
SELECT id, 'DEAL', 'AGGREGATE', 'MATERIALIZED', 'FORWARD', 'ON_INPUT_CHANGE', 'SUM'
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

-- First values for the deals already in the pipeline. A materialized calc only
-- recalculates when an input changes, so existing deals are queued here and the
-- queue is drained one entity at a time: tranches first, then deals.

DO $$
DECLARE
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_hold UUID;
    v_row RECORD;
    v_code TEXT;
BEGIN
    SELECT id INTO v_hold FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_HOLD_AMOUNT';

    FOR v_row IN
        SELECT er.parent_entity_id AS tranche_id,
               COALESCE(MIN(eav.valid_from)::DATE, CURRENT_DATE) AS starts
        FROM entity_instances.entity_relationships er
        JOIN entity_instances.master_entities d ON d.id = er.child_entity_id AND d.domain_code = 'DEAL'
        LEFT JOIN golden_master.entity_attribute_values eav
               ON eav.entity_id = er.parent_entity_id
              AND eav.system_to = v_open
              AND eav.attribute_id IN (
                  SELECT id FROM metadata_register.attribute_register
                  WHERE attribute_code IN ('TRANCHE_SIZE', 'TRANCHE_HOLD_PCT')
              )
        WHERE er.relationship_code = 'TRANCHE_DEAL' AND er.system_to = v_open
        GROUP BY er.parent_entity_id
    LOOP
        PERFORM golden_master.enqueue_calc(
            v_hold, v_row.tranche_id, v_row.starts, DATE '9999-12-31',
            v_row.tranche_id, 'TRANCHE_SIZE', v_row.starts
        );
    END LOOP;

    FOR v_row IN
        SELECT d.id AS deal_id,
               COALESCE(LEAST(
                   (SELECT MIN(eav.valid_from)::DATE
                    FROM entity_instances.entity_relationships td
                    JOIN golden_master.entity_attribute_values eav ON eav.entity_id = td.parent_entity_id
                    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                    WHERE td.child_entity_id = d.id
                      AND td.relationship_code = 'TRANCHE_DEAL' AND td.system_to = v_open
                      AND eav.system_to = v_open
                      AND ar.attribute_code IN ('TRANCHE_SIZE', 'TRANCHE_HOLD_PCT')),
                   (SELECT MIN(eav.valid_from)::DATE
                    FROM entity_instances.entity_relationships td
                    JOIN entity_instances.entity_relationships pt
                      ON pt.child_entity_id = td.parent_entity_id
                     AND pt.relationship_code = 'POSITION_TRANCHE' AND pt.system_to = v_open
                    JOIN golden_master.entity_attribute_values eav ON eav.entity_id = pt.parent_entity_id
                    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                    WHERE td.child_entity_id = d.id
                      AND td.relationship_code = 'TRANCHE_DEAL' AND td.system_to = v_open
                      AND eav.system_to = v_open
                      AND ar.attribute_code = 'MARKET_VALUE')
               ), CURRENT_DATE) AS starts
        FROM entity_instances.master_entities d
        WHERE d.domain_code = 'DEAL'
          AND EXISTS (
              SELECT 1 FROM entity_instances.entity_relationships td
              WHERE td.child_entity_id = d.id
                AND td.relationship_code = 'TRANCHE_DEAL' AND td.system_to = v_open
          )
    LOOP
        FOREACH v_code IN ARRAY ARRAY['DEAL_FACILITY_SIZE', 'DEAL_TARGET_HOLD', 'DEAL_ALLOCATED_AMOUNT'] LOOP
            PERFORM golden_master.enqueue_calc(
                (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = v_code),
                v_row.deal_id, v_row.starts, DATE '9999-12-31',
                v_row.deal_id, 'TRANCHE_SIZE', v_row.starts
            );
        END LOOP;
    END LOOP;

    FOR v_row IN
        SELECT DISTINCT er.parent_entity_id AS id
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'TRANCHE_DEAL' AND er.system_to = v_open
    LOOP
        PERFORM public.process_entity_calculated_attributes(v_row.id, 20);
    END LOOP;

    FOR v_row IN
        SELECT DISTINCT er.child_entity_id AS id
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = 'TRANCHE_DEAL' AND er.system_to = v_open
    LOOP
        PERFORM public.process_entity_calculated_attributes(v_row.id, 20);
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
