-- Migration: Metadata Register Schema
-- Description: Domain types, attribute registry, templates, and reference lists

-- Domain Types: FUND, ISSUER, DEAL, SECURITY, PRICE, POSITION
CREATE TABLE metadata_register.domain_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_code VARCHAR(50) UNIQUE NOT NULL,
    domain_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE metadata_register.domain_types IS 'Core domain types in the MDM system';

-- Attribute Registry: Polymorphic attribute definitions
CREATE TABLE metadata_register.attribute_register (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attribute_code VARCHAR(100) UNIQUE NOT NULL,
    attribute_name VARCHAR(200) NOT NULL,
    data_type VARCHAR(50) NOT NULL CHECK (data_type IN ('STRING', 'NUMBER', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON', 'REFERENCE')),
    description TEXT,
    unit_of_measure VARCHAR(50),
    validation_regex TEXT,
    is_required BOOLEAN DEFAULT FALSE,
    is_multi_valued BOOLEAN DEFAULT FALSE,
    reference_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    default_precedence_rank INTEGER DEFAULT 100,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attribute_register_code ON metadata_register.attribute_register(attribute_code);
CREATE INDEX idx_attribute_register_domain ON metadata_register.attribute_register(reference_domain_code);

COMMENT ON TABLE metadata_register.attribute_register IS 'Polymorphic attribute definitions with type constraints';

-- Domain Templates: Template configurations per domain
CREATE TABLE metadata_register.domain_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_code VARCHAR(100) UNIQUE NOT NULL,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    template_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    precedence_rules JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(domain_code, template_code)
);

CREATE INDEX idx_domain_templates_domain ON metadata_register.domain_templates(domain_code);
CREATE INDEX idx_domain_templates_active ON metadata_register.domain_templates(is_active);

COMMENT ON TABLE metadata_register.domain_templates IS 'Template configurations defining attribute sets per domain';

-- Template-Attribute Assignments: Which attributes belong to which templates
CREATE TABLE metadata_register.template_attribute_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES metadata_register.domain_templates(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
    is_required BOOLEAN DEFAULT FALSE,
    precedence_rank INTEGER DEFAULT 100,
    display_order INTEGER DEFAULT 0,
    display_label VARCHAR(200),
    validation_overrides JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(template_id, attribute_id)
);

CREATE INDEX idx_taa_template ON metadata_register.template_attribute_assignments(template_id);
CREATE INDEX idx_taa_attribute ON metadata_register.template_attribute_assignments(attribute_id);
CREATE INDEX idx_taa_precedence ON metadata_register.template_attribute_assignments(precedence_rank);

COMMENT ON TABLE metadata_register.template_attribute_assignments IS 'Template-to-attribute mappings with precedence rules';

-- Reference Lists: Enumerated values for reference attributes
CREATE TABLE metadata_register.reference_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_code VARCHAR(100) UNIQUE NOT NULL,
    list_name VARCHAR(200) NOT NULL,
    domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE metadata_register.reference_list_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES metadata_register.reference_lists(id) ON DELETE CASCADE,
    value_code VARCHAR(100) NOT NULL,
    value_label VARCHAR(200) NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(list_id, value_code)
);

CREATE INDEX idx_ref_list_values_list ON metadata_register.reference_list_values(list_id);
CREATE INDEX idx_ref_list_values_code ON metadata_register.reference_list_values(value_code);

COMMENT ON TABLE metadata_register.reference_lists IS 'Enumerated reference value lists';
COMMENT ON TABLE metadata_register.reference_list_values IS 'Individual values within reference lists';

-- Insert core domain types
INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('FUND', 'Fund', 'Investment fund vehicles'),
    ('ISSUER', 'Issuer', 'Companies and entities issuing securities'),
    ('DEAL', 'Deal', 'Investment transactions and deals'),
    ('SECURITY', 'Security', 'Tradeable financial instruments'),
    ('PRICE', 'Price', 'Pricing data points'),
    ('POSITION', 'Position', 'Portfolio positions and holdings');
