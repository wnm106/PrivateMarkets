-- Session rules per client: how long a sign-in lasts, how long it may sit
-- idle, and "sign out everywhere".
--
-- tenancy.client_auth_requirements gains
--   max_session_minutes    a sign-in ends this long after it started
--   idle_timeout_minutes   a sign-in ends after this long with no activity
-- A person in several clients gets the strictest of their clients' rules.
--
-- When a sign-in started comes from the token itself: the earliest time in its
-- amr claim (Supabase keeps it across refreshes), else iat. So the time limit
-- holds on every path: the web app, the Workers API, Excel and the assistant.
-- Activity is recorded by the web app's middleware in tenancy.session_activity
-- (tenancy.touch_session, at most once a minute). A session the web app never
-- saw, such as the Excel add-in's own sign-in, has no idle limit.
--
-- "Sign out everywhere" stores a cut-off per person in
-- tenancy.session_revocations: every sign-in that started before it is over.
-- A person can do it for themselves; a client's user managers for their
-- members; staff for anyone. Stored sessions are removed too, so they cannot
-- refresh.
--
-- Where it is checked, all through tenancy.session_rule_breach:
--   tenancy.evaluate_sign_in   the access-token hook (no new token at sign-in
--                              or refresh) and the middleware (signs the
--                              browser out with the reason)
--   tenancy.client_session_ok  every read of a client's data, so a token that
--                              is still valid stops working at once

-- ============================================================
-- 1. The rules and what they read
-- ============================================================
ALTER TABLE tenancy.client_auth_requirements
    ADD COLUMN IF NOT EXISTS max_session_minutes INTEGER CHECK (max_session_minutes BETWEEN 15 AND 43200),
    ADD COLUMN IF NOT EXISTS idle_timeout_minutes INTEGER CHECK (idle_timeout_minutes BETWEEN 5 AND 1440);
COMMENT ON COLUMN tenancy.client_auth_requirements.max_session_minutes IS 'A sign-in ends this many minutes after it started (15 minutes to 30 days). Null: no limit.';
COMMENT ON COLUMN tenancy.client_auth_requirements.idle_timeout_minutes IS 'A sign-in the web app has seen ends after this many minutes without activity (5 to 1440). Null: no limit.';

