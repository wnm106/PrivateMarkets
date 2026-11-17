-- Runs split by record, form steps (with a private link for people outside
-- the firm), and the lookups the outbound steps need.
--
-- One run per record: a Start step with runPerRecord starts one child run per
-- chosen record (up to 500), each with filters naming that record, and the
-- parent run ends. A child knows its parent.
--
-- Forms: an "Ask for information" step opens a form and waits. A form is for
-- named people or roles in the client, or for one person outside the firm by
-- a private link. The link's token is random, only its SHA-256 is stored, it
-- expires, and it stops working once the form is answered. The two portal
-- functions are the only ones a caller who is not signed in can reach, and
-- they show nothing but the form itself.
--
-- Outbound: the worker reads a client's HTTP connection, with its stored
-- credential, and the client's Slack address, through service-role functions.

ALTER TABLE ops.workflow_runs ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES ops.workflow_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_parent ON ops.workflow_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.workflow_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT,
    fields JSONB NOT NULL DEFAULT '[]',
    assigned_users UUID[] NOT NULL DEFAULT '{}',
    assigned_roles TEXT[] NOT NULL DEFAULT '{}',
    external_email TEXT,
    token_hash TEXT,
    token_expires_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'DECLINED', 'CANCELLED')),
    answers JSONB,
    note TEXT,
    submitted_by UUID,
    submitted_by_external TEXT,
    submitted_at TIMESTAMPTZ,
    due_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS workflow_forms_open ON ops.workflow_forms (client_id, created_at DESC) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS workflow_forms_token ON ops.workflow_forms (token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE ops.workflow_forms ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.workflow_forms IS 'A form a workflow step is waiting on. Reached only through the workflow_form* and workflow_portal* functions.';
COMMENT ON COLUMN ops.workflow_forms.token_hash IS 'SHA-256 of the private link''s token, for a form sent outside the firm. Cleared once answered.';

-- ---------------------------------------------------------------------------
-- One run per record
-- ---------------------------------------------------------------------------

-- Starts one child run per input, on the parent's workflow version, for the
-- person who started the parent. Returns the child run ids in order.
CREATE OR REPLACE FUNCTION public.workflow_worker_spawn(p_parent_run_id UUID, p_inputs JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
    v_parent ops.workflow_runs;
    v_input JSONB;
    v_child UUID;
    v_ids JSONB := '[]'::jsonb;
BEGIN
    SELECT * INTO v_parent FROM ops.workflow_runs WHERE id = p_parent_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The parent run was not found' USING ERRCODE = 'P0002';
    END IF;
    IF jsonb_typeof(p_inputs) <> 'array' OR jsonb_array_length(p_inputs) > 500 THEN
        RAISE EXCEPTION 'A run can be split into at most 500 runs' USING ERRCODE = '22023';
    END IF;
    -- Spawning again (after a crash) returns the children already started.
    IF EXISTS (SELECT 1 FROM ops.workflow_runs WHERE parent_run_id = p_parent_run_id) THEN
        RETURN (SELECT jsonb_agg(id ORDER BY created_at, id) FROM ops.workflow_runs WHERE parent_run_id = p_parent_run_id);
    END IF;
    FOR v_input IN SELECT value FROM jsonb_array_elements(p_inputs) LOOP
        INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version, input, started_by, parent_run_id)
        VALUES (v_parent.client_id, v_parent.workflow_id, v_parent.version_id, v_parent.version,
                COALESCE(v_input, '{}'::jsonb) || jsonb_build_object('parentRunId', v_parent.id), v_parent.started_by, v_parent.id)
        RETURNING id INTO v_child;
        PERFORM ops.workflow_log(v_child, NULL, 'run.started', 'SYSTEM', v_parent.started_by,
            'Run started from a run split by record', jsonb_build_object('parentRunId', v_parent.id, 'input', v_input));
        PERFORM ops.workflow_queue_advance(v_child, v_parent.client_id, v_parent.started_by);
        v_ids := v_ids || to_jsonb(v_child);
    END LOOP;
    RETURN v_ids;
END;
$$;

-- The runs a run was split into, for its page.
CREATE OR REPLACE FUNCTION public.workflow_run_children(p_run_id UUID)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT jsonb_build_object('id', r.id, 'status', r.status, 'input', r.input, 'created_at', r.created_at, 'finished_at', r.finished_at,
                              'open_reviews', (SELECT count(*) FROM ops.workflow_reviews AS q WHERE q.run_id = r.id AND q.status = 'OPEN'))
    FROM ops.workflow_runs AS r
    JOIN ops.workflow_runs AS p ON p.id = r.parent_run_id
    WHERE r.parent_run_id = p_run_id AND ops.workflow_can_see(p.client_id)
    ORDER BY r.created_at, r.id;
$$;

-- ---------------------------------------------------------------------------
-- Forms
-- ---------------------------------------------------------------------------

-- Why answers do not fit a form's fields, or NULL when they do. A field is
-- { key, label, type: text|longtext|number|date|choice|yesno, required, options }.
CREATE OR REPLACE FUNCTION ops.workflow_form_check(p_fields JSONB, p_answers JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v_field JSONB;
    v_key TEXT;
    v_label TEXT;
    v_value JSONB;
    v_text TEXT;
BEGIN
    IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN
        RETURN 'The answers must be an object of field values.';
    END IF;
    FOR v_field IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_fields) = 'array' THEN p_fields ELSE '[]'::jsonb END) LOOP
        v_key := v_field ->> 'key';
        v_label := COALESCE(NULLIF(v_field ->> 'label', ''), v_key);
        v_value := p_answers -> v_key;
        v_text := btrim(COALESCE(p_answers ->> v_key, ''));
        IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' OR v_text = '' THEN
            IF COALESCE((v_field ->> 'required')::boolean, FALSE) THEN
                RETURN v_label || ' is required.';
            END IF;
            CONTINUE;
        END IF;
        CASE COALESCE(v_field ->> 'type', 'text')
            WHEN 'number' THEN
                IF v_text !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN v_label || ' must be a number.'; END IF;
            WHEN 'date' THEN
                IF v_text !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN v_label || ' must be a date, YYYY-MM-DD.'; END IF;
                BEGIN
                    PERFORM v_text::date;
                EXCEPTION WHEN others THEN
                    RETURN v_label || ' is not a real date.';
                END;
            WHEN 'yesno' THEN
                IF jsonb_typeof(v_value) <> 'boolean' AND lower(v_text) NOT IN ('true', 'false', 'yes', 'no') THEN RETURN v_label || ' must be yes or no.'; END IF;
            WHEN 'choice' THEN
                IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_field -> 'options', '[]'::jsonb)) AS o WHERE o = v_text) THEN
                    RETURN v_label || ' must be one of the choices.';
                END IF;
            ELSE
                IF length(v_text) > 10000 THEN RETURN v_label || ' is too long.'; END IF;
        END CASE;
    END LOOP;
    RETURN NULL;
