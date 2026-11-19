-- Covenant definitions that differ by deal.
--
-- A covenant's calculation is data on the covenant, not a formula per deal.
-- Each DEAL_COVENANT has COVENANT_COMPONENT records: one line of the
-- borrower's statements, which side of the ratio it sits on, whether it adds
-- or subtracts, how the period is read (LTM, quarter, annualized, point in
-- time), an optional cap, the dates it is in force, and the clause it comes
-- from. One calculated attribute, COVENANT_CURRENT, reads those components
-- through a new DEFINITION calc kind, so 200 deals share one calculation and
-- each deal keeps its own definition.
--
-- An amendment closes the old components with an effective-to date and adds
-- new ones, so a past quarter is tested under the definition in force then.
--
-- Definitions to copy from are DEAL_COVENANT records with no deal and
-- COVENANT_IS_LIBRARY set. One per metric is also COVENANT_IS_HOUSE: the
-- standard definition that is computed for every deal next to its own, so
-- deals can be compared.
--
-- The borrower's compliance certificate is a source on COVENANT_CURRENT. The
-- calculated value still wins the golden record. A manual entry overrides it.

-- ============================================================
-- 1. Calc kind
-- ============================================================

ALTER TABLE metadata_register.calc_definitions
    DROP CONSTRAINT IF EXISTS calc_definitions_calc_kind_check;
ALTER TABLE metadata_register.calc_definitions
    ADD CONSTRAINT calc_definitions_calc_kind_check
    CHECK (calc_kind IN ('EXPRESSION', 'AGGREGATE', 'SERIES', 'DEFINITION'));

COMMENT ON COLUMN metadata_register.calc_definitions.calc_kind IS
    'EXPRESSION, AGGREGATE, SERIES, or DEFINITION. A DEFINITION calc reads its formula from component records on each entity (see golden_master.covenant_evaluate).';

-- ============================================================
-- 2. Source for the borrower's compliance certificate
-- ============================================================

INSERT INTO entity_instances.source_registry (
    source_code, source_name, source_type, feed_frequency, precedence_rank, is_active, is_protected, metadata
) VALUES (
    'BORROWER_CERTIFICATE', 'Borrower Compliance Certificate', 'VENDOR', 'QUARTERLY', 80, TRUE, FALSE,
    '{"color": "#9a6b1f"}'::jsonb
)
ON CONFLICT (source_code) DO NOTHING;

-- ============================================================
-- 3. Domain
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('COVENANT_COMPONENT', 'Covenant Component', 'One line of a covenant''s definition: which statement line, how it is read, and any cap')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = 165,
    parent_domain_code = 'DEAL_COVENANT',
    is_core = FALSE,
    updated_at = NOW()
FROM metadata_register.domain_groups g
WHERE g.group_code = 'DEALS' AND dt.domain_code = 'COVENANT_COMPONENT';

UPDATE metadata_register.domain_types
SET description = 'A maintenance covenant on a deal, its definition, and its calculated reading',
    updated_at = NOW()
WHERE domain_code = 'DEAL_COVENANT';

