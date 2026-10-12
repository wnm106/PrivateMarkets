-- Migration 00023: Add missing updated_at columns to intersection tables
-- Description: The intersection_types table was missing the updated_at column

ALTER TABLE metadata_register.intersection_types 
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE metadata_register.intersection_types 
    SET updated_at = created_at 
    WHERE updated_at IS NULL;

ALTER TABLE metadata_register.intersection_types 
    ALTER COLUMN updated_at SET NOT NULL;