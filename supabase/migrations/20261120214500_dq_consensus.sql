-- Consensus replaces congruency in the data quality score.
--
-- An attribute is in the measure when its golden source has a value and at
-- least one other active source value exists. It passes when every other
-- active value agrees with the golden source. Each disagreement is returned
-- as consensusConflicts so the dashboard can show the conflict.

DO $patch$
DECLARE
  s text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO s
  FROM pg_proc
  WHERE proname = 'data_quality_dashboard'
    AND pg_get_function_identity_arguments(oid) LIKE '%text[]%';

  IF s IS NULL THEN
    RAISE EXCEPTION 'data_quality_dashboard was not found';
  END IF;

  IF position('consensus_checks AS' IN s) > 0 AND position('''consensusConflicts''' IN s) > 0 THEN
    RETURN;
  END IF;

  IF position('congruency' IN s) = 0 THEN
    RAISE EXCEPTION 'congruency was not found on data_quality_dashboard';
  END IF;

  s := replace(s, 'congruency', 'consensus');

  s := replace(
    s,
    $old$  consensus_checks AS (
    SELECT p.entity_id,
           bool_and(COALESCE(
             data_quality.values_match(o.golden_value, p.golden_value)
             OR (
               o.golden_value_numeric IS NOT NULL
               AND p.golden_value_numeric IS NOT NULL
               AND o.golden_value_numeric = p.golden_value_numeric
             ),
             false
           )) AS passed
    FROM prevailing p
    JOIN open_source_values o
      ON o.entity_id = p.entity_id
     AND o.attribute_id = p.attribute_id
    GROUP BY p.entity_id, p.attribute_id, p.golden_value, p.golden_value_numeric
    HAVING count(*) >= 2
  ),$old$,
    $new$  golden_active AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           source_name,
           golden_value,
           golden_value_numeric
    FROM open_source_values
    WHERE is_golden
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  consensus_other AS (
    SELECT g.entity_id,
           g.attribute_id,
           g.source_code AS golden_source_code,
           g.source_name AS golden_source_name,
           g.golden_value,
           g.golden_value_numeric,
           o.source_code,
           o.source_name,
           o.golden_value AS other_value,
           COALESCE(
             data_quality.values_match(o.golden_value, g.golden_value)
             OR (
               o.golden_value_numeric IS NOT NULL
               AND g.golden_value_numeric IS NOT NULL
               AND o.golden_value_numeric = g.golden_value_numeric
             ),
             false
           ) AS agrees
    FROM golden_active g
    JOIN open_source_values o
      ON o.entity_id = g.entity_id
     AND o.attribute_id = g.attribute_id
     AND NOT o.is_golden
  ),
  consensus_checks AS (
    SELECT entity_id,
           attribute_id,
           bool_and(agrees) AS passed
    FROM consensus_other
    GROUP BY entity_id, attribute_id
  ),
  consensus_conflict_rows AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           c.golden_source_code,
           c.golden_source_name,
           c.golden_value,
           c.source_code,
           c.source_name,
           c.other_value
    FROM consensus_other c
    JOIN scoped s ON s.id = c.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = c.attribute_id
    WHERE NOT c.agrees
  ),$new$
  );

  s := replace(
    s,
    $old$    'scores', ($old$,
    $new$    'consensusConflicts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', entity_id,
          'entityCode', entity_code,
          'entityName', entity_name,
          'domainCode', domain_code,
          'attributeCode', attribute_code,
          'attributeName', attribute_name,
          'goldenSourceCode', golden_source_code,
          'goldenSourceName', golden_source_name,
          'goldenValue', golden_value,
          'sourceCode', source_code,
          'sourceName', source_name,
          'value', other_value
        )
        ORDER BY entity_name, attribute_name, source_name
      )
      FROM consensus_conflict_rows
    ), '[]'::jsonb),
    'scores', ($new$
  );

  IF position('consensus_conflict_rows AS' IN s) = 0
     OR position('''consensusConflicts''' IN s) = 0
     OR position('congruency' IN s) > 0
     OR position('HAVING count(*) >= 2' IN s) > 0 THEN
    RAISE EXCEPTION 'Could not replace congruency with consensus';
  END IF;

  EXECUTE s;
END;
$patch$;

COMMENT ON FUNCTION public.data_quality_dashboard(text, date, date, timestamptz, uuid, text[]) IS
  'Availability, DQ rule results, period movement, value changes, manual overrides, and score weights, resolved at the as-of dates and the knowledge time. scores and entityTypeScores are the check weights behind the firm and entity-type scores: availability, quality, freshness, and consensus. Consensus passes when every other active source value agrees with the golden source, and consensusConflicts lists each disagreement. Each entity row carries the same weights. p_sections lists the record lists to include (availabilityEntities, entities); NULL includes all of them. An entity id limits the run to that record.';
