-- Migration 00033: Create public views for intersection tables
-- Description: PostgREST doesn't support schema.table notation in .from(),
--              so we create views in public schema that wrap the schema-qualified tables

-- View for intersection_types
CREATE OR REPLACE VIEW public.intersection_types AS
SELECT * FROM metadata_register.intersection_types;

-- View for intersection_type_members
CREATE OR REPLACE VIEW public.intersection_type_members AS
SELECT * FROM metadata_register.intersection_type_members;

-- View for intersection_instances
CREATE OR REPLACE VIEW public.intersection_instances AS
SELECT * FROM entity_instances.intersection_instances;

-- View for intersection_members
CREATE OR REPLACE VIEW public.intersection_members AS
SELECT * FROM entity_instances.intersection_members;

-- View for intersection_attribute_values
CREATE OR REPLACE VIEW public.intersection_attribute_values AS
SELECT * FROM golden_master.intersection_attribute_values;

-- View for intersection_master (already in read_projections, but create alias in public)
CREATE OR REPLACE VIEW public.intersection_master AS
SELECT * FROM read_projections.intersection_master;

-- Grant permissions
GRANT SELECT ON public.intersection_types TO authenticated, anon;
GRANT SELECT ON public.intersection_type_members TO authenticated, anon;
GRANT SELECT ON public.intersection_instances TO authenticated, anon;
GRANT SELECT ON public.intersection_members TO authenticated, anon;
GRANT SELECT ON public.intersection_attribute_values TO authenticated, anon;
GRANT SELECT ON public.intersection_master TO authenticated, anon;

-- Grant insert/update/delete permissions for authenticated users
GRANT INSERT, UPDATE, DELETE ON public.intersection_types TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.intersection_type_members TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.intersection_instances TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.intersection_members TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.intersection_attribute_values TO authenticated;
