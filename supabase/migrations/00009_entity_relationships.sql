-- Migration: Entity relationships and required-parent flags
-- Description: Parent-child relationships between entities, plus is_required on relationship types.
-- The table definitions stay in this early migration so a fresh database can replay
-- in order. 00017 also creates relationship_types with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS entity_instances.entity_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    child_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100) NOT NULL,
    relationship_code VARCHAR(100) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(parent_entity_id, child_entity_id, relationship_code, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_parent ON entity_instances.entity_relationships(parent_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_child ON entity_instances.entity_relationships(child_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_type ON entity_instances.entity_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_current ON entity_instances.entity_relationships(parent_entity_id, child_entity_id)
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE entity_instances.entity_relationships IS 'Parent-child and cross-reference relationships between entities';

CREATE TABLE IF NOT EXISTS metadata_register.relationship_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relationship_code VARCHAR(100) UNIQUE NOT NULL,
    relationship_name VARCHAR(200) NOT NULL,
    parent_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    child_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relationship_types_code ON metadata_register.relationship_types(relationship_code);
CREATE INDEX IF NOT EXISTS idx_relationship_types_parent_domain ON metadata_register.relationship_types(parent_domain_code);
CREATE INDEX IF NOT EXISTS idx_relationship_types_child_domain ON metadata_register.relationship_types(child_domain_code);

COMMENT ON TABLE metadata_register.relationship_types IS 'Registry of allowed relationship types between entity domains';

INSERT INTO metadata_register.relationship_types (relationship_code, relationship_name, parent_domain_code, child_domain_code) VALUES
    ('SECURITY_ISSUER', 'Security issued by', 'SECURITY', 'ISSUER'),
    ('POSITION_FUND', 'Position held in fund', 'POSITION', 'FUND'),
    ('POSITION_SECURITY', 'Position in security', 'POSITION', 'SECURITY'),
    ('DEAL_ISSUER', 'Deal with issuer', 'DEAL', 'ISSUER'),
    ('DEAL_FUND', 'Deal sponsored by fund', 'DEAL', 'FUND'),
    ('ISSUER_PARENT', 'Parent company of issuer', 'ISSUER', 'ISSUER')
ON CONFLICT (relationship_code) DO NOTHING;

ALTER TABLE metadata_register.relationship_types
    ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT FALSE;

ALTER TABLE metadata_register.relationship_types
    ADD COLUMN IF NOT EXISTS cardinality TEXT DEFAULT 'ONE_TO_ONE'
    CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'COMPOSITE'));

ALTER TABLE metadata_register.relationship_types
    ADD COLUMN IF NOT EXISTS composite_key TEXT[] DEFAULT '{}';

ALTER TABLE metadata_register.relationship_types
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

COMMENT ON COLUMN metadata_register.relationship_types.is_required IS 'Whether this parent relationship is required for entity creation';

UPDATE metadata_register.relationship_types SET is_required = TRUE WHERE relationship_code = 'SECURITY_ISSUER';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'POSITION_FUND';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'POSITION_SECURITY';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'DEAL_ISSUER';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'DEAL_FUND';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'ISSUER_PARENT';
