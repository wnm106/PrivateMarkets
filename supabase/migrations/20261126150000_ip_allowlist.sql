-- Allowed networks per client: people in a client that lists networks may use
-- the app only from those addresses.
--
-- tenancy.client_auth_requirements.allowed_ip_ranges holds the networks
-- (CIDR). Null or empty: any address. A person in several clients must meet
-- every list among them, as with the session rules.
--
-- The database cannot see the caller's address: requests reach it from the
-- app's servers. The app reads it from the request (Cloudflare's
-- cf-connecting-ip) and asks tenancy.ip_refusal at each entry point: the web
-- middleware (through tenancy.check_request, which also records activity for
-- the idle limit), the GraphQL request context (web, Excel and the Workers
-- API), and the bearer sign-in of the other API routes, the MCP server among
-- them. A call made straight to the Supabase API with a valid token is not
-- covered.

ALTER TABLE tenancy.client_auth_requirements
    ADD COLUMN IF NOT EXISTS allowed_ip_ranges CIDR[]
        CHECK (allowed_ip_ranges IS NULL OR cardinality(allowed_ip_ranges) <= 50);
COMMENT ON COLUMN tenancy.client_auth_requirements.allowed_ip_ranges IS
    'Networks this client''s people may use the app from (at most 50). Null or empty: any address.';

-- Why this caller may not use the app from p_ip, or NULL.
CREATE OR REPLACE FUNCTION tenancy.ip_refusal(p_ip TEXT)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_ip INET;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN NULL;
    END IF;
    -- Usual case: none of the caller's clients lists networks.
    IF NOT EXISTS (
        SELECT 1
        FROM tenancy.client_users cu
        JOIN tenancy.client_auth_requirements r ON r.client_id = cu.client_id
        WHERE cu.user_id = auth.uid() AND cu.is_active AND COALESCE(cardinality(r.allowed_ip_ranges), 0) > 0
    ) THEN
        RETURN NULL;
    END IF;
    -- A workflow service account is not a person and runs from the platform.
    IF EXISTS (SELECT 1 FROM ops.workflow_service_accounts w WHERE w.user_id = auth.uid()) THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_ip := NULLIF(btrim(COALESCE(p_ip, '')), '')::INET;
    EXCEPTION WHEN invalid_text_representation THEN
        v_ip := NULL;
    END;
    IF v_ip IS NULL THEN
        RETURN 'Your organization allows access only from its own networks, and this request''s address could not be read.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM tenancy.client_users cu
        JOIN tenancy.client_auth_requirements r ON r.client_id = cu.client_id
        WHERE cu.user_id = auth.uid() AND cu.is_active
          AND COALESCE(cardinality(r.allowed_ip_ranges), 0) > 0
          AND NOT (v_ip <<= ANY (r.allowed_ip_ranges))
    ) THEN
        RETURN format('Your organization allows access only from its own networks. This address (%s) is not one of them.', host(v_ip));
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tenancy.ip_refusal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.ip_refusal(TEXT) TO authenticated, service_role;

-- The web middleware's one call per request: the address check, then, when it
-- passes, activity for the idle limit (tenancy.touch_session).
CREATE OR REPLACE FUNCTION tenancy.check_request(p_ip TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_refusal TEXT := tenancy.ip_refusal(p_ip);
BEGIN
    IF v_refusal IS NULL THEN
        PERFORM tenancy.touch_session();
    END IF;
    RETURN v_refusal;
END;
$$;
REVOKE ALL ON FUNCTION tenancy.check_request(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.check_request(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
