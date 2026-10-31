-- Bulk entity lists were probing every source for every entity and attribute.
-- 6,141 positions x 36 attributes x 12 sources is millions of index seeks on a
-- ledger of under 100k rows, which is what made the positions grid take ~30s.
-- Small calls (one record, a compliance value) keep the per-source seek.
-- Larger calls read the covering slices once and keep the newest row per source,
-- then the lowest precedence_rank, which is the same choice as the seek.

CREATE OR REPLACE FUNCTION golden_master.winning_attribute_values(
  p_entity_ids uuid[],
  p_attribute_ids uuid[],
  p_as_of date,
  p_knowledge timestamptz,
  p_require_text boolean DEFAULT false
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
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF COALESCE(cardinality(p_entity_ids), 0) * COALESCE(cardinality(p_attribute_ids), 0) <= 400 THEN
    RETURN QUERY
    SELECT DISTINCT ON (e.entity_id, a.attribute_id)
           e.entity_id,
           a.attribute_id,
           v.source_id,
           v.precedence_rank,
           v.golden_value,
           v.golden_value_numeric,
           v.golden_value_date,
           v.golden_value_timestamp,
           v.valid_from,
           v.valid_to
    FROM unnest(COALESCE(p_entity_ids, '{}'::uuid[])) AS e(entity_id)
    CROSS JOIN unnest(COALESCE(p_attribute_ids, '{}'::uuid[])) AS a(attribute_id)
    JOIN entity_instances.source_registry sr ON true
    JOIN LATERAL (
      SELECT eav.source_id, eav.precedence_rank, eav.golden_value, eav.golden_value_numeric,
             eav.golden_value_date, eav.golden_value_timestamp, eav.valid_from, eav.valid_to
      FROM golden_master.entity_attribute_values eav
      WHERE eav.entity_id = e.entity_id
        AND eav.attribute_id = a.attribute_id
        AND eav.source_id = sr.id
        AND eav.valid_from <= p_as_of
        AND eav.valid_to >= p_as_of
        AND eav.system_from <= p_knowledge
        AND eav.system_to >= p_knowledge
      ORDER BY eav.valid_from DESC, eav.system_from DESC
      LIMIT 1
    ) v ON true
    WHERE NOT p_require_text
       OR (v.golden_value IS NOT NULL AND v.golden_value <> '')
    ORDER BY e.entity_id, a.attribute_id, v.precedence_rank;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (s.entity_id, s.attribute_id)
         s.entity_id,
         s.attribute_id,
         s.source_id,
         s.precedence_rank,
         s.golden_value,
         s.golden_value_numeric,
         s.golden_value_date,
         s.golden_value_timestamp,
         s.valid_from,
         s.valid_to
  FROM (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, eav.source_id)
           eav.entity_id, eav.attribute_id, eav.source_id, eav.precedence_rank,
           eav.golden_value, eav.golden_value_numeric, eav.golden_value_date,
           eav.golden_value_timestamp, eav.valid_from, eav.valid_to
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = ANY(COALESCE(p_entity_ids, '{}'::uuid[]))
      AND eav.attribute_id = ANY(COALESCE(p_attribute_ids, '{}'::uuid[]))
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_from <= p_knowledge
      AND eav.system_to >= p_knowledge
    ORDER BY eav.entity_id, eav.attribute_id, eav.source_id, eav.valid_from DESC, eav.system_from DESC
  ) s
  WHERE NOT p_require_text
     OR (s.golden_value IS NOT NULL AND s.golden_value <> '')
  ORDER BY s.entity_id, s.attribute_id, s.precedence_rank;
END;
$$;

COMMENT ON FUNCTION golden_master.winning_attribute_values(uuid[], uuid[], date, timestamptz, boolean) IS
  'As-of golden values. Small entity x attribute sets use one index seek per (entity, attribute, source). Larger sets scan the covering slices once, keep the newest row per source, then the lowest precedence_rank. p_require_text drops blank sources before that choice, matching reporting.grid.';
