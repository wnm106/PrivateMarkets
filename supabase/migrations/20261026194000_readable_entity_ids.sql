-- Selecting the golden ledger applied both the READ policy and the FOR ALL
-- write policy, so every row ran the access check twice. The check also
-- repeated client and permission lookups per row. Resolve the caller's
-- readable entities once, then test membership.

CREATE OR REPLACE FUNCTION tenancy.readable_entity_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenancy.entity_grants) THEN
    RETURN QUERY
      SELECT me.id
      FROM entity_instances.master_entities me
      WHERE me.client_id IN (
        SELECT c FROM tenancy.current_client_ids() c
        WHERE tenancy.has_permission(c, 'entity.read')
           OR (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() = c)
      );
    RETURN;
  END IF;

  RETURN QUERY
    SELECT me.id
    FROM entity_instances.master_entities me
    WHERE tenancy.has_entity_access(me.id, 'READ');
END;
$$;

COMMENT ON FUNCTION tenancy.readable_entity_ids() IS
  'Entity ids the caller may read. With no entity_grants this is one client and permission lookup. Otherwise it falls back to has_entity_access.';

GRANT EXECUTE ON FUNCTION tenancy.readable_entity_ids() TO authenticated;

DROP POLICY IF EXISTS "Golden master readable per entity access" ON golden_master.entity_attribute_values;
CREATE POLICY "Golden master readable per entity access" ON golden_master.entity_attribute_values
  FOR SELECT TO authenticated
  USING (entity_id IN (SELECT tenancy.readable_entity_ids()));

-- FOR ALL also filters SELECT. Keep write checks on writes only.
DROP POLICY IF EXISTS "Golden master writable per entity access" ON golden_master.entity_attribute_values;
CREATE POLICY "Golden master insertable per entity access" ON golden_master.entity_attribute_values
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));
CREATE POLICY "Golden master updatable per entity access" ON golden_master.entity_attribute_values
  FOR UPDATE TO authenticated
  USING (tenancy.has_entity_access(entity_id, 'WRITE'))
  WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));
CREATE POLICY "Golden master deletable per entity access" ON golden_master.entity_attribute_values
  FOR DELETE TO authenticated
  USING (tenancy.has_entity_access(entity_id, 'WRITE'));

DROP POLICY IF EXISTS "Master entities readable per tenant/ACL" ON entity_instances.master_entities;
CREATE POLICY "Master entities readable per tenant/ACL" ON entity_instances.master_entities
  FOR SELECT TO authenticated
  USING (id IN (SELECT tenancy.readable_entity_ids()));
