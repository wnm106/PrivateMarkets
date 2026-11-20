-- Data quality scores.
--
-- One score at three levels, from the checks the dashboard already resolves:
--   availability  a required value is present (weight 1)
--   quality       a rule passes; critical 8, high 4, medium 2, low 1.
--                 A failure a person has accepted is left out of both sides.
--   freshness     a prevailing sourced value was received within 30 days of
--                 the To date. Derived and calculated values are left out.
--   congruency    two or more sources agree with the prevailing value.
--
-- A dimension with no checks is blank. The score is the average of the
-- dimensions that apply. An entity type and the firm add up the check
-- weights, so the firm weights equal the sum of the type weights.
-- The percentages are derived in the client from these weights.

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

  IF position('''entityTypeScores''' IN s) > 0 THEN
    RETURN;
  END IF;

  s := replace(
    s,
    $old$           sr.source_code,
           sr.source_name
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id$old$,
    $new$           sr.source_code,
           sr.source_name,
           COALESCE(eav.last_received_at, eav.system_from) AS received_at,
           (eav.golden_source_id IS NOT NULL AND eav.source_id = eav.golden_source_id) AS is_golden
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id$new$
  );

  s := replace(
    s,
    $old$  entity_rows AS ($old$,
    $new$  prevailing AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           golden_value,
           golden_value_numeric,
           received_at
    FROM open_source_values
    ORDER BY entity_id, attribute_id, is_golden DESC, precedence_rank ASC, golden_value
  ),
  fresh_checks AS (
    SELECT p.entity_id,
           (p.received_at::date >= (v_to - 30)) AS passed
    FROM prevailing p
    WHERE p.source_code IS DISTINCT FROM 'DERIVED'
      AND p.source_code IS DISTINCT FROM 'CALCULATED'
  ),
  congruency_checks AS (
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
  ),
  score_by_entity AS (
    SELECT entity_id,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability' AND passed), 0)::int AS availability_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability'), 0)::int AS availability_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality' AND passed), 0)::int AS quality_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality'), 0)::int AS quality_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness' AND passed), 0)::int AS freshness_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness'), 0)::int AS freshness_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'congruency' AND passed), 0)::int AS congruency_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'congruency'), 0)::int AS congruency_applicable
    FROM (
      SELECT entity_id, 'availability'::text AS dimension, 1::numeric AS weight, present_to AS passed
      FROM required_values
      UNION ALL
      SELECT rc.entity_id,
             'quality',
             CASE upper(COALESCE(aru.rule_severity, ''))
               WHEN 'CRITICAL' THEN 8
               WHEN 'HIGH' THEN 4
               WHEN 'MEDIUM' THEN 2
               ELSE 1
             END,
             rc.passed
      FROM rule_checks rc
      JOIN active_rules aru ON aru.id = rc.rule_id
      UNION ALL
      SELECT entity_id, 'freshness', 1, passed FROM fresh_checks
      UNION ALL
      SELECT entity_id, 'congruency', 1, passed FROM congruency_checks
    ) facts
    GROUP BY entity_id
  ),
  waived_by_entity AS (
    SELECT ax.entity_id, count(*)::int AS waived
    FROM accepted ax
    JOIN active_rules aru ON aru.id = ax.rule_id
    GROUP BY ax.entity_id
  ),
  type_score_rows AS (
    SELECT s.domain_code,
           count(*)::int AS entity_count,
           COALESCE(sum(sc.availability_passing), 0)::int AS availability_passing,
           COALESCE(sum(sc.availability_applicable), 0)::int AS availability_applicable,
           COALESCE(sum(sc.quality_passing), 0)::int AS quality_passing,
           COALESCE(sum(sc.quality_applicable), 0)::int AS quality_applicable,
           COALESCE(sum(sc.freshness_passing), 0)::int AS freshness_passing,
           COALESCE(sum(sc.freshness_applicable), 0)::int AS freshness_applicable,
           COALESCE(sum(sc.congruency_passing), 0)::int AS congruency_passing,
           COALESCE(sum(sc.congruency_applicable), 0)::int AS congruency_applicable,
           COALESCE(sum(wv.waived), 0)::int AS waived_checks
    FROM scoped s
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
    GROUP BY s.domain_code
  ),
  entity_rows AS ($new$
  );

  s := replace(
    s,
    $old$           COALESCE(om.match_count, 0) AS "overrideMatchCount",
           COALESCE(om.override_count, 0) AS "overrideCount"
    FROM scoped s$old$,
    $new$           COALESCE(om.match_count, 0) AS "overrideMatchCount",
           COALESCE(om.override_count, 0) AS "overrideCount",
           COALESCE(sc.availability_passing, 0) AS "availabilityPassing",
           COALESCE(sc.availability_applicable, 0) AS "availabilityApplicable",
           COALESCE(sc.quality_passing, 0) AS "qualityPassing",
           COALESCE(sc.quality_applicable, 0) AS "qualityApplicable",
           COALESCE(sc.freshness_passing, 0) AS "freshnessPassing",
           COALESCE(sc.freshness_applicable, 0) AS "freshnessApplicable",
           COALESCE(sc.congruency_passing, 0) AS "congruencyPassing",
           COALESCE(sc.congruency_applicable, 0) AS "congruencyApplicable",
           COALESCE(wv.waived, 0) AS "waivedChecks"
    FROM scoped s$new$
  );

  s := replace(
    s,
    $old$    LEFT JOIN entity_override_matches om ON om.entity_id = s.id
  ),$old$,
    $new$    LEFT JOIN entity_override_matches om ON om.entity_id = s.id
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
  ),$new$
  );

  s := replace(
    s,
    $old$    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'entityCount', entity_count,$old$,
    $new$    ), '[]'::jsonb),
    'scores', (
      SELECT jsonb_build_object(
        'availabilityPassing', COALESCE(sum(availability_passing), 0),
        'availabilityApplicable', COALESCE(sum(availability_applicable), 0),
        'qualityPassing', COALESCE(sum(quality_passing), 0),
        'qualityApplicable', COALESCE(sum(quality_applicable), 0),
        'freshnessPassing', COALESCE(sum(freshness_passing), 0),
        'freshnessApplicable', COALESCE(sum(freshness_applicable), 0),
        'congruencyPassing', COALESCE(sum(congruency_passing), 0),
        'congruencyApplicable', COALESCE(sum(congruency_applicable), 0),
        'waivedChecks', COALESCE(sum(waived_checks), 0)
      )
      FROM type_score_rows
    ),
    'entityTypeScores', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'domainCode', domain_code,
          'entityCount', entity_count,
          'availabilityPassing', availability_passing,
          'availabilityApplicable', availability_applicable,
          'qualityPassing', quality_passing,
          'qualityApplicable', quality_applicable,
          'freshnessPassing', freshness_passing,
          'freshnessApplicable', freshness_applicable,
          'congruencyPassing', congruency_passing,
          'congruencyApplicable', congruency_applicable,
          'waivedChecks', waived_checks
        )
        ORDER BY domain_code
      )
      FROM type_score_rows
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'entityCount', entity_count,$new$
  );

  IF position('AS received_at' IN s) = 0
     OR position('type_score_rows AS' IN s) = 0
     OR position('AS "waivedChecks"' IN s) = 0
     OR position('''entityTypeScores''' IN s) = 0
     OR position('LEFT JOIN score_by_entity sc' IN s) = 0 THEN
    RAISE EXCEPTION 'Could not add data quality scores to data_quality_dashboard';
  END IF;

  EXECUTE s;
END;
$patch$;

COMMENT ON FUNCTION public.data_quality_dashboard(text, date, date, timestamptz, uuid, text[]) IS
  'Availability, DQ rule results, period movement, value changes, manual overrides, and score weights, resolved at the as-of dates and the knowledge time. scores and entityTypeScores are the check weights behind the firm and entity-type scores. Each entity row carries the same weights. p_sections lists the record lists to include (availabilityEntities, entities); NULL includes all of them. An entity id limits the run to that record.';
