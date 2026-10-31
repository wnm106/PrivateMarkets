-- The golden winner is chosen when a value is saved and stored on the row
-- (golden_source_id). Entity grids read that row. They do not run the
-- precedence waterfall again.

CREATE INDEX IF NOT EXISTS idx_eav_persisted_winner
  ON golden_master.entity_attribute_values (entity_id, attribute_id, valid_from DESC, system_from DESC)
  INCLUDE (golden_value, golden_value_numeric, golden_value_date, golden_value_timestamp, valid_to, system_to)
  WHERE source_id = golden_source_id;

CREATE OR REPLACE FUNCTION golden_master.persisted_attribute_values(
  p_entity_ids uuid[],
  p_attribute_ids uuid[],
  p_as_of date,
  p_knowledge timestamptz
) RETURNS TABLE (
  entity_id uuid,
  attribute_id uuid,
  source_id uuid,
  precedence_rank integer,
  golden_value text,
  golden_value_numeric numeric,
  golden_value_date date,
  golden_value_timestamp timestamptz,
  valid_from date,
  valid_to date
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
         eav.entity_id,
         eav.attribute_id,
         eav.source_id,
         eav.precedence_rank,
         eav.golden_value,
         eav.golden_value_numeric,
         eav.golden_value_date,
         eav.golden_value_timestamp,
         eav.valid_from,
         eav.valid_to
  FROM golden_master.entity_attribute_values eav
  WHERE eav.entity_id = ANY(COALESCE(p_entity_ids, '{}'::uuid[]))
    AND eav.attribute_id = ANY(COALESCE(p_attribute_ids, '{}'::uuid[]))
    AND eav.source_id = eav.golden_source_id
    AND eav.valid_from <= p_as_of
    AND eav.valid_to >= p_as_of
    AND eav.system_from <= p_knowledge
    AND eav.system_to >= p_knowledge
    AND eav.golden_value IS NOT NULL
    AND eav.golden_value <> ''
  ORDER BY eav.entity_id, eav.attribute_id, eav.valid_from DESC, eav.system_from DESC;
$$;

COMMENT ON FUNCTION golden_master.persisted_attribute_values(uuid[], uuid[], date, timestamptz) IS
  'As-of values already resolved at save. Returns the row whose source is golden_source_id. Does not re-rank sources.';

GRANT EXECUTE ON FUNCTION golden_master.persisted_attribute_values(uuid[], uuid[], date, timestamptz)
  TO authenticated, service_role;
