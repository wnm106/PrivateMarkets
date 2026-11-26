-- Four eyes: a second person approves a manual value, and reviews a workflow
-- run the first person started.
--
-- A client turns it on with tenancy.clients.four_eyes_required (set by staff,
-- like the sign-in rule). It is data, not code: nothing names a client.
--
-- Manual values. golden_master.write_value is the one writer every screen,
-- the assistant, Excel and workflows reach, and anyone can also insert into
-- the ledger directly. So the rule sits on the ledger itself, in the trigger
-- that already checks a value against its record's client
-- (entity_instances.enforce_attribute_value_client): for a four-eyes client,
-- a signed-in person cannot insert a new manual value. It raises SQLSTATE
-- FE001 with the record's client in DETAIL.
--
-- golden_master.submit_manual_override takes the same arguments as
-- write_value. Without four eyes it writes the value, as before. With four
-- eyes it catches FE001, files golden_master.override_requests and returns
-- PENDING. Someone else who holds override.approve and may write the record
-- approves it with golden_master.decide_override_request, which writes the
-- value then. The person who asked can withdraw it while it waits.
--
-- Still allowed without approval: the platform service (workflows apply what
-- their own review step approved), and write_value keeping the earlier and
-- later parts of a manual value it replaces (golden_master.reasserting).
-- Neither adds a value nobody approved.
--
-- Workflow reviews already stop the person who started a run from reviewing
-- it, unless the step turns that off (separate_reviewer). For a four-eyes
-- client it cannot be turned off, and open reviews take it when the flag is
-- set.

-- ============================================================
-- 1. The client setting and the permission
-- ============================================================
ALTER TABLE tenancy.clients ADD COLUMN IF NOT EXISTS four_eyes_required BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN tenancy.clients.four_eyes_required IS
    'A second person approves manual values, and workflow reviews always need someone other than the person who started the run.';

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('override.approve', 'Approve or reject manual values someone else entered, where the client requires four eyes')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'override.approve'
WHERE r.client_id IS NULL AND r.role_code IN ('CLIENT_ADMIN', 'DATA_STEWARD')
ON CONFLICT DO NOTHING;

