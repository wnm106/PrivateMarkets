-- Migration: Multi-Tenant Client & User Management (Core)
-- Description: Establishes the `tenancy` schema: clients, user profiles, client
-- membership, roles/permissions (RBAC), per-entity ACLs, SSO (Azure AD) identity
-- mapping, and tenant-admin impersonation sessions ("support mode").
--
-- Design summary:
--   * tenancy.clients            -- a tenant (an investor/PE firm/LP using the platform)
--   * tenancy.profiles           -- 1:1 extension of auth.users; is_tenant_admin flags
--                                    Meridian support staff who can span clients
--   * tenancy.client_users       -- which auth.users belong to which client(s)
--   * tenancy.roles              -- global (client_id IS NULL) or client-owned custom roles
--   * tenancy.permissions        -- fine-grained capability codes
--   * tenancy.role_permissions   -- role -> permission grants
--   * tenancy.user_roles         -- user @ client -> role assignment
--   * tenancy.entity_grants      -- optional per-entity ACL (cascades to children)
--   * tenancy.client_identity_providers -- per-client Azure AD tenant / email domain mapping
--   * tenancy.impersonation_sessions    -- tenant-admin "simulate as client" sessions
--
-- See 00027 for adding client_id to entity_instances tables, 00028 for the
-- SQL helper functions used by RLS, and 00029 for the RLS policies themselves.

CREATE SCHEMA IF NOT EXISTS tenancy;
COMMENT ON SCHEMA tenancy IS 'Multi-tenant client/user management: tenants, membership, RBAC, entity ACLs, SSO mapping, impersonation';

-- ============================================================
-- Clients (tenants)
-- ============================================================
CREATE TABLE tenancy.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_code VARCHAR(50) UNIQUE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE, -- Meridian's own internal/unassigned bucket
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_clients_code ON tenancy.clients(client_code);
CREATE INDEX idx_clients_active ON tenancy.clients(is_active);
COMMENT ON TABLE tenancy.clients IS 'Tenants: client firms using the platform. All entity/positions data is scoped to a client.';

-- ============================================================
-- Profiles (1:1 extension of auth.users)
-- ============================================================
CREATE TABLE tenancy.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name VARCHAR(255),
    is_tenant_admin BOOLEAN NOT NULL DEFAULT FALSE, -- Meridian support/staff; can span & impersonate clients
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE tenancy.profiles IS 'Extends auth.users. is_tenant_admin = Meridian support staff who can span/impersonate multiple clients.';

-- ============================================================
-- Client membership
-- ============================================================
CREATE TABLE tenancy.client_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    invited_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, user_id)
);
CREATE INDEX idx_client_users_client ON tenancy.client_users(client_id);
CREATE INDEX idx_client_users_user ON tenancy.client_users(user_id);
COMMENT ON TABLE tenancy.client_users IS 'Which users belong to which client(s). Normal users typically belong to exactly one client.';

-- ============================================================
-- Roles & Permissions (RBAC)
-- ============================================================
CREATE TABLE tenancy.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE, -- NULL = global/system role template
    role_code VARCHAR(100) NOT NULL,
    role_name VARCHAR(255) NOT NULL,
    description TEXT,
    is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Global roles (client_id IS NULL) must have globally-unique codes; client-owned
-- custom roles must have codes unique within that client.
CREATE UNIQUE INDEX idx_roles_global_code ON tenancy.roles(role_code) WHERE client_id IS NULL;
CREATE UNIQUE INDEX idx_roles_client_code ON tenancy.roles(client_id, role_code) WHERE client_id IS NOT NULL;
CREATE INDEX idx_roles_client ON tenancy.roles(client_id);
COMMENT ON TABLE tenancy.roles IS 'Roles. client_id NULL = global system role template usable by any client; otherwise a client-specific custom role.';

