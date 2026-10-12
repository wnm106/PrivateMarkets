-- Migration: Precedence Rules Framework
-- Description: Adds tables for rule-based source precedence with conditions and chains

-- Precedence Rules: Conditional rules that override default source preferences
CREATE TABLE metadata_register.precedence_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(100) UNIQUE,
    rule_name VARCHAR(200) NOT NULL,
    domain_code VARCHAR(50) NOT NULL,
    template_code VARCHAR(100),
    attribute_code VARCHAR(100) NOT NULL,
    priority_tier VARCHAR(50) DEFAULT 'field-specific',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by VARCHAR(100),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_precedence_rules_domain ON metadata_register.precedence_rules(domain_code);
CREATE INDEX idx_precedence_rules_attribute ON metadata_register.precedence_rules(attribute_code);
CREATE INDEX idx_precedence_rules_active ON metadata_register.precedence_rules(is_active);
CREATE INDEX idx_precedence_rules_tier ON metadata_register.precedence_rules(priority_tier);

COMMENT ON TABLE metadata_register.precedence_rules IS 'Conditional rules that override default source precedence for attributes';

-- Precedence Rule Conditions: AND/OR conditions that determine when a rule applies
CREATE TABLE metadata_register.precedence_rule_conditions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES metadata_register.precedence_rules(id) ON DELETE CASCADE,
    condition_group INTEGER DEFAULT 1,
    condition_order INTEGER DEFAULT 1,
    attribute_code VARCHAR(100) NOT NULL,
    operator VARCHAR(50) NOT NULL,
    value TEXT,
    logic_operator VARCHAR(10) DEFAULT 'AND',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_precedence_conditions_rule ON metadata_register.precedence_rule_conditions(rule_id);
CREATE INDEX idx_precedence_conditions_group ON metadata_register.precedence_rule_conditions(condition_group);

COMMENT ON TABLE metadata_register.precedence_rule_conditions IS 'Conditions that determine when a precedence rule applies';

-- Precedence Rule Chain: Ordered source preferences for a rule
CREATE TABLE metadata_register.precedence_rule_chain (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES metadata_register.precedence_rules(id) ON DELETE CASCADE,
    chain_order INTEGER NOT NULL,
    source_code VARCHAR(50) NOT NULL,
    condition_type VARCHAR(50) DEFAULT 'if_value_present',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_precedence_chain_rule ON metadata_register.precedence_rule_chain(rule_id);
CREATE INDEX idx_precedence_chain_order ON metadata_register.precedence_rule_chain(chain_order);

COMMENT ON TABLE metadata_register.precedence_rule_chain IS 'Ordered source preferences for a precedence rule';

-- Add default_precedence_chain to template_attribute_assignments
ALTER TABLE metadata_register.template_attribute_assignments
ADD COLUMN IF NOT EXISTS default_precedence_chain JSONB;

COMMENT ON COLUMN metadata_register.template_attribute_assignments.default_precedence_chain IS 'Default source precedence chain as JSON array of source_codes';
