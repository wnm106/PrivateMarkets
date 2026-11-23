-- Reads as of an earlier Knowledge date use the winning source known then.
--
-- Which source's value is the golden one is stamped on each current value row
-- (golden_source_id). When a new value arrives and wins, the rows already
-- there are re-stamped in place (stamp_sibling_preference). A read as of an
-- earlier Knowledge date then filtered on today's winner: before the newcomer
-- existed, the older source's row was visible but no longer marked golden, so
-- the value came back empty or from the wrong source.
--
-- golden_master.golden_source_history keeps each current row's stamp over
-- system time, written by a trigger whenever the stamp changes. The reads that
-- take a Knowledge date ask golden_master.golden_source_at for the stamp in
-- force then. For current knowledge it is the stored stamp, with no lookup.
--
-- A row stamped before this migration has history from its first change on.
-- Until then its stored stamp is the one it has always had as far as the
-- database knows, which is what reads used before.

CREATE TABLE IF NOT EXISTS golden_master.golden_source_history (
    id BIGSERIAL PRIMARY KEY,
    value_id UUID NOT NULL,
    golden_source_id UUID,
    resolution_rule_applied TEXT,
    system_from TIMESTAMPTZ NOT NULL,
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59+00',
    CONSTRAINT golden_source_history_interval CHECK (system_from <= system_to)
);
CREATE INDEX IF NOT EXISTS idx_golden_source_history_value
    ON golden_master.golden_source_history (value_id, system_from);
COMMENT ON TABLE golden_master.golden_source_history IS
    'The golden source stamped on each current value row, over system time. Read through golden_master.golden_source_at.';

-- Read only through golden_source_at; written only by the trigger below.
ALTER TABLE golden_master.golden_source_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON golden_master.golden_source_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON golden_master.golden_source_history TO service_role;

CREATE OR REPLACE FUNCTION golden_master.record_golden_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.system_to = v_open THEN
            INSERT INTO golden_master.golden_source_history (value_id, golden_source_id, resolution_rule_applied, system_from)
            VALUES (NEW.id, NEW.golden_source_id, NEW.resolution_rule_applied, NEW.system_from);
        END IF;
        RETURN NULL;
    END IF;

    -- Only a current row's stamp is ever changed; a retired row's is final.
    IF OLD.system_to IS DISTINCT FROM v_open THEN
        RETURN NULL;
    END IF;

    IF NEW.golden_source_id IS DISTINCT FROM OLD.golden_source_id THEN
        -- A row written before this table existed: its stamp so far is the old one.
        IF NOT EXISTS (SELECT 1 FROM golden_master.golden_source_history h WHERE h.value_id = OLD.id) THEN
            INSERT INTO golden_master.golden_source_history (value_id, golden_source_id, resolution_rule_applied, system_from)
            VALUES (OLD.id, OLD.golden_source_id, OLD.resolution_rule_applied, OLD.system_from);
        END IF;
        UPDATE golden_master.golden_source_history
           SET system_to = greatest(system_from, now())
         WHERE value_id = OLD.id AND system_to = v_open;
        IF NEW.system_to = v_open THEN
            INSERT INTO golden_master.golden_source_history (value_id, golden_source_id, resolution_rule_applied, system_from)
            VALUES (NEW.id, NEW.golden_source_id, NEW.resolution_rule_applied, greatest(OLD.system_from, now()));
        END IF;
    ELSIF NEW.system_to IS DISTINCT FROM v_open THEN
        -- Retired: its last stamp holds until then.
        UPDATE golden_master.golden_source_history
           SET system_to = greatest(system_from, NEW.system_to)
         WHERE value_id = OLD.id AND system_to = v_open;
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION golden_master.record_golden_source() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_record_golden_source ON golden_master.entity_attribute_values;
CREATE TRIGGER zz_record_golden_source
    AFTER INSERT OR UPDATE OF golden_source_id, system_to ON golden_master.entity_attribute_values
    FOR EACH ROW EXECUTE FUNCTION golden_master.record_golden_source();

