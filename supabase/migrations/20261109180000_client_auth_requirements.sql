-- Per-client authentication requirements, managed by the tenant admin.
-- A client may allow password sign-in, require an authenticator app, and
-- register its own enterprise identity provider:
--   * AZURE  Microsoft Entra ID (the shared multi-tenant app, limited to one directory)
--   * SAML   SAML 2.0 (Okta, Entra, ADFS, Ping, Google Workspace, and others)
--   * OIDC   OpenID Connect
-- Email domains decide which client's rules apply at sign-in.

CREATE TABLE tenancy.client_auth_requirements (
    client_id UUID PRIMARY KEY REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    password_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
    email_domains TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id)
);

COMMENT ON TABLE tenancy.client_auth_requirements IS
    'Sign-in rules for one client. Email domains route people to these rules. Tenant admins write the row; the access-token hook and the app both enforce it.';

CREATE INDEX idx_client_auth_email_domains ON tenancy.client_auth_requirements USING GIN (email_domains);

ALTER TABLE tenancy.client_identity_providers
    ADD COLUMN display_name TEXT,
    ADD COLUMN saml_metadata_url TEXT,
    ADD COLUMN saml_metadata_xml TEXT,
    ADD COLUMN oidc_issuer TEXT,
    ADD COLUMN oidc_client_id TEXT,
    ADD COLUMN oidc_identifier TEXT,
    ADD COLUMN sso_provider_id UUID,
    ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN registration_error TEXT;

ALTER TABLE tenancy.client_identity_providers
    DROP CONSTRAINT IF EXISTS client_identity_providers_provider_check,
    DROP CONSTRAINT IF EXISTS client_identity_providers_check;

ALTER TABLE tenancy.client_identity_providers
    ADD CONSTRAINT client_identity_providers_provider_check
        CHECK (provider IN ('EMAIL', 'AZURE', 'SAML', 'OIDC')),
    ADD CONSTRAINT client_identity_providers_shape_check CHECK (
        (provider = 'AZURE' AND azure_tenant_id IS NOT NULL) OR
        (provider = 'EMAIL' AND email_domain IS NOT NULL) OR
        (provider = 'SAML' AND email_domain IS NOT NULL AND (saml_metadata_url IS NOT NULL OR saml_metadata_xml IS NOT NULL)) OR
        (provider = 'OIDC' AND email_domain IS NOT NULL AND oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)
    ),
    ADD CONSTRAINT client_identity_providers_registration_check
        CHECK (registration_status IN ('pending', 'active', 'error'));

UPDATE tenancy.client_identity_providers
SET email_domain = lower(email_domain)
WHERE email_domain IS NOT NULL AND email_domain <> lower(email_domain);

DROP INDEX IF EXISTS tenancy.idx_cip_email_domain;
CREATE UNIQUE INDEX idx_cip_email_domain
    ON tenancy.client_identity_providers (email_domain)
    WHERE email_domain IS NOT NULL;
CREATE UNIQUE INDEX idx_cip_oidc_identifier
    ON tenancy.client_identity_providers (oidc_identifier)
    WHERE oidc_identifier IS NOT NULL;

COMMENT ON TABLE tenancy.client_identity_providers IS
    'A client identity provider. AZURE is Microsoft Entra ID via the shared multi-tenant app. SAML is SAML 2.0 and OIDC is OpenID Connect; both are registered with the Auth server and addressed by email domain. The OIDC client secret is never stored here.';

