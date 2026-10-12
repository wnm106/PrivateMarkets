-- Search a value across entity code, entity name, and every attribute column in the request.
-- Used by entity list pages so one search box covers the whole entity set.

CREATE OR REPLACE FUNCTION reporting.filter_sql(p_filter jsonb, p_codes text[], p_meta jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    v_field text := p_filter->>'field';
    v_op text := p_filter->>'op';
    v_val jsonb := p_filter->'value';
    v_expr text;
    v_kind text;
    v_cmp text;   -- left-hand side used for comparisons (lower-cased for text)
    v_lo jsonb;
    v_hi jsonb;
    v_lit text;
    v_parts text[] := '{}';
    v_code text;
BEGIN
    IF v_field IS NULL OR v_op IS NULL THEN RAISE EXCEPTION 'Each filter needs field and op'; END IF;

    -- OR across identifiers and every attribute pivoted for this request.
    -- Field is ignored (callers pass entity_code, a builtin, so it is not treated as an attribute).
    IF v_op = 'searchAny' THEN
        IF v_val IS NULL OR jsonb_typeof(v_val) = 'null' OR btrim(COALESCE(v_val #>> '{}', '')) = '' THEN
            RAISE EXCEPTION 'A filter value is required';
        END IF;
        v_lit := reporting.lit(v_val, 'text');
        v_parts := ARRAY[
            format('position(lower(%s) in lower(b.entity_code)) > 0', v_lit),
            format('position(lower(%s) in lower(b.entity_name)) > 0', v_lit)
        ];
        IF p_codes IS NOT NULL THEN
            FOREACH v_code IN ARRAY p_codes LOOP
                v_parts := v_parts || format(
                    'position(lower(%s) in lower((%s)::text)) > 0',
                    v_lit, reporting.col_expr(v_code, p_codes)
                );
            END LOOP;
        END IF;
        RETURN '(' || array_to_string(v_parts, ' OR ') || ')';
    END IF;

    v_expr := reporting.col_expr(v_field, p_codes);
    v_kind := reporting.col_kind(v_field, p_meta);
    v_cmp := CASE WHEN v_kind = 'text' THEN 'lower(' || v_expr || ')' ELSE v_expr END;

    CASE v_op
        WHEN 'isNull'  THEN RETURN v_expr || ' IS NULL';
        WHEN 'notNull' THEN RETURN v_expr || ' IS NOT NULL';
        WHEN 'eq'  THEN RETURN format('%s = %s', v_cmp, CASE WHEN v_kind = 'text' THEN 'lower(' || reporting.lit(v_val, v_kind) || ')' ELSE reporting.lit(v_val, v_kind) END);
        WHEN 'neq' THEN RETURN format('NOT COALESCE(%s = %s, false)', v_cmp, CASE WHEN v_kind = 'text' THEN 'lower(' || reporting.lit(v_val, v_kind) || ')' ELSE reporting.lit(v_val, v_kind) END);
        WHEN 'gt'  THEN RETURN format('%s > %s',  v_expr, reporting.lit(v_val, v_kind));
        WHEN 'gte' THEN RETURN format('%s >= %s', v_expr, reporting.lit(v_val, v_kind));
        WHEN 'lt'  THEN RETURN format('%s < %s',  v_expr, reporting.lit(v_val, v_kind));
        WHEN 'lte' THEN RETURN format('%s <= %s', v_expr, reporting.lit(v_val, v_kind));
        WHEN 'in'  THEN RETURN format('%s = ANY (ARRAY[%s])', v_cmp, reporting.lit_list(v_val, v_kind, true));
        WHEN 'nin' THEN RETURN format('NOT COALESCE(%s = ANY (ARRAY[%s]), false)', v_cmp, reporting.lit_list(v_val, v_kind, true));
        WHEN 'contains'   THEN RETURN format('position(lower(%s) in lower(%s::text)) > 0', reporting.lit(v_val, 'text'), v_expr);
        WHEN 'startsWith' THEN RETURN format('left(lower(%s::text), char_length(%s)) = lower(%s)', v_expr, reporting.lit(v_val, 'text'), reporting.lit(v_val, 'text'));
        WHEN 'between' THEN
            v_lo := CASE WHEN jsonb_typeof(v_val) = 'array' THEN v_val->0 ELSE v_val END;
            v_hi := CASE WHEN jsonb_typeof(v_val) = 'array' THEN v_val->1 ELSE NULL END;
            IF v_lo IS NULL OR jsonb_typeof(v_lo) = 'null' THEN
                IF v_hi IS NULL OR jsonb_typeof(v_hi) = 'null' THEN RAISE EXCEPTION 'between needs at least one bound'; END IF;
                RETURN format('%s <= %s', v_expr, reporting.lit(v_hi, v_kind));
            ELSIF v_hi IS NULL OR jsonb_typeof(v_hi) = 'null' THEN
                RETURN format('%s >= %s', v_expr, reporting.lit(v_lo, v_kind));
            END IF;
            RETURN format('%s BETWEEN %s AND %s', v_expr, reporting.lit(v_lo, v_kind), reporting.lit(v_hi, v_kind));
        ELSE RAISE EXCEPTION 'Unsupported operator: %', v_op;
    END CASE;
END;
$fn$;
