-- A security is issued by an issuer. List it under Issuer in the directory,
-- the same way the issuer's financial periods and statement periods are listed.
-- Contracts, schedules, and prices stay under the security, so they indent
-- one level further.

UPDATE metadata_register.domain_types
SET parent_domain_code = 'ISSUER',
    updated_at = NOW()
WHERE domain_code = 'SECURITY'
  AND parent_domain_code IS DISTINCT FROM 'ISSUER';
