-- Stand-ins for what a Supabase project provides before the first migration:
-- roles, auth, storage, vault and the extensions schema. Enough for the
-- migrations to apply on plain Postgres (with pgvector); not a Supabase emulator.
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin',
                             'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user',
                             'pgsodium_keyiduser', 'supabase_realtime_admin'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END $$;
ALTER ROLE service_role BYPASSRLS;
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS graphql_public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(), email TEXT,
    raw_user_meta_data JSONB DEFAULT '{}', raw_app_meta_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
    email_confirmed_at TIMESTAMPTZ, last_sign_in_at TIMESTAMPTZ, phone TEXT, role TEXT, aud TEXT,
    instance_id UUID, encrypted_password TEXT, is_super_admin BOOLEAN, deleted_at TIMESTAMPTZ,
    banned_until TIMESTAMPTZ, is_anonymous BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS auth.identities (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(), user_id UUID, provider TEXT,
    identity_data JSONB, provider_id TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, last_sign_in_at TIMESTAMPTZ
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', TRUE), '')::UUID $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', TRUE), '') $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.email', TRUE), '') $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), ''), '{}')::JSONB $$;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id TEXT PRIMARY KEY, name TEXT, public BOOLEAN, owner UUID, created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(), file_size_limit BIGINT, allowed_mime_types TEXT[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(), bucket_id TEXT, name TEXT, owner UUID,
    metadata JSONB, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), path_tokens TEXT[]
);
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;

-- Vault keeps the secret in plain text here. Never point this at real credentials.
CREATE TABLE IF NOT EXISTS vault.secrets (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(), name TEXT, description TEXT, secret TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT s.*, s.secret AS decrypted_secret FROM vault.secrets s;
CREATE OR REPLACE FUNCTION vault.create_secret(new_secret TEXT, new_name TEXT DEFAULT NULL, new_description TEXT DEFAULT '')
RETURNS UUID LANGUAGE sql AS $$ INSERT INTO vault.secrets (secret, name, description) VALUES (new_secret, new_name, new_description) RETURNING id $$;
CREATE OR REPLACE FUNCTION vault.update_secret(secret_id UUID, new_secret TEXT DEFAULT NULL, new_name TEXT DEFAULT NULL, new_description TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE vault.secrets SET secret = COALESCE(new_secret, secret), name = COALESCE(new_name, name),
           description = COALESCE(new_description, description), updated_at = now()
    WHERE id = secret_id
$$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version TEXT PRIMARY KEY, statements TEXT[], name TEXT);
