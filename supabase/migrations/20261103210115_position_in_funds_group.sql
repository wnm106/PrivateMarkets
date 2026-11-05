-- Positions are holdings of a fund. List Position in Funds & investors,
-- directly after Fund. Cash Flow stays under Position, so it moves with it.

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    updated_at = NOW()
FROM (VALUES
    ('POSITION', 15),
    ('CASH_FLOW', 16)
) AS v(domain_code, display_order)
JOIN metadata_register.domain_groups g ON g.group_code = 'FUNDS'
WHERE dt.domain_code = v.domain_code;
