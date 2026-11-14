-- Preview a data quality rule before it is saved. The expression is compiled with the same
-- compiler the saved rules use and applied to the current golden values of every record the
-- caller can read, so the preview agrees with what the quality checks will report.

CREATE OR REPLACE FUNCTION public.dq_rule_preview(
  p_domain_code text,
  p_expression text,
  p_attribute_code text DEFAULT NULL,
  p_columns text[] DEFAULT NULL,
  p_as_of date DEFAULT NULL,
  p_outcome text DEFAULT 'FAIL',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '30s'
SET search_path = public, data_quality, entity_instances, metadata_register, golden_master, pg_catalog
AS $preview$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_as_of date := COALESCE(p_as_of, CURRENT_DATE);
  v_outcome text := upper(COALESCE(NULLIF(btrim(p_outcome), ''), 'FAIL'));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_attr text := lower(regexp_replace(COALESCE(p_attribute_code, ''), '[^A-Za-z0-9_]', '', 'g'));
  v_passes_blank boolean := false;
  v_columns text[];
  v_compiled text;
  v_sql text;
  v_result jsonb;
BEGIN
  IF v_outcome NOT IN ('FAIL', 'PASS', 'ALL') THEN
    RAISE EXCEPTION 'Outcome must be FAIL, PASS or ALL';
  END IF;
  IF NULLIF(btrim(COALESCE(p_expression, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Rule expression is empty';
  END IF;

  v_compiled := data_quality.compile_rule_expression(p_expression);

  -- A rule written "ATTRIBUTE IS NULL OR ..." passes when the attribute has no value at all.
  IF v_attr <> '' THEN
    v_passes_blank := p_expression ~* ('^' || v_attr || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT lower(c)), ARRAY[]::text[])
  INTO v_columns
  FROM unnest(COALESCE(p_columns, ARRAY[]::text[])) AS c;

  v_sql := format($q$
    WITH scoped AS MATERIALIZED (
      SELECT me.id, me.entity_code, me.entity_name
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
        AND ($1 IS NULL OR me.domain_code = $1)
    ),
    resolved AS MATERIALIZED (
      SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
        eav.entity_id,
        eav.attribute_id,
        NULLIF(btrim(eav.golden_value), '') AS golden_value
      FROM golden_master.entity_attribute_values eav
      JOIN scoped s ON s.id = eav.entity_id
      WHERE eav.system_to = '9999-12-31 23:59:59'
        AND eav.valid_from <= $2
        AND eav.valid_to >= $2
      ORDER BY eav.entity_id, eav.attribute_id, eav.precedence_rank ASC, eav.valid_from DESC
    ),
    value_map AS MATERIALIZED (
      SELECT rv.entity_id,
             jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS vals
      FROM resolved rv
      JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
      WHERE rv.golden_value IS NOT NULL
      GROUP BY rv.entity_id
    ),
    checked AS (
      SELECT s.id, s.entity_code, s.entity_name,
             COALESCE(vm.vals, '{}'::jsonb) AS vals,
             $2::date AS as_of
      FROM scoped s
      LEFT JOIN value_map vm ON vm.entity_id = s.id
    ),
    evaluated AS MATERIALIZED (
      SELECT c.id, c.entity_code, c.entity_name, c.vals,
             CASE
               WHEN $3::boolean AND NOT jsonb_exists(c.vals, $4)
                 THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE (%s)
             END AS result
      FROM checked c
    ),
    outcome AS (
      SELECT e.*, COALESCE((e.result ->> 'passed')::boolean, false) AS passed
      FROM evaluated e
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM outcome),
      'passed', (SELECT count(*) FROM outcome WHERE passed),
      'failed', (SELECT count(*) FROM outcome WHERE NOT passed),
      'rows', COALESCE((
        SELECT jsonb_agg(r.row ORDER BY r.entity_code, r.id)
        FROM (
          SELECT o.id, o.entity_code,
                 jsonb_build_object(
                   'entityId', o.id,
                   'entityCode', o.entity_code,
                   'entityName', o.entity_name,
                   'passed', o.passed,
                   'message', o.result ->> 'message',
                   'actualValue', o.result ->> 'actualValue',
                   'values', COALESCE((
                     SELECT jsonb_object_agg(k, o.vals -> k)
                     FROM unnest($5::text[]) AS k
                     WHERE jsonb_exists(o.vals, k)
                   ), '{}'::jsonb)
                 ) AS row
          FROM outcome o
          WHERE $6 = 'ALL' OR ($6 = 'FAIL' AND NOT o.passed) OR ($6 = 'PASS' AND o.passed)
          ORDER BY o.entity_code, o.id
          LIMIT %s OFFSET %s
        ) r
      ), '[]'::jsonb)
    )
  $q$, v_compiled, v_limit, v_offset);

  EXECUTE v_sql INTO v_result USING v_domain, v_as_of, v_passes_blank, v_attr, v_columns, v_outcome;
  RETURN v_result;
END;
$preview$;

GRANT EXECUTE ON FUNCTION public.dq_rule_preview(text, text, text, text[], date, text, integer, integer) TO authenticated, service_role;
