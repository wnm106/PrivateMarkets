-- Migration: Fix public schema views for GraphQL API access
-- Description: The GraphQL API queries views without schema prefixes, but the
-- actual views exist in read_projections and other schemas. This migration
-- creates/fixes views in the public schema and ensures proper permissions.

-- ============================================================
-- 1. Create/fix entity_master view in public schema
-- ============================================================
CREATE OR REPLACE VIEW public.entity_master AS
SELECT * FROM read_projections.entity_master;

GRANT SELECT ON public.entity_master TO authenticated;
ALTER VIEW public.entity_master SET (security_invoker = on);

COMMENT ON VIEW public.entity_master IS 'Public schema view of entity_master for GraphQL API access. RLS applies via security_invoker.';

-- ============================================================
-- 2. Fix intersection_master view in public schema
-- ============================================================
CREATE OR REPLACE VIEW public.intersection_master AS
SELECT * FROM read_projections.intersection_master;

GRANT SELECT ON public.intersection_master TO authenticated;
ALTER VIEW public.intersection_master SET (security_invoker = on);

COMMENT ON VIEW public.intersection_master IS 'Public schema view of intersection_master for GraphQL API access. RLS applies via security_invoker.';

-- ============================================================
-- 3. Ensure all underlying table permissions are granted
-- ============================================================
-- entity_instances schema
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.master_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.source_attribute_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.intersection_instances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.intersection_members TO authenticated;
GRANT USAGE ON SCHEMA entity_instances TO authenticated;

-- golden_master schema
GRANT SELECT, INSERT, UPDATE, DELETE ON golden_master.entity_attribute_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON golden_master.intersection_attribute_values TO authenticated;
GRANT USAGE ON SCHEMA golden_master TO authenticated;

-- metadata_register schema
GRANT SELECT ON metadata_register.domain_types TO authenticated;
GRANT SELECT ON metadata_register.attribute_register TO authenticated;
GRANT SELECT ON metadata_register.domain_templates TO authenticated;
GRANT SELECT ON metadata_register.intersection_types TO authenticated;
GRANT SELECT ON metadata_register.intersection_type_members TO authenticated;
GRANT SELECT ON metadata_register.relationship_types TO authenticated;
GRANT USAGE ON SCHEMA metadata_register TO authenticated;

-- entity_instances.source_registry (separate from other entity_instances grants above)
GRANT SELECT ON entity_instances.source_registry TO authenticated;

-- read_projections schema
GRANT SELECT ON read_projections.entity_master TO authenticated;
GRANT SELECT ON read_projections.intersection_master TO authenticated;
GRANT USAGE ON SCHEMA read_projections TO authenticated;

-- position_master schema
GRANT SELECT ON position_master.dimensional_intersections TO authenticated;
GRANT SELECT ON position_master.position_metrics TO authenticated;
GRANT USAGE ON SCHEMA position_master TO authenticated;
