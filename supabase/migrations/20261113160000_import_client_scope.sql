-- Imports belong to a client. Uploaded files, specialist sessions, and saved
-- column maps were global, so any signed-in user could list, read, or reprocess
-- another client's files. Each row now carries the client that created it.
--
-- feed_maps.client_id may stay NULL: those rows are built-in maps (the Position
-- File map) that every client can read but no client can change.

ALTER TABLE entity_instances.import_instances
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);
ALTER TABLE entity_instances.feed_maps
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

-- Everything loaded so far went into the default client, so it keeps that owner.
UPDATE entity_instances.import_instances
   SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
 WHERE client_id IS NULL;
UPDATE entity_instances.feed_maps
   SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
 WHERE client_id IS NULL
   AND map_code <> 'POSITION_FILE';

CREATE INDEX IF NOT EXISTS idx_import_instances_client_received
    ON entity_instances.import_instances (client_id, received_at DESC);

-- A map code and a file shape are unique within a client, not across clients.
ALTER TABLE entity_instances.feed_maps DROP CONSTRAINT IF EXISTS feed_maps_map_code_key;
DROP INDEX IF EXISTS entity_instances.feed_maps_header_signature;

CREATE UNIQUE INDEX IF NOT EXISTS feed_maps_client_map_code
    ON entity_instances.feed_maps (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), map_code);
CREATE UNIQUE INDEX IF NOT EXISTS feed_maps_client_header_signature
    ON entity_instances.feed_maps (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), header_signature)
    WHERE header_signature IS NOT NULL;

-- Reads go through the service role with an explicit client filter. The old
-- policies let any authenticated user read every row directly, so remove them.
DROP POLICY IF EXISTS import_instances_readable ON entity_instances.import_instances;
REVOKE SELECT ON entity_instances.import_instances FROM authenticated;
DROP POLICY IF EXISTS feed_maps_readable ON entity_instances.feed_maps;
CREATE POLICY feed_maps_readable ON entity_instances.feed_maps
    FOR SELECT TO authenticated
    USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()));

COMMENT ON COLUMN entity_instances.import_instances.client_id IS
    'Client that uploaded the file. Every read and write filters on it.';
COMMENT ON COLUMN entity_instances.feed_maps.client_id IS
    'Client that owns the map. NULL marks a built-in map that every client can read but not change.';

-- The data-specialist table comes from 20261030180000_source_load_sessions.sql.
-- Scope it too when it exists; if that migration has not run yet, run it first
-- and then run this file again (every statement here is safe to repeat).
DO $$
BEGIN
    IF to_regclass('entity_instances.load_sessions') IS NULL THEN
        RAISE NOTICE 'entity_instances.load_sessions is missing: apply 20261030180000_source_load_sessions.sql, then re-run this migration.';
        RETURN;
    END IF;

    ALTER TABLE entity_instances.load_sessions
        ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);
    UPDATE entity_instances.load_sessions
       SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
     WHERE client_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_load_sessions_client_created
        ON entity_instances.load_sessions (client_id, created_at DESC);
    DROP POLICY IF EXISTS load_sessions_readable ON entity_instances.load_sessions;
    REVOKE SELECT ON entity_instances.load_sessions FROM authenticated;
    COMMENT ON COLUMN entity_instances.load_sessions.client_id IS
        'Client that opened the specialist session. Every read and write filters on it.';
END $$;
