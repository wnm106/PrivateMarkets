-- Relationship reads check access once per query, not once per link.
--
-- Reading entity_instances.entity_relationships ran tenancy.has_entity_access
-- on both ends of every row, twice over: once for the read policy and once
-- for the write policy, which was declared FOR ALL and so applied to reads
-- too. Each call looks up the record's client, the caller's memberships,
-- permissions and grants. Counting 18,000 links as a signed-in user took
-- about seven seconds, against an eight-second statement timeout, so entity
-- lists and views with a related-entity column timed out.
--
-- The rule is unchanged. A link is readable when both of its records pass
-- has_entity_access(id, 'READ'), or both pass has_entity_access(id, 'WRITE')
-- (the old FOR ALL write policy also granted reads). Writes keep their
-- per-row check exactly as before, now as separate INSERT, UPDATE and DELETE
-- policies.
--
-- tenancy.relationship_endpoint_ids(level) returns, once per query, the
-- records has_entity_access(id, level) allows. With no restricted records it
-- reads the caller's clients and permissions once; once any record is
-- restricted it calls has_entity_access for each record.
-- supabase/tests/12_relationship_reads.sql holds the two to the same answer.

CREATE OR REPLACE FUNCTION tenancy.relationship_endpoint_ids(p_level text DEFAULT 'READ')
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, entity_instances, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM tenancy.entity_grants) THEN
        RETURN QUERY
            SELECT me.id
            FROM entity_instances.master_entities me
            WHERE tenancy.has_entity_access(me.id, p_level);
        RETURN;
    END IF;

    -- No record is restricted, so has_entity_access turns on the client alone:
    -- membership, then support mode, access management, or the permission.
    RETURN QUERY
        SELECT me.id
        FROM entity_instances.master_entities me
        WHERE me.client_id IN (
            SELECT c FROM tenancy.current_client_ids() c
            WHERE (tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() = c)
               OR tenancy.has_permission(c, 'entity_access.manage')
               OR tenancy.has_permission(c, CASE WHEN p_level = 'WRITE' THEN 'entity.write' ELSE 'entity.read' END)
        );
END;
$$;

COMMENT ON FUNCTION tenancy.relationship_endpoint_ids(text) IS
    'Records tenancy.has_entity_access(id, level) allows for the caller, as one set. The relationship read policy checks both ends of a link against it.';

REVOKE ALL ON FUNCTION tenancy.relationship_endpoint_ids(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.relationship_endpoint_ids(text) TO authenticated, service_role;

DROP POLICY IF EXISTS entity_relationships_select ON entity_instances.entity_relationships;
CREATE POLICY entity_relationships_select ON entity_instances.entity_relationships
    FOR SELECT TO authenticated
    USING (
        (parent_entity_id IN (SELECT tenancy.relationship_endpoint_ids('READ'))
         AND child_entity_id IN (SELECT tenancy.relationship_endpoint_ids('READ')))
        OR
        (parent_entity_id IN (SELECT tenancy.relationship_endpoint_ids('WRITE'))
         AND child_entity_id IN (SELECT tenancy.relationship_endpoint_ids('WRITE')))
    );

-- Writes: the same check as before, without applying to reads.
DROP POLICY IF EXISTS entity_relationships_write ON entity_instances.entity_relationships;

DROP POLICY IF EXISTS entity_relationships_insert ON entity_instances.entity_relationships;
CREATE POLICY entity_relationships_insert ON entity_instances.entity_relationships
    FOR INSERT TO authenticated
    WITH CHECK (tenancy.has_entity_access(parent_entity_id, 'WRITE') AND tenancy.has_entity_access(child_entity_id, 'WRITE'));

DROP POLICY IF EXISTS entity_relationships_update ON entity_instances.entity_relationships;
CREATE POLICY entity_relationships_update ON entity_instances.entity_relationships
    FOR UPDATE TO authenticated
    USING (tenancy.has_entity_access(parent_entity_id, 'WRITE') AND tenancy.has_entity_access(child_entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(parent_entity_id, 'WRITE') AND tenancy.has_entity_access(child_entity_id, 'WRITE'));

DROP POLICY IF EXISTS entity_relationships_delete ON entity_instances.entity_relationships;
CREATE POLICY entity_relationships_delete ON entity_instances.entity_relationships
    FOR DELETE TO authenticated
    USING (tenancy.has_entity_access(parent_entity_id, 'WRITE') AND tenancy.has_entity_access(child_entity_id, 'WRITE'));

NOTIFY pgrst, 'reload schema';
