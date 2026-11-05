-- INSERT ... RETURNING checks the SELECT policy before readable_entity_ids()
-- can see the new row, so a permitted insert comes back as a policy error.
-- The caller's own client and read permission are on the new row already.
-- Restricted entities still go through the access check.

DROP POLICY IF EXISTS "Master entities readable per tenant/ACL" ON entity_instances.master_entities;
CREATE POLICY "Master entities readable per tenant/ACL" ON entity_instances.master_entities
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT tenancy.readable_entity_ids())
    OR (
      client_id IN (
        SELECT c FROM tenancy.current_client_ids() c
        WHERE tenancy.has_permission(c, 'entity.read')
           OR (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() = c)
      )
      AND NOT tenancy.is_entity_restricted(id)
    )
  );
