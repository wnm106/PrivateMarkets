-- Insert core domain types directly to fix the database
INSERT INTO metadata_register.domain_types (domain_code, domain_name, description, is_active) VALUES
    ('FUND', 'Fund', 'Investment fund vehicles', true),
    ('ISSUER', 'Issuer', 'Companies and entities issuing securities', true),
    ('DEAL', 'Deal', 'Investment transactions and deals', true),
    ('SECURITY', 'Security', 'Tradeable financial instruments', true),
    ('PRICE', 'Price', 'Pricing data points', true),
    ('POSITION', 'Position', 'Portfolio positions and holdings', true)
ON CONFLICT (domain_code) DO NOTHING;

-- Insert some basic attributes to ensure dependencies exist
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
VALUES
('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;

-- Insert a sample attribute for each domain to get started
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
VALUES
('FUND_NAME', 'Fund Name', 'STRING', 'Name of the fund', TRUE, 100),
('ISSUER_NAME', 'Issuer Name', 'STRING', 'Name of the issuer', TRUE, 100),
('DEAL_NAME', 'Deal Name', 'STRING', 'Name of the deal', TRUE, 100),
('SECURITY_NAME', 'Security Name', 'STRING', 'Name of the security', TRUE, 100)
ON CONFLICT (attribute_code) DO NOTHING;