-- Display layouts place template attributes in custom HTML, including a
-- time-series view shaped to month-end, quarter-end, or year-end.
-- An entity template binding lets a parent, such as an issuer, choose the
-- layout used for itself or for a child relationship such as financials.

ALTER TABLE metadata_register.attribute_register
  ADD COLUMN IF NOT EXISTS reporting_grain VARCHAR(20)
    CHECK (reporting_grain IS NULL OR reporting_grain IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'IRREGULAR')),
  ADD COLUMN IF NOT EXISTS period_alignment VARCHAR(20) NOT NULL DEFAULT 'PERIOD_END'
    CHECK (period_alignment IN ('PERIOD_END', 'PERIOD_START')),
  ADD COLUMN IF NOT EXISTS period_rollup VARCHAR(20) NOT NULL DEFAULT 'NONE'
    CHECK (period_rollup IN ('NONE', 'PERIOD_END', 'SUM', 'AVG', 'MIN', 'MAX'));

COMMENT ON COLUMN metadata_register.attribute_register.reporting_grain IS
  'Grain at which this attribute is reported, such as quarter-end. NULL follows the layout view.';
COMMENT ON COLUMN metadata_register.attribute_register.period_alignment IS
  'PERIOD_END means the observation date is the close of the period.';
COMMENT ON COLUMN metadata_register.attribute_register.period_rollup IS
  'How finer observations fill a coarser period. PERIOD_END keeps the closing balance. SUM adds flows. Distinct from aggregation_type, which rolls entities together.';

ALTER TABLE golden_master.entity_attribute_values
  ADD COLUMN IF NOT EXISTS period_grain VARCHAR(20)
    CHECK (period_grain IS NULL OR period_grain IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS statement_basis VARCHAR(50);

COMMENT ON COLUMN golden_master.entity_attribute_values.period_grain IS
  'Reporting grain of this observation. Quarter-end and fiscal-year-end can share a date, so the date alone is not the key.';
COMMENT ON COLUMN golden_master.entity_attribute_values.statement_basis IS
  'Qualifier such as ACTUAL, AUDIT, MANAGEMENT, or BUDGET. NULL is treated as ACTUAL.';

CREATE INDEX IF NOT EXISTS idx_eav_period_basis
  ON golden_master.entity_attribute_values(entity_id, attribute_id, period_grain, statement_basis);

ALTER TABLE metadata_register.domain_templates
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'DOMAIN'
    CHECK (scope IN ('DOMAIN', 'ENTITY')),
  ADD COLUMN IF NOT EXISTS owner_entity_id UUID REFERENCES entity_instances.master_entities(id),
  ADD COLUMN IF NOT EXISTS based_on_template_id UUID REFERENCES metadata_register.domain_templates(id);

COMMENT ON COLUMN metadata_register.domain_templates.scope IS
  'DOMAIN templates apply to every entity of the domain. ENTITY templates are a fork owned by one entity.';
COMMENT ON COLUMN metadata_register.domain_templates.owner_entity_id IS
  'Set when scope is ENTITY. The issuer that owns a company-specific financial template.';
COMMENT ON COLUMN metadata_register.domain_templates.based_on_template_id IS
  'Template this entity-scoped fork was copied from.';

CREATE TABLE IF NOT EXISTS metadata_register.display_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_code VARCHAR(100) UNIQUE NOT NULL,
  layout_name VARCHAR(200) NOT NULL,
  description TEXT,
  domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
  owner_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
  relationship_code VARCHAR(100),
  scope VARCHAR(20) NOT NULL DEFAULT 'DOMAIN' CHECK (scope IN ('DOMAIN', 'ENTITY')),
  owner_entity_id UUID REFERENCES entity_instances.master_entities(id),
  html_template TEXT NOT NULL DEFAULT '',
  time_mode VARCHAR(20) NOT NULL DEFAULT 'POINT' CHECK (time_mode IN ('POINT', 'SERIES')),
  series_axis VARCHAR(30) NOT NULL DEFAULT 'VALID_TIME' CHECK (series_axis IN ('VALID_TIME', 'CHILD_ENTITIES')),
  default_view_grain VARCHAR(20) CHECK (default_view_grain IS NULL OR default_view_grain IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL')),
  allowed_view_grains TEXT[] NOT NULL DEFAULT '{}',
  series_window INTEGER NOT NULL DEFAULT 8 CHECK (series_window > 0 AND series_window <= 36),
  parameters JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  client_id UUID REFERENCES tenancy.clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata_register.display_layouts IS
  'HTML placement of attribute slots. SERIES mode repeats slots across fiscal period-end columns. Parameters declare the controls the HTML places.';

CREATE INDEX IF NOT EXISTS idx_display_layouts_domain ON metadata_register.display_layouts(domain_code);
CREATE INDEX IF NOT EXISTS idx_display_layouts_owner ON metadata_register.display_layouts(owner_entity_id);

ALTER TABLE metadata_register.domain_templates
  ADD COLUMN IF NOT EXISTS default_layout_id UUID REFERENCES metadata_register.display_layouts(id);

COMMENT ON COLUMN metadata_register.domain_templates.default_layout_id IS
  'Layout used when the entity has no display binding.';

CREATE TABLE IF NOT EXISTS metadata_register.entity_template_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
  relationship_code VARCHAR(100) NOT NULL DEFAULT '',
  data_template_id UUID REFERENCES metadata_register.domain_templates(id),
  layout_id UUID NOT NULL REFERENCES metadata_register.display_layouts(id),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE NOT NULL DEFAULT '9999-12-31',
  client_id UUID REFERENCES tenancy.clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_entity_id, relationship_code, valid_from)
);

