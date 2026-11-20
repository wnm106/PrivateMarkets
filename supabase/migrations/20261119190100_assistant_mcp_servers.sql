-- Assistant connections: a client's own MCP servers, and the identifiers that
-- tie a Tapestry record to the same record in another system.
--
--   ops.assistant_mcp_servers         an MCP server the client lets the chat
--                                     assistant call (client scoped)
--   entity_instances.entity_external_ids
--                                     a record's id in another system, keyed
--                                     by the source (source_registry)
--
-- A server may name the source it reaches (source_id). The same source keys
-- the crosswalk and the golden-source waterfall, so the assistant can tell
-- which system a value came from, which id that system knows the record by,
-- and which server to ask.
--
-- A server's credential is kept in Supabase Vault. It is written through
-- assistant_mcp_server_save and read only by the service-role functions at the
-- bottom of this file. No function returns it to a user.
--
-- Tools are offered to the assistant only once an administrator turns them on
-- (enabled_tools). A connection check records the tools the server lists
-- (discovered_tools), so the chat route never has to reach the server just to
-- build its tool list. write_tools are tools that change data in the other
-- system; the assistant must have the user's confirmation before calling one.

CREATE TABLE IF NOT EXISTS ops.assistant_mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    server_code VARCHAR(40) NOT NULL CHECK (server_code ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
    server_name VARCHAR(200) NOT NULL,
    url TEXT NOT NULL,
    auth_type VARCHAR(20) NOT NULL DEFAULT 'NONE' CHECK (auth_type IN ('NONE', 'BEARER', 'HEADER')),
    -- HEADER only: the header the secret is sent in, for example X-Api-Key.
    header_name VARCHAR(100),
    secret_id UUID,
    -- The system this server reaches. NULL for a server that is not a data source.
    source_id UUID REFERENCES entity_instances.source_registry(id) ON DELETE SET NULL,
    -- What the server is for, in the administrator's words. Shown to the assistant.
    instructions TEXT NOT NULL DEFAULT '',
    -- Which identifiers the server accepts: [{"identifier": "LEI", "argument": "lei", "tool": "get_company", "note": "..."}]
    identifier_hints JSONB NOT NULL DEFAULT '[]',
    -- Tools as the server last listed them: [{"name", "description", "inputSchema", "readOnly", "destructive"}]
    discovered_tools JSONB NOT NULL DEFAULT '[]',
    enabled_tools TEXT[] NOT NULL DEFAULT '{}',
    write_tools TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at TIMESTAMPTZ,
    last_check_ok BOOLEAN,
    last_check_message TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, server_code),
    CHECK (jsonb_typeof(identifier_hints) = 'array'),
    CHECK (jsonb_typeof(discovered_tools) = 'array'),
    CHECK (auth_type <> 'HEADER' OR NULLIF(btrim(COALESCE(header_name, '')), '') IS NOT NULL)
);

ALTER TABLE ops.assistant_mcp_servers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.assistant_mcp_servers IS
    'MCP servers a client lets the chat assistant call. Read and written only through the assistant_mcp_* functions.';

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('assistant.connections.manage', 'Connect MCP servers the assistant may call, including stored credentials')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'assistant.connections.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ops.can_manage_assistant_connections(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    -- Strictly TRUE or FALSE: a NULL here would slip past `IF NOT ...` in the callers.
    SELECT COALESCE(
        p_client_id IS NOT NULL
        AND (ops.is_service_role() OR tenancy.has_permission(p_client_id, 'assistant.connections.manage')),
        FALSE
    );
$$;

