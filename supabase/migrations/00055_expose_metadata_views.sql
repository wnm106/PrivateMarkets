-- Migration 00055: Expose metadata_register tables via public views
-- Description: Creates views in the public schema to expose metadata_register
--              tables to PostgREST, which by default only exposes the public schema.

-- Drop existing views if they exist
DROP VIEW IF EXISTS public.reference_lists CASCADE;
DROP VIEW IF EXISTS public.reference_list_summary CASCADE;
DROP VIEW IF EXISTS public.reference_list_values CASCADE;
DROP VIEW IF EXISTS public.attribute_register CASCADE;
DROP VIEW IF EXISTS public.domain_types CASCADE;
DROP VIEW IF EXISTS public.domain_templates CASCADE;
DROP VIEW IF EXISTS public.template_attribute_assignments CASCADE;
DROP VIEW IF EXISTS public.source_registry CASCADE;
DROP VIEW IF EXISTS public.entity_identifier_definitions CASCADE;
DROP VIEW IF EXISTS public.intersection_types CASCADE;
DROP VIEW IF EXISTS public.intersection_type_members CASCADE;
DROP VIEW IF EXISTS public.relationship_types CASCADE;

-- Reference Lists
CREATE OR REPLACE VIEW public.reference_lists AS
SELECT * FROM metadata_register.reference_lists;

-- Reference List Summary (computed view)
CREATE OR REPLACE VIEW public.reference_list_summary AS
SELECT * FROM metadata_register.reference_list_summary;

-- Reference List Values
CREATE OR REPLACE VIEW public.reference_list_values AS
SELECT * FROM metadata_register.reference_list_values;

-- Attribute Register
CREATE OR REPLACE VIEW public.attribute_register AS
SELECT * FROM metadata_register.attribute_register;

-- Domain Types
CREATE OR REPLACE VIEW public.domain_types AS
SELECT * FROM metadata_register.domain_types;

-- Domain Templates
CREATE OR REPLACE VIEW public.domain_templates AS
SELECT * FROM metadata_register.domain_templates;

-- Template Attribute Assignments
CREATE OR REPLACE VIEW public.template_attribute_assignments AS
SELECT * FROM metadata_register.template_attribute_assignments;

-- Source Registry (commented out - table may not exist)
-- CREATE OR REPLACE VIEW public.source_registry AS
-- SELECT * FROM metadata_register.source_registry;

-- Entity Identifier Definitions
CREATE OR REPLACE VIEW public.entity_identifier_definitions AS
SELECT * FROM metadata_register.entity_identifier_definitions;

-- Intersection Types
CREATE OR REPLACE VIEW public.intersection_types AS
SELECT * FROM metadata_register.intersection_types;

-- Intersection Type Members
CREATE OR REPLACE VIEW public.intersection_type_members AS
SELECT * FROM metadata_register.intersection_type_members;

-- Relationship Types
CREATE OR REPLACE VIEW public.relationship_types AS
SELECT * FROM metadata_register.relationship_types;

-- Grant permissions
GRANT SELECT ON public.reference_lists TO anon, authenticated;
GRANT SELECT ON public.reference_list_summary TO anon, authenticated;
GRANT SELECT ON public.reference_list_values TO anon, authenticated;
GRANT SELECT ON public.attribute_register TO anon, authenticated;
GRANT SELECT ON public.domain_types TO anon, authenticated;
GRANT SELECT ON public.domain_templates TO anon, authenticated;
GRANT SELECT ON public.template_attribute_assignments TO anon, authenticated;
-- GRANT SELECT ON public.source_registry TO anon, authenticated;
GRANT SELECT ON public.entity_identifier_definitions TO anon, authenticated;
GRANT SELECT ON public.intersection_types TO anon, authenticated;
GRANT SELECT ON public.intersection_type_members TO anon, authenticated;
GRANT SELECT ON public.relationship_types TO anon, authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
