-- Store the calculated covenant readings for each quarter end from 2024.
-- The sample writes queued every covenant; this drains those jobs covenant by
-- covenant so the queue is not left for the worker.

DO $$
DECLARE
    v_attr uuid;
    v_cov RECORD;
BEGIN
    SELECT id INTO v_attr FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_CURRENT';
    FOR v_cov IN
        SELECT id FROM entity_instances.master_entities
        WHERE domain_code = 'DEAL_COVENANT' AND is_active
        ORDER BY entity_code
    LOOP
        PERFORM golden_master.enqueue_calc(v_attr, v_cov.id, DATE '2024-01-01', DATE '9999-12-31', NULL, NULL, NULL);
        PERFORM golden_master.process_calc_invalidations(500, v_cov.id);
    END LOOP;
END $$;
