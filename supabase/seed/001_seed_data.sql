-- Seed: Domain Types
-- Already inserted in migration 00002

-- Seed: Attribute Register
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank) VALUES
    -- Fund attributes
    ('NAV', 'Net Asset Value', 'NUMBER', 'Fund net asset value', TRUE, 100),
    ('NAV_CURRENCY', 'NAV Currency', 'STRING', 'Currency of NAV', FALSE, 100),
    ('NAV_DATE', 'NAV Date', 'DATE', 'Date of NAV calculation', TRUE, 100),
    ('INCEPTION_DATE', 'Inception Date', 'DATE', 'Fund inception date', FALSE, 100),
    ('FUND_STATUS', 'Fund Status', 'STRING', 'Current fund status', FALSE, 100),
    ('FUND_TYPE', 'Fund Type', 'STRING', 'Type of fund', FALSE, 100),
    ('MANAGER', 'Fund Manager', 'STRING', 'Fund manager name', FALSE, 100),
    ('AUM', 'Assets Under Management', 'NUMBER', 'Total assets under management', FALSE, 100),
    ('EXPENSE_RATIO', 'Expense Ratio', 'NUMBER', 'Fund expense ratio', FALSE, 100),
    ('DOMICILE', 'Domicile', 'STRING', 'Fund domicile country', FALSE, 100),
    
    -- Issuer attributes
    ('LEI', 'Legal Entity Identifier', 'STRING', 'LEI code', FALSE, 100),
    ('COUNTRY', 'Country', 'STRING', 'Country of incorporation', FALSE, 100),
    ('SECTOR', 'Sector', 'STRING', 'Business sector', FALSE, 100),
    ('INDUSTRY', 'Industry', 'STRING', 'Business industry', FALSE, 100),
    ('MARKET_CAP', 'Market Capitalization', 'NUMBER', 'Market capitalization', FALSE, 100),
    ('CREDIT_RATING', 'Credit Rating', 'STRING', 'Credit rating', FALSE, 100),
    
    -- Security attributes
    ('ISIN', 'ISIN', 'STRING', 'International Securities Identification Number', FALSE, 100),
    ('CUSIP', 'CUSIP', 'STRING', 'Committee on Uniform Securities Identification Procedures code', FALSE, 100),
    ('TICKER', 'Ticker Symbol', 'STRING', 'Exchange ticker symbol', FALSE, 100),
    ('SECURITY_TYPE', 'Security Type', 'STRING', 'Type of security', FALSE, 100),
    ('CURRENCY', 'Currency', 'STRING', 'Denomination currency', FALSE, 100),
    ('EXCHANGE', 'Exchange', 'STRING', 'Trading exchange', FALSE, 100),
    ('PRICE', 'Price', 'NUMBER', 'Current price', FALSE, 100),
    ('PRICE_DATE', 'Price Date', 'DATE', 'Date of price', FALSE, 100),
    
    -- Deal attributes
    ('DEAL_DATE', 'Deal Date', 'DATE', 'Date of deal', FALSE, 100),
    ('DEAL_TYPE', 'Deal Type', 'STRING', 'Type of deal', FALSE, 100),
    ('DEAL_VALUE', 'Deal Value', 'NUMBER', 'Total deal value', FALSE, 100),
    ('STATUS', 'Status', 'STRING', 'Deal status', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;

-- Seed: Source Registry
-- Already inserted in migration 00003

-- Seed: Domain Templates
INSERT INTO metadata_register.domain_templates (template_code, domain_code, template_name, description) VALUES
    ('FUND_STANDARD', 'FUND', 'Standard Fund', 'Standard template for investment funds'),
    ('ISSUER_STANDARD', 'ISSUER', 'Standard Issuer', 'Standard template for issuers'),
    ('SECURITY_STANDARD', 'SECURITY', 'Standard Security', 'Standard template for securities'),
    ('DEAL_STANDARD', 'DEAL', 'Standard Deal', 'Standard template for deals')
ON CONFLICT (template_code) DO NOTHING;

-- Seed: Template-Attribute Assignments
-- Fund Standard Template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT 
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'FUND_STANDARD'),
    id,
    is_required,
    default_precedence_rank,
    row_number() OVER ()
FROM metadata_register.attribute_register
WHERE attribute_code IN ('NAV', 'NAV_CURRENCY', 'NAV_DATE', 'INCEPTION_DATE', 'FUND_STATUS', 'FUND_TYPE', 'MANAGER', 'AUM');

-- Issuer Standard Template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT 
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'ISSUER_STANDARD'),
    id,
    is_required,
    default_precedence_rank,
    row_number() OVER ()
FROM metadata_register.attribute_register
WHERE attribute_code IN ('LEI', 'COUNTRY', 'SECTOR', 'INDUSTRY', 'MARKET_CAP', 'CREDIT_RATING');

-- Security Standard Template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT 
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'SECURITY_STANDARD'),
    id,
    is_required,
    default_precedence_rank,
    row_number() OVER ()
FROM metadata_register.attribute_register
WHERE attribute_code IN ('ISIN', 'CUSIP', 'TICKER', 'SECURITY_TYPE', 'CURRENCY', 'EXCHANGE', 'PRICE', 'PRICE_DATE');

-- Deal Standard Template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT 
    (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'DEAL_STANDARD'),
    id,
    is_required,
    default_precedence_rank,
    row_number() OVER ()
FROM metadata_register.attribute_register
WHERE attribute_code IN ('DEAL_DATE', 'DEAL_TYPE', 'DEAL_VALUE', 'STATUS');

-- Statement wording that already means a canonical attribute.
INSERT INTO metadata_register.attribute_aliases (attribute_id, alias_label, alias_code, domain_code, match_kind, confidence)
SELECT attribute_id, alias_label, alias_code, domain_code, 'semantic', 0.960
FROM (
  SELECT id AS attribute_id, 'Ending NAV' AS alias_label, 'ENDING_NAV' AS alias_code, 'FUND' AS domain_code
  FROM metadata_register.attribute_register WHERE attribute_code = 'NAV'
  UNION ALL
  SELECT id, 'Net Assets', 'NET_ASSETS', 'FUND' FROM metadata_register.attribute_register WHERE attribute_code = 'NAV'
  UNION ALL
  SELECT id, 'Valuation Date', 'VALUATION_DATE', 'FUND' FROM metadata_register.attribute_register WHERE attribute_code = 'NAV_DATE'
  UNION ALL
  SELECT id, 'Total AUM', 'TOTAL_AUM', 'FUND' FROM metadata_register.attribute_register WHERE attribute_code = 'AUM'
) seeded
WHERE NOT EXISTS (
  SELECT 1 FROM metadata_register.attribute_aliases existing
  WHERE existing.alias_code = seeded.alias_code
    AND existing.domain_code = seeded.domain_code
    AND existing.template_id IS NULL
);
