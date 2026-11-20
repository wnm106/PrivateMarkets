-- Which entity types appear in global search and in the assistant follow list.
-- Contracts stay out. Every other type stays in until someone turns it off.

ALTER TABLE metadata_register.domain_types
  ADD COLUMN IF NOT EXISTS enabled_for_search BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN metadata_register.domain_types.enabled_for_search IS
  'When true, records of this entity type appear in global entity search and in the assistant list of records a person can follow.';

UPDATE metadata_register.domain_types
SET enabled_for_search = false,
    updated_at = NOW()
WHERE domain_code = 'INTEREST_CONTRACT';

-- Append the flag. Existing view columns stay in place so replace succeeds.
CREATE OR REPLACE VIEW public.domain_types AS
SELECT
  id,
  domain_code,
  domain_name,
  description,
  is_active,
  created_at,
  updated_at,
  temporal_model,
  as_of_date_granularity,
  as_of_date_label,
  client_id,
  group_id,
  parent_domain_code,
  is_core,
  display_order,
  enabled_for_search
FROM metadata_register.domain_types;

ALTER VIEW public.domain_types SET (security_invoker = on);

NOTIFY pgrst, 'reload schema';