-- The golden source a value row carried as of p_knowledge. NULL or a time not
-- in the past means now: the stored stamp. A row with no history has only ever
-- had its stored stamp, as far as the database knows.
--
-- SECURITY DEFINER so a reader needs no grant on the history. It returns only
-- a source id for a row id the caller already holds.
CREATE OR REPLACE FUNCTION golden_master.golden_source_at(p_value_id UUID, p_current UUID, p_knowledge TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_found BOOLEAN;
    v_source UUID;
BEGIN
    IF p_knowledge IS NULL OR p_knowledge >= now() THEN
        RETURN p_current;
    END IF;
    SELECT TRUE, h.golden_source_id INTO v_found, v_source
    FROM golden_master.golden_source_history h
    WHERE h.value_id = p_value_id
      AND h.system_from <= p_knowledge
      AND h.system_to > p_knowledge
    ORDER BY h.system_from DESC, h.id DESC
    LIMIT 1;
    RETURN CASE WHEN v_found THEN v_source ELSE p_current END;
END;
$$;
REVOKE ALL ON FUNCTION golden_master.golden_source_at(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.golden_source_at(UUID, UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================
-- The reads that take a Knowledge date
-- ============================================================

-- public.stale_attributes
CREATE OR REPLACE FUNCTION public.stale_attributes(p_domain_code text DEFAULT NULL::text, p_older_than_days integer DEFAULT 30, p_as_of_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_days integer := LEAST(GREATEST(COALESCE(p_older_than_days, 30), 1), 3650);
  v_as_of date := COALESCE(p_as_of_date, CURRENT_DATE);
  v_cutoff timestamptz := NOW() - make_interval(days => v_days);
  v_known timestamptz := COALESCE(p_knowledge_date, clock_timestamp());
  v_result jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);
  PERFORM set_config('enable_nestloop', 'off', true);

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code
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
      AND (p_entity_id IS NULL OR me.id = p_entity_id)
  ),
  winners AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
      eav.entity_id,
      eav.attribute_id,
      eav.source_id,
      NULLIF(btrim(eav.golden_value), '') AS golden_value,
      COALESCE(eav.last_received_at, eav.system_from) AS received_at
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    WHERE (
      (p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59')
      OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)
    )
      AND eav.valid_from <= v_as_of
      AND eav.valid_to >= v_as_of
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id,
      COALESCE(eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge_date), FALSE) DESC,
      eav.precedence_rank ASC,
      eav.valid_from DESC
  ),
  stale AS MATERIALIZED (
    SELECT
      s.id AS entity_id,
      s.entity_code,
      s.entity_name,
      s.domain_code,
      ar.attribute_code,
      ar.attribute_name,
      sr.source_code,
      sr.source_name,
      w.golden_value,
      w.received_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - w.received_at)) / 86400))::int AS age_days
    FROM winners w
    JOIN scoped s ON s.id = w.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id
    JOIN entity_instances.source_registry sr ON sr.id = w.source_id
    WHERE w.received_at < v_cutoff
      AND sr.source_code NOT IN ('DERIVED', 'CALCULATED')
  )
  SELECT jsonb_build_object(
    'olderThanDays', v_days,
    'asOfDate', v_as_of,
    'count', (SELECT count(*)::int FROM stale),
    'attributes', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'entityId', row.entity_id,
          'entityCode', row.entity_code,
          'entityName', row.entity_name,
          'domainCode', row.domain_code,
          'attributeCode', row.attribute_code,
          'attributeName', row.attribute_name,
          'sourceCode', row.source_code,
          'sourceName', row.source_name,
          'value', row.golden_value,
          'receivedAt', row.received_at,
          'ageDays', row.age_days
        )
        ORDER BY row.received_at ASC, row.entity_name, row.attribute_name
      )
      FROM (
        SELECT * FROM stale
        ORDER BY received_at ASC, entity_name, attribute_name
        LIMIT 200
      ) row
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- golden_master.persisted_attribute_values
CREATE OR REPLACE FUNCTION golden_master.persisted_attribute_values(p_entity_ids uuid[], p_attribute_ids uuid[], p_as_of date, p_knowledge timestamp with time zone)
 RETURNS TABLE(entity_id uuid, attribute_id uuid, source_id uuid, precedence_rank integer, golden_value text, golden_value_numeric numeric, golden_value_date date, golden_value_timestamp timestamp with time zone, valid_from date, valid_to date)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
         eav.entity_id,
         eav.attribute_id,
         eav.source_id,
         eav.precedence_rank,
         eav.golden_value,
         eav.golden_value_numeric,
         eav.golden_value_date,
         eav.golden_value_timestamp,
         eav.valid_from,
         eav.valid_to
  FROM golden_master.entity_attribute_values eav
  WHERE eav.entity_id = ANY(COALESCE(p_entity_ids, '{}'::uuid[]))
    AND eav.attribute_id = ANY(COALESCE(p_attribute_ids, '{}'::uuid[]))
    AND eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge)
    AND eav.valid_from <= p_as_of
    AND eav.valid_to >= p_as_of
    AND eav.system_from <= p_knowledge
    AND eav.system_to >= p_knowledge
    AND eav.golden_value IS NOT NULL
    AND eav.golden_value <> ''
  ORDER BY eav.entity_id, eav.attribute_id, eav.valid_from DESC, eav.system_from DESC;
$function$;

-- reporting.value_query
CREATE OR REPLACE FUNCTION reporting.value_query(p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'reporting', 'public', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
 SET statement_timeout TO '45s'
AS $function$
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
                     COALESCE(eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, $2), FALSE) DESC,
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
$function$;

