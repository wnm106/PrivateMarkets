-- Migration: Derived Attributes & Enhanced Data Types
-- Description: Adds derived attribute support with formulas, enhanced data types,
--              and database functions for formula evaluation

-- ============================================================
-- 1. Add derived attribute columns to attribute_register
-- ============================================================

ALTER TABLE metadata_register.attribute_register 
ADD COLUMN IF NOT EXISTS is_derived BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS derivation_formula TEXT,
ADD COLUMN IF NOT EXISTS derivation_dependencies JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS derivation_type VARCHAR(50),
ADD COLUMN IF NOT EXISTS formula_language VARCHAR(20) DEFAULT 'SQL';

-- Derivation types:
-- SIMPLE:    Direct calculation from other attributes
-- AGGREGATE: Sum/avg/count across related entities
-- LOOKUP:    Fetch from related entity
-- CUSTOM:    Complex formula with SQL/JS expression

COMMENT ON COLUMN metadata_register.attribute_register.is_derived IS 'Whether this attribute is calculated from other attributes';
COMMENT ON COLUMN metadata_register.attribute_register.derivation_formula IS 'Formula expression (SQL, JavaScript, or custom DSL)';
COMMENT ON COLUMN metadata_register.attribute_register.derivation_dependencies IS 'Array of attribute codes this derivation depends on';
COMMENT ON COLUMN metadata_register.attribute_register.derivation_type IS 'Type of derivation: SIMPLE, AGGREGATE, LOOKUP, CUSTOM';
COMMENT ON COLUMN metadata_register.attribute_register.formula_language IS 'Language of the formula expression: SQL, JS, DSL';

-- Index for querying derived attributes efficiently
CREATE INDEX IF NOT EXISTS idx_attribute_register_derived 
    ON metadata_register.attribute_register(is_derived) 
    WHERE is_derived = TRUE;

CREATE INDEX IF NOT EXISTS idx_attribute_register_derivation_type 
    ON metadata_register.attribute_register(derivation_type) 
    WHERE is_derived = TRUE;

-- ============================================================
-- 2. Enhanced data types constraint
-- ============================================================

-- Drop the old constraint if it exists (from original migration)
ALTER TABLE metadata_register.attribute_register
DROP CONSTRAINT IF EXISTS attribute_register_data_type_check;

-- Add expanded constraint with all supported data types
ALTER TABLE metadata_register.attribute_register
ADD CONSTRAINT attribute_register_data_type_check 
CHECK (data_type IN (
    'STRING',           -- Text values
    'NUMBER',           -- Numeric (integer or decimal)
    'INTEGER',          -- Integer only
    'DECIMAL',          -- Decimal with precision
    'BOOLEAN',          -- True/false
    'DATE',             -- Date only
    'TIMESTAMP',        -- Date and time
    'JSON',             -- JSON object
    'REFERENCE',        -- Reference to another entity
    'REFERENCE_LIST',   -- Reference to controlled vocabulary
    'CURRENCY',         -- Monetary amount
    'PERCENTAGE',       -- Percentage value
    'EMAIL',            -- Email address
    'URL',              -- URL
    'PHONE'             -- Phone number
));

COMMENT ON CONSTRAINT attribute_register_data_type_check ON metadata_register.attribute_register IS 
'Constrains data_type to supported types: STRING, NUMBER, INTEGER, DECIMAL, BOOLEAN, DATE, TIMESTAMP, JSON, REFERENCE, REFERENCE_LIST, CURRENCY, PERCENTAGE, EMAIL, URL, PHONE';

-- ============================================================
-- 3. Database functions for formula evaluation
-- ============================================================

