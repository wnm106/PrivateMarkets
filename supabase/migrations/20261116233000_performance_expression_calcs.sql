-- The six inception-to-date returns become live expression formulas.
--
--   XIRR(FLOWS(CASHFLOW_INVESTOR_AMOUNT, CASHFLOW_DATE), CLOSE(MARKET_VALUE))
--   MOIC(FLOWS(CASHFLOW_INVESTOR_AMOUNT, CASHFLOW_DATE), CLOSE(MARKET_VALUE))
--
-- The field paths are the ones the series calc already used, copied onto
-- operand inputs. Before the series inputs are removed, every entity is
-- solved both ways for inception, year to date, and quarter to date. A
-- difference stops the migration. After that the formula is what gets read,
-- and the previously stored series results are closed.

-- 1. The same paths, as formula operands ------------------------------------

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT ci.calc_definition_id, 'OPERAND', ci.attribute_code, ci.traversal, ci.relationship_codes, ci.ordinal
FROM metadata_register.calc_inputs ci
JOIN metadata_register.calc_definitions cd ON cd.id = ci.calc_definition_id
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code IN (
    'POSITION_IRR_ITD', 'POSITION_MOIC_ITD',
    'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD',
    'DEAL_IRR_ITD', 'DEAL_MOIC_ITD'
)
  AND ci.input_role IN ('AMOUNT', 'FLOW_DATE', 'TERMINAL')
  AND cd.calc_kind = 'SERIES'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO UPDATE
SET traversal = EXCLUDED.traversal,
    relationship_codes = EXCLUDED.relationship_codes,
    ordinal = EXCLUDED.ordinal;

-- 2. Prove the formula matches the series, then switch ----------------------

DO $$
DECLARE
    v_def RECORD;
    v_entity UUID;
    v_expr JSONB;
    v_amount TEXT;
    v_date TEXT;
    v_terminal TEXT;
    v_end DATE := CURRENT_DATE;
    v_window DATE;
    v_label TEXT;
    v_old NUMERIC;
    v_new NUMERIC;
    v_checked INTEGER := 0;
    v_windows DATE[];
BEGIN
    IF golden_master.performance_window_start('QTD', DATE '2026-11-16')
       IS DISTINCT FROM golden_master.series_window_start('QTD', DATE '2026-11-16')
       OR golden_master.performance_window_start('YTD', DATE '2026-11-16')
       IS DISTINCT FROM golden_master.series_window_start('YTD', DATE '2026-11-16')
       OR golden_master.performance_window_start('MTD', DATE '2026-11-16')
       IS DISTINCT FROM golden_master.series_window_start('MTD', DATE '2026-11-16')
       OR golden_master.performance_window_start('LTM', DATE '2026-11-16')
       IS DISTINCT FROM golden_master.series_window_start('TRAILING_12M', DATE '2026-11-16') THEN
        RAISE EXCEPTION 'Performance date offsets do not match the series windows';
    END IF;

    v_windows := ARRAY[
        NULL::DATE,
        golden_master.series_window_start('YTD', v_end),
        golden_master.series_window_start('QTD', v_end)
    ];

    FOR v_def IN
        SELECT cd.id, cd.series_fn, cd.domain_code, ar.attribute_code
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        WHERE cd.calc_kind = 'SERIES'
          AND ar.attribute_code IN (
              'POSITION_IRR_ITD', 'POSITION_MOIC_ITD',
              'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD',
              'DEAL_IRR_ITD', 'DEAL_MOIC_ITD'
          )
    LOOP
        SELECT attribute_code INTO v_amount
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'AMOUNT'
        LIMIT 1;
        SELECT attribute_code INTO v_date
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'FLOW_DATE'
        LIMIT 1;
        SELECT attribute_code INTO v_terminal
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'TERMINAL'
        LIMIT 1;
        IF v_amount IS NULL OR v_date IS NULL OR v_terminal IS NULL THEN
            RAISE EXCEPTION '% is missing a series input', v_def.attribute_code;
        END IF;

        v_expr := jsonb_build_object(
            'fn', v_def.series_fn,
            'args', jsonb_build_array(
                jsonb_build_object('fn', 'FLOWS', 'args', jsonb_build_array(
                    jsonb_build_object('ref', v_amount),
                    jsonb_build_object('ref', v_date)
                )),
                jsonb_build_object('fn', 'CLOSE', 'args', jsonb_build_array(
                    jsonb_build_object('ref', v_terminal)
                ))
            )
        );

        FOR v_entity IN
            SELECT me.id
            FROM entity_instances.master_entities me
            WHERE me.domain_code = v_def.domain_code
        LOOP
            FOREACH v_window IN ARRAY v_windows LOOP
                v_label := CASE WHEN v_window IS NULL THEN 'ITD' ELSE v_window::TEXT END;
                v_old := golden_master.series_value(v_def.id, v_entity, v_window, v_end, v_def.series_fn, 0);
                v_new := golden_master.performance_formula(v_def.id, v_entity, v_expr, v_end, 0, NULL, v_window);
                v_checked := v_checked + 1;
                IF v_old IS NULL AND v_new IS NULL THEN
                    CONTINUE;
                END IF;
                IF v_old IS NULL OR v_new IS NULL OR abs(v_old - v_new) > 0.0000001 THEN
                    RAISE EXCEPTION '% on % (%) does not match: series % formula %',
                        v_def.attribute_code, v_entity, v_label, v_old, v_new;
                END IF;
            END LOOP;
        END LOOP;

        UPDATE metadata_register.calc_definitions
        SET calc_kind = 'EXPRESSION',
            evaluation_mode = 'ON_READ',
            time_impact = 'FORWARD',
            output_grain = 'ON_INPUT_CHANGE',
            expression = v_expr,
            series_fn = NULL,
            updated_at = NOW()
        WHERE id = v_def.id;
    END LOOP;

    RAISE NOTICE 'Performance formulas matched the series on % results', v_checked;
