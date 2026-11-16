-- SFTP connections for feeds.
--
-- Adds SFTP to the kinds a connection may be. The connector is in
-- packages/worker/src/connectors.ts. Settings: {"host", "port", "username",
-- "folder", "authType": "PASSWORD" or "KEY", "hostKey", "afterLoad"}. The
-- password or private key is the connection's secret, kept in Vault like any other.
--
-- feed_connection_save is the function from 20261114210000_feeds.sql with SFTP
-- added to the kinds it accepts. Nothing else in it changed.

ALTER TABLE ops.connections DROP CONSTRAINT IF EXISTS connections_kind_check;
ALTER TABLE ops.connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('STORAGE', 'HTTP', 'SFTP'));

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
    IF p_kind IS NULL OR p_kind NOT IN ('STORAGE', 'HTTP', 'SFTP') THEN
        RAISE EXCEPTION 'The connection kind must be STORAGE, HTTP, or SFTP' USING ERRCODE = '22023';
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

NOTIFY pgrst, 'reload schema';