CREATE TABLE tenancy.permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_code VARCHAR(150) UNIQUE NOT NULL,
    description TEXT
);
COMMENT ON TABLE tenancy.permissions IS 'Fine-grained capability codes (e.g. entity.read, entity.write, user.manage).';

CREATE TABLE tenancy.role_permissions (
    role_id UUID NOT NULL REFERENCES tenancy.roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES tenancy.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE tenancy.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES tenancy.roles(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, user_id, role_id)
);
CREATE INDEX idx_user_roles_client_user ON tenancy.user_roles(client_id, user_id);
CREATE INDEX idx_user_roles_role ON tenancy.user_roles(role_id);
COMMENT ON TABLE tenancy.user_roles IS 'Assigns a role to a user, scoped to a specific client (same user can hold different roles across clients).';

-- A role used in user_roles for a given client must either be a global template
-- role or a role owned by that exact client.
CREATE OR REPLACE FUNCTION tenancy.validate_role_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_role_client UUID;
BEGIN
    SELECT client_id INTO v_role_client FROM tenancy.roles WHERE id = NEW.role_id;
    IF v_role_client IS NOT NULL AND v_role_client != NEW.client_id THEN
        RAISE EXCEPTION 'Role % does not belong to client % and is not a global role', NEW.role_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_roles_validate_scope
    BEFORE INSERT OR UPDATE ON tenancy.user_roles
    FOR EACH ROW EXECUTE FUNCTION tenancy.validate_role_scope();

-- ============================================================
-- Entity-level ACL ("control who can see a specific entity or child entity")
-- ============================================================
CREATE TABLE tenancy.entity_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    grantee_type VARCHAR(20) NOT NULL CHECK (grantee_type IN ('USER', 'ROLE')),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES tenancy.roles(id) ON DELETE CASCADE,
    access_level VARCHAR(20) NOT NULL DEFAULT 'READ' CHECK (access_level IN ('READ', 'WRITE')),
    include_children BOOLEAN NOT NULL DEFAULT TRUE, -- cascades down entity_instances.entity_relationships
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (grantee_type = 'USER' AND user_id IS NOT NULL AND role_id IS NULL) OR
        (grantee_type = 'ROLE' AND role_id IS NOT NULL AND user_id IS NULL)
    )
);
CREATE INDEX idx_entity_grants_entity ON tenancy.entity_grants(entity_id);
CREATE INDEX idx_entity_grants_client ON tenancy.entity_grants(client_id);
CREATE INDEX idx_entity_grants_user ON tenancy.entity_grants(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_entity_grants_role ON tenancy.entity_grants(role_id) WHERE role_id IS NOT NULL;
COMMENT ON TABLE tenancy.entity_grants IS
    'Opt-in restriction: once ANY grant row exists for an entity (or an include_children=TRUE ancestor), that entity and (if cascading) its children become visible ONLY to the explicitly granted users/roles. Entities with no grants fall back to normal role-based (entity.read/entity.write) access.';

CREATE OR REPLACE FUNCTION tenancy.validate_entity_grant_role_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_role_client UUID;
BEGIN
    IF NEW.role_id IS NOT NULL THEN
        SELECT client_id INTO v_role_client FROM tenancy.roles WHERE id = NEW.role_id;
        IF v_role_client IS NOT NULL AND v_role_client != NEW.client_id THEN
            RAISE EXCEPTION 'Role % does not belong to client % and is not a global role', NEW.role_id, NEW.client_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entity_grants_validate_scope
    BEFORE INSERT OR UPDATE ON tenancy.entity_grants
    FOR EACH ROW EXECUTE FUNCTION tenancy.validate_entity_grant_role_scope();

-- ============================================================
-- SSO identity mapping (per-client Azure AD tenant / email domain)
-- ============================================================
CREATE TABLE tenancy.client_identity_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('EMAIL', 'AZURE')),
    azure_tenant_id UUID, -- Azure AD "tid" claim; identifies the client's own Azure AD tenant
    email_domain VARCHAR(255), -- fallback auto-join by verified email domain (e.g. 'acmecapital.com')
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (provider = 'AZURE' AND azure_tenant_id IS NOT NULL) OR
        (provider = 'EMAIL' AND email_domain IS NOT NULL)
    )
);
CREATE UNIQUE INDEX idx_cip_azure_tenant ON tenancy.client_identity_providers(azure_tenant_id) WHERE provider = 'AZURE';
CREATE UNIQUE INDEX idx_cip_email_domain ON tenancy.client_identity_providers(email_domain) WHERE provider = 'EMAIL';
CREATE INDEX idx_cip_client ON tenancy.client_identity_providers(client_id);
COMMENT ON TABLE tenancy.client_identity_providers IS
    'Maps a client to its Azure AD tenant (via the "tid" claim) and/or verified email domain, so a single multi-tenant Azure App Registration can auto-provision users into the correct client on first login. See tenancy.handle_new_auth_user().';

