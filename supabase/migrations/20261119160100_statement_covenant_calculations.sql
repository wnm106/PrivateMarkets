-- Store the Covenant section on every borrower statement that has a deal
-- covenant, then score the covenant rules once so the compliance pages have
-- results today.
--
-- First, the sample first-test dates are realigned. They were set from close
-- dates that have since moved, so every sample covenant tested first in 2027
-- although the deals closed between 2023 and 2026. A first test is now the
-- first quarter end at least three months after the deal's target close.
-- Halyard's net leverage steps down from 4.00x to 3.25x for quarters from 2026.

DO $$
DECLARE
    v_statement uuid;
    v_rule text;
    v_test uuid;
    v_first uuid;
    v_level uuid;
BEGIN
    SELECT id INTO v_test FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    SELECT id INTO v_first FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_FIRST_TEST';
    SELECT id INTO v_level FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_LEVEL';

    CREATE TEMP TABLE t_first ON COMMIT DROP AS
    SELECT c.id AS covenant_id,
           (date_trunc('quarter', golden_master.golden_date(d.id, 'DEAL_TARGET_CLOSE_DATE'::varchar, CURRENT_DATE) + INTERVAL '3 months')
               + INTERVAL '3 months' - INTERVAL '1 day')::date AS first_test
    FROM entity_instances.master_entities c
    JOIN entity_instances.entity_relationships r ON r.parent_entity_id = c.id AND r.relationship_code = 'COVENANT_DEAL'
    JOIN entity_instances.master_entities d ON d.id = r.child_entity_id
    WHERE c.domain_code = 'DEAL_COVENANT'
      AND c.entity_code LIKE 'HALY-COV-%'
      AND golden_master.golden_date(d.id, 'DEAL_TARGET_CLOSE_DATE'::varchar, CURRENT_DATE) IS NOT NULL;

    IF v_test IS NOT NULL AND EXISTS (SELECT 1 FROM t_first) THEN
        DELETE FROM golden_master.entity_attribute_values eav
        USING t_first f
        WHERE eav.entity_id = f.covenant_id AND eav.attribute_id = v_first;

        INSERT INTO golden_master.entity_attribute_values (
            entity_id, attribute_id, source_id, golden_value, golden_value_date,
            valid_from, valid_to, precedence_rank, metadata
        )
        SELECT f.covenant_id, v_first, v_test, f.first_test::text, f.first_test,
               DATE '2020-01-01', DATE '9999-12-31', 100, '{"covenantSample":true}'::jsonb
        FROM t_first f;

        DELETE FROM golden_master.entity_attribute_values eav
        USING entity_instances.master_entities me
        WHERE me.entity_code = 'HALY-COV-HALYARD-1'
          AND eav.entity_id = me.id
          AND eav.attribute_id = v_level;

        INSERT INTO golden_master.entity_attribute_values (
            entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
            valid_from, valid_to, precedence_rank, metadata
        )
        SELECT me.id, v_level, v_test, s.level::text, s.level, s.valid_from, s.valid_to, 100, '{"covenantSample":true}'::jsonb
        FROM entity_instances.master_entities me
        CROSS JOIN (VALUES
            (4.00::numeric, DATE '2020-01-01', DATE '2025-12-31'),
            (3.25::numeric, DATE '2026-01-01', DATE '9999-12-31')
        ) AS s(level, valid_from, valid_to)
        WHERE me.entity_code = 'HALY-COV-HALYARD-1';
    END IF;

    FOR v_statement IN
        SELECT DISTINCT s.id
        FROM entity_instances.master_entities c
        CROSS JOIN LATERAL unnest(golden_master.related_ids(
            c.id, 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], CURRENT_DATE
        )) AS s(id)
        WHERE c.domain_code = 'DEAL_COVENANT' AND c.is_active
    LOOP
        PERFORM golden_master.refresh_statement_covenants(v_statement);
    END LOOP;

    FOREACH v_rule IN ARRAY ARRAY['COV_NET_LEVERAGE', 'COV_TOTAL_LEVERAGE', 'COV_INTEREST_COVERAGE', 'COV_FIXED_CHARGE', 'COV_LIQUIDITY'] LOOP
        -- Knowledge time is now, not the start of this transaction, so the
        -- values written above are seen.
        PERFORM compliance.evaluate_rule(v_rule, CURRENT_DATE, clock_timestamp());
    END LOOP;
END $$;