-- ------------------------------------------------------------
-- Keep a domain on exactly one client
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.sync_auth_domain()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_domain TEXT;
BEGIN
    IF TG_TABLE_NAME = 'client_auth_requirements' THEN
        NEW.email_domains := ARRAY(
            SELECT DISTINCT lower(btrim(d))
            FROM unnest(COALESCE(NEW.email_domains, '{}')) AS d
            WHERE btrim(d) <> ''
            ORDER BY 1
        );
        FOREACH v_domain IN ARRAY NEW.email_domains LOOP
            IF EXISTS (
                SELECT 1 FROM tenancy.client_auth_requirements
                WHERE v_domain = ANY (email_domains) AND client_id <> NEW.client_id
            ) OR EXISTS (
                SELECT 1 FROM tenancy.client_identity_providers
                WHERE email_domain = v_domain AND client_id <> NEW.client_id
            ) THEN
                RAISE EXCEPTION 'Email domain % is already assigned to another client', v_domain;
            END IF;
        END LOOP;
        RETURN NEW;
    END IF;

    NEW.email_domain := NULLIF(lower(btrim(COALESCE(NEW.email_domain, ''))), '');
    IF NEW.email_domain IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1 FROM tenancy.client_identity_providers
        WHERE email_domain = NEW.email_domain AND id IS DISTINCT FROM NEW.id
    ) OR EXISTS (
        SELECT 1 FROM tenancy.client_auth_requirements
        WHERE NEW.email_domain = ANY (email_domains) AND client_id <> NEW.client_id
    ) THEN
        RAISE EXCEPTION 'Email domain % is already assigned to another client', NEW.email_domain;
    END IF;

    INSERT INTO tenancy.client_auth_requirements (client_id, email_domains)
    VALUES (NEW.client_id, ARRAY[NEW.email_domain])
    ON CONFLICT (client_id) DO UPDATE
        SET email_domains = (
            SELECT ARRAY(
                SELECT DISTINCT d
                FROM unnest(tenancy.client_auth_requirements.email_domains || EXCLUDED.email_domains) AS d
                ORDER BY 1
            )
        );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_auth_requirements_domain
    BEFORE INSERT OR UPDATE ON tenancy.client_auth_requirements
    FOR EACH ROW EXECUTE FUNCTION tenancy.sync_auth_domain();

CREATE TRIGGER trg_client_identity_provider_domain
    BEFORE INSERT OR UPDATE OF email_domain, client_id ON tenancy.client_identity_providers
    FOR EACH ROW EXECUTE FUNCTION tenancy.sync_auth_domain();

CREATE TRIGGER trg_client_auth_requirements_updated_at
    BEFORE UPDATE ON tenancy.client_auth_requirements
    FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

