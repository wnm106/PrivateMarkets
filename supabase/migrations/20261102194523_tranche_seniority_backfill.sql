-- The memo showed a seniority phrase for every tranche even when TRANCHE_SENIORITY
-- was never stored. Persist that phrase so the attribute the cell is bound to has a value.

DO $$
DECLARE
    v_src uuid;
BEGIN
    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_src IS NULL THEN
        RAISE NOTICE 'Skipping tranche seniority backfill: no source';
        RETURN;
    END IF;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT tr.id,
           ar.id,
           v_src,
           CASE
               WHEN lower(coalesce(eq.golden_value, '')) IN ('true', 't', '1') THEN 'Equity-linked'
               WHEN inst.golden_value = 'SECOND_LIEN_LOAN' THEN '2nd lien'
               WHEN inst.golden_value = 'MEZZANINE' THEN 'Subordinated'
               WHEN inst.golden_value IN ('WARRANT', 'PREFERRED_EQUITY') THEN 'Equity-linked'
               ELSE '1st lien senior secured'
           END,
           DATE '2020-01-01',
           DATE '9999-12-31',
           100,
           '{"trancheSeniorityBackfill":true}'::jsonb
    FROM entity_instances.master_entities tr
    JOIN metadata_register.attribute_register ar
      ON ar.attribute_code = 'TRANCHE_SENIORITY'
    LEFT JOIN LATERAL (
        SELECT child_entity_id
        FROM entity_instances.entity_relationships rel
        WHERE rel.parent_entity_id = tr.id
          AND rel.relationship_code = 'TRANCHE_SECURITY'
          AND (rel.system_to IS NULL OR rel.system_to >= TIMESTAMP '9999-01-01')
        ORDER BY rel.is_primary DESC NULLS LAST, rel.valid_from
        LIMIT 1
    ) sec ON TRUE
    LEFT JOIN LATERAL (
        SELECT e.golden_value
        FROM golden_master.entity_attribute_values e
        JOIN metadata_register.attribute_register a ON a.id = e.attribute_id
        WHERE e.entity_id = sec.child_entity_id
          AND a.attribute_code = 'INSTRUMENT_TYPE'
          AND (e.system_to IS NULL OR e.system_to >= TIMESTAMP '9999-01-01')
          AND e.valid_to >= DATE '9999-01-01'
        ORDER BY e.valid_from DESC
        LIMIT 1
    ) inst ON TRUE
    LEFT JOIN LATERAL (
        SELECT e.golden_value
        FROM golden_master.entity_attribute_values e
        JOIN metadata_register.attribute_register a ON a.id = e.attribute_id
        WHERE e.entity_id = tr.id
          AND a.attribute_code = 'TRANCHE_IS_EQUITY_LINKED'
          AND (e.system_to IS NULL OR e.system_to >= TIMESTAMP '9999-01-01')
          AND e.valid_to >= DATE '9999-01-01'
        ORDER BY e.valid_from DESC
        LIMIT 1
    ) eq ON TRUE
    WHERE tr.domain_code = 'DEAL_TRANCHE'
      AND coalesce(tr.is_active, TRUE)
      AND NOT EXISTS (
          SELECT 1
          FROM golden_master.entity_attribute_values have
          WHERE have.entity_id = tr.id
            AND have.attribute_id = ar.id
            AND (have.system_to IS NULL OR have.system_to >= TIMESTAMP '9999-01-01')
            AND have.valid_to >= DATE '9999-01-01'
      );
END $$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261102194523', 'tranche_seniority_backfill'
WHERE NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261102194523'
);

NOTIFY pgrst, 'reload schema';
