-- Starting a workflow when something happens.
--
-- A trigger belongs to one client and one workflow. It watches one source:
--   FEED          a feed loaded a file, has one waiting for review, failed, or
--                 is late (the FEED_* activity events the feeds write).
--   DQ_FAILURES   a data quality scan found records that began failing a rule,
--                 or lost a required value, since the day before. dq.scan now
--                 records this as a DQ_NEW_FAILURES activity event.
-- and says, like a schedule, what the run starts with (input). Events are not
-- acted on one by one. The platform job workflow.triggers gathers what is new
-- since a trigger last fired and starts one run for all of it, through the
-- workflow.start job, as the person who created the trigger. For data quality
-- failures, the run is given those records as its filters, so it works on
-- them only.
--
-- Data quality is checked live. dq_exceptions holds only failures a person
-- accepted, so it is not a source: the scan's comparison with the day before
-- is what says a failure is new.
--
-- A trigger keeps at most one run going. While its run is queued, running, or
-- waiting for a review, new events wait, and the next run takes them all.
--
-- workflow.triggers is queued as soon as a feed or scan event is written, and
-- also runs every 5 minutes in case that was missed.

CREATE TABLE IF NOT EXISTS ops.workflow_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES ops.workflows(id) ON DELETE CASCADE,
    trigger_name TEXT NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('FEED', 'DQ_FAILURES')),
    match JSONB NOT NULL DEFAULT '{}',
    input JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL,
    cursor_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cursor_id UUID,
    last_job_id UUID,
    last_fired_at TIMESTAMPTZ,
    last_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_triggers_active ON ops.workflow_triggers (source, client_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS workflow_triggers_workflow ON ops.workflow_triggers (workflow_id);
CREATE INDEX IF NOT EXISTS activity_events_kind_time ON ops.activity_events (client_id, kind, occurred_at, id);

ALTER TABLE ops.workflow_triggers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.workflow_triggers IS 'Starts a workflow run when a feed event or new data quality failures arrive. Reached only through the workflow_trigger* functions.';
COMMENT ON COLUMN ops.workflow_triggers.match IS 'FEED: { kinds, feedCodes }. DQ_FAILURES: { severities, ruleCodes, domainCodes }. An empty list matches everything.';
COMMENT ON COLUMN ops.workflow_triggers.cursor_at IS 'Events at or before (cursor_at, cursor_id) have been acted on. Starts when the trigger is made: nothing earlier is picked up.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The text values of a JSON list, trimmed and upper-cased. Empty for anything else.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_list(p_value JSONB)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(array_agg(DISTINCT upper(btrim(x))) FILTER (WHERE btrim(x) <> ''), '{}')
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE '[]'::jsonb END) AS x;
$$;

-- Whether a trigger's last run is still going: its start job is open, or the
-- run that job started has not finished.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_busy(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT p_job_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM ops.job_runs AS j
        WHERE j.id = p_job_id
          AND (
              j.status IN ('QUEUED', 'RUNNING')
              OR (j.status = 'SUCCEEDED' AND EXISTS (
                  SELECT 1 FROM ops.workflow_runs AS r
                  WHERE r.id::text = j.result ->> 'workflowRunId'
                    AND r.status IN ('QUEUED', 'RUNNING', 'WAITING')
              ))
          )
    );
$$;

