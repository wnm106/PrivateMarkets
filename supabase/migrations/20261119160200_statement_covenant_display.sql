-- Show the statement's covenant ratios and covenant levels as multiples,
-- the way the statement's own leverage lines are shown.

UPDATE metadata_register.attribute_register
SET display_format = 'multiple',
    updated_at = NOW()
WHERE attribute_code IN (
    'STATEMENT_COV_NET_LEVERAGE', 'STATEMENT_COV_NET_LEVERAGE_LIMIT',
    'STATEMENT_COV_TOTAL_LEVERAGE', 'STATEMENT_COV_TOTAL_LEVERAGE_LIMIT',
    'STATEMENT_COV_INTEREST_COVERAGE', 'STATEMENT_COV_INTEREST_COVERAGE_LIMIT',
    'STATEMENT_COV_FIXED_CHARGE', 'STATEMENT_COV_FIXED_CHARGE_LIMIT'
);
