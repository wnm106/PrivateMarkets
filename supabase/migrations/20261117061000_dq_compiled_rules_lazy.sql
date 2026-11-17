-- Keep the data quality dashboard fast as the number of rules grows.
--
-- Every active rule used to be compiled into one SQL function holding a single
-- CASE. Postgres planned the whole of it on every dashboard call, so a fund
-- with 13 rules paid for all 177. The function is now PL/pgSQL with one
-- statement per rule: a rule is planned the first time it is used and not
-- before. Rules are grouped by the first character of their id so finding one
-- takes about a dozen comparisons rather than one per rule.
--
-- Results are unchanged. Safe to run again.

CREATE OR REPLACE FUNCTION data_quality.rebuild_compiled_rules()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'data_quality', 'pg_catalog'
AS $function$
DECLARE
  v_cases text;
  v_dispatch text;
  v_sql text;
BEGIN
  SELECT string_agg(
    format(
      E'    WHEN %L THEN\n      CASE p_rule_id\n%s\n        ELSE NULL;\n      END CASE;',
      b.bucket, b.rules
    ),
    E'\n' ORDER BY b.bucket
  )
  INTO v_cases
  FROM (
    SELECT substr(id::text, 1, 1) AS bucket,
           string_agg(
             format('        WHEN %L::uuid THEN RETURN (%s);', id, compiled_sql),
             E'\n' ORDER BY rule_code
           ) AS rules
    FROM data_quality.dq_rules
    WHERE is_active IS TRUE
      AND compiled_sql IS NOT NULL
    GROUP BY substr(id::text, 1, 1)
  ) AS b;

  v_dispatch := CASE
    WHEN v_cases IS NULL THEN ''
    ELSE format(E'  CASE substr(p_rule_id::text, 1, 1)\n%s\n    ELSE NULL;\n  END CASE;', v_cases)
  END;

  v_sql := format($fn$
CREATE OR REPLACE FUNCTION data_quality.apply_compiled_rule(p_rule_id uuid, vals jsonb, as_of date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $body$
BEGIN
%s
  RETURN jsonb_build_object('passed', false, 'evaluated', false, 'message', 'Rule is not compiled', 'actualValue', NULL);
END
$body$;
$fn$, v_dispatch);

  EXECUTE v_sql;
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_quality.apply_compiled_rule(uuid, jsonb, date) TO authenticated, service_role';
END;
$function$;

SELECT data_quality.rebuild_compiled_rules();