-- golden_master.attribute_text
CREATE OR REPLACE FUNCTION golden_master.attribute_text(p_entity_id uuid, p_attribute_code character varying, p_as_of date, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'pg_temp'
AS $function$
DECLARE
    v_text TEXT;
BEGIN
    SELECT eav.golden_value
      INTO v_text
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
    ORDER BY
        CASE
            WHEN eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge)
             AND eav.golden_value IS NOT NULL
             AND btrim(eav.golden_value) <> '' THEN 0
            WHEN eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '' THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;
    RETURN v_text;
END;
$function$;

-- golden_master.shown_date
CREATE OR REPLACE FUNCTION golden_master.shown_date(p_entity_id uuid, p_attribute_code character varying, p_as_of date, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'pg_temp'
AS $function$
DECLARE
    v_date DATE;
BEGIN
    SELECT COALESCE(
        eav.golden_value_date,
        CASE
            WHEN eav.golden_value ~ '^\d{4}-\d{2}-\d{2}' THEN left(eav.golden_value, 10)::DATE
            ELSE NULL
        END
    )
      INTO v_date
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
    ORDER BY
        CASE
            WHEN eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge)
             AND eav.golden_value IS NOT NULL
             AND btrim(eav.golden_value) <> '' THEN 0
            WHEN eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '' THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;
    RETURN v_date;
END;
$function$;

-- golden_master.golden_literal
CREATE OR REPLACE FUNCTION golden_master.golden_literal(p_entity_id uuid, p_attribute_code character varying, p_as_of date, p_depth integer DEFAULT 0, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_calc_id UUID;
    v_mode TEXT;
    v_kind TEXT;
    v_data_type TEXT;
    v_numeric NUMERIC;
    v_text TEXT;
BEGIN
    IF p_depth > 16 OR p_entity_id IS NULL THEN
        RETURN 'null'::jsonb;
    END IF;

    SELECT cd.id, cd.evaluation_mode, cd.calc_kind, ar.data_type
      INTO v_calc_id, v_mode, v_kind, v_data_type
    FROM metadata_register.attribute_register ar
    LEFT JOIN metadata_register.calc_definitions cd ON cd.attribute_id = ar.id
    WHERE ar.attribute_code = p_attribute_code;

    IF v_mode = 'ON_READ' AND v_kind = 'EXPRESSION' THEN
        RETURN golden_master.eval_expression_result(v_calc_id, p_entity_id, p_as_of, p_depth + 1, p_knowledge);
    END IF;

    IF v_mode = 'ON_READ' THEN
        v_numeric := golden_master.eval_calc(v_calc_id, p_entity_id, p_as_of, p_depth + 1);
        IF v_numeric IS NULL THEN
            RETURN 'null'::jsonb;
        END IF;
        RETURN to_jsonb(v_numeric);
    END IF;

    SELECT eav.golden_value_numeric, eav.golden_value
      INTO v_numeric, v_text
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
    ORDER BY
        CASE
            WHEN eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge)
             AND COALESCE(eav.golden_value_numeric::TEXT, eav.golden_value) IS NOT NULL
             AND btrim(COALESCE(eav.golden_value, '')) <> '' THEN 0
            WHEN eav.golden_value_numeric IS NOT NULL
              OR (eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '') THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;

    IF v_numeric IS NOT NULL THEN
        RETURN to_jsonb(v_numeric);
    END IF;
    IF v_text IS NULL THEN
        RETURN 'null'::jsonb;
    END IF;
    IF upper(COALESCE(v_data_type, '')) IN ('NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE')
       AND v_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RETURN to_jsonb(v_text::NUMERIC);
    END IF;
    RETURN to_jsonb(v_text);
END;
$function$;