-- A server as a user may see it: no secret, only whether one is stored.
CREATE OR REPLACE FUNCTION ops.assistant_mcp_server_json(p_row ops.assistant_mcp_servers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, pg_temp
AS $$
    SELECT (to_jsonb(p_row) - 'secret_id') || jsonb_build_object(
        'has_secret', p_row.secret_id IS NOT NULL,
        'source_code', s.source_code,
        'source_name', s.source_name,
        'can_manage', ops.can_manage_assistant_connections(p_row.client_id)
    )
    FROM (SELECT 1) AS one
    LEFT JOIN entity_instances.source_registry AS s ON s.id = p_row.source_id;
$$;

-- ---------------------------------------------------------------------------
-- Servers (caller-facing)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assistant_mcp_servers_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.assistant_mcp_server_json(m)
    FROM ops.assistant_mcp_servers AS m
    WHERE ops.can_see(m.client_id)
    ORDER BY m.server_name;
$$;

-- p_secret NULL keeps the stored secret. An empty string removes it.
-- p_source_code NULL or '' means the server is not tied to a source.
CREATE OR REPLACE FUNCTION public.assistant_mcp_server_save(
    p_id UUID,
    p_client_id UUID,
    p_server_code TEXT,
    p_server_name TEXT,
    p_url TEXT,
    p_auth_type TEXT,
    p_header_name TEXT,
    p_secret TEXT,
    p_source_code TEXT,
    p_instructions TEXT,
    p_identifier_hints JSONB,
    p_enabled_tools TEXT[],
    p_write_tools TEXT[],
    p_is_active BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, vault, pg_temp
AS $$
DECLARE
    v_row ops.assistant_mcp_servers;
    v_secret_id UUID;
    v_source_id UUID;
    v_url_changed BOOLEAN := FALSE;
BEGIN
    IF NULLIF(btrim(COALESCE(p_server_code, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_server_name, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_url, '')), '') IS NULL THEN
        RAISE EXCEPTION 'A code, a name and an address are required' USING ERRCODE = '22023';
    END IF;
    IF p_auth_type IS NULL OR p_auth_type NOT IN ('NONE', 'BEARER', 'HEADER') THEN
        RAISE EXCEPTION 'The sign-in must be NONE, BEARER or HEADER' USING ERRCODE = '22023';
    END IF;
    IF p_identifier_hints IS NOT NULL AND jsonb_typeof(p_identifier_hints) <> 'array' THEN
        RAISE EXCEPTION 'Identifier hints must be a list' USING ERRCODE = '22023';
    END IF;

    IF NULLIF(btrim(COALESCE(p_source_code, '')), '') IS NOT NULL THEN
        SELECT id INTO v_source_id FROM entity_instances.source_registry WHERE source_code = btrim(p_source_code);
        IF v_source_id IS NULL THEN
            RAISE EXCEPTION 'Source % was not found', p_source_code USING ERRCODE = 'P0002';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        IF NOT ops.can_manage_assistant_connections(p_client_id) THEN
            RAISE EXCEPTION 'You cannot manage assistant connections for this client' USING ERRCODE = '42501';
        END IF;
        INSERT INTO ops.assistant_mcp_servers (
            client_id, server_code, server_name, url, auth_type, header_name, source_id,
            instructions, identifier_hints, enabled_tools, write_tools, is_active, created_by
        ) VALUES (
            p_client_id, btrim(p_server_code), btrim(p_server_name), btrim(p_url), p_auth_type,
            NULLIF(btrim(COALESCE(p_header_name, '')), ''), v_source_id,
            COALESCE(p_instructions, ''), COALESCE(p_identifier_hints, '[]'::jsonb),
            COALESCE(p_enabled_tools, '{}'), COALESCE(p_write_tools, '{}'),
            COALESCE(p_is_active, TRUE), auth.uid()
        )
        RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ops.assistant_mcp_servers WHERE id = p_id;
        IF NOT FOUND OR NOT COALESCE(ops.can_see(v_row.client_id), FALSE) THEN
            RAISE EXCEPTION 'Server was not found' USING ERRCODE = 'P0002';
        END IF;
        IF NOT ops.can_manage_assistant_connections(v_row.client_id) THEN
            RAISE EXCEPTION 'You cannot manage assistant connections for this client' USING ERRCODE = '42501';
        END IF;
        v_url_changed := v_row.url IS DISTINCT FROM btrim(p_url)
            OR v_row.auth_type IS DISTINCT FROM p_auth_type
            OR v_row.header_name IS DISTINCT FROM NULLIF(btrim(COALESCE(p_header_name, '')), '')
            OR p_secret IS NOT NULL;
        UPDATE ops.assistant_mcp_servers
           SET server_code = btrim(p_server_code),
               server_name = btrim(p_server_name),
               url = btrim(p_url),
               auth_type = p_auth_type,
               header_name = NULLIF(btrim(COALESCE(p_header_name, '')), ''),
               source_id = v_source_id,
               instructions = COALESCE(p_instructions, ''),
               identifier_hints = COALESCE(p_identifier_hints, '[]'::jsonb),
               enabled_tools = COALESCE(p_enabled_tools, '{}'),
               write_tools = COALESCE(p_write_tools, '{}'),
               is_active = COALESCE(p_is_active, TRUE),
               -- A changed address or sign-in has not been checked yet.
               last_checked_at = CASE WHEN v_url_changed THEN NULL ELSE last_checked_at END,
               last_check_ok = CASE WHEN v_url_changed THEN NULL ELSE last_check_ok END,
               last_check_message = CASE WHEN v_url_changed THEN NULL ELSE last_check_message END,
               updated_at = NOW()
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    IF p_secret IS NOT NULL THEN
        IF p_secret = '' THEN
            IF v_row.secret_id IS NOT NULL THEN
                DELETE FROM vault.secrets WHERE id = v_row.secret_id;
                UPDATE ops.assistant_mcp_servers SET secret_id = NULL WHERE id = v_row.id RETURNING * INTO v_row;
            END IF;
        ELSIF v_row.secret_id IS NOT NULL THEN
            PERFORM vault.update_secret(v_row.secret_id, p_secret);
        ELSE
            v_secret_id := vault.create_secret(p_secret, 'assistant-mcp-' || v_row.id::text, 'Assistant MCP server credential');
            UPDATE ops.assistant_mcp_servers SET secret_id = v_secret_id WHERE id = v_row.id RETURNING * INTO v_row;
        END IF;
    END IF;

    RETURN ops.assistant_mcp_server_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_mcp_server_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, vault, pg_temp
AS $$
DECLARE
    v_row ops.assistant_mcp_servers;
BEGIN
    SELECT * INTO v_row FROM ops.assistant_mcp_servers WHERE id = p_id;
    IF NOT FOUND OR NOT COALESCE(ops.can_see(v_row.client_id), FALSE) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.can_manage_assistant_connections(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot manage assistant connections for this client' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.assistant_mcp_servers WHERE id = p_id;
    IF v_row.secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_row.secret_id;
    END IF;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Servers (service_role only): these return the credential.
-- ---------------------------------------------------------------------------

-- Every active server of a client, with its credential, for one chat turn.
CREATE OR REPLACE FUNCTION public.assistant_mcp_servers_runtime(p_client_id UUID)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, vault, pg_temp
AS $$
    SELECT ops.assistant_mcp_server_json(m) || jsonb_build_object(
        'secret', (SELECT s.decrypted_secret FROM vault.decrypted_secrets AS s WHERE s.id = m.secret_id)
    )
    FROM ops.assistant_mcp_servers AS m
    WHERE m.client_id = p_client_id
      AND m.is_active
      AND cardinality(m.enabled_tools) > 0
    ORDER BY m.server_name;
$$;

-- One server with its credential, for a connection check.
CREATE OR REPLACE FUNCTION public.assistant_mcp_server_context(p_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, vault, pg_temp
AS $$
    SELECT ops.assistant_mcp_server_json(m) || jsonb_build_object(
        'secret', (SELECT s.decrypted_secret FROM vault.decrypted_secrets AS s WHERE s.id = m.secret_id)
    )
    FROM ops.assistant_mcp_servers AS m
    WHERE m.id = p_id;
$$;

-- Records a check. p_tools NULL keeps the tools found last time (a failed check).
CREATE OR REPLACE FUNCTION public.assistant_mcp_server_checked(p_id UUID, p_ok BOOLEAN, p_message TEXT, p_tools JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, entity_instances, pg_temp
AS $$
DECLARE
    v_row ops.assistant_mcp_servers;
BEGIN
    UPDATE ops.assistant_mcp_servers
       SET last_checked_at = NOW(),
           last_check_ok = p_ok,
           last_check_message = left(p_message, 1000),
           discovered_tools = CASE WHEN p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN discovered_tools ELSE p_tools END,
           -- A tool the server no longer lists cannot stay turned on.
           enabled_tools = CASE
               WHEN p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN enabled_tools
               ELSE ARRAY(SELECT t FROM unnest(enabled_tools) AS t
                          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p_tools) AS d WHERE d->>'name' = t))
           END,
           updated_at = NOW()
     WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN ops.assistant_mcp_server_json(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- External ids: a record's id in another system.
--
-- Valid time (valid_from, valid_to) says when the id applied to the record.
-- Knowledge time (recorded_at, retired_at) says when Tapestry learned it and
-- when it stopped believing it. A correction retires the open row and records
-- a new one, so a question asked with an earlier Knowledge date still sees
-- what was known then.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_instances.entity_external_ids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    external_id VARCHAR(300) NOT NULL CHECK (btrim(external_id) <> ''),
    valid_from DATE NOT NULL DEFAULT DATE '1900-01-01',
    valid_to DATE NOT NULL DEFAULT DATE '9999-12-31',
    origin VARCHAR(20) NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'ASSISTANT', 'LOAD')),
    note TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by UUID,
    retired_at TIMESTAMPTZ,
    retired_by UUID,
    CHECK (valid_from < valid_to)
);

-- One believed id per record per system, and one record per id per system.
CREATE UNIQUE INDEX IF NOT EXISTS entity_external_ids_open_entity
    ON entity_instances.entity_external_ids (entity_id, source_id, valid_from)
    WHERE retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entity_external_ids_open_value
    ON entity_instances.entity_external_ids (client_id, source_id, external_id, valid_from)
    WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS entity_external_ids_entity ON entity_instances.entity_external_ids (entity_id);

ALTER TABLE entity_instances.entity_external_ids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "External ids readable per entity access" ON entity_instances.entity_external_ids;
CREATE POLICY "External ids readable per entity access" ON entity_instances.entity_external_ids
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'READ'));

