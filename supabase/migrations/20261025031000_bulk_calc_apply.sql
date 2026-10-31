-- A calculation queue is one row per affected entity. Applying a batch is one
-- statement: same formula, many entities, each with its own as-of window.

CREATE OR REPLACE FUNCTION golden_master.expression_batch_capable(p_calc_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.calc_definitions cd
        WHERE cd.id = p_calc_id
          AND cd.evaluation_mode = 'MATERIALIZED'
          AND cd.calc_kind = 'EXPRESSION'
          AND cd.output_grain = 'ON_INPUT_CHANGE'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id
          AND (
              ci.input_role <> 'OPERAND'
              OR (
                  ci.traversal <> 'SELF'
                  AND COALESCE(cardinality(ci.relationship_codes), 0) <> 1
              )
          )
    )
    AND EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'OPERAND'
    );
$$;

CREATE OR REPLACE FUNCTION golden_master.expression_batch_slices(p_job_ids UUID[])
RETURNS TABLE(entity_id UUID, valid_from DATE, valid_to DATE, value NUMERIC)
LANGUAGE sql
STABLE
AS $$
    WITH jobs AS (
        SELECT i.id, i.entity_id, i.window_start, i.window_end, i.calc_attribute_id,
               LEAST(i.window_end, CURRENT_DATE) AS cap
        FROM golden_master.calc_invalidations i
        WHERE i.id = ANY (p_job_ids)
          AND i.window_start <= LEAST(i.window_end, CURRENT_DATE)
    ),
    definition AS (
        SELECT DISTINCT cd.id AS calc_id, cd.expression
        FROM jobs j
        JOIN metadata_register.calc_definitions cd ON cd.attribute_id = j.calc_attribute_id
    ),
    operands AS (
        SELECT ci.attribute_code, ci.traversal, ci.relationship_codes, ar.id AS attribute_id
        FROM definition d
        JOIN metadata_register.calc_inputs ci ON ci.calc_definition_id = d.calc_id AND ci.input_role = 'OPERAND'
        JOIN metadata_register.attribute_register ar ON ar.attribute_code = ci.attribute_code
    ),
    self_bounds AS (
        SELECT j.entity_id, eav.valid_from AS boundary
        FROM jobs j
        JOIN operands o ON o.traversal = 'SELF'
        JOIN golden_master.entity_attribute_values eav
          ON eav.entity_id = j.entity_id
         AND eav.attribute_id = o.attribute_id
         AND eav.source_id = eav.golden_source_id
         AND eav.system_to = golden_master.open_system_to()
         AND eav.valid_from > j.window_start
         AND eav.valid_from <= j.cap
    ),
    related_bounds AS (
        SELECT j.entity_id, eav.valid_from AS boundary
        FROM jobs j
        JOIN operands o ON o.traversal <> 'SELF'
        JOIN entity_instances.entity_relationships er
          ON er.relationship_code = o.relationship_codes[1]
         AND er.system_to = golden_master.open_system_to()
         AND er.valid_to >= j.window_start
         AND er.valid_from <= j.cap
         AND (
              (o.traversal = 'UP' AND er.child_entity_id = j.entity_id)
           OR (o.traversal = 'DOWN' AND er.parent_entity_id = j.entity_id)
         )
        JOIN golden_master.entity_attribute_values eav
          ON eav.entity_id = CASE WHEN o.traversal = 'UP' THEN er.parent_entity_id ELSE er.child_entity_id END
         AND eav.attribute_id = o.attribute_id
         AND eav.source_id = eav.golden_source_id
         AND eav.system_to = golden_master.open_system_to()
         AND eav.valid_from > j.window_start
         AND eav.valid_from <= j.cap
    ),
    bounds AS (
        SELECT entity_id, window_start AS boundary, window_end FROM jobs
        UNION
        SELECT b.entity_id, b.boundary, j.window_end
        FROM self_bounds b
        JOIN jobs j ON j.entity_id = b.entity_id
        UNION
        SELECT b.entity_id, b.boundary, j.window_end
        FROM related_bounds b
        JOIN jobs j ON j.entity_id = b.entity_id
    ),
    ordered AS (
        SELECT DISTINCT entity_id, boundary, window_end
        FROM bounds
        WHERE boundary <= LEAST(window_end, CURRENT_DATE)
    ),
    slices AS (
        SELECT entity_id, boundary AS valid_from, window_end,
               COALESCE(
                   (LEAD(boundary) OVER (PARTITION BY entity_id ORDER BY boundary) - 1),
                   CASE WHEN window_end >= DATE '9999-12-31' THEN DATE '9999-12-31' ELSE window_end END
               ) AS valid_to
        FROM ordered
    ),
    valued AS (
        SELECT s.entity_id, s.valid_from, s.valid_to, o.attribute_code,
               (
                   SELECT COALESCE(
                       eav.golden_value_numeric,
                       CASE
                           WHEN eav.golden_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN eav.golden_value::NUMERIC
                           ELSE NULL
                       END
                   )
                   FROM golden_master.entity_attribute_values eav
                   WHERE eav.entity_id = input.input_entity_id
                     AND eav.attribute_id = o.attribute_id
                     AND eav.source_id = eav.golden_source_id
                     AND eav.valid_from <= s.valid_from
                     AND eav.valid_to >= s.valid_from
                     AND eav.system_to = golden_master.open_system_to()
                   LIMIT 1
               ) AS input_value
        FROM slices s
        JOIN operands o ON TRUE
        LEFT JOIN LATERAL (
            SELECT CASE
                WHEN o.traversal = 'SELF' THEN s.entity_id
                ELSE (
                    SELECT CASE WHEN o.traversal = 'UP' THEN er.parent_entity_id ELSE er.child_entity_id END
                    FROM entity_instances.entity_relationships er
                    WHERE er.relationship_code = o.relationship_codes[1]
                      AND er.system_to = golden_master.open_system_to()
                      AND er.valid_from <= s.valid_from
                      AND er.valid_to >= s.valid_from
                      AND (
                           (o.traversal = 'UP' AND er.child_entity_id = s.entity_id)
                        OR (o.traversal = 'DOWN' AND er.parent_entity_id = s.entity_id)
                      )
                    ORDER BY er.is_primary DESC, er.valid_from DESC
                    LIMIT 1
                )
            END AS input_entity_id
        ) input ON TRUE
    )
    SELECT v.entity_id, v.valid_from, v.valid_to,
           metadata_register.eval_numeric_expr(
               (SELECT expression FROM definition),
               COALESCE(jsonb_object_agg(v.attribute_code, to_jsonb(v.input_value)) FILTER (WHERE v.input_value IS NOT NULL), '{}'::jsonb)
           )
    FROM valued v
    GROUP BY v.entity_id, v.valid_from, v.valid_to;