-- Staff set it. Open reviews of the client take it at once.
CREATE OR REPLACE FUNCTION tenancy.set_client_four_eyes(p_client_id UUID, p_required BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, ops, pg_temp
AS $$
BEGIN
    IF NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only platform staff can change a client''s approval rule' USING ERRCODE = '42501';
    END IF;
    UPDATE tenancy.clients SET four_eyes_required = COALESCE(p_required, FALSE), updated_at = now()
    WHERE id = p_client_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown client' USING ERRCODE = '22023';
    END IF;
    IF p_required THEN
        UPDATE ops.workflow_reviews SET separate_reviewer = TRUE
        WHERE client_id = p_client_id AND status = 'PENDING' AND NOT separate_reviewer;
    END IF;
    RETURN COALESCE(p_required, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION tenancy.set_client_four_eyes(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.set_client_four_eyes(UUID, BOOLEAN) TO authenticated, service_role;

-- ============================================================
-- 2. Workflow reviews: separate reviewer cannot be turned off
-- ============================================================
CREATE OR REPLACE FUNCTION ops.workflow_review_four_eyes()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
BEGIN
    IF NOT NEW.separate_reviewer
       AND EXISTS (SELECT 1 FROM tenancy.clients c WHERE c.id = NEW.client_id AND c.four_eyes_required) THEN
        NEW.separate_reviewer := TRUE;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops.workflow_review_four_eyes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS workflow_review_four_eyes ON ops.workflow_reviews;
CREATE TRIGGER workflow_review_four_eyes
    BEFORE INSERT OR UPDATE OF separate_reviewer ON ops.workflow_reviews
    FOR EACH ROW EXECUTE FUNCTION ops.workflow_review_four_eyes();

-- ============================================================
-- 3. Manual values waiting for approval
-- ============================================================
CREATE TABLE IF NOT EXISTS golden_master.override_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id),
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    valid_from DATE NOT NULL,
    value JSONB NOT NULL,
    reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    requested_by UUID NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by UUID,
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    applied_value_id UUID,
    CHECK (status = 'PENDING' OR decided_at IS NOT NULL),
    CHECK (status <> 'APPROVED' OR (decided_by IS NOT NULL AND decided_by <> requested_by AND applied_value_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_override_requests_open ON golden_master.override_requests (client_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_override_requests_entity ON golden_master.override_requests (entity_id, attribute_id);
COMMENT ON TABLE golden_master.override_requests IS
    'Manual values a four-eyes client''s users entered, waiting for someone else to approve them. Read and changed only through the golden_master override request functions.';
ALTER TABLE golden_master.override_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON golden_master.override_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON golden_master.override_requests TO service_role;

-- ============================================================
-- 4. The ledger refuses an unapproved manual value
-- ============================================================
-- The client check every value already passes, plus the four-eyes rule.
CREATE OR REPLACE FUNCTION entity_instances.enforce_attribute_value_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'entity_instances', 'metadata_register', 'pg_temp'
AS $function$
DECLARE
  v_entity_client UUID;
  v_attribute_client UUID;
BEGIN
  SELECT client_id INTO v_entity_client
  FROM entity_instances.master_entities
  WHERE id = NEW.entity_id;

  SELECT client_id INTO v_attribute_client
  FROM metadata_register.attribute_register
  WHERE id = NEW.attribute_id;

  IF v_attribute_client IS NOT NULL AND v_attribute_client IS DISTINCT FROM v_entity_client THEN
    RAISE EXCEPTION 'Attribute belongs to a different client'
      USING ERRCODE = '42501';
  END IF;

  -- Four eyes: a signed-in person's new manual value waits for someone else
  -- (golden_master.submit_manual_override files it). Allowed: the platform
  -- service, an approved request being written, and write_value keeping the
  -- earlier and later parts of a value it replaces.
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.is_manual_override, FALSE)
     AND NOT tenancy.is_backend_caller()
     AND COALESCE(current_setting('golden_master.override_request', TRUE), '') = ''
     AND COALESCE(current_setting('golden_master.reasserting', TRUE), '') <> 'on'
     AND EXISTS (SELECT 1 FROM tenancy.clients c WHERE c.id = v_entity_client AND c.four_eyes_required) THEN
    RAISE EXCEPTION 'This client needs a second person to approve manual values. Submit it for approval.'
      USING ERRCODE = 'FE001', DETAIL = v_entity_client::text,
            HINT = 'golden_master.submit_manual_override files it for approval.';
  END IF;

  RETURN NEW;
END;
$function$;

-- write_value, marking the parts of replaced rows it writes again.
CREATE OR REPLACE FUNCTION golden_master.write_value(p_entity_id uuid, p_attribute_id uuid, p_source_id uuid, p_valid_from date, p_value jsonb, p_valid_to date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'golden_master', 'pg_temp'
AS $function$
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

    -- The parts of replaced rows written again below are not new values: a
    -- four-eyes client lets them through (enforce_attribute_value_client).
    PERFORM set_config('golden_master.reasserting', 'on', TRUE);
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
    PERFORM set_config('golden_master.reasserting', '', TRUE);

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
$function$;

-- ============================================================
-- 5. Submit, decide, withdraw, list
-- ============================================================
-- The one entry point for a manual value. {status: APPLIED, id} or
-- {status: PENDING, requestId}. SECURITY DEFINER so it can file the request;
-- it checks what the ledger's row security would (write access to the record)
-- before writing, and the ledger stamps the caller as the writer.
CREATE OR REPLACE FUNCTION golden_master.submit_manual_override(
    p_entity_id UUID, p_attribute_id UUID, p_source_id UUID, p_valid_from DATE, p_value JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_reason TEXT := btrim(COALESCE(p_value ->> 'override_reason', ''));
    v_client TEXT;
    v_id UUID;
BEGIN
    IF p_entity_id IS NULL OR p_attribute_id IS NULL OR p_source_id IS NULL OR p_valid_from IS NULL THEN
        RAISE EXCEPTION 'A value needs a record, an attribute, a source and the date it takes effect' USING ERRCODE = '22023';
    END IF;
    IF NOT COALESCE((p_value ->> 'is_manual_override')::BOOLEAN, FALSE) THEN
        RAISE EXCEPTION 'Only manual values go through submit_manual_override' USING ERRCODE = '22023';
    END IF;
    IF v_reason = '' THEN
        RAISE EXCEPTION 'A reason is required for a manual entry.' USING ERRCODE = '22023';
    END IF;
    IF NOT tenancy.is_backend_caller() THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'Sign in to enter a manual value' USING ERRCODE = '42501';
        END IF;
        IF NOT tenancy.has_entity_access(p_entity_id, 'WRITE') THEN
            RAISE EXCEPTION 'You cannot change this record' USING ERRCODE = '42501';
        END IF;
    END IF;

    BEGIN
        v_id := golden_master.write_value(p_entity_id, p_attribute_id, p_source_id, p_valid_from, p_value, NULL);
        RETURN jsonb_build_object('status', 'APPLIED', 'id', v_id);
    EXCEPTION WHEN SQLSTATE 'FE001' THEN
        -- The client requires four eyes. The trigger named the record's client.
        GET STACKED DIAGNOSTICS v_client = PG_EXCEPTION_DETAIL;
    END;

    INSERT INTO golden_master.override_requests (client_id, entity_id, attribute_id, source_id, valid_from, value, reason, requested_by)
    VALUES (v_client::UUID, p_entity_id, p_attribute_id, p_source_id, p_valid_from, p_value, v_reason, auth.uid())
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('status', 'PENDING', 'requestId', v_id);
END;
$$;
REVOKE ALL ON FUNCTION golden_master.submit_manual_override(UUID, UUID, UUID, DATE, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.submit_manual_override(UUID, UUID, UUID, DATE, JSONB) TO authenticated, service_role;

-- Why this caller cannot decide this request, or NULL when they can.
CREATE OR REPLACE FUNCTION golden_master.override_request_blocker(p_request golden_master.override_requests)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
BEGIN
    IF p_request.status <> 'PENDING' THEN
        RETURN 'This request was already ' || lower(p_request.status) || '.';
    END IF;
    IF auth.uid() IS NULL THEN
        RETURN 'Sign in to approve.';
    END IF;
    IF auth.uid() = p_request.requested_by THEN
        RETURN 'You entered this value, so someone else has to approve it.';
    END IF;
    IF NOT (tenancy.has_permission(p_request.client_id, 'override.approve') OR tenancy.is_tenant_admin()) THEN
        RETURN 'You do not hold the approve manual values permission for this client.';
    END IF;
    IF NOT tenancy.has_entity_access(p_request.entity_id, 'WRITE') THEN
        RETURN 'You cannot change this record.';
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION golden_master.override_request_blocker(golden_master.override_requests) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION golden_master.decide_override_request(p_request_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_request golden_master.override_requests;
    v_blocker TEXT;
    v_value_id UUID;
BEGIN
    SELECT * INTO v_request FROM golden_master.override_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR NOT tenancy.has_entity_access(v_request.entity_id, 'READ') THEN
        RAISE EXCEPTION 'Unknown request' USING ERRCODE = '22023';
    END IF;
    v_blocker := golden_master.override_request_blocker(v_request);
    IF v_blocker IS NOT NULL THEN
        RAISE EXCEPTION '%', v_blocker USING ERRCODE = '42501';
    END IF;

    IF p_approve THEN
        PERFORM set_config('golden_master.override_request', p_request_id::TEXT, TRUE);
        v_value_id := golden_master.write_value(
            v_request.entity_id, v_request.attribute_id, v_request.source_id, v_request.valid_from,
            v_request.value || jsonb_build_object('is_manual_override', TRUE), NULL
        );
        PERFORM set_config('golden_master.override_request', '', TRUE);
    END IF;

    UPDATE golden_master.override_requests
    SET status = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,
        decided_by = auth.uid(),
        decided_at = now(),
        decision_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
        applied_value_id = v_value_id
    WHERE id = p_request_id;

    RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END, 'id', v_value_id, 'entityId', v_request.entity_id);
END;
$$;
REVOKE ALL ON FUNCTION golden_master.decide_override_request(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.decide_override_request(UUID, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION golden_master.withdraw_override_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_request golden_master.override_requests;
BEGIN
    SELECT * INTO v_request FROM golden_master.override_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.requested_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Only the person who entered a value can withdraw it' USING ERRCODE = '42501';
    END IF;
    IF v_request.status <> 'PENDING' THEN
        RAISE EXCEPTION 'This request was already %', lower(v_request.status) USING ERRCODE = '22023';
    END IF;
    UPDATE golden_master.override_requests SET status = 'WITHDRAWN', decided_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('status', 'WITHDRAWN');
END;
$$;
REVOKE ALL ON FUNCTION golden_master.withdraw_override_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.withdraw_override_request(UUID) TO authenticated;

-- Requests on records the caller can read (which keeps them inside the
-- caller's clients), newest first. p_status NULL lists every status. The
-- record's name and code are added by the GraphQL resolver.
CREATE OR REPLACE FUNCTION golden_master.override_requests_list(p_status TEXT DEFAULT 'PENDING', p_limit INTEGER DEFAULT 200)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = golden_master, tenancy, metadata_register, pg_temp
AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to see approvals' USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(jsonb_agg(row ORDER BY (row ->> 'requestedAt') DESC), '[]'::jsonb) INTO v_result
    FROM (
        SELECT jsonb_build_object(
            'id', r.id,
            'status', r.status,
            'clientId', r.client_id,
            'entityId', r.entity_id,
            'attributeCode', ar.attribute_code,
            'attributeName', ar.attribute_name,
            'dataType', ar.data_type,
            'validFrom', r.valid_from,
            'value', r.value ->> 'golden_value',
            'reason', r.reason,
            'requestedBy', r.requested_by,
            'requestedByName', COALESCE(rp.display_name, ru.email, 'Unknown user'),
            'requestedAt', r.requested_at,
            'decidedBy', r.decided_by,
            'decidedByName', COALESCE(dp.display_name, du.email),
            'decidedAt', r.decided_at,
            'decisionNote', r.decision_note,
            'appliedValueId', r.applied_value_id,
            'mine', r.requested_by = auth.uid(),
            'blocker', golden_master.override_request_blocker(r),
            'canDecide', golden_master.override_request_blocker(r) IS NULL
        ) AS row
        FROM golden_master.override_requests r
        JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
        LEFT JOIN tenancy.profiles rp ON rp.id = r.requested_by
        LEFT JOIN auth.users ru ON ru.id = r.requested_by
        LEFT JOIN tenancy.profiles dp ON dp.id = r.decided_by
        LEFT JOIN auth.users du ON du.id = r.decided_by
        -- The tenant wall and record grants, as for the record itself.
        WHERE tenancy.has_entity_access(r.entity_id, 'READ')
          AND (p_status IS NULL OR r.status = upper(p_status))
        ORDER BY r.requested_at DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
    ) rows;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION golden_master.override_requests_list(TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.override_requests_list(TEXT, INTEGER) TO authenticated;

-- Requests are part of the audit story.
DROP TRIGGER IF EXISTS zz_audit_change ON golden_master.override_requests;
CREATE TRIGGER zz_audit_change AFTER INSERT OR UPDATE OR DELETE ON golden_master.override_requests
    FOR EACH ROW EXECUTE FUNCTION tenancy.audit_change();

NOTIFY pgrst, 'reload schema';
