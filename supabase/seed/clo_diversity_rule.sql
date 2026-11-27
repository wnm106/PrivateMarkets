-- CLO rule library: the Moody's diversity score test. Safe to run again.
--
-- CLO_DIVERSITY holds a CLO's performing collateral to the indenture's minimum
-- Moody's diversity score (CLO_MIN_DIVERSITY_SCORE on its CLO transaction). It
-- is scored by the compliance engine through the DIVERSITY term kind
-- (supabase/migrations/20261127130000_clo_diversity_term.sql), so it has a
-- status, history, pre-trade maintain-or-improve and capacity like every other
-- CLO test.
--
-- What it writes:
--   * the MOODYS_DIVERSITY_TABLE reference list: the classic Moody's industry
--     diversity table, 0 to 10 aggregate industry equivalent units. Replace the
--     rows with your indenture's table where it differs; values between rows
--     are interpolated, and above the last row the last score holds.
--   * the shared rule CLO_DIVERSITY, its version, its two lines (the score of
--     performing holdings, and the minimum read from the CLO transaction) and
--     its conditions (a fund with a CLO transaction; holdings not defaulted)
--   * enrollment: every fund enrolled in the CLO WARF test gets a blank row for
--     this test too, so it is scored at its own indenture minimum

DO $$
DECLARE
    v_rule UUID;
    v_version UUID;
    v_line UUID;
