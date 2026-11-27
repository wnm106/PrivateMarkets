-- Row security that is decided once per statement, not once per row.
--
-- Why: every read of domain_types, attribute_register and the other schema
-- tables ran the whole tenancy call chain (current_client_ids -> impersonation ->
-- admin -> MFA -> profiles) once per row, because SECURITY DEFINER functions with
-- a SET clause cannot be inlined into the policy. Measured on a replica at live
-- scale: domain_types 34ms -> 1.7ms for 60 rows.
--
-- What changes: how the answer is computed, never the answer. Each rewritten
-- policy is logically identical to the one it replaces:
--   * schema_row_visible(client_id)
--       = client_id IS NULL OR client_id IN (current_client_ids())
--         OR (tenant admin AND not impersonating)
--     The caller-level parts are now evaluated once (a hashed set / an InitPlan).
--   * domain_in_scope(code) = NOT catalog_restricted() OR <per-code checks>
--     The caller-level NOT catalog_restricted() is an InitPlan, the per-code
--     checks still run, only when the catalog is restricted.
-- entity_relationships_select is deliberately NOT changed: a set-based rewrite
-- returned identical rows but was not measurably faster on a replica.

-- ---------------------------------------------------------------------------
-- Helpers (callable by policies, therefore by the signed-in role)
-- ---------------------------------------------------------------------------

-- The "tenant admin looking at the whole product" arm of schema_row_visible.
CREATE OR REPLACE FUNCTION tenancy.schema_admin_sees_all()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'tenancy', 'pg_temp'
AS $$ SELECT tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL $$;

REVOKE ALL ON FUNCTION tenancy.schema_admin_sees_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.schema_admin_sees_all() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Schema tables: schema_row_visible(client_id) as a set test
-- ---------------------------------------------------------------------------
ALTER POLICY "Compliance rules readable per client" ON compliance.rules
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY attribute_aliases_client_scope ON metadata_register.attribute_aliases
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY attribute_register_select_scoped ON metadata_register.attribute_register
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY attribute_sections_select_scoped ON metadata_register.attribute_sections
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY client_attribute_settings_select ON metadata_register.client_attribute_settings
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY client_domain_settings_select ON metadata_register.client_domain_settings
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY domain_aliases_client_scope ON metadata_register.domain_aliases
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY domain_templates_select_scoped ON metadata_register.domain_templates
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY domain_types_select_scoped ON metadata_register.domain_types
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY entity_name_aliases_client_scope ON metadata_register.entity_name_aliases
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY reconciliation_definitions_select ON metadata_register.reconciliation_definitions
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY reference_lists_select_scoped ON metadata_register.reference_lists
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY relationship_types_select_scoped ON metadata_register.relationship_types
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY "Dashboards readable per client" ON public.dashboard_templates
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY "Narratives readable per client" ON public.narrative_templates
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY "Record experiences readable per client" ON public.record_experiences
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));
ALTER POLICY surface_definitions_select ON public.surface_definitions
  USING (client_id IS NULL OR client_id IN (SELECT tenancy.current_client_ids()) OR (SELECT tenancy.schema_admin_sees_all()));

-- ---------------------------------------------------------------------------
-- Module scope: whether the catalog is restricted is a fact about the caller,
-- not the row. Ask once; ask per code only when it is restricted.
-- ---------------------------------------------------------------------------
ALTER POLICY domain_types_module_scope ON metadata_register.domain_types
  USING ((SELECT NOT tenancy.catalog_restricted()) OR tenancy.domain_in_scope((domain_code)::text));
