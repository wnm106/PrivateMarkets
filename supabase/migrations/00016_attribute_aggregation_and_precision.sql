-- Migration: Attribute Aggregation Types & Numeric Precision
-- Description: Adds aggregation behavior (Min, Max, Sum, Average, Weighted Average)
--              to attributes, a weight column reference for weighted averages,
--              and a numeric precision indicator for display purposes.

-- ============================================================
-- 1. Add aggregation and precision columns to attribute_register
-- ============================================================

-- aggregation_type: How this attribute behaves when rows are aggregated
--   NONE           - No aggregation (default, single-row value used as-is)
--   MIN            - Minimum value across rows (works for NUMBER and STRING)
--   MAX            - Maximum value across rows (works for NUMBER and STRING)
--   SUM            - Sum of values (numeric types only)
--   AVG            - Simple average (numeric types only)
--   WEIGHTED_AVG   - Weighted average using another attribute as weight (numeric only)
ALTER TABLE metadata_register.attribute_register
    ADD COLUMN IF NOT EXISTS aggregation_type VARCHAR(20) DEFAULT 'NONE';

-- weight_attribute_code: For WEIGHTED_AVG, the attribute_code used as the weight
-- e.g. if aggregating "price" weighted by "quantity", weight_attribute_code = 'QUANTITY'
ALTER TABLE metadata_register.attribute_register
    ADD COLUMN IF NOT EXISTS weight_attribute_code VARCHAR(100);

-- numeric_precision: Number of decimal places to display for numeric values
-- NULL means use default display; 0 = integers, 2 = typical currency, 4 = rates, etc.
ALTER TABLE metadata_register.attribute_register
    ADD COLUMN IF NOT EXISTS numeric_precision INTEGER;

-- ============================================================
-- 2. Constraints
-- ============================================================

-- aggregation_type must be one of the supported values
ALTER TABLE metadata_register.attribute_register
    DROP CONSTRAINT IF EXISTS attribute_register_aggregation_type_check;

ALTER TABLE metadata_register.attribute_register
    ADD CONSTRAINT attribute_register_aggregation_type_check
    CHECK (aggregation_type IN ('NONE', 'MIN', 'MAX', 'SUM', 'AVG', 'WEIGHTED_AVG'));

-- numeric_precision must be non-negative if set
ALTER TABLE metadata_register.attribute_register
    DROP CONSTRAINT IF EXISTS attribute_register_numeric_precision_check;

ALTER TABLE metadata_register.attribute_register
    ADD CONSTRAINT attribute_register_numeric_precision_check
    CHECK (numeric_precision IS NULL OR numeric_precision >= 0);

-- weight_attribute_code must reference a valid attribute_code (self-referencing FK)
ALTER TABLE metadata_register.attribute_register
    DROP CONSTRAINT IF EXISTS attribute_register_weight_attribute_fk;

ALTER TABLE metadata_register.attribute_register
    ADD CONSTRAINT attribute_register_weight_attribute_fk
    FOREIGN KEY (weight_attribute_code) REFERENCES metadata_register.attribute_register(attribute_code);

-- ============================================================
-- 3. Validation trigger
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.validate_aggregation_settings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_weight_attr RECORD;
BEGIN
    IF NEW.aggregation_type IS NULL OR NEW.aggregation_type = 'NONE' THEN
        -- Clear weight if not using weighted average
        NEW.weight_attribute_code := NULL;
        RETURN NEW;
    END IF;

    -- WEIGHTED_AVG requires a weight attribute
    IF NEW.aggregation_type = 'WEIGHTED_AVG' THEN
        IF NEW.weight_attribute_code IS NULL THEN
            RAISE EXCEPTION 'weight_attribute_code is required when aggregation_type is WEIGHTED_AVG for attribute: %', NEW.attribute_code;
        END IF;

        -- Weight attribute must be numeric
        SELECT data_type INTO v_weight_attr
        FROM metadata_register.attribute_register
        WHERE attribute_code = NEW.weight_attribute_code;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'weight_attribute_code references non-existent attribute: %', NEW.weight_attribute_code;
        END IF;

        IF v_weight_attr.data_type NOT IN ('NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE') THEN
            RAISE EXCEPTION 'weight_attribute_code must reference a numeric attribute, got data_type: % for attribute: %', v_weight_attr.data_type, NEW.weight_attribute_code;
        END IF;

        -- The weighted attribute itself must be numeric
        IF NEW.data_type NOT IN ('NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE') THEN
            RAISE EXCEPTION 'WEIGHTED_AVG aggregation requires a numeric data_type, got: % for attribute: %', NEW.data_type, NEW.attribute_code;
        END IF;
    END IF;

    -- SUM and AVG require numeric data types
    IF NEW.aggregation_type IN ('SUM', 'AVG') THEN
        IF NEW.data_type NOT IN ('NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE') THEN
            RAISE EXCEPTION '% aggregation requires a numeric data_type, got: % for attribute: %', NEW.aggregation_type, NEW.data_type, NEW.attribute_code;
        END IF;
    END IF;

    -- MIN/MAX on STRING is allowed (lexicographic); on numeric types also fine
    -- No additional validation needed for MIN/MAX

    -- Clear weight_attribute_code if not WEIGHTED_AVG
    IF NEW.aggregation_type != 'WEIGHTED_AVG' THEN
        NEW.weight_attribute_code := NULL;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

