-- Function lockdown.
--
-- PostgREST exposes every function in the API schemas, so a function's grants
-- and its own checks are the only wall between an API caller and what it does.
-- Three things were wrong:
--
--   1. Postgres grants EXECUTE on every new function to PUBLIC, and Supabase
--      also grants functions in public to anon by name. A migration that ran
--      REVOKE ... FROM PUBLIC left the anon grant in place, so functions meant
--      for the service role only were open to callers with no login.
--   2. Several SECURITY DEFINER functions took an id and trusted it, with no
--      check that the caller may see that record or client.
--   3. Four formula functions ran any text starting with SELECT as the owner.
--
-- From here on a new function is callable by nobody until a migration grants
-- it. See docs/MIGRATIONS.md, "Function grants".

-- ============================================================
-- 1. Leftover debug functions
-- ============================================================
-- Each returned every client's data to any caller, including with no login.
DROP FUNCTION IF EXISTS public.check_client_setup();
DROP FUNCTION IF EXISTS public.check_entity_master_view();
-- These read a role from sign-up metadata, which the user can edit. Nothing
-- calls them; removing them keeps anyone from building an access check on it.
DROP FUNCTION IF EXISTS public.check_user_role(TEXT);
DROP FUNCTION IF EXISTS public.get_current_user_role();

-- ============================================================
-- 2. No function is callable by PUBLIC or with no login
-- ============================================================
-- For every function this project owns in its own schemas: take EXECUTE away
-- from PUBLIC and anon, and give authenticated and service_role exactly what
-- they could already do. Functions that belong to an extension are left alone.
DO $$
DECLARE
    f RECORD;
    v_auth BOOLEAN;
    v_service BOOLEAN;
BEGIN
    FOR f IN
        SELECT p.oid, p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN (
                'public', 'metadata_register', 'entity_instances', 'golden_master',
                'data_quality', 'compliance', 'read_projections', 'tenancy',
                'ops', 'docs', 'reporting'
              )
          AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
              )
    LOOP
        v_auth := has_function_privilege('authenticated', f.oid, 'EXECUTE');
        v_service := has_function_privilege('service_role', f.oid, 'EXECUTE');
        EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon', f.signature);
        IF v_auth THEN
            EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO authenticated', f.signature);
        END IF;
        IF v_service THEN
            EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO service_role', f.signature);
        END IF;
    END LOOP;
END;
$$;