-- ============================================================
-- 4. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('COVENANT_METRIC', 'Covenant Metric', 'DEAL_COVENANT', 'What a covenant measures'),
    ('COVENANT_SIDE', 'Covenant Side', 'COVENANT_COMPONENT', 'Whether a component is in the numerator or the denominator'),
    ('COVENANT_SIGN', 'Covenant Sign', 'COVENANT_COMPONENT', 'Whether a component adds or subtracts'),
    ('COVENANT_MEASURE', 'Covenant Measure', 'COVENANT_COMPONENT', 'How the statement line is read for the test period'),
    ('COVENANT_CAP_TYPE', 'Covenant Cap', 'COVENANT_COMPONENT', 'How a component is capped'),
    ('COVENANT_LINE', 'Covenant Line', 'COVENANT_COMPONENT', 'Borrower statement lines a covenant can read')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('COVENANT_METRIC', 'NET_LEVERAGE', 'Net leverage', 1),
    ('COVENANT_METRIC', 'TOTAL_LEVERAGE', 'Total leverage', 2),
    ('COVENANT_METRIC', 'INTEREST_COVERAGE', 'Interest coverage', 3),
    ('COVENANT_METRIC', 'FIXED_CHARGE_COVERAGE', 'Fixed charge coverage', 4),
    ('COVENANT_METRIC', 'LIQUIDITY', 'Liquidity', 5),
    ('COVENANT_SIDE', 'NUMERATOR', 'Numerator', 1),
    ('COVENANT_SIDE', 'DENOMINATOR', 'Denominator', 2),
    ('COVENANT_SIGN', 'ADD', 'Add', 1),
    ('COVENANT_SIGN', 'SUBTRACT', 'Subtract', 2),
    ('COVENANT_MEASURE', 'LTM', 'Last four quarters', 1),
    ('COVENANT_MEASURE', 'QUARTER', 'Test quarter', 2),
    ('COVENANT_MEASURE', 'ANNUALIZED', 'Test quarter annualized', 3),
    ('COVENANT_MEASURE', 'POINT', 'Balance at test date', 4),
    ('COVENANT_CAP_TYPE', 'NONE', 'No cap', 1),
    ('COVENANT_CAP_TYPE', 'AMOUNT', 'Capped at an amount', 2),
    ('COVENANT_CAP_TYPE', 'PCT_OF_BASE', 'Capped at a percent of the uncapped lines', 3),
    ('COVENANT_LINE', 'STATEMENT_DEBT', 'Term loan', 1),
    ('COVENANT_LINE', 'STATEMENT_LC_OUTSTANDING', 'Letters of credit', 2),
    ('COVENANT_LINE', 'STATEMENT_CASH', 'Cash', 3),
    ('COVENANT_LINE', 'STATEMENT_UNRESTRICTED_CASH', 'Unrestricted cash', 4),
    ('COVENANT_LINE', 'STATEMENT_RESTRICTED_CASH', 'Restricted cash', 5),
    ('COVENANT_LINE', 'STATEMENT_EBITDA', 'EBITDA', 6),
    ('COVENANT_LINE', 'STATEMENT_RESTRUCTURING', 'Restructuring charges', 7),
    ('COVENANT_LINE', 'STATEMENT_TRANSACTION_COSTS', 'Transaction costs', 8),
    ('COVENANT_LINE', 'STATEMENT_STOCK_COMP', 'Stock compensation', 9),
    ('COVENANT_LINE', 'STATEMENT_PF_SYNERGIES', 'Run-rate cost savings', 10),
    ('COVENANT_LINE', 'STATEMENT_INTEREST', 'Interest expense', 11),
    ('COVENANT_LINE', 'STATEMENT_TAX', 'Income tax', 12),
    ('COVENANT_LINE', 'STATEMENT_CAPEX', 'Capital expenditure', 13),
    ('COVENANT_LINE', 'STATEMENT_REVENUE', 'Revenue', 14)
) AS v(list_code, code, label, ord) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- ============================================================
-- 5. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT 'STATEMENT_PERIOD', 'Covenant memo', 35, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_sections
    WHERE domain_code = 'STATEMENT_PERIOD' AND section_name = 'Covenant memo' AND client_id IS NULL
);

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
    ('STATEMENT_RESTRICTED_CASH', 'Restricted Cash', 'CURRENCY', 'Cash at quarter end that cannot be used freely. Included in cash above.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 1),
    ('STATEMENT_LC_OUTSTANDING', 'Letters of Credit', 'CURRENCY', 'Letters of credit outstanding at quarter end. Not on the balance sheet.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 3),
    ('STATEMENT_RESTRUCTURING', 'Restructuring Charges', 'CURRENCY', 'Restructuring charges for the quarter. Included in operating expenses above.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 4),
    ('STATEMENT_TRANSACTION_COSTS', 'Transaction Costs', 'CURRENCY', 'Deal and financing costs for the quarter. Included in operating expenses above.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 5),
    ('STATEMENT_STOCK_COMP', 'Stock Compensation', 'CURRENCY', 'Non-cash stock compensation for the quarter. Included in operating expenses above.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 6),
    ('STATEMENT_PF_SYNERGIES', 'Run-Rate Cost Savings', 'CURRENCY', 'Cost savings the borrower expects but has not yet realised, for the quarter. Not in the statements.', 'STATEMENT_PERIOD', NULL, 'Covenant memo', 7),
    ('COVENANT_METRIC', 'Metric', 'REFERENCE_LIST', 'What the covenant measures', 'DEAL_COVENANT', 'COVENANT_METRIC', 'Covenant', 0),
    ('COVENANT_IS_LIBRARY', 'Library Definition', 'BOOLEAN', 'A definition to copy from. Not a covenant on a deal.', 'DEAL_COVENANT', NULL, 'Definition', 6),
    ('COVENANT_IS_HOUSE', 'House Standard', 'BOOLEAN', 'The standard definition computed for every deal next to its own', 'DEAL_COVENANT', NULL, 'Definition', 7),
    ('COMPONENT_SIDE', 'Side', 'REFERENCE_LIST', 'Numerator or denominator', 'COVENANT_COMPONENT', 'COVENANT_SIDE', 'Component', 1),
    ('COMPONENT_LINE', 'Statement Line', 'REFERENCE_LIST', 'The borrower statement line this component reads', 'COVENANT_COMPONENT', 'COVENANT_LINE', 'Component', 2),
    ('COMPONENT_SIGN', 'Sign', 'REFERENCE_LIST', 'Add or subtract', 'COVENANT_COMPONENT', 'COVENANT_SIGN', 'Component', 3),
    ('COMPONENT_MEASURE', 'Period', 'REFERENCE_LIST', 'Last four quarters, the test quarter, the test quarter annualized, or the balance at the test date', 'COVENANT_COMPONENT', 'COVENANT_MEASURE', 'Component', 4),
    ('COMPONENT_CAP_TYPE', 'Cap', 'REFERENCE_LIST', 'No cap, an amount, or a percent of the side''s uncapped lines', 'COVENANT_COMPONENT', 'COVENANT_CAP_TYPE', 'Component', 5),
    ('COMPONENT_CAP_VALUE', 'Cap Value', 'DECIMAL', 'The cap: an amount, or a percent such as 15 for 15%', 'COVENANT_COMPONENT', NULL, 'Component', 6),
    ('COMPONENT_EFFECTIVE_FROM', 'Effective From', 'DATE', 'First test date this component applies to. Blank means from the start.', 'COVENANT_COMPONENT', NULL, 'Component', 7),
    ('COMPONENT_EFFECTIVE_TO', 'Effective To', 'DATE', 'Last test date this component applies to. Blank means it is still in force.', 'COVENANT_COMPONENT', NULL, 'Component', 8),
    ('COMPONENT_CLAUSE', 'Clause', 'STRING', 'Where the credit agreement defines this, such as 1.01 Consolidated EBITDA (b)(iii)', 'COVENANT_COMPONENT', NULL, 'Component', 9)
) AS v(code, name, dtype, descr, dom, list, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

-- Unrestricted cash is what most agreements net. It is a statement formula.
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
) VALUES (
    'STATEMENT_UNRESTRICTED_CASH', 'Unrestricted Cash', 'CURRENCY', 'Cash less restricted cash', 'STATEMENT_PERIOD',
    FALSE, FALSE, 100,
    'Covenant memo', 2, FALSE, TRUE,
    FALSE, 'NONE'
)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable;

-- The covenant's reading is now calculated. It keeps every source's value.
UPDATE metadata_register.attribute_register
SET attribute_name = 'Calculated',
    description = 'The covenant calculated from this deal''s definition. The borrower''s certificate is kept as another source. A manual entry overrides the calculation.',
    is_editable = FALSE,
    is_time_varying = TRUE,
    time_dimension = 'VALID_TIME',
    updated_at = NOW()
WHERE attribute_code = 'COVENANT_CURRENT';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 6. Templates and relationship
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('COVENANT_COMPONENT_STANDARD', 'Standard Covenant Component', 'COVENANT_COMPONENT', 'One line of a covenant definition')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN ('COMPONENT_SIDE', 'COMPONENT_LINE', 'COMPONENT_SIGN', 'COMPONENT_MEASURE'),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = CASE
    WHEN a.domain_code = 'COVENANT_COMPONENT' THEN 'COVENANT_COMPONENT_STANDARD'
    WHEN a.domain_code = 'DEAL_COVENANT' THEN 'DEAL_COVENANT_STANDARD'
    ELSE 'STATEMENT_PERIOD_STANDARD'
END
WHERE a.attribute_code IN (
    'COMPONENT_SIDE', 'COMPONENT_LINE', 'COMPONENT_SIGN', 'COMPONENT_MEASURE', 'COMPONENT_CAP_TYPE',
    'COMPONENT_CAP_VALUE', 'COMPONENT_EFFECTIVE_FROM', 'COMPONENT_EFFECTIVE_TO', 'COMPONENT_CLAUSE',
    'COVENANT_METRIC', 'COVENANT_IS_LIBRARY', 'COVENANT_IS_HOUSE',
    'STATEMENT_RESTRICTED_CASH', 'STATEMENT_UNRESTRICTED_CASH', 'STATEMENT_LC_OUTSTANDING',
    'STATEMENT_RESTRUCTURING', 'STATEMENT_TRANSACTION_COSTS', 'STATEMENT_STOCK_COMP', 'STATEMENT_PF_SYNERGIES'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('COMPONENT_COVENANT', 'Component of covenant', 'COVENANT_COMPONENT', 'DEAL_COVENANT', 'The covenant this line defines', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 7. Unrestricted cash formula
-- ============================================================

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT a.id, 'STATEMENT_PERIOD', 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE',
       '{"op": "sub", "args": [{"ref": "STATEMENT_CASH"}, {"ref": "STATEMENT_RESTRICTED_CASH"}]}'::jsonb
FROM metadata_register.attribute_register a
WHERE a.attribute_code = 'STATEMENT_UNRESTRICTED_CASH'
ON CONFLICT (attribute_id) DO UPDATE
SET expression = EXCLUDED.expression,
    updated_at = NOW();

INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'OPERAND', v.code, 'SELF', '{}'::text[], v.ord
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register a ON a.id = cd.attribute_id AND a.attribute_code = 'STATEMENT_UNRESTRICTED_CASH'
CROSS JOIN (VALUES ('STATEMENT_CASH', 1), ('STATEMENT_RESTRICTED_CASH', 2)) AS v(code, ord)
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

-- ============================================================
-- 8. Evaluating a definition
-- ============================================================

CREATE OR REPLACE FUNCTION golden_master.covenant_text(p_entity uuid, p_code text, p_as_of date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT NULLIF(btrim(golden_master.golden_literal(p_entity, p_code::varchar, p_as_of) #>> '{}'), '');
$$;

-- The borrower's latest four quarters ending on or before the test date,
-- newest first. The path is covenant -> deal -> issuer <- statement.
CREATE OR REPLACE FUNCTION golden_master.covenant_statements(p_subject uuid, p_as_of date)
RETURNS TABLE(statement_id uuid, period_end date)
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT s.id, s.period_end
    FROM (
        SELECT sid AS id, golden_master.golden_date(sid, 'STATEMENT_END'::varchar, p_as_of) AS period_end
        FROM unnest(golden_master.related_ids(
            p_subject, 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], p_as_of
        )) AS sid
    ) s
    WHERE s.period_end IS NOT NULL
      AND s.period_end <= p_as_of
    ORDER BY s.period_end DESC
    LIMIT 4;
$$;

-- Evaluates p_definition's components against p_subject's statements.
-- For a deal's own test both are the covenant. For the house standard the
-- definition is the house record and the subject is the deal's covenant.
--
-- Uncapped components on a side add up to that side's base. A capped
-- component is limited to its amount, or to a percent of the base, before
-- its sign is applied. A side with no denominator components is a plain
-- amount, such as liquidity.
CREATE OR REPLACE FUNCTION golden_master.covenant_evaluate(
    p_definition uuid,
    p_subject uuid,
    p_as_of date,
    p_depth integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_ids uuid[];
    v_ends date[];
    v_comp RECORD;
    v_items jsonb := '[]'::jsonb;
    v_item jsonb;
    v_rows jsonb := '[]'::jsonb;
    v_missing text[] := '{}';
    v_base_num numeric := 0;
    v_base_den numeric := 0;
    v_num numeric := 0;
    v_den numeric := 0;
    v_has_num boolean := FALSE;
    v_has_den boolean := FALSE;
    v_incomplete boolean := FALSE;
    v_raw numeric;
    v_limit numeric;
    v_allowed numeric;
    v_applied numeric;
    v_sign integer;
    v_value numeric;
    v_part numeric;
    v_seen integer;
    v_i integer;
    v_active boolean;
    v_side text;
    v_cap text;
BEGIN
    IF p_depth > 8 OR p_definition IS NULL OR p_subject IS NULL OR p_as_of IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT array_agg(statement_id ORDER BY period_end DESC), array_agg(period_end ORDER BY period_end DESC)
      INTO v_ids, v_ends
    FROM golden_master.covenant_statements(p_subject, p_as_of);

    IF v_ids IS NULL THEN
        v_missing := v_missing || format('No borrower statement ends on or before %s', p_as_of);
    END IF;

    FOR v_comp IN
        SELECT c.id,
               me.entity_name AS name,
               upper(COALESCE(golden_master.covenant_text(c.id, 'COMPONENT_SIDE', p_as_of), 'NUMERATOR')) AS side,
               golden_master.covenant_text(c.id, 'COMPONENT_LINE', p_as_of) AS line,
               upper(COALESCE(golden_master.covenant_text(c.id, 'COMPONENT_SIGN', p_as_of), 'ADD')) AS sign,
               upper(COALESCE(golden_master.covenant_text(c.id, 'COMPONENT_MEASURE', p_as_of), 'POINT')) AS measure,
               upper(COALESCE(golden_master.covenant_text(c.id, 'COMPONENT_CAP_TYPE', p_as_of), 'NONE')) AS cap_type,
               golden_master.golden_numeric(c.id, 'COMPONENT_CAP_VALUE'::varchar, p_as_of, p_depth + 1) AS cap_value,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_FROM'::varchar, p_as_of) AS effective_from,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_TO'::varchar, p_as_of) AS effective_to,
               golden_master.covenant_text(c.id, 'COMPONENT_CLAUSE', p_as_of) AS clause
        FROM unnest(golden_master.related_ids(p_definition, 'UP', ARRAY['COMPONENT_COVENANT'], p_as_of)) AS c(id)
        JOIN entity_instances.master_entities me ON me.id = c.id AND me.is_active
    LOOP
        v_active := (v_comp.effective_from IS NULL OR v_comp.effective_from <= p_as_of)
                AND (v_comp.effective_to IS NULL OR v_comp.effective_to >= p_as_of);
        v_raw := NULL;

        IF v_active AND v_ids IS NOT NULL AND v_comp.line IS NOT NULL THEN
            IF v_comp.measure = 'LTM' THEN
                IF cardinality(v_ids) < 4 OR v_ends[4] <= (v_ends[1] - INTERVAL '12 months')::date THEN
                    v_missing := v_missing || format('%s needs four quarters ending %s', v_comp.name, v_ends[1]);
                ELSE
                    v_raw := 0;
                    v_seen := 0;
                    FOR v_i IN 1..4 LOOP
                        v_part := golden_master.golden_numeric(v_ids[v_i], v_comp.line::varchar, p_as_of, p_depth + 1);
                        IF v_part IS NOT NULL THEN
                            v_raw := v_raw + v_part;
                            v_seen := v_seen + 1;
                        END IF;
                    END LOOP;
                    IF v_seen = 0 THEN
                        v_raw := NULL;
                    END IF;
                END IF;
            ELSE
                v_raw := golden_master.golden_numeric(v_ids[1], v_comp.line::varchar, p_as_of, p_depth + 1);
                IF v_raw IS NOT NULL AND v_comp.measure = 'ANNUALIZED' THEN
                    v_raw := v_raw * 4;
                END IF;
            END IF;
            IF v_raw IS NULL AND NOT (v_missing @> ARRAY[format('%s needs four quarters ending %s', v_comp.name, v_ends[1])]) THEN
                v_missing := v_missing || format('%s has no value for the quarter ending %s', v_comp.name, v_ends[1]);
            END IF;
        END IF;

        IF v_active AND v_comp.line IS NULL THEN
            v_missing := v_missing || format('%s has no statement line', v_comp.name);
        END IF;

        IF v_active THEN
            IF v_comp.side = 'DENOMINATOR' THEN
                v_has_den := TRUE;
            ELSE
                v_has_num := TRUE;
            END IF;
            IF v_raw IS NULL THEN
                v_incomplete := TRUE;
            END IF;
        END IF;

        v_sign := CASE WHEN v_comp.sign = 'SUBTRACT' THEN -1 ELSE 1 END;
        IF v_active AND v_raw IS NOT NULL AND v_comp.cap_type = 'NONE' THEN
            IF v_comp.side = 'DENOMINATOR' THEN
                v_base_den := v_base_den + v_sign * v_raw;
            ELSE
                v_base_num := v_base_num + v_sign * v_raw;
            END IF;
        END IF;

        v_items := v_items || jsonb_build_array(jsonb_build_object(
            'id', v_comp.id,
            'name', v_comp.name,
            'side', v_comp.side,
            'line', v_comp.line,
            'lineName', (SELECT attribute_name FROM metadata_register.attribute_register WHERE attribute_code = v_comp.line),
            'sign', v_comp.sign,
            'measure', v_comp.measure,
            'capType', v_comp.cap_type,
            'capValue', v_comp.cap_value,
            'effectiveFrom', v_comp.effective_from,
            'effectiveTo', v_comp.effective_to,
            'clause', v_comp.clause,
            'active', v_active,
            'raw', v_raw
        ));
    END LOOP;

    v_num := v_base_num;
    v_den := v_base_den;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) ORDER BY
        CASE WHEN value->>'side' = 'DENOMINATOR' THEN 1 ELSE 0 END,
        CASE WHEN value->>'capType' = 'NONE' THEN 0 ELSE 1 END,
        value->>'name'
    LOOP
        v_raw := (v_item->>'raw')::numeric;
        v_side := v_item->>'side';
        v_cap := v_item->>'capType';
        v_sign := CASE WHEN v_item->>'sign' = 'SUBTRACT' THEN -1 ELSE 1 END;
        v_limit := NULL;
        v_allowed := NULL;
        v_applied := NULL;

        IF (v_item->>'active')::boolean AND v_raw IS NOT NULL THEN
            IF v_cap = 'AMOUNT' THEN
                v_limit := (v_item->>'capValue')::numeric;
            ELSIF v_cap = 'PCT_OF_BASE' THEN
                v_limit := GREATEST(
                    COALESCE((v_item->>'capValue')::numeric, 0) / 100
                        * CASE WHEN v_side = 'DENOMINATOR' THEN v_base_den ELSE v_base_num END,
                    0
                );
            END IF;
            v_allowed := CASE WHEN v_limit IS NOT NULL AND v_raw > v_limit THEN v_limit ELSE v_raw END;
            v_applied := v_sign * v_allowed;
            IF v_cap <> 'NONE' THEN
                IF v_side = 'DENOMINATOR' THEN
                    v_den := v_den + v_applied;
                ELSE
                    v_num := v_num + v_applied;
                END IF;
            END IF;
        END IF;

        v_rows := v_rows || jsonb_build_array(v_item || jsonb_build_object(
            'capLimit', v_limit,
            'allowed', v_allowed,
            'applied', v_applied,
            'capped', v_limit IS NOT NULL AND v_raw > v_limit
        ));
    END LOOP;

    IF NOT v_has_num AND NOT v_has_den THEN
        v_missing := v_missing || 'The definition has no components in force on this date'::text;
        v_incomplete := TRUE;
    END IF;

    IF v_incomplete OR v_ids IS NULL THEN
        v_value := NULL;
    ELSIF v_has_den THEN
        IF v_den <= 0 THEN
            v_missing := v_missing || 'The denominator is zero or negative'::text;
            v_value := NULL;
        ELSE
            v_value := v_num / v_den;
        END IF;
    ELSE
        v_value := v_num;
    END IF;

    RETURN jsonb_build_object(
        'asOf', p_as_of,
        'testDate', v_ends[1],
        'statementId', v_ids[1],
        'numerator', CASE WHEN v_has_num AND NOT v_incomplete THEN v_num END,
        'denominator', CASE WHEN v_has_den AND NOT v_incomplete THEN v_den END,
        'value', v_value,
        'components', v_rows,
        'missing', to_jsonb(v_missing)
    );
END;
$$;

COMMENT ON FUNCTION golden_master.covenant_evaluate(uuid, uuid, date, integer) IS
    'Evaluates the components of one covenant definition against another covenant''s borrower statements. Returns the value and a line-by-line breakdown.';

-- The house standard for a covenant's metric, in the covenant's client.
CREATE OR REPLACE FUNCTION golden_master.covenant_house(p_covenant uuid, p_as_of date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT h.id
    FROM entity_instances.master_entities c
    JOIN entity_instances.master_entities h
      ON h.domain_code = 'DEAL_COVENANT'
     AND h.is_active
     AND h.client_id IS NOT DISTINCT FROM c.client_id
    WHERE c.id = p_covenant
      AND lower(COALESCE(golden_master.covenant_text(h.id, 'COVENANT_IS_HOUSE', p_as_of), 'false')) = 'true'
      AND golden_master.covenant_text(h.id, 'COVENANT_METRIC', p_as_of)
          = golden_master.covenant_text(c.id, 'COVENANT_METRIC', p_as_of)
    ORDER BY h.entity_code
    LIMIT 1;
$$;

-- eval_calc is unchanged except for the DEFINITION branch.
CREATE OR REPLACE FUNCTION golden_master.eval_calc(p_calc_id uuid, p_entity_id uuid, p_as_of date, p_depth integer DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_result JSONB;
    v_ids UUID[];
    v_entity UUID;
    v_value NUMERIC;
    v_weight NUMERIC;
    v_weighted NUMERIC := 0;
    v_weight_sum NUMERIC := 0;
    v_sum NUMERIC := 0;
    v_min NUMERIC;
    v_max NUMERIC;
    v_count INTEGER := 0;
    v_dates DATE[] := '{}';
    v_amounts NUMERIC[] := '{}';
    v_amount_code VARCHAR(100);
    v_date_code VARCHAR(100);
    v_terminal_code VARCHAR(100);
    v_path TEXT[];
    v_traversal TEXT;
    v_flow_date DATE;
    v_amount NUMERIC;
    v_terminal NUMERIC;
    v_weight_code VARCHAR(100);
BEGIN
    IF p_depth > 8 THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- DEFINITION: the entity's own component records are the formula.
    IF v_def.calc_kind = 'DEFINITION' THEN
        RETURN (golden_master.covenant_evaluate(p_entity_id, p_entity_id, p_as_of, p_depth + 1)->>'value')::NUMERIC;
    END IF;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        v_result := golden_master.eval_expression_result(p_calc_id, p_entity_id, p_as_of, p_depth);
        IF v_result IS NULL OR jsonb_typeof(v_result) = 'null' THEN
            RETURN NULL;
        END IF;
        IF jsonb_typeof(v_result) = 'number'
           OR (jsonb_typeof(v_result) = 'string' AND (v_result #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$') THEN
            RETURN (v_result #>> '{}')::NUMERIC;
        END IF;
        RETURN NULL;
    END IF;

    IF v_def.calc_kind = 'AGGREGATE' THEN
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'MEASURE'
        LIMIT 1;
        v_ids := golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);

        SELECT attribute_code INTO v_weight_code
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'WEIGHT'
        LIMIT 1;

        FOREACH v_entity IN ARRAY v_ids LOOP
            v_value := golden_master.golden_numeric(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
            IF v_value IS NULL THEN
                CONTINUE;
            END IF;
            v_count := v_count + 1;
            v_sum := v_sum + v_value;
            v_min := LEAST(COALESCE(v_min, v_value), v_value);
            v_max := GREATEST(COALESCE(v_max, v_value), v_value);
            IF v_def.aggregate_fn = 'WAVG' THEN
                v_weight := golden_master.golden_numeric(v_entity, v_weight_code, p_as_of, p_depth + 1);
                IF v_weight IS NOT NULL THEN
                    v_weighted := v_weighted + (v_value * v_weight);
                    v_weight_sum := v_weight_sum + v_weight;
                END IF;
            END IF;
        END LOOP;

        IF v_count = 0 THEN
            RETURN NULL;
        END IF;
        IF v_def.aggregate_fn = 'SUM' THEN
            RETURN v_sum;
        ELSIF v_def.aggregate_fn = 'MIN' THEN
            RETURN v_min;
        ELSIF v_def.aggregate_fn = 'MAX' THEN
            RETURN v_max;
        ELSIF v_def.aggregate_fn = 'WAVG' THEN
            IF v_weight_sum = 0 THEN
                RETURN NULL;
            END IF;
            RETURN v_weighted / v_weight_sum;
        END IF;
        RETURN NULL;
    END IF;

    -- SERIES: the same function answers a stored window and a query-time period.
    RETURN golden_master.series_value(
        p_calc_id, p_entity_id,
        golden_master.series_window_start(v_def.series_window, p_as_of), p_as_of,
        v_def.series_fn, p_depth
    );
END;
$function$;

-- ============================================================
-- 9. The calculated covenant
-- ============================================================

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain
)
SELECT a.id, 'DEAL_COVENANT', 'DEFINITION', 'MATERIALIZED', 'FORWARD', 'QUARTER_END'
FROM metadata_register.attribute_register a
WHERE a.attribute_code = 'COVENANT_CURRENT'
ON CONFLICT (attribute_id) DO UPDATE
SET calc_kind = EXCLUDED.calc_kind,
    evaluation_mode = EXCLUDED.evaluation_mode,
    time_impact = EXCLUDED.time_impact,
    output_grain = EXCLUDED.output_grain,
    expression = NULL,
    updated_at = NOW();

-- Inputs only drive invalidation: a change to a component or to one of the
-- borrower's statement lines marks the covenant for recalculation.
INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'OPERAND', v.code, v.traversal, v.codes, v.ord
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register a ON a.id = cd.attribute_id AND a.attribute_code = 'COVENANT_CURRENT'
CROSS JOIN (VALUES
    ('COMPONENT_SIDE', 'UP', ARRAY['COMPONENT_COVENANT'], 1),
    ('COMPONENT_LINE', 'UP', ARRAY['COMPONENT_COVENANT'], 2),
    ('COMPONENT_SIGN', 'UP', ARRAY['COMPONENT_COVENANT'], 3),
    ('COMPONENT_MEASURE', 'UP', ARRAY['COMPONENT_COVENANT'], 4),
    ('COMPONENT_CAP_TYPE', 'UP', ARRAY['COMPONENT_COVENANT'], 5),
    ('COMPONENT_CAP_VALUE', 'UP', ARRAY['COMPONENT_COVENANT'], 6),
    ('COMPONENT_EFFECTIVE_FROM', 'UP', ARRAY['COMPONENT_COVENANT'], 7),
    ('COMPONENT_EFFECTIVE_TO', 'UP', ARRAY['COMPONENT_COVENANT'], 8),
    ('STATEMENT_END', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 10),
    ('STATEMENT_REVENUE', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 11),
    ('STATEMENT_COGS', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 12),
    ('STATEMENT_SM', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 13),
    ('STATEMENT_RD', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 14),
    ('STATEMENT_GA', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 15),
    ('STATEMENT_DA', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 16),
    ('STATEMENT_INTEREST', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 17),
    ('STATEMENT_TAX', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 18),
    ('STATEMENT_CASH', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 19),
    ('STATEMENT_DEBT', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 20),
    ('STATEMENT_PPE', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 21),
    ('STATEMENT_RESTRICTED_CASH', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 22),
    ('STATEMENT_LC_OUTSTANDING', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 23),
    ('STATEMENT_RESTRUCTURING', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 24),
    ('STATEMENT_TRANSACTION_COSTS', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 25),
    ('STATEMENT_STOCK_COMP', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 26),
    ('STATEMENT_PF_SYNERGIES', 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], 27)
) AS v(code, traversal, codes, ord)
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO UPDATE
SET traversal = EXCLUDED.traversal,
    relationship_codes = EXCLUDED.relationship_codes,
    ordinal = EXCLUDED.ordinal;

-- ============================================================
-- 10. Reading, copying, and recalculating from the app
-- ============================================================

-- Writes one source's value, replacing that source's open row.
CREATE OR REPLACE FUNCTION golden_master.covenant_put_value(
    p_entity uuid,
    p_code text,
    p_value text,
    p_source text DEFAULT 'MANUAL',
    p_valid_from date DEFAULT DATE '2020-01-01'
)
RETURNS void
LANGUAGE plpgsql
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_attr metadata_register.attribute_register%ROWTYPE;
    v_source uuid;
BEGIN
    SELECT * INTO v_attr FROM metadata_register.attribute_register WHERE attribute_code = p_code;
    SELECT id INTO v_source FROM entity_instances.source_registry WHERE source_code = p_source;
    IF v_attr.id IS NULL OR v_source IS NULL THEN
        RAISE EXCEPTION 'Unknown attribute % or source %', p_code, p_source;
    END IF;

    UPDATE golden_master.entity_attribute_values
    SET system_to = clock_timestamp()
    WHERE entity_id = p_entity
      AND attribute_id = v_attr.id
      AND source_id = v_source
      AND valid_to = DATE '9999-12-31'
      AND system_to = golden_master.open_system_to();

    IF p_value IS NULL OR btrim(p_value) = '' THEN
        RETURN;
    END IF;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, created_by
    ) VALUES (
        p_entity, v_attr.id, v_source, p_value,
        CASE WHEN v_attr.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN p_value::numeric END,
        CASE WHEN v_attr.data_type = 'DATE' THEN p_value::date END,
        CASE WHEN v_attr.data_type = 'BOOLEAN' THEN p_value::boolean END,
        p_valid_from, DATE '9999-12-31', COALESCE(v_attr.default_precedence_rank, 100), auth.uid()
    );
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.covenant_summary(p_covenant uuid, p_as_of date, p_history integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_entity entity_instances.master_entities%ROWTYPE;
    v_own jsonb;
    v_house uuid;
    v_house_result jsonb;
    v_history jsonb := '[]'::jsonb;
    v_reported jsonb;
    v_deal RECORD;
    v_quarter date;
    v_k integer;
BEGIN
    SELECT * INTO v_entity FROM entity_instances.master_entities WHERE id = p_covenant AND domain_code = 'DEAL_COVENANT';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_own := golden_master.covenant_evaluate(p_covenant, p_covenant, p_as_of, 0);
    v_house := golden_master.covenant_house(p_covenant, p_as_of);
    IF v_house IS NOT NULL AND v_house <> p_covenant THEN
        v_house_result := golden_master.covenant_evaluate(v_house, p_covenant, p_as_of, 0);
    END IF;

    SELECT d.id, d.entity_name INTO v_deal
    FROM unnest(golden_master.related_ids(p_covenant, 'DOWN', ARRAY['COVENANT_DEAL'], p_as_of)) AS r(id)
    JOIN entity_instances.master_entities d ON d.id = r.id
    LIMIT 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'sourceCode', sr.source_code,
               'sourceName', sr.source_name,
               'value', eav.golden_value_numeric,
               'validFrom', eav.valid_from
           ) ORDER BY sr.precedence_rank, sr.source_code), '[]'::jsonb)
      INTO v_reported
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id AND ar.attribute_code = 'COVENANT_CURRENT'
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_covenant
      AND sr.source_code NOT IN ('DERIVED', 'CALCULATED')
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = golden_master.open_system_to();

    FOR v_k IN 0..GREATEST(COALESCE(p_history, 0), 0) - 1 LOOP
        v_quarter := (date_trunc('quarter', p_as_of + 1) - make_interval(months => 3 * v_k) - INTERVAL '1 day')::date;
        v_history := jsonb_build_array(jsonb_build_object(
            'testDate', v_quarter,
            'value', golden_master.covenant_evaluate(p_covenant, p_covenant, v_quarter, 0)->'value',
            'house', CASE WHEN v_house IS NOT NULL AND v_house <> p_covenant
                          THEN golden_master.covenant_evaluate(v_house, p_covenant, v_quarter, 0)->'value' END
        )) || v_history;
    END LOOP;

    RETURN v_own || jsonb_build_object(
        'covenantId', v_entity.id,
        'code', v_entity.entity_code,
        'name', v_entity.entity_name,
        'dealId', v_deal.id,
        'dealName', v_deal.entity_name,
        'metric', golden_master.covenant_text(p_covenant, 'COVENANT_METRIC', p_as_of),
        'direction', golden_master.covenant_text(p_covenant, 'COVENANT_DIRECTION', p_as_of),
        'unit', golden_master.covenant_text(p_covenant, 'COVENANT_UNIT', p_as_of),
        'level', golden_master.golden_numeric(p_covenant, 'COVENANT_LEVEL'::varchar, p_as_of, 0),
        'firstTest', golden_master.golden_date(p_covenant, 'COVENANT_FIRST_TEST'::varchar, p_as_of),
        'isLibrary', lower(COALESCE(golden_master.covenant_text(p_covenant, 'COVENANT_IS_LIBRARY', p_as_of), 'false')) = 'true',
        'isHouse', lower(COALESCE(golden_master.covenant_text(p_covenant, 'COVENANT_IS_HOUSE', p_as_of), 'false')) = 'true',
        'stored', golden_master.golden_numeric(p_covenant, 'COVENANT_CURRENT'::varchar, p_as_of, 0),
        'houseId', v_house,
        'houseName', (SELECT entity_name FROM entity_instances.master_entities WHERE id = v_house),
        'house', v_house_result->'value',
        'reported', v_reported,
        'history', v_history
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.covenant_test(p_covenant_id uuid, p_as_of date DEFAULT NULL, p_history integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
BEGIN
    IF NOT tenancy.has_entity_access(p_covenant_id, 'READ') THEN
        RAISE EXCEPTION 'Covenant not found';
    END IF;
    RETURN golden_master.covenant_summary(p_covenant_id, COALESCE(p_as_of, CURRENT_DATE), LEAST(COALESCE(p_history, 8), 16));
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_covenant_tests(p_deal_id uuid, p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_as_of date := COALESCE(p_as_of, CURRENT_DATE);
BEGIN
    IF NOT tenancy.has_entity_access(p_deal_id, 'READ') THEN
        RAISE EXCEPTION 'Deal not found';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(golden_master.covenant_summary(c.id, v_as_of, 0) ORDER BY c.entity_code)
        FROM unnest(golden_master.related_ids(p_deal_id, 'UP', ARRAY['COVENANT_DEAL'], v_as_of)) AS r(id)
        JOIN entity_instances.master_entities c ON c.id = r.id AND c.is_active
        WHERE tenancy.has_entity_access(c.id, 'READ')
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.covenant_library(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_as_of date := COALESCE(p_as_of, CURRENT_DATE);
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', c.id,
                   'name', c.entity_name,
                   'description', c.description,
                   'metric', golden_master.covenant_text(c.id, 'COVENANT_METRIC', v_as_of),
                   'isHouse', lower(COALESCE(golden_master.covenant_text(c.id, 'COVENANT_IS_HOUSE', v_as_of), 'false')) = 'true',
                   'componentCount', cardinality(golden_master.related_ids(c.id, 'UP', ARRAY['COMPONENT_COVENANT'], v_as_of))
               ) ORDER BY c.entity_name)
        FROM entity_instances.master_entities c
        WHERE c.domain_code = 'DEAL_COVENANT'
          AND c.is_active
          AND lower(COALESCE(golden_master.covenant_text(c.id, 'COVENANT_IS_LIBRARY', v_as_of), 'false')) = 'true'
          AND tenancy.has_entity_access(c.id, 'READ')
    ), '[]'::jsonb);
END;
$$;

-- Recalculates the stored covenant reading for every quarter from p_from.
CREATE OR REPLACE FUNCTION public.recalculate_covenant(p_covenant_id uuid, p_from date DEFAULT DATE '2024-01-01')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_attr uuid;
BEGIN
    IF NOT tenancy.has_entity_access(p_covenant_id, 'WRITE') THEN
        RAISE EXCEPTION 'You cannot change this covenant';
    END IF;
    SELECT id INTO v_attr FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_CURRENT';
    PERFORM golden_master.enqueue_calc(v_attr, p_covenant_id, COALESCE(p_from, DATE '2024-01-01'), DATE '9999-12-31', NULL, NULL, NULL);
    RETURN golden_master.process_calc_invalidations(200, p_covenant_id);
END;
$$;

-- Replaces a covenant's definition from p_effective_from with a copy of
-- another definition. Components in force before that date are closed the
-- day before, so earlier quarters keep the definition they were tested under.
CREATE OR REPLACE FUNCTION public.copy_covenant_definition(
    p_covenant_id uuid,
    p_from_covenant_id uuid,
    p_effective_from date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_target entity_instances.master_entities%ROWTYPE;
    v_template uuid;
    v_comp RECORD;
    v_new uuid;
    v_count integer := 0;
    v_stamp text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
    v_code text;
    v_metric text;
BEGIN
    IF p_effective_from IS NULL THEN
        RAISE EXCEPTION 'Choose the first test date the new definition applies to';
    END IF;
    IF p_covenant_id = p_from_covenant_id THEN
        RAISE EXCEPTION 'Choose a different definition to copy from';
    END IF;
    IF NOT tenancy.has_entity_access(p_covenant_id, 'WRITE') THEN
        RAISE EXCEPTION 'You cannot change this covenant';
    END IF;
    IF NOT tenancy.has_entity_access(p_from_covenant_id, 'READ') THEN
        RAISE EXCEPTION 'Definition not found';
    END IF;

    SELECT * INTO v_target FROM entity_instances.master_entities WHERE id = p_covenant_id AND domain_code = 'DEAL_COVENANT';
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM entity_instances.master_entities WHERE id = p_from_covenant_id AND domain_code = 'DEAL_COVENANT'
    ) THEN
        RAISE EXCEPTION 'Both records must be covenants';
    END IF;
    SELECT id INTO v_template FROM metadata_register.domain_templates WHERE template_code = 'COVENANT_COMPONENT_STANDARD';

    -- Close the target's components that are still in force on the date.
    FOR v_comp IN
        SELECT c.id,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_FROM'::varchar, p_effective_from) AS effective_from,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_TO'::varchar, p_effective_from) AS effective_to
        FROM unnest(golden_master.related_ids(p_covenant_id, 'UP', ARRAY['COMPONENT_COVENANT'], p_effective_from)) AS c(id)
        JOIN entity_instances.master_entities me ON me.id = c.id AND me.is_active
    LOOP
        IF v_comp.effective_to IS NOT NULL AND v_comp.effective_to < p_effective_from THEN
            CONTINUE;
        END IF;
        IF v_comp.effective_from IS NOT NULL AND v_comp.effective_from >= p_effective_from THEN
            UPDATE entity_instances.master_entities SET is_active = FALSE, updated_at = NOW() WHERE id = v_comp.id;
        ELSE
            PERFORM golden_master.covenant_put_value(v_comp.id, 'COMPONENT_EFFECTIVE_TO', (p_effective_from - 1)::text);
        END IF;
    END LOOP;

    -- Copy the source's components in force on the date.
    FOR v_comp IN
        SELECT c.id, me.entity_name, me.description,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_FROM'::varchar, p_effective_from) AS effective_from,
               golden_master.golden_date(c.id, 'COMPONENT_EFFECTIVE_TO'::varchar, p_effective_from) AS effective_to
        FROM unnest(golden_master.related_ids(p_from_covenant_id, 'UP', ARRAY['COMPONENT_COVENANT'], p_effective_from)) AS c(id)
        JOIN entity_instances.master_entities me ON me.id = c.id AND me.is_active
        ORDER BY me.entity_code
    LOOP
        IF (v_comp.effective_from IS NOT NULL AND v_comp.effective_from > p_effective_from)
           OR (v_comp.effective_to IS NOT NULL AND v_comp.effective_to < p_effective_from) THEN
            CONTINUE;
        END IF;
        v_count := v_count + 1;
        v_code := v_target.entity_code || '-C' || v_stamp || '-' || v_count;

        INSERT INTO entity_instances.master_entities (
            entity_code, domain_code, template_id, entity_name, description, client_id, created_by, metadata
        ) VALUES (
            v_code, 'COVENANT_COMPONENT', v_template, v_comp.entity_name, v_comp.description,
            v_target.client_id, auth.uid(), jsonb_build_object('copiedFrom', v_comp.id)
        )
        RETURNING id INTO v_new;

        INSERT INTO entity_instances.entity_relationships (
            parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
        ) VALUES (
            v_new, p_covenant_id, 'Component of covenant', 'COMPONENT_COVENANT', TRUE, DATE '2020-01-01'
        );

        PERFORM golden_master.covenant_put_value(v_new, code, golden_master.covenant_text(v_comp.id, code, p_effective_from))
        FROM unnest(ARRAY[
            'COMPONENT_SIDE', 'COMPONENT_LINE', 'COMPONENT_SIGN', 'COMPONENT_MEASURE',
            'COMPONENT_CAP_TYPE', 'COMPONENT_CAP_VALUE', 'COMPONENT_CLAUSE', 'COMPONENT_EFFECTIVE_TO'
        ]) AS code;
        PERFORM golden_master.covenant_put_value(v_new, 'COMPONENT_EFFECTIVE_FROM', p_effective_from::text);
    END LOOP;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'That definition has no components in force on %', p_effective_from;
    END IF;

    v_metric := golden_master.covenant_text(p_from_covenant_id, 'COVENANT_METRIC', p_effective_from);
    IF v_metric IS NOT NULL AND golden_master.covenant_text(p_covenant_id, 'COVENANT_METRIC', p_effective_from) IS NULL THEN
        PERFORM golden_master.covenant_put_value(p_covenant_id, 'COVENANT_METRIC', v_metric);
    END IF;

    PERFORM public.recalculate_covenant(p_covenant_id, LEAST(p_effective_from, DATE '2024-01-01'));
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.covenant_test(uuid, date, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.deal_covenant_tests(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.covenant_library(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recalculate_covenant(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.copy_covenant_definition(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.covenant_test(uuid, date, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_covenant_tests(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.covenant_library(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_covenant(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copy_covenant_definition(uuid, uuid, date) TO authenticated, service_role;

-- ============================================================
-- 11. The covenant's working screen
-- ============================================================

INSERT INTO public.record_experiences (
    experience_code, experience_name, description, anchor_domain_code,
    sections, pipeline, is_default, is_active
) VALUES (
    'COVENANT_WORKSPACE',
    'Covenant',
    'The covenant test, its definition line by line, and the borrower''s certificate next to the calculation.',
    'DEAL_COVENANT',
    '[
      {"key":"covenant","title":"Covenant","kind":"FORM","placement":"CANVAS","domainCode":"DEAL_COVENANT","templateCode":"DEAL_COVENANT_STANDARD"},
      {"key":"test","title":"Test","kind":"COVENANT_TEST","placement":"TAB"},
      {"key":"definition","title":"Definition","kind":"GRID","placement":"TAB","domainCode":"COVENANT_COMPONENT","relationshipCode":"COMPONENT_COVENANT","direction":"UP","templateCode":"COVENANT_COMPONENT_STANDARD","columns":["COMPONENT_SIDE","COMPONENT_LINE","COMPONENT_SIGN","COMPONENT_MEASURE","COMPONENT_CAP_TYPE","COMPONENT_CAP_VALUE","COMPONENT_EFFECTIVE_FROM","COMPONENT_EFFECTIVE_TO","COMPONENT_CLAUSE"]}
    ]'::jsonb,
    NULL,
    TRUE,
    TRUE
)
ON CONFLICT (experience_code) DO UPDATE
SET experience_name = EXCLUDED.experience_name,
    description = EXCLUDED.description,
    anchor_domain_code = EXCLUDED.anchor_domain_code,
    sections = EXCLUDED.sections,
    is_default = EXCLUDED.is_default,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

NOTIFY pgrst, 'reload schema';
