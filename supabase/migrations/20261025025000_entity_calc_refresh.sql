-- Refresh calculated attributes for one entity. A save must not drain the
-- shared queue: that queue can hold a market-value job for every position,
-- and processing it in the save request hits the statement timeout.

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
    v_pending INTEGER;
    v_job golden_master.calc_invalidations%ROWTYPE;
    v_calc_id UUID;
    v_slices JSONB;
    v_row RECORD;
    v_value NUMERIC;
    v_changed BOOLEAN;
    v_next DATE;
BEGIN
    LOOP
        EXIT WHEN v_processed + v_failed >= v_limit;

        SELECT i.* INTO v_job
        FROM golden_master.calc_invalidations i
        WHERE i.status = 'PENDING'
          AND (i.not_before IS NULL OR i.not_before <= CURRENT_DATE)
          AND (p_entity_id IS NULL OR i.entity_id = p_entity_id)
        ORDER BY golden_master.calc_depth(i.calc_attribute_id), i.window_start, i.enqueued_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        EXIT WHEN NOT FOUND;

        UPDATE golden_master.calc_invalidations
        SET status = 'RUNNING', started_at = clock_timestamp(), last_error = NULL
        WHERE id = v_job.id;

        BEGIN
            SELECT id INTO v_calc_id
            FROM metadata_register.calc_definitions
            WHERE attribute_id = v_job.calc_attribute_id
              AND evaluation_mode = 'MATERIALIZED';

            IF v_calc_id IS NULL THEN
                UPDATE golden_master.calc_invalidations
                SET status = 'DONE', finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_processed := v_processed + 1;
                CONTINUE;
            END IF;

            v_slices := '[]'::jsonb;
            FOR v_row IN
                SELECT * FROM golden_master.calc_output_dates(
                    v_calc_id, v_job.entity_id, v_job.window_start, v_job.window_end
                )
            LOOP
                v_value := golden_master.eval_calc(v_calc_id, v_job.entity_id, v_row.as_of, 0);
                v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_row.as_of,
                    'valid_to', v_row.valid_to,
                    'value', v_value
                ));
            END LOOP;

            IF jsonb_array_length(v_slices) = 0 THEN
                v_next := golden_master.next_calc_date(v_calc_id, v_job.window_start);
                IF v_next IS NOT NULL AND v_next > CURRENT_DATE AND v_job.window_end >= v_next THEN
                    UPDATE golden_master.calc_invalidations
                    SET status = 'PENDING', not_before = v_next, started_at = NULL
                    WHERE id = v_job.id;
                    CONTINUE;
                END IF;
                UPDATE golden_master.calc_invalidations
                SET status = 'DONE', finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_processed := v_processed + 1;
                CONTINUE;
            END IF;

            PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);
            v_changed := golden_master.write_derived_slices(v_job.entity_id, v_job.calc_attribute_id, v_slices);
            PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);

            IF v_changed THEN
                PERFORM golden_master.enqueue_for_attribute_change(
                    v_job.entity_id, v_job.calc_attribute_id, v_job.window_start, v_job.window_end
                );
            END IF;

            UPDATE golden_master.calc_invalidations
            SET status = 'DONE', finished_at = clock_timestamp()
            WHERE id = v_job.id;
            v_processed := v_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
                UPDATE golden_master.calc_invalidations
                SET status = 'FAILED', last_error = SQLERRM, finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_failed := v_failed + 1;
        END;
    END LOOP;

    SELECT COUNT(*) INTO v_pending
    FROM golden_master.calc_invalidations
    WHERE status IN ('PENDING', 'RUNNING')
      AND (p_entity_id IS NULL OR entity_id = p_entity_id);

    RETURN jsonb_build_object(
        'processed', v_processed,
        'failed', v_failed,
        'pending', v_pending
    );
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.process_calc_invalidations(p_limit INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = golden_master, public, pg_temp
AS $$
    SELECT golden_master.process_calc_invalidations(p_limit, NULL::uuid);
$$;

CREATE OR REPLACE FUNCTION public.process_entity_calculated_attributes(
    p_entity_id UUID,
    p_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = golden_master, public, pg_temp
AS $$
    SELECT golden_master.process_calc_invalidations(COALESCE(p_limit, 20), p_entity_id);
$$;

REVOKE ALL ON FUNCTION golden_master.process_calc_invalidations(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_entity_calculated_attributes(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_entity_calculated_attributes(UUID, INTEGER) TO authenticated, service_role;
