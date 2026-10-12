-- Migration: Grant Entity Relationships Permissions
-- Description: Grants SELECT permission on entity_relationships table (needed by entity_master view)

GRANT SELECT ON entity_instances.entity_relationships TO authenticated;
