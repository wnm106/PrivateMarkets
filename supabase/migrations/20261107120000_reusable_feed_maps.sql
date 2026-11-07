-- Records whether an upload reused a saved column map.
-- exact: every column was already on the map.
-- extended: the original columns matched and the file added new fields.
-- new: no saved map covered the file.

ALTER TABLE entity_instances.import_instances
  ADD COLUMN IF NOT EXISTS map_reuse VARCHAR(20);

COMMENT ON COLUMN entity_instances.import_instances.map_reuse IS
  'exact when a saved map covered every column, extended when the file only added columns, new when no saved map applied.';

COMMENT ON COLUMN entity_instances.feed_maps.column_mappings IS
  'Reusable map artifact: original columns, learned columns, and the column-to-attribute assignments.';