CREATE TABLE IF NOT EXISTS tenancy.session_activity (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_activity_user ON tenancy.session_activity (user_id);
COMMENT ON TABLE tenancy.session_activity IS 'When the web app last saw each sign-in. Written by tenancy.touch_session; read by tenancy.session_rule_breach.';
ALTER TABLE tenancy.session_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenancy.session_activity FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS tenancy.session_revocations (
    user_id UUID PRIMARY KEY,
    revoked_before TIMESTAMPTZ NOT NULL,
    revoked_by UUID,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenancy.session_revocations IS 'Sign out everywhere: every sign-in of this person that started before revoked_before is over.';
ALTER TABLE tenancy.session_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenancy.session_revocations FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_audit_change ON tenancy.session_revocations;
CREATE TRIGGER zz_audit_change AFTER INSERT OR UPDATE OR DELETE ON tenancy.session_revocations
    FOR EACH ROW EXECUTE FUNCTION tenancy.audit_change();

-- When the sign-in behind these claims started.
CREATE OR REPLACE FUNCTION tenancy.session_started_at(p_claims JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE
SET search_path = tenancy, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT to_timestamp(min((elem ->> 'timestamp')::DOUBLE PRECISION))
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_claims -> 'amr') = 'array' THEN p_claims -> 'amr' ELSE '[]'::JSONB END) elem
         WHERE (elem ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$'),
        CASE WHEN (p_claims ->> 'iat') ~ '^[0-9]+$' THEN to_timestamp((p_claims ->> 'iat')::DOUBLE PRECISION) END
    );
$$;
REVOKE ALL ON FUNCTION tenancy.session_started_at(JSONB) FROM PUBLIC, anon, authenticated;

-- Why this sign-in is over, or NULL. p_client_id NULL applies the strictest
-- rule among the person's clients; a client id applies that client's rule.
CREATE OR REPLACE FUNCTION tenancy.session_rule_breach(p_user_id UUID, p_claims JSONB, p_client_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_started TIMESTAMPTZ;
    v_session UUID;
    v_revoked TIMESTAMPTZ;
    v_max INTEGER;
    v_idle INTEGER;
    v_last TIMESTAMPTZ;
    v_breach TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- This runs on every read of a client's data, so the usual case (no
    -- rule, no cut-off) is two indexed lookups and nothing else.
    SELECT revoked_before INTO v_revoked FROM tenancy.session_revocations WHERE user_id = p_user_id;
    IF p_client_id IS NOT NULL THEN
        SELECT r.max_session_minutes, r.idle_timeout_minutes INTO v_max, v_idle
        FROM tenancy.client_auth_requirements r WHERE r.client_id = p_client_id;
    ELSE
        SELECT min(r.max_session_minutes), min(r.idle_timeout_minutes) INTO v_max, v_idle
        FROM tenancy.client_auth_requirements r
        WHERE r.client_id IN (SELECT cu.client_id FROM tenancy.client_users cu WHERE cu.user_id = p_user_id AND cu.is_active);
    END IF;
    IF v_revoked IS NULL AND v_max IS NULL AND v_idle IS NULL THEN
        RETURN NULL;
    END IF;

    v_started := tenancy.session_started_at(COALESCE(p_claims, '{}'::JSONB));
    IF v_revoked IS NOT NULL AND v_started IS NOT NULL AND v_started < v_revoked THEN
        v_breach := 'You were signed out everywhere. Sign in again.';
    END IF;

    IF v_breach IS NULL AND v_max IS NOT NULL AND v_started IS NOT NULL AND now() - v_started > make_interval(mins => v_max) THEN
        v_breach := format('Your sign-in reached its limit of %s. Sign in again.', tenancy.minutes_text(v_max));
    END IF;

    IF v_breach IS NULL AND v_idle IS NOT NULL THEN
        BEGIN
            v_session := NULLIF(p_claims ->> 'session_id', '')::UUID;
        EXCEPTION WHEN invalid_text_representation THEN
            v_session := NULL;
        END;
        IF v_session IS NOT NULL THEN
            SELECT last_seen_at INTO v_last FROM tenancy.session_activity WHERE session_id = v_session;
            IF v_last IS NOT NULL AND now() - v_last > make_interval(mins => v_idle) THEN
                v_breach := format('You were signed out after %s without activity. Sign in again.', tenancy.minutes_text(v_idle));
            END IF;
        END IF;
    END IF;

    -- A workflow service account is not a person and keeps its sign-in.
    IF v_breach IS NOT NULL AND EXISTS (SELECT 1 FROM ops.workflow_service_accounts w WHERE w.user_id = p_user_id) THEN
        RETURN NULL;
    END IF;
    RETURN v_breach;
END;
$$;
REVOKE ALL ON FUNCTION tenancy.session_rule_breach(UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;

-- "90 minutes", "8 hours", "2 days".
CREATE OR REPLACE FUNCTION tenancy.minutes_text(p_minutes INTEGER)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN p_minutes % 1440 = 0 THEN (p_minutes / 1440) || CASE WHEN p_minutes = 1440 THEN ' day' ELSE ' days' END
        WHEN p_minutes % 60 = 0 THEN (p_minutes / 60) || CASE WHEN p_minutes = 60 THEN ' hour' ELSE ' hours' END
        ELSE p_minutes || CASE WHEN p_minutes = 1 THEN ' minute' ELSE ' minutes' END
    END;
$$;
REVOKE ALL ON FUNCTION tenancy.minutes_text(INTEGER) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. Where it is checked
-- ============================================================
-- The access-token hook and the middleware: as before, plus the session rules.
CREATE OR REPLACE FUNCTION tenancy.evaluate_sign_in(p_user_id uuid, p_email text, p_authentication_method text, p_claims jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_domain TEXT;
    v_client_id UUID;
    v_password BOOLEAN := TRUE;
    v_mfa_required BOOLEAN := FALSE;
    v_member_mfa BOOLEAN := FALSE;
    v_method TEXT := replace(COALESCE(p_authentication_method, ''), '"', '');
    v_provider TEXT := COALESCE(p_claims->'app_metadata'->>'provider', '');
    v_protocol TEXT;
    v_sso_id TEXT;
    v_aal TEXT := COALESCE(p_claims->>'aal', 'aal1');
    v_mfa_satisfied BOOLEAN;
    v_tenant_admin BOOLEAN := FALSE;
    v_profile_active BOOLEAN := TRUE;
    v_service_account BOOLEAN := FALSE;
    v_allowed BOOLEAN := TRUE;
    v_reason TEXT := NULL;
    v_session_breach TEXT;
BEGIN
    IF p_user_id IS NOT NULL THEN
        SELECT COALESCE(is_tenant_admin, FALSE), COALESCE(is_active, TRUE)
        INTO v_tenant_admin, v_profile_active
        FROM tenancy.profiles WHERE id = p_user_id;
        v_tenant_admin := COALESCE(v_tenant_admin, FALSE);
        v_profile_active := COALESCE(v_profile_active, TRUE);

        v_service_account := EXISTS (
            SELECT 1 FROM ops.workflow_service_accounts w WHERE w.user_id = p_user_id
        );

        -- A member of a client that requires a second factor needs one, whatever
        -- their email domain. A workflow service account is not a person.
        v_member_mfa := NOT v_service_account AND EXISTS (
            SELECT 1
            FROM tenancy.client_users cu
            JOIN tenancy.client_auth_requirements r ON r.client_id = cu.client_id
            WHERE cu.user_id = p_user_id AND cu.is_active AND r.mfa_required
        );
    END IF;

    v_mfa_satisfied := v_aal IN ('aal2', 'aal3')
        OR v_method = 'totp'
        OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
            WHERE elem->>'method' = 'totp'
        );

    IF NOT v_profile_active THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'reason', 'This account has been deactivated. Contact your administrator.',
            'mfa_required', FALSE,
            'mfa_satisfied', TRUE,
            'matched', FALSE
        );
    END IF;

    -- A session past its client's time limit, idle too long, or ended by
    -- "sign out everywhere" is over: no new token, and the app signs it out.
    v_session_breach := tenancy.session_rule_breach(p_user_id, p_claims, NULL);
    IF v_session_breach IS NOT NULL THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'reason', v_session_breach,
            'mfa_required', FALSE,
            'mfa_satisfied', TRUE,
            'matched', FALSE,
            'session_ended', TRUE
        );
    END IF;

    -- Platform staff can reach every client, so they always need a second factor.
    IF v_tenant_admin THEN
        RETURN jsonb_build_object(
            'allowed', TRUE,
            'reason', NULL,
            'mfa_required', TRUE,
            'mfa_satisfied', v_mfa_satisfied,
            'matched', FALSE
        );
    END IF;

    v_domain := lower(split_part(COALESCE(p_email, ''), '@', 2));
    IF v_domain = '' THEN
        RETURN jsonb_build_object(
            'allowed', TRUE,
            'reason', NULL,
            'mfa_required', v_member_mfa,
            'mfa_satisfied', (NOT v_member_mfa) OR v_mfa_satisfied,
            'matched', FALSE
        );
    END IF;

    SELECT client_id, password_enabled, mfa_required
    INTO v_client_id, v_password, v_mfa_required
    FROM tenancy.client_auth_requirements
    WHERE v_domain = ANY (email_domains)
    LIMIT 1;

    IF v_client_id IS NULL THEN
        SELECT p.client_id, COALESCE(r.password_enabled, TRUE), COALESCE(r.mfa_required, FALSE)
        INTO v_client_id, v_password, v_mfa_required
        FROM tenancy.client_identity_providers p
        LEFT JOIN tenancy.client_auth_requirements r ON r.client_id = p.client_id
        WHERE p.email_domain = v_domain AND p.is_enabled
        LIMIT 1;
    END IF;

    IF v_client_id IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', TRUE,
            'reason', NULL,
            'mfa_required', v_member_mfa,
            'mfa_satisfied', (NOT v_member_mfa) OR v_mfa_satisfied,
            'matched', FALSE
        );
    END IF;

    v_mfa_required := (COALESCE(v_mfa_required, FALSE) AND NOT v_service_account) OR v_member_mfa;

    SELECT elem->>'provider' INTO v_sso_id
    FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
    WHERE elem->>'method' = 'sso/saml' AND COALESCE(elem->>'provider', '') <> ''
    LIMIT 1;
    IF v_provider LIKE 'sso:%' THEN
        v_sso_id := COALESCE(NULLIF(v_sso_id, ''), split_part(v_provider, ':', 2));
    END IF;

    IF v_provider LIKE 'sso:%' OR v_method = 'sso/saml' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
        WHERE elem->>'method' = 'sso/saml'
    ) THEN
        v_protocol := 'SAML';
    ELSIF v_provider = 'azure' THEN
        v_protocol := 'AZURE';
    ELSIF v_provider LIKE 'custom:%' THEN
        v_protocol := 'OIDC';
    ELSIF v_provider = 'email'
        OR v_method IN ('password', 'recovery', 'invite', 'magiclink', 'otp', 'email/signup', 'email_change')
        OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
            WHERE elem->>'method' IN ('password', 'magiclink', 'otp', 'recovery', 'invite')
        ) THEN
        v_protocol := 'PASSWORD';
    ELSIF v_method IN ('oauth', 'oauth_provider/authorization_code') OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
        WHERE elem->>'method' = 'oauth'
    ) THEN
        v_protocol := 'OAUTH';
    ELSE
        v_protocol := NULL;
    END IF;

    IF v_protocol = 'PASSWORD' AND NOT v_password THEN
        v_allowed := FALSE;
        v_reason := 'This organization requires single sign-on. Use your company identity provider.';
    ELSIF v_protocol = 'SAML' AND NOT EXISTS (
        SELECT 1 FROM tenancy.client_identity_providers
        WHERE client_id = v_client_id AND provider = 'SAML' AND is_enabled AND registration_status = 'active'
          AND (v_sso_id IS NULL OR sso_provider_id IS NULL OR sso_provider_id::TEXT = v_sso_id)
    ) THEN
        v_allowed := FALSE;
        v_reason := 'This SAML identity provider is not allowed for this organization.';
    ELSIF v_protocol = 'AZURE' AND NOT EXISTS (
        SELECT 1 FROM tenancy.client_identity_providers
        WHERE client_id = v_client_id AND provider = 'AZURE' AND is_enabled
    ) THEN
        v_allowed := FALSE;
        v_reason := 'Microsoft Entra ID is not allowed for this organization.';
    ELSIF v_protocol = 'OIDC' AND NOT EXISTS (
        SELECT 1 FROM tenancy.client_identity_providers
        WHERE client_id = v_client_id AND provider = 'OIDC' AND is_enabled AND registration_status = 'active'
          AND (v_provider = '' OR oidc_identifier IS NULL OR oidc_identifier = v_provider)
    ) THEN
        v_allowed := FALSE;
        v_reason := 'This OpenID Connect provider is not allowed for this organization.';
    ELSIF v_protocol = 'OAUTH' AND NOT EXISTS (
        SELECT 1 FROM tenancy.client_identity_providers
        WHERE client_id = v_client_id AND provider IN ('AZURE', 'OIDC') AND is_enabled
    ) THEN
        v_allowed := FALSE;
        v_reason := 'This sign-in method is not allowed for this organization.';
    END IF;

    RETURN jsonb_build_object(
        'allowed', v_allowed,
        'reason', v_reason,
        'mfa_required', v_mfa_required,
        'mfa_satisfied', (NOT v_mfa_required) OR v_mfa_satisfied,
        'matched', TRUE
    );
