-- Display layouts were never adopted: no layouts, bindings, or template
-- defaults were ever stored. Remove the tables and the template column that
-- pointed at them.
--
-- Kept from 20261013154414_display_layouts.sql because other features use
-- them: attribute_register.reporting_grain / period_alignment / period_rollup,
-- entity_attribute_values.period_grain / statement_basis, and
-- domain_templates.scope / owner_entity_id / based_on_template_id.

DROP VIEW IF EXISTS public.entity_template_bindings;
DROP VIEW IF EXISTS public.display_layouts;

-- A view cannot lose a column through CREATE OR REPLACE, so rebuild it.
DROP VIEW IF EXISTS public.domain_templates;

ALTER TABLE metadata_register.domain_templates
  DROP COLUMN IF EXISTS default_layout_id;

CREATE VIEW public.domain_templates
WITH (security_invoker = on) AS
SELECT
  id, template_code, domain_code, template_name, description, is_active,
  precedence_rules, metadata, created_at, updated_at, applicability_rules, client_id,
  scope, owner_entity_id, based_on_template_id
FROM metadata_register.domain_templates;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.domain_templates TO authenticated;
GRANT ALL ON public.domain_templates TO service_role;

DROP TABLE IF EXISTS metadata_register.entity_template_bindings;
DROP TABLE IF EXISTS metadata_register.display_layouts;

NOTIFY pgrst, 'reload schema';
