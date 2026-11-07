-- Optional file-level source for an import. A mapped Source column overrides
-- this per row; a blank cell keeps this source.

ALTER TABLE entity_instances.import_instances
  ADD COLUMN IF NOT EXISTS source_code VARCHAR(50);

COMMENT ON COLUMN entity_instances.import_instances.source_code IS
  'Source used when a row does not name one. Defaults to POSITION_FILE at load time.';
