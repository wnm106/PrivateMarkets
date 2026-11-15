-- Feeds: files that arrive on their own and load through a saved map.
--
-- A connection is a place files come from. A feed is one kind of file from that
-- place, tied to the saved map that loads it. Every file a feed sees is written
-- to a ledger keyed by its content hash, so the same file is never loaded twice.
--
--   ops.connections     where files come from (client scoped)
--   ops.feeds           one recurring file: connection, path, saved map, timetable
--   ops.received_files  one row per distinct file content per feed
--
-- Connection kinds:
--   STORAGE  a folder in the private feed-inbox bucket. The path is always under
--            the client's own folder, so one client cannot read another's files.
--   HTTP     an https address the worker downloads from.
--
-- A connection's secret (token or password) is kept in Supabase Vault. It is
-- written through feed_connection_save and read only by feed_poll_context,
-- which only the service role may run. No function returns it to a user.
--
-- These replace entity_instances.data_connections and data_loaders, which kept
-- credentials as plain JSON and were not client scoped.

INSERT INTO storage.buckets (id, name, public)
VALUES ('feed-inbox', 'feed-inbox', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ops.connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    connection_code VARCHAR(100) NOT NULL,
    connection_name VARCHAR(200) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('STORAGE', 'HTTP')),
    -- Never holds a secret. STORAGE: {"folder": "admin"}. HTTP: {"baseUrl", "authType", "headerName", "username"}.
    config JSONB NOT NULL DEFAULT '{}',
    secret_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at TIMESTAMPTZ,
    last_check_ok BOOLEAN,
    last_check_message TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, connection_code)
);

CREATE TABLE IF NOT EXISTS ops.feeds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES ops.connections(id) ON DELETE CASCADE,
    feed_code VARCHAR(100) NOT NULL,
    feed_name VARCHAR(200) NOT NULL,
    -- STORAGE: a subfolder. HTTP: the address after the base URL. {YYYY} {MM} {DD} become the run date.
    path TEXT NOT NULL DEFAULT '',
    -- STORAGE only: which file names to take, for example NAV_*.xlsx.
    file_pattern VARCHAR(200) NOT NULL DEFAULT '*',
    map_code VARCHAR(100) NOT NULL,
    source_code VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- The job schedule that polls this feed. NULL when the feed is only polled on request.
    schedule_id UUID REFERENCES ops.job_schedules(id) ON DELETE SET NULL,
    -- When a file is expected. A feed with no file by this time plus the grace period is late.
    expected_cron VARCHAR(100),
    expected_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    grace_minutes INTEGER NOT NULL DEFAULT 120 CHECK (grace_minutes BETWEEN 0 AND 10080),
    last_polled_at TIMESTAMPTZ,
    last_received_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, feed_code)
);

CREATE INDEX IF NOT EXISTS feeds_connection ON ops.feeds (connection_id);

