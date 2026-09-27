-- Migration: Attribute Display Metadata
-- Description: Add display formatting, list values, and validation rules to attributes

-- Add display and validation columns to attribute_register
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS display_format VARCHAR(100);
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS list_values JSONB DEFAULT '[]';
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS validation_rules JSONB DEFAULT '{}';
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS default_value TEXT;
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS display_section VARCHAR(100) DEFAULT 'General';
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS display_group INTEGER DEFAULT 0;
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS is_editable BOOLEAN DEFAULT TRUE;
ALTER TABLE metadata_register.attribute_register ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT TRUE;

-- Update the public view to include new columns
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
    metadata,
    created_at,
    updated_at
FROM metadata_register.attribute_register;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_attribute_register_section ON metadata_register.attribute_register(display_section);
CREATE INDEX IF NOT EXISTS idx_attribute_register_visible ON metadata_register.attribute_register(is_visible);
CREATE INDEX IF NOT EXISTS idx_attribute_register_editable ON metadata_register.attribute_register(is_editable);

COMMENT ON COLUMN metadata_register.attribute_register.display_format IS 'Display format pattern (e.g., date format, number format, currency format)';
COMMENT ON COLUMN metadata_register.attribute_register.list_values IS 'JSON array of allowed values for enum/list attributes';
COMMENT ON COLUMN metadata_register.attribute_register.validation_rules IS 'JSON object with validation rules (min, max, pattern, etc.)';
COMMENT ON COLUMN metadata_register.attribute_register.default_value IS 'Default value for new entities';
COMMENT ON COLUMN metadata_register.attribute_register.display_section IS 'UI section grouping (e.g., General, Financial, Identifiers)';
COMMENT ON COLUMN metadata_register.attribute_register.display_group IS 'Sort order within section';
COMMENT ON COLUMN metadata_register.attribute_register.is_editable IS 'Whether this attribute can be edited in UI';
COMMENT ON COLUMN metadata_register.attribute_register.is_visible IS 'Whether this attribute is visible in UI';
