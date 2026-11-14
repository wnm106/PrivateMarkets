-- Every catalog attribute belongs to one entity type. These five were inserted
-- before domain scoping, so a blank domain made them appear on every entity.
-- Give each one the entity its description and rules already use, unless that
-- entity already has an attribute with the same name. A same-name row is removed
-- only when nothing still points at it.

DO $$
DECLARE
  blocked text;
  remaining text;
BEGIN
  CREATE TEMP TABLE unscoped_attribute_homes (
    attribute_code text PRIMARY KEY,
    domain_code text NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO unscoped_attribute_homes (attribute_code, domain_code) VALUES
    ('ANNUAL_INTEREST', 'SECURITY'),
    ('CASH_FLOWS', 'SECURITY'),
    ('YIELD_CURVE', 'SECURITY'),
    ('COST_BASIS', 'POSITION'),
    ('QUANTITY', 'POSITION');

  -- Values stored on a different entity type belong to the old shared catalog.
  DELETE FROM golden_master.entity_attribute_values AS value_row
  USING metadata_register.attribute_register AS attribute_row,
        unscoped_attribute_homes AS home,
        entity_instances.master_entities AS entity_row
  WHERE value_row.attribute_id = attribute_row.id
    AND attribute_row.attribute_code = home.attribute_code
    AND entity_row.id = value_row.entity_id
    AND entity_row.domain_code IS DISTINCT FROM home.domain_code;

  UPDATE metadata_register.attribute_register AS attribute_row
  SET domain_code = home.domain_code,
      updated_at = NOW()
  FROM unscoped_attribute_homes AS home
  WHERE attribute_row.attribute_code = home.attribute_code
    AND attribute_row.domain_code IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM metadata_register.attribute_register AS existing
      WHERE existing.domain_code = home.domain_code
        AND existing.id <> attribute_row.id
        AND lower(btrim(existing.attribute_name)) = lower(btrim(attribute_row.attribute_name))
    );

  SELECT string_agg(attribute_row.attribute_code, ', ' ORDER BY attribute_row.attribute_code)
  INTO blocked
  FROM metadata_register.attribute_register AS attribute_row
  JOIN unscoped_attribute_homes AS home ON home.attribute_code = attribute_row.attribute_code
  WHERE attribute_row.domain_code IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM golden_master.entity_attribute_values AS value_row
        WHERE value_row.attribute_id = attribute_row.id
      )
      OR EXISTS (
        SELECT 1 FROM data_quality.dq_rules AS rule_row
        WHERE rule_row.attribute_id = attribute_row.id
      )
      OR EXISTS (
        SELECT 1 FROM metadata_register.calc_definitions AS calc_row
        WHERE calc_row.attribute_id = attribute_row.id
      )
      OR EXISTS (
        SELECT 1 FROM metadata_register.template_attribute_assignments AS assignment_row
        WHERE assignment_row.attribute_id = attribute_row.id
      )
      OR EXISTS (
        SELECT 1 FROM metadata_register.attribute_aliases AS alias_row
        WHERE alias_row.attribute_id = attribute_row.id
      )
      OR EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs AS input_row
        WHERE input_row.attribute_code = attribute_row.attribute_code
      )
      OR EXISTS (
        SELECT 1 FROM entity_instances.source_attribute_values AS source_row
        WHERE source_row.attribute_id = attribute_row.id
      )
    );

  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot remove unscoped attributes that already exist on their entity and still have data: %',
      blocked;
  END IF;

  DELETE FROM metadata_register.attribute_register AS attribute_row
  USING unscoped_attribute_homes AS home
  WHERE attribute_row.attribute_code = home.attribute_code
    AND attribute_row.domain_code IS NULL
    AND EXISTS (
      SELECT 1
      FROM metadata_register.attribute_register AS existing
      WHERE existing.domain_code = home.domain_code
        AND existing.id <> attribute_row.id
        AND lower(btrim(existing.attribute_name)) = lower(btrim(attribute_row.attribute_name))
    );

  SELECT string_agg(attribute_code, ', ' ORDER BY attribute_code)
  INTO remaining
  FROM metadata_register.attribute_register
  WHERE domain_code IS NULL;

  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'Attributes still have no entity: %', remaining;
  END IF;
END $$;

COMMENT ON COLUMN metadata_register.attribute_register.domain_code IS
  'Entity type that owns this attribute.';

CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code character varying DEFAULT NULL::character varying)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'metadata_register', 'pg_temp'
AS $function$
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
          'display_span_columns', display_span_columns,
          'display_span_rows', display_span_rows,
          'is_editable', is_editable,
          'is_visible', is_visible,
          'aggregation_type', COALESCE(aggregation_type, 'NONE'),
          'weight_attribute_code', weight_attribute_code,
          'numeric_precision', numeric_precision
        ) AS attr_obj
        FROM metadata_register.attribute_register
        WHERE (p_domain_code IS NULL OR domain_code = p_domain_code)
        ORDER BY attribute_code
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_result;
  RETURN v_result;
END;
$function$;
