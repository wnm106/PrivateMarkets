-- How many related records sit on each side of a stored link.
-- A list shows the other entity only when this side has one record.
-- Declared ONE_TO_ONE can still be many in the rows (an issuer has many deals).

DROP FUNCTION IF EXISTS public.relationship_link_counts();

CREATE FUNCTION public.relationship_link_counts()
RETURNS TABLE (
    relationship_code text,
    parent_domain_code text,
    child_domain_code text,
    link_count bigint,
    max_per_parent bigint,
    max_per_child bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
SET statement_timeout = '30s'
AS $$
    WITH current_links AS (
        SELECT r.relationship_code::text AS relationship_code,
               p.domain_code::text AS parent_domain_code,
               c.domain_code::text AS child_domain_code,
               r.parent_entity_id,
               r.child_entity_id
        FROM entity_relationships r
        JOIN master_entities p ON p.id = r.parent_entity_id
        JOIN master_entities c ON c.id = r.child_entity_id
        WHERE r.valid_from <= CURRENT_DATE
          AND r.valid_to >= CURRENT_DATE
          AND r.system_from <= now()
          AND r.system_to >= now()
    ), counted AS (
        SELECT relationship_code,
               parent_domain_code,
               child_domain_code,
               count(*) OVER (
                   PARTITION BY relationship_code, parent_domain_code, child_domain_code, parent_entity_id
               ) AS per_parent,
               count(*) OVER (
                   PARTITION BY relationship_code, parent_domain_code, child_domain_code, child_entity_id
               ) AS per_child
        FROM current_links
    )
    SELECT relationship_code,
           parent_domain_code,
           child_domain_code,
           count(*)::bigint AS link_count,
           max(per_parent)::bigint AS max_per_parent,
           max(per_child)::bigint AS max_per_child
    FROM counted
    GROUP BY relationship_code, parent_domain_code, child_domain_code;
$$;

COMMENT ON FUNCTION public.relationship_link_counts() IS
    'Current link counts by relationship code and stored parent and child types, plus the most records on either side.';

GRANT EXECUTE ON FUNCTION public.relationship_link_counts() TO authenticated;

NOTIFY pgrst, 'reload schema';
