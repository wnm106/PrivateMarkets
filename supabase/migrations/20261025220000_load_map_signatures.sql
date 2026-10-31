-- A file shape (its column names) remembers the confirmed column map.
-- The next file with those columns skips discovery and reuses the map.

ALTER TABLE entity_instances.feed_maps
    ADD COLUMN IF NOT EXISTS header_signature TEXT,
    ADD COLUMN IF NOT EXISTS assignment_template JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS feed_maps_header_signature
    ON entity_instances.feed_maps (header_signature)
    WHERE header_signature IS NOT NULL;

COMMENT ON COLUMN entity_instances.feed_maps.header_signature IS
    'Sorted, lowercased column names for the file shape this map loads.';
COMMENT ON COLUMN entity_instances.feed_maps.assignment_template IS
    'Confirmed column assignments reused when another file has the same columns.';

INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, precedence_rank)
VALUES ('IMPORT', 'Data Import', 'INTERNAL', 50)
ON CONFLICT (source_code) DO NOTHING;
