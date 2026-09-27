-- Insert dependency attributes first to satisfy derived attribute requirements
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
VALUES
('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;

-- Simple calculation: Current Yield = Annual Interest / Current Price * 100
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    is_derived, derivation_type, derivation_formula, derivation_dependencies
) VALUES
('CURRENT_YIELD', 'Current Yield (%)', 'PERCENTAGE', 'Calculated yield based on current price',
 TRUE, 'SIMPLE',
 'SELECT (annual_interest / NULLIF(current_price, 0) * 100) FROM attributes WHERE attribute_code IN (''ANNUAL_INTEREST'', ''CURRENT_PRICE'')',
 '[\"ANNUAL_INTEREST\", \"CURRENT_PRICE\"]'::jsonb)
ON CONFLICT (attribute_code) DO NOTHING;