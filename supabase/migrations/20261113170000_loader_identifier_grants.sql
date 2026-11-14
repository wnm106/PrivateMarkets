-- The file loader runs as the service role and reads the identifier
-- definitions to match incoming rows to existing entities (LEI, ISIN, CUSIP...).
-- Only `authenticated` had access, so every load failed with
-- "permission denied for table entity_identifier_definitions".

GRANT USAGE ON SCHEMA metadata_register TO service_role;
GRANT SELECT ON metadata_register.entity_identifier_definitions TO service_role;
