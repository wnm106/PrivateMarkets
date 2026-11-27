-- The Performance surface (surfaces/performance) belongs to the Funds module, so a curated
-- client with that module can open it. Safe to run again.
--
-- A curated client's allowlist is copied from the module catalog when an admin saves the
-- client's modules, so an existing curated client sees the surface after its modules are
-- saved again.
UPDATE tenancy.module_catalog
SET surface_codes = array_append(surface_codes, 'performance')
WHERE module_code = 'funds'
  AND NOT ('performance' = ANY (surface_codes));
