-- How current relationship rows are actually stored, by parent and child type.
-- The chat agent uses this to choose lookup direction. Declared parent/child
-- on relationship_types can disagree with the rows (for example SECURITY_ISSUER).
-- SECURITY INVOKER so the caller's row access applies through the public views.

CREATE OR REPLACE FUNCTION public.relationship_link_counts()
RETURNS TABLE (
    relationship_code text,
    parent_domain_code text,
    child_domain_code text,
    link_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
SET statement_timeout = '30s'
AS $$
    SELECT r.relationship_code::text,
           p.domain_code::text,
           c.domain_code::text,
           count(*)::bigint
    FROM entity_relationships r
    JOIN master_entities p ON p.id = r.parent_entity_id
    JOIN master_entities c ON c.id = r.child_entity_id
    WHERE r.valid_from <= CURRENT_DATE
      AND r.valid_to >= CURRENT_DATE
      AND r.system_from <= now()
      AND r.system_to >= now()
    GROUP BY 1, 2, 3;
$$;

COMMENT ON FUNCTION public.relationship_link_counts() IS
    'Current link counts by relationship code and the parent and child entity types on the stored rows.';

GRANT EXECUTE ON FUNCTION public.relationship_link_counts() TO authenticated;

NOTIFY pgrst, 'reload schema';