END $$;

DELETE FROM metadata_register.calc_inputs ci
USING metadata_register.calc_definitions cd, metadata_register.attribute_register ar
WHERE ci.calc_definition_id = cd.id
  AND ar.id = cd.attribute_id
  AND ar.attribute_code IN (
      'POSITION_IRR_ITD', 'POSITION_MOIC_ITD',
      'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD',
      'DEAL_IRR_ITD', 'DEAL_MOIC_ITD'
  )
  AND ci.input_role IN ('AMOUNT', 'FLOW_DATE', 'TERMINAL');

-- The stored series figures would hide the live formula. Close them.
DO $$
BEGIN
    PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);
    UPDATE golden_master.entity_attribute_values eav
    SET valid_to = CURRENT_DATE,
        system_to = now()
    FROM metadata_register.attribute_register ar, entity_instances.source_registry s
    WHERE eav.attribute_id = ar.id
      AND eav.source_id = s.id
      AND ar.attribute_code IN (
          'POSITION_IRR_ITD', 'POSITION_MOIC_ITD',
          'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD',
          'DEAL_IRR_ITD', 'DEAL_MOIC_ITD'
      )
      AND s.source_code IN ('DERIVED', 'CALCULATED')
      AND eav.system_to = golden_master.open_system_to();
END $$;

-- 3. A period return uses the formula, with the caller's start date ----------

CREATE OR REPLACE FUNCTION golden_master.period_returns(
    p_entity_ids uuid[], p_attribute_codes text[], p_start date, p_end date
)
RETURNS TABLE(entity_id uuid, attribute_code text, value numeric)
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $function$
    SELECT me.id,
           ar.attribute_code::text,
           CASE
               WHEN cd.calc_kind = 'SERIES' THEN
                   golden_master.series_value(cd.id, me.id, p_start, COALESCE(p_end, CURRENT_DATE), cd.series_fn, 0)
               ELSE
                   golden_master.performance_formula(
                       cd.id, me.id, cd.expression, COALESCE(p_end, CURRENT_DATE), 0, NULL, p_start
                   )
           END
    FROM entity_instances.master_entities me
    JOIN metadata_register.calc_definitions cd ON cd.domain_code = me.domain_code
        AND (
            cd.calc_kind = 'SERIES'
            OR (
                cd.calc_kind = 'EXPRESSION'
                AND upper(COALESCE(cd.expression->>'fn', '')) IN ('XIRR', 'MOIC')
            )
        )
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    WHERE me.id = ANY (p_entity_ids)
      AND ar.attribute_code = ANY (p_attribute_codes);
$function$;

NOTIFY pgrst, 'reload schema';
