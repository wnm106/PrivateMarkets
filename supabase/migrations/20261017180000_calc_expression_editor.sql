-- Tenant admins can edit a calculated attribute's expression and its operand inputs.
-- The existing sync trigger copies the expression onto the attribute register.

GRANT INSERT, UPDATE, DELETE ON metadata_register.calc_definitions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata_register.calc_inputs TO authenticated;

DROP POLICY IF EXISTS calc_definitions_insert_admin ON metadata_register.calc_definitions;
DROP POLICY IF EXISTS calc_definitions_update_admin ON metadata_register.calc_definitions;
DROP POLICY IF EXISTS calc_definitions_delete_admin ON metadata_register.calc_definitions;
DROP POLICY IF EXISTS calc_inputs_insert_admin ON metadata_register.calc_inputs;
DROP POLICY IF EXISTS calc_inputs_update_admin ON metadata_register.calc_inputs;
DROP POLICY IF EXISTS calc_inputs_delete_admin ON metadata_register.calc_inputs;

CREATE POLICY calc_definitions_insert_admin ON metadata_register.calc_definitions
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);
CREATE POLICY calc_definitions_update_admin ON metadata_register.calc_definitions
  FOR UPDATE TO authenticated
  USING (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL)
  WITH CHECK (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);
CREATE POLICY calc_definitions_delete_admin ON metadata_register.calc_definitions
  FOR DELETE TO authenticated
  USING (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);

CREATE POLICY calc_inputs_insert_admin ON metadata_register.calc_inputs
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);
CREATE POLICY calc_inputs_update_admin ON metadata_register.calc_inputs
  FOR UPDATE TO authenticated
  USING (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL)
  WITH CHECK (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);
CREATE POLICY calc_inputs_delete_admin ON metadata_register.calc_inputs
  FOR DELETE TO authenticated
  USING (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL);
