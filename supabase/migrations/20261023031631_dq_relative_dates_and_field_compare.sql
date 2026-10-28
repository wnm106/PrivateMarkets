-- Date functions a quality rule can wrap around the as-of date or another
-- attribute, plus field-to-field comparisons in the dashboard evaluator.
-- CURRENT_DATE remains the as-of date passed into evaluation, not the clock.

CREATE OR REPLACE FUNCTION data_quality.apply_date_fn(p_fn text, p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE lower(btrim(COALESCE(p_fn, '')))
    WHEN 'previous_day' THEN (p_date - 1)
    WHEN 'yesterday' THEN (p_date - 1)
    WHEN 'start_of_month' THEN date_trunc('month', p_date::timestamp)::date
    WHEN 'end_of_month' THEN (date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day')::date
    WHEN 'start_of_quarter' THEN date_trunc('quarter', p_date::timestamp)::date
    WHEN 'end_of_quarter' THEN (date_trunc('quarter', p_date::timestamp) + interval '3 months' - interval '1 day')::date
    WHEN 'start_of_year' THEN date_trunc('year', p_date::timestamp)::date
    WHEN 'end_of_year' THEN (date_trunc('year', p_date::timestamp) + interval '1 year' - interval '1 day')::date
    ELSE p_date
  END;
$$;

COMMENT ON FUNCTION data_quality.apply_date_fn(text, date) IS
  'Shifts a date to the previous day or the start or end of its month, quarter, or year.';

REVOKE ALL ON FUNCTION data_quality.apply_date_fn(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_quality.apply_date_fn(text, date) TO authenticated, service_role;

DO $do$
DECLARE
  v_fn text;
  v_arg text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'previous_day', 'start_of_month', 'end_of_month', 'start_of_quarter',
    'end_of_quarter', 'start_of_year', 'end_of_year'
  ]
  LOOP
    FOREACH v_arg IN ARRAY ARRAY['date', 'timestamp', 'timestamptz']
    LOOP
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION data_quality.%I(p_value %s)
         RETURNS date
         LANGUAGE sql
         IMMUTABLE
         SET search_path = pg_catalog
         AS $fn$ SELECT data_quality.apply_date_fn(%L, p_value::date); $fn$',
        v_fn, v_arg, v_fn
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION data_quality.%I(%s) FROM PUBLIC',
        v_fn, v_arg
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION data_quality.%I(%s) TO authenticated, service_role',
        v_fn, v_arg
      );
    END LOOP;
  END LOOP;
END
$do$;

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
  v_fn text;
  v_arg text;
  v_other text;
  v_base date;
  v_label text;
  v_date_like text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$';
  v_num_like text := '^-?[0-9]+([.][0-9]+)?$';
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
    '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*(.+)$',
    'i'
  );
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := btrim(v_m[3]);
    v_label := v_rhs;
    v_value := NULLIF(btrim(p_values ->> lower(v_attr)), '');
    v_fn := NULL;
    v_arg := NULL;
    v_other := NULL;
    v_rhs_date := NULL;
    v_rhs_num := NULL;

    IF v_rhs ~* '^(YESTERDAY|CURRENT_DATE|((?:PREVIOUS_DAY|START_OF_MONTH|END_OF_MONTH|START_OF_QUARTER|END_OF_QUARTER|START_OF_YEAR|END_OF_YEAR))(?:[[:space:]]*\([[:space:]]*(CURRENT_DATE|[A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\))?)$' THEN
      v_m := regexp_match(
        v_rhs,
        '^(YESTERDAY|CURRENT_DATE|((?:PREVIOUS_DAY|START_OF_MONTH|END_OF_MONTH|START_OF_QUARTER|END_OF_QUARTER|START_OF_YEAR|END_OF_YEAR))(?:[[:space:]]*\([[:space:]]*(CURRENT_DATE|[A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\))?)$',
        'i'
      );
      IF upper(v_m[1]) = 'CURRENT_DATE' THEN
        v_rhs_date := p_as_of;
      ELSE
        v_fn := CASE WHEN upper(v_m[1]) = 'YESTERDAY' THEN 'previous_day' ELSE lower(v_m[2]) END;
        v_arg := v_m[3];
        IF v_arg IS NULL OR upper(v_arg) = 'CURRENT_DATE' THEN
          v_base := p_as_of;
        ELSE
          v_other := NULLIF(btrim(p_values ->> lower(v_arg)), '');
          IF v_other IS NULL THEN
            RETURN jsonb_build_object(
              'passed', false,
              'evaluated', true,
              'message', v_arg || ' is missing',
              'actualValue', v_value
            );
          END IF;
          IF v_other !~ v_date_like THEN
            RETURN jsonb_build_object(
              'passed', false,
              'evaluated', true,
              'message', v_arg || ' is not a date',
              'actualValue', v_other
            );
          END IF;
          BEGIN
            v_base := v_other::date;
          EXCEPTION WHEN others THEN
            RETURN jsonb_build_object(
              'passed', false,
              'evaluated', true,
              'message', v_arg || ' is not a date',
              'actualValue', v_other
            );
          END;
        END IF;
        v_rhs_date := data_quality.apply_date_fn(v_fn, v_base);
      END IF;

      IF v_value IS NULL THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is missing',
          'actualValue', NULL
        );
      END IF;
      IF v_value !~ v_date_like THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is not a date',
          'actualValue', v_value
        );
      END IF;
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
    ELSIF v_rhs ~ v_num_like THEN
      IF v_value IS NULL THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is missing',
          'actualValue', NULL
        );
      END IF;
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
    ELSIF v_rhs ~ '^''([^'']|'')*''$' THEN
      v_label := replace(btrim(v_rhs, ''''), '''''', '''');
      IF v_value IS NULL THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is missing',
          'actualValue', NULL
        );
      END IF;
      IF v_value ~ v_date_like AND v_label ~ v_date_like THEN
        BEGIN
          v_date := v_value::date;
          v_rhs_date := v_label::date;
        EXCEPTION WHEN others THEN
          v_date := NULL;
        END;
      END IF;
      IF v_date IS NOT NULL AND v_rhs_date IS NOT NULL THEN
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
      ELSE
        v_hit := CASE v_op
          WHEN '>' THEN v_value > v_label
          WHEN '>=' THEN v_value >= v_label
          WHEN '<' THEN v_value < v_label
          WHEN '<=' THEN v_value <= v_label
          WHEN '=' THEN v_value = v_label
          WHEN '!=' THEN v_value <> v_label
          WHEN '<>' THEN v_value <> v_label
          ELSE false
        END;
      END IF;
    ELSIF v_rhs ~* '^[A-Za-z_][A-Za-z0-9_]*$'
      AND upper(v_rhs) NOT IN (
        'AND', 'OR', 'IS', 'NULL', 'NOT', 'IN', 'LIKE', 'ILIKE', 'TRUE', 'FALSE',
        'CURRENT_DATE', 'YESTERDAY', 'PREVIOUS_DAY', 'START_OF_MONTH', 'END_OF_MONTH',
        'START_OF_QUARTER', 'END_OF_QUARTER', 'START_OF_YEAR', 'END_OF_YEAR'
      )
    THEN
      v_other := NULLIF(btrim(p_values ->> lower(v_rhs)), '');
      v_label := v_rhs;
      v_hit := NULL;
      v_date := NULL;
      v_rhs_date := NULL;
      IF v_value IS NULL THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_attr || ' is missing',
          'actualValue', NULL
        );
      END IF;
      IF v_other IS NULL THEN
        RETURN jsonb_build_object(
          'passed', false,
          'evaluated', true,
          'message', v_rhs || ' is missing',
          'actualValue', v_value
        );
      END IF;
      IF v_value ~ v_date_like AND v_other ~ v_date_like THEN
        BEGIN
          v_date := v_value::date;
          v_rhs_date := v_other::date;
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
        EXCEPTION WHEN others THEN
          v_hit := NULL;
        END;
      ELSIF v_value ~ v_num_like AND v_other ~ v_num_like THEN
        BEGIN
          v_num := v_value::numeric;
          v_rhs_num := v_other::numeric;
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
        EXCEPTION WHEN others THEN
          v_hit := NULL;
        END;
      END IF;
      IF v_hit IS NULL THEN
        v_hit := CASE v_op
          WHEN '>' THEN v_value > v_other
          WHEN '>=' THEN v_value >= v_other
          WHEN '<' THEN v_value < v_other
          WHEN '<=' THEN v_value <= v_other
          WHEN '=' THEN v_value = v_other
          WHEN '!=' THEN v_value <> v_other
          WHEN '<>' THEN v_value <> v_other
          ELSE false
        END;
      END IF;
    ELSE
      RETURN jsonb_build_object(
        'passed', false,
        'evaluated', false,
        'message', 'Expression is not supported: ' || v_clause,
        'actualValue', NULL
      );
    END IF;

    RETURN jsonb_build_object(
      'passed', COALESCE(v_hit, false),
      'evaluated', true,
      'message', CASE
        WHEN COALESCE(v_hit, false) THEN NULL
        WHEN v_rhs_date IS NOT NULL AND v_label IS DISTINCT FROM v_rhs_date::text
          THEN v_attr || ' failed ' || v_op || ' ' || v_label || ' (' || v_rhs_date::text || ')'
        ELSE v_attr || ' failed ' || v_op || ' ' || v_label
      END,
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

COMMENT ON FUNCTION data_quality.evaluate_rule_clause(text, jsonb, date) IS
  'Evaluates one pass clause. Comparisons accept a literal, another attribute, CURRENT_DATE, or a date function of CURRENT_DATE or an attribute.';

REVOKE ALL ON FUNCTION data_quality.evaluate_rule_clause(text, jsonb, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_quality.evaluate_rule_clause(text, jsonb, date) TO authenticated, service_role;
