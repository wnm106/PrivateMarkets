-- Migration: Add protection flag to source_registry
-- Description: Adds is_protected column to prevent deletion of critical sources like Manual Override

-- Add is_protected column
ALTER TABLE entity_instances.source_registry 
ADD COLUMN IF NOT EXISTS is_protected BOOLEAN DEFAULT FALSE;

-- Create index for protected sources
CREATE INDEX IF NOT EXISTS idx_source_registry_protected 
ON entity_instances.source_registry(is_protected);

-- Update existing Manual source to be protected
UPDATE entity_instances.source_registry 
SET is_protected = TRUE 
WHERE source_code = 'MANUAL';

-- Add comment
COMMENT ON COLUMN entity_instances.source_registry.is_protected 
IS 'Flag to prevent deletion/deactivation of critical system sources';
