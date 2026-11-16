-- A value written in a multi-row statement lost its golden source.
--
-- assign_golden_preference set a transaction flag on the first row and only
-- stamp_sibling_preference cleared it. Row-level AFTER triggers run at the end
-- of the statement, so every later row in the same statement saw the flag and
-- skipped the decision. Bulk loads left golden_source_id null on all rows but
-- the first.
--
-- Calculations read a value only when its source is the golden source, so
-- materialized calcs over bulk-loaded inputs wrote nothing: deal facility size
-- and target hold, fund gross asset value, fund IRR.
--
-- The flag now covers only the sibling update that needs it. Existing rows are
-- repaired, and the calcs that read them are queued and run.

-- ============================================================
-- 1. Triggers
-- ============================================================

CREATE OR REPLACE FUNCTION golden_master.assign_golden_preference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'golden_master', 'entity_instances', 'metadata_register', 'pg_temp'
AS $function$
DECLARE
  v_winner uuid;
  v_tier text;
  v_open boolean;
BEGIN
  -- Set while a sibling update or resolve_current_preference stamps rows itself.
  IF current_setting('golden_master.resolving', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_open := NEW.valid_to = DATE '9999-12-31'
    AND NEW.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00';

  SELECT decision.winner, decision.tier
    INTO v_winner, v_tier
  FROM golden_master.preference_decision(
    NEW.entity_id, NEW.attribute_id, NEW.id, NEW.source_id, NEW.golden_value, v_open
  ) AS decision;

  NEW.golden_source_id := v_winner;
  NEW.resolution_rule_applied := v_tier;
  NEW.resolved_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.stamp_sibling_preference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'golden_master', 'entity_instances', 'metadata_register', 'pg_temp'
AS $function$
BEGIN
  IF current_setting('golden_master.resolving', true) = '1' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('golden_master.resolving', '1', true);
  UPDATE golden_master.entity_attribute_values eav
  SET golden_source_id = NEW.golden_source_id,
      resolution_rule_applied = NEW.resolution_rule_applied,
      resolved_at = NEW.resolved_at
  WHERE eav.entity_id = NEW.entity_id
    AND eav.attribute_id = NEW.attribute_id
    AND eav.id <> NEW.id
    AND eav.valid_to = DATE '9999-12-31'
    AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
    AND (
      eav.golden_source_id IS DISTINCT FROM NEW.golden_source_id
      OR eav.resolution_rule_applied IS DISTINCT FROM NEW.resolution_rule_applied
    );
  PERFORM set_config('golden_master.resolving', '0', true);

  IF TG_OP = 'UPDATE' AND (OLD.entity_id IS DISTINCT FROM NEW.entity_id OR OLD.attribute_id IS DISTINCT FROM NEW.attribute_id) THEN
    PERFORM golden_master.resolve_current_preference(OLD.entity_id, OLD.attribute_id);
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('golden_master.resolving', '0', true);
    RAISE;
END;
$function$;

-- ============================================================
-- 2. Repair existing rows
-- ============================================================

DO $$
DECLARE
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_pair RECORD;
BEGIN
    -- Current rows: the same decision the trigger would have made.
    FOR v_pair IN
        SELECT DISTINCT entity_id, attribute_id
        FROM golden_master.entity_attribute_values
        WHERE system_to = v_open
          AND valid_to = DATE '9999-12-31'
          AND golden_source_id IS NULL
    LOOP
        PERFORM golden_master.resolve_current_preference(v_pair.entity_id, v_pair.attribute_id);
    END LOOP;

    -- History rows. The current winner of the pair applies. A pair with no
    -- current row takes its own source when it only ever had one. A pair with
    -- several sources and no current row stays unmarked.
    PERFORM set_config('golden_master.resolving', '1', true);
    PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);

    CREATE TEMP TABLE repaired_history ON COMMIT DROP AS
    WITH pairs AS (
        SELECT entity_id, attribute_id,
               (array_agg(DISTINCT golden_source_id) FILTER (
                   WHERE valid_to = DATE '9999-12-31' AND golden_source_id IS NOT NULL))[1] AS current_winner,
               count(DISTINCT source_id) AS sources,
               (array_agg(DISTINCT source_id))[1] AS only_source
        FROM golden_master.entity_attribute_values
        WHERE system_to = v_open
        GROUP BY entity_id, attribute_id
    ), marked AS (
        UPDATE golden_master.entity_attribute_values eav
        SET golden_source_id = COALESCE(p.current_winner, p.only_source),
            resolution_rule_applied = COALESCE(eav.resolution_rule_applied, 'BACKFILL'),
            resolved_at = now()
        FROM pairs p
        WHERE p.entity_id = eav.entity_id
          AND p.attribute_id = eav.attribute_id
          AND eav.system_to = v_open
          AND eav.valid_to <> DATE '9999-12-31'
          AND eav.golden_source_id IS NULL
          AND (p.current_winner IS NOT NULL OR p.sources = 1)
        RETURNING eav.entity_id, eav.attribute_id, eav.valid_from
    )
    SELECT entity_id, attribute_id, MIN(valid_from)::DATE AS starts
    FROM marked
    GROUP BY entity_id, attribute_id;

    PERFORM set_config('golden_master.resolving', '0', true);
    PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);

    -- One queue entry per repaired pair, not one per history row.
    FOR v_pair IN
        SELECT r.entity_id, r.attribute_id, r.starts
        FROM repaired_history r
        JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
        WHERE EXISTS (
            SELECT 1
            FROM metadata_register.calc_inputs ci
            JOIN metadata_register.calc_definitions cd ON cd.id = ci.calc_definition_id
            WHERE ci.attribute_code = ar.attribute_code
              AND cd.evaluation_mode = 'MATERIALIZED'
        )
    LOOP
        PERFORM golden_master.enqueue_for_attribute_change(
            v_pair.entity_id, v_pair.attribute_id, v_pair.starts, DATE '9999-12-31'
        );
    END LOOP;
