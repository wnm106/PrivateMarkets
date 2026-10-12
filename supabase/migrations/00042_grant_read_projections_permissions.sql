-- Migration: Grant Read Projections Permissions
-- Description: Grants SELECT permissions on read_projections schema views to authenticated role

-- Grant SELECT on all views in read_projections schema
GRANT SELECT ON ALL TABLES IN SCHEMA read_projections TO authenticated;

-- Ensure schema usage is granted
GRANT USAGE ON SCHEMA read_projections TO authenticated;

-- Grant SELECT on entity_relationships (needed by entity_master view)
GRANT SELECT ON entity_instances.entity_relationships TO authenticated;
