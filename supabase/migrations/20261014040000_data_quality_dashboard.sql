-- Data quality dashboard
-- Availability of required attributes, live evaluation of DQ rules, and
-- period-over-period golden-value changes. The function runs as the caller
-- so entity RLS still applies.

CREATE OR REPLACE FUNCTION data_quality.evaluate_rule_clause(
  p_clause text,
  p_values jsonb,
  p_as_of date
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $clause$
DECLARE
  v_clause text := btrim(COALESCE(p_clause, ''));
  v_m text[];
  v_attr text;
  v_value text;
  v_op text;
  v_rhs text;
  v_num numeric;
  v_rhs_num numeric;
  v_date date;
  v_rhs_date date;
  v_item text;
  v_hit boolean := false;
  v_saw_item boolean := false;
BEGIN
  IF v_clause = '' THEN
    RETURN jsonb_build_object(
      'passed', false,
      'evaluated', false,
      'message', 'Rule expression is empty',
      'actualValue', NULL
    );
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_value := p_values ->> lower(v_attr);
    RETURN jsonb_build_object(
      'passed', v_value IS NOT NULL,
      'evaluated', true,
      'message', CASE WHEN v_value IS NULL THEN v_attr || ' is missing' ELSE NULL END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NULL$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_value := p_values ->> lower(v_attr);
    RETURN jsonb_build_object(
      'passed', v_value IS NULL,
      'evaluated', true,
      'message', CASE WHEN v_value IS NOT NULL THEN v_attr || ' is present' ELSE NULL END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*~[[:space:]]*''((?:[^'']|'')*)''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_rhs := replace(v_m[2], '''''', '''');
    v_value := p_values ->> lower(v_attr);
    IF v_value IS NULL THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', true,
        'message', v_attr || ' is missing',
        'actualValue', NULL
      );
    END IF;
    BEGIN
      v_hit := v_value ~ v_rhs;
    EXCEPTION WHEN invalid_regular_expression THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', false,
        'message', 'Invalid regular expression on ' || v_attr,
        'actualValue', v_value
      );
    END;
    RETURN jsonb_build_object(
      'passed', v_hit,
      'evaluated', true,
      'message', CASE WHEN v_hit THEN NULL ELSE v_attr || ' does not match the expected format' END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+((?:I)?LIKE)[[:space:]]*''((?:[^'']|'')*)''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := upper(v_m[2]);
    v_rhs := replace(v_m[3], '''''', '''');
    v_value := p_values ->> lower(v_attr);
    IF v_value IS NULL THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', true,
        'message', v_attr || ' is missing',
        'actualValue', NULL
      );
    END IF;
    v_hit := CASE WHEN v_op = 'ILIKE' THEN v_value ILIKE v_rhs ELSE v_value LIKE v_rhs END;
    RETURN jsonb_build_object(
      'passed', v_hit,
      'evaluated', true,
      'message', CASE WHEN v_hit THEN NULL ELSE v_attr || ' does not match the expected pattern' END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IN[[:space:]]*\((.*)\)[[:space:]]*$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_value := p_values ->> lower(v_attr);
    IF v_value IS NULL THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', true,
        'message', v_attr || ' is missing',
        'actualValue', NULL
      );
    END IF;
    FOR v_item IN
      SELECT match[1]
      FROM regexp_matches(v_m[2], '''([^'']*)''', 'g') AS match
    LOOP
      v_saw_item := true;
      IF lower(v_value) = lower(replace(v_item, '''''', '''')) THEN
        v_hit := true;
      END IF;
    END LOOP;
    IF NOT v_saw_item THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', false,
        'message', 'IN list on ' || v_attr || ' has no quoted values',
        'actualValue', v_value
      );
    END IF;
    RETURN jsonb_build_object(
      'passed', v_hit,
      'evaluated', true,
      'message', CASE WHEN v_hit THEN NULL ELSE v_attr || ' is not an allowed value' END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(
    v_clause,
    '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*(CURRENT_DATE|-?[0-9]+(?:[.][0-9]+)?|''[^'']*'')[[:space:]]*$',
    'i'
  );
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_value := p_values ->> lower(v_attr);
    IF v_value IS NULL THEN
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', true,
        'message', v_attr || ' is missing',
        'actualValue', NULL
      );
    END IF;

    IF upper(v_rhs) = 'CURRENT_DATE' THEN
      BEGIN
        v_date := v_value::date;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is not a date',
          'actualValue', v_value
        );
      END;
      v_rhs_date := p_as_of;
      v_hit := CASE v_op
        WHEN '>' THEN v_date > v_rhs_date
        WHEN '>=' THEN v_date >= v_rhs_date
        WHEN '<' THEN v_date < v_rhs_date
        WHEN '<=' THEN v_date <= v_rhs_date
        WHEN '=' THEN v_date = v_rhs_date
        WHEN '!=' THEN v_date <> v_rhs_date
        WHEN '<>' THEN v_date <> v_rhs_date
        ELSE false
      END;
    ELSIF v_rhs ~ '^-?[0-9]+([.][0-9]+)?$' THEN
      BEGIN
        v_num := v_value::numeric;
        v_rhs_num := v_rhs::numeric;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is not a number',
          'actualValue', v_value
        );
      END;
      v_hit := CASE v_op
        WHEN '>' THEN v_num > v_rhs_num
        WHEN '>=' THEN v_num >= v_rhs_num
        WHEN '<' THEN v_num < v_rhs_num
        WHEN '<=' THEN v_num <= v_rhs_num
        WHEN '=' THEN v_num = v_rhs_num
        WHEN '!=' THEN v_num <> v_rhs_num
        WHEN '<>' THEN v_num <> v_rhs_num
        ELSE false
      END;
    ELSE
      v_rhs := btrim(v_rhs, '''');
      v_hit := CASE v_op
        WHEN '>' THEN v_value > v_rhs
        WHEN '>=' THEN v_value >= v_rhs
        WHEN '<' THEN v_value < v_rhs
        WHEN '<=' THEN v_value <= v_rhs
        WHEN '=' THEN v_value = v_rhs
        WHEN '!=' THEN v_value <> v_rhs
        WHEN '<>' THEN v_value <> v_rhs
        ELSE false
      END;
    END IF;

    RETURN jsonb_build_object(
      'passed', COALESCE(v_hit, false),
      'evaluated', true,
      'message', CASE WHEN COALESCE(v_hit, false) THEN NULL ELSE v_attr || ' failed ' || v_op || ' ' || v_rhs END,
      'actualValue', v_value
    );
  END IF;

  RETURN jsonb_build_object(
    'passed', false,
    'evaluated', false,
    'message', 'Expression is not supported: ' || v_clause,
    'actualValue', NULL
  );
END;
$clause$;

CREATE OR REPLACE FUNCTION data_quality.evaluate_rule_expression(
  p_expression text,
  p_values jsonb,
  p_as_of date
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, data_quality
AS $expr$
DECLARE
  v_expr text := btrim(regexp_replace(COALESCE(p_expression, ''), '[[:space:]]+', ' ', 'g'));
  v_or_part text;
  v_and_part text;
  v_or_parts text[];
  v_and_parts text[];
  v_clause jsonb;
  v_and_pass boolean;
  v_or_pass boolean := false;
  v_messages text[] := ARRAY[]::text[];
  v_actuals text[] := ARRAY[]::text[];
BEGIN
  IF v_expr = '' THEN
    RETURN jsonb_build_object(
      'passed', false,
      'evaluated', false,
      'message', 'Rule expression is empty',
      'actualValue', NULL
    );
  END IF;

  v_or_parts := regexp_split_to_array(v_expr, '[[:space:]]+[Oo][Rr][[:space:]]+');
  FOREACH v_or_part IN ARRAY v_or_parts LOOP
    v_and_parts := regexp_split_to_array(btrim(v_or_part), '[[:space:]]+[Aa][Nn][Dd][[:space:]]+');
    v_and_pass := true;
    FOREACH v_and_part IN ARRAY v_and_parts LOOP
      v_clause := data_quality.evaluate_rule_clause(btrim(v_and_part), COALESCE(p_values, '{}'::jsonb), p_as_of);
      IF COALESCE((v_clause->>'evaluated')::boolean, false) IS NOT TRUE THEN
        RETURN v_clause;
      END IF;
      IF COALESCE((v_clause->>'passed')::boolean, false) IS NOT TRUE THEN
        v_and_pass := false;
        IF v_clause->>'message' IS NOT NULL THEN
          v_messages := array_append(v_messages, v_clause->>'message');
        END IF;
        IF v_clause->>'actualValue' IS NOT NULL THEN
          v_actuals := array_append(v_actuals, v_clause->>'actualValue');
        END IF;
      END IF;
    END LOOP;
    IF v_and_pass THEN
      v_or_pass := true;
    END IF;
  END LOOP;

  IF v_or_pass THEN
    RETURN jsonb_build_object(
      'passed', true,
      'evaluated', true,
      'message', NULL,
      'actualValue', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'passed', false,
    'evaluated', true,
    'message', NULLIF(array_to_string(v_messages, '; '), ''),
    'actualValue', NULLIF(array_to_string(v_actuals, '; '), '')
  );
END;
$expr$;

CREATE OR REPLACE FUNCTION public.data_quality_dashboard(
  p_domain_code text DEFAULT NULL,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, data_quality, entity_instances, metadata_register, golden_master, pg_catalog
AS $dashboard$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_swap date;
  v_result jsonb;
BEGIN
  IF v_from > v_to THEN
    v_swap := v_from;
    v_from := v_to;
    v_to := v_swap;
  END IF;

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
      AND (v_domain IS NULL OR me.domain_code = v_domain)
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
    WHERE eav.system_to = '9999-12-31 23:59:59'
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
           r.rule_expression,
           data_quality.evaluate_rule_expression(r.rule_expression, '{}'::jsonb, v_to) AS probe
    FROM data_quality.dq_rules r
    WHERE r.is_active IS TRUE
      AND (v_domain IS NULL OR r.domain_code IS NULL OR r.domain_code = v_domain)
  ),
  rule_checks AS (
    SELECT aru.id AS rule_id,
           s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           data_quality.evaluate_rule_expression(
             aru.rule_expression,
             COALESCE(vm.values, '{}'::jsonb),
             v_to
           ) AS result
    FROM active_rules aru
    JOIN scoped s ON aru.domain_code IS NULL OR s.domain_code = aru.domain_code
    LEFT JOIN value_map vm ON vm.entity_id = s.id
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
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
  availability_rows AS (
    SELECT ar.attribute_code AS "attributeCode",
           ar.attribute_name AS "attributeName",
           COALESCE(ar.domain_code, req.domain_code) AS "domainCode",
           count(DISTINCT req.entity_id)::int AS "requiredCount",
           count(DISTINCT m.entity_id)::int AS "missingCount",
           round(
             100.0 * (count(DISTINCT req.entity_id) - count(DISTINCT m.entity_id))
             / NULLIF(count(DISTINCT req.entity_id), 0),
             1
           ) AS "availabilityPercent",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', m.entity_id,
                 'entityCode', m.entity_code,
                 'entityName', m.entity_name,
                 'domainCode', m.domain_code
               )
             ) FILTER (WHERE m.entity_id IS NOT NULL),
             '[]'::jsonb
           ) AS "missingEntities"
    FROM required_attr req
    JOIN metadata_register.attribute_register ar ON ar.id = req.attribute_id
    LEFT JOIN missing m
      ON m.entity_id = req.entity_id
     AND m.attribute_id = req.attribute_id
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
           COALESCE((aru.probe->>'evaluated')::boolean, false) AS "evaluated",
           CASE
             WHEN COALESCE((aru.probe->>'evaluated')::boolean, false) THEN NULL
             ELSE aru.probe->>'message'
           END AS "evaluationMessage",
           count(rc.entity_id)::int AS "entityCount",
           count(rc.entity_id) FILTER (
             WHERE COALESCE((rc.result->>'passed')::boolean, false) IS NOT TRUE
           )::int AS "failingCount",
           count(rc.entity_id) FILTER (
             WHERE COALESCE((rc.result->>'passed')::boolean, false)
           )::int AS "passingCount",
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id', rc.entity_id,
                 'entityCode', rc.entity_code,
                 'entityName', rc.entity_name,
                 'domainCode', rc.domain_code,
                 'message', rc.result->>'message',
                 'actualValue', rc.result->>'actualValue'
               )
               ORDER BY rc.entity_name
             ) FILTER (
               WHERE rc.entity_id IS NOT NULL
                 AND COALESCE((rc.result->>'passed')::boolean, false) IS NOT TRUE
             ),
             '[]'::jsonb
           ) AS "failingEntities"
    FROM active_rules aru
    LEFT JOIN rule_checks rc ON rc.rule_id = aru.id
    GROUP BY aru.id, aru.rule_code, aru.rule_name, aru.rule_type, aru.rule_severity,
             aru.domain_code, aru.rule_expression, aru.probe
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
    SELECT rc.entity_id,
           count(*)::int AS rule_count,
           count(*) FILTER (
             WHERE COALESCE((rc.result->>'passed')::boolean, false) IS NOT TRUE
           )::int AS failing_count,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'message', rc.result->>'message',
                 'actualValue', rc.result->>'actualValue'
               )
               ORDER BY aru.rule_name
             ) FILTER (
               WHERE COALESCE((rc.result->>'passed')::boolean, false) IS NOT TRUE
             ),
             '[]'::jsonb
           ) AS failing_rules
    FROM rule_checks rc
    JOIN active_rules aru ON aru.id = rc.rule_id
    GROUP BY rc.entity_id
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
           COALESCE(ec.change_count, 0) AS "changeCount",
           COALESCE(ec.changes, '[]'::jsonb) AS "changes"
    FROM scoped s
    LEFT JOIN entity_required er ON er.entity_id = s.id
    LEFT JOIN entity_missing em ON em.entity_id = s.id
    LEFT JOIN entity_rules ru ON ru.entity_id = s.id
    LEFT JOIN entity_changes ec ON ec.entity_id = s.id
  ),
  summary AS (
    SELECT
      (SELECT count(*)::int FROM scoped) AS entity_count,
      (SELECT count(*)::int FROM required_attr) AS required_slots,
      (SELECT count(*)::int FROM missing) AS missing_slots,
      (SELECT count(DISTINCT entity_id)::int FROM missing) AS entities_missing,
      (SELECT count(*)::int FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)) AS rules_evaluated,
      (SELECT count(*)::int FROM rule_checks WHERE COALESCE((result->>'passed')::boolean, false)) AS passing_checks,
      (SELECT count(*)::int FROM rule_checks WHERE COALESCE((result->>'passed')::boolean, false) IS NOT TRUE) AS failing_checks,
      (SELECT count(DISTINCT entity_id)::int FROM rule_checks WHERE COALESCE((result->>'passed')::boolean, false) IS NOT TRUE) AS entities_failing,
      (SELECT count(DISTINCT attribute_code)::int FROM changes) AS changed_attributes,
      (SELECT count(DISTINCT entity_id)::int FROM changes) AS changed_entities,
      (SELECT count(*)::int FROM changes) AS attribute_changes,
      (SELECT count(*)::int FROM entity_rows
        WHERE "missingCount" = 0 AND "failingRuleCount" = 0 AND "changeCount" = 0) AS clear_entities
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
          ELSE round(100.0 * passing_checks / (passing_checks + failing_checks), 1)
        END,
        'changedAttributeCount', changed_attributes,
        'changedEntityCount', changed_entities,
        'attributeChangeCount', attribute_changes,
        'clearEntityCount', clear_entities
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
    'entities', COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY (e."missingCount" + e."failingRuleCount" + e."changeCount") DESC, e."entityName")
      FROM entity_rows e
      WHERE e."missingCount" > 0 OR e."failingRuleCount" > 0 OR e."changeCount" > 0
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$dashboard$;

COMMENT ON FUNCTION public.data_quality_dashboard(text, date, date) IS
  'Availability of required attributes, DQ rule failures, and golden-value changes between two as-of dates.';

REVOKE ALL ON FUNCTION data_quality.evaluate_rule_clause(text, jsonb, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION data_quality.evaluate_rule_expression(text, jsonb, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.data_quality_dashboard(text, date, date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION data_quality.evaluate_rule_clause(text, jsonb, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION data_quality.evaluate_rule_expression(text, jsonb, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_dashboard(text, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
