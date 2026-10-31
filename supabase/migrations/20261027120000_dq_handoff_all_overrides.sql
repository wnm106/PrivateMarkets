-- Handoff can list every manual override in effect, and still flag the ones
-- whose value already matches the highest-ranked system source.

DO $patch$
DECLARE
  s text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO s
  FROM pg_proc
  WHERE proname = 'data_quality_dashboard'
    AND pg_get_function_identity_arguments(oid) LIKE '%timestamp with time zone%';

  IF s IS NULL THEN
    RAISE EXCEPTION 'data_quality_dashboard was not found';
  END IF;

  IF position('''ready'', o.ready' IN s) > 0 THEN
    RETURN;
  END IF;

  s := replace(
    s,
    $old$
  override_matches AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           m.golden_value AS override_value,
           m.override_reason,
           p.source_code AS priority_source_code,
           p.source_name AS priority_source_name,
           p.golden_value AS priority_value
    FROM manual_current m
    JOIN priority_current p
      ON p.entity_id = m.entity_id
     AND p.attribute_id = m.attribute_id
    JOIN scoped s ON s.id = m.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
    WHERE data_quality.values_match(m.golden_value, p.golden_value)
       OR (
         m.golden_value_numeric IS NOT NULL
         AND p.golden_value_numeric IS NOT NULL
         AND m.golden_value_numeric = p.golden_value_numeric
       )
  ),
$old$,
    $new$
  override_matches AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           m.golden_value AS override_value,
           m.override_reason,
           p.source_code AS priority_source_code,
           p.source_name AS priority_source_name,
           p.golden_value AS priority_value,
           (
             p.entity_id IS NOT NULL
             AND (
               data_quality.values_match(m.golden_value, p.golden_value)
               OR (
                 m.golden_value_numeric IS NOT NULL
                 AND p.golden_value_numeric IS NOT NULL
                 AND m.golden_value_numeric = p.golden_value_numeric
               )
             )
           ) AS ready
    FROM manual_current m
    LEFT JOIN priority_current p
      ON p.entity_id = m.entity_id
     AND p.attribute_id = m.attribute_id
    JOIN scoped s ON s.id = m.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
  ),
$new$
  );

  s := replace(
    s,
    $old$
  entity_override_matches AS (
    SELECT entity_id, count(*)::int AS match_count
    FROM override_matches
    GROUP BY entity_id
  ),
$old$,
    $new$
  entity_override_matches AS (
    SELECT entity_id,
           count(*) FILTER (WHERE ready)::int AS match_count,
           count(*)::int AS override_count
    FROM override_matches
    GROUP BY entity_id
  ),
$new$
  );

  s := replace(
    s,
    'COALESCE(om.match_count, 0) AS "overrideMatchCount"',
    E'COALESCE(om.match_count, 0) AS "overrideMatchCount",\n           COALESCE(om.override_count, 0) AS "overrideCount"'
  );

  s := replace(
    s,
    '(SELECT count(*)::int FROM override_matches) AS override_match_count',
    '(SELECT count(*)::int FROM override_matches WHERE ready) AS override_match_count'
  );

  s := replace(
    s,
    '''priorityValue'', o.priority_value',
    E'''priorityValue'', o.priority_value,\n          ''ready'', o.ready'
  );

  s := replace(
    s,
    'ORDER BY o.entity_name, o.attribute_name',
    'ORDER BY o.ready DESC, o.entity_name, o.attribute_name'
  );

  s := replace(
    s,
    'OR e."qualityResolvedCount" > 0 OR e."qualityIntroducedCount" > 0',
    'OR e."qualityResolvedCount" > 0 OR e."qualityIntroducedCount" > 0 OR e."overrideCount" > 0'
  );

  IF position('''ready'', o.ready' IN s) = 0
     OR position('AS "overrideCount"' IN s) = 0
     OR position('count(*) FILTER (WHERE ready)' IN s) = 0
     OR position('FROM override_matches WHERE ready' IN s) = 0
     OR position('e."overrideCount" > 0' IN s) = 0 THEN
    RAISE EXCEPTION 'Could not extend data_quality_dashboard with every manual override';
  END IF;

  EXECUTE s;
END;
$patch$;

COMMENT ON FUNCTION public.data_quality_dashboard(text, date, date, timestamptz, uuid) IS
  'Availability, DQ rule results, period movement, value changes, and manual overrides, resolved at the as-of dates and the knowledge time. Ready overrides match the highest-ranked system source. An entity id limits the run to that record.';