GRANT SELECT ON entity_instances.entity_external_ids TO authenticated;

COMMENT ON TABLE entity_instances.entity_external_ids IS
    'A record''s id in another system, keyed by source. Written through entity_external_id_save.';

CREATE OR REPLACE FUNCTION ops.external_id_json(p_row entity_instances.entity_external_ids)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', p_row.id,
        'entity_id', p_row.entity_id,
        'entity_code', e.entity_code,
        'entity_name', e.entity_name,
        'domain_code', e.domain_code,
        'source_code', s.source_code,
        'source_name', s.source_name,
        'external_id', p_row.external_id,
        'valid_from', p_row.valid_from,
        'valid_to', p_row.valid_to,
        'origin', p_row.origin,
        'note', p_row.note,
        'recorded_at', p_row.recorded_at,
        -- Servers of this client that reach the same system.
        'servers', COALESCE((
            SELECT jsonb_agg(m.server_code ORDER BY m.server_code)
            FROM ops.assistant_mcp_servers AS m
            WHERE m.client_id = p_row.client_id AND m.source_id = p_row.source_id AND m.is_active
        ), '[]'::jsonb)
    )
    FROM entity_instances.master_entities AS e
    JOIN entity_instances.source_registry AS s ON s.id = p_row.source_id
    WHERE e.id = p_row.entity_id;
