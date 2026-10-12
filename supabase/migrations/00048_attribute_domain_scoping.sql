-- Migration 00048: Add domain_code to attribute_register
-- Description: Adds a direct link between attributes and their owning domain.
--              This allows attributes to be scoped to entity types before being
--              assigned to templates.

-- Add domain_code column to attribute_register
ALTER TABLE metadata_register.attribute_register
ADD COLUMN IF NOT EXISTS domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code);

-- Create index for faster domain-based queries
CREATE INDEX IF NOT EXISTS idx_attribute_register_owning_domain 
ON metadata_register.attribute_register(domain_code);

-- Add comment
COMMENT ON COLUMN metadata_register.attribute_register.domain_code IS 'The domain (entity type) this attribute belongs to. NULL means global/shared attribute.';

-- Grant permissions on entity_identifier_definitions (was missing from migration 00047)
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.entity_identifier_definitions TO authenticated;

-- Update the get_attributes_with_aggregation RPC function to include domain_code
CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code VARCHAR DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(
        (SELECT jsonb_agg(attr_obj)
         FROM (
             SELECT jsonb_build_object(
                 'id', id,
                 'attribute_code', attribute_code,
                 'attribute_name', attribute_name,
                 'data_type', data_type,
                 'description', description,
                 'unit_of_measure', unit_of_measure,
                 'is_required', is_required,
                 'is_multi_valued', is_multi_valued,
                 'reference_domain_code', reference_domain_code,
                 'domain_code', domain_code,
                 'default_precedence_rank', default_precedence_rank,
                 'is_derived', is_derived,
                 'derivation_type', derivation_type,
                 'derivation_formula', derivation_formula,
                 'derivation_dependencies', derivation_dependencies,
                 'display_format', display_format,
                 'list_values', list_values,
                 'validation_rules', validation_rules,
                 'default_value', default_value,
                 'display_section', display_section,
                 'display_group', display_group,
                 'is_editable', is_editable,
                 'is_visible', is_visible,
                 'aggregation_type', COALESCE(aggregation_type, 'NONE'),
                 'weight_attribute_code', weight_attribute_code,
                 'numeric_precision', numeric_precision
             ) AS attr_obj
             FROM metadata_register.attribute_register
             WHERE (p_domain_code IS NULL OR domain_code = p_domain_code OR domain_code IS NULL)
               AND (is_derived = false OR is_derived IS NULL)
             ORDER BY attribute_code
         ) sub
        ),
        '[]'::jsonb
    )
    INTO v_result;
    
    RETURN v_result;
END;
$$;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';