CREATE OR REPLACE FUNCTION tenancy.seed_client_auth_requirements()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    INSERT INTO tenancy.client_auth_requirements (client_id)
    VALUES (NEW.id)
    ON CONFLICT (client_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_seed_auth_requirements
    AFTER INSERT ON tenancy.clients
    FOR EACH ROW EXECUTE FUNCTION tenancy.seed_client_auth_requirements();

INSERT INTO tenancy.client_auth_requirements (client_id, email_domains)
SELECT c.id,
       COALESCE((
           SELECT ARRAY(SELECT DISTINCT p.email_domain FROM tenancy.client_identity_providers p WHERE p.client_id = c.id AND p.email_domain IS NOT NULL ORDER BY 1)
       ), '{}')
FROM tenancy.clients c
ON CONFLICT (client_id) DO NOTHING;

-- ------------------------------------------------------------
-- Which sign-in methods an email domain may use.
-- Granted to service_role only. The login page calls it through the server.
-- The payload has no secrets and no client id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.discover_sign_in(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_domain TEXT;
    v_client_id UUID;
    v_name TEXT;
    v_password BOOLEAN := TRUE;
    v_mfa BOOLEAN := FALSE;
    v_methods JSONB := '[]'::JSONB;
    v_row tenancy.client_identity_providers%ROWTYPE;
BEGIN
    v_domain := lower(split_part(COALESCE(p_email, ''), '@', 2));
    IF v_domain = '' OR position('.' IN v_domain) = 0 THEN
        RETURN jsonb_build_object(
            'matched', FALSE,
            'password', TRUE,
            'mfa_required', FALSE,
            'organization', NULL,
            'message', NULL,
            'methods', jsonb_build_array(
                jsonb_build_object('protocol', 'password', 'label', 'Email and password'),
                jsonb_build_object('protocol', 'azure', 'label', 'Microsoft')
            )
        );
    END IF;

    SELECT r.client_id, c.client_name, r.password_enabled, r.mfa_required
    INTO v_client_id, v_name, v_password, v_mfa
    FROM tenancy.client_auth_requirements r
    JOIN tenancy.clients c ON c.id = r.client_id
    WHERE v_domain = ANY (r.email_domains)
    LIMIT 1;

    IF v_client_id IS NULL THEN
        SELECT p.client_id, c.client_name, COALESCE(r.password_enabled, TRUE), COALESCE(r.mfa_required, FALSE)
        INTO v_client_id, v_name, v_password, v_mfa
        FROM tenancy.client_identity_providers p
        JOIN tenancy.clients c ON c.id = p.client_id
        LEFT JOIN tenancy.client_auth_requirements r ON r.client_id = p.client_id
        WHERE p.email_domain = v_domain AND p.is_enabled
        LIMIT 1;
    END IF;

    IF v_client_id IS NULL THEN
        RETURN jsonb_build_object(
            'matched', FALSE,
            'password', TRUE,
            'mfa_required', FALSE,
            'organization', NULL,
            'message', NULL,
            'methods', jsonb_build_array(
                jsonb_build_object('protocol', 'password', 'label', 'Email and password'),
                jsonb_build_object('protocol', 'azure', 'label', 'Microsoft')
            )
        );
    END IF;

    IF v_password THEN
        v_methods := v_methods || jsonb_build_array(jsonb_build_object('protocol', 'password', 'label', 'Email and password'));
    END IF;

    FOR v_row IN
        SELECT * FROM tenancy.client_identity_providers
        WHERE client_id = v_client_id AND is_enabled
        ORDER BY provider, display_name
    LOOP
        IF v_row.provider = 'AZURE' THEN
            v_methods := v_methods || jsonb_build_array(jsonb_build_object(
                'protocol', 'azure',
                'label', COALESCE(v_row.display_name, 'Microsoft Entra ID'),
                'domain', COALESCE(v_row.email_domain, v_domain)
            ));
        ELSIF v_row.provider = 'SAML' AND v_row.registration_status = 'active' AND v_row.sso_provider_id IS NOT NULL THEN
            v_methods := v_methods || jsonb_build_array(jsonb_build_object(
                'protocol', 'saml',
                'label', COALESCE(v_row.display_name, 'SAML 2.0'),
                'domain', v_row.email_domain
            ));
        ELSIF v_row.provider = 'OIDC' AND v_row.registration_status = 'active' AND v_row.oidc_identifier IS NOT NULL THEN
            v_methods := v_methods || jsonb_build_array(jsonb_build_object(
                'protocol', 'oidc',
                'label', COALESCE(v_row.display_name, 'OpenID Connect'),
                'domain', v_row.email_domain,
                'identifier', v_row.oidc_identifier
            ));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'matched', TRUE,
        'password', v_password,
        'mfa_required', v_mfa,
        'organization', v_name,
        'message', CASE
            WHEN jsonb_array_length(v_methods) = 0 THEN 'Sign-in for this organization is not finished. Ask your administrator.'
            ELSE NULL
        END,
        'methods', v_methods
    );
END;
$$;

COMMENT ON FUNCTION tenancy.discover_sign_in(TEXT) IS
    'Public sign-in options for an email domain: password, Microsoft Entra ID, SAML 2.0, or OpenID Connect. No secrets and no client id.';

-- ------------------------------------------------------------
-- Decide whether a session's sign-in method is allowed.
-- Uses the Auth server's app_metadata and amr claims, never user-editable metadata.
-- Tenant admins are exempt so they can repair a client that has locked itself out.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.evaluate_sign_in(
    p_user_id UUID,
    p_email TEXT,
    p_authentication_method TEXT,
    p_claims JSONB
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_domain TEXT;
    v_client_id UUID;
    v_password BOOLEAN := TRUE;
    v_mfa_required BOOLEAN := FALSE;
    v_method TEXT := replace(COALESCE(p_authentication_method, ''), '"', '');
    v_provider TEXT := COALESCE(p_claims->'app_metadata'->>'provider', '');
    v_protocol TEXT;
    v_sso_id TEXT;
    v_aal TEXT := COALESCE(p_claims->>'aal', 'aal1');
    v_mfa_satisfied BOOLEAN;
    v_tenant_admin BOOLEAN := FALSE;
    v_allowed BOOLEAN := TRUE;
    v_reason TEXT := NULL;
BEGIN
    IF p_user_id IS NOT NULL THEN
        SELECT COALESCE(is_tenant_admin, FALSE) INTO v_tenant_admin
        FROM tenancy.profiles WHERE id = p_user_id;
    END IF;

    v_mfa_satisfied := v_aal IN ('aal2', 'aal3')
        OR v_method = 'totp'
        OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(p_claims->'amr', '[]'::JSONB)) elem
            WHERE elem->>'method' = 'totp'
        );

    v_domain := lower(split_part(COALESCE(p_email, ''), '@', 2));
    IF v_tenant_admin OR v_domain = '' THEN
        RETURN jsonb_build_object(
            'allowed', TRUE,
            'reason', NULL,
            'mfa_required', FALSE,
            'mfa_satisfied', TRUE,
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
            'mfa_required', FALSE,
            'mfa_satisfied', TRUE,
            'matched', FALSE
        );
    END IF;

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

