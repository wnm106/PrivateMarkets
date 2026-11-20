-- Platform tables that every signed-in user could read.
--
-- These tables have no client column. Platform staff write them, and every
-- signed-in user of every client could read them straight from the API:
--
--   * data_connections holds vendor credentials (auth_config) in plain text.
--     The GraphQL layer hides them; a direct API read did not.
--   * import_maps, import_executions and feed_lineage hold file contents, load
--     results and error logs, which carry the data of whichever client loaded.
--
-- Platform staff manage all of them, so platform staff read them. A person who
-- created an import map or ran an import still sees their own.

DROP POLICY IF EXISTS data_connections_select_authenticated ON entity_instances.data_connections;
CREATE POLICY data_connections_select_staff ON entity_instances.data_connections
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS data_loaders_select_authenticated ON entity_instances.data_loaders;
CREATE POLICY data_loaders_select_staff ON entity_instances.data_loaders
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS import_maps_select_authenticated ON entity_instances.import_maps;
CREATE POLICY import_maps_select_scoped ON entity_instances.import_maps
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR created_by::TEXT = auth.uid()::TEXT);

DROP POLICY IF EXISTS import_executions_select_authenticated ON entity_instances.import_executions;
CREATE POLICY import_executions_select_scoped ON entity_instances.import_executions
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR created_by::TEXT = auth.uid()::TEXT);

DROP POLICY IF EXISTS "Feed lineage readable by authenticated" ON entity_instances.feed_lineage;
CREATE POLICY feed_lineage_select_staff ON entity_instances.feed_lineage
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin());

-- A record's other names are part of the record. Reading the record was enough
-- to add or remove them; that takes the right to edit it.
DROP POLICY IF EXISTS entity_aliases_write ON entity_instances.entity_aliases;
CREATE POLICY entity_aliases_write ON entity_instances.entity_aliases
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

NOTIFY pgrst, 'reload schema';
