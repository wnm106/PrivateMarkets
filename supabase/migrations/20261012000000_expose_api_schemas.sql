-- Expose custom schemas to the Data API.
-- The GraphQL and MCP clients query relation names in the public schema.
-- Tables live in domain schemas, so publish security-invoker views in public
-- and grant the API roles access to the underlying schemas.

DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY[
    'metadata_register',
    'entity_instances',
    'golden_master',
    'position_master',
    'data_quality',
    'read_projections'
  ]
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role', schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO anon, authenticated, service_role', schema_name);
    EXECUTE format('GRANT ALL ON ALL ROUTINES IN SCHEMA %I TO anon, authenticated, service_role', schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO anon, authenticated, service_role', schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON TABLES TO anon, authenticated, service_role', schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON ROUTINES TO anon, authenticated, service_role', schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON SEQUENCES TO anon, authenticated, service_role', schema_name);
  END LOOP;
END $$;

-- Public projections. Skip relations that already exist in public
-- (attribute_register is maintained by earlier migrations).
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('metadata_register', 'domain_templates'),
      ('metadata_register', 'domain_types'),
      ('metadata_register', 'entity_identifier_definitions'),
      ('metadata_register', 'intersection_type_members'),
      ('metadata_register', 'intersection_types'),
      ('metadata_register', 'reference_list_values'),
      ('metadata_register', 'reference_lists'),
      ('metadata_register', 'relationship_types'),
      ('metadata_register', 'template_attribute_assignments'),
      ('metadata_register', 'derived_attribute_dependencies'),
      ('entity_instances', 'data_connections'),
      ('entity_instances', 'data_loaders'),
      ('entity_instances', 'entity_relationships'),
      ('entity_instances', 'feed_lineage'),
      ('entity_instances', 'import_executions'),
      ('entity_instances', 'import_maps'),
      ('entity_instances', 'intersection_instances'),
      ('entity_instances', 'intersection_members'),
      ('entity_instances', 'master_entities'),
      ('entity_instances', 'source_attribute_values'),
      ('entity_instances', 'source_registry'),
      ('golden_master', 'current_golden_records'),
      ('golden_master', 'entity_attribute_values'),
      ('golden_master', 'intersection_attribute_values'),
      ('position_master', 'dimensional_intersections'),
      ('position_master', 'position_metrics'),
      ('data_quality', 'dq_exceptions'),
      ('data_quality', 'dq_rules'),
      ('read_projections', 'deal_master'),
      ('read_projections', 'entity_master'),
      ('read_projections', 'fund_master'),
      ('read_projections', 'intersection_master'),
      ('read_projections', 'issuer_master'),
      ('read_projections', 'position_master'),
      ('read_projections', 'security_master')
    ) AS t(schema_name, relation_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = spec.relation_name
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT * FROM %I.%I',
      spec.relation_name, spec.schema_name, spec.relation_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated, service_role',
      spec.relation_name
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
