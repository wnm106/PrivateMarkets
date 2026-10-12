-- Migration: Tenancy helper functions
-- Description: SQL functions used by RLS policies (00029) and by the app layer
-- (impersonation RPCs, auto-provisioning trigger on auth.users).
--
-- All functions are SECURITY DEFINER with a locked-down search_path so they can
-- read tenancy.* (which itself has RLS enabled) regardless of the caller's row
-- visibility, while still deriving identity strictly from auth.uid().

-- ------------------------------------------------------------
-- tenancy.is_tenant_admin()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.is_tenant_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT COALESCE((SELECT is_tenant_admin FROM tenancy.profiles WHERE id = auth.uid()), FALSE);
$$;
COMMENT ON FUNCTION tenancy.is_tenant_admin() IS 'TRUE for Meridian support staff who can span/impersonate clients.';

-- ------------------------------------------------------------
-- tenancy.active_impersonation_client_id()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.active_impersonation_client_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT client_id FROM tenancy.impersonation_sessions
    WHERE admin_user_id = auth.uid() AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1;
$$;
COMMENT ON FUNCTION tenancy.active_impersonation_client_id() IS 'The client a tenant admin is currently impersonating, if any. NULL otherwise.';

-- ------------------------------------------------------------
-- tenancy.current_client_ids()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.current_client_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_impersonating UUID;
BEGIN
    v_impersonating := tenancy.active_impersonation_client_id();

    IF v_impersonating IS NOT NULL THEN
        -- While impersonating, scope strictly to the impersonated client only
        -- (don't leak the admin's own memberships into the simulated view).
        RETURN QUERY SELECT v_impersonating;
    ELSE
        RETURN QUERY
            SELECT client_id FROM tenancy.client_users
            WHERE user_id = auth.uid() AND is_active = TRUE;
    END IF;
END;
$$;
COMMENT ON FUNCTION tenancy.current_client_ids() IS 'The set of client_ids the current session may see: the impersonated client if a tenant admin is in support mode, else the caller''s own client memberships.';

GRANT EXECUTE ON FUNCTION tenancy.is_tenant_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.active_impersonation_client_id() TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.current_client_ids() TO authenticated;

