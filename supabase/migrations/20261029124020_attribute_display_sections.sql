-- Section order and cell size for entity attribute display.
-- Attributes render on a 4-column grid. Each attribute defaults to 1x1
-- and can span up to 4 columns and 3 rows.

ALTER TABLE metadata_register.attribute_register
  ADD COLUMN IF NOT EXISTS display_span_columns SMALLINT NOT NULL DEFAULT 1
    CHECK (display_span_columns BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS display_span_rows SMALLINT NOT NULL DEFAULT 1
    CHECK (display_span_rows BETWEEN 1 AND 3);

COMMENT ON COLUMN metadata_register.attribute_register.display_span_columns IS
  'Width of this attribute on the 4-column entity display. 1 is the default cell.';
COMMENT ON COLUMN metadata_register.attribute_register.display_span_rows IS
  'Height of this attribute on the entity display, in row tracks. 1 is the default.';

CREATE TABLE IF NOT EXISTS metadata_register.attribute_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
  section_name VARCHAR(100) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  client_id UUID REFERENCES tenancy.clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata_register.attribute_sections IS
  'Named display sections for one entity type, in the order they appear on the attribute page.';
COMMENT ON COLUMN metadata_register.attribute_sections.display_order IS
  'Section sequence within the entity type. Lower numbers appear first.';

CREATE UNIQUE INDEX IF NOT EXISTS attribute_sections_domain_name_uidx
  ON metadata_register.attribute_sections (domain_code, lower(section_name));
CREATE INDEX IF NOT EXISTS attribute_sections_domain_order_idx
  ON metadata_register.attribute_sections (domain_code, display_order);

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT grouped.domain_code,
       grouped.section_name,
       (row_number() OVER (
         PARTITION BY grouped.domain_code
         ORDER BY grouped.min_group, grouped.section_name
       ) - 1) * 10,
       dt.client_id
FROM (
  SELECT domain_code,
         COALESCE(NULLIF(btrim(display_section), ''), 'General') AS section_name,
         MIN(COALESCE(display_group, 0)) AS min_group
  FROM metadata_register.attribute_register
  WHERE domain_code IS NOT NULL
  GROUP BY domain_code, COALESCE(NULLIF(btrim(display_section), ''), 'General')
) grouped
JOIN metadata_register.domain_types dt ON dt.domain_code = grouped.domain_code
WHERE NOT EXISTS (
  SELECT 1
  FROM metadata_register.attribute_sections existing
  WHERE existing.domain_code = grouped.domain_code
    AND lower(existing.section_name) = lower(grouped.section_name)
);

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT dt.domain_code, 'General', 0, dt.client_id
FROM metadata_register.domain_types dt
WHERE NOT EXISTS (
  SELECT 1
  FROM metadata_register.attribute_sections existing
  WHERE existing.domain_code = dt.domain_code
    AND lower(existing.section_name) = 'general'
);

ALTER TABLE metadata_register.attribute_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attribute_sections_select_scoped ON metadata_register.attribute_sections;
DROP POLICY IF EXISTS attribute_sections_insert_scoped ON metadata_register.attribute_sections;
DROP POLICY IF EXISTS attribute_sections_update_scoped ON metadata_register.attribute_sections;
DROP POLICY IF EXISTS attribute_sections_delete_scoped ON metadata_register.attribute_sections;
CREATE POLICY attribute_sections_select_scoped ON metadata_register.attribute_sections
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY attribute_sections_insert_scoped ON metadata_register.attribute_sections
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_sections_update_scoped ON metadata_register.attribute_sections
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_sections_delete_scoped ON metadata_register.attribute_sections
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

CREATE OR REPLACE VIEW public.attribute_sections
WITH (security_invoker = true) AS
SELECT id, domain_code, section_name, display_order, client_id, created_at, updated_at
FROM metadata_register.attribute_sections;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribute_sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.attribute_sections TO authenticated;

CREATE OR REPLACE VIEW public.attribute_register AS
SELECT
  id, attribute_code, attribute_name, data_type, description, unit_of_measure,
  validation_regex, is_required, is_multi_valued, reference_domain_code,
  default_precedence_rank, metadata, created_at, updated_at, is_derived,
  display_format, list_values, validation_rules, default_value, display_section,
  display_group, is_editable, is_visible, derivation_formula, derivation_dependencies,
  derivation_type, formula_language, aggregation_type, weight_attribute_code,
  numeric_precision, domain_code, reference_list_code, is_time_varying, time_dimension,
  client_id, reporting_grain, period_alignment, period_rollup,
  display_span_columns, display_span_rows
FROM metadata_register.attribute_register;

ALTER VIEW public.attribute_register SET (security_invoker = on);

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
          'display_span_columns', display_span_columns,
          'display_span_rows', display_span_rows,
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

NOTIFY pgrst, 'reload schema';
