-- A fifth thing a workflow trigger can watch (see 20261117030000 and
-- 20261117061000):
--   REPORT  a stored file read as a filed report (a 10-Q, a 10-K, an annual
--           report), however it arrived: an upload in Load data, a feed, or an
--           email attachment. Narrowed by the reporting entity's name. Each run
--           is given one report, as importInstanceId, and the next report starts
--           the next run, so a NAV reconciliation runs once per filing.
--
-- The file says so itself: when a stored file is read as a financial report,
-- a REPORT_RECEIVED event is recorded with the entity, form and period end the
-- reader found, and the trigger job is woken.

ALTER TABLE ops.workflow_triggers DROP CONSTRAINT IF EXISTS workflow_triggers_source_check;
ALTER TABLE ops.workflow_triggers ADD CONSTRAINT workflow_triggers_source_check
    CHECK (source IN ('FEED', 'DQ_FAILURES', 'BREACH', 'VALUE_CHANGE', 'REPORT'));

COMMENT ON COLUMN ops.workflow_triggers.match IS 'FEED: { kinds, feedCodes }. DQ_FAILURES: { severities, ruleCodes, domainCodes }. BREACH: { ruleCodes, statuses }. VALUE_CHANGE: { attributeCodes, domainCodes }. REPORT: { entityNames }, each matched anywhere in the entity name the report gives. An empty list matches everything, except attributeCodes, which must name 1 to 20.';

-- What a stored report says it is, from the About table the report reader stores with it.
CREATE OR REPLACE FUNCTION entity_instances.import_report_about(p_tables JSONB, p_field TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT NULLIF(btrim(r ->> 'Value'), '')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_tables) = 'array' THEN p_tables ELSE '[]'::jsonb END) AS t,
         jsonb_array_elements(CASE WHEN jsonb_typeof(t -> 'rows') = 'array' THEN t -> 'rows' ELSE '[]'::jsonb END) AS r
    WHERE t ->> 'id' = 'report-about'
      AND r ->> 'Field' = p_field
    LIMIT 1;
$$;

-- Records that a stored file was read as a filed report: once, when it is stored or first read that way.
CREATE OR REPLACE FUNCTION entity_instances.import_report_received()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, entity_instances, pg_temp
AS $$
DECLARE
    v_entity TEXT;
    v_form TEXT;
    v_period TEXT;
BEGIN
    IF NEW.intake_method IS DISTINCT FROM 'financial_report' OR NEW.client_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.intake_method IS NOT DISTINCT FROM 'financial_report' THEN
        RETURN NULL;
    END IF;
    v_entity := entity_instances.import_report_about(NEW.tables, 'Entity');
    v_form := entity_instances.import_report_about(NEW.tables, 'Form');
    v_period := entity_instances.import_report_about(NEW.tables, 'Period end');
    INSERT INTO ops.activity_events (client_id, kind, subject_type, subject_id, subject_code, summary, payload)
    VALUES (
        NEW.client_id, 'REPORT_RECEIVED', 'IMPORT', NEW.id, left(NEW.file_name, 100),
        left(concat_ws(' ', NEW.file_name, 'was read as a', NULLIF(concat_ws(' ', v_form, 'filed report'), ''),
                       CASE WHEN v_entity IS NOT NULL THEN 'of ' || v_entity END,
                       CASE WHEN v_period IS NOT NULL THEN 'at ' || v_period END) || '.', 500),
        jsonb_build_object('importInstanceId', NEW.id, 'file', NEW.file_name, 'entityName', v_entity, 'form', v_form, 'periodEnd', v_period)
    );
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    -- Storing the file never fails because its event could not be written.
    RAISE WARNING 'Could not record that % was read as a filed report: %', NEW.id, SQLERRM;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS import_report_received ON entity_instances.import_instances;
CREATE TRIGGER import_report_received
    AFTER INSERT OR UPDATE OF intake_method ON entity_instances.import_instances
    FOR EACH ROW EXECUTE FUNCTION entity_instances.import_report_received();

CREATE INDEX IF NOT EXISTS activity_events_reports ON ops.activity_events (client_id, occurred_at, id) WHERE kind = 'REPORT_RECEIVED';