END;
$$;

-- Opens a form for a step, or returns the one already open. A new external
-- form gets a token, returned once here, so the worker can send the link.
CREATE OR REPLACE FUNCTION public.workflow_worker_form(p_run_id UUID, p_node_id TEXT, p_spec JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, extensions, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
    v_form ops.workflow_forms;
    v_spec JSONB := CASE WHEN jsonb_typeof(p_spec) = 'object' THEN p_spec ELSE '{}'::jsonb END;
    v_external TEXT := NULLIF(lower(btrim(COALESCE(v_spec ->> 'externalEmail', ''))), '');
    v_token TEXT;
    v_hours NUMERIC;
    v_users UUID[];
    v_roles TEXT[];
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_form FROM ops.workflow_forms WHERE run_id = p_run_id AND node_id = p_node_id;
    IF FOUND THEN
        RETURN (to_jsonb(v_form) - 'token_hash') || jsonb_build_object('created', FALSE);
    END IF;

    IF COALESCE((v_spec ->> 'external')::boolean, FALSE) THEN
        IF v_external IS NULL OR v_external !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
            RAISE EXCEPTION 'The form needs an email address for the person outside the firm' USING ERRCODE = '22023';
        END IF;
        v_token := encode(extensions.gen_random_bytes(24), 'hex');
    ELSE
        v_external := NULL;
    END IF;

    SELECT COALESCE(array_agg(DISTINCT x::uuid), '{}') INTO v_users
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_spec -> 'people') = 'array' THEN v_spec -> 'people' ELSE '[]'::jsonb END) AS x
    WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND ops.workflow_user_can_review(v_run.client_id, x::uuid);
    SELECT COALESCE(array_agg(DISTINCT upper(btrim(x))), '{}') INTO v_roles
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_spec -> 'roles') = 'array' THEN v_spec -> 'roles' ELSE '[]'::jsonb END) AS x
    WHERE btrim(x) <> '';
    BEGIN
        v_hours := NULLIF(v_spec ->> 'dueInHours', '')::numeric;
    EXCEPTION WHEN others THEN
        v_hours := NULL;
    END;

    INSERT INTO ops.workflow_forms (run_id, client_id, node_id, title, instructions, fields, assigned_users, assigned_roles,
                                    external_email, token_hash, token_expires_at, due_at)
    VALUES (v_run.id, v_run.client_id, p_node_id, COALESCE(NULLIF(btrim(v_spec ->> 'title'), ''), 'Information needed'),
            NULLIF(v_spec ->> 'instructions', ''), COALESCE(v_spec -> 'fields', '[]'::jsonb), v_users, v_roles,
            v_external, CASE WHEN v_token IS NULL THEN NULL ELSE encode(extensions.digest(v_token, 'sha256'), 'hex') END,
            CASE WHEN v_token IS NULL THEN NULL ELSE NOW() + INTERVAL '14 days' END,
            CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END)
    ON CONFLICT (run_id, node_id) DO NOTHING
    RETURNING * INTO v_form;

    PERFORM ops.workflow_log(v_run.id, p_node_id, 'form.requested', 'SYSTEM', NULL,
        CASE WHEN v_external IS NOT NULL THEN 'Waiting for ' || v_external || ' to fill in "' || v_form.title || '"'
             ELSE 'Waiting for a person to fill in "' || v_form.title || '"' END,
        jsonb_build_object('formId', v_form.id));
    RETURN (to_jsonb(v_form) - 'token_hash') || jsonb_build_object('created', TRUE, 'token', v_token);
