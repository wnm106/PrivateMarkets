-- Data quality spends most of its time parsing the same rule once per entity,
-- and a past as-of date needs its own plan so the open-history index is used.

CREATE INDEX IF NOT EXISTS idx_eav_open_system_resolution
  ON golden_master.entity_attribute_values (entity_id, attribute_id, precedence_rank, valid_from DESC)
  INCLUDE (valid_to)
  WHERE system_to = '9999-12-31 23:59:59+00';

CREATE OR REPLACE FUNCTION data_quality.try_fast_rule(
  p_expr text,
  p_values jsonb,
  p_as_of date
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fast$
DECLARE
  v_m text[];
  v_attr text;
  v_value text;
  v_op text;
  v_rhs text;
  v_num numeric;
  v_rhs_num numeric;
  v_date date;
  v_rhs_date date;
  v_ok boolean;
  v_item text;
BEGIN
  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 (>=|<=|>|<|=) (-?[0-9]+(?:[.][0-9]+)?) AND \1 (>=|<=|>|<|=) (-?[0-9]+(?:[.][0-9]+)?)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    IF v_value !~ '^-?[0-9]+([.][0-9]+)?$' THEN
      RETURN jsonb_build_object('passed', false, 'evaluated', true, 'message', v_attr || ' is not a number', 'actualValue', v_value);
    END IF;
    v_num := v_value::numeric;
    v_ok := CASE v_m[2]
      WHEN '>' THEN v_num > v_m[3]::numeric
      WHEN '>=' THEN v_num >= v_m[3]::numeric
      WHEN '<' THEN v_num < v_m[3]::numeric
      WHEN '<=' THEN v_num <= v_m[3]::numeric
      ELSE v_num = v_m[3]::numeric
    END;
    IF v_ok THEN
      v_ok := CASE v_m[4]
        WHEN '>' THEN v_num > v_m[5]::numeric
        WHEN '>=' THEN v_num >= v_m[5]::numeric
        WHEN '<' THEN v_num < v_m[5]::numeric
        WHEN '<=' THEN v_num <= v_m[5]::numeric
        ELSE v_num = v_m[5]::numeric
      END;
      IF NOT v_ok THEN
        v_op := v_m[4];
        v_rhs := v_m[5];
      END IF;
    ELSE
      v_op := v_m[2];
      v_rhs := v_m[3];
    END IF;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' failed ' || v_op || ' ' || v_rhs END,
      'actualValue', CASE WHEN v_ok THEN NULL ELSE v_value END
    );
  END IF;

  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 (>=|<=|>|<|=) (-?[0-9]+(?:[.][0-9]+)?)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    IF v_value !~ '^-?[0-9]+([.][0-9]+)?$' THEN
      RETURN jsonb_build_object('passed', false, 'evaluated', true, 'message', v_attr || ' is not a number', 'actualValue', v_value);
    END IF;
    v_num := v_value::numeric;
    v_rhs_num := v_rhs::numeric;
    v_ok := CASE v_op
      WHEN '>' THEN v_num > v_rhs_num
      WHEN '>=' THEN v_num >= v_rhs_num
      WHEN '<' THEN v_num < v_rhs_num
      WHEN '<=' THEN v_num <= v_rhs_num
      ELSE v_num = v_rhs_num
    END;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' failed ' || v_op || ' ' || v_rhs END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 (>=|<=|>|<|=) CURRENT_DATE$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    IF v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$' THEN
      RETURN jsonb_build_object('passed', false, 'evaluated', true, 'message', v_attr || ' is not a date', 'actualValue', v_value);
    END IF;
    v_date := v_value::date;
    v_ok := CASE v_op
      WHEN '>' THEN v_date > p_as_of
      WHEN '>=' THEN v_date >= p_as_of
      WHEN '<' THEN v_date < p_as_of
      WHEN '<=' THEN v_date <= p_as_of
      ELSE v_date = p_as_of
    END;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' failed ' || v_op || ' CURRENT_DATE (' || p_as_of::text || ')' END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 (>=|<=|>|<|=) ''([0-9]{4}-[0-9]{2}-[0-9]{2})''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs_date := v_m[3]::date;
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    IF v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$' THEN
      RETURN jsonb_build_object('passed', false, 'evaluated', true, 'message', v_attr || ' is not a date', 'actualValue', v_value);
    END IF;
    v_date := v_value::date;
    v_ok := CASE v_op
      WHEN '>' THEN v_date > v_rhs_date
      WHEN '>=' THEN v_date >= v_rhs_date
      WHEN '<' THEN v_date < v_rhs_date
      WHEN '<=' THEN v_date <= v_rhs_date
      ELSE v_date = v_rhs_date
    END;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' failed ' || v_op || ' ' || v_m[3] END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 ~ ''((?:[^'']|'')*)''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_rhs := replace(v_m[2], '''''', '''');
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    BEGIN
      v_ok := v_value ~ v_rhs;
    EXCEPTION WHEN invalid_regular_expression THEN
      RETURN jsonb_build_object('passed', false, 'evaluated', false, 'message', 'Invalid regular expression on ' || v_attr, 'actualValue', v_value);
    END;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' does not match the expected format' END,
      'actualValue', v_value
    );
  END IF;

  v_m := regexp_match(p_expr, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL OR \1 IN \((.*)\)[[:space:]]*$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    IF v_value IS NULL THEN
      RETURN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL);
    END IF;
    v_ok := false;
    FOR v_item IN
      SELECT match[1] FROM regexp_matches(v_m[2], '''([^'']*)''', 'g') AS match
    LOOP
      IF lower(v_value) = lower(replace(v_item, '''''', '''')) THEN
        v_ok := true;
      END IF;
    END LOOP;
    RETURN jsonb_build_object(
      'passed', v_ok,
      'evaluated', true,
      'message', CASE WHEN v_ok THEN NULL ELSE v_attr || ' is not an allowed value' END,
      'actualValue', v_value
    );
  END IF;

  RETURN NULL;
END;
$fast$;

GRANT EXECUTE ON FUNCTION data_quality.try_fast_rule(text, jsonb, date) TO authenticated, service_role;

DO $patch$
DECLARE
  s text;
  r record;
BEGIN
  FOR r IN
    SELECT oid, proname
    FROM pg_proc
    WHERE proname = 'evaluate_rule_expression'
      AND pg_get_function_identity_arguments(oid) = 'p_expression text, p_values jsonb, p_as_of date'
  LOOP
    s := pg_get_functiondef(r.oid);
    IF position('try_fast_rule' in s) = 0 THEN
      s := replace(s, 'v_actuals text[] := ARRAY[]::text[];', 'v_actuals text[] := ARRAY[]::text[];' || E'\n  v_fast jsonb;');
      s := replace(
        s,
        E'END IF;\n\n  v_or_parts := regexp_split_to_array',
        E'END IF;\n\n  v_fast := data_quality.try_fast_rule(v_expr, COALESCE(p_values, ''{}''::jsonb), p_as_of);\n  IF v_fast IS NOT NULL THEN\n    RETURN v_fast;\n  END IF;\n\n  v_or_parts := regexp_split_to_array'
      );
      EXECUTE s;
    END IF;
  END LOOP;

  FOR r IN
    SELECT oid, proname
    FROM pg_proc
    WHERE proname IN ('data_quality_dashboard', 'stale_attributes')
  LOOP
    s := pg_get_functiondef(r.oid);
    IF position('plan_cache_mode' in s) = 0 THEN
      s := replace(
        s,
        'PERFORM set_config(''statement_timeout'', ''45000'', true);',
        'PERFORM set_config(''statement_timeout'', ''45000'', true);' || E'\n  PERFORM set_config(''plan_cache_mode'', ''force_custom_plan'', true);'
      );
    END IF;
    IF r.proname = 'data_quality_dashboard' AND position('passes_when_blank' in s) = 0 THEN
      s := replace(
        s,
        'data_quality.evaluate_rule_expression(r.rule_expression, ''{}''::jsonb, v_to) AS probe',
        'data_quality.evaluate_rule_expression(r.rule_expression, ''{}''::jsonb, v_to) AS probe,' || E'\n           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* (''^'' || ar.attribute_code || ''[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]'')) AS passes_when_blank'
      );
      s := replace(
        s,
        'AND aru.rule_expression ~* (''^'' || aru.attribute_code || ''[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]'')',
        'AND aru.passes_when_blank'
      );
    END IF;
    EXECUTE s;
  END LOOP;
END;
$patch$;