CREATE TABLE IF NOT EXISTS ops.received_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    feed_id UUID NOT NULL REFERENCES ops.feeds(id) ON DELETE CASCADE,
    file_name VARCHAR(500) NOT NULL,
    remote_ref TEXT,
    size_bytes BIGINT,
    sha256 CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'LOADING'
        CHECK (status IN ('LOADING', 'LOADED', 'NEEDS_REVIEW', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 1,
    import_instance_id UUID,
    job_run_id UUID,
    rows_created INTEGER,
    rows_matched INTEGER,
    message TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    UNIQUE (feed_id, sha256)
);

CREATE INDEX IF NOT EXISTS received_files_client_received ON ops.received_files (client_id, received_at DESC);

ALTER TABLE ops.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.received_files ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.received_files IS
    'One row per distinct file content per feed. LOADED and NEEDS_REVIEW are final. FAILED is tried again on the next poll, three times in all.';

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('feed.manage', 'Create and change connections and feeds, including stored credentials')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'feed.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ops.can_manage_feeds(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT p_client_id IS NOT NULL
       AND (ops.is_service_role() OR tenancy.has_permission(p_client_id, 'feed.manage'));
$$;

-- A connection as a user may see it: no secret, only whether one is stored.
CREATE OR REPLACE FUNCTION ops.connection_json(p_row ops.connections)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
    SELECT (to_jsonb(p_row) - 'secret_id') || jsonb_build_object('has_secret', p_row.secret_id IS NOT NULL);
$$;

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feed_connections_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.connection_json(c)
    FROM ops.connections AS c
    WHERE ops.can_see(c.client_id)
    ORDER BY c.connection_name;
$$;

-- p_secret NULL keeps the stored secret. An empty string removes it.
CREATE OR REPLACE FUNCTION public.feed_connection_save(
    p_id UUID,
    p_client_id UUID,
    p_connection_code TEXT,
    p_connection_name TEXT,
    p_kind TEXT,
    p_config JSONB,
    p_secret TEXT,
    p_is_active BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, vault, pg_temp
AS $$
DECLARE
    v_row ops.connections;
    v_secret_id UUID;
BEGIN
    IF NULLIF(btrim(COALESCE(p_connection_code, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_connection_name, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A code and a name are required' USING ERRCODE = '22023';
    END IF;
    IF p_kind IS NULL OR p_kind NOT IN ('STORAGE', 'HTTP') THEN
        RAISE EXCEPTION 'The connection kind must be STORAGE or HTTP' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        IF NOT ops.can_manage_feeds(p_client_id) THEN
            RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO ops.connections (client_id, connection_code, connection_name, kind, config, is_active, created_by)
        VALUES (
            p_client_id, btrim(p_connection_code), btrim(p_connection_name), p_kind,
            COALESCE(p_config, '{}'::jsonb), COALESCE(p_is_active, TRUE), auth.uid()
        )
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ops.connections WHERE id = p_id;
        IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
            RAISE EXCEPTION 'Connection was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT ops.can_manage_feeds(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
        END IF;
        UPDATE ops.connections
           SET connection_code = btrim(p_connection_code),
               connection_name = btrim(p_connection_name),
               kind = p_kind,
               config = COALESCE(p_config, '{}'::jsonb),
               is_active = COALESCE(p_is_active, TRUE),
               -- A changed address or sign-in has not been checked yet.
               last_checked_at = NULL, last_check_ok = NULL, last_check_message = NULL,
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    IF p_secret IS NOT NULL THEN
        IF p_secret = '' THEN
            IF v_row.secret_id IS NOT NULL THEN
                DELETE FROM vault.secrets WHERE id = v_row.secret_id;
                UPDATE ops.connections SET secret_id = NULL WHERE id = v_row.id RETURNING * INTO v_row;
            END IF;
        ELSIF v_row.secret_id IS NOT NULL THEN
            PERFORM vault.update_secret(v_row.secret_id, p_secret);
        ELSE
            v_secret_id := vault.create_secret(p_secret, 'feed-connection-' || v_row.id::text, 'Feed connection credential');
            UPDATE ops.connections SET secret_id = v_secret_id WHERE id = v_row.id RETURNING * INTO v_row;
        END IF;
    END IF;

    RETURN ops.connection_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.feed_connection_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, vault, pg_temp
AS $$
DECLARE
    v_row ops.connections;
BEGIN
    SELECT * INTO v_row FROM ops.connections WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage_feeds(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM ops.feeds WHERE connection_id = p_id) THEN
        RAISE EXCEPTION 'Delete the feeds that use this connection first' USING ERRCODE = '23503';
    END IF;
    DELETE FROM ops.connections WHERE id = p_id;
    IF v_row.secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_row.secret_id;
    END IF;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Feeds
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.feed_json(p_row ops.feeds)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT to_jsonb(p_row) || jsonb_build_object(
        'connection_name', c.connection_name,
        'connection_kind', c.kind,
        'poll_cron', s.cron_expression,
        'poll_timezone', s.timezone,
        'poll_active', s.is_active,
        'next_poll_at', s.next_run_at,
        'last', (
            SELECT jsonb_build_object('file_name', f.file_name, 'status', f.status, 'received_at', f.received_at, 'message', f.message)
            FROM ops.received_files AS f
            WHERE f.feed_id = p_row.id
            ORDER BY f.last_seen_at DESC
            LIMIT 1
        )
    )
    FROM ops.connections AS c
    LEFT JOIN ops.job_schedules AS s ON s.id = p_row.schedule_id
    WHERE c.id = p_row.connection_id;
$$;

CREATE OR REPLACE FUNCTION public.feeds_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.feed_json(f)
    FROM ops.feeds AS f
    WHERE ops.can_see(f.client_id)
    ORDER BY f.feed_name;
$$;

CREATE OR REPLACE FUNCTION public.feed_save(
    p_id UUID,
    p_connection_id UUID,
    p_feed_code TEXT,
    p_feed_name TEXT,
    p_path TEXT,
    p_file_pattern TEXT,
    p_map_code TEXT,
    p_source_code TEXT,
    p_is_active BOOLEAN,
    p_schedule_id UUID,
    p_expected_cron TEXT,
    p_expected_timezone TEXT,
    p_grace_minutes INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_connection ops.connections;
    v_row ops.feeds;
BEGIN
    IF NULLIF(btrim(COALESCE(p_feed_code, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_feed_name, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_map_code, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A code, a name, and a saved map are required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_connection FROM ops.connections WHERE id = p_connection_id;
    IF NOT FOUND OR NOT ops.can_see(v_connection.client_id) THEN
        RAISE EXCEPTION 'Connection was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.can_manage_feeds(v_connection.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    -- The poll schedule must belong to the same client.
    IF p_schedule_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ops.job_schedules WHERE id = p_schedule_id AND client_id = v_connection.client_id
    ) THEN
        RAISE EXCEPTION 'Schedule was not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO ops.feeds (
            client_id, connection_id, feed_code, feed_name, path, file_pattern, map_code, source_code,
            is_active, schedule_id, expected_cron, expected_timezone, grace_minutes, created_by
        ) VALUES (
            v_connection.client_id, v_connection.id, btrim(p_feed_code), btrim(p_feed_name),
            btrim(COALESCE(p_path, '')), COALESCE(NULLIF(btrim(COALESCE(p_file_pattern, '')), ''), '*'),
            btrim(p_map_code), NULLIF(btrim(COALESCE(p_source_code, '')), ''),
            COALESCE(p_is_active, TRUE), p_schedule_id,
            NULLIF(btrim(COALESCE(p_expected_cron, '')), ''),
            COALESCE(NULLIF(btrim(COALESCE(p_expected_timezone, '')), ''), 'UTC'),
            COALESCE(p_grace_minutes, 120), auth.uid()
        )
        RETURNING * INTO v_row;
    ELSE
        UPDATE ops.feeds
           SET connection_id = v_connection.id,
               feed_code = btrim(p_feed_code),
               feed_name = btrim(p_feed_name),
               path = btrim(COALESCE(p_path, '')),
               file_pattern = COALESCE(NULLIF(btrim(COALESCE(p_file_pattern, '')), ''), '*'),
               map_code = btrim(p_map_code),
               source_code = NULLIF(btrim(COALESCE(p_source_code, '')), ''),
               is_active = COALESCE(p_is_active, TRUE),
               schedule_id = p_schedule_id,
               expected_cron = NULLIF(btrim(COALESCE(p_expected_cron, '')), ''),
               expected_timezone = COALESCE(NULLIF(btrim(COALESCE(p_expected_timezone, '')), ''), 'UTC'),
               grace_minutes = COALESCE(p_grace_minutes, 120),
               updated_at = NOW()
         WHERE id = p_id AND client_id = v_connection.client_id
        RETURNING * INTO v_row;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Feed was not found' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    RETURN ops.feed_json(v_row);
END;
$$;

-- Deletes the feed and the schedule that polls it. The file history goes with it.
CREATE OR REPLACE FUNCTION public.feed_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.feeds;
BEGIN
    SELECT * INTO v_row FROM ops.feeds WHERE id = p_id;
    IF NOT FOUND OR NOT ops.can_see(v_row.client_id) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage_feeds(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage feeds for this client' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.feeds WHERE id = p_id;
    IF v_row.schedule_id IS NOT NULL THEN
        DELETE FROM ops.job_schedules WHERE id = v_row.schedule_id;
    END IF;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.feed_received_files_list(
    p_feed_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(f) || jsonb_build_object(
        'feed_name', (SELECT feed_name FROM ops.feeds WHERE id = f.feed_id)
    )
    FROM ops.received_files AS f
    WHERE ops.can_see(f.client_id)
      AND (p_feed_id IS NULL OR f.feed_id = p_feed_id)
    ORDER BY f.last_seen_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (service_role only)
-- ---------------------------------------------------------------------------

-- Everything a poll needs, including the connection's secret.
CREATE OR REPLACE FUNCTION public.feed_poll_context(p_feed_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, vault, pg_temp
AS $$
    SELECT jsonb_build_object(
        'feed', to_jsonb(f),
        'connection', to_jsonb(c) - 'secret_id',
        'secret', (SELECT s.decrypted_secret FROM vault.decrypted_secrets AS s WHERE s.id = c.secret_id)
    )
    FROM ops.feeds AS f
    JOIN ops.connections AS c ON c.id = f.connection_id
    WHERE f.id = p_feed_id;
$$;

-- Same, for checking a connection that has no feed yet.
CREATE OR REPLACE FUNCTION public.feed_connection_context(p_connection_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, vault, pg_temp
AS $$
    SELECT jsonb_build_object(
        'connection', to_jsonb(c) - 'secret_id',
        'secret', (SELECT s.decrypted_secret FROM vault.decrypted_secrets AS s WHERE s.id = c.secret_id)
    )
    FROM ops.connections AS c
    WHERE c.id = p_connection_id;
$$;

CREATE OR REPLACE FUNCTION public.feed_connection_checked(p_connection_id UUID, p_ok BOOLEAN, p_message TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    UPDATE ops.connections
       SET last_checked_at = NOW(), last_check_ok = p_ok, last_check_message = left(p_message, 1000)
     WHERE id = p_connection_id;
$$;

-- Registers a file the poll found. Returns its ledger id and what to do:
--   LOAD  new content, or content that failed before and has attempts left
--   SKIP  already loaded, already waiting for review, or out of attempts
CREATE OR REPLACE FUNCTION public.feed_file_begin(
    p_feed_id UUID,
    p_file_name TEXT,
    p_remote_ref TEXT,
    p_size_bytes BIGINT,
    p_sha256 TEXT,
    p_job_run_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_feed ops.feeds;
    v_row ops.received_files;
    v_fresh BOOLEAN;
BEGIN
    SELECT * INTO v_feed FROM ops.feeds WHERE id = p_feed_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Feed was not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO ops.received_files (client_id, feed_id, file_name, remote_ref, size_bytes, sha256, job_run_id)
    VALUES (v_feed.client_id, v_feed.id, left(p_file_name, 500), p_remote_ref, p_size_bytes, lower(p_sha256), p_job_run_id)
    ON CONFLICT (feed_id, sha256) DO NOTHING
    RETURNING * INTO v_row;
    v_fresh := FOUND;

    IF NOT v_fresh THEN
        -- Locks the row, so two polls cannot both decide to load the same content.
        UPDATE ops.received_files
           SET last_seen_at = NOW()
         WHERE feed_id = p_feed_id AND sha256 = lower(p_sha256)
        RETURNING * INTO v_row;

        IF v_row.status = 'FAILED' AND v_row.attempts < 3 THEN
            UPDATE ops.received_files
               SET status = 'LOADING', attempts = attempts + 1, job_run_id = p_job_run_id,
                   message = NULL, finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
            v_fresh := TRUE;
        ELSIF v_row.status = 'LOADING'
              AND v_row.received_at < NOW() - INTERVAL '30 minutes'
              AND v_row.job_run_id IS DISTINCT FROM p_job_run_id AND v_row.attempts < 3 THEN
            -- An earlier poll died while loading this file.
            UPDATE ops.received_files
               SET attempts = attempts + 1, job_run_id = p_job_run_id, received_at = NOW()
             WHERE id = v_row.id
            RETURNING * INTO v_row;
            v_fresh := TRUE;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'id', v_row.id,
        'action', CASE WHEN v_fresh THEN 'LOAD' ELSE 'SKIP' END,
        'status', v_row.status,
        'attempts', v_row.attempts
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feed_file_finish(
    p_id UUID,
    p_status TEXT,
    p_import_instance_id UUID DEFAULT NULL,
    p_rows_created INTEGER DEFAULT NULL,
    p_rows_matched INTEGER DEFAULT NULL,
    p_message TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_feed_id UUID;
BEGIN
    IF p_status NOT IN ('LOADED', 'NEEDS_REVIEW', 'FAILED') THEN
        RAISE EXCEPTION 'A file finishes as LOADED, NEEDS_REVIEW, or FAILED' USING ERRCODE = '22023';
    END IF;
    UPDATE ops.received_files
       SET status = p_status,
           import_instance_id = COALESCE(p_import_instance_id, import_instance_id),
           rows_created = p_rows_created,
           rows_matched = p_rows_matched,
           message = left(p_message, 2000),
           finished_at = NOW()
     WHERE id = p_id
    RETURNING feed_id INTO v_feed_id;

    -- A file that arrived counts as received even when it needs a person to look at it.
    IF v_feed_id IS NOT NULL AND p_status IN ('LOADED', 'NEEDS_REVIEW') THEN
        UPDATE ops.feeds SET last_received_at = NOW() WHERE id = v_feed_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.feed_polled(p_feed_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    UPDATE ops.feeds SET last_polled_at = NOW() WHERE id = p_feed_id;
$$;

-- Active feeds of a client that expect a file on a timetable.
CREATE OR REPLACE FUNCTION public.feed_expectations(p_client_id UUID)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', f.id, 'feed_code', f.feed_code, 'feed_name', f.feed_name,
        'expected_cron', f.expected_cron, 'expected_timezone', f.expected_timezone,
        'grace_minutes', f.grace_minutes, 'last_received_at', f.last_received_at, 'created_at', f.created_at
    )
    FROM ops.feeds AS f
    WHERE f.client_id = p_client_id AND f.is_active AND f.expected_cron IS NOT NULL
    ORDER BY f.feed_name;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.can_manage_feeds(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.connection_json(ops.connections) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.feed_json(ops.feeds) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.feed_poll_context(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_connection_context(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_connection_checked(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_file_begin(UUID, TEXT, TEXT, BIGINT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_file_finish(UUID, TEXT, UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_polled(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_expectations(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_poll_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_connection_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_connection_checked(UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_file_begin(UUID, TEXT, TEXT, BIGINT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_file_finish(UUID, TEXT, UUID, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_polled(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_expectations(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.feed_connections_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feed_connection_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feed_connection_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feeds_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feed_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feed_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feed_received_files_list(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feed_connections_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_connection_save(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_connection_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feeds_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID, TEXT, TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_received_files_list(UUID, INTEGER) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
