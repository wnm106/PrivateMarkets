-- Bi-temporal integrity and a tamper-resistant change record.
--
-- The golden ledger promises two answers: what a value was on a date, and what
-- we knew on a date. Both broke:
--
--   * Writers "closed" the open row in place: valid_to moved to the edit date
--     and system_to to now, and only the new value was inserted. A NAV of 100
--     valid since 2024 then had no value at all for 2025 under current
--     knowledge, and "as known yesterday" for next month was rewritten too.
--   * Any signed-in user with write access could UPDATE or DELETE any row,
--     history included, and set created_by to anyone.
--   * Role, membership and access changes, and work done in support mode,
--     left no record.
--
-- This migration adds one correct write (golden_master.write_value), stops API
-- callers from editing or deleting history, stamps who made each change, and
-- keeps an append-only log of access changes. Server code (the service role,
-- migrations) is unaffected; its loaders keep their own semantics.

-- ============================================================
-- 1. Intervals must run forwards
-- ============================================================
-- NOT VALID: enforced for every new or changed row from now on, without
-- failing on any old row. VALIDATE CONSTRAINT later checks the old rows too.
ALTER TABLE golden_master.entity_attribute_values
    ADD CONSTRAINT eav_valid_interval CHECK (valid_from <= valid_to) NOT VALID,
    ADD CONSTRAINT eav_system_interval CHECK (system_from <= system_to) NOT VALID;
ALTER TABLE entity_instances.entity_relationships
    ADD CONSTRAINT rel_valid_interval CHECK (valid_from <= valid_to) NOT VALID,
    ADD CONSTRAINT rel_system_interval CHECK (system_from <= system_to) NOT VALID;