$$;

CREATE OR REPLACE FUNCTION golden_master.apply_expression_batch(p_job_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_source UUID;
    v_rank INTEGER;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_ts TIMESTAMPTZ := clock_timestamp();
    v_changed INTEGER := 0;
BEGIN
    IF COALESCE(cardinality(p_job_ids), 0) = 0 THEN
        RETURN 0;
    END IF;

    SELECT id, precedence_rank INTO v_source, v_rank
    FROM entity_instances.source_registry
    WHERE source_code = 'DERIVED';
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'DERIVED source is not registered';
    END IF;

    PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);

    CREATE TEMP TABLE IF NOT EXISTS calc_batch_write (
        entity_id UUID,
        attribute_id UUID,
        valid_from DATE,
        valid_to DATE,
        value NUMERIC
    ) ON COMMIT DROP;
    TRUNCATE calc_batch_write;

    INSERT INTO calc_batch_write (entity_id, attribute_id, valid_from, valid_to, value)
    WITH jobs AS (
        SELECT i.entity_id, i.calc_attribute_id, i.window_start, i.window_end
        FROM golden_master.calc_invalidations i
        WHERE i.id = ANY (p_job_ids)
          AND i.window_start <= LEAST(i.window_end, CURRENT_DATE)
    ),
    fresh AS (
        SELECT s.entity_id, j.calc_attribute_id, s.valid_from, s.valid_to, s.value
        FROM jobs j
        JOIN golden_master.expression_batch_slices(p_job_ids) s ON s.entity_id = j.entity_id
        WHERE s.value IS NOT NULL
    ),
    overlap AS (
        SELECT eav.entity_id, eav.attribute_id, eav.valid_from, eav.valid_to, eav.golden_value_numeric,
               j.window_start, j.window_end
        FROM jobs j
        JOIN golden_master.entity_attribute_values eav
          ON eav.entity_id = j.entity_id
         AND eav.attribute_id = j.calc_attribute_id
         AND eav.source_id = v_source
         AND eav.system_to = v_open
         AND eav.valid_to >= j.window_start
         AND eav.valid_from <= j.window_end
    ),
    desired AS (
        SELECT entity_id, attribute_id, valid_from, (window_start - 1) AS valid_to, golden_value_numeric AS value
        FROM overlap
        WHERE valid_from < window_start AND golden_value_numeric IS NOT NULL
        UNION ALL
        SELECT entity_id, attribute_id, (window_end + 1), valid_to, golden_value_numeric
        FROM overlap
        WHERE valid_to > window_end AND golden_value_numeric IS NOT NULL
        UNION ALL
        SELECT entity_id, calc_attribute_id, valid_from, valid_to, value FROM fresh
    ),
    current_rows AS (
        SELECT entity_id, attribute_id,
               jsonb_agg(jsonb_build_array(valid_from, valid_to, golden_value_numeric) ORDER BY valid_from, valid_to) AS signature
        FROM overlap
        GROUP BY entity_id, attribute_id
    ),
    desired_rows AS (
        SELECT entity_id, attribute_id,
               jsonb_agg(jsonb_build_array(valid_from, valid_to, value) ORDER BY valid_from, valid_to) AS signature
        FROM desired
        GROUP BY entity_id, attribute_id
    ),
    changed AS (
        SELECT COALESCE(d.entity_id, c.entity_id) AS entity_id,
               COALESCE(d.attribute_id, c.attribute_id) AS attribute_id
        FROM desired_rows d
        FULL JOIN current_rows c USING (entity_id, attribute_id)
        WHERE d.signature IS DISTINCT FROM c.signature
    )
    SELECT d.entity_id, d.attribute_id, d.valid_from, d.valid_to, d.value
    FROM desired d
    JOIN changed c ON c.entity_id = d.entity_id AND c.attribute_id = d.attribute_id;

    UPDATE golden_master.entity_attribute_values eav
    SET system_to = v_ts
    FROM golden_master.calc_invalidations i
    WHERE i.id = ANY (p_job_ids)
      AND i.window_start <= LEAST(i.window_end, CURRENT_DATE)
      AND eav.entity_id = i.entity_id
      AND eav.attribute_id = i.calc_attribute_id
      AND eav.source_id = v_source
      AND eav.system_to = v_open
      AND eav.valid_to >= i.window_start
      AND eav.valid_from <= i.window_end
      AND EXISTS (
          SELECT 1 FROM calc_batch_write w
          WHERE w.entity_id = eav.entity_id AND w.attribute_id = eav.attribute_id
      );

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
        valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
    )
    SELECT w.entity_id, w.attribute_id, v_source, w.value::TEXT, w.value,
           w.valid_from, w.valid_to, v_ts, v_open, v_rank, FALSE
    FROM calc_batch_write w;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);

    RETURN v_changed;
