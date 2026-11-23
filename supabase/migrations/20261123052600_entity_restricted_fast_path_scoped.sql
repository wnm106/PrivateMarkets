-- tenancy.is_entity_restricted: keep both the client scope and the fast path.
--
-- 20261120100000_tenancy_hardening counts only the owning client's grants. The
-- hosted project had already restored the fast path from
-- 20261026193000_skip_empty_entity_grant_walk (recorded there as
-- 20261120234000 entity_restricted_fast_path): with no entity grants at all, the
-- check is FALSE at once instead of walking every record's parents on each read.
-- Applied in version order, the hardening would drop that shortcut. This keeps
-- both, so a fresh database and the hosted project end up the same.
--
-- Safe to run again.

CREATE OR REPLACE FUNCTION tenancy.is_entity_restricted(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM tenancy.entity_grants) THEN FALSE
        ELSE EXISTS (
            SELECT 1
            FROM tenancy.entity_ancestors(p_entity_id) a
            JOIN tenancy.entity_grants g ON g.entity_id = a.entity_id
            JOIN entity_instances.master_entities me ON me.id = p_entity_id
            WHERE (a.is_self OR g.include_children)
              AND g.client_id = me.client_id
        )
    END;
$$;

COMMENT ON FUNCTION tenancy.is_entity_restricted(UUID) IS
    'TRUE when this entity, or an ancestor whose grant includes children, has an entity_grants row from the entity''s own client. Access is then an allow-list. FALSE at once when no entity grants exist.';

NOTIFY pgrst, 'reload schema';
