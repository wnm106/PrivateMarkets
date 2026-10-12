-- Migration 00050: Set domain_code for existing attributes
-- Description: Updates existing attributes with proper domain_code values
--              based on their intended entity type.

-- Temporarily disable the derived attribute validation trigger
ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

-- Fund attributes
UPDATE metadata_register.attribute_register
SET domain_code = 'FUND'
WHERE attribute_code IN ('NAV', 'NAV_CURRENCY', 'NAV_DATE', 'INCEPTION_DATE', 
                          'FUND_STATUS', 'FUND_TYPE', 'MANAGER', 'AUM', 'EXPENSE_RATIO', 
                          'DOMICILE', 'TOTAL_AUM');

-- Issuer attributes (non-derived first)
UPDATE metadata_register.attribute_register
SET domain_code = 'ISSUER'
WHERE attribute_code IN ('LEI', 'COUNTRY', 'SECTOR', 'INDUSTRY', 
                          'MARKET_CAP', 'CREDIT_RATING');

-- Security attributes
UPDATE metadata_register.attribute_register
SET domain_code = 'SECURITY'
WHERE attribute_code IN ('ISIN', 'CUSIP', 'TICKER', 'SECURITY_TYPE', 
                          'CURRENCY', 'EXCHANGE', 'PRICE', 'PRICE_DATE',
                          'CURRENT_PRICE', 'EFFECTIVE_DURATION');

-- Deal attributes
UPDATE metadata_register.attribute_register
SET domain_code = 'DEAL'
WHERE attribute_code IN ('DEAL_DATE', 'DEAL_TYPE', 'DEAL_VALUE', 'STATUS');

-- Cash Flow attributes
UPDATE metadata_register.attribute_register
SET domain_code = 'CASH_FLOW'
WHERE attribute_code IN ('CASHFLOW_DATE', 'CASHFLOW_TYPE', 'AMOUNT', 
                          'PAYMENT_STATUS', 'MARKET_VALUE');

-- Now update derived attributes (after their dependencies have domain_code set)
UPDATE metadata_register.attribute_register
SET domain_code = 'ISSUER'
WHERE attribute_code IN ('ISSUER_RATING');

UPDATE metadata_register.attribute_register
SET domain_code = 'SECURITY'
WHERE attribute_code IN ('CURRENT_YIELD', 'UNREALIZED_PNL');

-- Re-enable the derived attribute validation trigger
ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
