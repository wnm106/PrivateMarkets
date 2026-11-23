-- A data quality rule describes the exception, not good data.
--
-- A rule's expression is a set of conditions. A record raises an exception when
-- it meets every condition joined by AND, or every condition of any one group
-- when groups are joined by OR. A record that meets none of the groups passes.
--
-- A blank value meets no condition about its value. MARKET_CAP < 0 is not met
-- by a blank market cap, and neither is MARKET_CAP >= 0. Whether a field must be
-- present is the attribute's required flag, measured under availability. A rule
-- tests a blank only when it says so, with ATTRIBUTE IS NULL.
--
-- Until now an expression described good data, and a record raised an exception
-- when the expression was false. Every existing rule is rewritten once, here, to
-- the conditions that raise its exception. A condition about a value that the old
-- rule failed on a blank no longer fails a blank, as above. Conditions the old
-- rule wrote about blanks are kept.
--
-- New conditions: ATTR !~ 'pattern', ATTR NOT IN (...), ATTR IS NOT UNDER OTHER.
--
-- Safe to run again: the rewrite runs once, marked by the comment on
-- data_quality.dq_rules.rule_expression.

-- 1. One condition, compiled. pred is true when the condition is met. A blank
--    value meets no condition about its value. msg says what was met.
CREATE OR REPLACE FUNCTION data_quality.compile_rule_clause(p_clause text)
 RETURNS TABLE(pred text, msg text, actual text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_clause text := btrim(regexp_replace(COALESCE(p_clause, ''), '[[:space:]]+', ' ', 'g'));
  v_m text[];
  v_attr text;
  v_op text;
  v_rhs text;
  v_val text;
  v_other text;
  v_items text[] := ARRAY[]::text[];
  v_item text;
  v_num_like text := '^-?[0-9]+([.][0-9]+)?$';
  v_date_like text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$';
  v_label text;
BEGIN
  IF v_clause = '' THEN
    RAISE EXCEPTION 'Rule expression has an empty clause';
  END IF;

  -- ATTR IS NOT NULL
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS NOT NULL$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%s IS NOT NULL)', v_val);
    msg := v_attr || ' is present';
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR IS NULL
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%s IS NULL)', v_val);
    msg := v_attr || ' is blank';
    actual := 'NULL::text';
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR op number
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(>=|<=|<>|!=|=|>|<) ?(-?[0-9]+(?:[.][0-9]+)?)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %1$s !~ %2$L THEN false ELSE (%1$s::numeric %3$s %4$s) END)',
      v_val, v_num_like, v_op, v_rhs
    );
    msg := v_attr || ' ' || v_op || ' ' || v_rhs;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR op CURRENT_DATE (the as-of date)
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(>=|<=|<>|!=|=|>|<) ?CURRENT_DATE$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s as_of) END)',
      v_val, v_date_like, v_op
    );
    msg := v_attr || ' ' || v_op || ' the as-of date';
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR op 'YYYY-MM-DD'
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(>=|<=|<>|!=|=|>|<) ?''([0-9]{4}-[0-9]{2}-[0-9]{2})''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s DATE %4$L) END)',
      v_val, v_date_like, v_op, v_rhs
    );
    msg := v_attr || ' ' || v_op || ' ' || v_rhs;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR ~ 'pattern' and ATTR !~ 'pattern'
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(!~|~) ?''((?:[^'']|'''')*)''$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := v_m[2];
    v_rhs := replace(v_m[3], '''''', '''');
    BEGIN
      PERFORM '' ~ v_rhs;
    EXCEPTION WHEN invalid_regular_expression THEN
      RAISE EXCEPTION 'Invalid regular expression on %', v_attr;
    END;
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%1$s IS NOT NULL AND %1$s %2$s %3$L)', v_val, v_op, v_rhs);
    msg := v_attr || CASE WHEN v_op = '~' THEN ' matches the pattern' ELSE ' does not match the expected format' END;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ATTR IN (...) and ATTR NOT IN (...)
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) (NOT IN|IN) ?\((.*)\)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_op := upper(v_m[2]);
    FOR v_item IN
      SELECT match[1] FROM regexp_matches(v_m[3], '''((?:[^'']|'''')*)''', 'g') AS match
    LOOP
      v_items := v_items || format('%L', lower(replace(v_item, '''''', '''')));
    END LOOP;
    IF cardinality(v_items) = 0 THEN
      RAISE EXCEPTION 'IN list on % has no quoted values', v_attr;
    END IF;
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    pred := format('(%1$s IS NOT NULL AND lower(%1$s) %2$s (%3$s))', v_val, v_op, array_to_string(v_items, ', '));
    msg := v_attr || CASE WHEN v_op = 'IN' THEN ' is one of the listed values' ELSE ' is not an allowed value' END;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- One attribute compared with another: MATURITY_DATE <= ISSUANCE_DATE.
  -- Dates compare as dates, numbers as numbers, anything else as text.
  -- A blank on either side meets nothing.
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(>=|<=|<>|!=|=|>|<) ?([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL AND upper(v_m[3]) NOT IN ('NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'YESTERDAY') THEN
    v_attr := v_m[1];
    v_op := CASE WHEN v_m[2] = '!=' THEN '<>' ELSE v_m[2] END;
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    v_other := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_rhs));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %2$s IS NULL THEN false WHEN %1$s ~ %3$L AND %2$s ~ %3$L THEN (%1$s::date %5$s %2$s::date) WHEN %1$s ~ %4$L AND %2$s ~ %4$L THEN (%1$s::numeric %5$s %2$s::numeric) ELSE (%1$s %5$s %2$s) END)',
      v_val, v_other, v_date_like, v_num_like, v_op
    );
    msg := v_attr || ' ' || v_op || ' ' || v_rhs;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- CHILD IS UNDER PARENT and CHILD IS NOT UNDER PARENT: the child's value
  -- against the parent's value on the child field's list.
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS (NOT )?UNDER ([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    v_other := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_rhs));
    pred := format(
      '(%1$s IS NOT NULL AND %2$s IS NOT NULL AND %4$s COALESCE(metadata_register.list_value_is_under(%3$L, %1$s, %2$s), false))',
      v_val, v_other, upper(v_attr), CASE WHEN v_m[2] IS NULL THEN '' ELSE 'NOT' END
    );
    msg := v_attr || CASE WHEN v_m[2] IS NULL THEN ' is under ' ELSE ' is not under ' END || v_rhs;
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Expression is not supported: %', v_clause;
END;
$function$;

-- 2. A whole expression, compiled. The record raises an exception when any
--    group's conditions are all met; message names the first such group.
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
  v_preds text[];
  v_msgs text[];
  v_actual text;
  v_group text;
  v_groups text[] := ARRAY[]::text[];
  v_msg_cases text[] := ARRAY[]::text[];
  v_actual_cases text[] := ARRAY[]::text[];
  v_raised text;
BEGIN
  IF v_expr = '' THEN
    RAISE EXCEPTION 'Rule expression is empty';
  END IF;

  FOREACH v_or IN ARRAY data_quality.split_rule_expr(v_expr, 'OR') LOOP
    v_preds := ARRAY[]::text[];
    v_msgs := ARRAY[]::text[];
    v_actual := NULL;
    FOREACH v_and IN ARRAY data_quality.split_rule_expr(v_or, 'AND') LOOP
      SELECT * INTO v_part FROM data_quality.compile_rule_clause(v_and);
      v_preds := v_preds || v_part.pred;
      v_msgs := v_msgs || v_part.msg;
      v_actual := COALESCE(v_actual, v_part.actual);
    END LOOP;
    v_group := 'COALESCE((' || array_to_string(v_preds, ' AND ') || '), false)';
    v_groups := v_groups || v_group;
    v_msg_cases := v_msg_cases || format('WHEN %s THEN %L', v_group, array_to_string(v_msgs, ' and '));
    v_actual_cases := v_actual_cases || format('WHEN %s THEN (%s)', v_group, v_actual);
  END LOOP;

  v_raised := '(' || array_to_string(v_groups, ' OR ') || ')';
  RETURN format(
    'jsonb_build_object(''passed'', NOT %1$s, ''evaluated'', true, ''message'', CASE %2$s END, ''actualValue'', CASE %3$s END)',
    v_raised, array_to_string(v_msg_cases, ' '), array_to_string(v_actual_cases, ' ')
  );
END;
$compile$;

COMMENT ON FUNCTION data_quality.compile_rule_expression(text) IS
'Compiles a rule expression that describes the exception: true when every condition of any OR group is met. A blank value meets no condition about its value.';

-- 3. The parts of one condition: what it reads and what its opposite is.
--    kind is BLANK (ATTR IS NULL), PRESENT (ATTR IS NOT NULL) or VALUE.
--    A VALUE condition is never met when any attribute it reads is blank.
CREATE OR REPLACE FUNCTION data_quality.rule_clause_parts(p_clause text)
RETURNS TABLE(kind text, attrs text[], negated text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $parts$
DECLARE
  v_clause text := btrim(regexp_replace(COALESCE(p_clause, ''), '[[:space:]]+', ' ', 'g'));
  v_m text[];
BEGIN
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS NOT NULL$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'PRESENT'::text, ARRAY[upper(v_m[1])], v_m[1] || ' IS NULL';
    RETURN;
  END IF;
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS NULL$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'BLANK'::text, ARRAY[upper(v_m[1])], v_m[1] || ' IS NOT NULL';
    RETURN;
  END IF;
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) IS (NOT )?UNDER ([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'VALUE'::text, ARRAY[upper(v_m[1]), upper(v_m[3])],
      v_m[1] || CASE WHEN v_m[2] IS NULL THEN ' IS NOT UNDER ' ELSE ' IS UNDER ' END || v_m[3];
    RETURN;
  END IF;
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(!~|~) ?(''.*'')$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'VALUE'::text, ARRAY[upper(v_m[1])],
      v_m[1] || CASE WHEN v_m[2] = '~' THEN ' !~ ' ELSE ' ~ ' END || v_m[3];
    RETURN;
  END IF;
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) (NOT IN|IN) ?(\(.*\))$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'VALUE'::text, ARRAY[upper(v_m[1])],
      v_m[1] || CASE WHEN upper(v_m[2]) = 'IN' THEN ' NOT IN ' ELSE ' IN ' END || v_m[3];
    RETURN;
  END IF;
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*) ?(>=|<=|<>|!=|=|>|<) ?(.+)$', 'i');
  IF v_m IS NOT NULL THEN
    RETURN QUERY SELECT 'VALUE'::text,
      CASE
        WHEN v_m[3] ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND upper(v_m[3]) NOT IN ('NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'YESTERDAY')
          THEN ARRAY[upper(v_m[1]), upper(v_m[3])]
        ELSE ARRAY[upper(v_m[1])]
      END,
      v_m[1] || ' ' || CASE v_m[2]
        WHEN '>=' THEN '<' WHEN '<=' THEN '>' WHEN '>' THEN '<=' WHEN '<' THEN '>='
        WHEN '=' THEN '<>' ELSE '=' END || ' ' || v_m[3];
    RETURN;
  END IF;
  RAISE EXCEPTION 'Expression is not supported: %', v_clause;
END;
$parts$;

-- 4. True when the rule cannot raise its exception while p_attribute is blank:
--    every group has a condition on that attribute's value or presence. The
--    dashboard, load checks and preview then pass a record that lacks the
--    attribute without evaluating the rule.
CREATE OR REPLACE FUNCTION data_quality.rule_passes_when_blank(p_expression text, p_attribute text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, data_quality
AS $blank$
DECLARE
  v_attr text := upper(btrim(COALESCE(p_attribute, '')));
  v_or text;
  v_and text;
  v_part record;
  v_blocked boolean;
BEGIN
  IF v_attr = '' OR NULLIF(btrim(COALESCE(p_expression, '')), '') IS NULL THEN
    RETURN false;
  END IF;
  FOREACH v_or IN ARRAY data_quality.split_rule_expr(btrim(regexp_replace(p_expression, '[[:space:]]+', ' ', 'g')), 'OR') LOOP
    v_blocked := false;
    FOREACH v_and IN ARRAY data_quality.split_rule_expr(v_or, 'AND') LOOP
      SELECT * INTO v_part FROM data_quality.rule_clause_parts(v_and);
      IF v_part.kind IN ('PRESENT', 'VALUE') AND v_attr = ANY (v_part.attrs) THEN
        v_blocked := true;
      END IF;
    END LOOP;
    IF NOT v_blocked THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$blank$;

-- 5. The exception an old good-data expression described: the opposite of
--    the expression, as OR groups of AND conditions, with a blank meeting no
--    condition about its value. Groups that cannot be met, repeated conditions,
--    presence implied by a value condition, and groups that contain another
--    group are dropped. Returns NULL when nothing could raise the exception.
CREATE OR REPLACE FUNCTION data_quality.exception_from_pass_expression(p_expression text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, data_quality
AS $flip$
DECLARE
  v_expr text := btrim(regexp_replace(COALESCE(p_expression, ''), '[[:space:]]+', ' ', 'g'));
  v_or text;
  v_and text;
  v_part record;
  v_neg jsonb;
  v_products jsonb := '[[]]'::jsonb;
  v_next jsonb;
  v_kept jsonb;
  v_result text;
BEGIN
  IF v_expr = '' THEN
    RETURN NULL;
  END IF;

  -- not (G1 or G2 ...) = (not G1) and (not G2) ...; not G = any one negated condition of G.
  FOREACH v_or IN ARRAY data_quality.split_rule_expr(v_expr, 'OR') LOOP
    v_neg := '[]'::jsonb;
    FOREACH v_and IN ARRAY data_quality.split_rule_expr(v_or, 'AND') LOOP
      SELECT * INTO v_part FROM data_quality.rule_clause_parts(v_and);
      v_neg := v_neg || jsonb_build_array(jsonb_build_object(
        't', v_part.negated,
        'k', CASE v_part.kind WHEN 'BLANK' THEN 'PRESENT' WHEN 'PRESENT' THEN 'BLANK' ELSE 'VALUE' END,
        'a', to_jsonb(v_part.attrs)
      ));
    END LOOP;
    -- In a good-data group, ATTR IS NOT NULL beside a condition on ATTR's value
    -- added nothing: the value condition already failed a blank. Its opposite,
    -- ATTR IS NULL, would make the blank an exception, which is availability's
    -- job, so it is left out.
    SELECT COALESCE(jsonb_agg(b.value ORDER BY b.ordinality), '[]'::jsonb)
    INTO v_neg
    FROM jsonb_array_elements(v_neg) WITH ORDINALITY AS b
    WHERE NOT (b.value->>'k' = 'BLANK' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_neg) AS o
      WHERE o.value->>'k' = 'VALUE' AND (o.value->'a') ? (b.value->'a'->>0)
    ));

    SELECT COALESCE(jsonb_agg(p.value || jsonb_build_array(n.value) ORDER BY p.ordinality, n.ordinality), '[]'::jsonb)
    INTO v_next
    FROM jsonb_array_elements(v_products) WITH ORDINALITY AS p
    CROSS JOIN jsonb_array_elements(v_neg) WITH ORDINALITY AS n;

    -- Simplify each group.
    WITH grp AS (
      SELECT g.ordinality AS gi, g.value AS conds
      FROM jsonb_array_elements(v_next) WITH ORDINALITY AS g
    ),
    cond AS (
      SELECT grp.gi, c.ordinality AS ci, c.value AS c
      FROM grp CROSS JOIN jsonb_array_elements(grp.conds) WITH ORDINALITY AS c
    ),
    impossible AS (
      -- A blank attribute meets no condition about its value or presence.
      SELECT DISTINCT b.gi
      FROM cond b
      JOIN cond o ON o.gi = b.gi AND o.ci <> b.ci
      WHERE b.c->>'k' = 'BLANK'
        AND o.c->>'k' IN ('PRESENT', 'VALUE')
        AND (o.c->'a') ? (b.c->'a'->>0)
    ),
    kept AS (
      SELECT c.gi, c.ci, c.c
      FROM cond c
      WHERE c.gi NOT IN (SELECT gi FROM impossible)
        -- Presence is implied by any condition on the value.
        AND NOT (c.c->>'k' = 'PRESENT' AND EXISTS (
          SELECT 1 FROM cond o
          WHERE o.gi = c.gi AND o.c->>'k' = 'VALUE' AND (o.c->'a') ? (c.c->'a'->>0)
        ))
    ),
    deduped AS (
      SELECT DISTINCT ON (gi, upper(c->>'t')) gi, ci, c
      FROM kept
      ORDER BY gi, upper(c->>'t'), ci
    ),
    groups AS (
      SELECT gi,
             jsonb_agg(c ORDER BY ci) AS conds,
             array_agg(upper(c->>'t') ORDER BY upper(c->>'t')) AS keyset
      FROM deduped
      GROUP BY gi
    ),
    distinct_groups AS (
      SELECT DISTINCT ON (keyset) gi, conds, keyset FROM groups ORDER BY keyset, gi
    )
    SELECT COALESCE(jsonb_agg(d.conds ORDER BY d.gi), '[]'::jsonb)
    INTO v_kept
    FROM distinct_groups d
    -- A group that contains every condition of another group adds nothing.
    WHERE NOT EXISTS (
      SELECT 1 FROM distinct_groups o
      WHERE o.gi <> d.gi AND o.keyset <@ d.keyset AND o.keyset <> d.keyset
    );

    v_products := v_kept;
    IF jsonb_array_length(v_products) = 0 THEN
      RETURN NULL;
    END IF;
    IF jsonb_array_length(v_products) > 64 THEN
      RAISE EXCEPTION 'Rule expression is too large to rewrite: %', v_expr;
    END IF;
  END LOOP;

  SELECT string_agg(g.txt, ' OR ' ORDER BY g.ord)
  INTO v_result
  FROM (
    SELECT p.ordinality AS ord,
           (SELECT string_agg(c.value->>'t', ' AND ' ORDER BY c.ordinality)
            FROM jsonb_array_elements(p.value) WITH ORDINALITY AS c) AS txt
    FROM jsonb_array_elements(v_products) WITH ORDINALITY AS p
  ) AS g;
  RETURN v_result;
END;
$flip$;

REVOKE ALL ON FUNCTION data_quality.rule_clause_parts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION data_quality.rule_passes_when_blank(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION data_quality.exception_from_pass_expression(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_quality.rule_clause_parts(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION data_quality.rule_passes_when_blank(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION data_quality.exception_from_pass_expression(text) TO service_role;

-- 6. Rewrite every rule once. A rule nothing could fail is set inactive.
DO $rewrite$
DECLARE
  v_rule record;
  v_rewritten integer := 0;
  v_inactive integer := 0;
BEGIN
  IF COALESCE(col_description('data_quality.dq_rules'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'data_quality.dq_rules'::regclass AND attname = 'rule_expression')),
       '') LIKE 'Describes the exception%' THEN
    RAISE NOTICE 'Rules already describe exceptions; nothing rewritten.';
    RETURN;
  END IF;

  -- One statement each, so the compiled rules are rebuilt once and not per rule.
  CREATE TEMP TABLE _dq_flip ON COMMIT DROP AS
  SELECT id, rule_code, rule_expression AS old_expression,
         data_quality.exception_from_pass_expression(rule_expression) AS new_expression
  FROM data_quality.dq_rules;

  FOR v_rule IN SELECT rule_code, old_expression FROM _dq_flip WHERE new_expression IS NULL ORDER BY rule_code LOOP
    RAISE NOTICE 'Rule % could never fail and is now inactive: %', v_rule.rule_code, v_rule.old_expression;
  END LOOP;

  UPDATE data_quality.dq_rules r
  SET rule_expression = CASE WHEN f.new_expression IS NULL THEN r.rule_expression ELSE f.new_expression END,
      is_active = CASE WHEN f.new_expression IS NULL THEN false ELSE r.is_active END,
      updated_at = NOW()
  FROM _dq_flip f
  WHERE f.id = r.id;

  SELECT count(*) FILTER (WHERE new_expression IS NOT NULL), count(*) FILTER (WHERE new_expression IS NULL)
  INTO v_rewritten, v_inactive
  FROM _dq_flip;
  RAISE NOTICE 'Rewrote % rules to describe their exception; % set inactive.', v_rewritten, v_inactive;
END;
$rewrite$;

COMMENT ON COLUMN data_quality.dq_rules.rule_expression IS
'Describes the exception. A record raises it when every condition joined by AND is met, or every condition of any one group joined by OR. A blank value meets no condition about its value; test a blank with ATTRIBUTE IS NULL.';

-- Every rule is compiled again with the new compiler, whether or not its text
-- changed. The statement trigger rebuilds apply_compiled_rule.
UPDATE data_quality.dq_rules SET compiled_sql = data_quality.compile_rule_expression(rule_expression);

-- 7. The quick pass for a record that lacks the rule's attribute used to look
--    for an expression starting "ATTRIBUTE IS NULL OR". That shape now raises
--    an exception on a blank, so every function that read it asks
--    rule_passes_when_blank instead.
DO $shortcut$
DECLARE
  v_fn record;
  v_def text;
  v_new text;
  v_pattern text := '([A-Za-z_][A-Za-z0-9_.]*) ~\* \(''\^'' \|\| ([A-Za-z_][A-Za-z0-9_.]*) \|\| ''\[\[:space:\]\]\+IS\[\[:space:\]\]\+NULL\[\[:space:\]\]\+OR\[\[:space:\]\]''\)';
BEGIN
  FOR v_fn IN
    SELECT p.oid, n.nspname, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'data_quality')
      AND p.prokind = 'f'
      AND p.prosrc ~ v_pattern
  LOOP
    v_def := pg_get_functiondef(v_fn.oid);
    v_new := regexp_replace(v_def, v_pattern, 'data_quality.rule_passes_when_blank(\1, \2)', 'g');
    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
      RAISE NOTICE 'Blank shortcut now asks rule_passes_when_blank in %.%', v_fn.nspname, v_fn.proname;
    END IF;
  END LOOP;
END;
$shortcut$;

NOTIFY pgrst, 'reload schema';
