-- Gross asset value and IRR use the same queued rows as market value.
-- A period calculation is one statement over every claimed entity and every
-- as-of date in that entity's window. XIRR still runs per fund and date,
-- inside that statement.

CREATE OR REPLACE FUNCTION golden_master.period_batch_dates(
    p_job_ids UUID[],
    p_grain TEXT
)
RETURNS TABLE(entity_id UUID, valid_from DATE, valid_to DATE)
LANGUAGE sql
STABLE
AS $$
    WITH jobs AS (
        SELECT i.entity_id, i.window_start, i.window_end,
               LEAST(i.window_end, CURRENT_DATE) AS cap
        FROM golden_master.calc_invalidations i
        WHERE i.id = ANY (p_job_ids)
          AND i.window_start <= LEAST(i.window_end, CURRENT_DATE)
    ),
    step AS (
        SELECT CASE p_grain
                   WHEN 'MONTH_END' THEN INTERVAL '1 month'
                   WHEN 'YEAR_END' THEN INTERVAL '1 year'
                   ELSE INTERVAL '3 months'
               END AS step,
               CASE p_grain
                   WHEN 'MONTH_END' THEN 'month'
                   WHEN 'YEAR_END' THEN 'year'
                   ELSE 'quarter'
               END AS trunc
    ),
    bounds AS (
        SELECT j.entity_id, j.window_end,
               (date_trunc(s.trunc, gs) + s.step - INTERVAL '1 day')::DATE AS boundary
        FROM jobs j
        CROSS JOIN step s
        CROSS JOIN LATERAL generate_series(
            date_trunc(s.trunc, j.window_start::TIMESTAMP),
            date_trunc(s.trunc, j.cap::TIMESTAMP),
            s.step
        ) AS gs
        WHERE (date_trunc(s.trunc, gs) + s.step - INTERVAL '1 day')::DATE >= j.window_start
          AND (date_trunc(s.trunc, gs) + s.step - INTERVAL '1 day')::DATE <= j.cap
    )
    SELECT entity_id, boundary AS valid_from,
           COALESCE(
               (LEAD(boundary) OVER (PARTITION BY entity_id ORDER BY boundary) - 1),
               CASE WHEN window_end >= DATE '9999-12-31' THEN DATE '9999-12-31' ELSE window_end END
           ) AS valid_to
    FROM bounds;
$$;

CREATE OR REPLACE FUNCTION golden_master.aggregate_batch_capable(p_calc_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.calc_definitions cd
        WHERE cd.id = p_calc_id
          AND cd.evaluation_mode = 'MATERIALIZED'
          AND cd.calc_kind = 'AGGREGATE'
          AND cd.aggregate_fn IN ('SUM', 'MIN', 'MAX', 'WAVG')
          AND cd.output_grain IN ('MONTH_END', 'QUARTER_END', 'YEAR_END')
    )
    AND (
        SELECT COUNT(*) FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'MEASURE'
    ) = 1
    AND NOT EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id
          AND ci.input_role NOT IN ('MEASURE', 'WEIGHT')
    );
$$;

CREATE OR REPLACE FUNCTION golden_master.series_batch_capable(p_calc_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.calc_definitions cd
        WHERE cd.id = p_calc_id
          AND cd.evaluation_mode = 'MATERIALIZED'
          AND cd.calc_kind = 'SERIES'
          AND cd.series_fn = 'XIRR'
          AND cd.output_grain IN ('MONTH_END', 'QUARTER_END', 'YEAR_END')
    )
    AND (
        SELECT COUNT(*) FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'AMOUNT'
    ) = 1
    AND (
        SELECT COUNT(*) FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'FLOW_DATE'
    ) = 1
    AND (
        SELECT COUNT(*) FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'TERMINAL'
    ) = 1;
$$;

