-- Sample fund tests that the engine can actually score.
--
-- One result row is written per fund, and one extra row per group when the
-- rule groups (sector or issuer). Bench funds are excluded: those fixtures
-- store POSITION_FUND with the fund as the parent, which is the opposite of
-- the relationship registry. Production rows store the position as the parent,
-- so the rollup from a fund is direction UP.
--
-- Threshold shapes:
--   FUND_SECTOR_BOOK_PCT   percent of invested market value in one sector
--   FUND_ISSUER_NAV_PCT    percent of the fund's own NAV in one issuer
--   FUND_POSITION_COUNT    count of positions that have a market value
--   FUND_GROSS_EXPOSURE    total invested market value, capped by the fund's NAV

-- Issuer concentration groups on ISSUER_LEGAL_NAME. Copy the entity name
-- where that attribute was never set.
INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value,
    valid_from, valid_to, precedence_rank, metadata
)
SELECT me.id, ar.id, src.id, me.entity_name,
       DATE '2020-01-01', DATE '9999-12-31', 100,
       '{"complianceSample":true}'::jsonb
FROM entity_instances.master_entities me
JOIN metadata_register.attribute_register ar ON ar.attribute_code = 'ISSUER_LEGAL_NAME'
JOIN entity_instances.source_registry src ON src.source_code = 'MANUAL'
WHERE me.domain_code = 'ISSUER'
  AND me.is_active
  AND me.entity_name IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM golden_master.entity_attribute_values eav
      WHERE eav.entity_id = me.id
        AND eav.attribute_id = ar.id
        AND eav.valid_to >= CURRENT_DATE
        AND eav.system_to >= NOW()
  );

-- HSCF2 stores its single-name cap on FUND_ISSUER_LIMIT_PCT. The sample rule
-- reads FUND_SINGLE_ISSUER_LIMIT_PCT, which the other funds already carry.
INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
    valid_from, valid_to, precedence_rank, metadata
)
SELECT me.id, dst.id, src.id, srcv.golden_value, srcv.golden_value_numeric,
       DATE '2020-01-01', DATE '9999-12-31', 100,
       '{"complianceSample":true}'::jsonb
FROM entity_instances.master_entities me
JOIN metadata_register.attribute_register dst ON dst.attribute_code = 'FUND_SINGLE_ISSUER_LIMIT_PCT'
JOIN metadata_register.attribute_register org ON org.attribute_code = 'FUND_ISSUER_LIMIT_PCT'
JOIN golden_master.entity_attribute_values srcv
  ON srcv.entity_id = me.id
 AND srcv.attribute_id = org.id
 AND srcv.valid_to >= CURRENT_DATE
 AND srcv.system_to >= NOW()
JOIN entity_instances.source_registry src ON src.source_code = 'MANUAL'
WHERE me.entity_code = 'HSCF2-FUND'
  AND NOT EXISTS (
      SELECT 1
      FROM golden_master.entity_attribute_values eav
      WHERE eav.entity_id = me.id
        AND eav.attribute_id = dst.id
        AND eav.valid_to >= CURRENT_DATE
        AND eav.system_to >= NOW()
  );

INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES
    ('FUND_SECTOR_BOOK_PCT', 'Sector share of invested book', 'CONCENTRATION', 'FUND', TRUE, TRUE,
     'Share of a fund''s invested market value in one issuer sector. Warning above 22 percent, breach above 35 percent.'),
    ('FUND_ISSUER_NAV_PCT', 'Single-issuer share of NAV', 'CONCENTRATION', 'FUND', TRUE, TRUE,
     'Market value of one issuer as a percent of the fund''s own NAV. The hard limit is FUND_SINGLE_ISSUER_LIMIT_PCT on the fund, and the warning is 80 percent of that limit.'),
    ('FUND_POSITION_COUNT', 'Minimum number of valued positions', 'DIVERSIFICATION', 'FUND', TRUE, TRUE,
     'Count of positions that have a market value. Warning below 8, breach below 5.'),
    ('FUND_GROSS_EXPOSURE', 'Gross invested exposure', 'EXPOSURE', 'FUND', TRUE, TRUE,
     'Total invested market value. The hard cap is the fund''s NAV. A warning fires when exposure exceeds 12 percent of NAV.')
