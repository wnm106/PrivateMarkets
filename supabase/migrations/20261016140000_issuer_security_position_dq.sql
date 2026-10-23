-- Issuer, Security, and Position data quality
-- A starter set of completeness (via required template attributes) and
-- validity rules an asset manager can act on, plus a two-day sample book.
-- Validity rules pass when the attribute is blank, so a sparse feed is not
-- flagged thousands of times. Required template attributes cover completeness
-- for entities on the standard templates. Waived and false-positive
-- exceptions are left out of the failing counts for the as-of date.

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

  IF EXISTS (SELECT 1 FROM unnest(v_messages) AS m(msg) WHERE m.msg !~ ' is present$') THEN
    SELECT COALESCE(array_agg(m.msg), ARRAY[]::text[])
      INTO v_messages
    FROM unnest(v_messages) AS m(msg)
    WHERE m.msg !~ ' is present$';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT a.val), ARRAY[]::text[])
    INTO v_actuals
  FROM unnest(v_actuals) AS a(val);

  RETURN jsonb_build_object(
    'passed', false,
    'evaluated', true,
    'message', NULLIF(array_to_string(v_messages, '; '), ''),
    'actualValue', NULLIF(array_to_string(v_actuals, '; '), '')
  );
END;
$expr$;

GRANT EXECUTE ON FUNCTION data_quality.evaluate_rule_expression(text, jsonb, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.data_quality_dashboard(
  p_domain_code text DEFAULT NULL,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, data_quality, entity_instances, metadata_register, golden_master, pg_catalog
AS $dashboard$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_swap date;
  v_result jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '20000', true);
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
           r.rule_expression, r.rule_description, ar.attribute_code, ar.attribute_name,
           data_quality.evaluate_rule_expression(r.rule_expression, '{}'::jsonb, v_to) AS probe
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
  rule_checks AS (
    SELECT aru.id AS rule_id,
           s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           CASE
             WHEN aru.attribute_code IS NOT NULL
              AND NOT COALESCE(vm.values, '{}'::jsonb) ? lower(aru.attribute_code)
              AND aru.rule_expression ~* ('^' || aru.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')
             THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
             ELSE data_quality.evaluate_rule_expression(aru.rule_expression, COALESCE(vm.values, '{}'::jsonb), v_to)
           END AS result
    FROM active_rules aru
    JOIN scoped s ON aru.domain_code IS NULL OR s.domain_code = aru.domain_code
    LEFT JOIN value_map vm ON vm.entity_id = s.id
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
      AND NOT EXISTS (
        SELECT 1 FROM accepted ax
        WHERE ax.rule_id = aru.id AND ax.entity_id = s.id
      )
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
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
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
             aru.domain_code, aru.rule_expression, aru.rule_description,
             aru.attribute_code, aru.attribute_name, aru.probe
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
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
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
           COALESCE(ec.changes, '[]'::jsonb) AS "changes"
    FROM scoped s
    LEFT JOIN entity_required er ON er.entity_id = s.id
    LEFT JOIN entity_missing em ON em.entity_id = s.id
    LEFT JOIN entity_rules ru ON ru.entity_id = s.id
    LEFT JOIN entity_accepted ea ON ea.entity_id = s.id
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
  'Availability of required attributes, DQ rule failures, and golden-value changes between two as-of dates. Waived and false-positive exceptions are excluded.';

GRANT EXECUTE ON FUNCTION public.data_quality_dashboard(text, date, date) TO authenticated, service_role;
-- Required attributes on the standard templates. Completeness is measured here
-- so it only applies to entities that use the template, not the whole feed.
UPDATE metadata_register.template_attribute_assignments taa
SET is_required = TRUE
FROM metadata_register.domain_templates t,
     metadata_register.attribute_register ar
WHERE taa.template_id = t.id
  AND taa.attribute_id = ar.id
  AND (
    (t.template_code = 'ISSUER_STANDARD' AND ar.attribute_code IN ('ISSUER_LEGAL_NAME', 'LEI', 'COUNTRY', 'SECTOR'))
    OR (t.template_code = 'SECURITY_STANDARD' AND ar.attribute_code IN ('INSTRUMENT_TYPE', 'CURRENCY', 'MATURITY_DATE'))
    OR (t.template_code = 'POSITION_STANDARD' AND ar.attribute_code IN ('POSITION_CURRENCY', 'TRADE_DATE', 'MARKET_VALUE'))
  );

-- Validity rules. A blank value passes; a present value has to be usable.
INSERT INTO data_quality.dq_rules (
  rule_code, rule_name, domain_code, attribute_id, rule_type, rule_severity, rule_expression, rule_description
)
SELECT v.rule_code, v.rule_name, v.domain_code, ar.id, v.rule_type, v.rule_severity, v.rule_expression, v.rule_description
FROM (VALUES
  ('SECURITY_ISIN_FORMAT', 'ISIN Format Validation', 'SECURITY', 'ISIN', 'VALIDITY', 'HIGH',
    $e$ISIN IS NULL OR ISIN ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'$e$,
    $e$When an ISIN is present it must be 12 characters: two letters, nine letters or digits, and a numeric check digit.$e$),
  ('ISSUER_LEI_FORMAT', 'LEI Format', 'ISSUER', 'LEI', 'VALIDITY', 'HIGH',
    $e$LEI IS NULL OR LEI ~ '^[A-Z0-9]{18}[0-9]{2}$'$e$,
    $e$A Legal Entity Identifier is 20 characters, and the last two are check digits. Blank LEIs are a completeness gap, not a format error.$e$),
  ('ISSUER_COUNTRY_ISO', 'Country Is ISO Code', 'ISSUER', 'COUNTRY', 'VALIDITY', 'HIGH',
    $e$COUNTRY IS NULL OR COUNTRY IN ('US','GB','DE','FR','IE','LU','KY','NL','CH','SE','NO','DK','FI','IT','ES','PT','BE','AT','JP','AU','SG','HK','CN','CA','BM','JE','GG','IN','BR','MX','KR','NZ')$e$,
    $e$Country of incorporation should be an ISO country code such as US, not a country name.$e$),
  ('ISSUER_SECTOR_GICS', 'Sector Is GICS', 'ISSUER', 'SECTOR', 'VALIDITY', 'MEDIUM',
    $e$SECTOR IS NULL OR SECTOR IN ('INDUSTRIALS','INFORMATION_TECHNOLOGY','ENERGY','MATERIALS','FINANCIALS','COMMUNICATION_SERVICES','UTILITIES','REAL_ESTATE','HEALTH_CARE','CONSUMER_STAPLES','CONSUMER_DISCRETIONARY')$e$,
    $e$Sector should be a GICS sector so concentration reports group the same way every time.$e$),
  ('ISSUER_RATING_SCALE', 'Rating On The Scale', 'ISSUER', 'CREDIT_RATING', 'VALIDITY', 'HIGH',
    $e$CREDIT_RATING IS NULL OR CREDIT_RATING IN ('AAA','AA+','AA','AA-','A+','A','A-','BBB+','BBB','BBB-','BB+','BB','BB-','B+','B','B-','CCC+','CCC','CCC-','CC','C','D','NR','AA_PLUS','AA_MINUS','A_PLUS','A_MINUS','BBB_PLUS','BBB_MINUS','BB_PLUS','BB_MINUS','B_PLUS','B_MINUS','CCC_PLUS','CCC_MINUS')$e$,
    $e$Credit rating should be a known scale point, including NR when the issuer is unrated.$e$),
  ('ISSUER_MARKET_CAP_NONNEGATIVE', 'Market Cap Not Negative', 'ISSUER', 'MARKET_CAP', 'VALIDITY', 'HIGH',
    $e$MARKET_CAP IS NULL OR MARKET_CAP >= 0$e$,
    $e$Market capitalization cannot be negative.$e$),
  ('ISSUER_LEVERAGE_NONNEGATIVE', 'Net Leverage Not Negative', 'ISSUER', 'TOTAL_NET_LEVERAGE_RATIO', 'VALIDITY', 'MEDIUM',
    $e$TOTAL_NET_LEVERAGE_RATIO IS NULL OR TOTAL_NET_LEVERAGE_RATIO >= 0$e$,
    $e$Total net leverage is a ratio of debt to EBITDA and should not be stored as a negative number.$e$),
  ('ISSUER_COVERAGE_NONNEGATIVE', 'Interest Coverage Not Negative', 'ISSUER', 'INTEREST_COVERAGE_RATIO', 'VALIDITY', 'MEDIUM',
    $e$INTEREST_COVERAGE_RATIO IS NULL OR INTEREST_COVERAGE_RATIO >= 0$e$,
    $e$Interest coverage should not be stored as a negative number.$e$),
  ('ISSUER_FINANCIALS_NOT_FUTURE', 'Financials Not Future Dated', 'ISSUER', 'FINANCIAL_REPORTING_PERIOD_DATE', 'TIMELINESS', 'HIGH',
    $e$FINANCIAL_REPORTING_PERIOD_DATE IS NULL OR FINANCIAL_REPORTING_PERIOD_DATE <= CURRENT_DATE$e$,
    $e$The latest financial statement date cannot be in the future.$e$),
  ('SECURITY_CUSIP_FORMAT', 'CUSIP Format', 'SECURITY', 'CUSIP', 'VALIDITY', 'HIGH',
    $e$CUSIP IS NULL OR CUSIP ~ '^[A-Z0-9]{9}$'$e$,
    $e$A CUSIP is nine letters or digits.$e$),
  ('SECURITY_CURRENCY_ISO', 'Currency Is ISO', 'SECURITY', 'CURRENCY', 'VALIDITY', 'HIGH',
    $e$CURRENCY IS NULL OR CURRENCY IN ('USD','EUR','GBP','JPY','AUD','NOK','SGD','CAD','CHF','SEK','DKK','HKD')$e$,
    $e$Denomination currency should be an ISO code such as USD.$e$),
  ('SECURITY_INSTRUMENT_TYPE', 'Instrument Type Known', 'SECURITY', 'INSTRUMENT_TYPE', 'VALIDITY', 'HIGH',
    $e$INSTRUMENT_TYPE IS NULL OR INSTRUMENT_TYPE IN ('BOND','LOAN','EQUITY','DERIVATIVE','UNITRANCHE','REVOLVING_CREDIT','MEZZANINE','PREFERRED_EQUITY')$e$,
    $e$Instrument type should be one of the standard classifications used for exposure reports.$e$),
  ('SECURITY_COUPON_NONNEGATIVE', 'Coupon Not Negative', 'SECURITY', 'COUPON_RATE', 'VALIDITY', 'MEDIUM',
    $e$COUPON_RATE IS NULL OR COUPON_RATE >= 0$e$,
    $e$Coupon rate cannot be negative.$e$),
  ('SECURITY_SPREAD_NONNEGATIVE', 'Spread Not Negative', 'SECURITY', 'SPREAD_BPS', 'VALIDITY', 'MEDIUM',
    $e$SPREAD_BPS IS NULL OR SPREAD_BPS >= 0$e$,
    $e$Credit spread in basis points cannot be negative.$e$),
  ('SECURITY_PRICE_NONNEGATIVE', 'Price Not Negative', 'SECURITY', 'PRICE', 'VALIDITY', 'HIGH',
    $e$PRICE IS NULL OR PRICE >= 0$e$,
    $e$A security price cannot be negative.$e$),
  ('SECURITY_ISSUANCE_NOT_FUTURE', 'Issuance Not Future', 'SECURITY', 'ISSUANCE_DATE', 'VALIDITY', 'HIGH',
    $e$ISSUANCE_DATE IS NULL OR ISSUANCE_DATE <= CURRENT_DATE$e$,
    $e$Issuance date cannot be in the future.$e$),
  ('SECURITY_MATURITY_PLAUSIBLE', 'Maturity Is Plausible', 'SECURITY', 'MATURITY_DATE', 'VALIDITY', 'MEDIUM',
    $e$MATURITY_DATE IS NULL OR MATURITY_DATE >= '1990-01-01'$e$,
    $e$Maturity should be a real date on or after 1990. Dates before that are almost always a bad load.$e$),
  ('SECURITY_PRINCIPAL_POSITIVE', 'Original Principal Positive', 'SECURITY', 'ORIGINAL_PRINCIPAL_AMOUNT', 'VALIDITY', 'HIGH',
    $e$ORIGINAL_PRINCIPAL_AMOUNT IS NULL OR ORIGINAL_PRINCIPAL_AMOUNT > 0$e$,
    $e$Original principal, when present, has to be greater than zero.$e$),
  ('POSITION_MARKET_VALUE_NONNEGATIVE', 'Market Value Not Negative', 'POSITION', 'MARKET_VALUE', 'VALIDITY', 'HIGH',
    $e$MARKET_VALUE IS NULL OR MARKET_VALUE >= 0$e$,
    $e$Position market value cannot be negative in this long-only book.$e$),
  ('POSITION_QUANTITY_NONNEGATIVE', 'Quantity Not Negative', 'POSITION', 'QUANTITY', 'VALIDITY', 'HIGH',
    $e$QUANTITY IS NULL OR QUANTITY >= 0$e$,
    $e$Position quantity cannot be negative in this long-only book.$e$),
  ('POSITION_COST_NONNEGATIVE', 'Cost Basis Not Negative', 'POSITION', 'COST_BASIS', 'VALIDITY', 'HIGH',
    $e$COST_BASIS IS NULL OR COST_BASIS >= 0$e$,
    $e$Cost basis cannot be negative.$e$),
  ('POSITION_CURRENCY_ISO', 'Position Currency Is ISO', 'POSITION', 'POSITION_CURRENCY', 'VALIDITY', 'HIGH',
    $e$POSITION_CURRENCY IS NULL OR POSITION_CURRENCY IN ('USD','EUR','GBP','JPY','AUD','NOK','SGD','CAD','CHF','SEK','DKK','HKD')$e$,
    $e$Position currency should be an ISO code such as USD.$e$),
  ('POSITION_TYPE_ALLOWED', 'Position Type Known', 'POSITION', 'POSITION_TYPE', 'VALIDITY', 'MEDIUM',
    $e$POSITION_TYPE IS NULL OR POSITION_TYPE IN ('EQUITY','DEBT','OTHER')$e$,
    $e$Position type should be Equity, Debt, or Other.$e$),
  ('POSITION_TRADE_NOT_FUTURE', 'Trade Date Not Future', 'POSITION', 'TRADE_DATE', 'VALIDITY', 'HIGH',
    $e$TRADE_DATE IS NULL OR TRADE_DATE <= CURRENT_DATE$e$,
    $e$Trade date cannot be in the future.$e$),
  ('POSITION_PRICE_NONNEGATIVE', 'Fair Price Not Negative', 'POSITION', 'FAIR_MARKET_PRICE', 'VALIDITY', 'HIGH',
    $e$FAIR_MARKET_PRICE IS NULL OR FAIR_MARKET_PRICE >= 0$e$,
    $e$Fair market price cannot be negative.$e$),
  ('POSITION_VALUATION_LEVEL', 'Valuation Level Known', 'POSITION', 'VALUATION_HIERARCHY_LEVEL', 'VALIDITY', 'HIGH',
    $e$VALUATION_HIERARCHY_LEVEL IS NULL OR VALUATION_HIERARCHY_LEVEL IN ('Level_1','Level_2','Level_3','1','2','3')$e$,
    $e$GAAP fair-value level should be Level 1, Level 2, or Level 3.$e$),
  ('POSITION_FUNDED_PAR_NONNEGATIVE', 'Funded Par Not Negative', 'POSITION', 'FUNDED_PAR_AMOUNT', 'VALIDITY', 'HIGH',
    $e$FUNDED_PAR_AMOUNT IS NULL OR FUNDED_PAR_AMOUNT >= 0$e$,
    $e$Funded par cannot be negative.$e$),
  ('POSITION_DAILY_RETURN_RANGE', 'Daily Return In Range', 'POSITION', 'DAILY_RETURN', 'VALIDITY', 'MEDIUM',
    $e$DAILY_RETURN IS NULL OR DAILY_RETURN >= -100 AND DAILY_RETURN <= 100$e$,
    $e$Daily return is a percent and should sit between -100 and 100. A larger number is usually a units error.$e$),
  ('POSITION_METRIC_NOT_FUTURE', 'Metric Date Not Future', 'POSITION', 'METRIC_DATE', 'TIMELINESS', 'HIGH',
    $e$METRIC_DATE IS NULL OR METRIC_DATE <= CURRENT_DATE$e$,
    $e$The date the position metrics were measured cannot be in the future.$e$)
) AS v(rule_code, rule_name, domain_code, attribute_code, rule_type, rule_severity, rule_expression, rule_description)
LEFT JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
ON CONFLICT (rule_code) DO UPDATE
SET rule_name = EXCLUDED.rule_name,
    domain_code = EXCLUDED.domain_code,
    attribute_id = EXCLUDED.attribute_id,
    rule_type = EXCLUDED.rule_type,
    rule_severity = EXCLUDED.rule_severity,
    rule_expression = EXCLUDED.rule_expression,
    rule_description = EXCLUDED.rule_description,
    is_active = TRUE,
    updated_at = NOW();

-- Two as-of dates: 15 Oct 2026 and 16 Oct 2026. Stable attributes cover both
-- days. Attributes that move have a row for the 15th and a new row from the 16th.
INSERT INTO entity_instances.master_entities (
  entity_code, domain_code, template_id, entity_name, description, client_id, metadata
)
SELECT v.entity_code, v.domain_code, t.id, v.entity_name, v.description,
       '6c6bac30-6911-4cd7-97e5-d5447a8f06fb'::uuid,
       '{"dqSample":true}'::jsonb
FROM (VALUES
  ('DQ-ISS-NORTHWIND', 'ISSUER', 'ISSUER_STANDARD', 'Northwind Packaging LLC', 'Clean issuer. Market cap and leverage move between 15 and 16 Oct 2026.'),
  ('DQ-ISS-HARBOR', 'ISSUER', 'ISSUER_STANDARD', 'Harborline Foods Inc', 'Issuer with format, scale, and sign errors to resolve.'),
  ('DQ-ISS-CEDAR', 'ISSUER', 'ISSUER_STANDARD', 'Cedar Ridge Holdings', 'Issuer missing legal name and LEI. Rating moves from B to B+.'),
  ('DQ-SEC-NORTHWIND', 'SECURITY', 'SECURITY_STANDARD', 'Northwind First Lien TLB 2030', 'Clean loan. Spread and price move between the two days.'),
  ('DQ-SEC-HARBOR', 'SECURITY', 'SECURITY_STANDARD', 'Harborline Mezzanine 2028', 'Security with bad identifiers, currency, dates, and a negative price.'),
  ('DQ-SEC-CEDAR', 'SECURITY', 'SECURITY_STANDARD', 'Cedar Ridge Revolver 2029', 'Clean revolver. Price moves between the two days.'),
  ('DQ-POS-NORTHWIND', 'POSITION', 'POSITION_STANDARD', 'Northwind TLB - Fund I', 'Clean debt position. Market value and price move between the two days.'),
  ('DQ-POS-HARBOR', 'POSITION', 'POSITION_STANDARD', 'Harborline Mezzanine - Fund I', 'Position with negative value, a future trade date, and a bad valuation level.'),
  ('DQ-POS-CEDAR', 'POSITION', 'POSITION_STANDARD', 'Cedar Ridge Revolver - Fund I', 'Clean debt position. Market value moves between the two days.')
) AS v(entity_code, domain_code, template_code, entity_name, description)
JOIN metadata_register.domain_templates t ON t.template_code = v.template_code
ON CONFLICT (entity_code) DO UPDATE
SET template_id = EXCLUDED.template_id,
    entity_name = EXCLUDED.entity_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    is_active = TRUE,
    metadata = EXCLUDED.metadata;

DELETE FROM golden_master.entity_attribute_values eav
USING entity_instances.master_entities me
WHERE eav.entity_id = me.id
  AND me.entity_code LIKE 'DQ-%';

INSERT INTO golden_master.entity_attribute_values (
  entity_id, attribute_id, source_id, golden_value, valid_from, valid_to, precedence_rank, metadata
)
SELECT me.id, ar.id, src.id, v.golden_value, v.valid_from, v.valid_to, 100, '{"dqSample":true}'::jsonb
FROM (VALUES
  ('DQ-ISS-NORTHWIND', 'ISSUER_LEGAL_NAME', 'Northwind Packaging LLC', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'LEI', '549300NORTHWIND00001', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'COUNTRY', 'US', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'SECTOR', 'INDUSTRIALS', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'CREDIT_RATING', 'BB', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'FINANCIAL_REPORTING_PERIOD_DATE', '2026-09-30', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'INTEREST_COVERAGE_RATIO', '2.40', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'EBITDA_LTM', '42000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'MARKET_CAP', '850000000', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-ISS-NORTHWIND', 'MARKET_CAP', '865000000', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-ISS-NORTHWIND', 'TOTAL_NET_LEVERAGE_RATIO', '4.20', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-ISS-NORTHWIND', 'TOTAL_NET_LEVERAGE_RATIO', '4.35', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-ISS-HARBOR', 'ISSUER_LEGAL_NAME', 'Harborline Foods Inc', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'LEI', 'HARBOR', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'COUNTRY', 'United States', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'SECTOR', 'Widgets', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'CREDIT_RATING', 'ZZZ', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'FINANCIAL_REPORTING_PERIOD_DATE', '2026-12-31', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'INTEREST_COVERAGE_RATIO', '-0.40', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'EBITDA_LTM', '1000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'TOTAL_NET_LEVERAGE_RATIO', '-1', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-HARBOR', 'MARKET_CAP', '-5000000', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-ISS-HARBOR', 'MARKET_CAP', '-4800000', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-ISS-CEDAR', 'COUNTRY', 'US', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'SECTOR', 'ENERGY', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'MARKET_CAP', '210000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'FINANCIAL_REPORTING_PERIOD_DATE', '2026-06-30', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'INTEREST_COVERAGE_RATIO', '1.80', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'TOTAL_NET_LEVERAGE_RATIO', '5.10', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'EBITDA_LTM', '18000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-ISS-CEDAR', 'CREDIT_RATING', 'B', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-ISS-CEDAR', 'CREDIT_RATING', 'B+', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-SEC-NORTHWIND', 'ISIN', 'US0NWN000001', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'CUSIP', '00000NWN1', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'CURRENCY', 'USD', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'INSTRUMENT_TYPE', 'LOAN', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'MATURITY_DATE', '2030-06-15', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'ISSUANCE_DATE', '2024-06-15', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'COUPON_RATE', '8.50', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'ORIGINAL_PRINCIPAL_AMOUNT', '150000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'SPREAD_BPS', '450', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-SEC-NORTHWIND', 'SPREAD_BPS', '475', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-SEC-NORTHWIND', 'PRICE', '99.25', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-SEC-NORTHWIND', 'PRICE', '99.50', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-SEC-HARBOR', 'ISIN', 'NOT-AN-ISIN', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'CUSIP', 'BAD', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'CURRENCY', 'US$', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'INSTRUMENT_TYPE', 'Mezz Note', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'MATURITY_DATE', '1980-01-01', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'ISSUANCE_DATE', '2027-01-01', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'COUPON_RATE', '-2', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'SPREAD_BPS', '-25', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'ORIGINAL_PRINCIPAL_AMOUNT', '0', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-HARBOR', 'PRICE', '-10', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-SEC-HARBOR', 'PRICE', '-8', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-SEC-CEDAR', 'ISIN', 'US0CDR000001', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'CUSIP', '00000CDR1', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'CURRENCY', 'USD', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'INSTRUMENT_TYPE', 'REVOLVING_CREDIT', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'MATURITY_DATE', '2029-03-31', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'ISSUANCE_DATE', '2025-03-31', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'COUPON_RATE', '7.25', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'SPREAD_BPS', '375', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'ORIGINAL_PRINCIPAL_AMOUNT', '40000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-SEC-CEDAR', 'PRICE', '100.00', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-SEC-CEDAR', 'PRICE', '100.25', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-POS-NORTHWIND', 'QUANTITY', '12500000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'COST_BASIS', '12375000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'POSITION_CURRENCY', 'USD', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'TRADE_DATE', '2024-06-20', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'VALUATION_HIERARCHY_LEVEL', 'Level_2', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'FUNDED_PAR_AMOUNT', '12500000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'POSITION_TYPE', 'DEBT', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'DAILY_RETURN', '0.15', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'MARKET_VALUE', '12500000', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-NORTHWIND', 'MARKET_VALUE', '12625000', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'FAIR_MARKET_PRICE', '99.25', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-NORTHWIND', 'FAIR_MARKET_PRICE', '99.50', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-POS-NORTHWIND', 'METRIC_DATE', '2026-10-15', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-NORTHWIND', 'METRIC_DATE', '2026-10-16', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-POS-HARBOR', 'QUANTITY', '-100', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'COST_BASIS', '-1', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'POSITION_CURRENCY', 'BUCKS', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'TRADE_DATE', '2026-12-01', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'FAIR_MARKET_PRICE', '-5', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'VALUATION_HIERARCHY_LEVEL', 'Tier_9', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'FUNDED_PAR_AMOUNT', '-1000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'POSITION_TYPE', 'Short', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'DAILY_RETURN', '250', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'MARKET_VALUE', '-2500000', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-HARBOR', 'MARKET_VALUE', '-2400000', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-POS-HARBOR', 'METRIC_DATE', '2026-10-15', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-HARBOR', 'METRIC_DATE', '2027-01-01', DATE '2026-10-16', DATE '9999-12-31'),

  ('DQ-POS-CEDAR', 'QUANTITY', '4000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'COST_BASIS', '3980000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'POSITION_CURRENCY', 'USD', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'TRADE_DATE', '2025-04-02', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'FAIR_MARKET_PRICE', '100.00', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'VALUATION_HIERARCHY_LEVEL', 'Level_3', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'FUNDED_PAR_AMOUNT', '4000000', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'POSITION_TYPE', 'DEBT', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'DAILY_RETURN', '0.40', DATE '2026-10-15', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'MARKET_VALUE', '4000000', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-CEDAR', 'MARKET_VALUE', '4120000', DATE '2026-10-16', DATE '9999-12-31'),
  ('DQ-POS-CEDAR', 'METRIC_DATE', '2026-10-15', DATE '2026-10-15', DATE '2026-10-15'),
  ('DQ-POS-CEDAR', 'METRIC_DATE', '2026-10-16', DATE '2026-10-16', DATE '9999-12-31')
) AS v(entity_code, attribute_code, golden_value, valid_from, valid_to)
JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
JOIN entity_instances.source_registry src ON src.source_code = 'TEST';
NOTIFY pgrst, 'reload schema';
