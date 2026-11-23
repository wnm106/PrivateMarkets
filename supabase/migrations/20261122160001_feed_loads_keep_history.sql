-- Feed loads keep history.
--
-- The feed loader changed value rows in place: a corrected value overwrote
-- golden_value on the current row, and a newer period shortened valid_to on
-- the row it followed. The history guard lets the backend do that, so "what
-- did we know on date X" was rewritten for every value a feed touched.
--
-- golden_master.supersede_value does the same changes the bi-temporal way, in
-- one statement: the row stops being current knowledge (system_to = now) and a
-- copy with the change is written as current knowledge. The loader journals it
-- as VALUE_SUPERSEDE, and load_batch_revert puts the earlier row back.
-- VALUE_UPDATE and VALUE_CLOSE stay readable, so batches loaded before this
-- still revert.

ALTER TABLE entity_instances.load_batch_journal DROP CONSTRAINT IF EXISTS load_batch_journal_kind_check;
ALTER TABLE entity_instances.load_batch_journal ADD CONSTRAINT load_batch_journal_kind_check
    CHECK (kind IN ('VALUE_UPDATE', 'VALUE_CLOSE', 'VALUE_SUPERSEDE', 'LINK_CLOSE', 'RECORD_RENAME'));

-- Replaces one current value row with a changed copy, keeping the old row as
-- past knowledge. p_patch may change the value, its period end, its rank and
-- its metadata; nothing else, so who wrote it, when, and from which source stay
-- as they were. Returns the new row's id. Runs as the caller: a signed-in
-- caller is held to row security and the history guard, which allow exactly
-- this (ending a current row, writing a current one).
CREATE OR REPLACE FUNCTION golden_master.supersede_value(
    p_id UUID,
    p_patch JSONB,
    p_load_batch_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
    v_allowed CONSTANT TEXT[] := ARRAY[
        'golden_value', 'golden_value_numeric', 'golden_value_date', 'golden_value_timestamp',
        'golden_value_boolean', 'golden_value_jsonb', 'valid_to', 'precedence_rank',
        'metadata', 'last_received_at'
    ];
    v_row golden_master.entity_attribute_values;
    v_key TEXT;
BEGIN
    FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_patch, '{}'::jsonb)) LOOP
        IF NOT v_key = ANY (v_allowed) THEN
            RAISE EXCEPTION 'supersede_value cannot change %', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;

    SELECT * INTO v_row
    FROM golden_master.entity_attribute_values
    WHERE id = p_id AND system_to = v_open
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Value % is not current knowledge, so it cannot be replaced', p_id USING ERRCODE = 'P0002';
    END IF;

    UPDATE golden_master.entity_attribute_values SET system_to = now() WHERE id = p_id;

    v_row := jsonb_populate_record(v_row, p_patch);
    IF v_row.valid_to < v_row.valid_from THEN
        RAISE EXCEPTION 'A value cannot end (%) before it starts (%)', v_row.valid_to, v_row.valid_from USING ERRCODE = '22023';
    END IF;
    v_row.load_batch_id := COALESCE(p_load_batch_id, v_row.load_batch_id);
    RETURN golden_master.reassert_value(v_row);
END;
$$;
COMMENT ON FUNCTION golden_master.supersede_value(UUID, JSONB, UUID) IS
    'Replaces a current value row with a changed copy (value, period end, rank, metadata), keeping the old row as past knowledge. Used by feed loads instead of updating rows in place.';

