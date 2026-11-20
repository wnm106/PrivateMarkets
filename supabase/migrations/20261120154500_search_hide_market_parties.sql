-- These main types stay out of search and the assistant follow list.
-- FX rates, lenders, custodians, and counterparties are reference data.

UPDATE metadata_register.domain_types
SET enabled_for_search = false,
    updated_at = NOW()
WHERE domain_code IN ('FX_RATE', 'LENDER', 'CUSTODIAN', 'COUNTERPARTY')
  AND enabled_for_search IS DISTINCT FROM false;
