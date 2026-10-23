-- Calculated attributes such as MARKET_VALUE are still entity attributes.
-- The catalog was dropping every is_derived row, so they never appeared
-- on the entity page even when a value was stored and the attribute was visible.

CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code character varying DEFAULT NULL::character varying)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(
    (
      SELECT jsonb_agg(attr_obj)
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
          'reference_list_code', reference_list_code,
          'domain_code', domain_code,
          'client_id', client_id,
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
        ORDER BY attribute_code
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_result;
  RETURN v_result;
END;
$$;