-- A trigger as the pages show it.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_view(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT (to_jsonb(p_trigger) - 'cursor_id') || jsonb_build_object(
        'created_by_name', (SELECT display_name FROM tenancy.profiles WHERE id = p_trigger.created_by),
        'busy', ops.workflow_trigger_busy(p_trigger.last_job_id),
        'last_job', (
            SELECT jsonb_build_object('status', j.status, 'error', j.error_message, 'workflowRunId', j.result ->> 'workflowRunId', 'finishedAt', j.finished_at)
            FROM ops.job_runs AS j WHERE j.id = p_trigger.last_job_id
        ),
        'can_manage', ops.workflow_can(p_trigger.client_id, 'workflow.manage')
    );
$$;

-- ---------------------------------------------------------------------------
-- What people use
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_triggers_list(p_workflow_id UUID)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.workflow_trigger_view(t)
    FROM ops.workflow_triggers AS t
    WHERE t.workflow_id = p_workflow_id AND ops.workflow_can_see(t.client_id)
    ORDER BY t.created_at;
$$;

-- Creates (p_id NULL) or changes a trigger. The caller must manage workflows
-- in the client and be allowed to run them: the trigger starts runs as them.
-- Changing a trigger makes the caller its owner.
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
    v_trigger ops.workflow_triggers;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to set up a trigger' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_workflow FROM ops.workflows WHERE id = p_workflow_id AND is_active;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_workflow.client_id) THEN
        RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
    END IF;

    -- A client's own workflow is triggered in that client. A shared workflow
    -- is triggered in the one client this session acts in.
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

    IF v_source NOT IN ('FEED', 'DQ_FAILURES') THEN
        RAISE EXCEPTION 'A trigger watches feeds or data quality failures' USING ERRCODE = '22023';
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
    ELSE
        IF EXISTS (SELECT 1 FROM unnest(ops.workflow_trigger_list(v_match -> 'severities')) AS s WHERE s NOT IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')) THEN
            RAISE EXCEPTION 'Severities are CRITICAL, HIGH, MEDIUM, and LOW' USING ERRCODE = '22023';
        END IF;
        v_match := jsonb_build_object(
            'severities', to_jsonb(ops.workflow_trigger_list(v_match -> 'severities')),
            'ruleCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'ruleCodes')),
            'domainCodes', to_jsonb(ops.workflow_trigger_list(v_match -> 'domainCodes'))
        );
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO ops.workflow_triggers (client_id, workflow_id, trigger_name, source, match, input, is_active, created_by)
        VALUES (v_client, v_workflow.id, btrim(p_name), v_source, v_match, v_input, COALESCE(p_is_active, TRUE), auth.uid())
        RETURNING * INTO v_trigger;
    ELSE
        UPDATE ops.workflow_triggers
           SET trigger_name = btrim(p_name), source = v_source, match = v_match, input = v_input,
               is_active = COALESCE(p_is_active, TRUE), created_by = auth.uid(),
               -- Turning a trigger back on does not act on what arrived while it was off.
               cursor_at = CASE WHEN NOT is_active AND COALESCE(p_is_active, TRUE) THEN NOW() ELSE cursor_at END,
               cursor_id = CASE WHEN NOT is_active AND COALESCE(p_is_active, TRUE) THEN NULL ELSE cursor_id END,
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

CREATE OR REPLACE FUNCTION public.workflow_trigger_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT client_id INTO v_client FROM ops.workflow_triggers WHERE id = p_id;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_client) THEN
        RAISE EXCEPTION 'Trigger was not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT ops.workflow_can(v_client, 'workflow.manage') THEN
        RAISE EXCEPTION 'You cannot change this client''s workflows' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.workflow_triggers WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- The scan says what began failing
-- ---------------------------------------------------------------------------

-- As in 20261114200000, then records the records that began failing a rule, or
-- lost a required value, since the day before, as one DQ_NEW_FAILURES event
-- (up to 500 records). Nothing is recorded when nothing is new. The scan
-- compares with the day before, so a scan run twice in a day reports the same
-- new failures twice: schedule it once a day.
CREATE OR REPLACE FUNCTION public.job_run_dq_scan(
    p_user_id UUID,
    p_client_id UUID,
    p_domain_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '120s'
SET search_path = ops, public, pg_temp
AS $$
DECLARE
    v_report JSONB;
    v_items JSONB;
    v_count INTEGER;
    v_domain TEXT := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
BEGIN
    PERFORM ops.assume_user(p_user_id, p_client_id);
    v_report := public.data_quality_dashboard(v_domain);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'entityId', picked.e ->> 'id',
               'entityCode', picked.e ->> 'entityCode',
               'domainCode', picked.e ->> 'domainCode',
               'rules', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('ruleCode', r ->> 'ruleCode', 'severity', r ->> 'severity'))
                   FROM jsonb_array_elements(COALESCE(picked.e -> 'failingRules', '[]'::jsonb)) AS r
               ), '[]'::jsonb),
               'newRuleFailures', COALESCE((picked.e ->> 'qualityIntroducedCount')::int, 0),
               'newlyMissing', COALESCE((picked.e ->> 'availabilityIntroducedCount')::int, 0)
           )), '[]'::jsonb),
           count(*)
    INTO v_items, v_count
    FROM (
        SELECT ent AS e
        FROM jsonb_array_elements(COALESCE(v_report -> 'entities', '[]'::jsonb)) AS ent
        WHERE COALESCE((ent ->> 'qualityIntroducedCount')::int, 0) > 0
           OR COALESCE((ent ->> 'availabilityIntroducedCount')::int, 0) > 0
        LIMIT 500
    ) AS picked;

    IF v_count > 0 THEN
        INSERT INTO ops.activity_events (client_id, kind, subject_type, subject_code, summary, payload)
        VALUES (
            p_client_id, 'DQ_NEW_FAILURES', 'SCAN', COALESCE(v_domain, 'ALL'),
            format('%s %s began failing data quality checks%s', v_count, CASE WHEN v_count = 1 THEN 'record' ELSE 'records' END,
                   CASE WHEN v_domain IS NULL THEN '' ELSE ' (' || v_domain || ')' END),
            jsonb_build_object('items', v_items, 'domainCode', v_domain, 'fromDate', v_report -> 'fromDate', 'toDate', v_report -> 'toDate')
        );
    END IF;

    RETURN jsonb_build_object(
        'fromDate', v_report -> 'fromDate',
        'toDate', v_report -> 'toDate',
        'domainCode', v_domain,
        'summary', COALESCE(v_report -> 'summary', '{}'::jsonb),
        'newFailures', v_count
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- The job
-- ---------------------------------------------------------------------------

-- Feed events for a trigger since its cursor, up to 500.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_feed_events(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT jsonb_build_object(
               'items', COALESCE(jsonb_agg(jsonb_build_object(
                   'kind', x.kind, 'feedCode', x.subject_code, 'summary', x.summary,
                   'file', x.payload ->> 'file', 'at', x.occurred_at
               ) ORDER BY x.occurred_at, x.id) FILTER (WHERE x.rn <= 50), '[]'::jsonb),
               'lastAt', max(x.occurred_at),
               'lastId', (array_agg(x.id ORDER BY x.occurred_at DESC, x.id DESC))[1],
               'count', count(*)
           )
    FROM (
        SELECT e.*, row_number() OVER (ORDER BY e.occurred_at, e.id) AS rn
        FROM ops.activity_events AS e
        WHERE e.client_id = p_trigger.client_id
          AND e.subject_type = 'FEED'
          AND e.kind IN ('FEED_LOADED', 'FEED_NEEDS_REVIEW', 'FEED_FAILED', 'FEED_LATE')
          AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'kinds')) = 0
               OR e.kind = ANY (ops.workflow_trigger_list(p_trigger.match -> 'kinds')))
          AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'feedCodes')) = 0
               OR upper(e.subject_code) = ANY (ops.workflow_trigger_list(p_trigger.match -> 'feedCodes')))
          AND (e.occurred_at, e.id) > (p_trigger.cursor_at, COALESCE(p_trigger.cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
        ORDER BY e.occurred_at, e.id
        LIMIT 500
    ) AS x;
$$;

-- New data quality failures for a trigger since its cursor: the scan events
-- (up to 20) and, in them, the records that fit. A record fits when one of
-- its failing rules fits the severities and rule codes, or, for a trigger
-- that names neither, whenever it is listed. lastAt and lastId are the last
-- scan event read, whether or not any record in it fit.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_dq_failures(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    WITH events AS (
        SELECT ev.id, ev.occurred_at, ev.payload
        FROM ops.activity_events AS ev
        WHERE ev.client_id = p_trigger.client_id
          AND ev.kind = 'DQ_NEW_FAILURES'
          AND (ev.occurred_at, ev.id) > (p_trigger.cursor_at, COALESCE(p_trigger.cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
        ORDER BY ev.occurred_at, ev.id
        LIMIT 20
    ),
    fits AS (
        SELECT DISTINCT ON ((it ->> 'entityId'))
               (it ->> 'entityId')::uuid AS entity_id, e.occurred_at, e.id AS event_id,
               jsonb_build_object('entityId', it -> 'entityId', 'entityCode', it -> 'entityCode', 'domainCode', it -> 'domainCode',
                                  'rules', it -> 'rules', 'newlyMissing', it -> 'newlyMissing') AS item
        FROM events AS e
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload -> 'items') = 'array' THEN e.payload -> 'items' ELSE '[]'::jsonb END) AS it
        WHERE (it ->> 'entityId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'domainCodes')) = 0
               OR upper(it ->> 'domainCode') = ANY (ops.workflow_trigger_list(p_trigger.match -> 'domainCodes')))
          AND (
              (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'severities')) = 0
               AND cardinality(ops.workflow_trigger_list(p_trigger.match -> 'ruleCodes')) = 0)
              OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(it -> 'rules') = 'array' THEN it -> 'rules' ELSE '[]'::jsonb END) AS ru
                  WHERE (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'severities')) = 0
                         OR upper(ru ->> 'severity') = ANY (ops.workflow_trigger_list(p_trigger.match -> 'severities')))
                    AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'ruleCodes')) = 0
                         OR upper(ru ->> 'ruleCode') = ANY (ops.workflow_trigger_list(p_trigger.match -> 'ruleCodes')))
              )
          )
        ORDER BY (it ->> 'entityId'), e.occurred_at DESC, e.id DESC
    ),
    numbered AS (
        SELECT f.*, row_number() OVER (ORDER BY f.occurred_at, f.event_id, f.entity_id) AS rn FROM fits AS f
    )
    SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(n.item ORDER BY n.rn) FROM numbered AS n WHERE n.rn <= 50), '[]'::jsonb),
        'entityIds', COALESCE((SELECT to_jsonb(array_agg(n.entity_id ORDER BY n.rn)) FROM numbered AS n WHERE n.rn <= 500), '[]'::jsonb),
        'count', (SELECT count(*) FROM fits),
        'lastAt', (SELECT max(e.occurred_at) FROM events AS e),
        'lastId', (SELECT e.id FROM events AS e ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1)
    );