-- The next report for a trigger since its cursor: one a run, the first that fits.
-- lastAt and lastId are that report's event, or the last one read when none fit.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_reports(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    WITH scanned AS (
        SELECT e.id, e.occurred_at, e.subject_id, e.payload
        FROM ops.activity_events AS e
        WHERE e.client_id = p_trigger.client_id
          AND e.kind = 'REPORT_RECEIVED'
          AND e.subject_type = 'IMPORT'
          AND (e.occurred_at, e.id) > (p_trigger.cursor_at, COALESCE(p_trigger.cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
        ORDER BY e.occurred_at, e.id
        LIMIT 200
    ),
    fit AS (
        SELECT s.*
        FROM scanned AS s
        WHERE cardinality(ops.workflow_trigger_list(p_trigger.match -> 'entityNames')) = 0
           OR EXISTS (
               SELECT 1 FROM unnest(ops.workflow_trigger_list(p_trigger.match -> 'entityNames')) AS wanted
               WHERE strpos(upper(COALESCE(s.payload ->> 'entityName', '')), wanted) > 0
           )
        ORDER BY s.occurred_at, s.id
        LIMIT 1
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM fit) THEN jsonb_build_object(
               'items', (SELECT jsonb_build_array(jsonb_build_object(
                   'importInstanceId', f.subject_id, 'file', f.payload ->> 'file', 'entityName', f.payload ->> 'entityName',
                   'form', f.payload ->> 'form', 'periodEnd', f.payload ->> 'periodEnd', 'at', f.occurred_at)) FROM fit AS f),
               'lastAt', (SELECT f.occurred_at FROM fit AS f),
               'lastId', (SELECT f.id FROM fit AS f),
               'count', 1)
           ELSE jsonb_build_object(
               'items', '[]'::jsonb,
               'lastAt', (SELECT max(s.occurred_at) FROM scanned AS s),
               'lastId', (SELECT s.id FROM scanned AS s ORDER BY s.occurred_at DESC, s.id DESC LIMIT 1),
               'count', 0)
           END;
$$;

-- As in 20261117061000, accepting filed reports.
CREATE OR REPLACE FUNCTION public.workflow_trigger_save(
    p_id UUID,
    p_workflow_id UUID,
    p_name TEXT,
    p_source TEXT,
    p_match JSONB DEFAULT '{}',
    p_input JSONB DEFAULT '{}',
    p_is_active BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_workflow ops.workflows;
    v_client UUID;
    v_clients UUID[];
    v_source TEXT := upper(btrim(COALESCE(p_source, '')));
    v_match JSONB := CASE WHEN jsonb_typeof(p_match) = 'object' THEN p_match ELSE '{}'::jsonb END;
    v_input JSONB := CASE WHEN jsonb_typeof(p_input) = 'object' THEN p_input ELSE '{}'::jsonb END;
    v_kinds TEXT[];
    v_attrs TEXT[];
    v_unknown TEXT;
    v_trigger ops.workflow_triggers;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to set up a trigger' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_workflow FROM ops.workflows WHERE id = p_workflow_id AND is_active;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_workflow.client_id) THEN
        RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_workflow.client_id IS NOT NULL THEN
        v_client := v_workflow.client_id;
    ELSE
        SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
        IF v_clients IS NULL OR cardinality(v_clients) <> 1 THEN
            RAISE EXCEPTION 'Choose one client before setting up a trigger on a shared workflow' USING ERRCODE = '22023';
        END IF;
        v_client := v_clients[1];
    END IF;
    IF NOT ops.workflow_can(v_client, 'workflow.manage') OR NOT ops.workflow_can(v_client, 'workflow.run') THEN
        RAISE EXCEPTION 'Setting up a trigger needs permission to manage and to run workflows' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(COALESCE(p_name, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Give the trigger a name' USING ERRCODE = '22023';
    END IF;

    IF v_source = 'FEED' THEN
        v_kinds := ops.workflow_trigger_list(v_match -> 'kinds');
        IF EXISTS (SELECT 1 FROM unnest(v_kinds) AS k WHERE k NOT IN ('FEED_LOADED', 'FEED_NEEDS_REVIEW', 'FEED_FAILED', 'FEED_LATE')) THEN
            RAISE EXCEPTION 'A feed trigger watches FEED_LOADED, FEED_NEEDS_REVIEW, FEED_FAILED, or FEED_LATE' USING ERRCODE = '22023';
        END IF;
        v_match := jsonb_build_object('kinds', to_jsonb(v_kinds), 'feedCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'feedCodes')));
    ELSIF v_source = 'DQ_FAILURES' THEN
        IF EXISTS (SELECT 1 FROM unnest(ops.workflow_trigger_list(v_match -> 'severities')) AS s WHERE s NOT IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')) THEN
            RAISE EXCEPTION 'Severities are CRITICAL, HIGH, MEDIUM, and LOW' USING ERRCODE = '22023';
        END IF;
        v_match := jsonb_build_object(
            'severities', to_jsonb(ops.workflow_trigger_list(v_match -> 'severities')),
            'ruleCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'ruleCodes')),
            'domainCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'domainCodes'))
        );
    ELSIF v_source = 'BREACH' THEN
        IF EXISTS (SELECT 1 FROM unnest(ops.workflow_trigger_list(v_match -> 'statuses')) AS s WHERE s NOT IN ('SOFT_BREACH', 'HARD_BREACH')) THEN
            RAISE EXCEPTION 'A breach is SOFT_BREACH or HARD_BREACH' USING ERRCODE = '22023';
        END IF;
        v_match := jsonb_build_object(
            'ruleCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'ruleCodes')),
            'statuses', to_jsonb(ops.workflow_trigger_list(v_match -> 'statuses'))
        );
    ELSIF v_source = 'VALUE_CHANGE' THEN
        v_attrs := ops.workflow_trigger_list(v_match -> 'attributeCodes');
        IF cardinality(v_attrs) = 0 OR cardinality(v_attrs) > 20 THEN
            RAISE EXCEPTION 'Name 1 to 20 attributes whose changes start a run' USING ERRCODE = '22023';
        END IF;
        SELECT string_agg(a, ', ') INTO v_unknown
        FROM unnest(v_attrs) AS a
        WHERE NOT EXISTS (SELECT 1 FROM metadata_register.attribute_register AS ar WHERE upper(ar.attribute_code) = a);
        IF v_unknown IS NOT NULL THEN
            RAISE EXCEPTION 'There is no attribute %', v_unknown USING ERRCODE = '22023';
        END IF;
        v_match := jsonb_build_object('attributeCodes', to_jsonb(v_attrs), 'domainCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'domainCodes')));
    ELSIF v_source = 'REPORT' THEN
        v_match := jsonb_build_object('entityNames', to_jsonb(ops.workflow_trigger_list(v_match -> 'entityNames')));
    ELSE
        RAISE EXCEPTION 'A trigger watches feeds, data quality failures, compliance breaches, value changes, or filed reports' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO ops.workflow_triggers (client_id, workflow_id, trigger_name, source, match, input, is_active, created_by)
        VALUES (v_client, v_workflow.id, btrim(p_name), v_source, v_match, v_input, COALESCE(p_is_active, TRUE), auth.uid())
        RETURNING * INTO v_trigger;
    ELSE
        UPDATE ops.workflow_triggers
           SET trigger_name = btrim(p_name), source = v_source, match = v_match, input = v_input,
               is_active = COALESCE(p_is_active, TRUE), created_by = auth.uid(),
               cursor_at = CASE WHEN (NOT is_active AND COALESCE(p_is_active, TRUE)) OR source <> v_source THEN NOW() ELSE cursor_at END,
               cursor_id = CASE WHEN (NOT is_active AND COALESCE(p_is_active, TRUE)) OR source <> v_source THEN NULL ELSE cursor_id END,
               updated_at = NOW()
         WHERE id = p_id AND workflow_id = v_workflow.id AND client_id = v_client
        RETURNING * INTO v_trigger;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Trigger was not found' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    RETURN ops.workflow_trigger_view(v_trigger);
END;
$$;

-- As in 20261117061000, giving a report trigger's run its file.
CREATE OR REPLACE FUNCTION public.job_run_workflow_triggers(p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_trigger ops.workflow_triggers;
    v_code TEXT;
    v_found JSONB;
    v_count INTEGER;
    v_input JSONB;
    v_filters JSONB;
    v_job UUID;
    v_fired INTEGER := 0;
    v_busy INTEGER := 0;
    v_checked INTEGER := 0;
BEGIN
    FOR v_trigger IN
        SELECT t.* FROM ops.workflow_triggers AS t
        JOIN ops.workflows AS w ON w.id = t.workflow_id AND w.is_active
        WHERE t.is_active
        ORDER BY t.created_at
        FOR UPDATE OF t SKIP LOCKED
    LOOP
        v_checked := v_checked + 1;
        IF ops.workflow_trigger_busy(v_trigger.last_job_id) THEN
            v_busy := v_busy + 1;
            CONTINUE;
        END IF;

        v_found := CASE v_trigger.source
            WHEN 'FEED' THEN ops.workflow_trigger_feed_events(v_trigger)
            WHEN 'DQ_FAILURES' THEN ops.workflow_trigger_dq_failures(v_trigger)
            WHEN 'BREACH' THEN ops.workflow_trigger_breaches(v_trigger)
            WHEN 'REPORT' THEN ops.workflow_trigger_reports(v_trigger)
            ELSE ops.workflow_trigger_value_changes(v_trigger)
        END;
        v_count := COALESCE((v_found ->> 'count')::int, 0);

        IF v_count = 0 THEN
            -- What was read and did not fit is passed over, so it is not read again.
            IF v_found ->> 'lastId' IS NOT NULL THEN
                UPDATE ops.workflow_triggers
                   SET cursor_at = (v_found ->> 'lastAt')::timestamptz, cursor_id = (v_found ->> 'lastId')::uuid, updated_at = NOW()
                 WHERE id = v_trigger.id;
            END IF;
            CONTINUE;
        END IF;

        SELECT workflow_code INTO v_code FROM ops.workflows WHERE id = v_trigger.workflow_id;
        v_input := CASE WHEN jsonb_typeof(v_trigger.input) = 'object' THEN v_trigger.input ELSE '{}'::jsonb END;
        IF v_trigger.source = 'REPORT' THEN
            -- A run works on one report: the stored file that started it.
            v_input := v_input || jsonb_build_object('importInstanceId', v_found -> 'items' -> 0 ->> 'importInstanceId');
        ELSIF v_trigger.source <> 'FEED' THEN
            -- The run works on the records that started it, within any filters the trigger sets.
            v_filters := CASE WHEN jsonb_typeof(v_input -> 'filters') = 'object' THEN v_input -> 'filters' ELSE '{}'::jsonb END;
            v_input := v_input || jsonb_build_object('filters', v_filters || jsonb_build_object('entityIds', v_found -> 'entityIds'));
        END IF;
        v_input := v_input || jsonb_build_object('trigger', jsonb_build_object(
            'triggerId', v_trigger.id,
            'name', v_trigger.trigger_name,
            'source', v_trigger.source,
            'count', v_count,
            'items', v_found -> 'items'
        ));

        INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key, requested_by)
        VALUES (v_trigger.client_id, 'workflow.start', jsonb_build_object('workflowCode', v_code, 'input', v_input), 3,
                'workflow-trigger:' || v_trigger.id::text, v_trigger.created_by)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING
        RETURNING id INTO v_job;
        IF v_job IS NULL THEN
            v_busy := v_busy + 1;
            CONTINUE;
        END IF;

        UPDATE ops.workflow_triggers
           SET cursor_at = (v_found ->> 'lastAt')::timestamptz,
               cursor_id = (v_found ->> 'lastId')::uuid,
               last_job_id = v_job,
               last_fired_at = COALESCE(p_now, NOW()),
               last_count = v_count,
               updated_at = NOW()
         WHERE id = v_trigger.id;
        v_fired := v_fired + 1;
    END LOOP;

    RETURN jsonb_build_object('checked', v_checked, 'fired', v_fired, 'busy', v_busy);
END;
$$;

-- As in 20261117030000, waking the report trigger too.
CREATE OR REPLACE FUNCTION ops.workflow_triggers_wake_events()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM new_rows WHERE subject_type = 'FEED') THEN
        PERFORM ops.workflow_triggers_wake('FEED');
    END IF;
    IF EXISTS (SELECT 1 FROM new_rows WHERE kind = 'DQ_NEW_FAILURES') THEN
        PERFORM ops.workflow_triggers_wake('DQ_FAILURES');
    END IF;
    IF EXISTS (SELECT 1 FROM new_rows WHERE kind = 'REPORT_RECEIVED') THEN
        PERFORM ops.workflow_triggers_wake('REPORT');
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION ops.workflow_trigger_reports(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION entity_instances.import_report_received() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