END;
$$;

-- Whether the signed-in person may answer a form, or why not.
CREATE OR REPLACE FUNCTION ops.workflow_form_blocker(p_form ops.workflow_forms)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN NULL
        WHEN p_form.status <> 'OPEN' THEN 'This form has been answered.'
        WHEN p_form.external_email IS NOT NULL AND NOT ops.workflow_can(p_form.client_id, 'workflow.manage') THEN
            'This form was sent to ' || p_form.external_email || '. Only someone who manages workflows can answer it for them.'
        WHEN NOT ops.workflow_can(p_form.client_id, 'workflow.review') THEN 'You do not hold the review permission for this client.'
        WHEN NOT ops.workflow_review_assigned(p_form.client_id, auth.uid(), p_form.assigned_users, p_form.assigned_roles) THEN 'This form is for someone else.'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION ops.workflow_form_view(p_form ops.workflow_forms)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (to_jsonb(p_form) - 'token_hash') || jsonb_build_object(
        'blocker', ops.workflow_form_blocker(p_form),
        'can_answer', ops.workflow_form_blocker(p_form) IS NULL,
        'workflow_name', (SELECT w.workflow_name FROM ops.workflow_runs AS r JOIN ops.workflows AS w ON w.id = r.workflow_id WHERE r.id = p_form.run_id),
        'assignees', ops.workflow_review_assignees(p_form.client_id, p_form.assigned_users, p_form.assigned_roles),
        'submitted_by_name', (SELECT display_name FROM tenancy.profiles WHERE id = p_form.submitted_by),
        'link_active', p_form.token_hash IS NOT NULL AND p_form.token_expires_at > NOW()
    );
