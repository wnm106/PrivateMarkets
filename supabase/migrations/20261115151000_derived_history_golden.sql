-- Calculated history was written unmarked.
--
-- write_derived_slices inserts one row per period. The preference trigger marks
-- only open rows, so every closed period of a calc on the per-job path had no
-- golden marker and read back blank as of a past date. The set-based path marks
-- its own rows and was not affected.

CREATE OR REPLACE FUNCTION golden_master.write_derived_slices(p_entity_id uuid, p_attribute_id uuid, p_slices jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_source UUID;
    v_rank INTEGER;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_ts TIMESTAMPTZ := clock_timestamp();
    v_start DATE;
    v_end DATE;
    v_before JSONB;
    v_desired JSONB := '[]'::jsonb;
    v_old RECORD;
    v_slice JSONB;
    v_value NUMERIC;
    v_text TEXT;
BEGIN
    SELECT id, precedence_rank INTO v_source, v_rank
    FROM entity_instances.source_registry
    WHERE source_code = 'DERIVED';

    IF v_source IS NULL THEN
        RAISE EXCEPTION 'DERIVED source is not registered';
    END IF;

    SELECT MIN((slice->>'valid_from')::DATE), MAX((slice->>'valid_to')::DATE)
      INTO v_start, v_end
    FROM jsonb_array_elements(COALESCE(p_slices, '[]'::jsonb)) AS slice;

    IF v_start IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(jsonb_agg(
               CASE
                   WHEN eav.golden_value_numeric IS NULL AND eav.golden_value IS NOT NULL THEN
                       jsonb_build_object('valid_from', eav.valid_from, 'valid_to', eav.valid_to, 'text', eav.golden_value)
                   ELSE
                       jsonb_build_object('valid_from', eav.valid_from, 'valid_to', eav.valid_to, 'value', eav.golden_value_numeric)
               END
               ORDER BY eav.valid_from, eav.valid_to
           ), '[]'::jsonb)
      INTO v_before
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = p_attribute_id
      AND eav.source_id = v_source
      AND eav.system_to = v_open
      AND eav.valid_to >= v_start
      AND eav.valid_from <= v_end;

    FOR v_old IN
        SELECT valid_from, valid_to, golden_value, golden_value_numeric
        FROM golden_master.entity_attribute_values
        WHERE entity_id = p_entity_id
          AND attribute_id = p_attribute_id
          AND source_id = v_source
          AND system_to = v_open
          AND valid_to >= v_start
          AND valid_from <= v_end
    LOOP
        IF v_old.valid_from < v_start AND (v_start - 1) >= v_old.valid_from THEN
            IF v_old.golden_value_numeric IS NULL AND v_old.golden_value IS NOT NULL THEN
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_old.valid_from, 'valid_to', v_start - 1, 'text', v_old.golden_value
                ));
            ELSE
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_old.valid_from, 'valid_to', v_start - 1, 'value', v_old.golden_value_numeric
                ));
            END IF;
        END IF;
        IF v_old.valid_to > v_end AND (v_end + 1) <= v_old.valid_to THEN
            IF v_old.golden_value_numeric IS NULL AND v_old.golden_value IS NOT NULL THEN
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_end + 1, 'valid_to', v_old.valid_to, 'text', v_old.golden_value
                ));
            ELSE
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_end + 1, 'valid_to', v_old.valid_to, 'value', v_old.golden_value_numeric
                ));
            END IF;
        END IF;
    END LOOP;

    FOR v_slice IN SELECT value FROM jsonb_array_elements(p_slices) LOOP
        IF jsonb_typeof(v_slice->'text') = 'string' THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', (v_slice->>'valid_from')::DATE,
                'valid_to', (v_slice->>'valid_to')::DATE,
                'text', v_slice->>'text'
            ));
        ELSIF jsonb_typeof(v_slice->'value') = 'number' THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', (v_slice->>'valid_from')::DATE,
                'valid_to', (v_slice->>'valid_to')::DATE,
                'value', (v_slice->>'value')::NUMERIC
            ));
        END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(item ORDER BY item->>'valid_from', item->>'valid_to'), '[]'::jsonb)
      INTO v_desired
    FROM jsonb_array_elements(v_desired) AS item;

    IF v_before = v_desired THEN
        RETURN FALSE;
    END IF;

    FOR v_old IN
        SELECT *
        FROM golden_master.entity_attribute_values
        WHERE entity_id = p_entity_id
          AND attribute_id = p_attribute_id
          AND source_id = v_source
          AND system_to = v_open
          AND valid_to >= v_start
          AND valid_from <= v_end
    LOOP
        UPDATE golden_master.entity_attribute_values
        SET system_to = v_ts
        WHERE id = v_old.id;

        IF v_old.valid_from < v_start AND (v_start - 1) >= v_old.valid_from THEN
            INSERT INTO golden_master.entity_attribute_values (
                entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
                valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
            ) VALUES (
                p_entity_id, p_attribute_id, v_source, v_old.golden_value, v_old.golden_value_numeric,
                v_old.valid_from, v_start - 1, v_ts, v_open, COALESCE(v_old.precedence_rank, v_rank), FALSE
            );
        END IF;

        IF v_old.valid_to > v_end AND (v_end + 1) <= v_old.valid_to THEN
            INSERT INTO golden_master.entity_attribute_values (
                entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
                valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
            ) VALUES (
                p_entity_id, p_attribute_id, v_source, v_old.golden_value, v_old.golden_value_numeric,
                v_end + 1, v_old.valid_to, v_ts, v_open, COALESCE(v_old.precedence_rank, v_rank), FALSE
            );
        END IF;
    END LOOP;

    FOR v_slice IN SELECT value FROM jsonb_array_elements(p_slices) LOOP
        IF jsonb_typeof(v_slice->'text') = 'string' THEN
            v_text := v_slice->>'text';
            v_value := NULL;
        ELSIF jsonb_typeof(v_slice->'value') = 'number' THEN
            v_value := (v_slice->>'value')::NUMERIC;
            v_text := v_value::TEXT;
        ELSE
            CONTINUE;
        END IF;
        INSERT INTO golden_master.entity_attribute_values (
            entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
            valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
        ) VALUES (
            p_entity_id, p_attribute_id, v_source, v_text, v_value,
            (v_slice->>'valid_from')::DATE, (v_slice->>'valid_to')::DATE,
            v_ts, v_open, v_rank, FALSE
        );
    END LOOP;

    -- A calculated value has one source. The preference trigger only marks open rows, so the
    -- closed periods written above are marked here. Without this, history reads back blank.
    PERFORM set_config('golden_master.resolving', '1', true);
    UPDATE golden_master.entity_attribute_values eav
    SET golden_source_id = v_source, resolved_at = now()
    WHERE eav.entity_id = p_entity_id AND eav.attribute_id = p_attribute_id AND eav.source_id = v_source
      AND eav.system_to = v_open AND eav.golden_source_id IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values other
          WHERE other.entity_id = p_entity_id AND other.attribute_id = p_attribute_id
            AND other.system_to = v_open AND other.source_id <> v_source
      );
    PERFORM set_config('golden_master.resolving', '0', true);

    RETURN TRUE;
END;
$function$;

-- Repair what is already stored: calculated rows with no marker, on a pair that has no other source.
DO $$
BEGIN
    PERFORM set_config('golden_master.resolving', '1', true);
    PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);
    UPDATE golden_master.entity_attribute_values eav
    SET golden_source_id = eav.source_id, resolved_at = now()
    FROM entity_instances.source_registry s
    WHERE s.id = eav.source_id AND s.source_code = 'DERIVED'
      AND eav.system_to = golden_master.open_system_to() AND eav.golden_source_id IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values other
          WHERE other.entity_id = eav.entity_id AND other.attribute_id = eav.attribute_id
            AND other.system_to = golden_master.open_system_to() AND other.source_id <> eav.source_id
      );
    PERFORM set_config('golden_master.resolving', '0', true);
    PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
END $$;
