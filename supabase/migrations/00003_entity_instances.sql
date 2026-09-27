-- Migration: Entity Instances Schema
-- Description: Master entity registry, source tracking, and feed lineage

-- Source Registry: Vendor feed configurations
CREATE TABLE entity_instances.source_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_code VARCHAR(50) UNIQUE NOT NULL,
    source_name VARCHAR(200) NOT NULL,
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN ('VENDOR', 'INTERNAL', 'MANUAL', 'CALCULATED')),
    vendor_name VARCHAR(200),
    feed_format VARCHAR(50),
    feed_frequency VARCHAR(50),
    connection_config JSONB DEFAULT '{}',
    precedence_rank INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_source_registry_code ON entity_instances.source_registry(source_code);
CREATE INDEX idx_source_registry_type ON entity_instances.source_registry(source_type);
CREATE INDEX idx_source_registry_active ON entity_instances.source_registry(is_active);

COMMENT ON TABLE entity_instances.source_registry IS 'Registry of data sources including vendor feeds (Bloomberg, WSO, DealCloud, Allvue, S&P Capital IQ)';

-- Master Entities: Core entity instances across all domains
CREATE TABLE entity_instances.master_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_code VARCHAR(100) UNIQUE NOT NULL,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    template_id UUID REFERENCES metadata_register.domain_templates(id),
    entity_name VARCHAR(500) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_archived BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    updated_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_master_entities_code ON entity_instances.master_entities(entity_code);
CREATE INDEX idx_master_entities_domain ON entity_instances.master_entities(domain_code);
CREATE INDEX idx_master_entities_template ON entity_instances.master_entities(template_id);
CREATE INDEX idx_master_entities_active ON entity_instances.master_entities(is_active);
CREATE INDEX idx_master_entities_name ON entity_instances.master_entities(entity_name);

COMMENT ON TABLE entity_instances.master_entities IS 'Master entity registry for all domain instances';

-- Feed Lineage: Source feed tracking and staging
CREATE TABLE entity_instances.feed_lineage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    feed_batch_id VARCHAR(100) NOT NULL,
    feed_received_at TIMESTAMPTZ NOT NULL,
    feed_processed_at TIMESTAMPTZ,
    record_count INTEGER,
    success_count INTEGER,
    error_count INTEGER,
    feed_status VARCHAR(50) CHECK (feed_status IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED')),
    feed_metadata JSONB DEFAULT '{}',
    error_log JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_id, feed_batch_id)
);

CREATE INDEX idx_feed_lineage_source ON entity_instances.feed_lineage(source_id);
CREATE INDEX idx_feed_lineage_batch ON entity_instances.feed_lineage(feed_batch_id);
CREATE INDEX idx_feed_lineage_received ON entity_instances.feed_lineage(feed_received_at);
CREATE INDEX idx_feed_lineage_status ON entity_instances.feed_lineage(feed_status);

COMMENT ON TABLE entity_instances.feed_lineage IS 'Feed ingestion tracking with batch-level lineage';

-- Source Attribute Values: Staging table for source-provided values
CREATE TABLE entity_instances.source_attribute_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id),
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    feed_lineage_id UUID REFERENCES entity_instances.feed_lineage(id),
    attribute_value TEXT,
    value_as_jsonb JSONB,
    value_as_numeric NUMERIC,
    value_as_date DATE,
    value_as_timestamp TIMESTAMPTZ,
    value_as_boolean BOOLEAN,
    raw_value TEXT,
    confidence_score DECIMAL(5,4),
    is_override BOOLEAN DEFAULT FALSE,
    override_reason TEXT,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_sav_entity ON entity_instances.source_attribute_values(entity_id);
CREATE INDEX idx_sav_attribute ON entity_instances.source_attribute_values(attribute_id);
CREATE INDEX idx_sav_source ON entity_instances.source_attribute_values(source_id);
CREATE INDEX idx_sav_lineage ON entity_instances.source_attribute_values(feed_lineage_id);
CREATE INDEX idx_sav_valid_time ON entity_instances.source_attribute_values(valid_from, valid_to);
CREATE INDEX idx_sav_system_time ON entity_instances.source_attribute_values(system_from, system_to);
CREATE INDEX idx_sav_current ON entity_instances.source_attribute_values(entity_id, attribute_id) 
    WHERE system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE entity_instances.source_attribute_values IS 'Source-provided attribute values with bi-temporal tracking';

-- Insert core source registries
INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, vendor_name, precedence_rank) VALUES
    ('BLOOMBERG', 'Bloomberg Terminal', 'VENDOR', 'Bloomberg LP', 10),
    ('WSO', 'Wall Street Oasis', 'VENDOR', 'WSO', 20),
    ('DEALCLOUD', 'DealCloud', 'VENDOR', 'DealCloud', 30),
    ('ALLVUE', 'Allvue Systems', 'VENDOR', 'Allvue', 40),
    ('SP_CAPITAL_IQ', 'S&P Capital IQ', 'VENDOR', 'S&P Global', 50),
    ('INTERNAL', 'Internal Systems', 'INTERNAL', NULL, 60),
    ('MANUAL', 'Manual Entry', 'MANUAL', NULL, 90),
    ('CALCULATED', 'Calculated Values', 'CALCULATED', NULL, 100);