-- The two functions a person with no login is meant to reach: a workflow
-- portal link carries a long random token, and the token is the check.
GRANT EXECUTE ON FUNCTION public.workflow_portal_get(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.workflow_portal_submit(TEXT, TEXT, JSONB, TEXT) TO anon;

-- New functions start closed. Functions created in public still reach
-- authenticated and service_role through Supabase's own default grant; in every
-- other schema a migration must grant what it means to open.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
-- The tenancy schema granted every new function to signed-in users. Its
-- functions decide who sees what, so each one is granted by name instead.
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

-- ============================================================
-- 3. Helpers only other functions call
-- ============================================================
-- Each is reached through a SECURITY DEFINER function or trigger that does its
-- own checks. Called directly they answered for any record id.
REVOKE EXECUTE ON FUNCTION tenancy.entity_ancestors(UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION compliance.get_anchor_entities(UUID, DATE, TIMESTAMPTZ) FROM authenticated;
REVOKE EXECUTE ON FUNCTION golden_master.process_calc_invalidations(INTEGER, UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION golden_master.resolve_current_preference(UUID, UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION data_quality.rebuild_compiled_rules() FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.assert_domain_visible_to_client(TEXT, UUID) FROM authenticated;

-- ============================================================
-- 4. Formula functions ran caller-supplied SQL as the owner
-- ============================================================
-- Nothing in the application calls these. They now run with the caller's own
-- rights, and no API role may call them. Calculated attributes use the
-- expression engine (metadata_register.calc_definitions), which takes a parsed
-- expression, not SQL.
ALTER FUNCTION metadata_register.evaluate_simple_formula(UUID, TEXT, DATE) SECURITY INVOKER;
ALTER FUNCTION metadata_register.evaluate_aggregate_formula(UUID, TEXT, DATE) SECURITY INVOKER;
ALTER FUNCTION metadata_register.evaluate_lookup_formula(UUID, TEXT, DATE) SECURITY INVOKER;
ALTER FUNCTION metadata_register.evaluate_custom_formula(UUID, TEXT, DATE) SECURITY INVOKER;
ALTER FUNCTION metadata_register.evaluate_derived_attribute(UUID, VARCHAR, DATE) SECURITY INVOKER;
ALTER FUNCTION metadata_register.evaluate_derived_attributes_batch(UUID, JSONB, DATE) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_simple_formula(UUID, TEXT, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_aggregate_formula(UUID, TEXT, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_lookup_formula(UUID, TEXT, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_custom_formula(UUID, TEXT, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_derived_attribute(UUID, VARCHAR, DATE) FROM authenticated;
REVOKE EXECUTE ON FUNCTION metadata_register.evaluate_derived_attributes_batch(UUID, JSONB, DATE) FROM authenticated;

-- ============================================================
-- 5. Attribute settings follow the attribute table's own row security
-- ============================================================
-- As SECURITY DEFINER this let any caller rewrite any attribute, global ones
-- included. As the caller, the attribute_register policies decide: platform
-- staff for global attributes, a client's editors for that client's own.
ALTER FUNCTION public.update_attribute_aggregation(UUID, VARCHAR, VARCHAR, INTEGER) SECURITY INVOKER;
ALTER FUNCTION public.update_attribute_aggregation(UUID, VARCHAR, VARCHAR, INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION metadata_register.batch_normalize_values(VARCHAR, TEXT[]) SET search_path = metadata_register, pg_temp;

-- ============================================================
-- 6. One check for "may this caller see this record"
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.assert_entity_access(p_entity_id UUID, p_level TEXT DEFAULT 'READ')
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    IF tenancy.is_backend_caller() THEN
        RETURN;
    END IF;
    IF p_entity_id IS NULL OR NOT COALESCE(tenancy.has_entity_access(p_entity_id, p_level), FALSE) THEN
        RAISE EXCEPTION 'You do not have access to this record' USING ERRCODE = '42501';
    END IF;
END;
$$;
COMMENT ON FUNCTION tenancy.assert_entity_access(UUID, TEXT) IS
    'Raises unless the caller may read (or write) the record. Server code (service role, migrations) passes. Put this first in any SECURITY DEFINER function that takes a record id from the caller.';
GRANT EXECUTE ON FUNCTION tenancy.assert_entity_access(UUID, TEXT) TO authenticated, service_role;

-- ============================================================
-- 7. Functions that took an id on trust
-- ============================================================
-- Each body below is the one already in the database with a check added as its
-- first statement. Nothing else in them changes.

CREATE OR REPLACE FUNCTION public.calculated_attribute_states(p_entity_id UUID)
RETURNS TABLE(entity_id UUID, attribute_code VARCHAR, dirty BOOLEAN, status TEXT, window_start DATE, window_end DATE)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT
        me.id,
        ar.attribute_code,
        COALESCE(bool_or(i.status IN ('PENDING', 'RUNNING')), FALSE) AS dirty,
        CASE
            WHEN bool_or(i.status = 'RUNNING') THEN 'RUNNING'
            WHEN bool_or(i.status = 'PENDING') THEN 'PENDING'
            ELSE NULL
        END AS status,
        MIN(i.window_start) FILTER (WHERE i.status IN ('PENDING', 'RUNNING')) AS window_start,
        MAX(i.window_end) FILTER (WHERE i.status IN ('PENDING', 'RUNNING')) AS window_end
    FROM entity_instances.master_entities me
    JOIN metadata_register.calc_definitions cd
      ON cd.domain_code = me.domain_code
     AND cd.evaluation_mode = 'MATERIALIZED'
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    LEFT JOIN golden_master.calc_invalidations i
      ON i.calc_attribute_id = cd.attribute_id
     AND i.entity_id = me.id
     AND i.status IN ('PENDING', 'RUNNING')
    WHERE me.id = p_entity_id
      -- Callers see only records they may read. Server code is trusted.
      AND (tenancy.is_backend_caller() OR tenancy.has_entity_access(p_entity_id, 'READ'))
    GROUP BY me.id, ar.attribute_code;
$$;

-- The platform-wide queue belongs to the worker. Platform staff may also run it.
CREATE OR REPLACE FUNCTION public.process_calculated_attributes(p_limit INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
BEGIN
    IF NOT (tenancy.is_backend_caller() OR tenancy.is_tenant_admin()) THEN
        RAISE EXCEPTION 'Only the job worker or platform staff may process the whole calculation queue'
            USING ERRCODE = '42501';
    END IF;
    RETURN golden_master.process_calc_invalidations(p_limit);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_entity_calculated_attributes(p_entity_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = golden_master, public, pg_temp
AS $$
BEGIN
    PERFORM tenancy.assert_entity_access(p_entity_id, 'READ');
    RETURN golden_master.process_calc_invalidations(LEAST(COALESCE(p_limit, 20), 200), p_entity_id);
END;
$$;

-- A signed-in caller closes only runs they could see, and cannot use a short
-- window to fail a colleague's run that is still working.
CREATE OR REPLACE FUNCTION public.close_stale_narrative_runs(p_minutes INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    closed INTEGER;
    v_backend BOOLEAN := tenancy.is_backend_caller();
    v_minutes INTEGER := CASE
        WHEN tenancy.is_backend_caller() THEN COALESCE(p_minutes, 30)
        ELSE GREATEST(COALESCE(p_minutes, 30), 15)
    END;
BEGIN
    WITH stale AS (
        UPDATE public.narrative_runs r
           SET status = 'FAILED',
               error_message = 'Abandoned: no progress for ' || v_minutes || ' minutes',
               updated_at = now()
         WHERE r.status = 'RUNNING'
           AND r.updated_at < now() - make_interval(mins => v_minutes)
           AND (
                v_backend
                OR r.created_by = auth.uid()
                OR (r.entity_id IS NOT NULL AND tenancy.has_entity_access(r.entity_id, 'READ'))
           )
        RETURNING r.id
    ), sections AS (
        UPDATE public.narrative_run_sections s
           SET status = 'FAILED',
               error_message = COALESCE(s.error_message, 'Abandoned with the run'),
               updated_at = now()
          FROM stale
         WHERE s.run_id = stale.id
           AND s.status IN ('PENDING', 'RUNNING')
        RETURNING s.id
    )
    SELECT count(*)::INTEGER INTO closed FROM stale;

    RETURN closed;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_read_attribute_values(p_entity_id uuid, p_as_of date DEFAULT NULL::date, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(attribute_code character varying, attribute_name text, value_text text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $$
DECLARE
    v_as_of DATE := COALESCE(p_as_of, CURRENT_DATE);
    v_row RECORD;
    v_value JSONB;
    v_text TEXT;
BEGIN
    -- Callers see only records they may read. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_entity_id, 'READ');
    FOR v_row IN
        SELECT ar.attribute_code, ar.attribute_name, cd.id AS calc_id
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        JOIN entity_instances.master_entities me ON me.id = p_entity_id
        WHERE cd.evaluation_mode = 'ON_READ'
          AND cd.calc_kind = 'EXPRESSION'
          AND cd.domain_code = me.domain_code
    LOOP
        v_value := golden_master.eval_expression_result(v_row.calc_id, p_entity_id, v_as_of, 0, p_knowledge);
        IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
            CONTINUE;
        END IF;
        v_text := v_value #>> '{}';
        IF v_text IS NULL OR btrim(v_text) = '' THEN
            CONTINUE;
        END IF;
        attribute_code := v_row.attribute_code;
        attribute_name := v_row.attribute_name;
        value_text := v_text;
        RETURN NEXT;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.explain_calc(p_entity_id uuid, p_attribute_code text, p_as_of date DEFAULT NULL::date, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $$
DECLARE
    v_as_of DATE := COALESCE(p_as_of, CURRENT_DATE);
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_code TEXT;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_amount metadata_register.calc_inputs%ROWTYPE;
    v_date metadata_register.calc_inputs%ROWTYPE;
    v_terminal metadata_register.calc_inputs%ROWTYPE;
    v_weight_code TEXT;
    v_components JSONB := '[]'::jsonb;
    v_count INTEGER := 0;
    v_truncated BOOLEAN := FALSE;
    v_limit INTEGER := 40;
    v_entity UUID;
    v_ids UUID[];
    v_result JSONB;
    v_numeric NUMERIC;
    v_text TEXT;
    v_flow_date DATE;
    v_amount_value NUMERIC;
BEGIN
    -- Callers see only records they may read. Server code is trusted.
    PERFORM tenancy.assert_entity_access(p_entity_id, 'READ');
    SELECT cd.* INTO v_def
    FROM metadata_register.calc_definitions cd
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    WHERE ar.attribute_code = p_attribute_code;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT ar.attribute_code INTO v_code
    FROM metadata_register.attribute_register ar
    WHERE ar.id = v_def.attribute_id;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        FOR v_input IN
            SELECT * FROM metadata_register.calc_inputs
            WHERE calc_definition_id = v_def.id AND input_role = 'OPERAND'
            ORDER BY ordinal, attribute_code
        LOOP
            v_entity := golden_master.operand_entity(
                v_def.id, p_entity_id, v_input.attribute_code, v_input.traversal,
                v_input.relationship_codes, v_as_of, v_def.expression, p_knowledge
            );
            v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                v_def.domain_code, v_entity, v_input.attribute_code, v_input.input_role,
                v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL, p_knowledge
            ));
        END LOOP;
        v_result := golden_master.eval_expression_result(v_def.id, p_entity_id, v_as_of, 0, p_knowledge);
        IF v_result IS NOT NULL AND jsonb_typeof(v_result) <> 'null' THEN
            v_text := v_result #>> '{}';
        END IF;
    ELSIF v_def.calc_kind = 'AGGREGATE' THEN
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'MEASURE'
        LIMIT 1;

        SELECT attribute_code INTO v_weight_code
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'WEIGHT'
        LIMIT 1;

        IF v_input.attribute_code IS NOT NULL THEN
        v_ids := golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, v_as_of);
        IF v_ids IS NOT NULL THEN
            FOREACH v_entity IN ARRAY v_ids LOOP
                v_count := v_count + 1;
                IF v_count > v_limit THEN
                    v_truncated := TRUE;
                    EXIT;
                END IF;
                v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                    v_def.domain_code, v_entity, v_input.attribute_code, 'MEASURE',
                    v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL
                ));
                IF v_weight_code IS NOT NULL THEN
                    v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                        v_def.domain_code, v_entity, v_weight_code, 'WEIGHT',
                        v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL
                    ));
                END IF;
            END LOOP;
        END IF;
        END IF;
        v_numeric := golden_master.eval_calc(v_def.id, p_entity_id, v_as_of, 0);
        IF v_numeric IS NOT NULL THEN
            v_text := v_numeric::TEXT;
        END IF;
    ELSE
        SELECT * INTO v_amount
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'AMOUNT'
        LIMIT 1;
        SELECT * INTO v_date
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'FLOW_DATE'
        LIMIT 1;
        SELECT * INTO v_terminal
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'TERMINAL'
        LIMIT 1;

        IF v_amount.attribute_code IS NOT NULL THEN
        v_ids := golden_master.related_ids(p_entity_id, v_amount.traversal, v_amount.relationship_codes, v_as_of);
        IF v_ids IS NOT NULL THEN
            FOREACH v_entity IN ARRAY v_ids LOOP
                v_amount_value := golden_master.golden_numeric(v_entity, v_amount.attribute_code, v_as_of, 1);
                v_flow_date := golden_master.golden_date(v_entity, v_date.attribute_code, v_as_of);
                IF v_amount_value IS NULL OR v_flow_date IS NULL OR v_flow_date > v_as_of THEN
                    CONTINUE;
                END IF;
                v_count := v_count + 1;
                IF v_count > v_limit THEN
                    v_truncated := TRUE;
                    EXIT;
                END IF;
                v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                    v_def.domain_code, v_entity, v_amount.attribute_code, 'AMOUNT',
                    v_amount.traversal, v_amount.relationship_codes, v_as_of, 1, v_flow_date::TEXT
                ));
            END LOOP;
        END IF;
        END IF;

        IF v_terminal.attribute_code IS NOT NULL THEN
            v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                v_def.domain_code, p_entity_id, v_terminal.attribute_code, 'TERMINAL',
                'SELF', '{}'::text[], v_as_of, 1, 'Terminal value'
            ));
        END IF;
        v_numeric := golden_master.eval_calc(v_def.id, p_entity_id, v_as_of, 0);
        IF v_numeric IS NOT NULL THEN
            v_text := v_numeric::TEXT;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'attributeCode', v_code,
        'calcKind', v_def.calc_kind,
        'domainCode', v_def.domain_code,
        'expression', v_def.expression,
        'value', v_text,
        'truncated', v_truncated,
        'components', v_components
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_batch_quality(p_batch_id uuid, p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'data_quality', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $$
DECLARE
  v_batch entity_instances.load_batches%ROWTYPE;
  v_as_of DATE;
  v_result JSONB;
BEGIN
    -- A signed-in caller may check only their own client's batches.
    IF NOT tenancy.is_backend_caller()
       AND NOT COALESCE(p_client_id IN (SELECT tenancy.current_client_ids()), FALSE) THEN
        RAISE EXCEPTION 'Batch not found';
    END IF;
  SELECT * INTO v_batch FROM entity_instances.load_batches WHERE id = p_batch_id AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  SELECT GREATEST(v_batch.as_of_date, COALESCE(max(valid_from), v_batch.as_of_date))
    INTO v_as_of
  FROM entity_instances.load_batch_values WHERE batch_id = p_batch_id;

  WITH recs AS MATERIALIZED (
    SELECT r.id, r.domain_code, r.file_code, r.action, r.entity_id,
           COALESCE(me.entity_name, r.entity_name, r.file_code) AS entity_name,
           COALESCE(me.template_id, r.template_id) AS template_id
    FROM entity_instances.load_batch_records r
    LEFT JOIN entity_instances.master_entities me ON me.id = r.entity_id
    WHERE r.batch_id = p_batch_id
  ),
  live AS MATERIALIZED (
    SELECT DISTINCT ON (r.id, eav.attribute_id)
           r.id AS record_id, eav.attribute_id,
           NULLIF(btrim(eav.golden_value), '') AS value,
           eav.precedence_rank, eav.valid_from
    FROM recs r
    JOIN golden_master.entity_attribute_values eav ON eav.entity_id = r.entity_id
    WHERE eav.system_to = '9999-12-31 23:59:59'
      AND eav.valid_from <= v_as_of
      AND eav.valid_to >= v_as_of
    ORDER BY r.id, eav.attribute_id, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  staged AS MATERIALIZED (
    SELECT DISTINCT ON (v.record_id, v.attribute_id)
           v.id AS value_id, v.record_id, v.attribute_id,
           NULLIF(btrim(COALESCE(v.edited_value, v.proposed_value)), '') AS value,
           v.precedence_rank, v.valid_from,
           (v.origin_row IS NOT NULL AND v.origin_column IS NOT NULL) AS editable
    FROM entity_instances.load_batch_values v
    WHERE v.batch_id = p_batch_id
      AND v.valid_from <= v_as_of
    ORDER BY v.record_id, v.attribute_id, v.valid_from DESC
  ),
  merged AS MATERIALIZED (
    SELECT DISTINCT ON (u.record_id, u.attribute_id)
           u.record_id, u.attribute_id, u.value, u.from_batch
    FROM (
      SELECT record_id, attribute_id, value, precedence_rank, valid_from, TRUE AS from_batch FROM staged
      UNION ALL
      SELECT record_id, attribute_id, value, precedence_rank, valid_from, FALSE FROM live
    ) u
    ORDER BY u.record_id, u.attribute_id, u.precedence_rank ASC, u.valid_from DESC, u.from_batch DESC
  ),
  after_map AS MATERIALIZED (
    SELECT m.record_id, jsonb_object_agg(lower(ar.attribute_code), m.value) AS vals
    FROM merged m
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
    WHERE m.value IS NOT NULL
    GROUP BY m.record_id
  ),
  before_map AS MATERIALIZED (
    SELECT l.record_id, jsonb_object_agg(lower(ar.attribute_code), l.value) AS vals
    FROM live l
    JOIN metadata_register.attribute_register ar ON ar.id = l.attribute_id
    WHERE l.value IS NOT NULL
    GROUP BY l.record_id
  ),
  outranked AS (
    SELECT s.value_id, s.record_id, s.attribute_id, s.value AS proposed, m.value AS winning
    FROM staged s
    JOIN merged m ON m.record_id = s.record_id AND m.attribute_id = s.attribute_id
    WHERE m.from_batch IS FALSE
      AND s.value IS DISTINCT FROM m.value
  ),
  active_rules AS (
    SELECT r.id, r.rule_code, r.rule_name, r.domain_code, r.rule_severity,
           ar.id AS attribute_id, ar.attribute_code, ar.attribute_name,
           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* ('^' || ar.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')) AS passes_when_blank,
           data_quality.apply_compiled_rule(r.id, '{}'::jsonb, v_as_of) AS probe
    FROM data_quality.dq_rules r
    LEFT JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
    WHERE r.is_active IS TRUE
      AND (r.domain_code IS NULL OR r.domain_code IN (SELECT domain_code FROM recs))
  ),
  scope AS MATERIALIZED (
    SELECT aru.*, r.id AS record_id, r.entity_id
    FROM active_rules aru
    JOIN recs r ON aru.domain_code IS NULL OR aru.domain_code = r.domain_code
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
  ),
  accepted AS (
    SELECT DISTINCT ex.rule_id, ex.entity_id
    FROM data_quality.dq_exceptions ex
    WHERE ex.status IN ('WAIVED', 'FALSE_POSITIVE')
      AND ex.valid_from <= v_as_of
      AND ex.valid_to >= v_as_of
      AND ex.entity_id IN (SELECT entity_id FROM recs WHERE entity_id IS NOT NULL)
  ),
  checks AS MATERIALIZED (
    SELECT c.record_id, c.entity_id, c.id AS rule_id, c.rule_code, c.rule_name, c.rule_severity,
           c.attribute_id, c.attribute_code, c.attribute_name,
           COALESCE((c.after_result->>'passed')::boolean, false) AS after_passed,
           c.after_result->>'message' AS message,
           c.after_result->>'actualValue' AS actual_value,
           CASE WHEN c.before_result IS NULL THEN NULL
                ELSE COALESCE((c.before_result->>'passed')::boolean, false) END AS before_passed
    FROM (
      SELECT s.*,
             CASE
               WHEN s.attribute_code IS NOT NULL AND s.passes_when_blank
                AND NOT jsonb_exists(COALESCE(am.vals, '{}'::jsonb), lower(s.attribute_code))
               THEN jsonb_build_object('passed', true)
               ELSE data_quality.apply_compiled_rule(s.id, COALESCE(am.vals, '{}'::jsonb), v_as_of)
             END AS after_result,
             CASE
               WHEN s.entity_id IS NULL THEN NULL
               WHEN s.attribute_code IS NOT NULL AND s.passes_when_blank
                AND NOT jsonb_exists(COALESCE(bm.vals, '{}'::jsonb), lower(s.attribute_code))
               THEN jsonb_build_object('passed', true)
               ELSE data_quality.apply_compiled_rule(s.id, COALESCE(bm.vals, '{}'::jsonb), v_as_of)
             END AS before_result
      FROM scope s
      LEFT JOIN after_map am ON am.record_id = s.record_id
      LEFT JOIN before_map bm ON bm.record_id = s.record_id
      WHERE NOT EXISTS (
        SELECT 1 FROM accepted ax WHERE ax.rule_id = s.id AND ax.entity_id = s.entity_id
      )
      OFFSET 0
    ) c
  ),
  failures AS (
    SELECT c.*, r.domain_code, r.file_code, r.entity_name, r.action,
           CASE WHEN c.before_passed IS FALSE THEN 'EXISTING' ELSE 'NEW' END AS state,
           st.value_id, COALESCE(st.editable, false) AS editable, st.value AS staged_value
    FROM checks c
    JOIN recs r ON r.id = c.record_id
    LEFT JOIN staged st ON st.record_id = c.record_id AND st.attribute_id = c.attribute_id
    WHERE NOT c.after_passed
  ),
  cleared AS (
    SELECT c.*, r.domain_code, r.file_code, r.entity_name
    FROM checks c
    JOIN recs r ON r.id = c.record_id
    WHERE c.after_passed AND c.before_passed IS FALSE
  ),
  required_attr AS (
    SELECT r.id AS record_id, ar.id AS attribute_id, ar.attribute_code, ar.attribute_name
    FROM recs r
    JOIN metadata_register.template_attribute_assignments taa
      ON taa.template_id = r.template_id AND taa.is_required IS TRUE
    JOIN metadata_register.attribute_register ar ON ar.id = taa.attribute_id
    WHERE r.template_id IS NOT NULL
    UNION
    SELECT r.id, ar.id, ar.attribute_code, ar.attribute_name
    FROM recs r
    JOIN metadata_register.attribute_register ar
      ON ar.domain_code = r.domain_code AND ar.is_required IS TRUE
    WHERE r.template_id IS NULL
  ),
  missing AS (
    SELECT ra.*, r.domain_code, r.file_code, r.entity_name, r.action,
           CASE WHEN r.entity_id IS NULL THEN 'NEW' ELSE 'EXISTING' END AS state
    FROM required_attr ra
    JOIN recs r ON r.id = ra.record_id
    LEFT JOIN merged m
      ON m.record_id = ra.record_id AND m.attribute_id = ra.attribute_id AND m.value IS NOT NULL
    WHERE m.record_id IS NULL
  )
  SELECT jsonb_build_object(
    'batchId', p_batch_id,
    'asOf', v_as_of,
    'recordCount', (SELECT count(*) FROM recs),
    'ruleCount', (SELECT count(*) FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)),
    'summary', jsonb_build_object(
      'newFailures', (SELECT count(*) FROM failures WHERE state = 'NEW'),
      'existingFailures', (SELECT count(*) FROM failures WHERE state = 'EXISTING'),
      'cleared', (SELECT count(*) FROM cleared),
      'missingRequired', (SELECT count(*) FROM missing),
      'blocking', (SELECT count(*) FROM failures WHERE state = 'NEW' AND rule_severity = 'CRITICAL'),
      'outranked', (SELECT count(*) FROM outranked)
    ),
    'failures', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', f.record_id, 'entityId', f.entity_id, 'domainCode', f.domain_code,
        'fileCode', f.file_code, 'entityName', f.entity_name, 'recordAction', f.action,
        'ruleCode', f.rule_code, 'ruleName', f.rule_name, 'severity', f.rule_severity,
        'attributeCode', f.attribute_code, 'attributeName', f.attribute_name,
        'message', f.message, 'actualValue', f.actual_value, 'state', f.state,
        'valueId', f.value_id, 'editable', f.editable, 'stagedValue', f.staged_value
      ) ORDER BY (f.state = 'NEW') DESC,
                 array_position(ARRAY['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']::text[], f.rule_severity::text),
                 f.entity_name, f.rule_code)
      FROM (SELECT * FROM failures ORDER BY (state = 'NEW') DESC, entity_name LIMIT 500) f
    ), '[]'::jsonb),
    'cleared', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', c.record_id, 'domainCode', c.domain_code, 'fileCode', c.file_code,
        'entityName', c.entity_name, 'ruleCode', c.rule_code, 'ruleName', c.rule_name,
        'attributeCode', c.attribute_code
      ) ORDER BY c.entity_name, c.rule_code)
      FROM (SELECT * FROM cleared ORDER BY entity_name LIMIT 200) c
    ), '[]'::jsonb),
    'missing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', m.record_id, 'domainCode', m.domain_code, 'fileCode', m.file_code,
        'entityName', m.entity_name, 'recordAction', m.action,
        'attributeCode', m.attribute_code, 'attributeName', m.attribute_name, 'state', m.state
      ) ORDER BY m.entity_name, m.attribute_code)
      FROM (SELECT * FROM missing ORDER BY entity_name LIMIT 500) m
    ), '[]'::jsonb),
    'outranked', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'valueId', o.value_id, 'recordId', o.record_id, 'fileCode', r.file_code,
        'entityName', r.entity_name, 'attributeCode', ar.attribute_code,
        'attributeName', ar.attribute_name, 'proposed', o.proposed, 'winning', o.winning
      ) ORDER BY r.entity_name, ar.attribute_code)
      FROM (SELECT * FROM outranked LIMIT 200) o
      JOIN recs r ON r.id = o.record_id
      JOIN metadata_register.attribute_register ar ON ar.id = o.attribute_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_batch_revert(p_batch_id uuid, p_client_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'entity_instances', 'golden_master', 'pg_catalog'
AS $$
DECLARE
  v_batch entity_instances.load_batches%ROWTYPE;
  v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59';
  v_now TIMESTAMPTZ := clock_timestamp();
  v_entry RECORD;
  v_rows INTEGER;
  v_values_retired INTEGER := 0;
  v_values_kept INTEGER := 0;
  v_restored INTEGER := 0;
  v_not_restored INTEGER := 0;
  v_links_removed INTEGER := 0;
  v_records_deactivated INTEGER := 0;
  v_records_kept INTEGER := 0;
  v_result JSONB;
BEGIN
    -- A signed-in caller may revert only their own client's batches, needs the
    -- permission to promote loads, and is recorded as themselves.
    IF NOT tenancy.is_backend_caller() THEN
        IF NOT COALESCE(p_client_id IN (SELECT tenancy.current_client_ids()), FALSE)
           OR NOT COALESCE(tenancy.has_permission(p_client_id, 'load.promote'), FALSE) THEN
            RAISE EXCEPTION 'Batch not found';
        END IF;
        p_user_id := auth.uid();
    END IF;
  SELECT * INTO v_batch
  FROM entity_instances.load_batches
  WHERE id = p_batch_id AND client_id = p_client_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status NOT IN ('PROMOTED', 'FAILED') THEN
    RAISE EXCEPTION 'Only a promoted batch can be reverted. This one is %.', lower(v_batch.status);
  END IF;

  -- Values a later load rewrote in place are no longer this batch's to retire.
  SELECT count(*) INTO v_values_kept
  FROM golden_master.entity_attribute_values eav
  WHERE eav.load_batch_id = p_batch_id
    AND eav.system_to = v_open
    AND EXISTS (
      SELECT 1 FROM entity_instances.load_batch_journal j
      WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
    );

  UPDATE golden_master.entity_attribute_values eav
     SET system_to = v_now
   WHERE eav.load_batch_id = p_batch_id
     AND eav.system_to = v_open
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.load_batch_journal j
       WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
     );
  GET DIAGNOSTICS v_values_retired = ROW_COUNT;

  -- Put back what was changed in place, newest change first.
  FOR v_entry IN
    SELECT * FROM entity_instances.load_batch_journal WHERE batch_id = p_batch_id ORDER BY id DESC
  LOOP
    v_rows := 0;
    IF v_entry.kind = 'VALUE_CLOSE' THEN
      UPDATE golden_master.entity_attribute_values
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'VALUE_UPDATE' THEN
      UPDATE golden_master.entity_attribute_values
         SET golden_value = v_entry.before->>'golden_value',
             golden_value_numeric = (v_entry.before->>'golden_value_numeric')::numeric,
             golden_value_date = (v_entry.before->>'golden_value_date')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND golden_value IS NOT DISTINCT FROM (v_entry.after->>'golden_value');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'LINK_CLOSE' THEN
      UPDATE entity_instances.entity_relationships
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'RECORD_RENAME' THEN
      UPDATE entity_instances.master_entities
         SET entity_name = v_entry.before->>'entity_name', updated_at = v_now
       WHERE id = v_entry.target_id
         AND entity_name = (v_entry.after->>'entity_name');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;
    IF v_rows > 0 THEN
      v_restored := v_restored + 1;
    ELSE
      v_not_restored := v_not_restored + 1;
    END IF;
  END LOOP;

  DELETE FROM entity_instances.entity_relationships WHERE load_batch_id = p_batch_id;
  GET DIAGNOSTICS v_links_removed = ROW_COUNT;

  UPDATE entity_instances.master_entities me
     SET is_active = FALSE, updated_at = v_now
   WHERE me.load_batch_id = p_batch_id
     AND me.is_active IS TRUE
     AND NOT EXISTS (
       SELECT 1 FROM golden_master.entity_attribute_values eav
       WHERE eav.entity_id = me.id AND eav.system_to = v_open
     )
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.entity_relationships er
       WHERE (er.parent_entity_id = me.id OR er.child_entity_id = me.id) AND er.system_to = v_open
     );
  GET DIAGNOSTICS v_records_deactivated = ROW_COUNT;

  SELECT count(*) INTO v_records_kept
  FROM entity_instances.master_entities me
  WHERE me.load_batch_id = p_batch_id AND me.is_active IS TRUE;

  v_result := jsonb_build_object(
    'valuesRetired', v_values_retired,
    'valuesLeft', v_values_kept,
    'changesRestored', v_restored,
    'changesLeft', v_not_restored,
    'linksRemoved', v_links_removed,
    'recordsDeactivated', v_records_deactivated,
    'recordsLeft', v_records_kept
  );

  UPDATE entity_instances.load_batches
     SET status = 'REVERTED', reverted_by = p_user_id, reverted_at = v_now, revert_result = v_result
   WHERE id = p_batch_id;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';
