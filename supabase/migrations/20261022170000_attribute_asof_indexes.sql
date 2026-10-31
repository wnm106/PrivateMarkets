-- As-of attribute retrieval for a book of funds, positions, securities, and issuers.
--
-- The hot predicate is "this entity, this attribute, this source, the slice whose
-- valid time contains a date and whose system time contains a knowledge time,
-- lowest precedence_rank". Ten years of daily slices make a filter on
-- (valid_from <= d AND valid_to >= d) walk every earlier version. A GiST on the
-- raw dates does not prune that history (measured: bitmap scan of an 8.3M-row
-- ledger was slower than a sequential scan).
--
-- The index that does prune it is a btree whose last key is valid_from DESC,
-- used as:
--   WHERE entity_id = ? AND attribute_id = ? AND source_id = ?
--     AND valid_from <= as_of AND valid_to >= as_of
--     AND system_from <= knowledge AND system_to >= knowledge
--   ORDER BY valid_from DESC, system_from DESC
--   LIMIT 1
-- Postgres starts at the newest valid_from that is still <= as_of and stops at
-- the first row that also covers as_of. On 200 positions x 12 attributes x
-- 2 sources x every weekday for 10 years (8,347,200 rows) that resolved every
-- attribute in about 30ms, index-only, versus a 670ms scan of the whole ledger.
--
-- winning_attribute_values is that seek. reporting.grid, compliance value
-- resolution, and resolve_golden_record all go through it. Callers that still
-- filter the table directly (one entity's lineage) keep the partial current
-- index and the entity/attribute btrees.

-- ============================================================
-- 1. Golden ledger: one seek per (entity, attribute, source)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_eav_entity_attr_source_asof
  ON golden_master.entity_attribute_values
     (entity_id, attribute_id, source_id, valid_from DESC, system_from DESC)
  INCLUDE (valid_to, system_to, precedence_rank, golden_value_numeric, golden_value_date, golden_value_timestamp);

-- Feed reprocess reads one source and one valid_from or valid_to for a set of entities.
CREATE INDEX IF NOT EXISTS idx_eav_source_valid_from_entity
  ON golden_master.entity_attribute_values (source_id, valid_from, entity_id);
CREATE INDEX IF NOT EXISTS idx_eav_source_valid_to_entity
  ON golden_master.entity_attribute_values (source_id, valid_to, entity_id);

-- Indexes the as-of seek replaces. Kept: entity+attribute+precedence, the partial
-- current-row index, attribute_id, and the golden-source maintenance indexes.
DROP INDEX IF EXISTS golden_master.idx_eav_entity;
DROP INDEX IF EXISTS golden_master.idx_eav_source;
DROP INDEX IF EXISTS golden_master.idx_eav_precedence;
DROP INDEX IF EXISTS golden_master.idx_eav_valid_time;
DROP INDEX IF EXISTS golden_master.idx_eav_system_time;
DROP INDEX IF EXISTS golden_master.idx_eav_attr_entity_valid;

-- ============================================================
-- 2. Source ledger (compliance source_scope other than GOLDEN)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sav_entity_attr_source_asof
  ON entity_instances.source_attribute_values
     (entity_id, attribute_id, source_id, valid_from DESC, created_at DESC)
  INCLUDE (valid_to, system_from, system_to, value_as_numeric);

DROP INDEX IF EXISTS entity_instances.idx_sav_valid_time;
DROP INDEX IF EXISTS entity_instances.idx_sav_system_time;
DROP INDEX IF EXISTS entity_instances.idx_sav_attr_source_entity_valid;

-- ============================================================
-- 3. Intersection attributes (position-style EAV) and fund→position walks
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_iav_intersection_attr_source_asof
  ON golden_master.intersection_attribute_values
     (intersection_id, attribute_id, source_id, valid_from DESC, system_from DESC)
  INCLUDE (valid_to, system_to, precedence_rank, golden_value_numeric);

DROP INDEX IF EXISTS golden_master.idx_iav_valid_time;
DROP INDEX IF EXISTS golden_master.idx_iav_system_time;

-- valid_from is the second column so `parent_entity_id = ? AND valid_from <= as_of`
-- is an index condition even when the walk matches relationship_code OR
-- relationship_type. valid_to and system time are filters on the included columns.
CREATE INDEX IF NOT EXISTS idx_rel_parent_asof_seek
  ON entity_instances.entity_relationships
     (parent_entity_id, valid_from DESC)
  INCLUDE (valid_to, system_from, system_to, relationship_code, relationship_type, child_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_child_asof_seek
  ON entity_instances.entity_relationships
     (child_entity_id, valid_from DESC)
  INCLUDE (valid_to, system_from, system_to, relationship_code, relationship_type, parent_entity_id);

DROP INDEX IF EXISTS entity_instances.idx_entity_rel_parent_asof;
DROP INDEX IF EXISTS entity_instances.idx_entity_rel_child_asof;

-- ============================================================
-- 4. One as-of row per entity and attribute (lowest precedence among sources)
-- ============================================================
CREATE OR REPLACE FUNCTION golden_master.winning_attribute_values(
  p_entity_ids uuid[],
  p_attribute_ids uuid[],
  p_as_of date,
  p_knowledge timestamptz,
  p_require_text boolean DEFAULT false
) RETURNS TABLE (
  entity_id uuid,
  attribute_id uuid,
  source_id uuid,
  precedence_rank integer,
  golden_value text,
  golden_value_numeric numeric,
  golden_value_date date,
  golden_value_timestamp timestamptz,
  valid_from date,
  valid_to date
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (e.entity_id, a.attribute_id)
         e.entity_id,
         a.attribute_id,
         v.source_id,
         v.precedence_rank,
         v.golden_value,
         v.golden_value_numeric,
         v.golden_value_date,
         v.golden_value_timestamp,
         v.valid_from,
         v.valid_to
  FROM unnest(COALESCE(p_entity_ids, '{}'::uuid[])) AS e(entity_id)
  CROSS JOIN unnest(COALESCE(p_attribute_ids, '{}'::uuid[])) AS a(attribute_id)
  JOIN entity_instances.source_registry sr ON true
  JOIN LATERAL (
    SELECT eav.source_id, eav.precedence_rank, eav.golden_value, eav.golden_value_numeric,
           eav.golden_value_date, eav.golden_value_timestamp, eav.valid_from, eav.valid_to
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = e.entity_id
      AND eav.attribute_id = a.attribute_id
      AND eav.source_id = sr.id
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_from <= p_knowledge
      AND eav.system_to >= p_knowledge
    ORDER BY eav.valid_from DESC, eav.system_from DESC
    LIMIT 1
  ) v ON true
  WHERE NOT p_require_text
     OR (v.golden_value IS NOT NULL AND v.golden_value <> '')
  ORDER BY e.entity_id, a.attribute_id, v.precedence_rank
$$;

COMMENT ON FUNCTION golden_master.winning_attribute_values(uuid[], uuid[], date, timestamptz, boolean) IS
  'As-of golden values. One index seek per (entity, attribute, source) on idx_eav_entity_attr_source_asof, then the lowest precedence_rank. p_require_text drops blank sources before that choice, matching reporting.grid.';

CREATE OR REPLACE FUNCTION public.winning_attribute_values(
  p_entity_ids uuid[],
  p_attribute_ids uuid[],
  p_as_of date,
  p_knowledge timestamptz,
  p_require_text boolean DEFAULT false
) RETURNS TABLE (
  entity_id uuid,
  attribute_id uuid,
  source_id uuid,
  precedence_rank integer,
  golden_value text,
  golden_value_numeric numeric,
  golden_value_date date,
  golden_value_timestamp timestamptz,
  valid_from date,
  valid_to date
)
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM golden_master.winning_attribute_values(
    p_entity_ids, p_attribute_ids, p_as_of, p_knowledge, p_require_text);
$$;

GRANT EXECUTE ON FUNCTION golden_master.winning_attribute_values(uuid[], uuid[], date, timestamptz, boolean)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.winning_attribute_values(uuid[], uuid[], date, timestamptz, boolean)
  TO authenticated, service_role;

-- ============================================================
-- 5. Point and set readers
-- ============================================================
CREATE OR REPLACE FUNCTION golden_master.resolve_golden_record(
  p_entity_id UUID,
  p_attribute_id UUID,
  p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (
  golden_value TEXT,
  source_id UUID,
  source_code VARCHAR,
  precedence_rank INTEGER,
  valid_from DATE,
  valid_to DATE
) LANGUAGE sql STABLE AS $$
  SELECT w.golden_value, w.source_id, sr.source_code, w.precedence_rank, w.valid_from, w.valid_to
  FROM golden_master.winning_attribute_values(
         ARRAY[p_entity_id],
         ARRAY[p_attribute_id],
         p_as_of_date,
         '9999-12-31 23:59:59'::timestamptz,
         false) w
  JOIN entity_instances.source_registry sr ON sr.id = w.source_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION compliance.get_numeric_value(
  p_entity_id UUID,
  p_attribute_code VARCHAR,
  p_as_of_date DATE,
  p_knowledge_date TIMESTAMPTZ,
  p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_value NUMERIC;
  v_attribute_id UUID;
  v_source_id UUID;
BEGIN
  SELECT ar.id INTO v_attribute_id
  FROM metadata_register.attribute_register ar
  WHERE ar.attribute_code = p_attribute_code;
  IF v_attribute_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
    SELECT w.golden_value_numeric INTO v_value
    FROM golden_master.winning_attribute_values(
           ARRAY[p_entity_id], ARRAY[v_attribute_id], p_as_of_date, p_knowledge_date, false) w
    LIMIT 1;
  ELSE
    SELECT sr.id INTO v_source_id
    FROM entity_instances.source_registry sr
    WHERE sr.source_code = p_source_scope;
    IF v_source_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT s.value_as_numeric INTO v_value
    FROM entity_instances.source_attribute_values s
    WHERE s.entity_id = p_entity_id
      AND s.attribute_id = v_attribute_id
      AND s.source_id = v_source_id
      AND s.valid_from <= p_as_of_date
      AND s.valid_to >= p_as_of_date
      AND s.system_from <= p_knowledge_date
      AND s.system_to >= p_knowledge_date
    ORDER BY s.valid_from DESC, s.created_at DESC
    LIMIT 1;
  END IF;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.get_text_value(
  p_entity_id UUID,
  p_attribute_code VARCHAR,
  p_as_of_date DATE,
  p_knowledge_date TIMESTAMPTZ,
  p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_value TEXT;
  v_attribute_id UUID;
  v_source_id UUID;
BEGIN
  SELECT ar.id INTO v_attribute_id
  FROM metadata_register.attribute_register ar
  WHERE ar.attribute_code = p_attribute_code;
  IF v_attribute_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
    SELECT w.golden_value INTO v_value
    FROM golden_master.winning_attribute_values(
           ARRAY[p_entity_id], ARRAY[v_attribute_id], p_as_of_date, p_knowledge_date, false) w
    LIMIT 1;
  ELSE
    SELECT sr.id INTO v_source_id
    FROM entity_instances.source_registry sr
    WHERE sr.source_code = p_source_scope;
    IF v_source_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT s.attribute_value INTO v_value
    FROM entity_instances.source_attribute_values s
    WHERE s.entity_id = p_entity_id
      AND s.attribute_id = v_attribute_id
      AND s.source_id = v_source_id
      AND s.valid_from <= p_as_of_date
      AND s.valid_to >= p_as_of_date
      AND s.system_from <= p_knowledge_date
      AND s.system_to >= p_knowledge_date
    ORDER BY s.valid_from DESC, s.created_at DESC
    LIMIT 1;
  END IF;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.get_numeric_values(
  p_entity_ids UUID[],
  p_attribute_code VARCHAR,
  p_as_of DATE,
  p_knowledge TIMESTAMPTZ,
  p_source_scope VARCHAR
) RETURNS TABLE (entity_id UUID, val NUMERIC) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
  v_attribute_id UUID;
  v_source_id UUID;
BEGIN
  SELECT ar.id INTO v_attribute_id
  FROM metadata_register.attribute_register ar
  WHERE ar.attribute_code = p_attribute_code;
  IF v_attribute_id IS NULL OR p_entity_ids IS NULL THEN
    RETURN;
  END IF;

  IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
    RETURN QUERY
    SELECT w.entity_id, w.golden_value_numeric
    FROM golden_master.winning_attribute_values(
           p_entity_ids, ARRAY[v_attribute_id], p_as_of, p_knowledge, false) w;
  ELSE
    SELECT sr.id INTO v_source_id
    FROM entity_instances.source_registry sr
    WHERE sr.source_code = p_source_scope;
    IF v_source_id IS NULL THEN
      RETURN;
    END IF;
    RETURN QUERY
    SELECT e.entity_id, v.val
    FROM unnest(p_entity_ids) AS e(entity_id)
    JOIN LATERAL (
      SELECT s.value_as_numeric AS val
      FROM entity_instances.source_attribute_values s
      WHERE s.entity_id = e.entity_id
        AND s.attribute_id = v_attribute_id
        AND s.source_id = v_source_id
        AND s.valid_from <= p_as_of
        AND s.valid_to >= p_as_of
        AND s.system_from <= p_knowledge
        AND s.system_to >= p_knowledge
      ORDER BY s.valid_from DESC, s.created_at DESC
      LIMIT 1
    ) v ON true;
  END IF;
END;
$$;

-- ============================================================
-- 6. Report grid reads the same seek for own and related attributes
-- ============================================================
CREATE OR REPLACE FUNCTION reporting.grid(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $fn$
DECLARE
    c_builtin CONSTANT text[] := ARRAY['entity_id', 'entity_code', 'entity_name', 'domain_code'];
    v_lk jsonb := COALESCE(p_request->'lookups', '[]'::jsonb);
    v_laliases text[] := '{}';
    v_lkctes text := '';
    v_joins text := '';
    v_fields text[];
    v_own text[];
    v_lcodes text[];
    v_lmap jsonb := '{}'::jsonb;
    v_lpiv text;
    v_src text;
    v_fcol text;
    v_tcol text;
    k int;
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

    -- ---- lookups: attributes of RELATED entities, addressed as <alias>.<ATTRIBUTE> ----
    FOR i IN 0..jsonb_array_length(v_lk) - 1 LOOP
        v_item := v_lk->i;
        IF COALESCE(v_item->>'alias', '') !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
            RAISE EXCEPTION 'Each lookup needs an identifier alias (letters, digits, _)';
        END IF;
        IF (v_item->>'alias') = ANY (v_laliases) THEN RAISE EXCEPTION 'Duplicate lookup alias: %', v_item->>'alias'; END IF;
        IF upper(COALESCE(v_item->>'direction', '')) NOT IN ('UP', 'DOWN') THEN
            RAISE EXCEPTION 'Lookup % needs direction UP or DOWN', v_item->>'alias';
        END IF;
        IF v_item->>'from' IS NOT NULL AND NOT ((v_item->>'from') = ANY (v_laliases)) THEN
            RAISE EXCEPTION 'Lookup % refers to unknown (or later-defined) lookup %', v_item->>'alias', v_item->>'from';
        END IF;
        v_laliases := v_laliases || (v_item->>'alias');
    END LOOP;

    -- ---- fields this request touches (builtins excluded) ----
    SELECT COALESCE(array_agg(DISTINCT f ORDER BY f), '{}') INTO v_fields FROM (
        SELECT jsonb_array_elements_text(v_columns) AS f
        UNION SELECT jsonb_array_elements_text(v_group_by)
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_filters) x
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_sort) x
            WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_metrics) m WHERE m->>'alias' = x->>'field')
        UNION SELECT x->>'field' FROM jsonb_array_elements(v_metrics) x
        UNION SELECT x->>'weightField' FROM jsonb_array_elements(v_metrics) x
    ) s WHERE f IS NOT NULL AND f <> ALL (c_builtin);

    v_meta := '{}'::jsonb;
    FOREACH v_field IN ARRAY v_fields LOOP
        v_meta := v_meta || jsonb_build_object(v_field, reporting.field_meta(v_field, v_lk));
    END LOOP;
    -- weight fields needed by default (WEIGHTED_AVG) aggregations
    SELECT COALESCE(array_agg(DISTINCT m.value->>'weight'), '{}') INTO v_extra
    FROM jsonb_each(v_meta) m
    WHERE m.value->>'agg' = 'WEIGHTED_AVG' AND m.value->>'weight' IS NOT NULL AND NOT (v_meta ? (m.value->>'weight'));
    FOREACH v_field IN ARRAY v_extra LOOP
        v_meta := v_meta || jsonb_build_object(v_field, reporting.field_meta(v_field, v_lk));
    END LOOP;
    SELECT COALESCE(array_agg(kk ORDER BY kk), '{}') INTO v_codes FROM jsonb_object_keys(v_meta) kk;
    SELECT COALESCE(array_agg(c), '{}') INTO v_own FROM unnest(v_codes) c WHERE position('.' in c) = 0;

    -- ---- entity set ----
    v_ids := reporting.resolve_entities(
        COALESCE(p_request->>'start', 'CONTEXT'), v_domain,
        NULLIF(p_request->>'contextEntityId', '')::uuid,
        p_request->'path', COALESCE((p_request->>'includeAnchor')::boolean, false),
        v_asof, v_know);

    -- ---- pivot columns ----
    -- lookup CTEs: one related entity per base entity (nearest by entity_code when several), then its attributes
    FOR k IN 0..jsonb_array_length(v_lk) - 1 LOOP
        v_item := v_lk->k;
        v_dir := upper(v_item->>'direction');
        v_fcol := CASE WHEN v_dir = 'UP' THEN 'child_entity_id' ELSE 'parent_entity_id' END;
        v_tcol := CASE WHEN v_dir = 'UP' THEN 'parent_entity_id' ELSE 'child_entity_id' END;
        v_src := CASE WHEN v_item->>'from' IS NULL THEN 'SELECT id AS sid, id AS src FROM ents'
                      ELSE format('SELECT sid, rid AS src FROM lk%s', array_position(v_laliases, v_item->>'from') - 1) END;
        v_lkctes := v_lkctes || format($q$
        , lk%1$s AS (
            SELECT DISTINCT ON (s.sid) s.sid, t.id AS rid, t.entity_code AS ecode, t.entity_name AS ename
            FROM (%2$s) s
            JOIN entity_instances.entity_relationships r ON r.%3$I = s.src
            JOIN entity_instances.master_entities t ON t.id = r.%4$I
            WHERE r.valid_from <= $3 AND r.valid_to >= $3 AND r.system_from <= $5 AND r.system_to >= $5
              AND t.is_active%5$s%6$s
            ORDER BY s.sid, t.entity_code, t.id)$q$,
            k, v_src, v_fcol, v_tcol,
            CASE WHEN NULLIF(v_item->>'relationshipCode', '') IS NULL THEN ''
                 ELSE format(' AND (r.relationship_code = %1$L OR r.relationship_type = %1$L)', v_item->>'relationshipCode') END,
            CASE WHEN NULLIF(v_item->>'domainCode', '') IS NULL THEN ''
                 ELSE format(' AND t.domain_code = %L', v_item->>'domainCode') END);
        v_joins := v_joins || format(' LEFT JOIN lk%1$s ON lk%1$s.sid = e.id', k);

        SELECT COALESCE(array_agg(c ORDER BY c), '{}') INTO v_lcodes FROM (
            SELECT DISTINCT substr(f, char_length(v_item->>'alias') + 2) AS c
            FROM unnest(v_codes) f
            WHERE left(f, char_length(v_item->>'alias') + 1) = (v_item->>'alias') || '.'
              AND substr(f, char_length(v_item->>'alias') + 2) <> ALL (ARRAY['entity_code', 'entity_name'])
        ) s;
        IF cardinality(v_lcodes) > 0 THEN
            v_lpiv := '';
            FOR j IN 1..cardinality(v_lcodes) LOOP
                v_lpiv := v_lpiv || format(', max(CASE WHEN v.code = %L THEN %s END) AS r%s', v_lcodes[j],
                    reporting.val_expr(v_meta->((v_item->>'alias') || '.' || v_lcodes[j])->>'kind'), j);
                v_lmap := v_lmap || jsonb_build_object((v_item->>'alias') || '.' || v_lcodes[j], format('rp%s.r%s', k, j));
            END LOOP;
            v_lkctes := v_lkctes || format($q$
        , rp%1$s AS (
            SELECT v.entity_id %2$s FROM (
                SELECT w.entity_id, ar.attribute_code AS code,
                       w.golden_value AS txt, w.golden_value_numeric AS num,
                       w.golden_value_date AS dt, w.golden_value_timestamp AS ts
                FROM golden_master.winning_attribute_values(
                       ARRAY(SELECT DISTINCT rid FROM lk%1$s),
                       ARRAY(SELECT id FROM metadata_register.attribute_register WHERE attribute_code = ANY (%3$L::text[])),
                       $3, $5, true) w
                JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id) v
            GROUP BY v.entity_id)$q$, k, v_lpiv, v_lcodes);
            v_joins := v_joins || format(' LEFT JOIN rp%1$s ON rp%1$s.entity_id = lk%1$s.rid', k);
        END IF;
    END LOOP;

    FOR i IN 1..COALESCE(cardinality(v_codes), 0) LOOP
        IF position('.' in v_codes[i]) = 0 THEN
            v_pivot := v_pivot || format(', max(CASE WHEN v.code = %L THEN %s END) AS c%s',
                v_codes[i], reporting.val_expr(v_meta->v_codes[i]->>'kind'), i);
        ELSIF (v_meta->v_codes[i]->>'builtin') = 'true' THEN
            v_pivot := v_pivot || format(', max(lk%s.%s) AS c%s',
                array_position(v_laliases, split_part(v_codes[i], '.', 1)) - 1,
                CASE WHEN v_meta->v_codes[i]->>'code' = 'entity_name' THEN 'ename' ELSE 'ecode' END, i);
        ELSE
            v_pivot := v_pivot || format(', max(%s) AS c%s', v_lmap->>v_codes[i], i);
        END IF;
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
            SELECT w.entity_id, ar.attribute_code AS code,
                   w.golden_value AS txt, w.golden_value_numeric AS num,
                   w.golden_value_date AS dt, w.golden_value_timestamp AS ts
            FROM golden_master.winning_attribute_values(
                   $1,
                   ARRAY(SELECT id FROM metadata_register.attribute_register WHERE attribute_code = ANY ($2)),
                   $3, $5, true) w
            JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id
        )%s
        , base AS (
            SELECT e.id, e.entity_code, e.entity_name, e.domain_code %s
            FROM ents e LEFT JOIN vals v ON v.entity_id = e.id%s
            GROUP BY e.id, e.entity_code, e.entity_name, e.domain_code
        ), filt AS (
            SELECT * FROM base b WHERE %s
        )
    $q$, v_lkctes, v_pivot, v_joins, v_where);

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

    EXECUTE v_sql INTO v_result USING v_ids, v_own, v_asof, v_domain, v_know, v_limit, v_offset;

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


NOTIFY pgrst, 'reload schema';