-- golden_master.describe_calc_component
CREATE OR REPLACE FUNCTION golden_master.describe_calc_component(p_root_domain text, p_entity_id uuid, p_attribute_code character varying, p_role text, p_traversal text, p_codes text[], p_as_of date, p_depth integer, p_detail text, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_name TEXT;
    v_home TEXT;
    v_home_name TEXT;
    v_domain TEXT := p_root_domain;
    v_domain_name TEXT;
    v_code TEXT;
    v_parent TEXT;
    v_child TEXT;
    v_entity_code TEXT;
    v_entity_name TEXT;
    v_entity_domain TEXT;
    v_literal JSONB;
    v_value TEXT;
    v_names JSONB := '[]'::jsonb;
    v_calculated BOOLEAN;
BEGIN
    SELECT ar.attribute_name, ar.domain_code, dt.domain_name
      INTO v_name, v_home, v_home_name
    FROM metadata_register.attribute_register ar
    LEFT JOIN metadata_register.domain_types dt ON dt.domain_code = ar.domain_code
    WHERE ar.attribute_code = p_attribute_code;

    IF p_traversal <> 'SELF' AND COALESCE(cardinality(p_codes), 0) > 0 THEN
        FOREACH v_code IN ARRAY p_codes LOOP
            SELECT parent_domain_code, child_domain_code
              INTO v_parent, v_child
            FROM metadata_register.relationship_types
            WHERE relationship_code = v_code;
            IF p_traversal = 'DOWN' AND v_parent = v_domain THEN
                v_domain := v_child;
            ELSIF p_traversal = 'UP' AND v_child = v_domain THEN
                v_domain := v_parent;
            END IF;
        END LOOP;
    END IF;

    IF p_entity_id IS NOT NULL THEN
        SELECT entity_code, entity_name, domain_code
          INTO v_entity_code, v_entity_name, v_entity_domain
        FROM entity_instances.master_entities
        WHERE id = p_entity_id;
        IF v_entity_domain IS NOT NULL THEN
            v_domain := v_entity_domain;
        END IF;
        v_literal := golden_master.golden_literal(p_entity_id, p_attribute_code, p_as_of, p_depth, p_knowledge);
        IF v_literal IS NULL OR jsonb_typeof(v_literal) = 'null' THEN
            v_value := NULL;
        ELSE
            v_value := v_literal #>> '{}';
        END IF;
        IF v_value IS NULL THEN
            SELECT COALESCE(eav.golden_value_numeric::TEXT, eav.golden_value)
              INTO v_value
            FROM golden_master.entity_attribute_values eav
            JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
            WHERE eav.entity_id = p_entity_id
              AND ar.attribute_code = p_attribute_code
              AND eav.valid_from <= p_as_of
              AND eav.valid_to >= p_as_of
              AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
              AND COALESCE(eav.golden_value, '') <> ''
            ORDER BY
                CASE WHEN eav.source_id IS NOT DISTINCT FROM golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge) THEN 0 ELSE 1 END,
                eav.precedence_rank NULLS LAST
            LIMIT 1;
        END IF;
    END IF;

    SELECT domain_name INTO v_domain_name
    FROM metadata_register.domain_types
    WHERE domain_code = v_domain;

    SELECT COALESCE(jsonb_agg(COALESCE(rt.relationship_name, ord.code) ORDER BY ord.ordinality), '[]'::jsonb)
      INTO v_names
    FROM unnest(COALESCE(p_codes, '{}'::text[])) WITH ORDINALITY AS ord(code, ordinality)
    LEFT JOIN metadata_register.relationship_types rt ON rt.relationship_code = ord.code;

    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        WHERE ar.attribute_code = p_attribute_code
    ) INTO v_calculated;

    RETURN jsonb_build_object(
        'attributeCode', p_attribute_code,
        'attributeName', COALESCE(v_name, p_attribute_code),
        'role', p_role,
        'traversal', p_traversal,
        'relationshipCodes', to_jsonb(COALESCE(p_codes, '{}'::text[])),
        'relationshipNames', v_names,
        'domainCode', v_domain,
        'domainName', COALESCE(v_domain_name, v_domain),
        'homeDomainCode', v_home,
        'homeDomainName', v_home_name,
        'entityId', p_entity_id,
        'entityCode', v_entity_code,
        'entityName', v_entity_name,
        'value', v_value,
        'detail', p_detail,
        'calculated', COALESCE(v_calculated, FALSE)
    );
END;
$function$;

