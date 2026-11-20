-- The entity count scans every record. A function call on each row exceeded the
-- statement timeout, so the sidebar lost the whole domain list. Compare the
-- domain code to one allowlist computed for the statement.

DROP POLICY IF EXISTS master_entities_module_select ON entity_instances.master_entities;
CREATE POLICY master_entities_module_select ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );

DROP POLICY IF EXISTS master_entities_module_insert ON entity_instances.master_entities;
CREATE POLICY master_entities_module_insert ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );

DROP POLICY IF EXISTS master_entities_module_update ON entity_instances.master_entities;
CREATE POLICY master_entities_module_update ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  )
  WITH CHECK (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );
