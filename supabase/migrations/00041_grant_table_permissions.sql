-- Migration: Grant Table Permissions
-- Description: Grants SELECT, INSERT, UPDATE, DELETE permissions to authenticated role for entity tables

-- Grant permissions on entity_instances schema tables (only tables that exist)
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.master_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.source_attribute_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.feed_lineage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.source_registry TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.intersection_instances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.intersection_members TO authenticated;

-- Grant permissions on golden_master schema tables
GRANT SELECT, INSERT, UPDATE, DELETE ON golden_master.entity_attribute_values TO authenticated;

-- Grant permissions on position_master schema tables
GRANT SELECT, INSERT, UPDATE, DELETE ON position_master.dimensional_intersections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_master.position_metrics TO authenticated;

-- Grant permissions on data_quality schema tables
GRANT SELECT, INSERT, UPDATE, DELETE ON data_quality.dq_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_quality.dq_exceptions TO authenticated;

-- Grant permissions on metadata_register schema tables
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.domain_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.attribute_register TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.domain_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.template_attribute_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.reference_lists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.reference_list_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.relationship_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.intersection_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.intersection_type_members TO authenticated;

-- Grant permissions on read_projections schema views that this migration can see.
-- Some projection names are created by later migrations, so skip any that are absent.
DO $$
DECLARE
  view_name text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'entity_master',
    'entity_attribute_values',
    'entity_relationships',
    'intersection_master',
    'intersection_members'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'read_projections' AND c.relname = view_name
    ) THEN
      EXECUTE format('GRANT SELECT ON read_projections.%I TO authenticated', view_name);
    END IF;
  END LOOP;
END $$;

-- Grant permissions on read_projections schema views
GRANT SELECT ON ALL TABLES IN SCHEMA read_projections TO authenticated;

-- Grant usage on schemas
GRANT USAGE ON SCHEMA entity_instances TO authenticated;
GRANT USAGE ON SCHEMA golden_master TO authenticated;
GRANT USAGE ON SCHEMA position_master TO authenticated;
GRANT USAGE ON SCHEMA data_quality TO authenticated;
GRANT USAGE ON SCHEMA metadata_register TO authenticated;
GRANT USAGE ON SCHEMA read_projections TO authenticated;