-- ------------------------------------------------------------
-- tenancy.has_permission(client_id, permission_code)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.has_permission(p_client_id UUID, p_permission_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT
        EXISTS (
            SELECT 1
            FROM tenancy.user_roles ur
            JOIN tenancy.role_permissions rp ON rp.role_id = ur.role_id
            JOIN tenancy.permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = auth.uid()
              AND ur.client_id = p_client_id
              AND p.permission_code = p_permission_code
        )
        OR (tenancy.is_tenant_admin() AND p_client_id = tenancy.active_impersonation_client_id());
$$;
COMMENT ON FUNCTION tenancy.has_permission IS 'TRUE if the caller holds a role granting the given permission for the given client, or is a tenant admin currently impersonating that client.';

GRANT EXECUTE ON FUNCTION tenancy.has_permission(UUID, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- tenancy.is_entity_restricted(entity_id)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.is_entity_restricted(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp, entity_instances
AS $$
    WITH RECURSIVE ancestry AS (
        SELECT p_entity_id AS entity_id, TRUE AS is_self
        UNION ALL
        SELECT er.parent_entity_id, FALSE
        FROM entity_instances.entity_relationships er
        JOIN ancestry a ON er.child_entity_id = a.entity_id
        WHERE er.valid_to = '9999-12-31' AND er.system_to = '9999-12-31 23:59:59'
    )
    SELECT EXISTS (
        SELECT 1 FROM tenancy.entity_grants g
        JOIN ancestry a ON a.entity_id = g.entity_id
        WHERE a.is_self OR g.include_children
    );
$$;
COMMENT ON FUNCTION tenancy.is_entity_restricted IS 'TRUE if this entity (or an ancestor with include_children=TRUE) has any entity_grants rows, meaning access is restricted to explicit grantees rather than normal role-based access.';

-- ------------------------------------------------------------
-- tenancy.has_entity_access(entity_id, level)
-- ------------------------------------------------------------
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
        -- No fine-grained ACL on this entity/ancestor chain: fall back to role permissions.
        RETURN tenancy.has_permission(v_client_id, CASE WHEN p_level = 'WRITE' THEN 'entity.write' ELSE 'entity.read' END);
    END IF;

    -- Entity (or an ancestor) is explicitly restricted: require a direct grant,
    -- either to this user or to one of their roles for this client.
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
COMMENT ON FUNCTION tenancy.has_entity_access IS 'Resolves whether the caller may READ or WRITE a given entity: tenant isolation, then entity-level ACL if restricted, else role-based entity.read/entity.write permission.';

GRANT EXECUTE ON FUNCTION tenancy.is_entity_restricted(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.has_entity_access(UUID, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- Impersonation RPCs ("simulate as a client")
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.start_impersonation(p_client_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only tenant admins may impersonate a client' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM tenancy.clients WHERE id = p_client_id AND is_active) THEN
        RAISE EXCEPTION 'Unknown or inactive client: %', p_client_id;
    END IF;

    UPDATE tenancy.impersonation_sessions
    SET ended_at = NOW()
    WHERE admin_user_id = auth.uid() AND ended_at IS NULL;

    INSERT INTO tenancy.impersonation_sessions (admin_user_id, client_id, reason)
    VALUES (auth.uid(), p_client_id, p_reason)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
COMMENT ON FUNCTION tenancy.start_impersonation IS 'Begin a support-mode session simulating the given client. Ends any prior active session for this admin first.';

CREATE OR REPLACE FUNCTION tenancy.stop_impersonation()
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    UPDATE tenancy.impersonation_sessions
    SET ended_at = NOW()
    WHERE admin_user_id = auth.uid() AND ended_at IS NULL;
$$;
COMMENT ON FUNCTION tenancy.stop_impersonation IS 'End the current tenant admin''s active impersonation session, if any.';

GRANT EXECUTE ON FUNCTION tenancy.start_impersonation(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.stop_impersonation() TO authenticated;

-- ------------------------------------------------------------
-- Provision a brand-new client with its membership for the creating admin
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.provision_client(
    p_client_code TEXT,
    p_client_name TEXT,
    p_admin_user_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_client_id UUID;
    v_role_id UUID;
BEGIN
    IF NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only tenant admins may provision new clients' USING ERRCODE = '42501';
    END IF;

    INSERT INTO tenancy.clients (client_code, client_name)
    VALUES (p_client_code, p_client_name)
    RETURNING id INTO v_client_id;

    IF p_admin_user_id IS NOT NULL THEN
        INSERT INTO tenancy.client_users (client_id, user_id, invited_by)
        VALUES (v_client_id, p_admin_user_id, auth.uid());

        SELECT id INTO v_role_id FROM tenancy.roles WHERE role_code = 'CLIENT_ADMIN' AND client_id IS NULL;
        INSERT INTO tenancy.user_roles (client_id, user_id, role_id, granted_by)
        VALUES (v_client_id, p_admin_user_id, v_role_id, auth.uid());
    END IF;

    RETURN v_client_id;
END;
$$;
COMMENT ON FUNCTION tenancy.provision_client IS 'Tenant-admin-only: creates a new client and optionally seeds its first CLIENT_ADMIN user.';

GRANT EXECUTE ON FUNCTION tenancy.provision_client(TEXT, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- Auto-provisioning on first login (profile + SSO-based client auto-join)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_azure_tid TEXT;
    v_domain TEXT;
    v_client_id UUID;
    v_viewer_role_id UUID;
BEGIN
    INSERT INTO tenancy.profiles (id, display_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email))
    ON CONFLICT (id) DO NOTHING;

    -- Azure AD: the "tid" claim identifies which Azure AD tenant the user signed in
    -- from. A single multi-tenant Azure App Registration can serve all clients;
    -- we route the user to the right client by matching tid here.
    v_azure_tid := NEW.raw_user_meta_data->>'tid';
    IF v_azure_tid IS NOT NULL THEN
        BEGIN
            SELECT client_id INTO v_client_id
            FROM tenancy.client_identity_providers
            WHERE provider = 'AZURE' AND azure_tenant_id = v_azure_tid::uuid AND is_enabled
            LIMIT 1;
        EXCEPTION WHEN invalid_text_representation THEN
            -- Malformed/non-GUID "tid" claim: never let this block sign-up.
            v_client_id := NULL;
        END;
    END IF;

    -- Fallback: verified email domain match (works for both email/password and OAuth).
    IF v_client_id IS NULL AND NEW.email IS NOT NULL THEN
        v_domain := split_part(NEW.email, '@', 2);
        SELECT client_id INTO v_client_id
        FROM tenancy.client_identity_providers
        WHERE provider = 'EMAIL' AND email_domain = v_domain AND is_enabled
        LIMIT 1;
    END IF;

    IF v_client_id IS NOT NULL THEN
        INSERT INTO tenancy.client_users (client_id, user_id)
        VALUES (v_client_id, NEW.id)
        ON CONFLICT (client_id, user_id) DO NOTHING;

        SELECT id INTO v_viewer_role_id FROM tenancy.roles WHERE role_code = 'VIEWER' AND client_id IS NULL;
        IF v_viewer_role_id IS NOT NULL THEN
            INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
            VALUES (v_client_id, NEW.id, v_viewer_role_id)
            ON CONFLICT (client_id, user_id, role_id) DO NOTHING;
        END IF;
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Provisioning is best-effort: never let it block account creation. The
    -- user will simply sign in with no client membership until an admin adds
    -- one, which the UI handles gracefully (see apps/web `/no-access`).
    RAISE WARNING 'tenancy.handle_new_auth_user failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION tenancy.handle_new_auth_user IS 'Creates a tenancy.profiles row for every new auth.users row, and auto-joins the user to a client (as VIEWER) by matching the Azure AD tid claim or verified email domain against tenancy.client_identity_providers. Users with no match sign in but see no client data until a CLIENT_ADMIN or tenant admin adds them to a client.';

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION tenancy.handle_new_auth_user();

-- ------------------------------------------------------------
-- Client member directory (surfaces auth.users.email, which PostgREST never
-- exposes directly, to admins of that client)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.client_member_directory(p_client_id UUID)
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    display_name TEXT,
    is_active BOOLEAN,
    client_user_is_active BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF NOT (tenancy.is_tenant_admin() OR p_client_id IN (SELECT * FROM tenancy.current_client_ids())) THEN
        RAISE EXCEPTION 'Not a member of this client' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
        SELECT u.id, u.email::TEXT, p.display_name, p.is_active, cu.is_active
        FROM tenancy.client_users cu
        JOIN auth.users u ON u.id = cu.user_id
        LEFT JOIN tenancy.profiles p ON p.id = u.id
        WHERE cu.client_id = p_client_id;
END;
$$;
COMMENT ON FUNCTION tenancy.client_member_directory IS 'Lists a client''s members with email (from auth.users, never exposed directly via PostgREST). Caller must belong to the client (or be impersonating it) or be a tenant admin.';

GRANT EXECUTE ON FUNCTION tenancy.client_member_directory(UUID) TO authenticated;