$$;

CREATE OR REPLACE FUNCTION public.workflow_forms_list(p_status TEXT DEFAULT 'OPEN', p_run_id UUID DEFAULT NULL)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.workflow_form_view(f)
    FROM ops.workflow_forms AS f
    WHERE ops.workflow_can_see(f.client_id)
      AND (p_status IS NULL OR f.status = p_status)
      AND (p_run_id IS NULL OR f.run_id = p_run_id)
    ORDER BY f.due_at NULLS LAST, f.created_at DESC
    LIMIT 200;
$$;

-- Records an answer from someone signed in and lets the run go on.
CREATE OR REPLACE FUNCTION public.workflow_form_submit(p_form_id UUID, p_outcome TEXT, p_answers JSONB DEFAULT '{}', p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_form ops.workflow_forms;
    v_blocker TEXT;
    v_problem TEXT;
BEGIN
    IF p_outcome NOT IN ('SUBMITTED', 'DECLINED') THEN
        RAISE EXCEPTION 'A form is submitted or declined' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_form FROM ops.workflow_forms WHERE id = p_form_id FOR UPDATE;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_form.client_id) THEN
        RAISE EXCEPTION 'Form was not found' USING ERRCODE = 'P0002';
    END IF;
    v_blocker := ops.workflow_form_blocker(v_form);
    IF v_blocker IS NOT NULL THEN
        RAISE EXCEPTION '%', v_blocker USING ERRCODE = '42501';
    END IF;
    IF p_outcome = 'SUBMITTED' THEN
        v_problem := ops.workflow_form_check(v_form.fields, COALESCE(p_answers, '{}'::jsonb));
        IF v_problem IS NOT NULL THEN
            RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
        END IF;
    END IF;
    UPDATE ops.workflow_forms
       SET status = p_outcome, answers = CASE WHEN p_outcome = 'SUBMITTED' THEN p_answers END, note = NULLIF(btrim(COALESCE(p_note, '')), ''),
           submitted_by = auth.uid(), submitted_at = NOW(), token_hash = NULL
     WHERE id = p_form_id
    RETURNING * INTO v_form;
    PERFORM ops.workflow_log(v_form.run_id, v_form.node_id, 'form.answered', 'USER', auth.uid(),
        CASE WHEN p_outcome = 'SUBMITTED' THEN 'Form filled in' ELSE 'Form declined' END,
        jsonb_build_object('formId', v_form.id, 'outcome', p_outcome));
    PERFORM ops.workflow_queue_advance(v_form.run_id, v_form.client_id, auth.uid());
    RETURN ops.workflow_form_view(v_form);
END;
$$;