$$;

-- Platform job: for each active trigger that is not busy, gathers what arrived
-- since it last fired and queues one workflow.start for all of it.
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

        v_found := CASE WHEN v_trigger.source = 'FEED'
            THEN ops.workflow_trigger_feed_events(v_trigger)
            ELSE ops.workflow_trigger_dq_failures(v_trigger)
        END;
        v_count := COALESCE((v_found ->> 'count')::int, 0);

        IF v_count = 0 THEN
            -- Scan events with no record that fits are passed over, so they are not read again.
            IF v_found ->> 'lastId' IS NOT NULL THEN
                UPDATE ops.workflow_triggers
                   SET cursor_at = (v_found ->> 'lastAt')::timestamptz, cursor_id = (v_found ->> 'lastId')::uuid, updated_at = NOW()
                 WHERE id = v_trigger.id;
            END IF;
            CONTINUE;
        END IF;

        SELECT workflow_code INTO v_code FROM ops.workflows WHERE id = v_trigger.workflow_id;
        v_input := CASE WHEN jsonb_typeof(v_trigger.input) = 'object' THEN v_trigger.input ELSE '{}'::jsonb END;
        IF v_trigger.source = 'DQ_FAILURES' THEN
            -- The run works on the records that began failing, within any filters the trigger sets.
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

