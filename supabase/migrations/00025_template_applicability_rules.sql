-- Migration: Template Applicability Rules
-- Description: Add applicability_rules JSONB column to domain_templates
-- This allows defining logic for which records a template applies to

ALTER TABLE metadata_register.domain_templates
ADD COLUMN IF NOT EXISTS applicability_rules JSONB DEFAULT '{}';

COMMENT ON COLUMN metadata_register.domain_templates.applicability_rules IS 
'JSON rules defining which records this template applies to. Structure: { conditions: [{ attributeCode, operator, value }], logic: "AND" | "OR" }';