BEGIN
    -- ---------- the diversity table ----------
    INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
    VALUES ('MOODYS_DIVERSITY_TABLE', 'Moody''s Diversity Table', NULL,
            'Moody''s industry diversity table. Each row maps an aggregate industry equivalent unit score (metadata units) to an industry diversity score (metadata score). Values between rows are interpolated; above the last row the last score holds. Replace the rows with your indenture''s table.')
    ON CONFLICT (list_code) DO UPDATE SET list_name = EXCLUDED.list_name, description = EXCLUDED.description;

    INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms, metadata)
    SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb, v.meta::jsonb
    FROM metadata_register.reference_lists rl
    JOIN (VALUES
        ('U00', '0 units', 0, '{"units":0,"score":0}'),
        ('U01', '1 unit', 1, '{"units":1,"score":1.00}'),
        ('U02', '2 units', 2, '{"units":2,"score":1.50}'),
        ('U03', '3 units', 3, '{"units":3,"score":2.00}'),
        ('U04', '4 units', 4, '{"units":4,"score":2.33}'),
        ('U05', '5 units', 5, '{"units":5,"score":2.67}'),
        ('U06', '6 units', 6, '{"units":6,"score":3.00}'),
        ('U07', '7 units', 7, '{"units":7,"score":3.25}'),
        ('U08', '8 units', 8, '{"units":8,"score":3.50}'),
        ('U09', '9 units', 9, '{"units":9,"score":3.75}'),
        ('U10', '10 units', 10, '{"units":10,"score":4.00}')
    ) AS v(code, label, ord, meta) ON rl.list_code = 'MOODYS_DIVERSITY_TABLE'
    ON CONFLICT (list_id, value_code) DO UPDATE SET value_label = EXCLUDED.value_label, display_order = EXCLUDED.display_order, metadata = EXCLUDED.metadata;

    -- ---------- the rule ----------
    SELECT id INTO v_rule FROM compliance.rules WHERE rule_code = 'CLO_DIVERSITY' AND client_id IS NULL;
    IF v_rule IS NULL THEN
        INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description, metadata)
        VALUES ('CLO_DIVERSITY', 'Moody''s Diversity Score', 'COLLATERAL_QUALITY', 'FUND', TRUE, TRUE, '', '{"family":"CLO"}'::jsonb)
        RETURNING id INTO v_rule;
    END IF;
    UPDATE compliance.rules
    SET rule_name = 'Moody''s Diversity Score', rule_category = 'COLLATERAL_QUALITY', is_active = TRUE, applies_to_all = TRUE,
        description = 'Moody''s diversity score of performing obligations: par by obligor group, each obligor counted as up to one unit against the average obligor par, each industry''s units through the Moody''s diversity table, summed. The minimum is the CLO transaction''s minimum diversity score.',
        metadata = COALESCE(metadata, '{}'::jsonb) || '{"family":"CLO"}'::jsonb
    WHERE id = v_rule;

    SELECT id INTO v_version FROM compliance.rule_versions WHERE rule_id = v_rule AND version_number = 1;
    IF v_version IS NULL THEN
        INSERT INTO compliance.rule_versions (
            rule_id, version_number, valid_from, rule_name, description, base_domain_code,
            numerator_attribute_code, numerator_aggregation, denominator_scope, denominator_source,
            limit_direction, result_unit, metadata, is_active)
        VALUES (v_rule, 1, DATE '2020-01-01', 'Moody''s Diversity Score',
                'Moody''s diversity score of performing obligations, against the CLO transaction''s minimum.', 'POSITION',
                'FUNDED_PAR_AMOUNT', 'SUM', 'SAME_GROUP', 'BASE',
                'MIN', 'RATIO', '{"pre_trade":true,"scenario_mode":"strict"}'::jsonb, TRUE)
        RETURNING id INTO v_version;
    END IF;

    -- Lines and conditions are rewritten each run.
    DELETE FROM compliance.rule_conditions WHERE rule_version_id = v_version;
    DELETE FROM compliance.rule_measure_lines WHERE rule_version_id = v_version;

    INSERT INTO compliance.rule_measure_lines (rule_version_id, side, line_order, label, kind, attribute_code, path, weight_attribute_code, value_path, required)
    VALUES (v_version, 'NUMERATOR', 1, 'Diversity score of performing obligations', 'DIVERSITY', 'MOODYS_INDUSTRY_CODE',
            '[{"direction":"UP","recursive":false,"relationship_code":"POSITION_FUND"}]'::jsonb, 'FUNDED_PAR_AMOUNT',
            '[{"direction":"DOWN","recursive":false,"relationship_code":"POSITION_SECURITY"},{"direction":"DOWN","recursive":false,"relationship_code":"SECURITY_ISSUER"}]'::jsonb,
            TRUE)
    RETURNING id INTO v_line;
    INSERT INTO compliance.rule_measure_lines (rule_version_id, side, line_order, kind, attribute_code, path)
    VALUES (v_version, 'LIMIT', 1, 'MAX', 'CLO_MIN_DIVERSITY_SCORE',
            '[{"direction":"DOWN","recursive":false,"relationship_code":"FUND_CLO_TRANSACTION"}]'::jsonb);

    INSERT INTO compliance.rule_conditions (rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, value, logic_operator, attribute_dimension, filter_role, measure_line_id)
    VALUES
        (v_version, 'ANCHOR', 1, 1, 'CLO_CLOSING_DATE', 'is_not_null', NULL, 'AND',
         '{"relationship_path":[{"direction":"DOWN","recursive":false,"relationship_code":"FUND_CLO_TRANSACTION"}]}'::jsonb, 'WHERE', NULL),
        (v_version, 'LINE', 1, 1, 'IS_DEFAULTED', 'not_equals', 'true', 'AND',
         '{"relationship_path":[{"direction":"DOWN","recursive":false,"relationship_code":"POSITION_SECURITY"}]}'::jsonb, 'WHERE', v_line);

    -- ---------- enrollment ----------
    -- Every fund scored on the CLO WARF test is scored on this one too, at its own minimum (a blank row).
    INSERT INTO compliance.rule_thresholds (rule_id, entity_id, hard_limit_value, limit_direction, applies, notes)
    SELECT DISTINCT v_rule, t.entity_id, NULL::NUMERIC, 'MIN', TRUE, 'CLO library: scored with the other CLO tests'
    FROM compliance.rule_thresholds t
    JOIN compliance.rules w ON w.id = t.rule_id AND w.rule_code = 'CLO_WARF' AND w.client_id IS NULL
    WHERE t.entity_id IS NOT NULL AND t.applies AND t.group_value IS NULL AND t.rank_from IS NULL AND t.rank_to IS NULL
      AND t.valid_to >= CURRENT_DATE
      AND NOT EXISTS (
          SELECT 1 FROM compliance.rule_thresholds x
          WHERE x.rule_id = v_rule AND x.entity_id = t.entity_id
            AND x.group_value IS NULL AND x.rank_from IS NULL AND x.rank_to IS NULL
      );
END $$;

NOTIFY pgrst, 'reload schema';
