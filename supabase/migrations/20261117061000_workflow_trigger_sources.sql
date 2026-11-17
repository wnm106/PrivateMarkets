-- Two more things a workflow trigger can watch (see 20261117030000):
--   BREACH        a compliance rule result that is a breach, where the result
--                 before it for the same rule, record, and grouping was not.
--                 Narrowed by rule codes and by soft or hard. The run is given
--                 the breached records (usually funds) as its filters.
--   VALUE_CHANGE  a new current value recorded for one of the attributes the
--                 trigger names (1 to 20; naming none is refused, so a trigger
--                 cannot fire on every value). Narrowed by type of record. The
--                 run is given the records whose values changed.
-- Both are woken as soon as results or values are written, and by the 5
-- minute schedule.

ALTER TABLE ops.workflow_triggers DROP CONSTRAINT IF EXISTS workflow_triggers_source_check;
ALTER TABLE ops.workflow_triggers ADD CONSTRAINT workflow_triggers_source_check
    CHECK (source IN ('FEED', 'DQ_FAILURES', 'BREACH', 'VALUE_CHANGE'));

COMMENT ON COLUMN ops.workflow_triggers.match IS 'FEED: { kinds, feedCodes }. DQ_FAILURES: { severities, ruleCodes, domainCodes }. BREACH: { ruleCodes, statuses }. VALUE_CHANGE: { attributeCodes, domainCodes }. An empty list matches everything, except attributeCodes, which must name 1 to 20.';

CREATE INDEX IF NOT EXISTS compliance_results_evaluated ON compliance.rule_evaluation_results (evaluated_at, id);
CREATE INDEX IF NOT EXISTS eav_attribute_created ON golden_master.entity_attribute_values (attribute_id, created_at, id);

-- New breaches for a trigger since its cursor. Reads up to 2000 breach
-- results; lastAt and lastId are the last one read, whether or not it was new.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_breaches(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, compliance, entity_instances, pg_temp
AS $$
    WITH scanned AS (
        SELECT res.id, res.evaluated_at, res.rule_id, res.anchor_entity_id, res.group_by_value, res.status, res.computed_value, res.as_of_date,
               r.rule_code, m.entity_code
        FROM compliance.rule_evaluation_results AS res
        JOIN compliance.rules AS r ON r.id = res.rule_id
        JOIN entity_instances.master_entities AS m ON m.id = res.anchor_entity_id
        WHERE m.client_id = p_trigger.client_id
          AND res.status IN ('SOFT_BREACH', 'HARD_BREACH')
          AND (res.evaluated_at, res.id) > (p_trigger.cursor_at, COALESCE(p_trigger.cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
        ORDER BY res.evaluated_at, res.id
        LIMIT 2000
    ),
    fits AS (
        SELECT s.*, row_number() OVER (ORDER BY s.evaluated_at, s.id) AS rn
        FROM scanned AS s
        WHERE (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'ruleCodes')) = 0
               OR upper(s.rule_code) = ANY (ops.workflow_trigger_list(p_trigger.match -> 'ruleCodes')))
          AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'statuses')) = 0
               OR s.status = ANY (ops.workflow_trigger_list(p_trigger.match -> 'statuses')))
          -- New: the result before it for the same rule, record, and grouping was not a breach.
          AND NOT EXISTS (
              SELECT 1 FROM (
                  SELECT prior.status
                  FROM compliance.rule_evaluation_results AS prior
                  WHERE prior.rule_id = s.rule_id
                    AND prior.anchor_entity_id = s.anchor_entity_id
                    AND COALESCE(prior.group_by_value, '') = COALESCE(s.group_by_value, '')
                    AND (prior.evaluated_at, prior.id) < (s.evaluated_at, s.id)
                  ORDER BY prior.evaluated_at DESC, prior.id DESC
                  LIMIT 1
              ) AS last_one
              WHERE last_one.status IN ('SOFT_BREACH', 'HARD_BREACH')
          )
    )
    SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'entityId', f.anchor_entity_id, 'entityCode', f.entity_code, 'ruleCode', f.rule_code, 'status', f.status,
                     'value', f.computed_value, 'asOf', f.as_of_date, 'group', f.group_by_value) ORDER BY f.rn)
                   FROM fits AS f WHERE f.rn <= 50), '[]'::jsonb),
        'entityIds', COALESCE((SELECT to_jsonb(array_agg(DISTINCT f.anchor_entity_id)) FROM fits AS f), '[]'::jsonb),
        'count', (SELECT count(*) FROM fits),
        'lastAt', (SELECT max(s.evaluated_at) FROM scanned AS s),
        'lastId', (SELECT s.id FROM scanned AS s ORDER BY s.evaluated_at DESC, s.id DESC LIMIT 1)
    );