EXCEPTION
    WHEN OTHERS THEN
        PERFORM set_config('golden_master.resolving', '0', true);
        PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
        RAISE;
END;
$$;

-- ============================================================
-- 3. Batch slice functions
-- ============================================================

-- The batch functions return a column named valid_to and also select an
-- unqualified valid_to, so every period aggregate failed with "column reference
-- valid_to is ambiguous". Fund gross asset value never ran. The column wins.

DO $$
DECLARE
    v_fn RECORD;
    v_def TEXT;
BEGIN
    FOR v_fn IN
        SELECT p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'golden_master'
          AND l.lanname = 'plpgsql'
          AND p.proname IN ('aggregate_batch_slices', 'series_batch_slices', 'expression_batch_slices')
    LOOP
        v_def := pg_get_functiondef(v_fn.oid);
        IF position('#variable_conflict' IN v_def) = 0 THEN
            v_def := replace(v_def, 'AS $function$', E'AS $function$\n#variable_conflict use_column');
            EXECUTE v_def;
        END IF;
    END LOOP;
END;
$$;

-- Jobs that failed on that error run again.
UPDATE golden_master.calc_invalidations
SET status = 'PENDING', last_error = NULL, started_at = NULL, finished_at = NULL
WHERE status = 'FAILED'
  AND last_error LIKE '%is ambiguous%';

-- ============================================================
-- 4. Run the queued calculations
-- ============================================================

DO $$
DECLARE
    v_result JSONB;
    v_round INTEGER := 0;
BEGIN
    LOOP
        v_round := v_round + 1;
        v_result := golden_master.process_calc_invalidations(2000);
        EXIT WHEN COALESCE((v_result->>'pending')::INTEGER, 0) = 0
               OR COALESCE((v_result->>'processed')::INTEGER, 0) = 0
               OR v_round >= 50;
    END LOOP;
END;
$$;
