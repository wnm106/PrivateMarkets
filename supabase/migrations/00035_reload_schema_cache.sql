-- Migration 00035: Reload PostgREST Schema Cache & Add Update Function
-- Description: Forces PostgREST to reload its schema cache so it recognizes
--              the new aggregation_type, weight_attribute_code, and numeric_precision
--              columns added to the attribute_register view in migration 00016.
--              Also adds RPC functions to handle attributes with these fields.

-- Notify PostgREST to reload its schema cache
NOTIFY pgrst, 'reload schema';

-- Create an RPC function to update attribute aggregation fields
-- This bypasses the PostgREST schema cache issue
CREATE OR REPLACE FUNCTION public.update_attribute_aggregation(
    p_attribute_id UUID,
    p_aggregation_type VARCHAR(20),
    p_weight_attribute_code VARCHAR(100),
    p_numeric_precision INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    UPDATE metadata_register.attribute_register
    SET 
        aggregation_type = p_aggregation_type,
        weight_attribute_code = p_weight_attribute_code,
        numeric_precision = p_numeric_precision,
        updated_at = NOW()
    WHERE id = p_attribute_id;
    
    SELECT jsonb_build_object(
        'id', id,
        'attribute_code', attribute_code,
        'aggregation_type', aggregation_type,
        'weight_attribute_code', weight_attribute_code,
        'numeric_precision', numeric_precision
    )
    INTO v_result
    FROM metadata_register.attribute_register
    WHERE id = p_attribute_id;
    
    RETURN v_result;
END;
$$;

-- Create an RPC function to get all attributes with aggregation fields
-- This bypasses the PostgREST schema cache issue for reads
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
             WHERE (p_domain_code IS NULL OR reference_domain_code = p_domain_code)
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
