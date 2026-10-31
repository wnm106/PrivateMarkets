-- Row security calls has_entity_access once or twice per golden-ledger row.
-- is_entity_restricted walks every ancestor even when entity_grants is empty,
-- which turned a positions grid (about 8,500 covering values) into an 11s
-- query. With no grants, nothing is restricted, so skip that walk.

CREATE OR REPLACE FUNCTION tenancy.is_entity_restricted(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp, entity_instances
AS $$
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM tenancy.entity_grants) THEN FALSE
      ELSE EXISTS (
        WITH RECURSIVE ancestry AS (
            SELECT p_entity_id AS entity_id, TRUE AS is_self
            UNION ALL
            SELECT er.parent_entity_id, FALSE
            FROM entity_instances.entity_relationships er
            JOIN ancestry a ON er.child_entity_id = a.entity_id
            WHERE er.valid_to = '9999-12-31' AND er.system_to = '9999-12-31 23:59:59'
        )
        SELECT 1 FROM tenancy.entity_grants g
        JOIN ancestry a ON a.entity_id = g.entity_id
        WHERE a.is_self OR g.include_children
      )
    END;
$$;

COMMENT ON FUNCTION tenancy.is_entity_restricted IS
  'TRUE if this entity (or an ancestor with include_children=TRUE) has any entity_grants rows. An empty grant table restricts nobody, so the ancestor walk is skipped.';

CREATE OR REPLACE FUNCTION tenancy.has_entity_access(p_entity_id UUID, p_level TEXT DEFAULT 'READ')
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp, entity_instances
AS $$
DECLARE
    v_client_id UUID;
    v_restricted BOOLEAN;
    v_has_grant BOOLEAN;
BEGIN
    SELECT client_id INTO v_client_id FROM entity_instances.master_entities WHERE id = p_entity_id;
    IF v_client_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Base tenant isolation: must be a member of (or impersonating) the owning client.
    IF v_client_id NOT IN (SELECT * FROM tenancy.current_client_ids()) THEN
        RETURN FALSE;
    END IF;

    -- Tenant admins in support mode can see/edit everything within the client
    -- they are actively impersonating (that's the point of support mode).
    IF tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() = v_client_id THEN
        RETURN TRUE;
    END IF;

    v_restricted := tenancy.is_entity_restricted(p_entity_id);

    IF NOT v_restricted THEN
        RETURN tenancy.has_permission(v_client_id, CASE WHEN p_level = 'WRITE' THEN 'entity.write' ELSE 'entity.read' END);
    END IF;

    SELECT EXISTS (
        WITH RECURSIVE ancestry AS (
            SELECT p_entity_id AS entity_id, TRUE AS is_self
            UNION ALL
            SELECT er.parent_entity_id, FALSE
            FROM entity_instances.entity_relationships er
            JOIN ancestry a ON er.child_entity_id = a.entity_id
            WHERE er.valid_to = '9999-12-31' AND er.system_to = '9999-12-31 23:59:59'
        )
        SELECT 1
        FROM tenancy.entity_grants g
        JOIN ancestry a ON a.entity_id = g.entity_id
        WHERE (a.is_self OR g.include_children)
          AND (p_level = 'READ' OR g.access_level = 'WRITE')
          AND (
                (g.grantee_type = 'USER' AND g.user_id = auth.uid())
                OR (g.grantee_type = 'ROLE' AND g.role_id IN (
                        SELECT role_id FROM tenancy.user_roles
                        WHERE user_id = auth.uid() AND client_id = v_client_id
                   ))
          )
    ) INTO v_has_grant;

    RETURN COALESCE(v_has_grant, FALSE);
END;
$$;