REVOKE ALL ON FUNCTION golden_master.supersede_value(UUID, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.supersede_value(UUID, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_batch_revert(p_batch_id uuid, p_client_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'entity_instances', 'golden_master', 'pg_catalog'
AS $$
DECLARE
  v_batch entity_instances.load_batches%ROWTYPE;
  -- With the zone: without it the literal is read in the session's time zone and matches no row.
  v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
  v_now TIMESTAMPTZ := clock_timestamp();
  v_entry RECORD;
  v_old golden_master.entity_attribute_values;
  v_rows INTEGER;
  v_values_retired INTEGER := 0;
  v_values_kept INTEGER := 0;
  v_restored INTEGER := 0;
  v_not_restored INTEGER := 0;
  v_links_removed INTEGER := 0;
  v_records_deactivated INTEGER := 0;
  v_records_kept INTEGER := 0;
  v_result JSONB;
BEGIN
    -- Restoring an earlier state rewrites value rows as they were, which the
    -- row guard allows only for trusted writers. The mark lasts until this
    -- call's transaction ends. (A function-level SET of a custom setting needs
    -- a superuser, which Supabase migrations do not run as.)
    PERFORM set_config('golden_master.trusted_writer', 'on', TRUE);
    -- A signed-in caller may revert only their own client's batches, needs the
    -- permission to promote loads, and is recorded as themselves.
    IF NOT tenancy.is_backend_caller() THEN
        IF NOT COALESCE(p_client_id IN (SELECT tenancy.current_client_ids()), FALSE)
           OR NOT COALESCE(tenancy.has_permission(p_client_id, 'load.promote'), FALSE) THEN
            RAISE EXCEPTION 'Batch not found';
        END IF;
        p_user_id := auth.uid();
    END IF;
  SELECT * INTO v_batch
  FROM entity_instances.load_batches
  WHERE id = p_batch_id AND client_id = p_client_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status NOT IN ('PROMOTED', 'FAILED') THEN
    RAISE EXCEPTION 'Only a promoted batch can be reverted. This one is %.', lower(v_batch.status);
  END IF;

  -- Values a later load rewrote in place are no longer this batch's to retire.
  SELECT count(*) INTO v_values_kept
  FROM golden_master.entity_attribute_values eav
  WHERE eav.load_batch_id = p_batch_id
    AND eav.system_to = v_open
    AND EXISTS (
      SELECT 1 FROM entity_instances.load_batch_journal j
      WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
    );

  UPDATE golden_master.entity_attribute_values eav
     SET system_to = v_now
   WHERE eav.load_batch_id = p_batch_id
     AND eav.system_to = v_open
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.load_batch_journal j
       WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
     );
  GET DIAGNOSTICS v_values_retired = ROW_COUNT;

  -- Put back what was changed in place, newest change first.
  FOR v_entry IN
    SELECT * FROM entity_instances.load_batch_journal WHERE batch_id = p_batch_id ORDER BY id DESC
  LOOP
    v_rows := 0;
    IF v_entry.kind = 'VALUE_CLOSE' THEN
      UPDATE golden_master.entity_attribute_values
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'VALUE_UPDATE' THEN
      UPDATE golden_master.entity_attribute_values
         SET golden_value = v_entry.before->>'golden_value',
             golden_value_numeric = (v_entry.before->>'golden_value_numeric')::numeric,
             golden_value_date = (v_entry.before->>'golden_value_date')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND golden_value IS NOT DISTINCT FROM (v_entry.after->>'golden_value');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'VALUE_SUPERSEDE' THEN
      -- The load retired the row and wrote a replacement. The replacement carries
      -- this batch's id, so it was retired above. The row it replaced comes back
      -- as current knowledge, unless it was itself written by this batch (an
      -- intermediate step, put back by an older entry) or something written
      -- since now holds that period for that source.
      UPDATE golden_master.entity_attribute_values
         SET system_to = v_now
       WHERE id = (v_entry.after->>'replacement_id')::uuid
         AND system_to = v_open;
      SELECT * INTO v_old FROM golden_master.entity_attribute_values WHERE id = v_entry.target_id;
      IF FOUND AND v_old.load_batch_id IS DISTINCT FROM p_batch_id AND NOT EXISTS (
        SELECT 1 FROM golden_master.entity_attribute_values e
        WHERE e.entity_id = v_old.entity_id
          AND e.attribute_id = v_old.attribute_id
          AND e.source_id = v_old.source_id
          AND e.period_grain IS NOT DISTINCT FROM v_old.period_grain
          AND e.statement_basis IS NOT DISTINCT FROM v_old.statement_basis
          AND e.system_to = v_open
          AND e.valid_from <= v_old.valid_to
          AND e.valid_to >= v_old.valid_from
      ) THEN
        PERFORM golden_master.reassert_value(v_old);
        v_rows := 1;
      ELSIF FOUND AND v_old.load_batch_id = p_batch_id THEN
        -- An intermediate row: nothing to put back, and no change left behind.
        v_rows := -1;
      END IF;
    ELSIF v_entry.kind = 'LINK_CLOSE' THEN
      UPDATE entity_instances.entity_relationships
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'RECORD_RENAME' THEN
      UPDATE entity_instances.master_entities
         SET entity_name = v_entry.before->>'entity_name', updated_at = v_now
       WHERE id = v_entry.target_id
         AND entity_name = (v_entry.after->>'entity_name');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;
    IF v_rows > 0 THEN
      v_restored := v_restored + 1;
    ELSIF v_rows = 0 THEN
      v_not_restored := v_not_restored + 1;
    END IF;
  END LOOP;

  DELETE FROM entity_instances.entity_relationships WHERE load_batch_id = p_batch_id;
  GET DIAGNOSTICS v_links_removed = ROW_COUNT;

  UPDATE entity_instances.master_entities me
     SET is_active = FALSE, updated_at = v_now
   WHERE me.load_batch_id = p_batch_id
     AND me.is_active IS TRUE
     AND NOT EXISTS (
       SELECT 1 FROM golden_master.entity_attribute_values eav
       WHERE eav.entity_id = me.id AND eav.system_to = v_open
     )
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.entity_relationships er
       WHERE (er.parent_entity_id = me.id OR er.child_entity_id = me.id) AND er.system_to = v_open
     );
  GET DIAGNOSTICS v_records_deactivated = ROW_COUNT;

  SELECT count(*) INTO v_records_kept
  FROM entity_instances.master_entities me
  WHERE me.load_batch_id = p_batch_id AND me.is_active IS TRUE;

  v_result := jsonb_build_object(
    'valuesRetired', v_values_retired,
    'valuesLeft', v_values_kept,
    'changesRestored', v_restored,
    'changesLeft', v_not_restored,
    'linksRemoved', v_links_removed,
    'recordsDeactivated', v_records_deactivated,
    'recordsLeft', v_records_kept
  );

  UPDATE entity_instances.load_batches
     SET status = 'REVERTED', reverted_by = p_user_id, reverted_at = v_now, revert_result = v_result
   WHERE id = p_batch_id;

  RETURN v_result;
END;
$$;

-- The loader calls supersede_value through PostgREST.
NOTIFY pgrst, 'reload schema';
