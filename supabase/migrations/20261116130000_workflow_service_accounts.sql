-- Workflow service accounts.
--
-- A workflow step does not run as the person who started the run. It runs as
-- the client's workflow service account: a user that is not a person, belongs
-- to that one client, and holds the Workflow Service role. What a workflow can
-- read and change is what that account can.
--
-- People are still checked, by lookup: the person who starts a run needs
-- workflow.run, and the person who approves a change needs workflow.review and
-- entity.write, so nobody approves a change they could not make themselves.

CREATE TABLE IF NOT EXISTS ops.workflow_service_accounts (
    client_id UUID PRIMARY KEY REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    user_id UUID NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ops.workflow_service_accounts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.workflow_service_accounts IS 'The user each client''s workflow steps run as. One per client, and an account serves one client only.';

-- What the service account may do. Deliberately short of Client Administrator:
-- it cannot delete records, manage users or roles, or change who sees what.
INSERT INTO tenancy.roles (client_id, role_code, role_name, description, is_system_role) VALUES
    (NULL, 'WORKFLOW_SERVICE', 'Workflow Service', 'For a client''s workflow service account: read and edit records, and resolve data quality exceptions', TRUE)
ON CONFLICT (role_code) WHERE client_id IS NULL DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code IN ('entity.read', 'entity.write', 'dq.manage')
WHERE r.role_code = 'WORKFLOW_SERVICE' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- Names the account a client's workflows run as. For setup, by the service role.
CREATE OR REPLACE FUNCTION public.workflow_service_account_set(p_client_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    INSERT INTO ops.workflow_service_accounts (client_id, user_id)
    VALUES (p_client_id, p_user_id)
    ON CONFLICT (client_id) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = NOW();
END;
$$;

-- The account a client's steps run as: {"userId": ...}, or {"problem": ...}
-- when there is none or it can no longer act for the client. The account must
-- belong to this client only and be able to read its records.
CREATE OR REPLACE FUNCTION public.workflow_worker_service_account(p_client_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_user UUID;
    v_problem TEXT;
BEGIN
    SELECT user_id INTO v_user FROM ops.workflow_service_accounts WHERE client_id = p_client_id;
    IF v_user IS NULL THEN
        RETURN jsonb_build_object('problem', 'This client has no workflow service account. See docs/WORKFLOWS.md, "Who a step runs as".');
    END IF;
    v_problem := public.workflow_worker_member(v_user, p_client_id, 'entity.read');
    IF v_problem IS NOT NULL THEN
        RETURN jsonb_build_object('problem', replace(v_problem, 'The person this step runs as', 'The workflow service account'));
    END IF;
    RETURN jsonb_build_object('userId', v_user);
END;
$$;

-- Whether a person may have a step act for them: {"name": ...} when they hold
-- every permission in p_permissions for the client, else {"problem": ...}.
-- Unlike the service account, a person may belong to several clients.
CREATE OR REPLACE FUNCTION public.workflow_worker_person(p_user_id UUID, p_client_id UUID, p_permissions TEXT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_name TEXT;
    v_permission TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('problem', 'This step has no person behind it. Start the run from the app, or from a schedule someone owns.');
    END IF;
    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, TRUE);

    SELECT display_name INTO v_name FROM tenancy.profiles WHERE id = p_user_id AND is_active;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('problem', 'The person behind this step is no longer an active user.');
    END IF;

    IF NOT tenancy.is_tenant_admin() THEN
        IF NOT (p_client_id IN (SELECT tenancy.current_client_ids())) THEN
            RETURN jsonb_build_object('problem', 'The person behind this step no longer belongs to this client.');
        END IF;
        FOREACH v_permission IN ARRAY COALESCE(p_permissions, ARRAY[]::TEXT[]) LOOP
            IF NOT tenancy.has_permission(p_client_id, v_permission) THEN
                RETURN jsonb_build_object('problem', 'The person behind this step does not hold ' || v_permission || ' for this client.');
            END IF;
        END LOOP;
    END IF;
    RETURN jsonb_build_object('name', v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.workflow_service_account_set(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_service_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_person(UUID, UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_service_account_set(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_service_account(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_person(UUID, UUID, TEXT[]) TO service_role;

NOTIFY pgrst, 'reload schema';
