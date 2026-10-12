-- Migration: Create public view for source_registry
-- Description: Creates a view in public schema to allow PostgREST access to entity_instances.source_registry

CREATE OR REPLACE VIEW public.source_registry AS
SELECT 
    id,
    source_code,
    source_name,
    source_type,
    vendor_name,
    feed_format,
    feed_frequency,
    precedence_rank,
    is_active,
    is_protected,
    metadata,
    created_at,
    updated_at
FROM entity_instances.source_registry;

COMMENT ON VIEW public.source_registry IS 'Public view of source registry for PostgREST access';