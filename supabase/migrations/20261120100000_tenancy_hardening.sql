-- Tenancy hardening.
--
-- Closes the ways a signed-in user could cross from one client into another
-- through the tenancy tables and helper functions themselves:
--
--   1. A user could set is_tenant_admin (or is_active) on their own profile.
--   2. Sign-up joined a stranger to a client on a Microsoft tenant id or an
--      email domain that nobody had verified.
--   3. Deactivating a member, a profile or a client changed nothing.
--   4. Multi-factor sign-in was checked by the web app only, so a direct data
--      call with a password-only session skipped it. Platform staff were exempt.
--   5. Support-mode (impersonation) sessions never expired and outlived demotion.
--   6. One client's administrator could hide another client's records, join
--      another client's intersection, or bind another client's custom role.
--
-- Every access helper keeps its name and signature, so the policies that call
-- them need no change.

-- ============================================================
-- Session helpers
-- ============================================================

-- TRUE for trusted server code: the service role, or SQL run with no request
-- at all (migrations, psql). FALSE for every signed-in or anonymous API call.
CREATE OR REPLACE FUNCTION tenancy.is_backend_caller()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = tenancy, pg_temp
AS $$
    SELECT auth.uid() IS NULL
       AND COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb ->> 'role', '')
           IN ('', 'service_role');
$$;
COMMENT ON FUNCTION tenancy.is_backend_caller() IS
    'TRUE when the caller is the service role or SQL with no API request (migrations). Never TRUE for a signed-in or anonymous API caller.';

-- TRUE when this session passed a second factor. A session the worker opens
-- for a job owner (ops.assume_user and the workflow lookups) carries the
-- server_session claim: there is no person present to prompt, and only the
-- service role can open one.
CREATE OR REPLACE FUNCTION tenancy.session_has_mfa()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = tenancy, pg_temp
AS $$
    SELECT COALESCE(auth.jwt() ->> 'aal', 'aal1') IN ('aal2', 'aal3')
        OR COALESCE(auth.jwt() -> 'server_session' = 'true'::jsonb, FALSE)
        OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END
            ) elem
            WHERE elem ->> 'method' = 'totp'
        );
$$;
COMMENT ON FUNCTION tenancy.session_has_mfa() IS
    'TRUE when the session token shows a second factor (aal2, or a TOTP entry in amr), or is a server session opened by the worker for a job owner.';

-- A profile that was switched off loses access everywhere. A user with no
-- profile row yet counts as active, so nobody is locked out by a missing row.
CREATE OR REPLACE FUNCTION tenancy.profile_is_active()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT COALESCE((SELECT is_active FROM tenancy.profiles WHERE id = auth.uid()), TRUE);
$$;

-- Whether this session may act in a client at all: the client is active, and
-- if the client requires multi-factor sign-in the session has it. The rule
-- follows membership, not email domain, so a guest from another domain is held
-- to the client's rule too. The client's workflow service account is not a
-- person and is exempt: only the worker can sign in as it.
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
       );
$$;
COMMENT ON FUNCTION tenancy.client_session_ok(UUID) IS
    'TRUE when the client is active and this session meets its multi-factor rule. Checked by current_client_ids and has_permission, so it holds for direct data calls as well as the app.';

