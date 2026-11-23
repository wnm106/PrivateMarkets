-- Workflows show only the client the caller is working in.
--
-- ops.workflow_can_see and ops.workflow_can let a tenant admin through before
-- they looked at the client, so staff in support mode for one client saw every
-- client's workflows, runs, reviews, forms and screens, and could act on them.
-- Both now follow tenancy.current_client_ids() and tenancy.has_permission(),
-- the way ops.can_see does for jobs: in support mode that is the impersonated
-- client only, otherwise the caller's own memberships. A shared workflow (no
-- client) stays visible to anyone working in a client, and only a tenant admin
-- may manage one.

CREATE OR REPLACE FUNCTION ops.workflow_can_see(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN EXISTS (SELECT 1 FROM tenancy.current_client_ids())
        ELSE p_client_id IN (SELECT tenancy.current_client_ids())
    END;
$$;
COMMENT ON FUNCTION ops.workflow_can_see(UUID) IS
    'Whether the caller sees a workflow, run, review, form or screen of this client: only the clients this session is working in (the impersonated client in support mode). A shared one (no client) is visible to anyone working in a client.';

CREATE OR REPLACE FUNCTION ops.workflow_can(p_client_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN tenancy.is_tenant_admin()
        ELSE tenancy.has_permission(p_client_id, p_permission)
    END;
$$;
COMMENT ON FUNCTION ops.workflow_can(UUID, TEXT) IS
    'Whether the caller holds a workflow permission in this client. Staff act on a client only while impersonating it (has_permission). Only a tenant admin manages a shared workflow (no client).';

REVOKE ALL ON FUNCTION ops.workflow_can_see(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_can(UUID, TEXT) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
