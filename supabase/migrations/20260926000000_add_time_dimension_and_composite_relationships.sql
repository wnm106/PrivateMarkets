-- Add time dimension support to attributes
ALTER TABLE metadata_register.attribute_register 
ADD COLUMN IF NOT EXISTS is_time_varying BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS time_dimension TEXT DEFAULT 'NONE' 
  CHECK (time_dimension IN ('NONE', 'VALID_TIME', 'TRANSACTION_TIME', 'BITEMPORAL'));

-- Add composite relationship support
ALTER TABLE metadata_register.relationship_types
ADD COLUMN IF NOT EXISTS cardinality TEXT DEFAULT 'ONE_TO_ONE'
  CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'COMPOSITE')),
ADD COLUMN IF NOT EXISTS composite_key TEXT[] DEFAULT '{}';

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_attribute_time_dimension 
  ON metadata_register.attribute_register(time_dimension) 
  WHERE time_dimension != 'NONE';

CREATE INDEX IF NOT EXISTS idx_relationship_cardinality 
  ON metadata_register.relationship_types(cardinality) 
  WHERE cardinality != 'ONE_TO_ONE';
