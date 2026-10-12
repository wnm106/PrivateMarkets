-- Migration: Add is_required to relationship_types
-- Description: Allows marking parent relationships as required or optional

ALTER TABLE metadata_register.relationship_types 
    ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN metadata_register.relationship_types.is_required IS 'Whether this parent relationship is required for entity creation';

-- Update seed data with appropriate required/optional flags
UPDATE metadata_register.relationship_types SET is_required = TRUE WHERE relationship_code = 'SECURITY_ISSUER';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'POSITION_FUND';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'POSITION_SECURITY';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'DEAL_ISSUER';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'DEAL_FUND';
UPDATE metadata_register.relationship_types SET is_required = FALSE WHERE relationship_code = 'ISSUER_PARENT';