EXCEPTION
    WHEN OTHERS THEN
        PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
        RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.enqueue_batch_dependents(p_job_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS calc_batch_dependents (
        calc_attribute_id UUID,
        entity_id UUID,
        window_start DATE,
        window_end DATE,
        cause_entity_id UUID,
        cause_attribute_code VARCHAR(100),
        cause_valid_from DATE
    ) ON COMMIT DROP;
    TRUNCATE calc_batch_dependents;

    INSERT INTO calc_batch_dependents
    WITH incoming AS (
        SELECT cd.attribute_id AS calc_attribute_id,
               CASE
                   WHEN ci.traversal = 'SELF' OR COALESCE(cardinality(ci.relationship_codes), 0) = 0 THEN w.entity_id
                   WHEN ci.traversal = 'DOWN' THEN er.parent_entity_id
                   ELSE er.child_entity_id
               END AS entity_id,
               MIN(i.window_start) AS window_start,
               MAX(CASE WHEN cd.time_impact = 'FORWARD' THEN DATE '9999-12-31' ELSE i.window_end END) AS window_end,
               (array_agg(w.entity_id))[1] AS cause_entity_id,
               ar.attribute_code AS cause_attribute_code,
               MIN(i.window_start) AS cause_valid_from
        FROM (
            SELECT DISTINCT entity_id, attribute_id
            FROM calc_batch_write
        ) w
        JOIN golden_master.calc_invalidations i ON i.entity_id = w.entity_id AND i.id = ANY (p_job_ids)
        JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id
        JOIN metadata_register.calc_inputs ci ON ci.attribute_code = ar.attribute_code
        JOIN metadata_register.calc_definitions cd
          ON cd.id = ci.calc_definition_id
         AND cd.evaluation_mode = 'MATERIALIZED'
         AND cd.attribute_id <> w.attribute_id
        LEFT JOIN entity_instances.entity_relationships er
          ON ci.traversal <> 'SELF'
         AND COALESCE(cardinality(ci.relationship_codes), 0) = 1
         AND er.relationship_code = ci.relationship_codes[1]
         AND er.system_to = golden_master.open_system_to()
         AND er.valid_to >= i.window_start
         AND er.valid_from <= i.window_end
         AND (
              (ci.traversal = 'DOWN' AND er.child_entity_id = w.entity_id)
           OR (ci.traversal <> 'DOWN' AND er.parent_entity_id = w.entity_id)
         )
        GROUP BY cd.attribute_id, ar.attribute_code,
                 CASE
                     WHEN ci.traversal = 'SELF' OR COALESCE(cardinality(ci.relationship_codes), 0) = 0 THEN w.entity_id
                     WHEN ci.traversal = 'DOWN' THEN er.parent_entity_id
                     ELSE er.child_entity_id
                 END
    )
    SELECT calc_attribute_id, entity_id, window_start, window_end,
           cause_entity_id, cause_attribute_code, cause_valid_from
    FROM incoming
    WHERE entity_id IS NOT NULL;

    INSERT INTO golden_master.calc_invalidations (
        calc_attribute_id, entity_id, window_start, window_end,
        cause_entity_id, cause_attribute_code, cause_valid_from
    )
    SELECT d.calc_attribute_id, d.entity_id, d.window_start, d.window_end,
           d.cause_entity_id, d.cause_attribute_code, d.cause_valid_from
    FROM calc_batch_dependents d
    WHERE NOT EXISTS (
        SELECT 1 FROM golden_master.calc_invalidations existing
        WHERE existing.calc_attribute_id = d.calc_attribute_id
          AND existing.entity_id = d.entity_id
          AND existing.status = 'PENDING'
    );

    UPDATE golden_master.calc_invalidations existing
    SET window_start = LEAST(existing.window_start, d.window_start),
        window_end = GREATEST(existing.window_end, d.window_end),
        not_before = NULL,
        cause_entity_id = d.cause_entity_id,
        cause_attribute_code = d.cause_attribute_code,
        cause_valid_from = d.cause_valid_from
    FROM calc_batch_dependents d
    WHERE existing.calc_attribute_id = d.calc_attribute_id
      AND existing.entity_id = d.entity_id
      AND existing.status = 'PENDING';
END;
$$;

ALTER FUNCTION golden_master.process_calc_invalidations(INTEGER, UUID)
    RENAME TO process_calc_invalidations_each;

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
    v_ids UUID[];
    v_ready UUID[];
    v_rest JSONB;
BEGIN
    LOOP
        EXIT WHEN v_processed + v_failed >= v_limit;

        SELECT cd.id, cd.attribute_id
          INTO v_calc_id, v_attribute_id
        FROM metadata_register.calc_definitions cd
        WHERE golden_master.expression_batch_capable(cd.id)
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

        BEGIN
            IF COALESCE(cardinality(v_ready), 0) > 0 THEN
                PERFORM golden_master.apply_expression_batch(v_ready);
                PERFORM golden_master.enqueue_batch_dependents(v_ready);
            END IF;
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

REVOKE ALL ON FUNCTION golden_master.expression_batch_capable(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.expression_batch_slices(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.apply_expression_batch(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.process_calc_invalidations_each(INTEGER, UUID) FROM PUBLIC;