-- public.data_quality_dashboard
CREATE OR REPLACE FUNCTION public.data_quality_dashboard(p_domain_code text DEFAULT NULL::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid, p_sections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'data_quality', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_known timestamptz := COALESCE(p_knowledge_date, clock_timestamp());
  v_swap date;
  v_result jsonb;
  v_lists boolean := p_sections IS NULL OR 'availabilityEntities' = ANY(p_sections);
  v_entities boolean := p_sections IS NULL OR 'entities' = ANY(p_sections);
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);
  PERFORM set_config('enable_nestloop', 'off', true);
  PERFORM set_config('work_mem', '64MB', true);
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);
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
      AND (v_domain IS NULL OR me.domain_code = v_domain) AND (p_entity_id IS NULL OR me.id = p_entity_id)
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
    WHERE (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
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
           data_quality.apply_compiled_rule(r.id, '{}'::jsonb, v_to) AS probe,
           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* ('^' || ar.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')) AS passes_when_blank
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
  rule_scope AS MATERIALIZED (
    SELECT aru.id AS rule_id, aru.attribute_code, aru.passes_when_blank, s.id AS entity_id
    FROM active_rules aru
    JOIN scoped s ON s.domain_code = aru.domain_code
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
    UNION ALL
    SELECT aru.id, aru.attribute_code, aru.passes_when_blank, s.id
    FROM active_rules aru
    CROSS JOIN scoped s
    WHERE aru.domain_code IS NULL
      AND COALESCE((aru.probe->>'evaluated')::boolean, false)
  ),
  rule_checks AS MATERIALIZED (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'message' AS message,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_to)
             END AS result
      FROM rule_scope rs
      LEFT JOIN value_map vm ON vm.entity_id = rs.entity_id
      WHERE NOT EXISTS (
        SELECT 1 FROM accepted ax
        WHERE ax.rule_id = rs.rule_id AND ax.entity_id = rs.entity_id
      )
      OFFSET 0  -- keeps the rule from being evaluated once per column read from it
    ) c
  ),
  rule_counts AS (
    SELECT rule_id,
           count(*)::int AS entity_count,
           count(*) FILTER (WHERE NOT passed)::int AS failing_count,
           count(*) FILTER (WHERE passed)::int AS passing_count
    FROM rule_checks
    GROUP BY rule_id
  ),
  failing_checks AS MATERIALIZED (
    SELECT rc.rule_id, rc.entity_id, rc.message, rc.actual_value,
           s.entity_code, s.entity_name, s.domain_code
    FROM rule_checks rc
    JOIN scoped s ON s.id = rc.entity_id
    WHERE NOT rc.passed
  ),
  prior_value_map AS MATERIALIZED (
    SELECT rv.entity_id,
           jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS values
    FROM resolved rv
    JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
    WHERE v_from <> v_to
      AND rv.as_of = v_from
      AND rv.golden_value IS NOT NULL
    GROUP BY rv.entity_id
  ),
  changed_entities AS (
    SELECT COALESCE(cur.entity_id, prev.entity_id) AS entity_id
    FROM value_map cur
    FULL JOIN prior_value_map prev ON prev.entity_id = cur.entity_id
    WHERE cur.values IS DISTINCT FROM prev.values
  ),
  prior_checks AS (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_from)
             END AS result
      FROM rule_scope rs
      JOIN changed_entities ce ON ce.entity_id = rs.entity_id
      LEFT JOIN prior_value_map vm ON vm.entity_id = rs.entity_id
      WHERE v_from <> v_to
      OFFSET 0
    ) c
  ),
  rule_shift AS MATERIALIZED (
    SELECT rc.rule_id,
           rc.entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           pc.passed AS prior_passed,
           rc.passed AS current_passed,
           pc.actual_value AS previous_value,
           rc.actual_value AS current_value
    FROM rule_checks rc
    JOIN prior_checks pc ON pc.rule_id = rc.rule_id AND pc.entity_id = rc.entity_id
    JOIN scoped s ON s.id = rc.entity_id
    WHERE pc.passed <> rc.passed  -- only a changed outcome is ever reported
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
  required_values AS (
    SELECT r.entity_id,
           r.entity_code,
           r.entity_name,
           r.domain_code,
           r.attribute_id,
           rv.golden_value,
           fr.golden_value AS previous_value,
           fr.golden_value IS NOT NULL AS present_from,
           rv.golden_value IS NOT NULL AS present_to
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    LEFT JOIN resolved fr
      ON fr.entity_id = r.entity_id
     AND fr.attribute_id = r.attribute_id
     AND fr.as_of = v_from
     AND fr.golden_value IS NOT NULL
  ),
  availability_rows AS (
    SELECT ar.attribute_code AS "attributeCode",
           ar.attribute_name AS "attributeName",
           req.domain_code AS "domainCode",
           count(DISTINCT req.entity_id)::int AS "requiredCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NULL)::int AS "missingCount",
           round(
             100.0 * count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NOT NULL)
             / NULLIF(count(DISTINCT req.entity_id), 0),
             1
           ) AS "availabilityPercent",
           count(DISTINCT req.entity_id) FILTER (WHERE NOT req.present_from AND req.present_to)::int AS "resolvedCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.present_from AND NOT req.present_to)::int AS "introducedCount",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code
               )
             ) FILTER (WHERE v_lists AND req.golden_value IS NULL),
             '[]'::jsonb
           ) AS "missingEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', NULL,
                 'currentValue', req.golden_value
               )
             ) FILTER (WHERE v_lists AND NOT req.present_from AND req.present_to),
             '[]'::jsonb
           ) AS "resolvedEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', req.previous_value,
                 'currentValue', NULL
               )
             ) FILTER (WHERE v_lists AND req.present_from AND NOT req.present_to),
             '[]'::jsonb
           ) AS "introducedEntities"
    FROM required_values req
    JOIN metadata_register.attribute_register ar ON ar.id = req.attribute_id
    GROUP BY ar.attribute_code, ar.attribute_name, req.domain_code
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
           COALESCE(cnt.entity_count, 0) AS "entityCount",
           COALESCE(cnt.failing_count, 0) AS "failingCount",
           COALESCE(cnt.passing_count, 0) AS "passingCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', fc.entity_id,
                 'entityCode', fc.entity_code,
                 'entityName', fc.entity_name,
                 'domainCode', fc.domain_code,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY fc.entity_name
             )
             FROM failing_checks fc
             WHERE fc.rule_id = aru.id
           ), '[]'::jsonb) AS "failingEntities",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed), 0) AS "resolvedCount",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed), 0) AS "introducedCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed
           ), '[]'::jsonb) AS "resolvedEntities",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed
           ), '[]'::jsonb) AS "introducedEntities"
    FROM active_rules aru
    LEFT JOIN rule_counts cnt ON cnt.rule_id = aru.id
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
  open_source_values AS (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, eav.source_id)
           eav.entity_id,
           eav.attribute_id,
           NULLIF(btrim(eav.golden_value), '') AS golden_value,
           eav.golden_value_numeric,
           eav.precedence_rank,
           eav.is_manual_override,
           eav.override_reason,
           sr.source_code,
           sr.source_name,
           COALESCE(eav.last_received_at, eav.system_from) AS received_at,
           COALESCE(eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge_date), FALSE) AS is_golden
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
      AND eav.valid_from <= v_to
      AND eav.valid_to >= v_to
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id, eav.source_id, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  manual_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, override_reason
    FROM open_source_values
    WHERE is_manual_override IS TRUE OR source_code = 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  priority_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, source_code, source_name
    FROM open_source_values
    WHERE COALESCE(is_manual_override, false) IS NOT TRUE
      AND source_code IS DISTINCT FROM 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  override_matches AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           m.golden_value AS override_value,
           m.override_reason,
           p.source_code AS priority_source_code,
           p.source_name AS priority_source_name,
           p.golden_value AS priority_value,
           (
             p.entity_id IS NOT NULL
             AND (
               data_quality.values_match(m.golden_value, p.golden_value)
               OR (
                 m.golden_value_numeric IS NOT NULL
                 AND p.golden_value_numeric IS NOT NULL
                 AND m.golden_value_numeric = p.golden_value_numeric
               )
             )
           ) AS ready
    FROM manual_current m
    LEFT JOIN priority_current p
      ON p.entity_id = m.entity_id
     AND p.attribute_id = m.attribute_id
    JOIN scoped s ON s.id = m.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
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
           ) FILTER (WHERE v_entities) AS missing_attributes
    FROM missing
    GROUP BY entity_id
  ),
  entity_required AS (
    SELECT entity_id, count(*)::int AS required_count
    FROM required_attr
    GROUP BY entity_id
  ),
  entity_rules AS (
    SELECT cnt.entity_id,
           cnt.rule_count,
           cnt.failing_count,
           COALESCE(f.failing_rules, '[]'::jsonb) AS failing_rules
    FROM (
      SELECT entity_id,
             count(*)::int AS rule_count,
             count(*) FILTER (WHERE NOT passed)::int AS failing_count
      FROM rule_checks
      GROUP BY entity_id
    ) cnt
    LEFT JOIN (
      SELECT fc.entity_id,
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY aru.rule_name
             ) AS failing_rules
      FROM failing_checks fc
      JOIN active_rules aru ON aru.id = fc.rule_id
      WHERE v_entities
      GROUP BY fc.entity_id
    ) f ON f.entity_id = cnt.entity_id
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
  entity_availability_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT present_from AND present_to)::int AS resolved_count,
           count(*) FILTER (WHERE present_from AND NOT present_to)::int AS introduced_count
    FROM required_values
    GROUP BY entity_id
  ),
  entity_quality_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT prior_passed AND current_passed)::int AS resolved_count,
           count(*) FILTER (WHERE prior_passed AND NOT current_passed)::int AS introduced_count
    FROM rule_shift
    GROUP BY entity_id
  ),
  entity_override_matches AS (
    SELECT entity_id,
           count(*) FILTER (WHERE ready)::int AS match_count,
           count(*)::int AS override_count
    FROM override_matches
    GROUP BY entity_id
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
           ) FILTER (WHERE v_entities) AS changes
    FROM changes
    GROUP BY entity_id
  ),
  prevailing AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           golden_value,
           golden_value_numeric,
           received_at
    FROM open_source_values
    ORDER BY entity_id, attribute_id, is_golden DESC, precedence_rank ASC, golden_value
  ),
  fresh_checks AS (
    SELECT p.entity_id,
           (p.received_at::date >= (v_to - 30)) AS passed
    FROM prevailing p
    WHERE p.source_code IS DISTINCT FROM 'DERIVED'
      AND p.source_code IS DISTINCT FROM 'CALCULATED'
  ),
  golden_active AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           source_name,
           golden_value,
           golden_value_numeric
    FROM open_source_values
    WHERE is_golden
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  consensus_other AS (
    SELECT g.entity_id,
           g.attribute_id,
           g.source_code AS golden_source_code,
           g.source_name AS golden_source_name,
           g.golden_value,
           g.golden_value_numeric,
           o.source_code,
           o.source_name,
           o.golden_value AS other_value,
           COALESCE(
             data_quality.values_match(o.golden_value, g.golden_value)
             OR (
               o.golden_value_numeric IS NOT NULL
               AND g.golden_value_numeric IS NOT NULL
               AND o.golden_value_numeric = g.golden_value_numeric
             ),
             false
           ) AS agrees
    FROM golden_active g
    JOIN open_source_values o
      ON o.entity_id = g.entity_id
     AND o.attribute_id = g.attribute_id
     AND NOT o.is_golden
  ),
  consensus_checks AS (
    SELECT entity_id,
           attribute_id,
           bool_and(agrees) AS passed
    FROM consensus_other
    GROUP BY entity_id, attribute_id
  ),
  consensus_conflict_rows AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           c.golden_source_code,
           c.golden_source_name,
           c.golden_value,
           c.source_code,
           c.source_name,
           c.other_value
    FROM consensus_other c
    JOIN scoped s ON s.id = c.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = c.attribute_id
    WHERE NOT c.agrees
  ),
  score_by_entity AS (
    SELECT entity_id,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability' AND passed), 0)::int AS availability_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability'), 0)::int AS availability_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality' AND passed), 0)::int AS quality_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality'), 0)::int AS quality_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness' AND passed), 0)::int AS freshness_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness'), 0)::int AS freshness_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'consensus' AND passed), 0)::int AS consensus_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'consensus'), 0)::int AS consensus_applicable
    FROM (
      SELECT entity_id, 'availability'::text AS dimension, 1::numeric AS weight, present_to AS passed
      FROM required_values
      UNION ALL
      SELECT rc.entity_id,
             'quality',
             CASE upper(COALESCE(aru.rule_severity, ''))
               WHEN 'CRITICAL' THEN 8
               WHEN 'HIGH' THEN 4
               WHEN 'MEDIUM' THEN 2
               ELSE 1
             END,
             rc.passed
      FROM rule_checks rc
      JOIN active_rules aru ON aru.id = rc.rule_id
      UNION ALL
      SELECT entity_id, 'freshness', 1, passed FROM fresh_checks
      UNION ALL
      SELECT entity_id, 'consensus', 1, passed FROM consensus_checks
    ) facts
    GROUP BY entity_id
  ),
  waived_by_entity AS (
    SELECT ax.entity_id, count(*)::int AS waived
    FROM accepted ax
    JOIN active_rules aru ON aru.id = ax.rule_id
    GROUP BY ax.entity_id
  ),
  type_score_rows AS (
    SELECT s.domain_code,
           count(*)::int AS entity_count,
           COALESCE(sum(sc.availability_passing), 0)::int AS availability_passing,
           COALESCE(sum(sc.availability_applicable), 0)::int AS availability_applicable,
           COALESCE(sum(sc.quality_passing), 0)::int AS quality_passing,
           COALESCE(sum(sc.quality_applicable), 0)::int AS quality_applicable,
           COALESCE(sum(sc.freshness_passing), 0)::int AS freshness_passing,
           COALESCE(sum(sc.freshness_applicable), 0)::int AS freshness_applicable,
           COALESCE(sum(sc.consensus_passing), 0)::int AS consensus_passing,
           COALESCE(sum(sc.consensus_applicable), 0)::int AS consensus_applicable,
           COALESCE(sum(wv.waived), 0)::int AS waived_checks
    FROM scoped s
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
    GROUP BY s.domain_code
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
           COALESCE(ec.changes, '[]'::jsonb) AS "changes",
           COALESCE(am.resolved_count, 0) AS "availabilityResolvedCount",
           COALESCE(am.introduced_count, 0) AS "availabilityIntroducedCount",
           COALESCE(qm.resolved_count, 0) AS "qualityResolvedCount",
           COALESCE(qm.introduced_count, 0) AS "qualityIntroducedCount",
           COALESCE(om.match_count, 0) AS "overrideMatchCount",
           COALESCE(om.override_count, 0) AS "overrideCount",
           COALESCE(sc.availability_passing, 0) AS "availabilityPassing",
           COALESCE(sc.availability_applicable, 0) AS "availabilityApplicable",
           COALESCE(sc.quality_passing, 0) AS "qualityPassing",
           COALESCE(sc.quality_applicable, 0) AS "qualityApplicable",
           COALESCE(sc.freshness_passing, 0) AS "freshnessPassing",
           COALESCE(sc.freshness_applicable, 0) AS "freshnessApplicable",
           COALESCE(sc.consensus_passing, 0) AS "consensusPassing",
           COALESCE(sc.consensus_applicable, 0) AS "consensusApplicable",
           COALESCE(wv.waived, 0) AS "waivedChecks"
    FROM scoped s
    LEFT JOIN entity_required er ON er.entity_id = s.id
    LEFT JOIN entity_missing em ON em.entity_id = s.id
    LEFT JOIN entity_rules ru ON ru.entity_id = s.id
    LEFT JOIN entity_accepted ea ON ea.entity_id = s.id
    LEFT JOIN entity_changes ec ON ec.entity_id = s.id
    LEFT JOIN entity_availability_movement am ON am.entity_id = s.id
    LEFT JOIN entity_quality_movement qm ON qm.entity_id = s.id
    LEFT JOIN entity_override_matches om ON om.entity_id = s.id
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
  ),
  summary AS (
    SELECT
      (SELECT count(*)::int FROM scoped) AS entity_count,
      (SELECT count(*)::int FROM required_attr) AS required_slots,
      (SELECT count(*)::int FROM missing) AS missing_slots,
      (SELECT count(DISTINCT entity_id)::int FROM missing) AS entities_missing,
      (SELECT count(*)::int FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)) AS rules_evaluated,
      (SELECT COALESCE(sum(passing_count), 0)::int FROM rule_counts) AS passing_checks,
      (SELECT COALESCE(sum(failing_count), 0)::int FROM rule_counts) AS failing_checks,
      (SELECT count(DISTINCT entity_id)::int FROM failing_checks) AS entities_failing,
      (SELECT count(DISTINCT attribute_code)::int FROM changes) AS changed_attributes,
      (SELECT count(DISTINCT entity_id)::int FROM changes) AS changed_entities,
      (SELECT count(*)::int FROM changes) AS attribute_changes,
      (SELECT count(*)::int FROM entity_rows
        WHERE "missingCount" = 0 AND "failingRuleCount" = 0 AND "changeCount" = 0 AND "overrideMatchCount" = 0) AS clear_entities,
      (SELECT count(*)::int FROM required_values WHERE NOT present_from AND present_to) AS availability_resolved,
      (SELECT count(*)::int FROM required_values WHERE present_from AND NOT present_to) AS availability_introduced,
      (SELECT count(*)::int FROM rule_shift WHERE NOT prior_passed AND current_passed) AS quality_resolved,
      (SELECT count(*)::int FROM rule_shift WHERE prior_passed AND NOT current_passed) AS quality_introduced,
      (SELECT count(*)::int FROM override_matches WHERE ready) AS override_match_count
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
    'consensusConflicts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', entity_id,
          'entityCode', entity_code,
          'entityName', entity_name,
          'domainCode', domain_code,
          'attributeCode', attribute_code,
          'attributeName', attribute_name,
          'goldenSourceCode', golden_source_code,
          'goldenSourceName', golden_source_name,
          'goldenValue', golden_value,
          'sourceCode', source_code,
          'sourceName', source_name,
          'value', other_value
        )
        ORDER BY entity_name, attribute_name, source_name
      )
      FROM consensus_conflict_rows
    ), '[]'::jsonb),
    'scores', (
      SELECT jsonb_build_object(
        'availabilityPassing', COALESCE(sum(availability_passing), 0),
        'availabilityApplicable', COALESCE(sum(availability_applicable), 0),
        'qualityPassing', COALESCE(sum(quality_passing), 0),
        'qualityApplicable', COALESCE(sum(quality_applicable), 0),
        'freshnessPassing', COALESCE(sum(freshness_passing), 0),
        'freshnessApplicable', COALESCE(sum(freshness_applicable), 0),
        'consensusPassing', COALESCE(sum(consensus_passing), 0),
        'consensusApplicable', COALESCE(sum(consensus_applicable), 0),
        'waivedChecks', COALESCE(sum(waived_checks), 0)
      )
      FROM type_score_rows
    ),
    'entityTypeScores', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'domainCode', domain_code,
          'entityCount', entity_count,
          'availabilityPassing', availability_passing,
          'availabilityApplicable', availability_applicable,
          'qualityPassing', quality_passing,
          'qualityApplicable', quality_applicable,
          'freshnessPassing', freshness_passing,
          'freshnessApplicable', freshness_applicable,
          'consensusPassing', consensus_passing,
          'consensusApplicable', consensus_applicable,
          'waivedChecks', waived_checks
        )
        ORDER BY domain_code
      )
      FROM type_score_rows
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
        'clearEntityCount', clear_entities,
        'availabilityResolvedCount', availability_resolved,
        'availabilityIntroducedCount', availability_introduced,
        'qualityResolvedCount', quality_resolved,
        'qualityIntroducedCount', quality_introduced,
        'overrideMatchCount', override_match_count
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
    'overrideMatches', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', o.entity_id,
          'entityCode', o.entity_code,
          'entityName', o.entity_name,
          'domainCode', o.domain_code,
          'attributeCode', o.attribute_code,
          'attributeName', o.attribute_name,
          'overrideValue', o.override_value,
          'overrideReason', o.override_reason,
          'prioritySourceCode', o.priority_source_code,
          'prioritySourceName', o.priority_source_name,
          'priorityValue', o.priority_value,
          'ready', o.ready
        )
        ORDER BY o.ready DESC, o.entity_name, o.attribute_name
      )
      FROM override_matches o
    ), '[]'::jsonb),
    'entities', CASE WHEN v_entities THEN COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY (e."missingCount" + e."failingRuleCount" + e."changeCount" + e."overrideMatchCount") DESC, e."entityName")
      FROM entity_rows e
      WHERE e."missingCount" > 0 OR e."failingRuleCount" > 0 OR e."changeCount" > 0 OR e."overrideMatchCount" > 0
         OR e."availabilityResolvedCount" > 0 OR e."availabilityIntroducedCount" > 0
         OR e."qualityResolvedCount" > 0 OR e."qualityIntroducedCount" > 0 OR e."overrideCount" > 0
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

NOTIFY pgrst, 'reload schema';
