-- List a fund's own records under Fund. The relationship rows already
-- point each of these at a fund. NAV Line stays under its statement.
-- Position follows the fund's records so the menu indent stays with Fund.

UPDATE metadata_register.domain_types AS dt
SET parent_domain_code = v.parent_code,
    display_order = v.display_order,
    updated_at = NOW()
FROM (VALUES
    ('CAPITAL_ACTIVITY', 'FUND', 11),
    ('CAPITAL_PLAN', 'FUND', 12),
    ('CASH_FORECAST', 'FUND', 13),
    ('CREDIT_FACILITY', 'FUND', 14),
    ('EXPOSURE_LIMIT', 'FUND', 15),
    ('NAV_STATEMENT', 'FUND', 16),
    ('NAV_LINE', 'NAV_STATEMENT', 17),
    ('POSITION', NULL, 18),
    ('CASH_FLOW', 'POSITION', 19)
) AS v(domain_code, parent_code, display_order)
WHERE dt.domain_code = v.domain_code;
