-- Re-decide the golden source for many records in one call.
--
-- The API's batchResolveGoldenSources re-decided each record by touching one
-- of its rows so the trigger would run, then read the rows back: about five
-- round trips per record, re-reading the same attribute every time. This runs
-- golden_master.resolve_current_preference, the decision the triggers use, for
-- a list of records at once, and returns each record's winner.
--
-- A signed-in caller may re-resolve only records they may write; the others are
-- skipped, not reported, so the call says nothing about records they cannot see.

CREATE OR REPLACE FUNCTION golden_master.reresolve_golden_sources(p_entity_ids UUID[], p_attribute_code TEXT)
RETURNS TABLE (entity_id UUID, golden_value_id UUID, winning_source TEXT, golden_value TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, tenancy, pg_temp
AS $$
DECLARE
    v_attribute_id UUID;
    v_entity UUID;
    v_backend BOOLEAN := tenancy.is_backend_caller();
BEGIN
    SELECT ar.id INTO v_attribute_id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code;
    IF v_attribute_id IS NULL THEN
        RAISE EXCEPTION 'Attribute not found: %', p_attribute_code USING ERRCODE = 'P0002';
    END IF;
    IF cardinality(p_entity_ids) > 1000 THEN
        RAISE EXCEPTION 'Re-resolve at most 1000 records a call' USING ERRCODE = '22023';
    END IF;

    FOR v_entity IN SELECT DISTINCT e FROM unnest(COALESCE(p_entity_ids, '{}'::UUID[])) AS e LOOP
        IF NOT v_backend AND NOT COALESCE(tenancy.has_entity_access(v_entity, 'WRITE'), FALSE) THEN
            CONTINUE;
        END IF;
        PERFORM golden_master.resolve_current_preference(v_entity, v_attribute_id);
        RETURN QUERY
        SELECT v_entity, eav.id, sr.source_code::TEXT, eav.golden_value::TEXT
        FROM golden_master.entity_attribute_values eav
        LEFT JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
        WHERE eav.entity_id = v_entity
          AND eav.attribute_id = v_attribute_id
          AND eav.valid_to = DATE '9999-12-31'
          AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
          AND eav.source_id = eav.golden_source_id
        ORDER BY eav.valid_from DESC
        LIMIT 1;
    END LOOP;
END;
$$;
COMMENT ON FUNCTION golden_master.reresolve_golden_sources(UUID[], TEXT) IS
    'Re-decides the golden source of an attribute for many records at once, with resolve_current_preference, and returns each winner.';
REVOKE ALL ON FUNCTION golden_master.reresolve_golden_sources(UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.reresolve_golden_sources(UUID[], TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
