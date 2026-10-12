-- Migration: Schema grants for `tenancy` + Azure AD provider wiring
-- Description: `tenancy` is a brand-new schema (unlike entity_instances/golden_master/etc.
-- which were already present when this project's schemas were exposed via PostgREST).
-- PostgREST/supabase-js access requires explicit privilege grants in addition to RLS
-- policies -- RLS only restricts *rows*, the role still needs the base GRANT.

GRANT USAGE ON SCHEMA tenancy TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenancy TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA tenancy TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy
    GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy
    GRANT EXECUTE ON FUNCTIONS TO authenticated;

-- Note: `tenancy` must also be added to `api.schemas` in supabase/config.toml
-- (done alongside this migration) so PostgREST actually exposes it.

-- ------------------------------------------------------------
-- Azure AD identity provider notes
-- ------------------------------------------------------------
-- Supabase Auth's "azure" OAuth provider is configured once at the project
-- level (Dashboard -> Authentication -> Providers -> Azure, or
-- supabase/config.toml [auth.external.azure] for local dev) using a SINGLE
-- Azure App Registration set to "multi-tenant" account type. That one app
-- registration can accept sign-ins from ANY client's Azure AD tenant; we
-- distinguish *which* client a user belongs to after the fact by matching the
-- "tid" (Azure tenant id) claim against tenancy.client_identity_providers,
-- which tenancy.handle_new_auth_user() does automatically on first login
-- (00028_tenancy_functions.sql).
--
-- The "tid" claim is not forwarded into raw_user_meta_data by GoTrue
-- automatically today, so until/unless a custom Auth Hook is wired up to copy
-- it, client admins (or tenant admins) can also just add the client's users
-- manually via tenancy.client_users / the Admin > Tenancy UI -- Azure login
-- still works for authentication, it just won't auto-join a client without
-- either the tid claim being present in user metadata or an email-domain
-- mapping in tenancy.client_identity_providers.
COMMENT ON TABLE tenancy.client_identity_providers IS
    'Maps a client to its Azure AD tenant (via the "tid" claim, when available in auth.users.raw_user_meta_data) and/or verified email domain, so a single multi-tenant Azure App Registration can auto-provision users into the correct client on first login. See tenancy.handle_new_auth_user(). Falls back to manual provisioning via tenancy.client_users when neither match is available.';
