-- Migration: Entity Relationships
-- Description: Parent-child and cross-reference relationships between entities

-- Entity Relationships: Parent-child and cross-references between entities
CREATE TABLE entity_instances.entity_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    child_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100) NOT NULL, -- e.g., 'ISSUER_OF', 'HELD_BY', 'POSITION_IN'
    relationship_code VARCHAR(100) NOT NULL, -- e.g., 'SEC_ISSUER', 'POS_FUND'
    is_primary BOOLEAN DEFAULT FALSE, -- e.g., primary issuer vs co-issuer
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(parent_entity_id, child_entity_id, relationship_code, valid_from)
);

CREATE INDEX idx_entity_relationships_parent ON entity_instances.entity_relationships(parent_entity_id);
CREATE INDEX idx_entity_relationships_child ON entity_instances.entity_relationships(child_entity_id);
CREATE INDEX idx_entity_relationships_type ON entity_instances.entity_relationships(relationship_type);
CREATE INDEX idx_entity_relationships_current ON entity_instances.entity_relationships(parent_entity_id, child_entity_id)
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE entity_instances.entity_relationships IS 'Parent-child and cross-reference relationships between entities';

-- Relationship Types: Metadata for allowed relationship types
CREATE TABLE metadata_register.relationship_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relationship_code VARCHAR(100) UNIQUE NOT NULL,
    relationship_name VARCHAR(200) NOT NULL,
    parent_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    child_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relationship_types_code ON metadata_register.relationship_types(relationship_code);
CREATE INDEX idx_relationship_types_parent_domain ON metadata_register.relationship_types(parent_domain_code);
CREATE INDEX idx_relationship_types_child_domain ON metadata_register.relationship_types(child_domain_code);

COMMENT ON TABLE metadata_register.relationship_types IS 'Registry of allowed relationship types between entity domains';

-- Seed common relationship types
INSERT INTO metadata_register.relationship_types (relationship_code, relationship_name, parent_domain_code, child_domain_code) VALUES
    ('SECURITY_ISSUER', 'Security issued by', 'SECURITY', 'ISSUER'),
    ('POSITION_FUND', 'Position held in fund', 'POSITION', 'FUND'),
    ('POSITION_SECURITY', 'Position in security', 'POSITION', 'SECURITY'),
    ('DEAL_ISSUER', 'Deal with issuer', 'DEAL', 'ISSUER'),
    ('DEAL_FUND', 'Deal sponsored by fund', 'DEAL', 'FUND'),
    ('ISSUER_PARENT', 'Parent company of issuer', 'ISSUER', 'ISSUER');