-- ============================================================
-- 2. One correct write
-- ============================================================
-- Records that a source says the value is p_value from p_valid_from to
-- p_valid_to, as known now.
--
-- Rows from the same source that overlap that period stop being current
-- knowledge (system_to = now) and are never changed otherwise. The parts of
-- them outside the period are written again as current knowledge, so every
-- other date keeps its value. Asking about any earlier knowledge date still
-- returns exactly what was known then.
--
-- p_valid_to NULL means "until this source's next later value", or open-ended
-- when there is none, so a backdated correction does not wipe out later values.
--
-- p_value holds the new row's columns: golden_value, golden_value_numeric,
-- golden_value_date, golden_value_timestamp, golden_value_boolean,
-- golden_value_jsonb, precedence_rank, is_manual_override, override_reason,
-- confidence_score, metadata, period_grain, statement_basis, source_value_id,
-- load_batch_id. Rows with a different period_grain or statement_basis are
-- separate series and are left alone.
--
-- Runs as the caller, so row security decides whether they may write.
CREATE OR REPLACE FUNCTION golden_master.write_value(
    p_entity_id UUID,
    p_attribute_id UUID,
    p_source_id UUID,
    p_valid_from DATE,
    p_value JSONB,
    p_valid_to DATE DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_open_ts CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
    v_open_d CONSTANT DATE := '9999-12-31';
    v_now TIMESTAMPTZ := now();
    v_new golden_master.entity_attribute_values;
    v_to DATE := p_valid_to;
    v_grain TEXT := NULLIF(p_value ->> 'period_grain', '');
    v_basis TEXT := NULLIF(p_value ->> 'statement_basis', '');
    v_rank INTEGER;
    v_row golden_master.entity_attribute_values;
    v_retired UUID[] := ARRAY[]::UUID[];
    v_id UUID;
BEGIN
    IF p_entity_id IS NULL OR p_attribute_id IS NULL OR p_source_id IS NULL THEN
        RAISE EXCEPTION 'A value needs a record, an attribute and a source' USING ERRCODE = '22023';
    END IF;
    IF p_valid_from IS NULL THEN
        RAISE EXCEPTION 'A value needs the date it takes effect' USING ERRCODE = '22023';
    END IF;

    -- One writer at a time per record, attribute and source, so two people
    -- saving at once cannot both leave a current row.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_entity_id::TEXT || '|' || p_attribute_id::TEXT || '|' || p_source_id::TEXT, 0)
    );

    IF v_to IS NULL THEN
        SELECT min(e.valid_from) - 1 INTO v_to
        FROM golden_master.entity_attribute_values e
        WHERE e.entity_id = p_entity_id
          AND e.attribute_id = p_attribute_id
          AND e.source_id = p_source_id
          AND e.system_to = v_open_ts
          AND e.period_grain IS NOT DISTINCT FROM v_grain
          AND e.statement_basis IS NOT DISTINCT FROM v_basis
          AND e.valid_from > p_valid_from;
        v_to := COALESCE(v_to, v_open_d);
    END IF;
    IF v_to < p_valid_from THEN
        RAISE EXCEPTION 'A value cannot end (%) before it starts (%)', v_to, p_valid_from USING ERRCODE = '22023';
    END IF;

    FOR v_row IN
        SELECT *
        FROM golden_master.entity_attribute_values e
        WHERE e.entity_id = p_entity_id
          AND e.attribute_id = p_attribute_id
          AND e.source_id = p_source_id
          AND e.system_to = v_open_ts
          AND e.period_grain IS NOT DISTINCT FROM v_grain
          AND e.statement_basis IS NOT DISTINCT FROM v_basis
          AND e.valid_from <= v_to
          AND e.valid_to >= p_valid_from
        ORDER BY e.valid_from
        FOR UPDATE
    LOOP
        UPDATE golden_master.entity_attribute_values
        SET system_to = v_now
        WHERE id = v_row.id;
        v_retired := v_retired || v_row.id;

        -- The part of the row before the new period stays current.
        IF v_row.valid_from < p_valid_from THEN
            v_row.valid_to := p_valid_from - 1;
            PERFORM golden_master.reassert_value(v_row);
        END IF;
    END LOOP;

    -- The part of a retired row after the new period stays current too. Read
    -- the rows again: the loop above changed v_row for the earlier part.
    FOR v_row IN
        SELECT *
        FROM golden_master.entity_attribute_values e
        WHERE e.id = ANY (v_retired)
          AND e.valid_to > v_to
    LOOP
        v_row.valid_from := v_to + 1;
        PERFORM golden_master.reassert_value(v_row);
    END LOOP;

    v_new := jsonb_populate_record(NULL::golden_master.entity_attribute_values, COALESCE(p_value, '{}'::jsonb));
    v_rank := v_new.precedence_rank;
    IF v_rank IS NULL THEN
        SELECT s.precedence_rank INTO v_rank FROM entity_instances.source_registry s WHERE s.id = p_source_id;
    END IF;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, source_value_id,
        golden_value, golden_value_jsonb, golden_value_numeric, golden_value_date,
        golden_value_timestamp, golden_value_boolean,
        valid_from, valid_to,
        precedence_rank, confidence_score, is_manual_override, override_reason,
        metadata, period_grain, statement_basis, load_batch_id
    ) VALUES (
        p_entity_id, p_attribute_id, p_source_id, v_new.source_value_id,
        v_new.golden_value, v_new.golden_value_jsonb, v_new.golden_value_numeric, v_new.golden_value_date,
        v_new.golden_value_timestamp, v_new.golden_value_boolean,
        p_valid_from, v_to,
        COALESCE(v_rank, 100), v_new.confidence_score, COALESCE(v_new.is_manual_override, FALSE), v_new.override_reason,
        COALESCE(v_new.metadata, '{}'::jsonb), v_grain, v_basis, v_new.load_batch_id
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
COMMENT ON FUNCTION golden_master.write_value(UUID, UUID, UUID, DATE, JSONB, DATE) IS
    'Records a source''s value for a period as current knowledge, keeping every other date''s value and every earlier knowledge date''s answer. The one way application code should change a golden value.';

-- Writes a copy of an existing row, with its own valid period, as current
-- knowledge. Used by write_value for the parts of a row outside a new period.
CREATE OR REPLACE FUNCTION golden_master.reassert_value(p_row golden_master.entity_attribute_values)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, source_value_id,
        golden_value, golden_value_jsonb, golden_value_numeric, golden_value_date,
        golden_value_timestamp, golden_value_boolean,
        valid_from, valid_to,
        precedence_rank, confidence_score, is_manual_override, override_reason,
        competing_values, metadata, period_grain, statement_basis, load_batch_id,
        last_received_at
    ) VALUES (
        p_row.entity_id, p_row.attribute_id, p_row.source_id, p_row.source_value_id,
        p_row.golden_value, p_row.golden_value_jsonb, p_row.golden_value_numeric, p_row.golden_value_date,
        p_row.golden_value_timestamp, p_row.golden_value_boolean,
        p_row.valid_from, p_row.valid_to,
        p_row.precedence_rank, p_row.confidence_score, p_row.is_manual_override, p_row.override_reason,
        p_row.competing_values,
        COALESCE(p_row.metadata, '{}'::jsonb) || jsonb_build_object('reasserted_from', p_row.id),
        p_row.period_grain, p_row.statement_basis, p_row.load_batch_id,
        p_row.last_received_at
    )
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION golden_master.write_value(UUID, UUID, UUID, DATE, JSONB, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION golden_master.reassert_value(golden_master.entity_attribute_values) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION golden_master.write_value(UUID, UUID, UUID, DATE, JSONB, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.reassert_value(golden_master.entity_attribute_values) TO service_role;

-- reassert_value runs inside write_value as the caller, so the caller needs to
-- run it. It writes only what write_value hands it, through row security.
GRANT EXECUTE ON FUNCTION golden_master.reassert_value(golden_master.entity_attribute_values) TO authenticated;

-- split_valid_time is the old "new value from a date" call. It now keeps the
-- earlier part of the row as current knowledge instead of dropping it.
CREATE OR REPLACE FUNCTION golden_master.split_valid_time(
    p_eav_id UUID,
    p_split_date DATE,
    p_new_value TEXT,
    p_source_id UUID,
    p_user_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_old golden_master.entity_attribute_values;
BEGIN
    SELECT * INTO v_old
    FROM golden_master.entity_attribute_values
    WHERE id = p_eav_id
      AND system_to = '9999-12-31 23:59:59+00';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Record not found or already closed: %', p_eav_id;
    END IF;
    IF p_split_date < v_old.valid_from OR p_split_date > v_old.valid_to THEN
        RAISE EXCEPTION 'Split date % outside valid range [% to %]', p_split_date, v_old.valid_from, v_old.valid_to;
    END IF;

    -- The new value may come from another source than the row it splits, so
    -- the row is ended here explicitly. Its earlier part stays current.
    IF p_source_id IS DISTINCT FROM v_old.source_id THEN
        UPDATE golden_master.entity_attribute_values SET system_to = now() WHERE id = v_old.id;
        IF p_split_date > v_old.valid_from THEN
            v_old.valid_to := p_split_date - 1;
            PERFORM golden_master.reassert_value(v_old);
        END IF;
    END IF;

    RETURN golden_master.write_value(
        v_old.entity_id, v_old.attribute_id, COALESCE(p_source_id, v_old.source_id), p_split_date,
        jsonb_build_object(
            'golden_value', p_new_value,
            'golden_value_numeric', CASE WHEN p_new_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN p_new_value::NUMERIC END,
            'precedence_rank', v_old.precedence_rank,
            'is_manual_override', TRUE,
            'period_grain', v_old.period_grain,
            'statement_basis', v_old.statement_basis
        ),
        v_old.valid_to
    );
END;
$$;

-- ============================================================
-- 3. API callers cannot rewrite or delete history
-- ============================================================
-- For a signed-in caller, a value row's value, period, source, provenance and
-- author never change after it is written. The only change allowed is ending
-- it as current knowledge (system_to from open to now). Derived columns that
-- resolution recomputes (golden_source_id, resolved_at, ...) stay writable.
-- Who wrote a row comes from the session, not from the request, and work done
-- in support mode says so.
--
-- Server code passes: the service role and migrations, and the few trusted
-- functions that restore an earlier state (load_batch_revert), which set
-- golden_master.trusted_writer for their own duration.
CREATE OR REPLACE FUNCTION golden_master.guard_value_rows()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_open_ts CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59+00';
    v_session UUID;
BEGIN
    IF tenancy.is_backend_caller()
       OR COALESCE(current_setting('golden_master.trusted_writer', TRUE), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.created_by := auth.uid();
        NEW.updated_by := NULL;
        NEW.created_at := now();
        NEW.system_from := now();
        IF NEW.system_to IS DISTINCT FROM v_open_ts THEN
            RAISE EXCEPTION 'A new value is current knowledge. Past knowledge cannot be written.'
                USING ERRCODE = '42501';
        END IF;

        IF tenancy.active_impersonation_client_id() IS NOT NULL THEN
            SELECT s.id INTO v_session
            FROM tenancy.impersonation_sessions s
            WHERE s.admin_user_id = auth.uid() AND s.ended_at IS NULL AND s.expires_at > now()
            ORDER BY s.started_at DESC
            LIMIT 1;
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
                'support_mode', jsonb_build_object('staff_user_id', auth.uid(), 'session_id', v_session)
            );
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF ROW(NEW.entity_id, NEW.attribute_id, NEW.source_id, NEW.source_value_id,
           NEW.golden_value, NEW.golden_value_jsonb, NEW.golden_value_numeric, NEW.golden_value_date,
           NEW.golden_value_timestamp, NEW.golden_value_boolean,
           NEW.valid_from, NEW.valid_to, NEW.system_from,
           NEW.precedence_rank, NEW.is_manual_override, NEW.override_reason,
           NEW.period_grain, NEW.statement_basis, NEW.load_batch_id,
           NEW.created_at, NEW.created_by)
       IS DISTINCT FROM
       ROW(OLD.entity_id, OLD.attribute_id, OLD.source_id, OLD.source_value_id,
           OLD.golden_value, OLD.golden_value_jsonb, OLD.golden_value_numeric, OLD.golden_value_date,
           OLD.golden_value_timestamp, OLD.golden_value_boolean,
           OLD.valid_from, OLD.valid_to, OLD.system_from,
           OLD.precedence_rank, OLD.is_manual_override, OLD.override_reason,
           OLD.period_grain, OLD.statement_basis, OLD.load_batch_id,
           OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'A recorded value cannot be changed. Write a new value with golden_master.write_value.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.system_to IS DISTINCT FROM OLD.system_to THEN
        IF OLD.system_to IS DISTINCT FROM v_open_ts THEN
            RAISE EXCEPTION 'A value that is no longer current cannot be changed' USING ERRCODE = '42501';
        END IF;
        -- Ending a row as current knowledge happens now, never earlier.
        NEW.system_to := now();
    END IF;
    NEW.updated_by := auth.uid();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_guard_value_rows ON golden_master.entity_attribute_values;
CREATE TRIGGER aa_guard_value_rows
    BEFORE INSERT OR UPDATE ON golden_master.entity_attribute_values
    FOR EACH ROW EXECUTE FUNCTION golden_master.guard_value_rows();

ALTER FUNCTION public.load_batch_revert(UUID, UUID, UUID) SET golden_master.trusted_writer = 'on';

-- History is never deleted from the API. Values end; they are not removed.
DROP POLICY IF EXISTS "Golden master deletable per entity access" ON golden_master.entity_attribute_values;
REVOKE DELETE, TRUNCATE ON golden_master.entity_attribute_values FROM authenticated, anon;

-- A link between records ends the same way, rather than being deleted.
REVOKE DELETE, TRUNCATE ON entity_instances.entity_relationships FROM authenticated, anon;

-- Deleting a record removes its whole value and link history with it. A record
-- with history is deactivated instead (is_active = false).
CREATE OR REPLACE FUNCTION entity_instances.guard_entity_delete()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = entity_instances, golden_master, tenancy, pg_temp
AS $$
BEGIN
    IF tenancy.is_backend_caller() THEN
        RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM golden_master.entity_attribute_values WHERE entity_id = OLD.id)
       OR EXISTS (
            SELECT 1 FROM entity_instances.entity_relationships
            WHERE parent_entity_id = OLD.id OR child_entity_id = OLD.id
       ) THEN
        RAISE EXCEPTION 'This record has history, so it is deactivated rather than deleted. Set is_active to false.'
            USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS aa_guard_entity_delete ON entity_instances.master_entities;
CREATE TRIGGER aa_guard_entity_delete
    BEFORE DELETE ON entity_instances.master_entities
    FOR EACH ROW EXECUTE FUNCTION entity_instances.guard_entity_delete();

-- ============================================================
-- 4. Append-only record of access changes
-- ============================================================
CREATE TABLE IF NOT EXISTS tenancy.audit_log (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    actor_user_id UUID,
    actor_role TEXT,
    impersonated_client_id UUID,
    client_id UUID,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    row_id TEXT,
    old_row JSONB,
    new_row JSONB
);
CREATE INDEX IF NOT EXISTS idx_tenancy_audit_client_time ON tenancy.audit_log (client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenancy_audit_actor_time ON tenancy.audit_log (actor_user_id, occurred_at DESC);
COMMENT ON TABLE tenancy.audit_log IS
    'Who changed membership, roles, permissions, access grants, sign-in rules, staff status or support mode, and when. Written only by triggers; rows are never changed or removed.';

ALTER TABLE tenancy.audit_log ENABLE ROW LEVEL SECURITY;

-- The tenancy schema grants new tables to signed-in users by default. This one
-- is written by triggers only.
REVOKE ALL ON tenancy.audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON tenancy.audit_log TO authenticated;
GRANT SELECT ON tenancy.audit_log TO service_role;
REVOKE ALL ON SEQUENCE tenancy.audit_log_id_seq FROM PUBLIC, anon, authenticated;

-- Platform staff see everything; a client's user and role managers see their
-- client's entries.
CREATE POLICY audit_log_read ON tenancy.audit_log
    FOR SELECT TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR (client_id IS NOT NULL AND (
                tenancy.has_permission(client_id, 'user.manage')
                OR tenancy.has_permission(client_id, 'role.manage')
           ))
    );

CREATE OR REPLACE FUNCTION tenancy.audit_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_old JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
    v_new JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
    v_row JSONB := COALESCE(v_new, v_old);
    v_client UUID;
BEGIN
    -- Profiles: only staff status and active status matter here.
    IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE'
       AND (v_old -> 'is_tenant_admin') IS NOT DISTINCT FROM (v_new -> 'is_tenant_admin')
       AND (v_old -> 'is_active') IS NOT DISTINCT FROM (v_new -> 'is_active') THEN
        RETURN NULL;
    END IF;

    v_client := CASE
        WHEN TG_TABLE_NAME = 'clients' THEN (v_row ->> 'id')::UUID
        WHEN v_row ? 'client_id' THEN NULLIF(v_row ->> 'client_id', '')::UUID
    END;
    -- A role permission belongs to the role's client.
    IF TG_TABLE_NAME = 'role_permissions' THEN
        SELECT r.client_id INTO v_client FROM tenancy.roles r WHERE r.id = (v_row ->> 'role_id')::UUID;
    END IF;

    -- Secrets never go into the log.
    v_old := v_old - 'client_secret' - 'secret' - 'metadata_xml';
    v_new := v_new - 'client_secret' - 'secret' - 'metadata_xml';

    INSERT INTO tenancy.audit_log (
        actor_user_id, actor_role, impersonated_client_id, client_id,
        table_name, operation, row_id, old_row, new_row
    ) VALUES (
        auth.uid(),
        COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb ->> 'role', current_user),
        tenancy.active_impersonation_client_id(),
        v_client,
        TG_TABLE_NAME, TG_OP,
        COALESCE(v_row ->> 'id', concat_ws(':', v_row ->> 'role_id', v_row ->> 'permission_id')),
        v_old, v_new
    );
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tenancy.audit_change() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'clients', 'profiles', 'client_users', 'roles', 'role_permissions', 'user_roles',
        'entity_grants', 'client_identity_providers', 'client_auth_requirements', 'impersonation_sessions'
    ] LOOP
        IF to_regclass('tenancy.' || t) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS zz_audit_change ON tenancy.%I', t);
            EXECUTE format(
                'CREATE TRIGGER zz_audit_change AFTER INSERT OR UPDATE OR DELETE ON tenancy.%I '
                'FOR EACH ROW EXECUTE FUNCTION tenancy.audit_change()', t);
        END IF;
    END LOOP;
END;
$$;

-- Nobody edits or removes an entry, the service role included. Retention, if
-- ever needed, is a migration that drops this trigger deliberately.
CREATE OR REPLACE FUNCTION tenancy.audit_log_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'The access audit log is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS audit_log_append_only ON tenancy.audit_log;
CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON tenancy.audit_log
    FOR EACH ROW EXECUTE FUNCTION tenancy.audit_log_append_only();
REVOKE TRUNCATE ON tenancy.audit_log FROM service_role;

NOTIFY pgrst, 'reload schema';
