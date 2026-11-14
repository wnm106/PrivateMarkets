-- An issuer with no market cap should fail this rule, not pass it.
-- Both lines must be true: the value is present, and it is not negative.
-- A rule someone has already edited is left alone.

UPDATE data_quality.dq_rules
SET rule_expression = 'MARKET_CAP IS NOT NULL AND MARKET_CAP >= 0',
    rule_description = 'Market capitalization must be present and cannot be negative.',
    updated_at = NOW()
WHERE rule_code = 'ISSUER_MARKET_CAP_NONNEGATIVE'
  AND rule_expression = 'MARKET_CAP IS NULL OR MARKET_CAP >= 0';
