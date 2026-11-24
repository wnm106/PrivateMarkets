-- One client per sign-in, for a sign-in that chooses one (docs/EXCEL_ADDIN.md).
--
-- A person who belongs to several clients saw all of them at once in Excel.
-- Record codes are unique per client only (20261122165959), so the same code
-- in two of their clients left a TAP cell with no way to say which was meant.
--
-- The Excel sign-in page now has the person pick a client, and that choice is
-- kept here against the sign-in's session id, which is in every token of that
-- session and survives a refresh. tenancy.client_session_ok is the one place
-- that says whether a session may act in a client; it is read by
-- current_client_ids and has_permission, so every record read and write
-- follows the choice. A formula, a table or a request never names a client.
--
-- A session with no choice behaves as before. The browser app's session is a
-- different session, so it is not narrowed by a choice made for Excel.

-- No foreign key on client_id on purpose: if the client is ever removed, the
-- row must stay so the session sees nothing, rather than every other client.
CREATE TABLE IF NOT EXISTS tenancy.session_clients (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id UUID NOT NULL,
    chosen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_clients_user ON tenancy.session_clients(user_id);

COMMENT ON TABLE tenancy.session_clients IS
    'The client a sign-in chose to work in. One row per auth session that chose; a session with no row works in all the person''s clients. Written only by tenancy.choose_session_client.';

-- Read and written only through the functions below.
ALTER TABLE tenancy.session_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenancy.session_clients FROM PUBLIC, anon, authenticated;
GRANT ALL ON tenancy.session_clients TO service_role;

-- The auth session this request's token belongs to. NULL for server code and
-- for a session the worker opens for a job owner, which carry no session id.
CREATE OR REPLACE FUNCTION tenancy.session_id()
RETURNS UUID
LANGUAGE sql STABLE
SET search_path = tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (auth.jwt() ->> 'session_id')::uuid
    END;
$$;
COMMENT ON FUNCTION tenancy.session_id() IS
    'The auth session id in the caller''s token, or NULL when the token has none.';

CREATE OR REPLACE FUNCTION tenancy.session_client_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT sc.client_id
    FROM tenancy.session_clients sc
    WHERE sc.session_id = tenancy.session_id()
      AND sc.user_id = auth.uid();
$$;
COMMENT ON FUNCTION tenancy.session_client_id() IS
    'The client this sign-in chose to work in, or NULL when it chose none.';

-- The body is the one in 20261120100000, with the last condition added: a session
-- that chose a client may act in that client only.
CREATE OR REPLACE FUNCTION tenancy.client_session_ok(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM tenancy.clients c WHERE c.id = p_client_id AND c.is_active)
       AND (
            NOT COALESCE(
                (SELECT r.mfa_required FROM tenancy.client_auth_requirements r WHERE r.client_id = p_client_id),
                FALSE
            )
            OR COALESCE(tenancy.session_has_mfa(), FALSE)
            OR EXISTS (
                SELECT 1 FROM ops.workflow_service_accounts w
                WHERE w.client_id = p_client_id AND w.user_id = auth.uid()
            )
       )
       AND COALESCE(tenancy.session_client_id() = p_client_id, TRUE);
$$;
COMMENT ON FUNCTION tenancy.client_session_ok(UUID) IS
    'TRUE when the client is active, this session meets its multi-factor rule, and the session chose no other client to work in. Checked by current_client_ids and has_permission, so it holds for direct data calls as well as the app.';

-- The clients the caller may choose for this sign-in: their active
-- memberships in active clients whose sign-in rule the session meets. Once
-- the session has chosen, that is the one client, marked is_chosen.
CREATE OR REPLACE FUNCTION tenancy.session_client_choices()
RETURNS TABLE (client_id UUID, client_code TEXT, client_name TEXT, is_chosen BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT c.id,
           c.client_code::TEXT,
           c.client_name::TEXT,
           COALESCE(c.id = tenancy.session_client_id(), FALSE)
    FROM tenancy.client_users cu
    JOIN tenancy.clients c ON c.id = cu.client_id
    WHERE cu.user_id = auth.uid()
      AND cu.is_active
      AND tenancy.profile_is_active()
      AND tenancy.client_session_ok(cu.client_id)
    ORDER BY c.client_name, c.client_code;
$$;
COMMENT ON FUNCTION tenancy.session_client_choices() IS
    'The caller''s own clients that this sign-in may work in. After a choice it lists that client only, with is_chosen true.';

-- Choose the client this sign-in works in. Once per session: the choice
-- belongs to the sign-in, so a different client means signing in again.
CREATE OR REPLACE FUNCTION tenancy.choose_session_client(p_client_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_user UUID := auth.uid();
    v_session UUID := tenancy.session_id();
    v_chosen UUID;
BEGIN
    IF v_user IS NULL OR v_session IS NULL THEN
        RAISE EXCEPTION 'A client is chosen by a signed-in person, for their own sign-in' USING ERRCODE = '42501';
    END IF;

    SELECT sc.client_id INTO v_chosen
    FROM tenancy.session_clients sc
    WHERE sc.session_id = v_session;
    IF FOUND THEN
        IF v_chosen = p_client_id THEN
            RETURN v_chosen;
        END IF;
        RAISE EXCEPTION 'This sign-in is already for another client. Sign in again to change it.' USING ERRCODE = '42501';
    END IF;

    -- The same answer whether the client does not exist or the caller is not in it.
    IF p_client_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM tenancy.client_users cu
        WHERE cu.user_id = v_user
          AND cu.client_id = p_client_id
          AND cu.is_active
          AND tenancy.profile_is_active()
          AND tenancy.client_session_ok(p_client_id)
    ) THEN
        RAISE EXCEPTION 'You do not belong to this client' USING ERRCODE = '42501';
    END IF;

    INSERT INTO tenancy.session_clients (session_id, user_id, client_id)
    VALUES (v_session, v_user, p_client_id)
    ON CONFLICT (session_id) DO NOTHING;

    -- Two requests at once: the first one's choice stands.
    SELECT sc.client_id INTO v_chosen
    FROM tenancy.session_clients sc
    WHERE sc.session_id = v_session;
    IF v_chosen IS DISTINCT FROM p_client_id THEN
        RAISE EXCEPTION 'This sign-in is already for another client. Sign in again to change it.' USING ERRCODE = '42501';
    END IF;
    RETURN v_chosen;
END;
$$;
COMMENT ON FUNCTION tenancy.choose_session_client(UUID) IS
    'Sets the one client this sign-in works in. The caller must be an active member whose session meets the client''s sign-in rule. A session that has chosen cannot choose another.';

REVOKE ALL ON FUNCTION tenancy.session_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.session_client_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.session_client_choices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.choose_session_client(UUID) FROM PUBLIC, anon, authenticated;
-- session_id and session_client_id are called only from inside the functions here.
GRANT EXECUTE ON FUNCTION tenancy.session_id() TO service_role;
GRANT EXECUTE ON FUNCTION tenancy.session_client_id() TO service_role;
GRANT EXECUTE ON FUNCTION tenancy.session_client_choices() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION tenancy.choose_session_client(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