COMMENT ON FUNCTION metadata_register.validate_aggregation_settings IS
'Validates aggregation settings: WEIGHTED_AVG requires numeric weight attribute, SUM/AVG require numeric data types.';

DROP TRIGGER IF EXISTS trg_validate_aggregation_settings ON metadata_register.attribute_register;
CREATE TRIGGER trg_validate_aggregation_settings
    BEFORE INSERT OR UPDATE ON metadata_register.attribute_register
    FOR EACH ROW
    EXECUTE FUNCTION metadata_register.validate_aggregation_settings();

-- ============================================================
-- 4. Update the public view to include new columns
-- ============================================================

DROP VIEW IF EXISTS public.attribute_register;
CREATE VIEW public.attribute_register AS
SELECT
    id,
    attribute_code,
    attribute_name,
    data_type,
    description,
    unit_of_measure,
    validation_regex,
    is_required,
    is_multi_valued,
    reference_domain_code,
    default_precedence_rank,
    is_derived,
    display_format,
    list_values,
    validation_rules,
    default_value,
    display_section,
    display_group,
    is_editable,
    is_visible,
    aggregation_type,
    weight_attribute_code,
    numeric_precision,
    metadata,
    created_at,
    updated_at
FROM metadata_register.attribute_register;

-- ============================================================
-- 5. Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_attribute_register_aggregation
    ON metadata_register.attribute_register(aggregation_type)
    WHERE aggregation_type IS NOT NULL AND aggregation_type != 'NONE';

CREATE INDEX IF NOT EXISTS idx_attribute_register_weight_attr
    ON metadata_register.attribute_register(weight_attribute_code)
    WHERE weight_attribute_code IS NOT NULL;

-- ============================================================
-- 6. Comments
-- ============================================================

COMMENT ON COLUMN metadata_register.attribute_register.aggregation_type IS
'How this attribute behaves in aggregated rows: NONE, MIN, MAX, SUM, AVG, or WEIGHTED_AVG. MIN/MAX work for both numeric and text; SUM/AVG/WEIGHTED_AVG are numeric only.';

COMMENT ON COLUMN metadata_register.attribute_register.weight_attribute_code IS
'For WEIGHTED_AVG aggregation, the attribute_code of the numeric weight column (e.g. QUANTITY for a weighted average price).';

COMMENT ON COLUMN metadata_register.attribute_register.numeric_precision IS
'Number of decimal places to display for numeric values. NULL = use default, 0 = integer display, 2 = typical currency, 4 = rates/percentages.';

-- ============================================================
-- 7. Seed: Set sensible defaults for some known attributes
-- ============================================================

-- Total AUM should SUM
UPDATE metadata_register.attribute_register
SET aggregation_type = 'SUM', numeric_precision = 2
WHERE attribute_code = 'TOTAL_AUM';

-- Current Yield should average
UPDATE metadata_register.attribute_register
SET aggregation_type = 'AVG', numeric_precision = 4
WHERE attribute_code = 'CURRENT_YIELD';

-- Credit rating: take the worst (MIN alphabetically if AAA < CCC, or MAX if reversed)
-- Using MAX as a reasonable default for text aggregation
UPDATE metadata_register.attribute_register
SET aggregation_type = 'MAX'
WHERE attribute_code = 'ISSUER_RATING';

-- Set precision for currency/percentage attributes
UPDATE metadata_register.attribute_register
SET numeric_precision = 2
WHERE data_type = 'CURRENCY' AND numeric_precision IS NULL;

UPDATE metadata_register.attribute_register
SET numeric_precision = 4
WHERE data_type = 'PERCENTAGE' AND numeric_precision IS NULL;