-- The portal: a form by its private link, for someone not signed in. Shows
-- only the form. NULL for a link that is wrong, used, or expired.
CREATE OR REPLACE FUNCTION public.workflow_portal_get(p_token TEXT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, extensions, pg_temp
AS $$
    SELECT jsonb_build_object(
        'title', f.title,
        'instructions', f.instructions,
        'fields', f.fields,
        'dueAt', f.due_at,
        'from', (SELECT c.client_name FROM tenancy.clients AS c WHERE c.id = f.client_id)
    )
    FROM ops.workflow_forms AS f
    WHERE p_token ~ '^[0-9a-f]{48}$'
      AND f.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      AND f.token_expires_at > NOW()
      AND f.status = 'OPEN';
$$;

CREATE OR REPLACE FUNCTION public.workflow_portal_submit(p_token TEXT, p_outcome TEXT, p_answers JSONB DEFAULT '{}', p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, extensions, pg_temp
AS $$
DECLARE
    v_form ops.workflow_forms;
    v_problem TEXT;
BEGIN
    IF p_outcome NOT IN ('SUBMITTED', 'DECLINED') THEN
        RAISE EXCEPTION 'A form is submitted or declined' USING ERRCODE = '22023';
    END IF;
    IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN
        RAISE EXCEPTION 'This link is not valid' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_form FROM ops.workflow_forms
     WHERE token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') AND token_expires_at > NOW() AND status = 'OPEN'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This link has expired or the form was already answered' USING ERRCODE = 'P0002';
    END IF;
    IF p_outcome = 'SUBMITTED' THEN
        v_problem := ops.workflow_form_check(v_form.fields, COALESCE(p_answers, '{}'::jsonb));
        IF v_problem IS NOT NULL THEN
            RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
        END IF;
    END IF;
    UPDATE ops.workflow_forms
       SET status = p_outcome, answers = CASE WHEN p_outcome = 'SUBMITTED' THEN p_answers END, note = NULLIF(left(btrim(COALESCE(p_note, '')), 2000), ''),
           submitted_by_external = external_email, submitted_at = NOW(), token_hash = NULL
     WHERE id = v_form.id
    RETURNING * INTO v_form;
    PERFORM ops.workflow_log(v_form.run_id, v_form.node_id, 'form.answered', 'USER', NULL,
        CASE WHEN p_outcome = 'SUBMITTED' THEN 'Form filled in by ' ELSE 'Form declined by ' END || v_form.external_email,
        jsonb_build_object('formId', v_form.id, 'outcome', p_outcome, 'external', TRUE));
    PERFORM ops.workflow_queue_advance(v_form.run_id, v_form.client_id, NULL);
    RETURN jsonb_build_object('status', v_form.status);
END;
$$;

-- ---------------------------------------------------------------------------
-- Outbound lookups for the worker
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_worker_connection(p_client_id UUID, p_code TEXT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, vault, pg_temp
AS $$
    SELECT jsonb_build_object(
        'connection', to_jsonb(c) - 'secret_id',
        'secret', (SELECT s.decrypted_secret FROM vault.decrypted_secrets AS s WHERE s.id = c.secret_id)
    )
    FROM ops.connections AS c
    WHERE c.client_id = p_client_id AND upper(c.connection_code) = upper(btrim(p_code));
$$;

CREATE OR REPLACE FUNCTION public.workflow_worker_slack(p_client_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT slack_webhook_url FROM ops.notification_settings WHERE client_id = p_client_id;
$$;

-- Cancelling a run also closes its open forms.
CREATE OR REPLACE FUNCTION ops.workflow_forms_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
        UPDATE ops.workflow_forms SET status = 'CANCELLED', token_hash = NULL WHERE run_id = NEW.id AND status = 'OPEN';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workflow_forms_cancel ON ops.workflow_runs;
CREATE TRIGGER workflow_forms_cancel AFTER UPDATE OF status ON ops.workflow_runs
    FOR EACH ROW EXECUTE FUNCTION ops.workflow_forms_cancel();

REVOKE ALL ON FUNCTION public.workflow_worker_spawn(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_run_children(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ops.workflow_form_check(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_worker_form(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.workflow_form_blocker(ops.workflow_forms) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_form_view(ops.workflow_forms) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_forms_list(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_form_submit(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_portal_get(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_portal_submit(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_worker_connection(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workflow_worker_slack(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.workflow_forms_cancel() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.workflow_worker_spawn(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_run_children(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_form(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_forms_list(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_form_submit(UUID, TEXT, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_portal_get(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_portal_submit(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_connection(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_slack(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
