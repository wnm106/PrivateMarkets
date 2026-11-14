-- Global search matches entity names with ILIKE '%query%'. The btree on
-- entity_name cannot serve a leading wildcard, so each keystroke scanned the
-- registry. A trigram GIN index supports that contains predicate for active
-- rows, which is the filter search always applies.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_master_entities_name_trgm
  ON entity_instances.master_entities
  USING gin (entity_name extensions.gin_trgm_ops)
  WHERE is_active;

COMMENT ON INDEX entity_instances.idx_master_entities_name_trgm IS
  'Substring and case-insensitive lookup of active entity names for global search.';
