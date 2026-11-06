-- Role-level entity security and tenant isolation fixes.
--
-- Tenants already cannot read each other's entity rows: tenancy.has_entity_access
-- rejects any entity whose client_id is outside tenancy.current_client_ids().
-- This migration closes the holes around that rule and makes role assignment
-- the way a client closes an entity.
--
-- Assigning a role grant (include_children defaults to TRUE) is an allow-list.
-- Anyone in the client who does not hold that role, and who is not allowed to
-- manage entity access, loses the entity and every descendant linked through
-- entity_relationships. Client administrators keep access so they can change
-- the assignment. With no grants, the entity stays open to members who hold
-- entity.read / entity.write.

-- ------------------------------------------------------------
-- Ancestor walk (cycle-safe). Not granted to API roles: it returns ids.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.entity_ancestors(p_entity_id UUID)
RETURNS TABLE (entity_id UUID, is_self BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = entity_instances, pg_temp
AS $$
    WITH RECURSIVE ancestry AS (
        SELECT p_entity_id AS entity_id, TRUE AS is_self, ARRAY[p_entity_id] AS path, 0 AS depth
        UNION ALL
        SELECT er.parent_entity_id, FALSE, a.path || er.parent_entity_id, a.depth + 1
        FROM entity_instances.entity_relationships er
        JOIN ancestry a ON er.child_entity_id = a.entity_id
        WHERE er.valid_to = '9999-12-31'
          AND er.system_to = '9999-12-31 23:59:59'
          AND a.depth < 32
          AND NOT (er.parent_entity_id = ANY (a.path))
    )
    SELECT ancestry.entity_id, ancestry.is_self FROM ancestry;
$$;

REVOKE ALL ON FUNCTION tenancy.entity_ancestors(UUID) FROM PUBLIC;
DO $$
BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION tenancy.entity_ancestors(UUID) TO %I', current_user);
END $$;

COMMENT ON FUNCTION tenancy.entity_ancestors(UUID) IS
    'Current parent chain for an entity, including itself. Cycles are cut. Executable only by the function owner (RLS helpers).';

CREATE OR REPLACE FUNCTION tenancy.is_entity_restricted(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tenancy.entity_ancestors(p_entity_id) a
        JOIN tenancy.entity_grants g ON g.entity_id = a.entity_id
        WHERE a.is_self OR g.include_children
    );
$$;

COMMENT ON FUNCTION tenancy.is_entity_restricted(UUID) IS
    'TRUE when this entity, or an ancestor whose grant includes children, has any entity_grants row. Access is then an allow-list.';

CREATE OR REPLACE FUNCTION tenancy.has_entity_access(p_entity_id UUID, p_level TEXT DEFAULT 'READ')
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
DECLARE
    v_client_id UUID;
    v_restricted BOOLEAN;
    v_has_grant BOOLEAN;
BEGIN
    SELECT client_id INTO v_client_id
    FROM entity_instances.master_entities
    WHERE id = p_entity_id;

    IF v_client_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Tenant wall. A user who is not a member of the owning client, and who is
    -- not impersonating it, never sees the row. This is what keeps tenants apart.
    IF v_client_id NOT IN (SELECT tenancy.current_client_ids()) THEN
        RETURN FALSE;
    END IF;

    -- Support mode: a tenant admin simulating this client can see the whole client.
    IF tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() = v_client_id THEN
        RETURN TRUE;
    END IF;

    -- Whoever may edit the allow-list must still be able to open the entity.
    IF tenancy.has_permission(v_client_id, 'entity_access.manage') THEN
        RETURN TRUE;
    END IF;

    v_restricted := tenancy.is_entity_restricted(p_entity_id);

    IF NOT v_restricted THEN
        RETURN tenancy.has_permission(
            v_client_id,
            CASE WHEN p_level = 'WRITE' THEN 'entity.write' ELSE 'entity.read' END
        );
    END IF;

    -- Closed entity: only an explicit user grant, or a role the caller holds
    -- in this client, counts. A grant on an ancestor counts for descendants
    -- when include_children is true (the default).
    SELECT EXISTS (
        SELECT 1
        FROM tenancy.entity_grants g
        JOIN tenancy.entity_ancestors(p_entity_id) a ON a.entity_id = g.entity_id
        WHERE (a.is_self OR g.include_children)
          AND (p_level = 'READ' OR g.access_level = 'WRITE')
          AND (
                (g.grantee_type = 'USER' AND g.user_id = auth.uid())
                OR (
                    g.grantee_type = 'ROLE'
                    AND g.role_id IN (
                        SELECT ur.role_id
                        FROM tenancy.user_roles ur
                        WHERE ur.user_id = auth.uid()
                          AND ur.client_id = v_client_id
                    )
                )
          )
    ) INTO v_has_grant;

    RETURN COALESCE(v_has_grant, FALSE);
END;
$$;

COMMENT ON FUNCTION tenancy.has_entity_access(UUID, TEXT) IS
    'Tenant isolation first, then role allow-list. A role grant hides the entity and, by default, every child from members who do not hold that role. entity_access.manage still opens the entity so an administrator can change the list.';

-- ------------------------------------------------------------
-- Replace the role allow-list for one entity. Children are always included.
-- An empty role list removes the role restriction (user grants are left as-is).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.set_entity_role_access(
    p_client_id UUID,
    p_entity_id UUID,
    p_roles JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
DECLARE
    v_entity_client UUID;
    v_role JSONB;
    v_role_id UUID;
    v_level TEXT;
    v_seen UUID[] := ARRAY[]::UUID[];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT (
        tenancy.is_tenant_admin()
        OR tenancy.has_permission(p_client_id, 'entity_access.manage')
    ) THEN
        RAISE EXCEPTION 'Not allowed to manage entity access' USING ERRCODE = '42501';
    END IF;

    SELECT client_id INTO v_entity_client
    FROM entity_instances.master_entities
    WHERE id = p_entity_id;

    IF v_entity_client IS NULL OR v_entity_client <> p_client_id THEN
        RAISE EXCEPTION 'Entity does not belong to this client' USING ERRCODE = '42501';
    END IF;

    DELETE FROM tenancy.entity_grants
    WHERE entity_id = p_entity_id
      AND client_id = p_client_id
      AND grantee_type = 'ROLE';

    IF p_roles IS NULL OR jsonb_typeof(p_roles) <> 'array' THEN
        RETURN;
    END IF;

    FOR v_role IN SELECT value FROM jsonb_array_elements(p_roles)
    LOOP
        BEGIN
            v_role_id := NULLIF(v_role->>'role_id', '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Role id is not a UUID';
        END;
        IF v_role_id IS NULL OR v_role_id = ANY (v_seen) THEN
            CONTINUE;
        END IF;
        v_seen := v_seen || v_role_id;

        v_level := UPPER(COALESCE(NULLIF(v_role->>'access_level', ''), 'READ'));
        IF v_level NOT IN ('READ', 'WRITE') THEN
            RAISE EXCEPTION 'Access level must be READ or WRITE';
        END IF;

        INSERT INTO tenancy.entity_grants (
            client_id, entity_id, grantee_type, role_id, access_level, include_children, created_by
        ) VALUES (
            p_client_id, p_entity_id, 'ROLE', v_role_id, v_level, TRUE, auth.uid()
        );
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION tenancy.set_entity_role_access(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.set_entity_role_access(UUID, UUID, JSONB) TO authenticated;

COMMENT ON FUNCTION tenancy.set_entity_role_access(UUID, UUID, JSONB) IS
    'Replaces role grants on one entity. Every grant includes children, so unauthorized members lose the entity and its descendants. Pass an empty array to remove the role restriction.';

-- One role grant per entity. Drop accidental duplicates before the index.
DELETE FROM tenancy.entity_grants a
WHERE a.grantee_type = 'ROLE'
  AND a.role_id IS NOT NULL
  AND a.id <> (
      SELECT b.id
      FROM tenancy.entity_grants b
      WHERE b.grantee_type = 'ROLE'
        AND b.client_id = a.client_id
        AND b.entity_id = a.entity_id
        AND b.role_id = a.role_id
      ORDER BY b.created_at, b.id
      LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_grants_one_role
    ON tenancy.entity_grants (client_id, entity_id, role_id)
    WHERE grantee_type = 'ROLE' AND role_id IS NOT NULL;

-- ------------------------------------------------------------
-- Directory used by the security screen. Security definer so a tenant admin
-- can list a client's entities without first impersonating, after the
-- permission check. Rows are still filtered to that one client.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.entity_access_rows(p_client_id UUID, p_entity_id UUID DEFAULT NULL, p_search TEXT DEFAULT NULL)
RETURNS TABLE (
    entity_id UUID,
    client_id UUID,
    entity_code TEXT,
    entity_name TEXT,
    domain_code TEXT,
    restricted BOOLEAN,
    grants JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
DECLARE
    v_search TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT (
        tenancy.is_tenant_admin()
        OR tenancy.has_permission(p_client_id, 'entity_access.manage')
    ) THEN
        RAISE EXCEPTION 'Not allowed to manage entity access' USING ERRCODE = '42501';
    END IF;

    v_search := NULLIF(btrim(COALESCE(p_search, '')), '');
    IF v_search IS NOT NULL THEN
        v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');
    END IF;

    RETURN QUERY
    SELECT
        me.id,
        me.client_id,
        me.entity_code::text,
        me.entity_name::text,
        me.domain_code::text,
        EXISTS (
            SELECT 1
            FROM tenancy.entity_ancestors(me.id) a
            JOIN tenancy.entity_grants g ON g.entity_id = a.entity_id
            WHERE a.is_self OR g.include_children
        ) AS restricted,
        COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', g.id,
                    'clientId', g.client_id,
                    'entityId', g.entity_id,
                    'granteeType', g.grantee_type,
                    'userId', g.user_id,
                    'roleId', g.role_id,
                    'granteeLabel', COALESCE(p.display_name, r.role_name),
                    'accessLevel', g.access_level,
                    'includeChildren', g.include_children,
                    'createdAt', g.created_at
                )
                ORDER BY g.created_at
            )
            FROM tenancy.entity_grants g
            LEFT JOIN tenancy.profiles p ON p.id = g.user_id
            LEFT JOIN tenancy.roles r ON r.id = g.role_id
            WHERE g.entity_id = me.id
              AND g.client_id = me.client_id
        ), '[]'::jsonb) AS grants
    FROM entity_instances.master_entities me
    WHERE me.client_id = p_client_id
      AND (p_entity_id IS NULL OR me.id = p_entity_id)
      AND (
          v_search IS NULL
          OR me.entity_name ILIKE '%' || v_search || '%' ESCAPE '\'
          OR me.entity_code ILIKE '%' || v_search || '%' ESCAPE '\'
      )
    ORDER BY me.entity_name, me.entity_code
    LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION tenancy.entity_access_rows(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.entity_access_rows(UUID, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION tenancy.entity_access_rows(UUID, UUID, TEXT) IS
    'Entities in one client plus their access grants, for administrators. Limited to 200 rows; pass a search string to narrow.';

-- Grant rows are an admin list, not something every co-member should read.
DROP POLICY IF EXISTS "Entity grants visible to co-members" ON tenancy.entity_grants;

-- ------------------------------------------------------------
-- Relationship graph was readable by every authenticated user.
-- ------------------------------------------------------------
ALTER TABLE entity_instances.entity_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_relationships_select ON entity_instances.entity_relationships;
DROP POLICY IF EXISTS entity_relationships_write ON entity_instances.entity_relationships;

CREATE POLICY entity_relationships_select ON entity_instances.entity_relationships
    FOR SELECT TO authenticated
    USING (
        tenancy.has_entity_access(parent_entity_id, 'READ')
        AND tenancy.has_entity_access(child_entity_id, 'READ')
    );

CREATE POLICY entity_relationships_write ON entity_instances.entity_relationships
    FOR ALL TO authenticated
    USING (
        tenancy.has_entity_access(parent_entity_id, 'WRITE')
        AND tenancy.has_entity_access(child_entity_id, 'WRITE')
    )
    WITH CHECK (
        tenancy.has_entity_access(parent_entity_id, 'WRITE')
        AND tenancy.has_entity_access(child_entity_id, 'WRITE')
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.entity_relationships TO authenticated;

DO $$
DECLARE
    v_kind "char";
BEGIN
    SELECT c.relkind INTO v_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'entity_relationships';

    IF v_kind IS NULL THEN
        EXECUTE $view$
            CREATE VIEW public.entity_relationships
            WITH (security_invoker = true) AS
            SELECT * FROM entity_instances.entity_relationships
        $view$;
    ELSIF v_kind = 'v' THEN
        EXECUTE 'ALTER VIEW public.entity_relationships SET (security_invoker = on)';
    ELSIF v_kind = 'r' THEN
        EXECUTE 'ALTER TABLE public.entity_relationships ENABLE ROW LEVEL SECURITY';
    END IF;

    IF v_kind IS NULL OR v_kind = 'v' THEN
        EXECUTE 'REVOKE ALL ON public.entity_relationships FROM PUBLIC, anon';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_relationships TO authenticated';
    END IF;
END $$;

-- ------------------------------------------------------------
-- Intersections: policies that read member rows under RLS hide the very
-- members the caller must not see, so an intersection can look open.
-- These helpers read members as the owner, then apply entity access.
-- Empty intersections and all-null position rows are not visible.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.intersection_accessible(p_intersection_id UUID, p_level TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM entity_instances.intersection_instances ii
        WHERE ii.id = p_intersection_id
          AND ii.client_id IN (SELECT tenancy.current_client_ids())
    )
    AND EXISTS (
        SELECT 1
        FROM entity_instances.intersection_members im
        WHERE im.intersection_id = p_intersection_id
          AND im.valid_to = '9999-12-31'
          AND im.system_to = '9999-12-31 23:59:59'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM entity_instances.intersection_members im
        WHERE im.intersection_id = p_intersection_id
          AND im.valid_to = '9999-12-31'
          AND im.system_to = '9999-12-31 23:59:59'
          AND NOT tenancy.has_entity_access(im.entity_id, p_level)
    );
$$;

CREATE OR REPLACE FUNCTION tenancy.dimensional_intersection_accessible(p_intersection_id UUID, p_level TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, position_master, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM position_master.dimensional_intersections di
        WHERE di.id = p_intersection_id
          AND (
              di.fund_entity_id IS NOT NULL
              OR di.issuer_entity_id IS NOT NULL
              OR di.deal_entity_id IS NOT NULL
              OR di.security_entity_id IS NOT NULL
          )
          AND (di.fund_entity_id IS NULL OR tenancy.has_entity_access(di.fund_entity_id, p_level))
          AND (di.issuer_entity_id IS NULL OR tenancy.has_entity_access(di.issuer_entity_id, p_level))
          AND (di.deal_entity_id IS NULL OR tenancy.has_entity_access(di.deal_entity_id, p_level))
          AND (di.security_entity_id IS NULL OR tenancy.has_entity_access(di.security_entity_id, p_level))
    );
$$;

REVOKE ALL ON FUNCTION tenancy.intersection_accessible(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.dimensional_intersection_accessible(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.intersection_accessible(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.dimensional_intersection_accessible(UUID, TEXT) TO authenticated;

DROP POLICY IF EXISTS "Intersections readable if all members accessible" ON entity_instances.intersection_instances;
DROP POLICY IF EXISTS "Intersections updatable if all members accessible" ON entity_instances.intersection_instances;
DROP POLICY IF EXISTS "Intersection attribute values readable per member access" ON golden_master.intersection_attribute_values;
DROP POLICY IF EXISTS "Intersection attribute values writable per member access" ON golden_master.intersection_attribute_values;
DROP POLICY IF EXISTS "Dimensional intersections readable per member access" ON position_master.dimensional_intersections;
DROP POLICY IF EXISTS "Dimensional intersections writable per member access" ON position_master.dimensional_intersections;
DROP POLICY IF EXISTS "Position metrics readable per intersection access" ON position_master.position_metrics;
DROP POLICY IF EXISTS "Position metrics writable per intersection access" ON position_master.position_metrics;

CREATE POLICY "Intersections readable if all members accessible" ON entity_instances.intersection_instances
    FOR SELECT TO authenticated
    USING (tenancy.intersection_accessible(id, 'READ'));

CREATE POLICY "Intersections updatable if all members accessible" ON entity_instances.intersection_instances
    FOR UPDATE TO authenticated
    USING (tenancy.intersection_accessible(id, 'WRITE'))
    WITH CHECK (
        client_id IN (SELECT tenancy.current_client_ids())
        AND tenancy.has_permission(client_id, 'entity.write')
    );

CREATE POLICY "Intersection attribute values readable per member access" ON golden_master.intersection_attribute_values
    FOR SELECT TO authenticated
    USING (tenancy.intersection_accessible(intersection_id, 'READ'));

CREATE POLICY "Intersection attribute values writable per member access" ON golden_master.intersection_attribute_values
    FOR ALL TO authenticated
    USING (tenancy.intersection_accessible(intersection_id, 'WRITE'))
    WITH CHECK (tenancy.intersection_accessible(intersection_id, 'WRITE'));

CREATE POLICY "Dimensional intersections readable per member access" ON position_master.dimensional_intersections
    FOR SELECT TO authenticated
    USING (tenancy.dimensional_intersection_accessible(id, 'READ'));

CREATE POLICY "Dimensional intersections writable per member access" ON position_master.dimensional_intersections
    FOR ALL TO authenticated
    USING (tenancy.dimensional_intersection_accessible(id, 'WRITE'))
    WITH CHECK (tenancy.dimensional_intersection_accessible(id, 'WRITE'));

CREATE POLICY "Position metrics readable per intersection access" ON position_master.position_metrics
    FOR SELECT TO authenticated
    USING (tenancy.dimensional_intersection_accessible(intersection_id, 'READ'));

CREATE POLICY "Position metrics writable per intersection access" ON position_master.position_metrics
    FOR ALL TO authenticated
    USING (tenancy.dimensional_intersection_accessible(intersection_id, 'WRITE'))
    WITH CHECK (tenancy.dimensional_intersection_accessible(intersection_id, 'WRITE'));

-- Scope rows name entities. Other tenants must not read them.
DROP POLICY IF EXISTS "Compliance scope assignments readable by authenticated" ON compliance.rule_scope_assignments;
CREATE POLICY "Compliance scope assignments readable per entity" ON compliance.rule_scope_assignments
    FOR SELECT TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR tenancy.has_entity_access(entity_id, 'READ')
    );

-- Uploaded files are tenant payloads. Rows with no client stay invisible to
-- signed-in users; the service role used by the local loader still bypasses RLS.
ALTER TABLE entity_instances.import_instances
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

DROP POLICY IF EXISTS import_instances_readable ON entity_instances.import_instances;
CREATE POLICY import_instances_select_tenant ON entity_instances.import_instances
    FOR SELECT TO authenticated
    USING (
        client_id IS NOT NULL
        AND client_id IN (SELECT tenancy.current_client_ids())
    );

COMMENT ON COLUMN entity_instances.import_instances.client_id IS
    'Owning tenant for an uploaded file. NULL rows are not visible through RLS.';

-- Views created after 00029, and CREATE OR REPLACE VIEW, can drop security_invoker
-- and then run as the owner, which bypasses RLS. Put it back on every view.
DO $$
DECLARE
    v_view RECORD;
BEGIN
    FOR v_view IN
        SELECT n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'v'
          AND n.nspname IN (
              'public', 'read_projections', 'golden_master', 'metadata_register',
              'entity_instances', 'position_master', 'compliance', 'data_quality'
          )
    LOOP
        EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = on)', v_view.nspname, v_view.relname);
    END LOOP;
END $$;

DO $$
BEGIN
    IF to_regclass('public.tenant_clients') IS NOT NULL THEN
        EXECUTE 'ALTER VIEW public.tenant_clients SET (security_invoker = on)';
        EXECUTE 'REVOKE ALL ON public.tenant_clients FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT SELECT ON public.tenant_clients TO service_role';
    END IF;

    IF to_regclass('public.intersection_instances') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.intersection_instances FROM anon';
    END IF;
    IF to_regclass('public.intersection_members') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.intersection_members FROM anon';
    END IF;
    IF to_regclass('public.intersection_attribute_values') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.intersection_attribute_values FROM anon';
    END IF;
    IF to_regclass('public.intersection_master') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.intersection_master FROM anon';
    END IF;
    IF to_regclass('public.entity_master') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.entity_master FROM anon';
    END IF;
END $$;
