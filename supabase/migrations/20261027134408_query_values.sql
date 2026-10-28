-- Ad hoc questions need two grains.
-- Entity grain (reporting.grid) is one row per record of a domain.
-- Value grain is one row per prevailing field: the source the screen shows,
-- the value, and which record it belongs to. Omitting domainCode on an entity
-- query means every active record the caller can read.

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
        SELECT COALESCE(array_agg(me.id), '{}') INTO v_ids
        FROM entity_instances.master_entities me
        WHERE me.is_active
          AND (p_domain_code IS NULL OR me.domain_code = p_domain_code);
        IF COALESCE(cardinality(v_ids), 0) > c_limit THEN
            RAISE EXCEPTION 'Query covers more than % entities; set domainCode to narrow it', c_limit;
        END IF;
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

CREATE OR REPLACE FUNCTION reporting.value_expr(p_field text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
BEGIN
    CASE p_field
        WHEN 'domain_code' THEN RETURN 'b.domain_code';
        WHEN 'entity_code' THEN RETURN 'b.entity_code';
        WHEN 'entity_name' THEN RETURN 'b.entity_name';
        WHEN 'entity_id' THEN RETURN 'b.entity_id::text';
        WHEN 'attribute_code' THEN RETURN 'b.attribute_code';
        WHEN 'attribute_name' THEN RETURN 'b.attribute_name';
        WHEN 'value' THEN RETURN 'b.value';
        WHEN 'numeric_value' THEN RETURN 'b.numeric_value';
        WHEN 'source_code' THEN RETURN 'b.source_code';
        WHEN 'source_name' THEN RETURN 'b.source_name';
        WHEN 'valid_from' THEN RETURN 'b.valid_from';
        WHEN 'received_at' THEN RETURN 'b.received_at';
        ELSE RAISE EXCEPTION 'Unknown field: %', p_field;
    END CASE;
END;
$fn$;

CREATE OR REPLACE FUNCTION reporting.value_kind(p_field text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
    SELECT CASE p_field
        WHEN 'numeric_value' THEN 'num'
        WHEN 'valid_from' THEN 'date'
        WHEN 'received_at' THEN 'date'
        ELSE 'text'
    END;
$fn$;

CREATE OR REPLACE FUNCTION reporting.value_filter(p_filter jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
    v_field text := p_filter->>'field';
    v_op text := p_filter->>'op';
    v_val jsonb := p_filter->'value';
    v_expr text;
    v_kind text;
    v_cmp text;
    v_lo jsonb;
    v_hi jsonb;
BEGIN
    IF v_field IS NULL OR v_op IS NULL THEN
        RAISE EXCEPTION 'Each filter needs field and op';
    END IF;
    v_expr := reporting.value_expr(v_field);
    v_kind := reporting.value_kind(v_field);
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

CREATE OR REPLACE FUNCTION reporting.value_query(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = reporting, public, entity_instances, metadata_register, golden_master, pg_catalog
SET statement_timeout = '45s'
AS $fn$
DECLARE
    v_asof date := COALESCE(NULLIF(p_request->>'asOfDate', '')::date, CURRENT_DATE);
    v_know timestamptz := COALESCE(NULLIF(p_request->>'knowledgeDate', '')::timestamptz, clock_timestamp());
    v_domain text := NULLIF(upper(btrim(COALESCE(p_request->>'domainCode', ''))), '');
    v_attrs text[];
    v_filters jsonb := COALESCE(p_request->'filters', '[]'::jsonb);
    v_group jsonb := COALESCE(p_request->'groupBy', '[]'::jsonb);
    v_metrics jsonb := COALESCE(p_request->'metrics', '[]'::jsonb);
    v_select jsonb := COALESCE(p_request->'select', '[]'::jsonb);
    v_order jsonb := COALESCE(p_request->'orderBy', '[]'::jsonb);
    v_limit int;
    v_where text := 'TRUE';
    v_item jsonb;
    v_field text;
    v_alias text;
    v_agg text;
    v_expr text;
    v_dir text;
    v_select_list text := '';
    v_group_sql text := '';
    v_window text := '';
    v_metric_exprs jsonb := '{}'::jsonb;
    v_sql text;
    v_result jsonb;
    i int;
    v_aggregate boolean;
BEGIN
    IF jsonb_typeof(p_request->'attributeCodes') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT upper(btrim(x))), '{}') INTO v_attrs
        FROM jsonb_array_elements_text(p_request->'attributeCodes') x
        WHERE btrim(x) <> '';
        IF COALESCE(cardinality(v_attrs), 0) = 0 THEN v_attrs := NULL; END IF;
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_filters) LOOP
        v_where := v_where || ' AND (' || reporting.value_filter(v_item) || ')';
    END LOOP;

    v_aggregate := jsonb_array_length(v_group) > 0 OR jsonb_array_length(v_metrics) > 0;
    v_limit := LEAST(GREATEST(COALESCE((p_request->>'limit')::int, CASE WHEN v_aggregate THEN 200 ELSE 40 END), 1), 200);

    IF v_aggregate THEN
        FOR i IN 0..jsonb_array_length(v_group) - 1 LOOP
            v_field := v_group->>i;
            v_expr := reporting.value_expr(v_field);
            v_select_list := v_select_list || format('%s AS %I, ', v_expr, v_field);
            v_group_sql := v_group_sql || format('%s, ', (i + 1));
        END LOOP;
        IF jsonb_array_length(v_metrics) = 0 THEN
            v_metrics := '[{"alias":"count","agg":"COUNT"}]'::jsonb;
        END IF;
        FOR i IN 0..jsonb_array_length(v_metrics) - 1 LOOP
            v_item := v_metrics->i;
            v_alias := v_item->>'alias';
            v_agg := upper(COALESCE(v_item->>'agg', ''));
            v_field := NULLIF(v_item->>'field', '');
            IF v_alias IS NULL OR v_alias !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
                RAISE EXCEPTION 'Metric alias must be an identifier';
            END IF;
            IF v_metric_exprs ? v_alias THEN
                RAISE EXCEPTION 'Duplicate metric alias: %', v_alias;
            END IF;
            IF v_agg = 'COUNT' THEN
                v_expr := 'count(*)';
            ELSIF v_agg = 'COUNT_DISTINCT' THEN
                IF v_field IS NULL THEN RAISE EXCEPTION 'COUNT_DISTINCT needs a field'; END IF;
                v_expr := format('count(DISTINCT %s)', reporting.value_expr(v_field));
            ELSIF v_agg IN ('SUM', 'AVG', 'MIN', 'MAX') THEN
                IF v_field IS NULL THEN RAISE EXCEPTION '% needs a field', v_agg; END IF;
                IF v_agg IN ('SUM', 'AVG') AND reporting.value_kind(v_field) <> 'num' THEN
                    RAISE EXCEPTION '% only applies to numeric_value', v_agg;
                END IF;
                v_expr := format('%s(%s)', lower(v_agg), reporting.value_expr(v_field));
            ELSE
                RAISE EXCEPTION 'Unsupported aggregation: %', v_agg;
            END IF;
            v_metric_exprs := v_metric_exprs || jsonb_build_object(v_alias, v_expr);
            v_select_list := v_select_list || format('%s AS %I, ', v_expr, v_alias);
        END LOOP;
        v_group_sql := CASE WHEN v_group_sql = '' THEN '' ELSE 'GROUP BY ' || rtrim(v_group_sql, ', ') END;
    ELSE
        IF jsonb_array_length(v_select) = 0 THEN
            v_select := '["domain_code","entity_name","attribute_name","value","source_name","valid_from"]'::jsonb;
        END IF;
        FOR i IN 0..jsonb_array_length(v_select) - 1 LOOP
            v_field := v_select->>i;
            v_select_list := v_select_list || format('%s AS %I, ', reporting.value_expr(v_field), v_field);
        END LOOP;
    END IF;
    v_select_list := rtrim(v_select_list, ', ');

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_order) LOOP
        v_field := v_item->>'field';
        IF v_field IS NULL THEN CONTINUE; END IF;
        v_dir := CASE WHEN lower(v_item->>'dir') = 'desc' THEN 'DESC' ELSE 'ASC' END;
        IF v_aggregate THEN
            IF NOT (v_metric_exprs ? v_field) AND NOT (v_field = ANY (ARRAY(SELECT jsonb_array_elements_text(v_group)))) THEN
                RAISE EXCEPTION 'orderBy field % is not grouped or aggregated', v_field;
            END IF;
        ELSE
            IF NOT (v_field = ANY (ARRAY(SELECT jsonb_array_elements_text(v_select)))) THEN
                RAISE EXCEPTION 'orderBy field % is not selected', v_field;
            END IF;
        END IF;
        v_window := v_window || format('%I %s NULLS LAST, ', v_field, v_dir);
    END LOOP;
    IF v_window = '' AND v_aggregate THEN
        v_window := format('%I DESC NULLS LAST', COALESCE(v_metrics->0->>'alias', 'count'));
    ELSIF v_window = '' THEN
        FOR i IN 0..jsonb_array_length(v_select) - 1 LOOP
            v_window := v_window || format('%I ASC NULLS LAST, ', v_select->>i);
        END LOOP;
    END IF;
    v_window := rtrim(v_window, ', ');

    v_sql := format($q$
        WITH winners AS (
            SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
                   eav.entity_id,
                   me.entity_code,
                   me.entity_name,
                   me.domain_code,
                   ar.attribute_code,
                   ar.attribute_name,
                   eav.golden_value AS value,
                   eav.golden_value_numeric AS numeric_value,
                   sr.source_code,
                   sr.source_name,
                   eav.valid_from,
                   eav.last_received_at AS received_at
            FROM golden_master.entity_attribute_values eav
            JOIN entity_instances.master_entities me ON me.id = eav.entity_id
            JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
            JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
            WHERE me.is_active
              AND eav.valid_from <= $1
              AND eav.valid_to >= $1
              AND eav.system_from <= $2
              AND eav.system_to >= $2
              AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
              AND ($3::text IS NULL OR me.domain_code = $3)
              AND ($4::text[] IS NULL OR upper(ar.attribute_code) = ANY ($4))
            ORDER BY eav.entity_id, eav.attribute_id,
                     (eav.golden_source_id IS NOT NULL AND eav.source_id = eav.golden_source_id) DESC,
                     eav.precedence_rank ASC,
                     eav.valid_from DESC,
                     eav.system_from DESC
        ),
        filt AS (
            SELECT * FROM winners b WHERE %1$s
        ),
        shaped AS (
            SELECT q.*, row_number() OVER (ORDER BY %3$s) AS rn
            FROM (
                SELECT %2$s
                FROM filt b
                %4$s
            ) q
        )
        SELECT jsonb_build_object(
            'grain', 'value',
            'asOfDate', to_char($1::date, 'YYYY-MM-DD'),
            'valueCount', (SELECT count(*)::int FROM filt),
            'entityCount', (SELECT count(DISTINCT entity_id)::int FROM filt),
            'rowCount', (SELECT count(*)::int FROM shaped),
            'truncated', (SELECT count(*) FROM shaped) > $5,
            'rows', COALESCE((
                SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn)
                FROM (SELECT * FROM shaped ORDER BY rn LIMIT $5) s
            ), '[]'::jsonb),
            'note', 'valueCount is every matching field. entityCount is every matching record. rowCount is the full grouped or listed result before the cap. When truncated is true, rows is a sample; do not add the sample up.'
        )
    $q$, v_where, v_select_list, v_window, v_group_sql);

    EXECUTE v_sql INTO v_result USING v_asof, v_know, v_domain, v_attrs, v_limit;
    RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION reporting.value_query(jsonb) IS
  'Ad hoc query over prevailing field values (one row per entity and attribute). Filter and group by source, attribute, domain, or value. SECURITY INVOKER: caller RLS applies. valueCount is complete.';

CREATE OR REPLACE FUNCTION public.query_values(p_request jsonb)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = reporting, pg_catalog
SET statement_timeout = '45s'
AS $fn$
    SELECT reporting.value_query(p_request);
$fn$;

COMMENT ON FUNCTION public.query_values(jsonb) IS
  'RPC wrapper for reporting.value_query. One row per prevailing field value the caller can read.';

GRANT EXECUTE ON FUNCTION reporting.value_expr(text) TO authenticated;
GRANT EXECUTE ON FUNCTION reporting.value_kind(text) TO authenticated;
GRANT EXECUTE ON FUNCTION reporting.value_filter(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION reporting.value_query(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.query_values(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
