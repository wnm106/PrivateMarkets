-- Instrument eligibility is a compliance rule, not a list on the fund.
--
-- The allocation engine used to block a security when its instrument type was
-- missing from FUND_ALLOWED_INSTRUMENT_TYPES on the fund. That kept the
-- restriction out of the rule register, the audit trail and the Hypo test.
--
-- FUND_INSTRUMENT_EXPOSURE is the market value a fund holds in each
-- instrument type (the security's INSTRUMENT_TYPE). It has no default limit.
-- A fund that may not hold a type gets a threshold of 0 for that type, so the
-- capacity for that security is 0 and the allocation engine leaves the fund
-- out of that tranche. A fund-level row with no limit enrolls the fund, so the
-- scheduled run scores it and catches a holding that slips in.
--
-- The thresholds below carry over what the fund lists said on 2026-11-19:
-- every instrument type a fund's list left out is 0 for that fund, and the
-- fund's mandate note is the threshold note. The fund attributes are left in
-- place but nothing reads them for eligibility any more.

INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES (
    'FUND_INSTRUMENT_EXPOSURE',
    'Permitted instrument types',
    'ELIGIBILITY',
    'FUND',
    TRUE,
    TRUE,
    'Market value a fund holds in each instrument type, read from the security''s INSTRUMENT_TYPE. No default limit. A threshold of 0 for an instrument type means the fund may not hold it.'
)
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
    result_unit, consolidate_descendants
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name,
       'Sum of position market value by the instrument type of the position''s security. A portfolio counts its sub-portfolios.',
       'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"UP","recursive":false}]'::jsonb,
       '[{"relationship_code":"POSITION_SECURITY","direction":"DOWN","recursive":false}]'::jsonb,
       'INSTRUMENT_TYPE',
       'MARKET_VALUE', 'SUM',
       NULL, NULL, 'SAME_GROUP', 'BASE',
       'MAX', NULL, NULL,
       NULL, NULL,
       'CURRENCY', TRUE
FROM compliance.rules r
WHERE r.rule_code = 'FUND_INSTRUMENT_EXPOSURE'
ON CONFLICT (rule_id, version_number) DO NOTHING;

-- One row per fund that carries a list: the fund is scored by the rule.
WITH rule AS (
    SELECT id FROM compliance.rules WHERE rule_code = 'FUND_INSTRUMENT_EXPOSURE'
),
lists AS (
    SELECT v.entity_id, v.golden_value
    FROM golden_master.entity_attribute_values v
    JOIN metadata_register.attribute_register a ON a.id = v.attribute_id
    WHERE a.attribute_code = 'FUND_ALLOWED_INSTRUMENT_TYPES'
      AND v.system_to >= TIMESTAMP '9999-01-01'
      AND v.valid_to >= CURRENT_DATE
      AND COALESCE(v.golden_value, '') <> ''
)
INSERT INTO compliance.rule_thresholds (rule_id, entity_id, group_value, applies, hard_limit_value, soft_limit_value, limit_direction, notes, valid_from)
SELECT rule.id, lists.entity_id, NULL, TRUE, NULL, NULL, 'MAX',
       'Scored for instrument eligibility. Carried over from the fund''s permitted instrument list.',
       DATE '2020-01-01'
FROM rule, lists
WHERE NOT EXISTS (
    SELECT 1 FROM compliance.rule_thresholds t
    WHERE t.rule_id = rule.id AND t.entity_id = lists.entity_id AND t.group_value IS NULL AND t.rank_from IS NULL
);

-- A 0 limit for every instrument type the fund's list left out.
WITH rule AS (
    SELECT id FROM compliance.rules WHERE rule_code = 'FUND_INSTRUMENT_EXPOSURE'
),
lists AS (
    SELECT v.entity_id, string_to_array(replace(v.golden_value, ' ', ''), ',') AS allowed
    FROM golden_master.entity_attribute_values v
    JOIN metadata_register.attribute_register a ON a.id = v.attribute_id
    WHERE a.attribute_code = 'FUND_ALLOWED_INSTRUMENT_TYPES'
      AND v.system_to >= TIMESTAMP '9999-01-01'
      AND v.valid_to >= CURRENT_DATE
      AND COALESCE(v.golden_value, '') <> ''
),
notes AS (
    SELECT v.entity_id, v.golden_value AS note
    FROM golden_master.entity_attribute_values v
    JOIN metadata_register.attribute_register a ON a.id = v.attribute_id
    WHERE a.attribute_code = 'FUND_MANDATE_NOTE'
      AND v.system_to >= TIMESTAMP '9999-01-01'
      AND v.valid_to >= CURRENT_DATE
),
types(code) AS (
    VALUES ('LOAN'), ('DELAYED_DRAW_TERM_LOAN'), ('REVOLVING_CREDIT'), ('SECOND_LIEN_LOAN'),
           ('MEZZANINE'), ('WARRANT'), ('PREFERRED_EQUITY')
)
INSERT INTO compliance.rule_thresholds (rule_id, entity_id, group_value, applies, hard_limit_value, soft_limit_value, limit_direction, notes, valid_from)
SELECT rule.id, lists.entity_id, types.code, TRUE, 0, NULL, 'MAX',
       COALESCE(NULLIF(notes.note, ''), 'Not a permitted instrument type for this fund.'),
       DATE '2020-01-01'
FROM rule
CROSS JOIN lists
CROSS JOIN types
LEFT JOIN notes ON notes.entity_id = lists.entity_id
WHERE NOT (types.code = ANY (lists.allowed))
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_thresholds t
      WHERE t.rule_id = rule.id AND t.entity_id = lists.entity_id AND t.group_value = types.code
  );