-- Function to evaluate simple formulas (returns NUMERIC)
CREATE OR REPLACE FUNCTION metadata_register.evaluate_simple_formula(
    p_entity_id UUID,
    p_formula TEXT,
    p_as_of_date DATE
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_result NUMERIC;
    v_sanitized_formula TEXT;
BEGIN
    -- Validate inputs
    IF p_entity_id IS NULL OR p_formula IS NULL THEN
        RETURN NULL;
    END IF;

    -- Basic safety: only allow SELECT statements
    v_sanitized_formula := trim(p_formula);
    IF UPPER(v_sanitized_formula) NOT LIKE 'SELECT%' THEN
        RAISE EXCEPTION 'Formula must be a SELECT statement';
    END IF;

    -- Execute the formula as dynamic SQL
    -- The formula should reference entity_attribute_values or similar tables
    -- and use p_entity_id and p_as_of_date as bind parameters
    EXECUTE v_sanitized_formula INTO v_result USING p_entity_id, p_as_of_date;
    
    RETURN v_result;
EXCEPTION 
    WHEN OTHERS THEN
        RAISE WARNING 'Error evaluating simple formula for entity %: %', p_entity_id, SQLERRM;
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_simple_formula IS 
'Evaluates a simple derivation formula (SQL SELECT) and returns a NUMERIC result. Formulas must be SELECT statements.';

-- Function to evaluate aggregate formulas (returns NUMERIC)
CREATE OR REPLACE FUNCTION metadata_register.evaluate_aggregate_formula(
    p_entity_id UUID,
    p_formula TEXT,
    p_as_of_date DATE
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_result NUMERIC;
    v_sanitized_formula TEXT;
BEGIN
    IF p_entity_id IS NULL OR p_formula IS NULL THEN
        RETURN NULL;
    END IF;

    v_sanitized_formula := trim(p_formula);
    IF UPPER(v_sanitized_formula) NOT LIKE 'SELECT%' THEN
        RAISE EXCEPTION 'Formula must be a SELECT statement';
    END IF;

    EXECUTE v_sanitized_formula INTO v_result USING p_entity_id, p_as_of_date;
    
    RETURN COALESCE(v_result, 0);
EXCEPTION 
    WHEN OTHERS THEN
        RAISE WARNING 'Error evaluating aggregate formula for entity %: %', p_entity_id, SQLERRM;
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_aggregate_formula IS 
'Evaluates an aggregate derivation formula (SUM, AVG, COUNT) and returns a NUMERIC result.';

-- Function to evaluate lookup formulas (returns TEXT)
CREATE OR REPLACE FUNCTION metadata_register.evaluate_lookup_formula(
    p_entity_id UUID,
    p_formula TEXT,
    p_as_of_date DATE
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_result TEXT;
    v_sanitized_formula TEXT;
BEGIN
    IF p_entity_id IS NULL OR p_formula IS NULL THEN
        RETURN NULL;
    END IF;

    v_sanitized_formula := trim(p_formula);
    IF UPPER(v_sanitized_formula) NOT LIKE 'SELECT%' THEN
        RAISE EXCEPTION 'Formula must be a SELECT statement';
    END IF;

    EXECUTE v_sanitized_formula INTO v_result USING p_entity_id, p_as_of_date;
    
    RETURN v_result;
EXCEPTION 
    WHEN OTHERS THEN
        RAISE WARNING 'Error evaluating lookup formula for entity %: %', p_entity_id, SQLERRM;
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_lookup_formula IS 
'Evaluates a lookup derivation formula that fetches a value from a related entity.';

-- Function to evaluate custom formulas (returns JSONB for flexibility)
CREATE OR REPLACE FUNCTION metadata_register.evaluate_custom_formula(
    p_entity_id UUID,
    p_formula TEXT,
    p_as_of_date DATE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_result JSONB;
    v_sanitized_formula TEXT;
BEGIN
    IF p_entity_id IS NULL OR p_formula IS NULL THEN
        RETURN NULL;
    END IF;

    v_sanitized_formula := trim(p_formula);
    IF UPPER(v_sanitized_formula) NOT LIKE 'SELECT%' THEN
        RAISE EXCEPTION 'Formula must be a SELECT statement';
    END IF;

    EXECUTE v_sanitized_formula INTO v_result USING p_entity_id, p_as_of_date;
    
    RETURN v_result;
EXCEPTION 
    WHEN OTHERS THEN
        RAISE WARNING 'Error evaluating custom formula for entity %: %', p_entity_id, SQLERRM;
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_custom_formula IS 
'Evaluates a custom derivation formula and returns a JSONB result for maximum flexibility.';

-- ============================================================
-- 4. Helper function: Evaluate any derived attribute by code
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.evaluate_derived_attribute(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_attr RECORD;
    v_result JSONB;
    v_numeric_result NUMERIC;
    v_text_result TEXT;
BEGIN
    -- Get the attribute definition
    SELECT * INTO v_attr
    FROM metadata_register.attribute_register
    WHERE attribute_code = p_attribute_code
      AND is_derived = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'Derived attribute not found: ' || p_attribute_code);
    END IF;

    -- Evaluate based on derivation type
    CASE v_attr.derivation_type
        WHEN 'SIMPLE' THEN
            v_numeric_result := metadata_register.evaluate_simple_formula(
                p_entity_id, v_attr.derivation_formula, p_as_of_date
            );
            v_result := jsonb_build_object(
                'value', v_numeric_result,
                'attribute_code', p_attribute_code,
                'derivation_type', 'SIMPLE',
                'evaluated_at', NOW()
            );
            
        WHEN 'AGGREGATE' THEN
            v_numeric_result := metadata_register.evaluate_aggregate_formula(
                p_entity_id, v_attr.derivation_formula, p_as_of_date
            );
            v_result := jsonb_build_object(
                'value', v_numeric_result,
                'attribute_code', p_attribute_code,
                'derivation_type', 'AGGREGATE',
                'evaluated_at', NOW()
            );
            
        WHEN 'LOOKUP' THEN
            v_text_result := metadata_register.evaluate_lookup_formula(
                p_entity_id, v_attr.derivation_formula, p_as_of_date
            );
            v_result := jsonb_build_object(
                'value', v_text_result,
                'attribute_code', p_attribute_code,
                'derivation_type', 'LOOKUP',
                'evaluated_at', NOW()
            );
            
        WHEN 'CUSTOM' THEN
            v_result := metadata_register.evaluate_custom_formula(
                p_entity_id, v_attr.derivation_formula, p_as_of_date
            );
            IF v_result IS NOT NULL AND NOT v_result ? 'attribute_code' THEN
                v_result := v_result || jsonb_build_object(
                    'attribute_code', p_attribute_code,
                    'derivation_type', 'CUSTOM',
                    'evaluated_at', NOW()
                );
            END IF;
            
        ELSE
            v_result := jsonb_build_object(
                'error', 'Unknown derivation type: ' || v_attr.derivation_type
            );
    END CASE;

    -- Add dependencies info
    v_result := v_result || jsonb_build_object(
        'dependencies', v_attr.derivation_dependencies
    );

    RETURN v_result;
EXCEPTION 
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'error', SQLERRM,
            'attribute_code', p_attribute_code,
            'evaluated_at', NOW()
        );
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_derived_attribute IS 
'Universal evaluator for any derived attribute. Returns JSONB with value, metadata, and dependencies.';

-- ============================================================
-- 5. Batch evaluation function for multiple derived attributes
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.evaluate_derived_attributes_batch(
    p_entity_id UUID,
    p_attribute_codes JSONB,  -- Array of attribute codes as JSONB
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_code TEXT;
    v_result JSONB;
    v_results JSONB := '{}'::jsonb;
BEGIN
    -- Iterate through each attribute code and evaluate
    FOR v_code IN SELECT jsonb_array_elements_text(p_attribute_codes)
    LOOP
        v_result := metadata_register.evaluate_derived_attribute(
            p_entity_id, v_code, p_as_of_date
        );
        v_results := v_results || jsonb_build_object(v_code, v_result);
    END LOOP;

    RETURN v_results;
EXCEPTION 
    WHEN OTHERS THEN
        RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION metadata_register.evaluate_derived_attributes_batch IS 
'Evaluates multiple derived attributes for an entity in a single call.';

-- ============================================================
-- 6. Dependency validation function
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.validate_derivation_dependencies(
    p_attribute_code VARCHAR,
    p_dependencies JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_dep TEXT;
    v_missing TEXT[] := '{}';
BEGIN
    -- Check that all dependency attribute codes exist
    FOR v_dep IN SELECT jsonb_array_elements_text(p_dependencies)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM metadata_register.attribute_register 
            WHERE attribute_code = v_dep
        ) THEN
            v_missing := v_missing || v_dep;
        END IF;
    END LOOP;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE WARNING 'Missing dependency attributes for %: %', p_attribute_code, array_to_string(v_missing, ', ');
        RETURN FALSE;
    END IF;

    RETURN TRUE;
EXCEPTION 
    WHEN OTHERS THEN
        RAISE WARNING 'Error validating dependencies: %', SQLERRM;
        RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION metadata_register.validate_derivation_dependencies IS 
'Validates that all dependency attribute codes exist in the attribute register.';

-- ============================================================
-- 7. Trigger to validate derived attributes on insert/update
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.validate_derived_attribute_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Only validate if this is a derived attribute
    IF NEW.is_derived = TRUE THEN
        -- Ensure derivation type is set
        IF NEW.derivation_type IS NULL THEN
            RAISE EXCEPTION 'derivation_type is required for derived attributes';
        END IF;

        -- Ensure derivation type is valid
        IF NEW.derivation_type NOT IN ('SIMPLE', 'AGGREGATE', 'LOOKUP', 'CUSTOM') THEN
            RAISE EXCEPTION 'derivation_type must be one of: SIMPLE, AGGREGATE, LOOKUP, CUSTOM';
        END IF;

        -- Ensure formula is set
        IF NEW.derivation_formula IS NULL OR trim(NEW.derivation_formula) = '' THEN
            RAISE EXCEPTION 'derivation_formula is required for derived attributes';
        END IF;

        -- Validate dependencies exist
        IF NEW.derivation_dependencies IS NOT NULL 
           AND jsonb_array_length(NEW.derivation_dependencies) > 0 THEN
            IF NOT metadata_register.validate_derivation_dependencies(
                NEW.attribute_code, NEW.derivation_dependencies
            ) THEN
                RAISE EXCEPTION 'Invalid derivation dependencies for attribute: %', NEW.attribute_code;
            END IF;
        END IF;

        -- Prevent circular dependencies (simple check)
        IF NEW.attribute_code = ANY(
            SELECT jsonb_array_elements_text(COALESCE(NEW.derivation_dependencies, '[]'::jsonb))
        ) THEN
            RAISE EXCEPTION 'Attribute cannot depend on itself: %', NEW.attribute_code;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS trg_validate_derived_attribute ON metadata_register.attribute_register;
CREATE TRIGGER trg_validate_derived_attribute
    BEFORE INSERT OR UPDATE ON metadata_register.attribute_register
    FOR EACH ROW
    WHEN (NEW.is_derived = TRUE)
    EXECUTE FUNCTION metadata_register.validate_derived_attribute_trigger();

-- ============================================================
-- 8. Seed data: Derived attribute examples
-- ============================================================

-- Insert derived attributes demonstrating each derivation type

-- Insert dependency attributes first to satisfy derived attribute requirements
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
VALUES
('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100),
('POSITION.MARKET_VALUE', 'Position Market Value', 'CURRENCY', 'Market value of a position', FALSE, 100),
('ISSUER.CREDIT_RATING', 'Issuer Credit Rating', 'STRING', 'Credit rating of the parent issuer', FALSE, 100),
('CASH_FLOWS', 'Cash Flows', 'JSON', 'Bond cash flow schedule', FALSE, 100),
('YIELD_CURVE', 'Yield Curve', 'JSON', 'Yield curve used for duration', FALSE, 100),
('COST_BASIS', 'Cost Basis', 'CURRENCY', 'Position cost basis', FALSE, 100),
('QUANTITY', 'Quantity', 'NUMBER', 'Position quantity', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;

-- Simple calculation: Current Yield = Annual Interest / Current Price * 100
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('CURRENT_YIELD', 'Current Yield (%)', 'PERCENTAGE', 'Calculated yield based on current price',
 TRUE, 'SIMPLE',
 'SELECT (annual_interest / NULLIF(current_price, 0) * 100) FROM attributes WHERE attribute_code IN (''ANNUAL_INTEREST'', ''CURRENT_PRICE'')',
 '["ANNUAL_INTEREST", "CURRENT_PRICE"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;

-- Aggregate: Total AUM = Sum of all position market values in fund
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('TOTAL_AUM', 'Total AUM', 'CURRENCY', 'Sum of all position market values',
 TRUE, 'AGGREGATE',
 'SELECT COALESCE(SUM(pm.market_value), 0) FROM position_master pm WHERE pm.fund_id = $1',
 '["POSITION.MARKET_VALUE"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;

-- Lookup: Get issuer credit rating from parent issuer entity
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('ISSUER_RATING', 'Issuer Credit Rating', 'STRING', 'Credit rating from parent issuer',
 TRUE, 'LOOKUP',
 'SELECT golden_value FROM golden_master.entity_attribute_values WHERE entity_id = (SELECT parent_entity_id FROM entity_relationships WHERE child_entity_id = $1 AND relationship_code = ''SECURITY_ISSUER'') AND attribute_code = ''CREDIT_RATING''',
 '["ISSUER.CREDIT_RATING"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;

-- Custom: Duration calculation with complex formula
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('EFFECTIVE_DURATION', 'Effective Duration', 'NUMBER', 'Bond duration calculated from yield curve',
 TRUE, 'CUSTOM',
 'SELECT calculate_duration(cash_flows, yield_curve) FROM bond_attributes WHERE security_id = $1',
 '["CASH_FLOWS", "YIELD_CURVE"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;

-- Simple: Unrealized P&L = (Current Price - Cost Basis) * Quantity
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('UNREALIZED_PNL', 'Unrealized P&L', 'CURRENCY', 'Unrealized profit or loss',
 TRUE, 'SIMPLE',
 'SELECT (current_price - cost_basis) * quantity FROM position_attributes WHERE position_id = $1',
 '["CURRENT_PRICE", "COST_BASIS", "QUANTITY"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;

-- ============================================================
-- 9. View for derived attribute dependency graph
-- ============================================================

CREATE OR REPLACE VIEW metadata_register.derived_attribute_dependencies AS
SELECT 
    ar.attribute_code,
    ar.attribute_name,
    ar.data_type,
    ar.derivation_type,
    ar.derivation_formula,
    ar.formula_language,
    ar.derivation_dependencies,
    jsonb_array_length(COALESCE(ar.derivation_dependencies, '[]'::jsonb)) AS dependency_count,
    ar.is_derived,
    ar.description,
    (
        SELECT COUNT(*)
        FROM metadata_register.template_attribute_assignments taa
        WHERE taa.attribute_id = ar.id
    ) AS template_usage_count
FROM metadata_register.attribute_register ar
WHERE ar.is_derived = TRUE;

COMMENT ON VIEW metadata_register.derived_attribute_dependencies IS 
'View showing all derived attributes with their dependency information and usage statistics.';

-- ============================================================
-- 10. Grant permissions
-- ============================================================

GRANT SELECT ON metadata_register.derived_attribute_dependencies TO authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.evaluate_derived_attribute TO authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.evaluate_derived_attributes_batch TO authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.validate_derivation_dependencies TO authenticated;