-- ============================================================
-- Tenant-admin impersonation ("support mode")
-- ============================================================
CREATE TABLE tenancy.impersonation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    reason TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);
-- Only one *active* impersonation session per tenant admin at a time.
CREATE UNIQUE INDEX idx_impersonation_active_per_admin ON tenancy.impersonation_sessions(admin_user_id) WHERE ended_at IS NULL;
CREATE INDEX idx_impersonation_client ON tenancy.impersonation_sessions(client_id);
COMMENT ON TABLE tenancy.impersonation_sessions IS
    'Audit trail + active-session marker for tenant admins (support staff) simulating a specific client. RLS is request-stateless (PostgREST), so "current client" is derived by checking for an open (ended_at IS NULL) row here rather than a session variable.';

-- updated_at triggers for the obvious tables
CREATE OR REPLACE FUNCTION tenancy.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_updated_at BEFORE UPDATE ON tenancy.clients FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON tenancy.profiles FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON tenancy.roles FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ============================================================
-- Seed: permissions + global system roles
-- ============================================================
INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('entity.read', 'View entities, attributes, positions, and intersections'),
    ('entity.write', 'Create and edit entities, attributes, positions, and intersections'),
    ('entity.delete', 'Delete / archive entities'),
    ('entity_access.manage', 'Create or remove per-entity access grants (ACLs)'),
    ('user.manage', 'Invite, provision, and deactivate users within a client'),
    ('role.manage', 'Create custom roles and assign/revoke roles'),
    ('dq.manage', 'Manage data quality rules and resolve exceptions'),
    ('client.manage', 'Manage client (tenant) settings; tenant-admin scope only')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.roles (client_id, role_code, role_name, description, is_system_role) VALUES
    (NULL, 'CLIENT_ADMIN', 'Client Administrator', 'Full control within the client: users, roles, entity access, and data', TRUE),
    (NULL, 'DATA_STEWARD', 'Data Steward', 'Can create/edit entities and manage data quality', TRUE),
    (NULL, 'ANALYST', 'Analyst', 'Read-only access to entities, positions, and reporting', TRUE),
    (NULL, 'VIEWER', 'Viewer', 'Minimal read-only access; default role for newly auto-provisioned users', TRUE)
ON CONFLICT (role_code) WHERE client_id IS NULL DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code IN (
    'entity.read', 'entity.write', 'entity.delete', 'entity_access.manage', 'user.manage', 'role.manage', 'dq.manage'
)
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code IN ('entity.read', 'entity.write', 'dq.manage')
WHERE r.role_code = 'DATA_STEWARD' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code IN ('entity.read')
WHERE r.role_code IN ('ANALYST', 'VIEWER') AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- Seed: an internal "Unassigned" client to backfill pre-existing data into (see 00027)
INSERT INTO tenancy.clients (client_code, client_name, is_internal, settings)
VALUES ('MERIDIAN_INTERNAL', 'Meridian Internal (Unassigned)', TRUE, '{}')
ON CONFLICT (client_code) DO NOTHING;
