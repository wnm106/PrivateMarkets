-- Add time dimension support to attributes
ALTER TABLE metadata_register.attribute_register
ADD COLUMN IF NOT EXISTS is_time_varying BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS time_dimension TEXT DEFAULT 'NONE'
  CHECK (time_dimension IN ('NONE', 'VALID_TIME', 'TRANSACTION_TIME', 'BITEMPORAL'));

-- Add composite relationship support
ALTER TABLE metadata_register.relationship_types
ADD COLUMN IF NOT EXISTS cardinality TEXT DEFAULT 'ONE_TO_ONE'
  CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'COMPOSITE')),
ADD COLUMN IF NOT EXISTS composite_key TEXT[] DEFAULT '{}';

-- Recreate the public view so the new attribute columns are visible.
-- public.attribute_register is a view over the metadata table, so ALTER TABLE
-- on the unqualified name would target the view and fail.
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
    is_time_varying,
    time_dimension,
    metadata,
    created_at,
    updated_at
FROM metadata_register.attribute_register;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_attribute_time_dimension
  ON metadata_register.attribute_register(time_dimension)
  WHERE time_dimension != 'NONE';

CREATE INDEX IF NOT EXISTS idx_relationship_cardinality
  ON metadata_register.relationship_types(cardinality)
  WHERE cardinality != 'ONE_TO_ONE';
