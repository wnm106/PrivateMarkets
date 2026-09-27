-- Migration: Data Connections and Loaders
-- Description: Separate tables for data connections (endpoints with auth) and data loaders (scheduled jobs)

-- Data Connections: Represents an endpoint with authentication configuration
CREATE TABLE entity_instances.data_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_code VARCHAR(50) UNIQUE NOT NULL,
    connection_name VARCHAR(200) NOT NULL,
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN ('VENDOR', 'INTERNAL', 'MANUAL', 'CALCULATED')),
    vendor_name VARCHAR(200),
    
    -- Endpoint configuration
    endpoint_url TEXT,
    endpoint_method VARCHAR(20) DEFAULT 'GET',
    endpoint_headers JSONB DEFAULT '{}',
    request_timeout INTEGER DEFAULT 30000,
    
    -- Authentication
    auth_type VARCHAR(50) NOT NULL CHECK (auth_type IN ('NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH', 'OAUTH2_CLIENT', 'OAUTH2_AUTH_CODE', 'CERTIFICATE', 'CUSTOM_HEADER')),
    auth_config JSONB DEFAULT '{}',
    
    -- Status
    connection_status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (connection_status IN ('ACTIVE', 'INACTIVE', 'ERROR', 'TESTING')),
    last_tested_at TIMESTAMPTZ,
    last_test_result JSONB DEFAULT '{}',
    
    -- Metadata
    precedence_rank INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_data_connections_code ON entity_instances.data_connections(connection_code);
CREATE INDEX idx_data_connections_type ON entity_instances.data_connections(source_type);
CREATE INDEX idx_data_connections_active ON entity_instances.data_connections(is_active);
CREATE INDEX idx_data_connections_status ON entity_instances.data_connections(connection_status);

COMMENT ON TABLE entity_instances.data_connections IS 'Data connections with endpoint URLs and authentication configurations';

-- Data Loaders: Represents a specific data loading job from a connection
CREATE TABLE entity_instances.data_loaders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loader_code VARCHAR(50) UNIQUE NOT NULL,
    loader_name VARCHAR(200) NOT NULL,
    connection_id UUID NOT NULL REFERENCES entity_instances.data_connections(id) ON DELETE CASCADE,
    
    -- What to load
    domain_code VARCHAR(50),
    attribute_codes TEXT[],
    
    -- Schedule
    load_frequency VARCHAR(50) NOT NULL CHECK (load_frequency IN ('INTRADAY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND')),
    cron_expression VARCHAR(100),
    load_window VARCHAR(50), -- e.g., 'OVERNIGHT', 'MARKET_HOURS', 'ANYTIME'
    batch_size INTEGER DEFAULT 1000,
    
    -- Transform
    transform_mapping JSONB DEFAULT '{}',
    field_mapping JSONB DEFAULT '{}',
    
    -- Status
    loader_status VARCHAR(50) DEFAULT 'IDLE' CHECK (loader_status IN ('IDLE', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED')),
    last_run_at TIMESTAMPTZ,
    last_run_result JSONB DEFAULT '{}',
    next_run_at TIMESTAMPTZ,
    
    -- Metadata
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_data_loaders_code ON entity_instances.data_loaders(loader_code);
CREATE INDEX idx_data_loaders_connection ON entity_instances.data_loaders(connection_id);
CREATE INDEX idx_data_loaders_frequency ON entity_instances.data_loaders(load_frequency);
CREATE INDEX idx_data_loaders_active ON entity_instances.data_loaders(is_active);
CREATE INDEX idx_data_loaders_next_run ON entity_instances.data_loaders(next_run_at);

COMMENT ON TABLE entity_instances.data_loaders IS 'Data loading jobs that pull data from connections on a schedule';

-- Seed some example connections
INSERT INTO entity_instances.data_connections (
    connection_code, connection_name, source_type, vendor_name,
    endpoint_url, auth_type, auth_config, precedence_rank
) VALUES
    ('BLOOMBERG_API', 'Bloomberg API', 'VENDOR', 'Bloomberg LP',
     'https://api.bloomberg.com/v1/market-data', 'API_KEY',
     '{"apiKeyHeader": "X-API-Key"}'::jsonb, 10),
    ('DEALCLOUD_REST', 'DealCloud REST API', 'VENDOR', 'DealCloud',
     'https://api.dealcloud.com/v2', 'OAUTH2_CLIENT',
     '{"tokenUrl": "https://auth.dealcloud.com/oauth/token", "clientId": "dc_client", "scopes": ["read", "write"]}'::jsonb, 30),
    ('ALLVUE_SFTP', 'Allvue SFTP Feed', 'VENDOR', 'Allvue',
     'sftp://feeds.allvue.com/daily', 'CERTIFICATE',
     '{"hostKey": "ssh-rsa AAAA...", "username": "allvue_feed"}'::jsonb, 40),
    ('INTERNAL_PORTAL', 'Internal Data Portal', 'INTERNAL', NULL,
     'https://internal.company.com/api/data', 'BEARER_TOKEN',
     '{"tokenRefreshUrl": "https://auth.company.com/token"}'::jsonb, 60);

-- Seed some example loaders
INSERT INTO entity_instances.data_loaders (
    loader_code, loader_name, connection_id, domain_code, attribute_codes,
    load_frequency, cron_expression, load_window, batch_size
) VALUES
    ('BLOOMBERG_NAV_INTRADAY', 'Bloomberg NAV Intraday',
     (SELECT id FROM entity_instances.data_connections WHERE connection_code = 'BLOOMBERG_API'),
     'FUND', ARRAY['NAV', 'NAV_DATE'],
     'INTRADAY', '*/30 9-16 * * 1-5', 'MARKET_HOURS', 500),
    ('BLOOMBERG_PRICES_DAILY', 'Bloomberg Daily Prices',
     (SELECT id FROM entity_instances.data_connections WHERE connection_code = 'BLOOMBERG_API'),
     'SECURITY', ARRAY['PRICE', 'PRICE_DATE', 'VOLUME'],
     'DAILY', '0 18 * * 1-5', 'OVERNIGHT', 10000),
    ('DEALCLOUD_DEALS_DAILY', 'DealCloud Daily Deals',
     (SELECT id FROM entity_instances.data_connections WHERE connection_code = 'DEALCLOUD_REST'),
     'DEAL', ARRAY['DEAL_DATE', 'DEAL_TYPE', 'DEAL_VALUE', 'STATUS'],
     'DAILY', '0 2 * * *', 'OVERNIGHT', 1000),
    ('ALLVUE_POSITIONS_DAILY', 'Allvue Daily Positions',
     (SELECT id FROM entity_instances.data_connections WHERE connection_code = 'ALLVUE_SFTP'),
     'POSITION', ARRAY['QUANTITY', 'MARKET_VALUE', 'COST_BASIS'],
     'DAILY', '0 3 * * *', 'OVERNIGHT', 5000);
