-- Migration: Report Grid / Data Query execution in SQL
-- Description: Set-based, bi-temporal execution of dashboard / narrative data queries.
--
--   reporting.resolve_entities  -- start set + relationship traversal AS OF a date
--                                  (valid time) and knowledge time (system time).
--   reporting.grid              -- one request in, one JSON page out:
--                                    * pivots ONLY the attributes the request touches
--                                      (visible columns, filters, sort, group-by, metrics)
--                                    * server-side filter / sort / pagination
--                                    * hierarchical group-by with summary rows, using each
--                                      attribute's own aggregation_type / weight / precision
--                                    * flat aggregate mode with explicit metrics
--   public.report_grid          -- thin PostgREST/RPC wrapper
--
-- All functions are SECURITY INVOKER: the caller's RLS (tenancy / entity ACLs) applies.
-- Bi-temporal predicate convention matches compliance.* : valid_from <= d <= valid_to and
-- system_from <= k <= system_to.

CREATE SCHEMA IF NOT EXISTS reporting;
COMMENT ON SCHEMA reporting IS 'Set-based execution helpers for dashboards, grids and narratives.';

-- ============================================================
-- 1. Indexes supporting traversal and as-of lookups
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_entity_rel_parent_asof
    ON entity_instances.entity_relationships (parent_entity_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_entity_rel_child_asof
    ON entity_instances.entity_relationships (child_entity_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_eav_entity_attr_prec
    ON golden_master.entity_attribute_values (entity_id, attribute_id, precedence_rank);

-- ============================================================
-- 2. Entity set resolution
-- ============================================================
CREATE OR REPLACE FUNCTION reporting.resolve_entities(
    p_start text,
    p_domain_code text,
    p_context_entity uuid,
    p_path jsonb,
    p_include_anchor boolean,
    p_as_of date,
    p_knowledge timestamptz
) RETURNS uuid[]
LANGUAGE plpgsql STABLE
AS $fn$
DECLARE
    c_limit CONSTANT int := 200000;
    v_ids uuid[];
    v_anchor uuid[];
    v_hop jsonb;
    v_dir text;
    v_rel text;
    v_dom text;
    v_max int;
    v_incl boolean;
    v_visited uuid[];
    v_frontier uuid[];
    v_collected uuid[];
    v_next uuid[];
    d int;
BEGIN
    IF p_start = 'DOMAIN' THEN
        IF p_domain_code IS NULL THEN
            RAISE EXCEPTION 'start=DOMAIN requires domainCode';
        END IF;
        SELECT COALESCE(array_agg(me.id), '{}') INTO v_ids
        FROM entity_instances.master_entities me
        WHERE me.domain_code = p_domain_code AND me.is_active;
    ELSE
        IF p_context_entity IS NULL THEN
            RAISE EXCEPTION 'start=CONTEXT requires an entity context (none supplied)';
        END IF;
        v_ids := ARRAY[p_context_entity];
    END IF;
    v_anchor := v_ids;

    FOR v_hop IN SELECT value FROM jsonb_array_elements(COALESCE(p_path, '[]'::jsonb)) LOOP
        v_dir  := upper(COALESCE(v_hop->>'direction', 'DOWN'));
        v_rel  := NULLIF(v_hop->>'relationshipCode', '');
        v_dom  := NULLIF(v_hop->>'domainCode', '');
        v_incl := COALESCE((v_hop->>'includeStart')::boolean, false);
        v_max  := CASE WHEN COALESCE((v_hop->>'recursive')::boolean, false)
                       THEN LEAST(GREATEST(COALESCE((v_hop->>'maxDepth')::int, 5), 1), 10)
                       ELSE 1 END;

        v_visited   := v_ids;
        v_frontier  := v_ids;
        v_collected := CASE WHEN v_incl THEN v_ids ELSE '{}'::uuid[] END;

        FOR d IN 1..v_max LOOP
            EXIT WHEN COALESCE(cardinality(v_frontier), 0) = 0;

            IF v_dir = 'UP' THEN
                SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}') INTO v_next
                FROM entity_instances.entity_relationships er
                WHERE er.child_entity_id = ANY (v_frontier)
                  AND (v_rel IS NULL OR er.relationship_code = v_rel OR er.relationship_type = v_rel)
                  AND er.valid_from <= p_as_of AND er.valid_to >= p_as_of
                  AND er.system_from <= p_knowledge AND er.system_to >= p_knowledge
                  AND NOT (er.parent_entity_id = ANY (v_visited));
            ELSE
                SELECT COALESCE(array_agg(DISTINCT er.child_entity_id), '{}') INTO v_next
                FROM entity_instances.entity_relationships er
                WHERE er.parent_entity_id = ANY (v_frontier)
                  AND (v_rel IS NULL OR er.relationship_code = v_rel OR er.relationship_type = v_rel)
                  AND er.valid_from <= p_as_of AND er.valid_to >= p_as_of
                  AND er.system_from <= p_knowledge AND er.system_to >= p_knowledge
                  AND NOT (er.child_entity_id = ANY (v_visited));
            END IF;

            -- Only active entities that the caller can see take part (RLS applies here).
            SELECT COALESCE(array_agg(me.id), '{}') INTO v_next
            FROM entity_instances.master_entities me
            WHERE me.id = ANY (v_next) AND me.is_active;

            EXIT WHEN cardinality(v_next) = 0;

            v_visited := v_visited || v_next;
            IF cardinality(v_visited) > c_limit THEN
                RAISE EXCEPTION 'Relationship traversal exceeded % entities; narrow the query', c_limit;
            END IF;
            v_frontier := v_next;

            IF v_dom IS NULL THEN
                v_collected := v_collected || v_next;
            ELSE
                v_collected := v_collected || ARRAY(
                    SELECT me.id FROM entity_instances.master_entities me
                    WHERE me.id = ANY (v_next) AND me.domain_code = v_dom);
            END IF;
        END LOOP;

        v_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_collected) x);
    END LOOP;

    IF p_include_anchor THEN
        v_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_ids || v_anchor) x);
    END IF;

    RETURN v_ids;