$$;

-- Every id the given records hold in other systems, as of the given dates.
CREATE OR REPLACE FUNCTION public.entity_external_ids_for(
    p_entity_ids UUID[],
    p_as_of DATE DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, tenancy, pg_temp
AS $$
    SELECT ops.external_id_json(x)
    FROM entity_instances.entity_external_ids AS x
    WHERE x.entity_id = ANY (p_entity_ids)
      AND tenancy.has_entity_access(x.entity_id, 'READ')
      AND COALESCE(p_as_of, CURRENT_DATE) >= x.valid_from
      AND COALESCE(p_as_of, CURRENT_DATE) < x.valid_to
      AND x.recorded_at <= COALESCE(p_knowledge, NOW())
      AND (x.retired_at IS NULL OR x.retired_at > COALESCE(p_knowledge, NOW()))
    ORDER BY x.entity_id, x.source_id;
$$;

-- The record that holds an id in a given system, as of the given dates.
CREATE OR REPLACE FUNCTION public.entity_external_id_find(
    p_source_code TEXT,
    p_external_id TEXT,
    p_as_of DATE DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, entity_instances, tenancy, pg_temp
AS $$
    SELECT ops.external_id_json(x)
    FROM entity_instances.entity_external_ids AS x
    JOIN entity_instances.source_registry AS s ON s.id = x.source_id
    WHERE s.source_code = btrim(p_source_code)
      AND lower(x.external_id) = lower(btrim(p_external_id))
      AND x.client_id IN (SELECT tenancy.current_client_ids())
      AND tenancy.has_entity_access(x.entity_id, 'READ')
      AND COALESCE(p_as_of, CURRENT_DATE) >= x.valid_from
      AND COALESCE(p_as_of, CURRENT_DATE) < x.valid_to
      AND x.recorded_at <= COALESCE(p_knowledge, NOW())
      AND (x.retired_at IS NULL OR x.retired_at > COALESCE(p_knowledge, NOW()));
$$;

-- Records (or corrects) a record's id in another system. The open row for the
-- same record, system and start date is retired, not overwritten.
CREATE OR REPLACE FUNCTION public.entity_external_id_save(
    p_entity_id UUID,
    p_source_code TEXT,
    p_external_id TEXT,
    p_valid_from DATE DEFAULT NULL,
    p_origin TEXT DEFAULT 'MANUAL',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, entity_instances, tenancy, pg_temp
AS $$
DECLARE
    v_entity entity_instances.master_entities;
    v_source_id UUID;
    v_valid_from DATE := COALESCE(p_valid_from, DATE '1900-01-01');
    v_existing entity_instances.entity_external_ids;
    v_row entity_instances.entity_external_ids;
BEGIN
    IF NULLIF(btrim(COALESCE(p_external_id, '')), '') IS NULL THEN
        RAISE EXCEPTION 'An id is required' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(p_origin, 'MANUAL') NOT IN ('MANUAL', 'ASSISTANT', 'LOAD') THEN
        RAISE EXCEPTION 'Origin must be MANUAL, ASSISTANT or LOAD' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_entity FROM entity_instances.master_entities WHERE id = p_entity_id;
    IF NOT FOUND OR NOT COALESCE(tenancy.has_entity_access(p_entity_id, 'READ'), FALSE) THEN
        RAISE EXCEPTION 'Record was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT COALESCE(tenancy.has_entity_access(p_entity_id, 'WRITE'), FALSE) THEN
        RAISE EXCEPTION 'You cannot change this record' USING ERRCODE = '42501';
    END IF;
    SELECT id INTO v_source_id FROM entity_instances.source_registry WHERE source_code = btrim(p_source_code);
    IF v_source_id IS NULL THEN
        RAISE EXCEPTION 'Source % was not found', p_source_code USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_existing
    FROM entity_instances.entity_external_ids
    WHERE client_id = v_entity.client_id AND source_id = v_source_id
      AND lower(external_id) = lower(btrim(p_external_id))
      AND valid_from = v_valid_from AND retired_at IS NULL;
    IF FOUND THEN
        IF v_existing.entity_id = p_entity_id THEN
            RETURN ops.external_id_json(v_existing);
        END IF;
        RAISE EXCEPTION '% id % already belongs to another record', p_source_code, p_external_id USING ERRCODE = '23505';
    END IF;

    UPDATE entity_instances.entity_external_ids
       SET retired_at = NOW(), retired_by = auth.uid()
     WHERE entity_id = p_entity_id AND source_id = v_source_id
       AND valid_from = v_valid_from AND retired_at IS NULL;

    INSERT INTO entity_instances.entity_external_ids (
        client_id, entity_id, source_id, external_id, valid_from, origin, note, recorded_by
    ) VALUES (
        v_entity.client_id, p_entity_id, v_source_id, btrim(p_external_id), v_valid_from,
        COALESCE(p_origin, 'MANUAL'), NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid()
    )
    RETURNING * INTO v_row;

    RETURN ops.external_id_json(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.can_manage_assistant_connections(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assistant_mcp_server_json(ops.assistant_mcp_servers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.external_id_json(entity_instances.entity_external_ids) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.assistant_mcp_servers_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_mcp_server_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], TEXT[], BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_mcp_server_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_mcp_servers_runtime(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assistant_mcp_server_context(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assistant_mcp_server_checked(UUID, BOOLEAN, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_external_ids_for(UUID[], DATE, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.entity_external_id_find(TEXT, TEXT, DATE, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.entity_external_id_save(UUID, TEXT, TEXT, DATE, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.assistant_mcp_servers_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_mcp_server_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], TEXT[], BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_mcp_server_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_mcp_servers_runtime(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.assistant_mcp_server_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.assistant_mcp_server_checked(UUID, BOOLEAN, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_external_ids_for(UUID[], DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.entity_external_id_find(TEXT, TEXT, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.entity_external_id_save(UUID, TEXT, TEXT, DATE, TEXT, TEXT) TO authenticated, service_role;
