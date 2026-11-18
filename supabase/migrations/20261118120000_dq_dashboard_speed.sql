-- The data quality dashboard took about 20 seconds on a book of 9,500 records.
--
-- Every rule result was kept as a wide row (record names plus a JSON result)
-- and that set of about 160,000 rows was scanned a dozen times and sorted on
-- eleven columns, most of it on disk. Results are now kept as narrow rows
-- (rule, record, passed, message, value), counted in one pass, and joined to
-- names only for the handful that fail. Rules are matched to records by domain
-- with a hash join instead of comparing every rule to every record.
--
-- The output is unchanged. Safe to run again.

CREATE OR REPLACE FUNCTION public.data_quality_dashboard(p_domain_code text DEFAULT NULL::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'data_quality', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_known timestamptz := COALESCE(p_knowledge_date, clock_timestamp());
  v_swap date;
  v_result jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);
  PERFORM set_config('enable_nestloop', 'off', true);
  PERFORM set_config('work_mem', '64MB', true);
  IF v_from > v_to THEN
    v_swap := v_from;
    v_from := v_to;
    v_to := v_swap;
  END IF;

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
      AND me.client_id IN (
        SELECT cid
        FROM tenancy.current_client_ids() AS cid
        WHERE tenancy.has_permission(cid, 'entity.read')
      )
      AND CASE
        WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
          THEN tenancy.has_entity_access(me.id, 'READ')
        ELSE TRUE
      END
      AND (v_domain IS NULL OR me.domain_code = v_domain) AND (p_entity_id IS NULL OR me.id = p_entity_id)
  ),
  resolved AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, snapshot.as_of)
      eav.entity_id,
      eav.attribute_id,
      snapshot.as_of,
      NULLIF(btrim(eav.golden_value), '') AS golden_value
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN (
      VALUES (v_from), (v_to)
    ) AS snapshot(as_of) ON TRUE
    WHERE (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
      AND eav.valid_from <= snapshot.as_of
      AND eav.valid_to >= snapshot.as_of
    ORDER BY eav.entity_id, eav.attribute_id, snapshot.as_of, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  required_attr AS (
    SELECT s.id AS entity_id, s.entity_code, s.entity_name, s.domain_code,
           ar.id AS attribute_id, ar.attribute_code, ar.attribute_name
    FROM scoped s
    JOIN metadata_register.template_attribute_assignments taa
      ON taa.template_id = s.template_id
     AND taa.is_required IS TRUE
    JOIN metadata_register.attribute_register ar ON ar.id = taa.attribute_id
    WHERE s.template_id IS NOT NULL
    UNION
    SELECT s.id, s.entity_code, s.entity_name, s.domain_code,
           ar.id, ar.attribute_code, ar.attribute_name
    FROM scoped s
    JOIN metadata_register.attribute_register ar
      ON ar.domain_code = s.domain_code
     AND ar.is_required IS TRUE
    WHERE s.template_id IS NULL
  ),
  missing AS (
    SELECT r.*
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    WHERE rv.entity_id IS NULL
  ),
  value_map AS MATERIALIZED (
    SELECT rv.entity_id,
           jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS values
    FROM resolved rv
    JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
    WHERE rv.as_of = v_to
      AND rv.golden_value IS NOT NULL
    GROUP BY rv.entity_id
  ),
  active_rules AS (
    SELECT r.id, r.rule_code, r.rule_name, r.domain_code, r.rule_type, r.rule_severity,
           r.rule_expression, r.rule_description, ar.attribute_code, ar.attribute_name,
           data_quality.apply_compiled_rule(r.id, '{}'::jsonb, v_to) AS probe,
           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* ('^' || ar.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')) AS passes_when_blank
    FROM data_quality.dq_rules r
    LEFT JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
    WHERE r.is_active IS TRUE
      AND (v_domain IS NULL OR r.domain_code IS NULL OR r.domain_code = v_domain)
  ),
  accepted AS (
    SELECT DISTINCT ON (ex.rule_id, ex.entity_id)
           ex.rule_id, ex.entity_id, ex.status, ex.resolution_notes
    FROM data_quality.dq_exceptions ex
    WHERE ex.status IN ('WAIVED', 'FALSE_POSITIVE')
      AND ex.valid_from <= v_to
      AND ex.valid_to >= v_to
      AND ex.entity_id IN (SELECT id FROM scoped)
    ORDER BY ex.rule_id, ex.entity_id, ex.updated_at DESC NULLS LAST, ex.detected_at DESC
  ),
  rule_scope AS MATERIALIZED (
    SELECT aru.id AS rule_id, aru.attribute_code, aru.passes_when_blank, s.id AS entity_id
    FROM active_rules aru
    JOIN scoped s ON s.domain_code = aru.domain_code
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
    UNION ALL
    SELECT aru.id, aru.attribute_code, aru.passes_when_blank, s.id
    FROM active_rules aru
    CROSS JOIN scoped s
    WHERE aru.domain_code IS NULL
      AND COALESCE((aru.probe->>'evaluated')::boolean, false)
  ),
  rule_checks AS MATERIALIZED (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'message' AS message,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_to)
             END AS result
      FROM rule_scope rs
      LEFT JOIN value_map vm ON vm.entity_id = rs.entity_id
      WHERE NOT EXISTS (
        SELECT 1 FROM accepted ax
        WHERE ax.rule_id = rs.rule_id AND ax.entity_id = rs.entity_id
      )
      OFFSET 0  -- keeps the rule from being evaluated once per column read from it
    ) c
  ),
  rule_counts AS (
    SELECT rule_id,
           count(*)::int AS entity_count,
           count(*) FILTER (WHERE NOT passed)::int AS failing_count,
           count(*) FILTER (WHERE passed)::int AS passing_count
    FROM rule_checks
    GROUP BY rule_id
  ),
  failing_checks AS MATERIALIZED (
    SELECT rc.rule_id, rc.entity_id, rc.message, rc.actual_value,
           s.entity_code, s.entity_name, s.domain_code
    FROM rule_checks rc
    JOIN scoped s ON s.id = rc.entity_id
    WHERE NOT rc.passed
  ),
  prior_value_map AS MATERIALIZED (
    SELECT rv.entity_id,
           jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS values
    FROM resolved rv
    JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
    WHERE v_from <> v_to
      AND rv.as_of = v_from
      AND rv.golden_value IS NOT NULL
    GROUP BY rv.entity_id
  ),
  changed_entities AS (
    SELECT COALESCE(cur.entity_id, prev.entity_id) AS entity_id
    FROM value_map cur
    FULL JOIN prior_value_map prev ON prev.entity_id = cur.entity_id
    WHERE cur.values IS DISTINCT FROM prev.values
  ),
  prior_checks AS (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_from)
             END AS result
      FROM rule_scope rs
      JOIN changed_entities ce ON ce.entity_id = rs.entity_id
      LEFT JOIN prior_value_map vm ON vm.entity_id = rs.entity_id
      WHERE v_from <> v_to
      OFFSET 0
    ) c
  ),
  rule_shift AS MATERIALIZED (
    SELECT rc.rule_id,
           rc.entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           pc.passed AS prior_passed,
           rc.passed AS current_passed,
           pc.actual_value AS previous_value,
           rc.actual_value AS current_value
    FROM rule_checks rc
    JOIN prior_checks pc ON pc.rule_id = rc.rule_id AND pc.entity_id = rc.entity_id
    JOIN scoped s ON s.id = rc.entity_id
    WHERE pc.passed <> rc.passed  -- only a changed outcome is ever reported
  ),
  paired AS (
    SELECT entity_id,
           attribute_id,
           max(golden_value) FILTER (WHERE as_of = v_from) AS previous_value,
           max(golden_value) FILTER (WHERE as_of = v_to) AS current_value
    FROM resolved
    GROUP BY entity_id, attribute_id
    HAVING max(golden_value) FILTER (WHERE as_of = v_from)
       IS DISTINCT FROM
       max(golden_value) FILTER (WHERE as_of = v_to)
  ),
  changes AS (
    SELECT p.entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           ar.domain_code AS attribute_domain_code,
           p.previous_value,
           p.current_value
    FROM paired p
    JOIN scoped s ON s.id = p.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = p.attribute_id
  ),
  required_values AS (
    SELECT r.entity_id,
           r.entity_code,
           r.entity_name,
           r.domain_code,
           r.attribute_id,
           rv.golden_value,
           fr.golden_value AS previous_value,
           fr.golden_value IS NOT NULL AS present_from,
           rv.golden_value IS NOT NULL AS present_to
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    LEFT JOIN resolved fr
      ON fr.entity_id = r.entity_id
     AND fr.attribute_id = r.attribute_id
     AND fr.as_of = v_from
     AND fr.golden_value IS NOT NULL
  ),
  availability_rows AS (
    SELECT ar.attribute_code AS "attributeCode",
           ar.attribute_name AS "attributeName",
           COALESCE(ar.domain_code, req.domain_code) AS "domainCode",
           count(DISTINCT req.entity_id)::int AS "requiredCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NULL)::int AS "missingCount",
           round(
             100.0 * count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NOT NULL)
             / NULLIF(count(DISTINCT req.entity_id), 0),
             1
           ) AS "availabilityPercent",
           count(DISTINCT req.entity_id) FILTER (WHERE NOT req.present_from AND req.present_to)::int AS "resolvedCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.present_from AND NOT req.present_to)::int AS "introducedCount",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code
               )
             ) FILTER (WHERE req.golden_value IS NULL),
             '[]'::jsonb
           ) AS "missingEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', NULL,
                 'currentValue', req.golden_value
               )
             ) FILTER (WHERE NOT req.present_from AND req.present_to),
             '[]'::jsonb
           ) AS "resolvedEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', req.previous_value,
                 'currentValue', NULL
               )
             ) FILTER (WHERE req.present_from AND NOT req.present_to),
             '[]'::jsonb
           ) AS "introducedEntities",
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'value', req.golden_value
               )
               ORDER BY (req.golden_value IS NULL) DESC, req.entity_name
             ),
             '[]'::jsonb
           ) AS "entities"
    FROM required_values req
    JOIN metadata_register.attribute_register ar ON ar.id = req.attribute_id
    GROUP BY ar.attribute_code, ar.attribute_name, COALESCE(ar.domain_code, req.domain_code)
  ),
  quality_rows AS (
    SELECT aru.id AS "ruleId",
           aru.rule_code AS "ruleCode",
           aru.rule_name AS "ruleName",
           aru.rule_type AS "ruleType",
           aru.rule_severity AS "severity",
           aru.domain_code AS "domainCode",
           aru.rule_expression AS "ruleExpression",
           aru.rule_description AS "ruleDescription",
           aru.attribute_code AS "attributeCode",
           aru.attribute_name AS "attributeName",
           (SELECT count(*)::int FROM accepted ax WHERE ax.rule_id = aru.id) AS "acceptedCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', me.id,
                 'entityCode', me.entity_code,
                 'entityName', me.entity_name,
                 'domainCode', me.domain_code,
                 'status', ax.status,
                 'notes', ax.resolution_notes
               )
               ORDER BY me.entity_name
             )
             FROM accepted ax
             JOIN entity_instances.master_entities me ON me.id = ax.entity_id
             WHERE ax.rule_id = aru.id
           ), '[]'::jsonb) AS "acceptedEntities",
           COALESCE((aru.probe->>'evaluated')::boolean, false) AS "evaluated",
           CASE
             WHEN COALESCE((aru.probe->>'evaluated')::boolean, false) THEN NULL
             ELSE aru.probe->>'message'
           END AS "evaluationMessage",
           COALESCE(cnt.entity_count, 0) AS "entityCount",
           COALESCE(cnt.failing_count, 0) AS "failingCount",
           COALESCE(cnt.passing_count, 0) AS "passingCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', fc.entity_id,
                 'entityCode', fc.entity_code,
                 'entityName', fc.entity_name,
                 'domainCode', fc.domain_code,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY fc.entity_name
             )
             FROM failing_checks fc
             WHERE fc.rule_id = aru.id
           ), '[]'::jsonb) AS "failingEntities",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed), 0) AS "resolvedCount",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed), 0) AS "introducedCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed
           ), '[]'::jsonb) AS "resolvedEntities",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed
           ), '[]'::jsonb) AS "introducedEntities"
    FROM active_rules aru
    LEFT JOIN rule_counts cnt ON cnt.rule_id = aru.id
  ),
  trajectory_rows AS (
    SELECT c.attribute_code AS "attributeCode",
           c.attribute_name AS "attributeName",
           c.attribute_domain_code AS "domainCode",
           count(*)::int AS "changeCount",
           jsonb_agg(
             jsonb_build_object(
               'id', c.entity_id,
               'entityCode', c.entity_code,
               'entityName', c.entity_name,
               'domainCode', c.domain_code,
               'previousValue', c.previous_value,
               'currentValue', c.current_value
             )
             ORDER BY c.entity_name
           ) AS "changes"
    FROM changes c
    GROUP BY c.attribute_code, c.attribute_name, c.attribute_domain_code
  ),
  open_source_values AS (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, eav.source_id)
           eav.entity_id,
           eav.attribute_id,
           NULLIF(btrim(eav.golden_value), '') AS golden_value,
           eav.golden_value_numeric,
           eav.precedence_rank,
           eav.is_manual_override,
           eav.override_reason,
           sr.source_code,
           sr.source_name
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
      AND eav.valid_from <= v_to
      AND eav.valid_to >= v_to
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id, eav.source_id, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  manual_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, override_reason
    FROM open_source_values
    WHERE is_manual_override IS TRUE OR source_code = 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  priority_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, source_code, source_name
    FROM open_source_values
    WHERE COALESCE(is_manual_override, false) IS NOT TRUE
      AND source_code IS DISTINCT FROM 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
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
  entity_missing AS (
    SELECT entity_id,
           count(*)::int AS missing_count,
           jsonb_agg(
             jsonb_build_object(
               'attributeCode', attribute_code,
               'attributeName', attribute_name
             )
             ORDER BY attribute_name
           ) AS missing_attributes
    FROM missing
    GROUP BY entity_id
  ),
  entity_required AS (
    SELECT entity_id, count(*)::int AS required_count
    FROM required_attr
    GROUP BY entity_id
  ),
  entity_rules AS (
    SELECT cnt.entity_id,
           cnt.rule_count,
           cnt.failing_count,
           COALESCE(f.failing_rules, '[]'::jsonb) AS failing_rules
    FROM (
      SELECT entity_id,
             count(*)::int AS rule_count,
             count(*) FILTER (WHERE NOT passed)::int AS failing_count
      FROM rule_checks
      GROUP BY entity_id
    ) cnt
    LEFT JOIN (
      SELECT fc.entity_id,
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY aru.rule_name
             ) AS failing_rules
      FROM failing_checks fc
      JOIN active_rules aru ON aru.id = fc.rule_id
      GROUP BY fc.entity_id
    ) f ON f.entity_id = cnt.entity_id
  ),
  entity_accepted AS (
    SELECT ax.entity_id,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'status', ax.status,
                 'notes', ax.resolution_notes
               )
               ORDER BY aru.rule_name
             ),
             '[]'::jsonb
           ) AS accepted_rules
    FROM accepted ax
    JOIN active_rules aru ON aru.id = ax.rule_id
    GROUP BY ax.entity_id
  ),
  entity_availability_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT present_from AND present_to)::int AS resolved_count,
           count(*) FILTER (WHERE present_from AND NOT present_to)::int AS introduced_count
    FROM required_values
    GROUP BY entity_id
  ),
  entity_quality_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT prior_passed AND current_passed)::int AS resolved_count,
           count(*) FILTER (WHERE prior_passed AND NOT current_passed)::int AS introduced_count
    FROM rule_shift
    GROUP BY entity_id
  ),
  entity_override_matches AS (
    SELECT entity_id,
           count(*) FILTER (WHERE ready)::int AS match_count,
           count(*)::int AS override_count
    FROM override_matches
    GROUP BY entity_id
  ),
  entity_changes AS (
    SELECT entity_id,
           count(*)::int AS change_count,
           jsonb_agg(
             jsonb_build_object(
               'attributeCode', attribute_code,
               'attributeName', attribute_name,
               'previousValue', previous_value,
               'currentValue', current_value
             )
             ORDER BY attribute_name
           ) AS changes
    FROM changes
    GROUP BY entity_id
  ),
  entity_rows AS (
    SELECT s.id AS "id",
           s.entity_code AS "entityCode",
           s.entity_name AS "entityName",
           s.domain_code AS "domainCode",
           COALESCE(er.required_count, 0) AS "requiredCount",
           COALESCE(em.missing_count, 0) AS "missingCount",
           CASE
             WHEN COALESCE(er.required_count, 0) = 0 THEN NULL
             ELSE round(100.0 * (er.required_count - COALESCE(em.missing_count, 0)) / er.required_count, 1)
           END AS "availabilityPercent",
           COALESCE(em.missing_attributes, '[]'::jsonb) AS "missingAttributes",
           COALESCE(ru.rule_count, 0) AS "ruleCount",
           COALESCE(ru.failing_count, 0) AS "failingRuleCount",
           CASE
             WHEN COALESCE(ru.rule_count, 0) = 0 THEN NULL
             ELSE round(100.0 * (ru.rule_count - COALESCE(ru.failing_count, 0)) / ru.rule_count, 1)
           END AS "qualityPercent",
           COALESCE(ru.failing_rules, '[]'::jsonb) AS "failingRules",
           COALESCE(ea.accepted_rules, '[]'::jsonb) AS "acceptedRules",
           COALESCE(ec.change_count, 0) AS "changeCount",
           COALESCE(ec.changes, '[]'::jsonb) AS "changes",
           COALESCE(am.resolved_count, 0) AS "availabilityResolvedCount",
           COALESCE(am.introduced_count, 0) AS "availabilityIntroducedCount",
           COALESCE(qm.resolved_count, 0) AS "qualityResolvedCount",
           COALESCE(qm.introduced_count, 0) AS "qualityIntroducedCount",
           COALESCE(om.match_count, 0) AS "overrideMatchCount",
           COALESCE(om.override_count, 0) AS "overrideCount"
    FROM scoped s
    LEFT JOIN entity_required er ON er.entity_id = s.id
    LEFT JOIN entity_missing em ON em.entity_id = s.id
    LEFT JOIN entity_rules ru ON ru.entity_id = s.id
    LEFT JOIN entity_accepted ea ON ea.entity_id = s.id
    LEFT JOIN entity_changes ec ON ec.entity_id = s.id
    LEFT JOIN entity_availability_movement am ON am.entity_id = s.id
    LEFT JOIN entity_quality_movement qm ON qm.entity_id = s.id
    LEFT JOIN entity_override_matches om ON om.entity_id = s.id
  ),
  summary AS (
    SELECT
      (SELECT count(*)::int FROM scoped) AS entity_count,
      (SELECT count(*)::int FROM required_attr) AS required_slots,
      (SELECT count(*)::int FROM missing) AS missing_slots,
      (SELECT count(DISTINCT entity_id)::int FROM missing) AS entities_missing,
      (SELECT count(*)::int FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)) AS rules_evaluated,
      (SELECT COALESCE(sum(passing_count), 0)::int FROM rule_counts) AS passing_checks,
      (SELECT COALESCE(sum(failing_count), 0)::int FROM rule_counts) AS failing_checks,
      (SELECT count(DISTINCT entity_id)::int FROM failing_checks) AS entities_failing,
      (SELECT count(DISTINCT attribute_code)::int FROM changes) AS changed_attributes,
      (SELECT count(DISTINCT entity_id)::int FROM changes) AS changed_entities,
      (SELECT count(*)::int FROM changes) AS attribute_changes,
      (SELECT count(*)::int FROM entity_rows
        WHERE "missingCount" = 0 AND "failingRuleCount" = 0 AND "changeCount" = 0 AND "overrideMatchCount" = 0) AS clear_entities,
      (SELECT count(*)::int FROM required_values WHERE NOT present_from AND present_to) AS availability_resolved,
      (SELECT count(*)::int FROM required_values WHERE present_from AND NOT present_to) AS availability_introduced,
      (SELECT count(*)::int FROM rule_shift WHERE NOT prior_passed AND current_passed) AS quality_resolved,
      (SELECT count(*)::int FROM rule_shift WHERE prior_passed AND NOT current_passed) AS quality_introduced,
      (SELECT count(*)::int FROM override_matches WHERE ready) AS override_match_count
  )
  SELECT jsonb_build_object(
    'fromDate', to_char(v_from, 'YYYY-MM-DD'),
    'toDate', to_char(v_to, 'YYYY-MM-DD'),
    'domains', COALESCE((
      SELECT jsonb_agg(domain_code ORDER BY domain_code)
      FROM (
        SELECT DISTINCT domain_code
        FROM entity_instances.master_entities
        WHERE is_active IS TRUE
          AND domain_code IS NOT NULL
          AND client_id IN (
            SELECT cid
            FROM tenancy.current_client_ids() AS cid
            WHERE tenancy.has_permission(cid, 'entity.read')
          )
      ) d
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'entityCount', entity_count,
        'requiredSlots', required_slots,
        'populatedSlots', required_slots - missing_slots,
        'missingSlots', missing_slots,
        'entitiesMissingRequired', entities_missing,
        'availabilityPercent', CASE
          WHEN required_slots = 0 THEN NULL
          ELSE round(100.0 * (required_slots - missing_slots) / required_slots, 1)
        END,
        'rulesEvaluated', rules_evaluated,
        'passingChecks', passing_checks,
        'failingChecks', failing_checks,
        'entitiesFailingRules', entities_failing,
        'qualityPercent', CASE
          WHEN passing_checks + failing_checks = 0 THEN NULL
          WHEN failing_checks = 0 THEN 100.0
          ELSE least(99.9, round(100.0 * passing_checks / (passing_checks + failing_checks), 1))
        END,
        'changedAttributeCount', changed_attributes,
        'changedEntityCount', changed_entities,
        'attributeChangeCount', attribute_changes,
        'clearEntityCount', clear_entities,
        'availabilityResolvedCount', availability_resolved,
        'availabilityIntroducedCount', availability_introduced,
        'qualityResolvedCount', quality_resolved,
        'qualityIntroducedCount', quality_introduced,
        'overrideMatchCount', override_match_count
      )
      FROM summary
    ),
    'availability', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a."missingCount" DESC, a."attributeName")
      FROM availability_rows a
    ), '[]'::jsonb),
    'quality', COALESCE((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q."failingCount" DESC, q."ruleName")
      FROM quality_rows q
    ), '[]'::jsonb),
    'trajectory', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t."changeCount" DESC, t."attributeName")
      FROM trajectory_rows t
    ), '[]'::jsonb),
    'overrideMatches', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', o.entity_id,
          'entityCode', o.entity_code,
          'entityName', o.entity_name,
          'domainCode', o.domain_code,
          'attributeCode', o.attribute_code,
          'attributeName', o.attribute_name,
          'overrideValue', o.override_value,
          'overrideReason', o.override_reason,
          'prioritySourceCode', o.priority_source_code,
          'prioritySourceName', o.priority_source_name,
          'priorityValue', o.priority_value,
          'ready', o.ready
        )
        ORDER BY o.ready DESC, o.entity_name, o.attribute_name
      )
      FROM override_matches o
    ), '[]'::jsonb),
    'entities', COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY (e."missingCount" + e."failingRuleCount" + e."changeCount" + e."overrideMatchCount") DESC, e."entityName")
      FROM entity_rows e
      WHERE e."missingCount" > 0 OR e."failingRuleCount" > 0 OR e."changeCount" > 0 OR e."overrideMatchCount" > 0
         OR e."availabilityResolvedCount" > 0 OR e."availabilityIntroducedCount" > 0
         OR e."qualityResolvedCount" > 0 OR e."qualityIntroducedCount" > 0 OR e."overrideCount" > 0
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$
;