COMMENT ON TABLE metadata_register.entity_template_bindings IS
  'Selects a data template and display layout for an entity. A non-empty relationship_code applies the layout to children of that relationship, so an issuer can own the financial statement of its financial children.';

CREATE INDEX IF NOT EXISTS idx_template_bindings_owner
  ON metadata_register.entity_template_bindings(owner_entity_id, relationship_code);

ALTER TABLE metadata_register.display_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.entity_template_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS display_layouts_select_scoped ON metadata_register.display_layouts;
DROP POLICY IF EXISTS display_layouts_insert_scoped ON metadata_register.display_layouts;
DROP POLICY IF EXISTS display_layouts_update_scoped ON metadata_register.display_layouts;
DROP POLICY IF EXISTS display_layouts_delete_scoped ON metadata_register.display_layouts;
CREATE POLICY display_layouts_select_scoped ON metadata_register.display_layouts
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY display_layouts_insert_scoped ON metadata_register.display_layouts
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY display_layouts_update_scoped ON metadata_register.display_layouts
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY display_layouts_delete_scoped ON metadata_register.display_layouts
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS entity_template_bindings_select_scoped ON metadata_register.entity_template_bindings;
DROP POLICY IF EXISTS entity_template_bindings_insert_scoped ON metadata_register.entity_template_bindings;
DROP POLICY IF EXISTS entity_template_bindings_update_scoped ON metadata_register.entity_template_bindings;
DROP POLICY IF EXISTS entity_template_bindings_delete_scoped ON metadata_register.entity_template_bindings;
CREATE POLICY entity_template_bindings_select_scoped ON metadata_register.entity_template_bindings
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY entity_template_bindings_insert_scoped ON metadata_register.entity_template_bindings
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY entity_template_bindings_update_scoped ON metadata_register.entity_template_bindings
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY entity_template_bindings_delete_scoped ON metadata_register.entity_template_bindings
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

CREATE OR REPLACE VIEW public.attribute_register AS
SELECT
  id, attribute_code, attribute_name, data_type, description, unit_of_measure,
  validation_regex, is_required, is_multi_valued, reference_domain_code,
  default_precedence_rank, metadata, created_at, updated_at, is_derived,
  display_format, list_values, validation_rules, default_value, display_section,
  display_group, is_editable, is_visible, derivation_formula, derivation_dependencies,
  derivation_type, formula_language, aggregation_type, weight_attribute_code,
  numeric_precision, domain_code, reference_list_code, is_time_varying, time_dimension,
  client_id, reporting_grain, period_alignment, period_rollup
FROM metadata_register.attribute_register;

CREATE OR REPLACE VIEW public.domain_templates AS
SELECT
  id, template_code, domain_code, template_name, description, is_active,
  precedence_rules, metadata, created_at, updated_at, applicability_rules, client_id,
  scope, owner_entity_id, based_on_template_id, default_layout_id
FROM metadata_register.domain_templates;

CREATE OR REPLACE VIEW public.entity_attribute_values AS
SELECT
  id, entity_id, attribute_id, source_id, source_value_id, golden_value,
  golden_value_jsonb, golden_value_numeric, golden_value_date, golden_value_timestamp,
  golden_value_boolean, valid_from, valid_to, system_from, system_to, precedence_rank,
  confidence_score, is_manual_override, override_reason, competing_values,
  resolution_rule_applied, metadata, created_at, created_by, updated_by,
  golden_source_id, resolution_version, resolved_at, period_grain, statement_basis
FROM golden_master.entity_attribute_values;

CREATE OR REPLACE VIEW public.display_layouts
WITH (security_invoker = true) AS
SELECT * FROM metadata_register.display_layouts;

CREATE OR REPLACE VIEW public.entity_template_bindings
WITH (security_invoker = true) AS
SELECT * FROM metadata_register.entity_template_bindings;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.display_layouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_template_bindings TO authenticated;

ALTER VIEW public.attribute_register SET (security_invoker = on);
ALTER VIEW public.domain_templates SET (security_invoker = on);
ALTER VIEW public.entity_attribute_values SET (security_invoker = on);

NOTIFY pgrst, 'reload schema';
