-- Pro forma compliance rules for the deal allocation surface.
--
-- Each rule anchors on a fund, rolls up the fund's positions (booked and
-- synthetic alike) and measures exposure with MARKET_VALUE, which carries the
-- proposed exposure on a synthetic position. They are created inactive so no
-- scheduled run picks them up; the surface evaluates them on demand.
--
-- What the engine can express today, and what it cannot:
--   * Limits are one value per rule, so these use a common ceiling. The per-fund
--     limits on FUND_*_LIMIT_PCT are stored for the allocation engine and for a
--     later rule change that reads the limit from the fund.
--   * The denominator is the fund's total position market value, not NAV. A
--     NAV denominator needs the engine to read an attribute from the anchor.
--   * Sponsor grouping follows POSITION_TRANCHE, so booked positions without a
--     tranche fall into the unassigned group.
--   * Mandate eligibility and liquidity coverage are not here: they compare a
--     position to a list or a balance on the fund, which the engine cannot yet do.

INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES
    ('PF_ISSUER_CONCENTRATION', 'Pro Forma Single-Issuer Concentration', 'CONCENTRATION', 'FUND', TRUE, FALSE,
     'Share of a fund''s position market value in one issuer, including proposed allocations.'),
    ('PF_SPONSOR_CONCENTRATION', 'Pro Forma Sponsor Concentration', 'CONCENTRATION', 'FUND', TRUE, FALSE,
     'Share of a fund''s position market value tied to one sponsor through the tranche and deal, including proposed allocations.'),
    ('PF_UNFUNDED_COMMITMENTS', 'Pro Forma Unfunded Commitments', 'EXPOSURE', 'FUND', TRUE, FALSE,
     'Unfunded commitments as a share of a fund''s position market value, including proposed delayed draw and revolver allocations.')
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, description, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    limit_direction, soft_limit_value, hard_limit_value, result_unit
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, v.descr, 'POSITION',
       '[{"relationship_code": "POSITION_FUND", "direction": "UP", "recursive": false}]'::jsonb,
       v.group_path::jsonb, v.group_attr,
       v.num_attr, 'SUM',
       'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL',
       'MAX', v.soft, v.hard, 'PERCENTAGE'
FROM compliance.rules r
JOIN (VALUES
    ('PF_ISSUER_CONCENTRATION', 'Exposure to one issuer as a percent of fund position market value.',
     '[{"relationship_code": "POSITION_SECURITY", "direction": "DOWN", "recursive": false},
       {"relationship_code": "SECURITY_ISSUER", "direction": "DOWN", "recursive": false}]',
     'ISSUER_LEGAL_NAME', 'MARKET_VALUE', 8::numeric, 10::numeric),
    ('PF_SPONSOR_CONCENTRATION', 'Exposure tied to one sponsor as a percent of fund position market value.',
     '[{"relationship_code": "POSITION_TRANCHE", "direction": "DOWN", "recursive": false},
       {"relationship_code": "TRANCHE_DEAL", "direction": "DOWN", "recursive": false},
       {"relationship_code": "DEAL_SPONSOR", "direction": "DOWN", "recursive": false}]',
     'SPONSOR_NAME', 'MARKET_VALUE', 8::numeric, 10::numeric),
    ('PF_UNFUNDED_COMMITMENTS', 'Unfunded commitments as a percent of fund position market value.',
     '[]', NULL, 'UNFUNDED_COMMITMENT_AMOUNT', 12::numeric, 15::numeric)
) AS v(code, descr, group_path, group_attr, num_attr, soft, hard) ON v.code = r.rule_code
ON CONFLICT (rule_id, version_number) DO NOTHING;
