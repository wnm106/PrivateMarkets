-- Compile each data quality expression into SQL when the rule is saved.
-- The dashboard executes that stored SQL instead of interpreting the text per entity.
-- Fragments may only refer to the dispatcher parameters vals (jsonb) and as_of (date).

ALTER TABLE data_quality.dq_rules
  ADD COLUMN IF NOT EXISTS compiled_sql text;

COMMENT ON COLUMN data_quality.dq_rules.compiled_sql IS
  'Server-composed jsonb SQL for this expression. Rebuilt from rule_expression on save. Uses vals and as_of.';

CREATE OR REPLACE FUNCTION data_quality.split_rule_expr(p_expr text, p_keyword text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $split$
DECLARE
  i integer := 1;
  n integer := length(p_expr);
  in_quote boolean := false;
  buf text := '';
  parts text[] := ARRAY[]::text[];
  kw text := ' ' || upper(p_keyword) || ' ';
BEGIN
  WHILE i <= n LOOP
    IF substr(p_expr, i, 1) = '''' THEN
      IF in_quote AND i < n AND substr(p_expr, i + 1, 1) = '''' THEN
        buf := buf || '''''';
        i := i + 2;
        CONTINUE;
      END IF;
      in_quote := NOT in_quote;
      buf := buf || '''';
      i := i + 1;
      CONTINUE;
    END IF;
    IF NOT in_quote AND upper(substr(p_expr, i, length(kw))) = kw THEN
      parts := parts || btrim(buf);
      buf := '';
      i := i + length(kw);
      CONTINUE;
    END IF;
    buf := buf || substr(p_expr, i, 1);
    i := i + 1;
  END LOOP;
  IF in_quote THEN
    RAISE EXCEPTION 'Unclosed quote in rule expression';
  END IF;
  parts := parts || btrim(buf);
  RETURN parts;
END;
$split$;

CREATE OR REPLACE FUNCTION data_quality.compile_rule_clause(p_clause text)
RETURNS TABLE(pred text, msg text, actual text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $clause$
DECLARE
  v_clause text := btrim(p_clause);
  v_m text[];
  v_attr text;
  v_op text;
  v_rhs text;
  v_val text;
  v_items text[] := ARRAY[]::text[];
  v_item text;
  v_num_like text := '^-?[0-9]+([.][0-9]+)?$';
  v_date_like text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$';
BEGIN
  IF v_clause = '' THEN
    RAISE EXCEPTION 'Rule expression has an empty clause';
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL$', 'i');
  IF v_m IS NULL THEN
    v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NULL$', 'i');
    IF v_m IS NOT NULL THEN
      v_attr := v_m[1];
      v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
      pred := format('(%s IS NULL)', v_val);
      msg := format('%L', v_attr || ' is present');
      actual := v_val;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    v_attr := v_m[1];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%s IS NOT NULL)', v_val);
    msg := format('%L', v_attr || ' is missing');
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*(-?[0-9]+(?:[.][0-9]+)?)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::numeric %3$s %4$s) END)',
      v_val, v_num_like, v_op, v_rhs
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',
      v_val, v_attr || ' is missing', v_num_like, v_attr || ' is not a number', v_attr || ' failed ' || v_op || ' ' || v_rhs
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*CURRENT_DATE$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s as_of) END)',
      v_val, v_date_like, v_op
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L || '' ('' || as_of::text || '')'' END)',
      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' CURRENT_DATE'
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*''([0-9]{4}-[0-9]{2}-[0-9]{2})''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s DATE %4$L) END)',
      v_val, v_date_like, v_op, v_rhs
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',
      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' ' || v_rhs
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*~[[:space:]]*''((?:[^'']|'')*)''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_rhs := replace(v_m[2], '''''', '''');
    BEGIN
      PERFORM '' ~ v_rhs;
    EXCEPTION WHEN invalid_regular_expression THEN
      RAISE EXCEPTION 'Invalid regular expression on %', v_attr;
    END;
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%1$s IS NOT NULL AND %1$s ~ %2$L)', v_val, v_rhs);
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',
      v_val, v_attr || ' is missing', v_attr || ' does not match the expected format'
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IN[[:space:]]*\((.*)\)[[:space:]]*$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    FOR v_item IN
      SELECT match[1] FROM regexp_matches(v_m[2], '''([^'']*)''', 'g') AS match
    LOOP
      v_items := v_items || format('%L', lower(replace(v_item, '''''', '''')));
    END LOOP;
    IF cardinality(v_items) = 0 THEN
      RAISE EXCEPTION 'IN list on % has no quoted values', v_attr;
    END IF;
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%1$s IS NOT NULL AND lower(%1$s) IN (%2$s))', v_val, array_to_string(v_items, ', '));
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',
      v_val, v_attr || ' is missing', v_attr || ' is not an allowed value'
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Expression is not supported: %', v_clause;
END;
$clause$;

CREATE OR REPLACE FUNCTION data_quality.compile_rule_expression(p_expression text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, data_quality
AS $compile$
DECLARE
  v_expr text := btrim(regexp_replace(COALESCE(p_expression, ''), '[[:space:]]+', ' ', 'g'));
  v_or text;
  v_and text;
  v_part record;
  v_and_preds text[] ;
  v_and_msgs text[];
  v_and_actual text;
  v_group_pred text;
  v_group_msg text;
  v_group_actual text;
  v_or_preds text[] := ARRAY[]::text[];
  v_or_msgs text[] := ARRAY[]::text[];
  v_or_actuals text[] := ARRAY[]::text[];
  v_only_actual text;
  v_mixed_actual boolean := false;
  v_passed text;
  v_message text;
  v_actual text;
BEGIN
  IF v_expr = '' THEN
    RAISE EXCEPTION 'Rule expression is empty';
  END IF;

  FOREACH v_or IN ARRAY data_quality.split_rule_expr(v_expr, 'OR') LOOP
    v_and_preds := ARRAY[]::text[];
    v_and_msgs := ARRAY[]::text[];
    v_and_actual := NULL;
    FOREACH v_and IN ARRAY data_quality.split_rule_expr(v_or, 'AND') LOOP
      SELECT * INTO v_part FROM data_quality.compile_rule_clause(v_and);
      v_and_preds := v_and_preds || v_part.pred;
      v_and_msgs := v_and_msgs || format('CASE WHEN NOT %s THEN (%s) END', v_part.pred, v_part.msg);
      IF v_and_actual IS NULL THEN
        v_and_actual := v_part.actual;
      END IF;
    END LOOP;
    v_group_pred := '(' || array_to_string(v_and_preds, ' AND ') || ')';
    v_group_msg := 'concat_ws(''; '', ' || array_to_string(v_and_msgs, ', ') || ')';
    v_group_actual := v_and_actual;
    v_or_preds := v_or_preds || v_group_pred;
    v_or_msgs := v_or_msgs || format(
      'CASE WHEN NOT %1$s AND COALESCE((%2$s), '''') !~ '' is present$'' THEN (%2$s) END',
      v_group_pred, v_group_msg
    );
    v_or_actuals := v_or_actuals || format('CASE WHEN NOT %s THEN (%s) END', v_group_pred, v_group_actual);
    IF v_only_actual IS NULL THEN
      v_only_actual := v_group_actual;
    ELSIF v_only_actual IS DISTINCT FROM v_group_actual THEN
      v_mixed_actual := true;
    END IF;
  END LOOP;

  v_passed := '(' || array_to_string(v_or_preds, ' OR ') || ')';
  v_message := format(
    'CASE WHEN %1$s THEN NULL ELSE NULLIF(concat_ws(''; '', %2$s), '''') END',
    v_passed, array_to_string(v_or_msgs, ', ')
  );
  IF v_mixed_actual THEN
    v_actual := format(
      'CASE WHEN %1$s THEN NULL ELSE NULLIF(concat_ws(''; '', %2$s), '''') END',
      v_passed, array_to_string(v_or_actuals, ', ')
    );
  ELSE
    v_actual := format('CASE WHEN %s THEN NULL ELSE (%s) END', v_passed, v_only_actual);
  END IF;

  RETURN format(
    'jsonb_build_object(''passed'', %1$s, ''evaluated'', true, ''message'', %2$s, ''actualValue'', %3$s)',
    v_passed, v_message, v_actual
  );
END;
$compile$;

CREATE OR REPLACE FUNCTION data_quality.rebuild_compiled_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = data_quality, pg_catalog
AS $rebuild$
DECLARE
  v_cases text;
  v_sql text;
BEGIN
  SELECT string_agg(
    format('WHEN %L::uuid THEN (%s)', id, compiled_sql),
    E'\n    ' ORDER BY rule_code
  )
  INTO v_cases
  FROM data_quality.dq_rules
  WHERE is_active IS TRUE
    AND compiled_sql IS NOT NULL;

  v_sql := format($fn$
CREATE OR REPLACE FUNCTION data_quality.apply_compiled_rule(p_rule_id uuid, vals jsonb, as_of date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $body$
SELECT CASE p_rule_id
    %s
    ELSE jsonb_build_object('passed', false, 'evaluated', false, 'message', 'Rule is not compiled', 'actualValue', NULL)
  END
$body$;
$fn$, COALESCE(v_cases, ''));

  EXECUTE v_sql;
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_quality.apply_compiled_rule(uuid, jsonb, date) TO authenticated, service_role';
END;
$rebuild$;

CREATE OR REPLACE FUNCTION data_quality.dq_rules_compile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = data_quality, pg_catalog
AS $row$
BEGIN
  NEW.compiled_sql := data_quality.compile_rule_expression(NEW.rule_expression);
  RETURN NEW;
END;
$row$;

CREATE OR REPLACE FUNCTION data_quality.dq_rules_rebuild_compiled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = data_quality, pg_catalog
AS $stmt$
BEGIN
  PERFORM data_quality.rebuild_compiled_rules();
  RETURN NULL;
END;
$stmt$;

DROP TRIGGER IF EXISTS dq_rules_compile ON data_quality.dq_rules;
CREATE TRIGGER dq_rules_compile
  BEFORE INSERT OR UPDATE OF rule_expression ON data_quality.dq_rules
  FOR EACH ROW
  EXECUTE FUNCTION data_quality.dq_rules_compile();

DROP TRIGGER IF EXISTS dq_rules_rebuild_compiled ON data_quality.dq_rules;
CREATE TRIGGER dq_rules_rebuild_compiled
  AFTER INSERT OR UPDATE OR DELETE ON data_quality.dq_rules
  FOR EACH STATEMENT
  EXECUTE FUNCTION data_quality.dq_rules_rebuild_compiled();

UPDATE data_quality.dq_rules SET rule_expression = rule_expression;

DO $check$
DECLARE
  v_rule record;
  v_sample jsonb;
  v_slow jsonb;
  v_fast jsonb;
  v_samples jsonb[] := ARRAY[
    '{}'::jsonb,
    '{"market_value":"10"}'::jsonb,
    '{"market_value":"-1"}'::jsonb,
    '{"market_value":"nope"}'::jsonb,
    '{"country":"US"}'::jsonb,
    '{"country":"ZZ"}'::jsonb,
    '{"lei":"bad"}'::jsonb,
    '{"maturity_date":"1980-01-01"}'::jsonb,
    '{"maturity_date":"2030-01-01"}'::jsonb,
    '{"metric_date":"2026-12-01"}'::jsonb,
    '{"metric_date":"2020-01-01"}'::jsonb,
    '{"daily_return":"150"}'::jsonb,
    '{"daily_return":"10"}'::jsonb,
    '{"original_principal_amount":"0"}'::jsonb,
    '{"nav":"1"}'::jsonb,
    '{"price":"-2"}'::jsonb,
    '{"deal_date":"2020-01-01"}'::jsonb,
    '{"credit_rating":"nope"}'::jsonb,
    '{"position_currency":"usd"}'::jsonb
  ];
BEGIN
  FOR v_rule IN
    SELECT rule_name, regexp_replace(rule_expression, '[[:space:]]+', ' ', 'g') AS expr, compiled_sql
    FROM data_quality.dq_rules
    WHERE is_active IS TRUE
  LOOP
    FOREACH v_sample IN ARRAY v_samples LOOP
      v_slow := data_quality.evaluate_rule_expression(v_rule.expr, v_sample, DATE '2026-10-24');
      EXECUTE format(
        'SELECT (%s) FROM (SELECT $1::jsonb AS vals, $2::date AS as_of) input',
        v_rule.compiled_sql
      ) INTO v_fast USING v_sample, DATE '2026-10-24';
      IF (v_slow->>'passed') IS DISTINCT FROM (v_fast->>'passed')
         OR COALESCE(v_slow->>'message', '') IS DISTINCT FROM COALESCE(v_fast->>'message', '') THEN
        RAISE EXCEPTION 'Compiled SQL disagrees for % on %: slow % fast %',
          v_rule.rule_name, v_sample, v_slow, v_fast;
      END IF;
    END LOOP;
  END LOOP;
END;
$check$;

DO $wire$
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

  s := replace(
    s,
    'data_quality.evaluate_rule_expression(r.rule_expression, ''{}''::jsonb, v_to) AS probe',
    'data_quality.apply_compiled_rule(r.id, ''{}''::jsonb, v_to) AS probe'
  );
  s := replace(
    s,
    'data_quality.evaluate_rule_expression(aru.rule_expression, COALESCE(vm.values, ''{}''::jsonb), v_to)',
    'data_quality.apply_compiled_rule(aru.id, COALESCE(vm.values, ''{}''::jsonb), v_to)'
  );
  s := replace(
    s,
    'data_quality.evaluate_rule_expression(aru.rule_expression, COALESCE(vm.values, ''{}''::jsonb), v_from)',
    'data_quality.apply_compiled_rule(aru.id, COALESCE(vm.values, ''{}''::jsonb), v_from)'
  );

  IF position('apply_compiled_rule' in s) = 0 THEN
    RAISE EXCEPTION 'Could not wire compiled rules into the dashboard';
  END IF;
  EXECUTE s;
END;
$wire$;