CREATE OR REPLACE FUNCTION tenancy.current_sign_in_decision()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('allowed', FALSE, 'reason', 'Not signed in', 'mfa_required', FALSE, 'mfa_satisfied', FALSE, 'matched', FALSE);
    END IF;
    RETURN tenancy.evaluate_sign_in(auth.uid(), COALESCE(auth.jwt()->>'email', ''), '', COALESCE(auth.jwt(), '{}'::JSONB));
END;
$$;

COMMENT ON FUNCTION tenancy.current_sign_in_decision() IS
    'Whether the caller''s current session satisfies their email domain''s authentication rules, including authenticator MFA.';

-- Reject a token when the client disallows the method. MFA still receives an
-- aal1 token so the person can enroll; the app then requires the step-up.
-- A failure inside the hook allows the token so a defect cannot lock everyone out.
-- An explicit policy denial is returned to the Auth server as HTTP 403.
CREATE OR REPLACE FUNCTION tenancy.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_decision JSONB;
    v_user_id UUID;
BEGIN
    IF event->'claims' IS NULL THEN
        RETURN event;
    END IF;
    BEGIN
        v_user_id := NULLIF(event->>'user_id', '')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        v_user_id := NULL;
    END;
    v_decision := tenancy.evaluate_sign_in(
        v_user_id,
        event->'claims'->>'email',
        COALESCE(event->>'authentication_method', ''),
        event->'claims'
    );
    IF COALESCE((v_decision->>'allowed')::BOOLEAN, TRUE) IS FALSE THEN
        RETURN jsonb_build_object(
            'error', jsonb_build_object(
                'http_code', 403,
                'message', COALESCE(v_decision->>'reason', 'This sign-in method is not allowed for this organization.')
            )
        );
    END IF;
    RETURN jsonb_build_object('claims', event->'claims');
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tenancy.custom_access_token_hook failed open: %', SQLERRM;
    RETURN jsonb_build_object('claims', event->'claims');
END;
$$;

COMMENT ON FUNCTION tenancy.custom_access_token_hook(JSONB) IS
    'Auth access-token hook. Refuses a session whose method is not allowed for the email domain''s client. Enable it with [auth.hook.custom_access_token] uri = pg-functions://postgres/tenancy/custom_access_token_hook.';

REVOKE ALL ON FUNCTION tenancy.discover_sign_in(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.evaluate_sign_in(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.custom_access_token_hook(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tenancy.current_sign_in_decision() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION tenancy.discover_sign_in(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION tenancy.current_sign_in_decision() TO authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT USAGE ON SCHEMA tenancy TO supabase_auth_admin;
        GRANT EXECUTE ON FUNCTION tenancy.custom_access_token_hook(JSONB) TO supabase_auth_admin;
    END IF;
END $$;

-- ------------------------------------------------------------
-- First login joins the client by Azure tenant id, then by any configured domain
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

    v_azure_tid := NEW.raw_user_meta_data->>'tid';
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

    IF v_client_id IS NULL AND NEW.email IS NOT NULL THEN
        v_domain := lower(split_part(NEW.email, '@', 2));
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
    RAISE WARNING 'tenancy.handle_new_auth_user failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenancy.handle_new_auth_user IS
    'Creates a profile and joins the user to a client as VIEWER when the Azure AD tid claim or email domain matches that client''s authentication configuration.';

-- ------------------------------------------------------------
-- RLS. Same shape as the identity-provider policies: members can read,
-- only a tenant admin can change how a client signs in.
-- ------------------------------------------------------------
ALTER TABLE tenancy.client_auth_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth requirements visible to co-members or tenant admins"
    ON tenancy.client_auth_requirements
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR client_id IN (SELECT tenancy.current_client_ids()));

CREATE POLICY "Auth requirements writable by tenant admins"
    ON tenancy.client_auth_requirements
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());