$$;

-- New current values for a trigger's attributes since its cursor, up to 2000.
CREATE OR REPLACE FUNCTION ops.workflow_trigger_value_changes(p_trigger ops.workflow_triggers)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, golden_master, entity_instances, metadata_register, pg_temp
AS $$
    WITH attrs AS (
        SELECT ar.id, ar.attribute_code
        FROM metadata_register.attribute_register AS ar
        WHERE upper(ar.attribute_code) = ANY (ops.workflow_trigger_list(p_trigger.match -> 'attributeCodes'))
    ),
    scanned AS (
        SELECT v.id, v.created_at, v.entity_id, v.golden_value, a.attribute_code, m.entity_code, m.domain_code
        FROM golden_master.entity_attribute_values AS v
        JOIN attrs AS a ON a.id = v.attribute_id
        JOIN entity_instances.master_entities AS m ON m.id = v.entity_id
        WHERE m.client_id = p_trigger.client_id
          AND v.system_to = golden_master.open_system_to()
          AND v.created_at IS NOT NULL
          AND (v.created_at, v.id) > (p_trigger.cursor_at, COALESCE(p_trigger.cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
          AND (cardinality(ops.workflow_trigger_list(p_trigger.match -> 'domainCodes')) = 0
               OR upper(m.domain_code) = ANY (ops.workflow_trigger_list(p_trigger.match -> 'domainCodes')))
        ORDER BY v.created_at, v.id
        LIMIT 2000
    ),
    numbered AS (SELECT s.*, row_number() OVER (ORDER BY s.created_at, s.id) AS rn FROM scanned AS s)
    SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'entityId', n.entity_id, 'entityCode', n.entity_code, 'attributeCode', n.attribute_code,
                     'value', left(n.golden_value, 200)) ORDER BY n.rn)
                   FROM numbered AS n WHERE n.rn <= 50), '[]'::jsonb),
        'entityIds', COALESCE((SELECT to_jsonb((array_agg(DISTINCT n.entity_id))[1:500]) FROM numbered AS n), '[]'::jsonb),
        'count', (SELECT count(*) FROM scanned),
        'lastAt', (SELECT max(s.created_at) FROM scanned AS s),
        'lastId', (SELECT s.id FROM scanned AS s ORDER BY s.created_at DESC, s.id DESC LIMIT 1)
    );
$$;

-- As in 20261117030000, accepting the two new sources.
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
    ELSE
        RAISE EXCEPTION 'A trigger watches feeds, data quality failures, compliance breaches, or value changes' USING ERRCODE = '22023';
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

-- As in 20261117030000, for all four sources.
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
        IF v_trigger.source <> 'FEED' THEN
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

-- Wake the job when breach results or values are written. Statement-level, and
-- never fails the statement that wrote them.
CREATE OR REPLACE FUNCTION ops.workflow_triggers_wake_breach()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM new_rows WHERE status IN ('SOFT_BREACH', 'HARD_BREACH')) THEN
        PERFORM ops.workflow_triggers_wake('BREACH');
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ops.workflow_triggers_wake_values()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
BEGIN
    PERFORM ops.workflow_triggers_wake('VALUE_CHANGE');
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workflow_triggers_wake ON compliance.rule_evaluation_results;
CREATE TRIGGER workflow_triggers_wake
    AFTER INSERT ON compliance.rule_evaluation_results
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION ops.workflow_triggers_wake_breach();

DROP TRIGGER IF EXISTS workflow_triggers_wake ON golden_master.entity_attribute_values;
CREATE TRIGGER workflow_triggers_wake
    AFTER INSERT ON golden_master.entity_attribute_values
    FOR EACH STATEMENT EXECUTE FUNCTION ops.workflow_triggers_wake_values();

REVOKE ALL ON FUNCTION ops.workflow_trigger_breaches(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_trigger_value_changes(ops.workflow_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_triggers_wake_breach() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.workflow_triggers_wake_values() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_trigger_save(UUID, UUID, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_run_workflow_triggers(TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
