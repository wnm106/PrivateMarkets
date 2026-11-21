-- Links between records keep their history too.
--
-- A link (entity_instances.entity_relationships) is bi-temporal like a value,
-- but it could still be edited in place: its dates and flags rewritten, so the
-- earlier version was lost. It could not be ended and written again either,
-- because a link was unique on (parent, child, code, valid_from) across all of
-- history, so the revised link collided with the one it replaced.
--
--   * The uniqueness now holds among current links only. An ended link no
--     longer blocks a new one with the same start date.
--   * entity_instances.revise_relationship ends a link and writes its revised
--     version in one transaction.
--   * For API callers a link's endpoints, code, dates, flags and author never
--     change after it is written; it can only be ended (system_to open -> now).
--     Server code is unaffected.
--
-- Older migrations that upsert links use ON CONFLICT on the four columns; they
-- ran before this one. A new migration that upserts current links must write
-- ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from)
-- WHERE system_to = '9999-12-31 23:59:59+00'.

ALTER TABLE entity_instances.entity_relationships
    DROP CONSTRAINT IF EXISTS entity_relationships_parent_entity_id_child_entity_id_relat_key;
CREATE UNIQUE INDEX IF NOT EXISTS entity_relationships_current_key
    ON entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_code, valid_from)
    WHERE system_to = '9999-12-31 23:59:59+00';

-- Ends the link and writes it again with the given changes, as current
-- knowledge. NULL leaves a field as it was. Runs as the caller, so row security
-- decides whether they may.
CREATE OR REPLACE FUNCTION entity_instances.revise_relationship(
    p_id UUID,
    p_is_primary BOOLEAN DEFAULT NULL,
    p_valid_from DATE DEFAULT NULL,
    p_valid_to DATE DEFAULT NULL,
    p_relationship_type TEXT DEFAULT NULL
) RETURNS entity_instances.entity_relationships
LANGUAGE plpgsql
SET search_path = entity_instances, pg_temp
AS $$
DECLARE
    v_old entity_instances.entity_relationships;
    v_new entity_instances.entity_relationships;
BEGIN
    SELECT * INTO v_old
    FROM entity_instances.entity_relationships
    WHERE id = p_id AND system_to = '9999-12-31 23:59:59+00'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That link was not found, or has already ended' USING ERRCODE = 'P0002';
    END IF;

    UPDATE entity_instances.entity_relationships SET system_to = now() WHERE id = v_old.id;

    v_new := v_old;
    v_new.id := gen_random_uuid();
    v_new.is_primary := COALESCE(p_is_primary, v_old.is_primary);
    v_new.valid_from := COALESCE(p_valid_from, v_old.valid_from);
    v_new.valid_to := COALESCE(p_valid_to, v_old.valid_to);
    v_new.relationship_type := COALESCE(p_relationship_type, v_old.relationship_type);
    v_new.system_from := now();
    v_new.system_to := '9999-12-31 23:59:59+00';
    v_new.metadata := COALESCE(v_old.metadata, '{}'::jsonb) || jsonb_build_object('revised_from', v_old.id);

    INSERT INTO entity_instances.entity_relationships SELECT (v_new).*;
    RETURN v_new;
END;
$$;
REVOKE ALL ON FUNCTION entity_instances.revise_relationship(UUID, BOOLEAN, DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION entity_instances.revise_relationship(UUID, BOOLEAN, DATE, DATE, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION entity_instances.guard_relationship_rows()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = entity_instances, tenancy, pg_temp
AS $$
DECLARE
    v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
BEGIN
    IF tenancy.is_backend_caller() THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.system_from := now();
        IF NEW.system_to IS DISTINCT FROM v_open THEN
            RAISE EXCEPTION 'A new link is current knowledge. Past knowledge cannot be written.' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - 'system_to' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'system_to' - 'updated_at') THEN
        RAISE EXCEPTION 'A recorded link cannot be changed. Revise it with entity_instances.revise_relationship.'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.system_to IS DISTINCT FROM OLD.system_to THEN
        IF OLD.system_to IS DISTINCT FROM v_open THEN
            RAISE EXCEPTION 'A link that has ended cannot be changed' USING ERRCODE = '42501';
        END IF;
        NEW.system_to := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_guard_relationship_rows ON entity_instances.entity_relationships;
CREATE TRIGGER aa_guard_relationship_rows
    BEFORE INSERT OR UPDATE ON entity_instances.entity_relationships
    FOR EACH ROW EXECUTE FUNCTION entity_instances.guard_relationship_rows();

NOTIFY pgrst, 'reload schema';