CREATE OR REPLACE FUNCTION golden_master.calc_batch_capable(p_calc_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT golden_master.expression_batch_capable(p_calc_id)
        OR golden_master.aggregate_batch_capable(p_calc_id)
        OR golden_master.series_batch_capable(p_calc_id);
$$;

CREATE OR REPLACE FUNCTION golden_master.aggregate_batch_slices(p_job_ids UUID[])
RETURNS TABLE(entity_id UUID, valid_from DATE, valid_to DATE, value NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_fn TEXT;
    v_grain TEXT;
    v_traversal TEXT;
    v_codes TEXT[];
    v_measure VARCHAR(100);
    v_weight VARCHAR(100);
BEGIN
    SELECT cd.aggregate_fn, cd.output_grain, ci.traversal, ci.relationship_codes, ci.attribute_code
      INTO v_fn, v_grain, v_traversal, v_codes, v_measure
    FROM golden_master.calc_invalidations i
    JOIN metadata_register.calc_definitions cd ON cd.attribute_id = i.calc_attribute_id
    JOIN metadata_register.calc_inputs ci ON ci.calc_definition_id = cd.id AND ci.input_role = 'MEASURE'
    WHERE i.id = ANY (p_job_ids)
    LIMIT 1;

    SELECT attribute_code INTO v_weight
    FROM metadata_register.calc_inputs ci
    JOIN metadata_register.calc_definitions cd ON cd.id = ci.calc_definition_id
    JOIN golden_master.calc_invalidations i ON i.calc_attribute_id = cd.attribute_id
    WHERE i.id = ANY (p_job_ids) AND ci.input_role = 'WEIGHT'
    LIMIT 1;

    RETURN QUERY
    WITH RECURSIVE dates AS (
        SELECT * FROM golden_master.period_batch_dates(p_job_ids, v_grain)
    ),
    codes AS (
        SELECT hop.code, hop.ordinal::INTEGER AS ord
        FROM unnest(COALESCE(v_codes, ARRAY[]::TEXT[])) WITH ORDINALITY AS hop(code, ordinal)
    ),
    walk AS (
        SELECT d.entity_id AS root_id, d.valid_from AS as_of, d.valid_to, d.entity_id AS current_id, 0 AS depth
        FROM dates d
        UNION ALL
        SELECT w.root_id, w.as_of, w.valid_to,
               CASE WHEN v_traversal = 'DOWN' THEN er.child_entity_id ELSE er.parent_entity_id END,
               w.depth + 1
        FROM walk w
        JOIN codes c ON c.ord = w.depth + 1
        JOIN entity_instances.entity_relationships er
          ON er.relationship_code = c.code
         AND er.system_to = golden_master.open_system_to()
         AND er.valid_from <= w.as_of
         AND er.valid_to >= w.as_of
         AND (
              (v_traversal = 'DOWN' AND er.parent_entity_id = w.current_id)
           OR (v_traversal <> 'DOWN' AND er.child_entity_id = w.current_id)
         )
        WHERE w.depth < 8
    ),
    members AS (
        SELECT root_id, as_of, valid_to, current_id
        FROM walk
        WHERE depth = CASE
            WHEN v_traversal = 'SELF' OR COALESCE(cardinality(v_codes), 0) = 0 THEN 0
            ELSE COALESCE(cardinality(v_codes), 0)
        END
    ),
    measured AS (
        SELECT m.root_id, m.as_of, m.valid_to,
               (
                   SELECT COALESCE(eav.golden_value_numeric,
                       CASE WHEN eav.golden_value ~ '^-?[0-9]+([.][0-9]+)?$' THEN eav.golden_value::NUMERIC END)
                   FROM golden_master.entity_attribute_values eav
                   JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                   WHERE eav.entity_id = m.current_id
                     AND ar.attribute_code = v_measure
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= m.as_of
                     AND eav.valid_to >= m.as_of
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               ) AS amount,
               (
                   SELECT COALESCE(eav.golden_value_numeric,
                       CASE WHEN eav.golden_value ~ '^-?[0-9]+([.][0-9]+)?$' THEN eav.golden_value::NUMERIC END)
                   FROM golden_master.entity_attribute_values eav
                   JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                   WHERE v_weight IS NOT NULL
                     AND eav.entity_id = m.current_id
                     AND ar.attribute_code = v_weight
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= m.as_of
                     AND eav.valid_to >= m.as_of
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               ) AS weight
        FROM members m
    )
    SELECT g.root_id, g.as_of, g.valid_to,
           CASE
               WHEN COUNT(g.amount) = 0 THEN NULL
               WHEN v_fn = 'MIN' THEN MIN(g.amount)
               WHEN v_fn = 'MAX' THEN MAX(g.amount)
               WHEN v_fn = 'WAVG' THEN SUM(g.amount * g.weight) / NULLIF(SUM(g.weight), 0)
               ELSE SUM(g.amount)
           END
    FROM measured g
    GROUP BY g.root_id, g.as_of, g.valid_to;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.series_batch_slices(p_job_ids UUID[])
RETURNS TABLE(entity_id UUID, valid_from DATE, valid_to DATE, value NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_grain TEXT;
    v_traversal TEXT;
    v_codes TEXT[];
    v_amount VARCHAR(100);
    v_flow VARCHAR(100);
    v_terminal VARCHAR(100);
BEGIN
    SELECT cd.output_grain, amt.traversal, amt.relationship_codes, amt.attribute_code, flow.attribute_code, term.attribute_code
      INTO v_grain, v_traversal, v_codes, v_amount, v_flow, v_terminal
    FROM golden_master.calc_invalidations i
    JOIN metadata_register.calc_definitions cd ON cd.attribute_id = i.calc_attribute_id
    JOIN metadata_register.calc_inputs amt ON amt.calc_definition_id = cd.id AND amt.input_role = 'AMOUNT'
    JOIN metadata_register.calc_inputs flow ON flow.calc_definition_id = cd.id AND flow.input_role = 'FLOW_DATE'
    JOIN metadata_register.calc_inputs term ON term.calc_definition_id = cd.id AND term.input_role = 'TERMINAL'
    WHERE i.id = ANY (p_job_ids)
    LIMIT 1;

    RETURN QUERY
    WITH RECURSIVE dates AS (
        SELECT * FROM golden_master.period_batch_dates(p_job_ids, v_grain)
    ),
    codes AS (
        SELECT hop.code, hop.ordinal::INTEGER AS ord
        FROM unnest(COALESCE(v_codes, ARRAY[]::TEXT[])) WITH ORDINALITY AS hop(code, ordinal)
    ),
    walk AS (
        SELECT d.entity_id AS root_id, d.valid_from AS as_of, d.valid_to, d.entity_id AS current_id, 0 AS depth
        FROM dates d
        UNION ALL
        SELECT w.root_id, w.as_of, w.valid_to,
               CASE WHEN v_traversal = 'DOWN' THEN er.child_entity_id ELSE er.parent_entity_id END,
               w.depth + 1
        FROM walk w
        JOIN codes c ON c.ord = w.depth + 1
        JOIN entity_instances.entity_relationships er
          ON er.relationship_code = c.code
         AND er.system_to = golden_master.open_system_to()
         AND er.valid_from <= w.as_of
         AND er.valid_to >= w.as_of
         AND (
              (v_traversal = 'DOWN' AND er.parent_entity_id = w.current_id)
           OR (v_traversal <> 'DOWN' AND er.child_entity_id = w.current_id)
         )
        WHERE w.depth < 8
    ),
    members AS (
        SELECT root_id, as_of, valid_to, current_id
        FROM walk
        WHERE depth = CASE
            WHEN v_traversal = 'SELF' OR COALESCE(cardinality(v_codes), 0) = 0 THEN 0
            ELSE COALESCE(cardinality(v_codes), 0)
        END
    ),
    flows AS (
        SELECT m.root_id, m.as_of, m.valid_to,
               (
                   SELECT COALESCE(eav.golden_value_date,
                       CASE WHEN eav.golden_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(eav.golden_value, 10)::DATE END)
                   FROM golden_master.entity_attribute_values eav
                   JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                   WHERE eav.entity_id = m.current_id
                     AND ar.attribute_code = v_flow
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= m.as_of
                     AND eav.valid_to >= m.as_of
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               ) AS flow_date,
               (
                   SELECT COALESCE(eav.golden_value_numeric,
                       CASE WHEN eav.golden_value ~ '^-?[0-9]+([.][0-9]+)?$' THEN eav.golden_value::NUMERIC END)
                   FROM golden_master.entity_attribute_values eav
                   JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                   WHERE eav.entity_id = m.current_id
                     AND ar.attribute_code = v_amount
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= m.as_of
                     AND eav.valid_to >= m.as_of
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               ) AS amount
        FROM members m
    ),
    kept AS (
        SELECT root_id, as_of, valid_to, flow_date, amount
        FROM flows
        WHERE amount IS NOT NULL AND flow_date IS NOT NULL AND flow_date <= as_of
        UNION ALL
        SELECT d.entity_id, d.valid_from, d.valid_to, d.valid_from,
               (
                   SELECT COALESCE(eav.golden_value_numeric,
                       CASE WHEN eav.golden_value ~ '^-?[0-9]+([.][0-9]+)?$' THEN eav.golden_value::NUMERIC END)
                   FROM golden_master.entity_attribute_values eav
                   JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                   WHERE eav.entity_id = d.entity_id
                     AND ar.attribute_code = v_terminal
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= d.valid_from
                     AND eav.valid_to >= d.valid_from
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               )
        FROM dates d
    ),
    solved AS (
        SELECT k.root_id, k.as_of, k.valid_to,
               golden_master.xirr(
                   array_agg(k.flow_date ORDER BY k.flow_date, k.amount),
                   array_agg(k.amount ORDER BY k.flow_date, k.amount)
               ) AS rate
        FROM kept k
        WHERE k.amount IS NOT NULL
        GROUP BY k.root_id, k.as_of, k.valid_to
    )
    SELECT d.entity_id, d.valid_from, d.valid_to, s.rate
    FROM dates d
    LEFT JOIN solved s ON s.root_id = d.entity_id AND s.as_of = d.valid_from;
END;
$$;

ALTER FUNCTION golden_master.expression_batch_slices(UUID[])
    RENAME TO expression_only_batch_slices;

CREATE OR REPLACE FUNCTION golden_master.expression_batch_slices(p_job_ids UUID[])
RETURNS TABLE(entity_id UUID, valid_from DATE, valid_to DATE, value NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_id UUID;
    v_kind TEXT;
BEGIN
    SELECT cd.id, cd.calc_kind
      INTO v_id, v_kind
    FROM golden_master.calc_invalidations i
    JOIN metadata_register.calc_definitions cd ON cd.attribute_id = i.calc_attribute_id
    WHERE i.id = ANY (p_job_ids)
    LIMIT 1;

    IF golden_master.expression_batch_capable(v_id) THEN
        RETURN QUERY SELECT * FROM golden_master.expression_only_batch_slices(p_job_ids);
    ELSIF golden_master.aggregate_batch_capable(v_id) THEN
        RETURN QUERY SELECT * FROM golden_master.aggregate_batch_slices(p_job_ids);
    ELSIF golden_master.series_batch_capable(v_id) THEN
        RETURN QUERY SELECT * FROM golden_master.series_batch_slices(p_job_ids);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.process_calc_invalidations(
    p_limit INTEGER,
    p_entity_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
    v_processed INTEGER := 0;
    v_failed INTEGER := 0;
    v_calc_id UUID;
    v_attribute_id UUID;
    v_grain TEXT;
    v_ids UUID[];
    v_ready UUID[];
    v_dated UUID[];
    v_rest JSONB;
BEGIN
    LOOP
        EXIT WHEN v_processed + v_failed >= v_limit;

        SELECT cd.id, cd.attribute_id, cd.output_grain
          INTO v_calc_id, v_attribute_id, v_grain
        FROM metadata_register.calc_definitions cd
        WHERE golden_master.calc_batch_capable(cd.id)
          AND EXISTS (
              SELECT 1
              FROM golden_master.calc_invalidations i
              WHERE i.calc_attribute_id = cd.attribute_id
                AND i.status = 'PENDING'
                AND (i.not_before IS NULL OR i.not_before <= CURRENT_DATE)
                AND (p_entity_id IS NULL OR i.entity_id = p_entity_id)
          )
        ORDER BY golden_master.calc_depth(cd.attribute_id)
        LIMIT 1;

        EXIT WHEN v_calc_id IS NULL;

        WITH claimed AS (
            UPDATE golden_master.calc_invalidations i
            SET status = 'RUNNING', started_at = clock_timestamp(), last_error = NULL
            WHERE i.id IN (
                SELECT pending.id
                FROM golden_master.calc_invalidations pending
                WHERE pending.calc_attribute_id = v_attribute_id
                  AND pending.status = 'PENDING'
                  AND (pending.not_before IS NULL OR pending.not_before <= CURRENT_DATE)
                  AND (p_entity_id IS NULL OR pending.entity_id = p_entity_id)
                ORDER BY pending.window_start, pending.enqueued_at
                LIMIT v_limit - v_processed - v_failed
                FOR UPDATE SKIP LOCKED
            )
            RETURNING i.id, i.window_start, i.window_end
        )
        SELECT COALESCE(array_agg(id), '{}'),
               COALESCE(array_agg(id) FILTER (
                   WHERE window_start <= LEAST(window_end, CURRENT_DATE)
               ), '{}')
          INTO v_ids, v_ready
        FROM claimed;

        EXIT WHEN COALESCE(cardinality(v_ids), 0) = 0;

        UPDATE golden_master.calc_invalidations
        SET status = 'PENDING', not_before = window_start, started_at = NULL
        WHERE id = ANY (v_ids)
          AND NOT (id = ANY (v_ready));

        IF v_grain IS DISTINCT FROM 'ON_INPUT_CHANGE' AND COALESCE(cardinality(v_ready), 0) > 0 THEN
            SELECT COALESCE(array_agg(i.id), '{}')
              INTO v_dated
            FROM golden_master.calc_invalidations i
            WHERE i.id = ANY (v_ready)
              AND EXISTS (
                  SELECT 1
                  FROM golden_master.period_batch_dates(v_ready, v_grain) d
                  WHERE d.entity_id = i.entity_id
              );

            UPDATE golden_master.calc_invalidations i
            SET status = 'PENDING',
                not_before = golden_master.next_calc_date(v_calc_id, i.window_start),
                started_at = NULL
            WHERE i.id = ANY (v_ready)
              AND NOT (i.id = ANY (v_dated));

            v_ready := v_dated;
        END IF;

        IF COALESCE(cardinality(v_ready), 0) = 0 THEN
            CONTINUE;
        END IF;

        BEGIN
            PERFORM golden_master.apply_expression_batch(v_ready);
            PERFORM golden_master.enqueue_batch_dependents(v_ready);
            UPDATE golden_master.calc_invalidations
            SET status = 'DONE', finished_at = clock_timestamp()
            WHERE id = ANY (v_ready);
            v_processed := v_processed + COALESCE(cardinality(v_ready), 0);
        EXCEPTION
            WHEN OTHERS THEN
                PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
                UPDATE golden_master.calc_invalidations
                SET status = 'FAILED', last_error = SQLERRM, finished_at = clock_timestamp()
                WHERE id = ANY (v_ready);
                v_failed := v_failed + COALESCE(cardinality(v_ready), 0);
        END;
    END LOOP;

    IF v_processed + v_failed < v_limit THEN
        v_rest := golden_master.process_calc_invalidations_each(v_limit - v_processed - v_failed, p_entity_id);
        v_processed := v_processed + COALESCE((v_rest->>'processed')::INTEGER, 0);
        v_failed := v_failed + COALESCE((v_rest->>'failed')::INTEGER, 0);
    END IF;

    RETURN jsonb_build_object(
        'processed', v_processed,
        'failed', v_failed,
        'pending', (
            SELECT COUNT(*)
            FROM golden_master.calc_invalidations
            WHERE status IN ('PENDING', 'RUNNING')
              AND (p_entity_id IS NULL OR entity_id = p_entity_id)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION golden_master.period_batch_dates(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.aggregate_batch_capable(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.series_batch_capable(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.calc_batch_capable(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.aggregate_batch_slices(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.series_batch_slices(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.expression_only_batch_slices(UUID[]) FROM PUBLIC;