REVOKE ALL ON FUNCTION tenancy.is_backend_caller() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.session_has_mfa() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.profile_is_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.client_session_ok(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.is_backend_caller() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION tenancy.session_has_mfa() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION tenancy.profile_is_active() TO authenticated, service_role;
-- client_session_ok is called only from inside the two helpers below.
REVOKE ALL ON FUNCTION tenancy.client_session_ok(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION tenancy.client_session_ok(UUID) TO service_role;

-- ============================================================
-- Platform staff
-- ============================================================

-- Staff powers span every client, so they need an active profile and a second
-- factor on the session. A staff member who signs in with a password alone is
-- an ordinary user until they complete the second step.
CREATE OR REPLACE FUNCTION tenancy.is_tenant_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT COALESCE(
               (SELECT is_tenant_admin AND is_active FROM tenancy.profiles WHERE id = auth.uid()),
               FALSE
           )
       AND COALESCE(tenancy.session_has_mfa(), FALSE);
$$;
COMMENT ON FUNCTION tenancy.is_tenant_admin() IS
    'TRUE for active platform staff whose session passed a second factor. Staff can span and impersonate clients, so a password-only session does not carry staff powers.';

-- Only platform staff may change who is staff or who is active. Without this
-- the self-update policy on profiles let any user promote themselves.
CREATE OR REPLACE FUNCTION tenancy.guard_profile_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF (NEW.is_tenant_admin IS DISTINCT FROM OLD.is_tenant_admin
        OR NEW.is_active IS DISTINCT FROM OLD.is_active)
       AND NOT tenancy.is_backend_caller()
       AND NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only platform staff may change is_tenant_admin or is_active'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_privileged ON tenancy.profiles;
CREATE TRIGGER trg_profiles_guard_privileged
    BEFORE UPDATE ON tenancy.profiles
    FOR EACH ROW EXECUTE FUNCTION tenancy.guard_profile_privileged_columns();

-- A profile row is created by the sign-up trigger. Nobody inserts one with the
-- staff flag already set.
CREATE OR REPLACE FUNCTION tenancy.guard_profile_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF NEW.is_tenant_admin
       AND NOT tenancy.is_backend_caller()
       AND NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only platform staff may create a staff profile' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_insert ON tenancy.profiles;
CREATE TRIGGER trg_profiles_guard_insert
    BEFORE INSERT ON tenancy.profiles
    FOR EACH ROW EXECUTE FUNCTION tenancy.guard_profile_insert();

-- ============================================================
-- Support mode: sessions end on their own, and end with the staff role
-- ============================================================
ALTER TABLE tenancy.impersonation_sessions
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Sessions already open get eight hours from when they started, so a session
-- left open for days ends now.
UPDATE tenancy.impersonation_sessions
SET expires_at = started_at + INTERVAL '8 hours'
WHERE expires_at IS NULL;

ALTER TABLE tenancy.impersonation_sessions
    ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '8 hours',
    ALTER COLUMN expires_at SET NOT NULL;

COMMENT ON COLUMN tenancy.impersonation_sessions.expires_at IS
    'When this support-mode session stops counting, whether or not it was ended by hand. Eight hours from the start.';

CREATE OR REPLACE FUNCTION tenancy.active_impersonation_client_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT s.client_id
    FROM tenancy.impersonation_sessions s
    WHERE s.admin_user_id = auth.uid()
      AND s.ended_at IS NULL
      AND s.expires_at > NOW()
      AND tenancy.is_tenant_admin()
    ORDER BY s.started_at DESC
    LIMIT 1;
$$;
COMMENT ON FUNCTION tenancy.active_impersonation_client_id() IS
    'The client a platform staff member is impersonating right now, if any. A session counts only while it is open, unexpired, and its owner is still active staff.';

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

    INSERT INTO tenancy.impersonation_sessions (admin_user_id, client_id, reason, expires_at)
    VALUES (auth.uid(), p_client_id, p_reason, NOW() + INTERVAL '8 hours')
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ============================================================
-- Membership and permissions honour "inactive"
-- ============================================================
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
            SELECT cu.client_id
            FROM tenancy.client_users cu
            WHERE cu.user_id = auth.uid()
              AND cu.is_active = TRUE
              AND tenancy.profile_is_active()
              AND tenancy.client_session_ok(cu.client_id);
    END IF;
END;
$$;
COMMENT ON FUNCTION tenancy.current_client_ids() IS
    'The clients this session may see: the impersonated client for staff in support mode, else the caller''s active memberships in active clients whose sign-in rule the session meets.';

CREATE OR REPLACE FUNCTION tenancy.has_permission(p_client_id UUID, p_permission_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT
        (
            EXISTS (
                SELECT 1
                FROM tenancy.user_roles ur
                JOIN tenancy.client_users cu
                  ON cu.client_id = ur.client_id AND cu.user_id = ur.user_id AND cu.is_active
                JOIN tenancy.role_permissions rp ON rp.role_id = ur.role_id
                JOIN tenancy.permissions p ON p.id = rp.permission_id
                WHERE ur.user_id = auth.uid()
                  AND ur.client_id = p_client_id
                  AND p.permission_code = p_permission_code
            )
            AND tenancy.profile_is_active()
            AND tenancy.client_session_ok(p_client_id)
        )
        OR (tenancy.is_tenant_admin() AND p_client_id = tenancy.active_impersonation_client_id());
$$;
COMMENT ON FUNCTION tenancy.has_permission(UUID, TEXT) IS
    'TRUE if the caller is an active member of an active client, holds a role granting the permission there, and meets the client''s sign-in rule; or is platform staff impersonating that client.';

-- ============================================================
-- Sign-in decision: staff need a second factor, and the multi-factor rule
-- follows membership as well as email domain
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.evaluate_sign_in(
    p_user_id UUID,
    p_email TEXT,
    p_authentication_method TEXT,
    p_claims JSONB
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
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
$$;

-- ============================================================
-- Sign-up: join a client only on proof
-- ============================================================
-- Two proofs count:
--   * Microsoft Entra: the account was created by the Azure provider (Auth
--     writes app metadata, the person signing up cannot), and the tenant id
--     comes from that sign-in. A "tid" typed into sign-up metadata is ignored.
--   * Email domain: the address is confirmed. An unconfirmed address proves
--     nothing about who owns the mailbox.
CREATE OR REPLACE FUNCTION tenancy.auto_join_client(
    p_user_id UUID,
    p_email TEXT,
    p_email_confirmed BOOLEAN,
    p_app_meta JSONB,
    p_user_meta JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_azure_tid TEXT;
    v_iss TEXT;
    v_domain TEXT;
    v_client_id UUID;
    v_viewer_role_id UUID;
BEGIN
    IF COALESCE(p_app_meta->>'provider', '') = 'azure' THEN
        v_iss := COALESCE(p_user_meta->>'iss', '');
        v_azure_tid := COALESCE(
            NULLIF(p_user_meta->>'tid', ''),
            NULLIF(p_user_meta->'custom_claims'->>'tid', ''),
            NULLIF(substring(v_iss FROM '^https://login\.microsoftonline\.com/([0-9a-fA-F-]{36})/'), '')
        );
        -- When the issuer is present it must name the same directory.
        IF v_azure_tid IS NOT NULL AND v_iss <> ''
           AND v_iss NOT ILIKE 'https://login.microsoftonline.com/' || v_azure_tid || '/%' THEN
            v_azure_tid := NULL;
        END IF;
        IF v_azure_tid IS NOT NULL THEN
            BEGIN
                SELECT client_id INTO v_client_id
                FROM tenancy.client_identity_providers
                WHERE provider = 'AZURE' AND azure_tenant_id = v_azure_tid::uuid AND is_enabled
                LIMIT 1;
            EXCEPTION WHEN invalid_text_representation THEN
                v_client_id := NULL;
            END;
        END IF;
    END IF;

    IF v_client_id IS NULL AND p_email IS NOT NULL AND COALESCE(p_email_confirmed, FALSE) THEN
        v_domain := lower(split_part(p_email, '@', 2));
        IF v_domain <> '' THEN
            SELECT client_id INTO v_client_id
            FROM tenancy.client_auth_requirements
            WHERE v_domain = ANY (email_domains)
            LIMIT 1;
            IF v_client_id IS NULL THEN
                SELECT client_id INTO v_client_id
                FROM tenancy.client_identity_providers
                WHERE email_domain = v_domain AND is_enabled
                LIMIT 1;
            END IF;
        END IF;
    END IF;

    IF v_client_id IS NOT NULL THEN
        INSERT INTO tenancy.client_users (client_id, user_id)
        VALUES (v_client_id, p_user_id)
        ON CONFLICT (client_id, user_id) DO NOTHING;

        SELECT id INTO v_viewer_role_id FROM tenancy.roles WHERE role_code = 'VIEWER' AND client_id IS NULL;
        IF v_viewer_role_id IS NOT NULL THEN
            INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
            VALUES (v_client_id, p_user_id, v_viewer_role_id)
            ON CONFLICT (client_id, user_id, role_id) DO NOTHING;
        END IF;
    END IF;

    RETURN v_client_id;
END;
$$;
-- Only the sign-up triggers call this. Called directly it would join the caller
-- to any client, so no API role may run it.
REVOKE ALL ON FUNCTION tenancy.auto_join_client(UUID, TEXT, BOOLEAN, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION tenancy.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    INSERT INTO tenancy.profiles (id, display_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email))
    ON CONFLICT (id) DO NOTHING;

    PERFORM tenancy.auto_join_client(
        NEW.id, NEW.email, NEW.email_confirmed_at IS NOT NULL,
        COALESCE(NEW.raw_app_meta_data, '{}'::jsonb), COALESCE(NEW.raw_user_meta_data, '{}'::jsonb)
    );

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tenancy.handle_new_auth_user failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION tenancy.handle_new_auth_user() IS
    'Creates a tenancy.profiles row for every new auth.users row, and joins the user to a client (as VIEWER) only on proof: an Azure sign-in from the client''s registered directory, or a confirmed address on the client''s email domain.';

-- An address confirmed after sign-up joins then. This is the usual path for a
-- password sign-up: the row is inserted unconfirmed and confirmed by the link.
CREATE OR REPLACE FUNCTION tenancy.handle_auth_user_confirmed()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    -- A user who already belongs to a client is left as they are.
    IF EXISTS (SELECT 1 FROM tenancy.client_users WHERE user_id = NEW.id) THEN
        RETURN NEW;
    END IF;

    PERFORM tenancy.auto_join_client(
        NEW.id, NEW.email, TRUE,
        COALESCE(NEW.raw_app_meta_data, '{}'::jsonb), COALESCE(NEW.raw_user_meta_data, '{}'::jsonb)
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tenancy.handle_auth_user_confirmed failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
    AFTER UPDATE OF email_confirmed_at ON auth.users
    FOR EACH ROW
    WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
    EXECUTE FUNCTION tenancy.handle_auth_user_confirmed();

-- ============================================================
-- Cross-client grants and roles
-- ============================================================

-- These run as the function owner so the role lookup is not hidden by row
-- security. Run as the caller, another client's role was invisible, the check
-- found nothing to object to, and the role could be bound across clients.
CREATE OR REPLACE FUNCTION tenancy.validate_role_scope()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_role_client UUID;
    v_found BOOLEAN;
BEGIN
    SELECT TRUE, client_id INTO v_found, v_role_client FROM tenancy.roles WHERE id = NEW.role_id;
    IF NOT COALESCE(v_found, FALSE) THEN
        RAISE EXCEPTION 'Role % does not exist', NEW.role_id;
    END IF;
    IF v_role_client IS NOT NULL AND v_role_client != NEW.client_id THEN
        RAISE EXCEPTION 'Role % does not belong to client % and is not a global role', NEW.role_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$;

-- A grant belongs to the client that owns the record. Without this, one
-- client's administrator could file a grant on another client's record, which
-- closed that record to its own users.
CREATE OR REPLACE FUNCTION tenancy.validate_entity_grant_role_scope()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_role_client UUID;
    v_entity_client UUID;
BEGIN
    SELECT client_id INTO v_entity_client
    FROM entity_instances.master_entities WHERE id = NEW.entity_id;
    IF v_entity_client IS DISTINCT FROM NEW.client_id THEN
        RAISE EXCEPTION 'An access grant must belong to the client that owns the record'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.role_id IS NOT NULL THEN
        SELECT client_id INTO v_role_client FROM tenancy.roles WHERE id = NEW.role_id;
        IF v_role_client IS NOT NULL AND v_role_client != NEW.client_id THEN
            RAISE EXCEPTION 'Role % does not belong to client % and is not a global role', NEW.role_id, NEW.client_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Grants filed against a record by a client that does not own it never counted
-- as intended. Remove any that exist.
DELETE FROM tenancy.entity_grants g
USING entity_instances.master_entities me
WHERE me.id = g.entity_id AND me.client_id <> g.client_id;

-- Only the owning client's grants close a record.
CREATE OR REPLACE FUNCTION tenancy.is_entity_restricted(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tenancy.entity_ancestors(p_entity_id) a
        JOIN tenancy.entity_grants g ON g.entity_id = a.entity_id
        JOIN entity_instances.master_entities me ON me.id = p_entity_id
        WHERE (a.is_self OR g.include_children)
          AND g.client_id = me.client_id
    );
$$;

-- A member row joins a record to an intersection. Both must belong to the same
-- client; checking only the record let one client add members to another's
-- intersection, which closed it to its owner.
DROP POLICY IF EXISTS "Intersection members writable per entity access" ON entity_instances.intersection_members;
CREATE POLICY "Intersection members writable per entity access" ON entity_instances.intersection_members
    FOR ALL TO authenticated
    USING (
        tenancy.has_entity_access(entity_id, 'WRITE')
        AND EXISTS (
            SELECT 1
            FROM entity_instances.intersection_instances ii
            JOIN entity_instances.master_entities me ON me.id = intersection_members.entity_id
            WHERE ii.id = intersection_members.intersection_id
              AND ii.client_id = me.client_id
        )
    )
    WITH CHECK (
        tenancy.has_entity_access(entity_id, 'WRITE')
        AND EXISTS (
            SELECT 1
            FROM entity_instances.intersection_instances ii
            JOIN entity_instances.master_entities me ON me.id = intersection_members.entity_id
            WHERE ii.id = intersection_members.intersection_id
              AND ii.client_id = me.client_id
        )
    );

-- client.manage is the platform-staff permission. A client's own role manager
-- cannot hand it out.
CREATE OR REPLACE FUNCTION tenancy.guard_platform_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM tenancy.permissions p
        WHERE p.id = NEW.permission_id AND p.permission_code = 'client.manage'
    )
       AND NOT tenancy.is_backend_caller()
       AND NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only platform staff may grant client.manage' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_role_permissions_guard_platform ON tenancy.role_permissions;
CREATE TRIGGER trg_role_permissions_guard_platform
    BEFORE INSERT OR UPDATE ON tenancy.role_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy.guard_platform_permissions();

-- ============================================================
-- Sessions the worker opens for a job owner
-- ============================================================
-- These three functions make a job's owner the caller for one transaction.
-- Only the service role can reach them. They now mark the session as a server
-- session, so a job for a client that requires multi-factor sign-in still runs:
-- there is no person present to prompt. Bodies are otherwise unchanged.
CREATE OR REPLACE FUNCTION ops.assume_user(p_user_id uuid, p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'tenancy', 'pg_temp'
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'This job needs a client' USING ERRCODE = '22023';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'This job has no owner to run as. Queue it from a schedule or from the Jobs page.' USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'server_session', TRUE)::text,
        TRUE
    );

    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;

    IF v_clients IS NULL OR NOT (p_client_id = ANY (v_clients)) THEN
        RAISE EXCEPTION 'The person who scheduled this job no longer belongs to this client' USING ERRCODE = '42501';
    END IF;
    IF cardinality(v_clients) > 1 THEN
        RAISE EXCEPTION 'The person who scheduled this job belongs to more than one client. This job needs an owner with one client, so its results stay with that client.'
            USING ERRCODE = '42501';
    END IF;
    IF NOT tenancy.has_permission(p_client_id, 'entity.read') THEN
        RAISE EXCEPTION 'The person who scheduled this job can no longer read this client''s records' USING ERRCODE = '42501';
    END IF;
END;
$$
;

CREATE OR REPLACE FUNCTION public.workflow_worker_member(p_user_id uuid, p_client_id uuid, p_permission text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'tenancy', 'pg_temp'
AS $$
DECLARE
    v_clients UUID[];
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 'This step has no person to run as.';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'server_session', TRUE)::text, TRUE);

    SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
    IF v_clients IS NULL OR NOT (p_client_id = ANY (v_clients)) THEN
        RETURN 'The person this step runs as no longer belongs to this client.';
    END IF;
    IF cardinality(v_clients) > 1 THEN
        RETURN 'The person this step runs as belongs to more than one client. A workflow step needs a person with one client, so what it reads stays with that client.';
    END IF;
    IF NOT tenancy.has_permission(p_client_id, p_permission) THEN
        RETURN 'The person this step runs as does not hold ' || p_permission || ' for this client.';
    END IF;
    RETURN NULL;
END;
$$
;

CREATE OR REPLACE FUNCTION public.workflow_worker_person(p_user_id uuid, p_client_id uuid, p_permissions text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'tenancy', 'pg_temp'
AS $$
DECLARE
    v_name TEXT;
    v_permission TEXT;
    v_admin BOOLEAN;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('problem', 'This step has no person behind it. Start the run from the app, or from a schedule someone owns.');
    END IF;
    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'server_session', TRUE)::text, TRUE);

    SELECT display_name INTO v_name FROM tenancy.profiles WHERE id = p_user_id AND is_active;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('problem', 'The person behind this step is no longer an active user.');
    END IF;

    v_admin := tenancy.is_tenant_admin();
    IF NOT v_admin THEN
        IF NOT (p_client_id IN (SELECT tenancy.current_client_ids())) THEN
            RETURN jsonb_build_object('problem', 'The person behind this step no longer belongs to this client.');
        END IF;
        FOREACH v_permission IN ARRAY COALESCE(p_permissions, ARRAY[]::TEXT[]) LOOP
            IF NOT tenancy.has_permission(p_client_id, v_permission) THEN
                RETURN jsonb_build_object('problem', 'The person behind this step does not hold ' || v_permission || ' for this client.');
            END IF;
        END LOOP;
    END IF;
    RETURN jsonb_build_object('name', v_name, 'tenantAdmin', v_admin);
END;
$$
;

NOTIFY pgrst, 'reload schema';
