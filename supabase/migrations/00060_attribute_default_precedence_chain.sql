-- Global source sequence for an attribute.
-- Templates keep using template_attribute_assignments.default_precedence_chain
-- only as an override. An empty or null template chain means "use the global sequence".
-- The application also stores the same array in metadata.defaultPrecedenceChain so
-- the sequence can be read and written before this column is exposed on the public view.

ALTER TABLE metadata_register.attribute_register
  ADD COLUMN IF NOT EXISTS default_precedence_chain JSONB;

COMMENT ON COLUMN metadata_register.attribute_register.default_precedence_chain IS
  'Global source precedence sequence, excluding MANUAL. Template assignments override this when their chain contains sources.';

UPDATE metadata_register.attribute_register
SET default_precedence_chain = metadata->'defaultPrecedenceChain'
WHERE default_precedence_chain IS NULL
  AND jsonb_typeof(metadata->'defaultPrecedenceChain') = 'array';
