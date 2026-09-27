-- Migration: Entity Identifiers
-- Description: Define unique identifier attributes and identifier pairs per domain

-- Entity Identifier Definitions: Single and composite unique identifiers per domain
CREATE TABLE metadata_register.entity_identifier_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    identifier_code VARCHAR(100) NOT NULL,
    identifier_name VARCHAR(200) NOT NULL,
    attribute_codes TEXT[] NOT NULL, -- Array of attribute codes that form this identifier
    is_primary BOOLEAN DEFAULT FALSE, -- Whether this is the primary identifier for the domain
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(domain_code, identifier_code)
);

CREATE INDEX idx_entity_identifiers_domain ON metadata_register.entity_identifier_definitions(domain_code);
CREATE INDEX idx_entity_identifiers_active ON metadata_register.entity_identifier_definitions(is_active);

COMMENT ON TABLE metadata_register.entity_identifier_definitions IS 'Unique identifier definitions per domain - single attributes or composite identifier pairs';

-- Seed some common identifier definitions
INSERT INTO metadata_register.entity_identifier_definitions 
    (domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description) 
VALUES
    -- Securities identifiers
    ('SECURITY', 'ISIN', 'ISIN', ARRAY['isin'], TRUE, 'International Securities Identification Number'),
    ('SECURITY', 'CUSIP', 'CUSIP', ARRAY['cusip'], FALSE, 'Committee on Uniform Securities Identification Procedures'),
    ('SECURITY', 'SEDOL', 'SEDOL', ARRAY['sedol'], FALSE, 'Stock Exchange Daily Official List'),
    ('SECURITY', 'TICKER', 'Ticker Symbol', ARRAY['ticker'], FALSE, 'Exchange ticker symbol'),
    
    -- Issuer identifiers
    ('ISSUER', 'LEI', 'Legal Entity Identifier', ARRAY['lei'], TRUE, 'Global Legal Entity Identifier'),
    ('ISSUER', 'LEI_COUNTRY', 'LEI + Country Pair', ARRAY['lei', 'country'], FALSE, 'LEI combined with country for enhanced uniqueness'),
    
    -- Fund identifiers
    ('FUND', 'ISIN', 'ISIN', ARRAY['isin'], TRUE, 'International Securities Identification Number for Funds'),
    ('FUND', 'FUND_CODE', 'Fund Code', ARRAY['fund_code'], FALSE, 'Internal fund identification code'),
    
    -- Deal identifiers
    ('DEAL', 'DEAL_ID', 'Deal Identifier', ARRAY['deal_id'], TRUE, 'Unique deal identifier'),
    ('DEAL', 'DEAL_NAME', 'Deal Name', ARRAY['name'], FALSE, 'Deal name as identifier');