-- Migration: Tenant-scope entity & intersection data
-- Description: Adds client_id to the tables that own tenant data (master_entities,
-- intersection_instances), backfills existing rows into the internal "unassigned"
-- client, and keeps intersection_instances.client_id in sync with its members.

-- ============================================================
-- master_entities.client_id
-- ============================================================
ALTER TABLE entity_instances.master_entities
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

UPDATE entity_instances.master_entities
SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
WHERE client_id IS NULL;

ALTER TABLE entity_instances.master_entities ALTER COLUMN client_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_entities_client ON entity_instances.master_entities(client_id);

COMMENT ON COLUMN entity_instances.master_entities.client_id IS 'Owning tenant. Every entity belongs to exactly one client.';

-- ============================================================
-- intersection_instances.client_id
-- ============================================================
ALTER TABLE entity_instances.intersection_instances
    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

UPDATE entity_instances.intersection_instances
SET client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
WHERE client_id IS NULL;

ALTER TABLE entity_instances.intersection_instances ALTER COLUMN client_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intersection_instances_client ON entity_instances.intersection_instances(client_id);

COMMENT ON COLUMN entity_instances.intersection_instances.client_id IS 'Owning tenant, derived from (and kept in sync with) its member entities. See trg_intersection_members_sync_client.';

-- Keep intersection_instances.client_id aligned with its constituent entities:
-- whenever a member is added, adopt that member entity's client if the
-- intersection is still pointing at the internal/unassigned bucket.
CREATE OR REPLACE FUNCTION entity_instances.sync_intersection_client_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_member_client UUID;
    v_current_client UUID;
    v_internal_client UUID;
BEGIN
    SELECT id INTO v_internal_client FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL';
    SELECT client_id INTO v_member_client FROM entity_instances.master_entities WHERE id = NEW.entity_id;
    SELECT client_id INTO v_current_client FROM entity_instances.intersection_instances WHERE id = NEW.intersection_id;

    IF v_member_client IS NOT NULL AND v_current_client IS DISTINCT FROM v_member_client
        AND (v_current_client IS NULL OR v_current_client = v_internal_client) THEN
        UPDATE entity_instances.intersection_instances
        SET client_id = v_member_client
        WHERE id = NEW.intersection_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intersection_members_sync_client ON entity_instances.intersection_members;
CREATE TRIGGER trg_intersection_members_sync_client
    AFTER INSERT ON entity_instances.intersection_members
    FOR EACH ROW EXECUTE FUNCTION entity_instances.sync_intersection_client_id();