ON CONFLICT (rule_code) DO UPDATE
SET rule_name = EXCLUDED.rule_name,
    rule_category = EXCLUDED.rule_category,
    description = EXCLUDED.description,
    is_active = TRUE,
    applies_to_all = TRUE;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, description, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope, denominator_source,
    limit_direction, soft_limit_value, hard_limit_value,
    hard_limit_attribute_code, soft_limit_factor,
    result_unit
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, v.descr, 'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]'::jsonb,
       v.group_path::jsonb, v.group_attr,
       v.num_attr, v.num_agg,
       v.den_attr, v.den_agg, v.den_scope, v.den_source,
       v.direction, v.soft, v.hard,
       v.limit_attr, v.soft_factor,
       v.unit
FROM compliance.rules r
JOIN (VALUES
    ('FUND_SECTOR_BOOK_PCT',
     'Sector market value divided by the fund''s total invested market value.',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]',
     'SECTOR', 'MARKET_VALUE', 'SUM', 'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL', 'BASE',
     'MAX', 22::numeric, 35::numeric, NULL::varchar, NULL::numeric, 'PERCENTAGE'),
    ('FUND_ISSUER_NAV_PCT',
     'Issuer market value divided by the NAV stored on the fund.',
     '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false},{"relationship_code":"SECURITY_ISSUER","direction":"DOWN","recursive":false}]',
     'ISSUER_LEGAL_NAME', 'MARKET_VALUE', 'SUM', 'NAV', 'VALUE', 'SAME_GROUP', 'ANCHOR',
     'MAX', 8::numeric, 10::numeric, 'FUND_SINGLE_ISSUER_LIMIT_PCT', 0.8::numeric, 'PERCENTAGE'),
    ('FUND_POSITION_COUNT',
     'How many of the fund''s positions have a market value.',
     '[]',
     NULL::varchar, 'MARKET_VALUE', 'COUNT', NULL::varchar, NULL::varchar, 'SAME_GROUP', 'BASE',
     'MIN', 8::numeric, 5::numeric, NULL::varchar, NULL::numeric, 'COUNT'),
    ('FUND_GROSS_EXPOSURE',
     'Sum of position market value. Hard limit is the fund NAV; warning is 12 percent of NAV.',
     '[]',
     NULL::varchar, 'MARKET_VALUE', 'SUM', NULL::varchar, NULL::varchar, 'SAME_GROUP', 'BASE',
     'MAX', NULL::numeric, NULL::numeric, 'NAV', 0.12::numeric, 'CURRENCY')
) AS v(code, descr, group_path, group_attr, num_attr, num_agg, den_attr, den_agg, den_scope, den_source, direction, soft, hard, limit_attr, soft_factor, unit)
  ON v.code = r.rule_code
ON CONFLICT (rule_id, version_number) DO NOTHING;

-- Ignore positions that have no market value, except the count rule, which
-- counts only the positions that have one and should breach when that count is low.
INSERT INTO compliance.rule_conditions (
    rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, logic_operator
)
SELECT rv.id, 'BASE', 1, 1, 'MARKET_VALUE', 'is_not_null', 'AND'
FROM compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id
WHERE r.rule_code IN ('FUND_SECTOR_BOOK_PCT', 'FUND_ISSUER_NAV_PCT', 'FUND_GROSS_EXPOSURE')
  AND rv.version_number = 1
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_conditions c
      WHERE c.rule_version_id = rv.id AND c.attribute_code = 'MARKET_VALUE'
  );

INSERT INTO compliance.rule_scope_assignments (rule_id, scope_type, entity_id, include_children, notes)
SELECT r.id, 'EXCLUDE', me.id, FALSE,
       'Bench fixtures store POSITION_FUND with the fund as parent. These rules walk the registry direction.'
FROM compliance.rules r
JOIN entity_instances.master_entities me
  ON me.domain_code = 'FUND' AND me.entity_code LIKE 'BENCH-%'
WHERE r.rule_code IN ('FUND_SECTOR_BOOK_PCT', 'FUND_ISSUER_NAV_PCT', 'FUND_POSITION_COUNT', 'FUND_GROSS_EXPOSURE')
ON CONFLICT (rule_id, scope_type, entity_id) DO NOTHING;

-- Reporting date of the fund-surface sample. Golden values are open-ended, so
-- the same date scores the other funds too.
SELECT compliance.evaluate_rule('FUND_SECTOR_BOOK_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_ISSUER_NAV_PCT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_POSITION_COUNT', DATE '2026-09-30');
SELECT compliance.evaluate_rule('FUND_GROSS_EXPOSURE', DATE '2026-09-30');
