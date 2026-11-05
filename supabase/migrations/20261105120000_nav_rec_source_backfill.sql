-- NAV reconciliation reads two sources of each attribute.
-- Fund administrator figures are FUND_ADMIN. Internal figures are INTERNAL.
-- Copy the values that still sit on the test and allocation sources, and give
-- every non-benchmark fund a statement whose investments equal its positions.
-- The attribute-value trigger walks the relationship graph and overflows on this copy.

SET session_replication_role = replica;

DO $$
DECLARE
    v_internal uuid;
    v_admin uuid;
    v_internal_rank integer;
    v_admin_rank integer;
    v_template uuid;
    v_rel_name text;
BEGIN
    SELECT id, precedence_rank INTO v_internal, v_internal_rank FROM entity_instances.source_registry WHERE source_code = 'INTERNAL';
    SELECT id, precedence_rank INTO v_admin, v_admin_rank FROM entity_instances.source_registry WHERE source_code = 'FUND_ADMIN';
    SELECT id INTO v_template FROM metadata_register.domain_templates WHERE template_code = 'NAV_STATEMENT_STANDARD';
    SELECT relationship_name INTO v_rel_name FROM metadata_register.relationship_types WHERE relationship_code = 'STATEMENT_FUND';
    IF v_internal IS NULL OR v_admin IS NULL OR v_template IS NULL OR v_rel_name IS NULL THEN
        RAISE EXCEPTION 'NAV backfill is missing a source, the statement template, or STATEMENT_FUND';
    END IF;

    -- Position book and agent mark land on the internal source. The administrator mark lands on fund admin.
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, system_from, system_to, precedence_rank, metadata
    )
    SELECT eav.entity_id, eav.attribute_id, copy.target_id, eav.golden_value,
           CASE
               WHEN eav.golden_value_numeric IS NOT NULL THEN eav.golden_value_numeric
               WHEN eav.golden_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN eav.golden_value::numeric
           END, eav.golden_value_date, eav.golden_value_boolean,
           eav.valid_from, eav.valid_to, eav.system_from, eav.system_to, copy.target_rank,
           jsonb_build_object('navRecBackfill', true, 'fromSource', src.source_code)
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.master_entities me ON me.id = eav.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    JOIN entity_instances.source_registry src ON src.id = eav.source_id
    JOIN (VALUES
        ('POSITION', 'MARKET_VALUE', 'INTERNAL'),
        ('POSITION', 'ACCRUED_CASH_INTEREST_AMOUNT', 'INTERNAL'),
        ('POSITION', 'UNREALIZED_GAIN_LOSS', 'INTERNAL'),
        ('POSITION', 'POSITION_STRATEGY', 'INTERNAL'),
        ('POSITION', 'POSITION_AGENT_MARK', 'INTERNAL'),
        ('POSITION', 'POSITION_MARK', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_PURCHASES', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_REPAYMENTS', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_SALES', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_PIK', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_AMORTIZATION', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_UNREALIZED_CHANGE', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_REALIZED_GAIN', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_END_FV', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_INTEREST_EARNED', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_FEE_INCOME', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_END_ACCRUED', 'FUND_ADMIN'),
        ('POSITION_ROLL', 'ROLL_OUR_ACCRUED', 'INTERNAL'),
        ('FUND', 'FUND_STRATEGY', 'INTERNAL'),
        ('FUND', 'FUND_TOTAL_COMMITMENTS', 'INTERNAL'),
        ('FUND', 'FUND_NET_IRR', 'INTERNAL'),
        ('FUND', 'FUND_CLOSE_FREQUENCY', 'INTERNAL'),
        ('FUND', 'FUND_CLOSE_LAG_DAYS', 'INTERNAL'),
        ('FUND', 'FUND_MGMT_FEE_RATE_PCT', 'INTERNAL'),
        ('FUND', 'FUND_PREF_RETURN_PCT', 'INTERNAL'),
        ('FUND', 'FUND_CARRY_PCT', 'INTERNAL'),
        ('FUND', 'FUND_CATCH_UP_PCT', 'INTERNAL'),
        ('REC_EVIDENCE', 'EVIDENCE_KIND', 'FUND_ADMIN'),
        ('REC_EVIDENCE', 'EVIDENCE_DATE', 'FUND_ADMIN'),
        ('REC_EVIDENCE', 'EVIDENCE_AMOUNT', 'FUND_ADMIN'),
        ('REC_EVIDENCE', 'EVIDENCE_SOURCE', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_PERIOD_END', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_PERIOD_END', 'INTERNAL'),
        ('NAV_STATEMENT', 'STATEMENT_PERIOD_LABEL', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_PERIOD_LABEL', 'INTERNAL'),
        ('NAV_STATEMENT', 'STATEMENT_TOLERANCE_PCT', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_TOLERANCE_PCT', 'INTERNAL'),
        ('NAV_STATEMENT', 'STATEMENT_CERTIFIED', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_CERTIFIED', 'INTERNAL'),
        ('NAV_STATEMENT', 'STATEMENT_RECEIVED_DATE', 'FUND_ADMIN'),
        ('NAV_STATEMENT', 'STATEMENT_RECEIVED_DATE', 'INTERNAL')
    ) AS spec(domain_code, attribute_code, target_code)
      ON spec.domain_code = me.domain_code AND spec.attribute_code = ar.attribute_code
    JOIN LATERAL (
        SELECT CASE WHEN spec.target_code = 'INTERNAL' THEN v_internal ELSE v_admin END AS target_id,
               CASE WHEN spec.target_code = 'INTERNAL' THEN v_internal_rank ELSE v_admin_rank END AS target_rank
    ) AS copy ON TRUE
    WHERE me.entity_code NOT LIKE 'BENCH-%'
      AND src.source_code NOT IN ('INTERNAL', 'FUND_ADMIN', 'MANUAL')
      AND eav.system_to >= NOW()
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values have
          WHERE have.entity_id = eav.entity_id
            AND have.attribute_id = eav.attribute_id
            AND have.source_id = copy.target_id
            AND have.valid_from = eav.valid_from
            AND have.valid_to = eav.valid_to
            AND have.system_to >= NOW()
      );

    -- A statement line that only has the administrator amount gets the same window on the internal source.
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, system_from, system_to, precedence_rank, metadata
    )
    SELECT eav.entity_id, eav.attribute_id, v_internal, eav.golden_value,
           CASE
               WHEN eav.golden_value_numeric IS NOT NULL THEN eav.golden_value_numeric
               WHEN eav.golden_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN eav.golden_value::numeric
           END, eav.golden_value_date, eav.golden_value_boolean,
           eav.valid_from, eav.valid_to, eav.system_from, eav.system_to, v_internal_rank,
           '{"navRecBackfill":true,"fromSource":"FUND_ADMIN"}'::jsonb
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.master_entities me ON me.id = eav.entity_id AND me.domain_code = 'NAV_STATEMENT'
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    JOIN entity_instances.source_registry src ON src.id = eav.source_id AND src.source_code = 'FUND_ADMIN'
    WHERE ar.validation_rules ? 'navLine'
      AND eav.system_to >= NOW()
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values have
          JOIN entity_instances.source_registry hs ON hs.id = have.source_id AND hs.source_code = 'INTERNAL'
          WHERE have.entity_id = eav.entity_id
            AND have.attribute_id = eav.attribute_id
            AND have.system_to >= NOW()
      );

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT f.entity_code || '-STMT', 'NAV_STATEMENT', v_template,
           f.entity_name || ' NAV statement',
           'NAV statement backfilled from the fund''s positions.',
           f.client_id, '{"navRecBackfill":true}'::jsonb
    FROM entity_instances.master_entities f
    WHERE f.domain_code = 'FUND'
      AND f.is_active
      AND f.entity_code NOT LIKE 'BENCH-%'
      AND NOT EXISTS (
          SELECT 1 FROM entity_instances.entity_relationships r
          JOIN entity_instances.master_entities s ON s.id = r.parent_entity_id AND s.domain_code = 'NAV_STATEMENT'
          WHERE r.child_entity_id = f.id AND r.relationship_code = 'STATEMENT_FUND'
      )
    ON CONFLICT (entity_code) DO UPDATE
    SET is_active = TRUE,
        template_id = EXCLUDED.template_id,
        client_id = EXCLUDED.client_id;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT stmt.id, f.id, v_rel_name, 'STATEMENT_FUND', TRUE, DATE '2020-01-01'
    FROM entity_instances.master_entities f
    JOIN entity_instances.master_entities stmt ON stmt.entity_code = f.entity_code || '-STMT' AND stmt.domain_code = 'NAV_STATEMENT'
    WHERE f.domain_code = 'FUND' AND f.entity_code NOT LIKE 'BENCH-%'
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;

    -- Close calendar for funds that have never had one, so the reconciliation board can open them.
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT f.id, ar.id, v_internal, payload.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN payload.val::numeric END,
           DATE '2020-01-01', DATE '9999-12-31', v_internal_rank,
           '{"navRecBackfill":true}'::jsonb
    FROM entity_instances.master_entities f
    CROSS JOIN (VALUES
        ('FUND_CLOSE_FREQUENCY', 'QUARTERLY'),
        ('FUND_CLOSE_LAG_DAYS', '37')
    ) AS payload(attribute_code, val)
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = payload.attribute_code
    WHERE f.domain_code = 'FUND' AND f.is_active AND f.entity_code NOT LIKE 'BENCH-%'
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values have
          WHERE have.entity_id = f.id AND have.attribute_id = ar.id AND have.system_to >= NOW()
      );

    -- Investments and net assets for a new statement are the position market values in force at the period end.
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric, golden_value_date,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT stmt.id, ar.id, src.id,
           CASE WHEN ar.data_type = 'DATE' THEN payload.val ELSE payload.val END,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN payload.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN payload.val::date END,
           DATE '2020-01-01', DATE '9999-12-31', src.precedence_rank,
           '{"navRecBackfill":true}'::jsonb
    FROM entity_instances.master_entities f
    JOIN entity_instances.master_entities stmt ON stmt.entity_code = f.entity_code || '-STMT'
    JOIN entity_instances.source_registry src ON src.source_code IN ('FUND_ADMIN', 'INTERNAL')
    JOIN LATERAL (
        SELECT CASE
            WHEN EXISTS (
                SELECT 1 FROM golden_master.entity_attribute_values freq
                JOIN metadata_register.attribute_register fa ON fa.id = freq.attribute_id AND fa.attribute_code = 'FUND_CLOSE_FREQUENCY'
                WHERE freq.entity_id = f.id AND freq.golden_value = 'MONTHLY' AND freq.system_to >= NOW()
            ) THEN DATE '2026-10-31' ELSE DATE '2026-09-30' END AS period_end
    ) AS cal ON TRUE
    JOIN LATERAL (
        SELECT COALESCE(sum(mv.amount), 0) AS invested
        FROM (
            SELECT DISTINCT ON (pos.position_id)
                   CASE
                       WHEN eav.golden_value_numeric IS NOT NULL THEN eav.golden_value_numeric
                       WHEN eav.golden_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN eav.golden_value::numeric
                   END AS amount
            FROM (
                SELECT r.parent_entity_id AS position_id
                FROM entity_instances.entity_relationships r
                WHERE r.child_entity_id = f.id AND r.relationship_code = 'POSITION_FUND'
                UNION
                SELECT r.parent_entity_id
                FROM entity_instances.entity_relationships kids
                JOIN entity_instances.entity_relationships r
                  ON r.child_entity_id = kids.child_entity_id AND r.relationship_code = 'POSITION_FUND'
                WHERE kids.parent_entity_id = f.id AND kids.relationship_code = 'FUND_PARENT'
            ) AS pos
            JOIN golden_master.entity_attribute_values eav ON eav.entity_id = pos.position_id
            JOIN metadata_register.attribute_register ma ON ma.id = eav.attribute_id AND ma.attribute_code = 'MARKET_VALUE'
            JOIN entity_instances.source_registry ms ON ms.id = eav.source_id AND ms.source_code = 'INTERNAL'
            WHERE eav.valid_from <= cal.period_end AND eav.valid_to >= cal.period_end AND eav.system_to >= NOW()
            ORDER BY pos.position_id, eav.valid_from DESC
        ) AS mv
    ) AS book ON TRUE
    CROSS JOIN LATERAL (VALUES
        ('STATEMENT_PERIOD_END', to_char(cal.period_end, 'YYYY-MM-DD')),
        ('STATEMENT_PERIOD_LABEL', to_char(cal.period_end, 'FMMonth DD, YYYY')),
        ('STATEMENT_TOLERANCE_PCT', '0.5'),
        ('NAV_BS_INVESTMENTS', book.invested::text),
        ('NAV_BS_NET_ASSETS', book.invested::text)
    ) AS payload(attribute_code, val)
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = payload.attribute_code
    WHERE f.domain_code = 'FUND' AND f.entity_code NOT LIKE 'BENCH-%'
      AND stmt.metadata ->> 'navRecBackfill' = 'true'
      AND NOT EXISTS (
          SELECT 1 FROM golden_master.entity_attribute_values have
          WHERE have.entity_id = stmt.id AND have.attribute_id = ar.id AND have.source_id = src.id AND have.system_to >= NOW()
      );
END $$;

SET session_replication_role = DEFAULT;

NOTIFY pgrst, 'reload schema';