-- Queues workflow.triggers once, when a trigger of that source exists. Never
-- fails the statement that wrote the events: the 5 minute schedule catches up.
CREATE OR REPLACE FUNCTION ops.workflow_triggers_wake(p_source TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM ops.workflow_triggers WHERE is_active AND source = p_source) THEN
        INSERT INTO ops.job_runs (client_id, job_type, payload, max_attempts, dedupe_key)
        VALUES (NULL, 'workflow.triggers', '{}'::jsonb, 3, 'workflow-triggers')
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING') DO NOTHING;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'workflow triggers were not woken: %', SQLERRM;
END;
$$;

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
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workflow_triggers_wake ON ops.activity_events;
CREATE TRIGGER workflow_triggers_wake
    AFTER INSERT ON ops.activity_events
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION ops.workflow_triggers_wake_events();

INSERT INTO ops.job_schedules (
    client_id, schedule_code, schedule_name, job_type, payload, cron_expression,
    timezone, is_active, max_attempts, next_run_at, created_by
)
SELECT NULL, 'WORKFLOW_TRIGGERS', 'Workflow triggers', 'workflow.triggers', '{}'::jsonb,
       '*/5 * * * *', 'UTC', TRUE, 3, NOW(), NULL
WHERE NOT EXISTS (
    SELECT 1 FROM ops.job_schedules WHERE client_id IS NULL AND schedule_code = 'WORKFLOW_TRIGGERS'
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.workflow_trigger_list(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_trigger_busy(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_trigger_view(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_trigger_feed_events(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_trigger_dq_failures(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_triggers_wake(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_triggers_wake_events() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.workflow_triggers_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_trigger_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_run_dq_scan(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.workflow_triggers_list(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_trigger_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_run_dq_scan(UUID, UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