END;
$function$;

-- Every read of a client's data: as before, plus that client's session rule.
CREATE OR REPLACE FUNCTION tenancy.client_session_ok(p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'tenancy', 'pg_temp'
AS $function$
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
       AND COALESCE(tenancy.session_client_id() = p_client_id, TRUE)
       AND tenancy.session_rule_breach(auth.uid(), auth.jwt(), p_client_id) IS NULL;
$function$;

-- ============================================================
-- 3. Recording activity and signing out everywhere
-- ============================================================
-- Called by the web app's middleware once the sign-in is allowed.
CREATE OR REPLACE FUNCTION tenancy.touch_session()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_session UUID := tenancy.session_id();
BEGIN
    IF auth.uid() IS NULL OR v_session IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO tenancy.session_activity AS a (session_id, user_id)
    VALUES (v_session, auth.uid())
    ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now()
    WHERE a.user_id = auth.uid() AND a.last_seen_at < now() - INTERVAL '60 seconds';
END;
$$;
REVOKE ALL ON FUNCTION tenancy.touch_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.touch_session() TO authenticated;

-- Ends every sign-in of a person. NULL: the caller themselves.
CREATE OR REPLACE FUNCTION tenancy.sign_out_everywhere(p_user_id UUID DEFAULT NULL)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_target UUID := COALESCE(p_user_id, auth.uid());
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
    END IF;
    IF v_target <> auth.uid()
       AND NOT tenancy.is_tenant_admin()
       AND NOT EXISTS (
            SELECT 1 FROM tenancy.client_users cu
            WHERE cu.user_id = v_target AND tenancy.has_permission(cu.client_id, 'user.manage')
       ) THEN
        RAISE EXCEPTION 'You can sign out only yourself or people in a client whose users you manage' USING ERRCODE = '42501';
    END IF;

    INSERT INTO tenancy.session_revocations (user_id, revoked_before, revoked_by)
    VALUES (v_target, now(), auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before, revoked_by = EXCLUDED.revoked_by, revoked_at = now();

    -- Stored sessions cannot refresh. Where Auth's tables are not reachable,
    -- the cut-off above still ends them at the next token and the next read.
    IF to_regclass('auth.sessions') IS NOT NULL THEN
        BEGIN
            EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1' USING v_target;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE WARNING 'auth.sessions not reachable; sessions of % end at their next token', v_target;
        END;
    END IF;
    RETURN now();
END;
$$;
REVOKE ALL ON FUNCTION tenancy.sign_out_everywhere(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.sign_out_everywhere(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