END;
$fn$;

-- ============================================================
-- 3. SQL-building helpers (pure string builders; identifiers are positional,
--    all user-supplied values pass through %L / strict regex validation)
-- ============================================================
CREATE OR REPLACE FUNCTION reporting.col_expr(p_field text, p_codes text[])
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
    IF p_field IN ('entity_code', 'entity_name', 'domain_code') THEN RETURN 'b.' || p_field; END IF;
    IF p_field = 'entity_id' THEN RETURN 'b.id::text'; END IF;
    IF array_position(p_codes, p_field) IS NULL THEN
        RAISE EXCEPTION 'Unknown field: %', p_field;
    END IF;
    RETURN 'b.c' || array_position(p_codes, p_field);
END;
$fn$;

CREATE OR REPLACE FUNCTION reporting.col_kind(p_field text, p_meta jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE WHEN p_field IN ('entity_code', 'entity_name', 'domain_code', 'entity_id') THEN 'text'
                ELSE COALESCE(p_meta->p_field->>'kind', 'text') END;
$fn$;

CREATE OR REPLACE FUNCTION reporting.val_expr(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE p_kind
        WHEN 'num'  THEN $q$COALESCE(v.num, CASE WHEN v.txt ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.txt::numeric END)$q$
        WHEN 'date' THEN $q$COALESCE(v.dt, v.ts::date, CASE WHEN v.txt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(v.txt, 10)::date END)$q$
        ELSE 'v.txt' END;
$fn$;

CREATE OR REPLACE FUNCTION reporting.lit(p_value jsonb, p_kind text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v text := p_value #>> '{}';
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'A filter value is required'; END IF;
    IF p_kind = 'num' THEN
        IF v !~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN RAISE EXCEPTION 'Invalid number: %', v; END IF;
        RETURN format('%L::numeric', btrim(v));
    ELSIF p_kind = 'date' THEN
        IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN RAISE EXCEPTION 'Invalid date: %', v; END IF;
        RETURN format('%L::date', left(v, 10));
    END IF;
    RETURN format('%L', v);
END;
$fn$;

-- Comma separated SQL literal list from a JSON array or a comma-delimited string.
CREATE OR REPLACE FUNCTION reporting.lit_list(p_value jsonb, p_kind text, p_lower boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    v_items jsonb;
    v_out text[] := '{}';
    e jsonb;
    l text;
BEGIN
    IF jsonb_typeof(p_value) = 'array' THEN
        v_items := p_value;
    ELSIF jsonb_typeof(p_value) = 'string' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(btrim(s))), '[]'::jsonb) INTO v_items
        FROM unnest(string_to_array(p_value #>> '{}', ',')) s WHERE btrim(s) <> '';
    ELSE
        v_items := jsonb_build_array(p_value);
    END IF;
    FOR e IN SELECT value FROM jsonb_array_elements(v_items) LOOP
        l := reporting.lit(e, p_kind);
        v_out := v_out || CASE WHEN p_lower AND p_kind = 'text' THEN 'lower(' || l || ')' ELSE l END;
    END LOOP;
    IF cardinality(v_out) = 0 THEN RETURN 'NULL'; END IF;
    RETURN array_to_string(v_out, ', ');
END;
$fn$;

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
BEGIN
    IF v_field IS NULL OR v_op IS NULL THEN RAISE EXCEPTION 'Each filter needs field and op'; END IF;
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

-- Aggregate expression over alias `b`. Returns NULL when the aggregation does not apply.
CREATE OR REPLACE FUNCTION reporting.agg_sql(
    p_field text, p_agg text, p_weight text, p_precision int,
    p_codes text[], p_meta jsonb, p_strict boolean
) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    v_agg text := upper(COALESCE(p_agg, 'NONE'));
    v_expr text;
    v_kind text;
    v_w text;
    v_res text;
BEGIN
    IF v_agg = 'COUNT' THEN
        RETURN CASE WHEN p_field IS NULL THEN 'count(*)' ELSE format('count(%s)', reporting.col_expr(p_field, p_codes)) END;
    ELSIF v_agg = 'COUNT_DISTINCT' THEN
        RETURN CASE WHEN p_field IS NULL THEN 'count(DISTINCT b.id)' ELSE format('count(DISTINCT %s)', reporting.col_expr(p_field, p_codes)) END;
    END IF;

    IF p_field IS NULL THEN
        IF p_strict THEN RAISE EXCEPTION '% requires a field', v_agg; END IF;
        RETURN NULL;
    END IF;
    v_expr := reporting.col_expr(p_field, p_codes);
    v_kind := reporting.col_kind(p_field, p_meta);

    IF v_agg = 'SUM' AND v_kind = 'num' THEN v_res := format('sum(%s)', v_expr);
    ELSIF v_agg = 'AVG' AND v_kind = 'num' THEN v_res := format('avg(%s)', v_expr);
    ELSIF v_agg = 'MIN' AND v_kind IN ('num', 'date') THEN RETURN format('min(%s)', v_expr);
    ELSIF v_agg = 'MAX' AND v_kind IN ('num', 'date') THEN RETURN format('max(%s)', v_expr);
    ELSIF v_agg = 'WEIGHTED_AVG' AND v_kind = 'num' AND p_weight IS NOT NULL THEN
        v_w := reporting.col_expr(p_weight, p_codes);
        v_res := format(
            'sum(%1$s * %2$s) FILTER (WHERE %1$s IS NOT NULL AND %2$s IS NOT NULL) / NULLIF(sum(%2$s) FILTER (WHERE %1$s IS NOT NULL AND %2$s IS NOT NULL), 0)',
            v_expr, v_w);
    ELSE
        IF p_strict AND v_agg NOT IN ('NONE') THEN
            RAISE EXCEPTION 'Aggregation % is not applicable to field % (type %)', v_agg, p_field, v_kind;
        END IF;
        RETURN NULL;
    END IF;

    IF p_precision IS NOT NULL THEN
        v_res := format('round((%s)::numeric, %s)', v_res, p_precision);
    END IF;
    RETURN v_res;
END;
$fn$;

-- jsonb_build_object takes at most 100 args: chunk key/value pair strings.
CREATE OR REPLACE FUNCTION reporting.obj_sql(p_pairs text[])
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    v_parts text[] := '{}';
    i int := 1;
    n int := COALESCE(cardinality(p_pairs), 0);
BEGIN
    IF n = 0 THEN RETURN 'jsonb_build_object()'; END IF;
    WHILE i <= n LOOP
        v_parts := v_parts || ('jsonb_build_object(' || array_to_string(p_pairs[i:least(i + 39, n)], ', ') || ')');
        i := i + 40;
    END LOOP;
    RETURN array_to_string(v_parts, ' || ');
END;
$fn$;

-- ============================================================
-- 4. The grid
-- ============================================================
CREATE OR REPLACE FUNCTION reporting.grid(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $fn$
DECLARE
    c_builtin CONSTANT text[] := ARRAY['entity_id', 'entity_code', 'entity_name', 'domain_code'];
    v_asof date := COALESCE(NULLIF(p_request->>'asOfDate', '')::date, CURRENT_DATE);
    v_know timestamptz := COALESCE(NULLIF(p_request->>'knowledgeDate', '')::timestamptz, now());
    v_domain text := NULLIF(p_request->>'domainCode', '');
    v_export boolean := COALESCE((p_request->>'export')::boolean, false);
    v_limit int;
    v_offset int := GREATEST(COALESCE((p_request->>'offset')::int, 0), 0);
    v_columns jsonb := COALESCE(p_request->'columns', '[]'::jsonb);
    v_filters jsonb := COALESCE(p_request->'filters', '[]'::jsonb);
    v_sort jsonb := COALESCE(p_request->'sort', '[]'::jsonb);
    v_group_by jsonb := COALESCE(p_request->'groupBy', '[]'::jsonb);
    v_group_keys jsonb := COALESCE(p_request->'groupKeys', '[]'::jsonb);
    v_metrics jsonb := COALESCE(p_request->'metrics', '[]'::jsonb);
    v_flat boolean := COALESCE((p_request->>'flat')::boolean, false);
    v_n int := jsonb_array_length(COALESCE(p_request->'groupBy', '[]'::jsonb));
    v_l int := jsonb_array_length(COALESCE(p_request->'groupKeys', '[]'::jsonb));
    v_ids uuid[];
    v_codes text[];
    v_extra text[];
    v_missing text[];
    v_meta jsonb;
    v_mode text;
    v_pivot text := '';
    v_where text := 'TRUE';
    v_gk_where text := 'TRUE';
    v_order text := '';
    v_rowobj text;
    v_pairs text[];
    v_sum_pairs text[] := ARRAY['''_count'', count(*)'];
    v_agg_cols text[] := '{}';   -- visible columns that have a summary aggregate (in order)
    v_agg_exprs text[] := '{}';
    v_prefix text;
    v_sql text;
    v_result jsonb;
    v_cols_meta jsonb;
    v_item jsonb;
    v_field text;
    v_kind text;
    v_expr text;
    v_agg text;
    v_gexprs text[] := '{}';
    v_gsel text := '';
    v_msel text := '';
    v_aorder text := '';
    v_gorder text;
    v_dir text;
    i int;
    j int;
BEGIN
    v_limit := LEAST(GREATEST(COALESCE((p_request->>'limit')::int, 50), 1), CASE WHEN v_export THEN 100000 ELSE 500 END);
    IF v_l > v_n THEN RAISE EXCEPTION 'groupKeys has more entries than groupBy'; END IF;

    -- ---- attribute codes this request touches (builtins excluded) ----
    SELECT COALESCE(array_agg(DISTINCT f ORDER BY f), '{}') INTO v_codes FROM (
        SELECT jsonb_array_elements_text(v_columns) AS f
        UNION SELECT jsonb_array_elements_text(v_group_by)
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_filters) x
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_sort) x
            WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_metrics) m WHERE m->>'alias' = x->>'field')
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_metrics) x
        UNION SELECT x->>'weightField' FROM jsonb_array_elements(v_metrics) x
    ) s WHERE f IS NOT NULL AND f <> ALL (c_builtin);

    -- weight attributes needed by default (WEIGHTED_AVG) aggregations
    SELECT COALESCE(array_agg(DISTINCT ar.weight_attribute_code), '{}') INTO v_extra
    FROM metadata_register.attribute_register ar
    WHERE ar.attribute_code = ANY (v_codes)
      AND ar.aggregation_type = 'WEIGHTED_AVG' AND ar.weight_attribute_code IS NOT NULL;
    SELECT COALESCE(array_agg(DISTINCT c ORDER BY c), '{}') INTO v_codes FROM unnest(v_codes || v_extra) c;

    SELECT array_agg(c) INTO v_missing FROM unnest(v_codes) c
    WHERE NOT EXISTS (SELECT 1 FROM metadata_register.attribute_register ar WHERE ar.attribute_code = c);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown attribute(s): %', array_to_string(v_missing, ', ');
    END IF;

    SELECT COALESCE(jsonb_object_agg(ar.attribute_code, jsonb_build_object(
               'kind', CASE WHEN upper(ar.data_type) IN ('NUMBER','CURRENCY','PERCENTAGE','INTEGER','DECIMAL','FLOAT','NUMERIC') THEN 'num' WHEN upper(ar.data_type) IN ('DATE','TIMESTAMP','DATETIME') THEN 'date' ELSE 'text' END,
               'agg', COALESCE(ar.aggregation_type, 'NONE'),
               'weight', ar.weight_attribute_code,
               'precision', ar.numeric_precision,
               'name', ar.attribute_name,
               'unit', ar.unit_of_measure)), '{}'::jsonb)
    INTO v_meta
    FROM metadata_register.attribute_register ar WHERE ar.attribute_code = ANY (v_codes);

    -- ---- entity set ----
    v_ids := reporting.resolve_entities(
        COALESCE(p_request->>'start', 'CONTEXT'), v_domain,
        NULLIF(p_request->>'contextEntityId', '')::uuid,
        p_request->'path', COALESCE((p_request->>'includeAnchor')::boolean, false),
        v_asof, v_know);

    -- ---- pivot columns ----
    FOR i IN 1..COALESCE(cardinality(v_codes), 0) LOOP
        v_pivot := v_pivot || format(', max(CASE WHEN v.code = %L THEN %s END) AS c%s',
            v_codes[i], reporting.val_expr(v_meta->v_codes[i]->>'kind'), i);
    END LOOP;

    -- ---- filters ----
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_filters) LOOP
        v_where := v_where || ' AND (' || reporting.filter_sql(v_item, v_codes, v_meta) || ')';
    END LOOP;

    -- ---- group key restriction (hierarchical drill-down) ----
    FOR i IN 1..v_l LOOP
        v_field := v_group_by->>(i - 1);
        v_expr := reporting.col_expr(v_field, v_codes);
        v_kind := reporting.col_kind(v_field, v_meta);
        IF jsonb_typeof(v_group_keys->(i - 1)) = 'null' THEN
            v_gk_where := v_gk_where || format(' AND %s IS NULL', v_expr);
        ELSE
            v_gk_where := v_gk_where || format(' AND %s = %s', v_expr, reporting.lit(v_group_keys->(i - 1), v_kind));
        END IF;
    END LOOP;

    -- ---- default aggregates for visible columns (attribute-defined aggregation) ----
    FOR i IN 0..jsonb_array_length(v_columns) - 1 LOOP
        v_field := v_columns->>i;
        CONTINUE WHEN v_field = ANY (c_builtin);
        v_expr := reporting.agg_sql(v_field, v_meta->v_field->>'agg', v_meta->v_field->>'weight',
                                    NULLIF(v_meta->v_field->>'precision', '')::int, v_codes, v_meta, false);
        IF v_expr IS NOT NULL THEN
            v_agg_cols := v_agg_cols || v_field;
            v_agg_exprs := v_agg_exprs || v_expr;
            v_sum_pairs := v_sum_pairs || format('%L, %s', v_field, v_expr);
        END IF;
    END LOOP;

    -- ---- sort (rows mode) ----
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_sort) LOOP
        CONTINUE WHEN (v_item->>'field') IS NULL;
        v_dir := CASE WHEN lower(v_item->>'dir') = 'desc' THEN 'DESC' ELSE 'ASC' END;
        BEGIN
            v_order := v_order || format('%s %s NULLS LAST, ', reporting.col_expr(v_item->>'field', v_codes), v_dir);
        EXCEPTION WHEN OTHERS THEN
            NULL; -- aggregate-mode sorts on metric aliases are resolved separately
        END;
    END LOOP;
    v_order := v_order || 'b.entity_code, b.id';

    -- ---- common CTE prefix ----
    v_prefix := format($q$
        WITH ents AS (
            SELECT me.id, me.entity_code, me.entity_name, me.domain_code
            FROM entity_instances.master_entities me
            WHERE me.id = ANY ($1) AND me.is_active AND ($4::text IS NULL OR me.domain_code = $4::text)
        ), vals AS (
            SELECT DISTINCT ON (eav.entity_id, ar.attribute_code)
                   eav.entity_id, ar.attribute_code AS code,
                   eav.golden_value AS txt, eav.golden_value_numeric AS num,
                   eav.golden_value_date AS dt, eav.golden_value_timestamp AS ts
            FROM golden_master.entity_attribute_values eav
            JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
            WHERE eav.entity_id = ANY ($1) AND ar.attribute_code = ANY ($2)
              AND eav.valid_from <= $3 AND eav.valid_to >= $3
              AND eav.system_from <= $5 AND eav.system_to >= $5
              AND eav.golden_value IS NOT NULL AND eav.golden_value <> ''
            ORDER BY eav.entity_id, ar.attribute_code, eav.precedence_rank
        ), base AS (
            SELECT e.id, e.entity_code, e.entity_name, e.domain_code %s
            FROM ents e LEFT JOIN vals v ON v.entity_id = e.id
            GROUP BY e.id, e.entity_code, e.entity_name, e.domain_code
        ), filt AS (
            SELECT * FROM base b WHERE %s
        )
    $q$, v_pivot, v_where);

    v_mode := CASE
        WHEN jsonb_array_length(v_metrics) > 0 OR v_flat THEN 'aggregate'
        WHEN v_n > 0 AND v_l < v_n THEN 'groups'
        ELSE 'rows' END;

    IF v_mode = 'rows' THEN
        v_pairs := ARRAY['''entity_id'', b.id', '''entity_code'', b.entity_code', '''entity_name'', b.entity_name', '''domain_code'', b.domain_code'];
        FOR i IN 0..jsonb_array_length(v_columns) - 1 LOOP
            v_field := v_columns->>i;
            CONTINUE WHEN v_field = ANY (c_builtin);
            v_pairs := v_pairs || format('%L, %s', v_field, reporting.col_expr(v_field, v_codes));
        END LOOP;
        v_rowobj := reporting.obj_sql(v_pairs);

        v_sql := v_prefix || format($q$
            , scoped AS (SELECT * FROM filt b WHERE %s)
            , page AS (
                SELECT b.*, row_number() OVER (ORDER BY %s) AS rn
                FROM scoped b ORDER BY rn LIMIT $6 OFFSET $7)
            SELECT jsonb_build_object(
                'mode', 'rows', 'level', %s,
                'total', (SELECT count(*) FROM scoped),
                'matched', (SELECT count(*) FROM scoped),
                'rows', COALESCE((SELECT jsonb_agg(%s ORDER BY b.rn) FROM page b), '[]'::jsonb),
                'summary', (SELECT %s FROM filt b))
        $q$, v_gk_where, v_order, v_l, v_rowobj, reporting.obj_sql(v_sum_pairs));

    ELSIF v_mode = 'groups' THEN
        v_field := v_group_by->>v_l;
        v_expr := reporting.col_expr(v_field, v_codes);
        v_pairs := ARRAY['''_key'', g.gk', '''_count'', g.cnt'];
        FOR j IN 1..COALESCE(cardinality(v_agg_cols), 0) LOOP
            v_msel := v_msel || format(', %s AS a%s', v_agg_exprs[j], j);
            v_pairs := v_pairs || format('%L, g.a%s', v_agg_cols[j], j);
        END LOOP;
        -- order groups by an aggregated column if requested, else by key
        v_gorder := 'g.gk NULLS LAST';
        IF jsonb_array_length(v_sort) > 0 THEN
            j := array_position(v_agg_cols, v_sort->0->>'field');
            IF j IS NOT NULL THEN
                v_gorder := format('g.a%s %s NULLS LAST, g.gk NULLS LAST', j,
                    CASE WHEN lower(v_sort->0->>'dir') = 'desc' THEN 'DESC' ELSE 'ASC' END);
            ELSIF (v_sort->0->>'field') = v_field AND lower(v_sort->0->>'dir') = 'desc' THEN
                v_gorder := 'g.gk DESC NULLS LAST';
            END IF;
        END IF;

        v_sql := v_prefix || format($q$
            , scoped AS (SELECT * FROM filt b WHERE %s)
            , grp AS (SELECT %s AS gk, count(*) AS cnt %s FROM scoped b GROUP BY 1)
            , gpage AS (
                SELECT g.*, row_number() OVER (ORDER BY %s) AS rn
                FROM grp g ORDER BY rn LIMIT $6 OFFSET $7)
            SELECT jsonb_build_object(
                'mode', 'groups', 'level', %s, 'groupField', %L,
                'total', (SELECT count(*) FROM grp),
                'matched', (SELECT count(*) FROM scoped),
                'rows', COALESCE((SELECT jsonb_agg(%s ORDER BY g.rn) FROM gpage g), '[]'::jsonb),
                'summary', (SELECT %s FROM filt b))
        $q$, v_gk_where, v_expr, v_msel, v_gorder, v_l, v_field,
             reporting.obj_sql(v_pairs), reporting.obj_sql(v_sum_pairs));

    ELSE  -- aggregate: group by ALL groupBy fields at once, explicit metrics
        v_pairs := '{}';
        FOR i IN 0..v_n - 1 LOOP
            v_field := v_group_by->>i;
            v_gexprs := v_gexprs || reporting.col_expr(v_field, v_codes);
            v_gsel := v_gsel || format('%s AS g%s, ', v_gexprs[i + 1], i + 1);
            v_pairs := v_pairs || format('%L, g.g%s', v_field, i + 1);
        END LOOP;
        FOR j IN 0..jsonb_array_length(v_metrics) - 1 LOOP
            v_item := v_metrics->j;
            v_expr := reporting.agg_sql(v_item->>'field', v_item->>'agg', v_item->>'weightField', NULL, v_codes, v_meta, true);
            IF v_expr IS NULL THEN RAISE EXCEPTION 'Metric % is not computable', COALESCE(v_item->>'alias', j::text); END IF;
            v_msel := v_msel || format('%s AS m%s, ', v_expr, j + 1);
            v_pairs := v_pairs || format('%L, g.m%s', COALESCE(v_item->>'alias', 'metric_' || (j + 1)), j + 1);
        END LOOP;
        IF jsonb_array_length(v_metrics) = 0 THEN
            v_msel := 'count(*) AS m1, ';
            v_pairs := v_pairs || '''count'', g.m1';
        END IF;
        v_msel := rtrim(v_msel, ', ');

        -- sorting: group field or metric alias; default = group keys
        FOR v_item IN SELECT value FROM jsonb_array_elements(v_sort) LOOP
            v_dir := CASE WHEN lower(v_item->>'dir') = 'desc' THEN 'DESC' ELSE 'ASC' END;
            FOR i IN 0..v_n - 1 LOOP
                IF v_group_by->>i = v_item->>'field' THEN v_aorder := v_aorder || format('g.g%s %s NULLS LAST, ', i + 1, v_dir); END IF;
            END LOOP;
            FOR j IN 0..jsonb_array_length(v_metrics) - 1 LOOP
                IF v_metrics->j->>'alias' = v_item->>'field' THEN v_aorder := v_aorder || format('g.m%s %s NULLS LAST, ', j + 1, v_dir); END IF;
            END LOOP;
        END LOOP;
        FOR i IN 1..v_n LOOP v_aorder := v_aorder || format('g.g%s NULLS LAST, ', i); END LOOP;
        v_aorder := CASE WHEN v_aorder = '' THEN '1' ELSE rtrim(v_aorder, ', ') END;

        v_sql := v_prefix || format($q$
            , grp AS (SELECT %s %s FROM filt b %s)
            , gpage AS (
                SELECT g.*, row_number() OVER (ORDER BY %s) AS rn
                FROM grp g ORDER BY rn LIMIT $6 OFFSET $7)
            SELECT jsonb_build_object(
                'mode', 'aggregate',
                'total', (SELECT count(*) FROM grp),
                'matched', (SELECT count(*) FROM filt),
                'rows', COALESCE((SELECT jsonb_agg(%s ORDER BY g.rn) FROM gpage g), '[]'::jsonb))
        $q$, v_gsel, v_msel,
             CASE WHEN v_n > 0 THEN 'GROUP BY ' || (SELECT string_agg(x::text, ', ') FROM generate_series(1, v_n) x) ELSE '' END,
             v_aorder, reporting.obj_sql(v_pairs));
    END IF;

    EXECUTE v_sql INTO v_result USING v_ids, v_codes, v_asof, v_domain, v_know, v_limit, v_offset;

    -- ---- column metadata for the UI ----
    SELECT COALESCE(jsonb_agg(
        CASE WHEN c = ANY (c_builtin)
             THEN jsonb_build_object('code', c, 'name', c, 'kind', 'text', 'aggregation', 'NONE')
             ELSE jsonb_build_object('code', c, 'name', v_meta->c->>'name', 'kind', v_meta->c->>'kind',
                      'aggregation', v_meta->c->>'agg', 'weight', v_meta->c->>'weight',
                      'unit', v_meta->c->>'unit', 'precision', v_meta->c->'precision') END), '[]'::jsonb)
    INTO v_cols_meta
    FROM jsonb_array_elements_text(v_columns) c;

    RETURN v_result || jsonb_build_object(
        'columns', v_cols_meta, 'groupBy', v_group_by,
        'asOfDate', v_asof, 'knowledgeDate', v_know, 'entityCount', cardinality(v_ids));
END;
$fn$;

-- ============================================================
-- 5. Public RPC wrapper + grants
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_grid(p_request jsonb)
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout = '30s'
AS $fn$ SELECT reporting.grid(p_request); $fn$;

COMMENT ON FUNCTION public.report_grid(jsonb) IS 'Bi-temporal, paginated, server-side grid/aggregate query over an entity set (see reporting.grid). SECURITY INVOKER: caller RLS applies.';

GRANT USAGE ON SCHEMA reporting TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_grid(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
