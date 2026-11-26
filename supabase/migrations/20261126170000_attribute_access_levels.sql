-- Field-level security: some attributes are seen only by people cleared for
-- them.
--
-- Each attribute has an access level: STANDARD (everyone who can read the
-- record), CONFIDENTIAL or RESTRICTED. The platform sets it on
-- metadata_register.attribute_register; a client can set its own level for any
-- attribute it uses in metadata_register.client_attribute_settings. Seeing a
-- CONFIDENTIAL attribute takes data.confidential.read in the client, seeing a
-- RESTRICTED one takes data.restricted.read (which covers confidential too).
-- Client administrators hold both; data stewards hold confidential. Until an
-- attribute is classified, nothing changes for anyone.
--
-- tenancy.hidden_attribute_ids() is the one answer to "which attributes may
-- this caller not see". A person in several clients does not see an attribute
-- any of them hides from them. Platform staff and the platform service see
-- everything.
--
-- Where it applies:
--   * Row security on golden_master.entity_attribute_values and
--     intersection_attribute_values, for reading and for writing. The app's
--     readers (winning_attribute_values, query_values, report_grid, the
--     entity_master view) and its direct reads run as the caller, so all of
--     them, the assistant's tools and every export built from them, see only
--     what the caller may.
--   * The definer functions that hand values to people: explain_golden_source
--     (the sources panel), data_quality_dashboard, dq_availability_detail,
--     dq_rule_preview, stale_attributes, confirm_attribute_receipt. Each reads
--     the values through the same filter.
--   * Definer functions that must see every value to stay correct (merging
--     records, reverting a load, choosing the golden source, calculations,
--     compliance) are not filtered. supabase/tests/23_attribute_access.sql
--     lists them with the reason, and fails when a new definer reader appears
--     on neither list.

-- ============================================================
-- 1. Levels and permissions
-- ============================================================
ALTER TABLE metadata_register.attribute_register
    ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'STANDARD'
        CHECK (access_level IN ('STANDARD', 'CONFIDENTIAL', 'RESTRICTED'));
COMMENT ON COLUMN metadata_register.attribute_register.access_level IS
    'Who sees this attribute''s values: STANDARD (anyone who can read the record), CONFIDENTIAL (data.confidential.read) or RESTRICTED (data.restricted.read). A client can set its own in client_attribute_settings.';
CREATE INDEX IF NOT EXISTS idx_attribute_register_classified
    ON metadata_register.attribute_register (id) WHERE access_level <> 'STANDARD';

ALTER TABLE metadata_register.client_attribute_settings
    ADD COLUMN IF NOT EXISTS access_level TEXT
        CHECK (access_level IS NULL OR access_level IN ('STANDARD', 'CONFIDENTIAL', 'RESTRICTED'));
COMMENT ON COLUMN metadata_register.client_attribute_settings.access_level IS
    'This client''s own access level for the attribute. Null: the attribute''s own level.';
CREATE INDEX IF NOT EXISTS idx_client_attribute_settings_classified
    ON metadata_register.client_attribute_settings (client_id, attribute_id) WHERE access_level IS NOT NULL;

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('data.confidential.read', 'See and change attributes marked confidential'),
    ('data.restricted.read', 'See and change attributes marked restricted, and confidential ones')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON
    (r.role_code = 'CLIENT_ADMIN' AND p.permission_code IN ('data.confidential.read', 'data.restricted.read'))
    OR (r.role_code = 'DATA_STEWARD' AND p.permission_code = 'data.confidential.read')
WHERE r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- ============================================================
-- 2. Which attributes this caller may not see
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.hidden_attribute_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = tenancy, metadata_register, pg_temp
AS $$
BEGIN
    -- Usual case: nothing is classified, so nothing is hidden and this costs two index probes.
    IF NOT EXISTS (SELECT 1 FROM metadata_register.attribute_register WHERE access_level <> 'STANDARD')
       AND NOT EXISTS (SELECT 1 FROM metadata_register.client_attribute_settings WHERE access_level IS NOT NULL AND access_level <> 'STANDARD') THEN
        RETURN;
    END IF;
    IF tenancy.is_backend_caller() OR tenancy.is_tenant_admin() THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH clients AS (
        SELECT c AS client_id FROM tenancy.current_client_ids() AS c
    ),
    levels AS (
        SELECT cl.client_id, ar.id AS attribute_id, COALESCE(s.access_level, ar.access_level) AS level
        FROM clients cl
        JOIN metadata_register.attribute_register ar ON ar.client_id IS NULL OR ar.client_id = cl.client_id
        LEFT JOIN metadata_register.client_attribute_settings s ON s.client_id = cl.client_id AND s.attribute_id = ar.id
        WHERE ar.access_level <> 'STANDARD' OR (s.access_level IS NOT NULL AND s.access_level <> 'STANDARD')
    )
    SELECT DISTINCT l.attribute_id
    FROM levels l
    WHERE (l.level = 'RESTRICTED' AND NOT tenancy.has_permission(l.client_id, 'data.restricted.read'))
       OR (l.level = 'CONFIDENTIAL'
           AND NOT tenancy.has_permission(l.client_id, 'data.confidential.read')
           AND NOT tenancy.has_permission(l.client_id, 'data.restricted.read'));
END;
$$;
REVOKE ALL ON FUNCTION tenancy.hidden_attribute_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.hidden_attribute_ids() TO authenticated, service_role;
COMMENT ON FUNCTION tenancy.hidden_attribute_ids() IS
    'Attributes the caller may not see or change, in any of the clients they work in. Empty for platform staff, the platform service, and while nothing is classified.';

-- The codes, for the app to show "Restricted" instead of a blank, and for the assistant to say so.
CREATE OR REPLACE FUNCTION public.hidden_attribute_codes()
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = metadata_register, tenancy, pg_temp
AS $$
    SELECT COALESCE(array_agg(ar.attribute_code::TEXT ORDER BY ar.attribute_code), '{}')
    FROM metadata_register.attribute_register ar
    WHERE ar.id IN (SELECT tenancy.hidden_attribute_ids());
$$;
REVOKE ALL ON FUNCTION public.hidden_attribute_codes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hidden_attribute_codes() TO authenticated;

-- A client sets its own level for an attribute: whoever manages its roles
-- (role.manage, held by client administrators), since this decides who sees
-- what, and staff. NULL goes back to the attribute's own level.
CREATE OR REPLACE FUNCTION public.set_client_attribute_access_level(p_client_id UUID, p_attribute_code TEXT, p_level TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
    v_attribute UUID;
    v_level TEXT := NULLIF(upper(btrim(COALESCE(p_level, ''))), '');
BEGIN
    IF NOT (tenancy.is_tenant_admin() OR tenancy.has_permission(p_client_id, 'role.manage')) THEN
        RAISE EXCEPTION 'Only this client''s administrators can classify its data' USING ERRCODE = '42501';
    END IF;
    IF v_level IS NOT NULL AND v_level NOT IN ('STANDARD', 'CONFIDENTIAL', 'RESTRICTED') THEN
        RAISE EXCEPTION 'The level is STANDARD, CONFIDENTIAL or RESTRICTED' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO v_attribute FROM metadata_register.attribute_register
    WHERE attribute_code = btrim(p_attribute_code) AND (client_id IS NULL OR client_id = p_client_id);
    IF v_attribute IS NULL THEN
        RAISE EXCEPTION 'Unknown attribute %', p_attribute_code USING ERRCODE = '22023';
    END IF;
    -- A row also says whether the attribute is hidden from the catalog; a new
    -- one made here is not.
    INSERT INTO metadata_register.client_attribute_settings (client_id, attribute_id, is_hidden, access_level, updated_by)
    VALUES (p_client_id, v_attribute, FALSE, v_level, auth.uid())
    ON CONFLICT (client_id, attribute_id) DO UPDATE SET access_level = EXCLUDED.access_level, updated_by = EXCLUDED.updated_by, updated_at = now();
    -- Nothing left to say: no row.
    DELETE FROM metadata_register.client_attribute_settings
    WHERE client_id = p_client_id AND attribute_id = v_attribute AND NOT is_hidden AND access_level IS NULL;
    RETURN v_level;
END;
$$;
REVOKE ALL ON FUNCTION public.set_client_attribute_access_level(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_client_attribute_access_level(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 3. Row security on the values
-- ============================================================
DROP POLICY IF EXISTS "Golden master readable per entity access" ON golden_master.entity_attribute_values;
CREATE POLICY "Golden master readable per entity access" ON golden_master.entity_attribute_values
    FOR SELECT TO authenticated
    USING (entity_id IN (SELECT tenancy.readable_entity_ids())
           AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()));
DROP POLICY IF EXISTS "Golden master insertable per entity access" ON golden_master.entity_attribute_values;
CREATE POLICY "Golden master insertable per entity access" ON golden_master.entity_attribute_values
    FOR INSERT TO authenticated
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE')
                AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()));
DROP POLICY IF EXISTS "Golden master updatable per entity access" ON golden_master.entity_attribute_values;
CREATE POLICY "Golden master updatable per entity access" ON golden_master.entity_attribute_values
    FOR UPDATE TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE') AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE') AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()));

DROP POLICY IF EXISTS "Intersection attribute values readable per member access" ON golden_master.intersection_attribute_values;
CREATE POLICY "Intersection attribute values readable per member access" ON golden_master.intersection_attribute_values
    FOR SELECT TO authenticated
    USING (tenancy.intersection_accessible(intersection_id, 'READ')
           AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()));
DROP POLICY IF EXISTS "Intersection attribute values writable per member access" ON golden_master.intersection_attribute_values;
CREATE POLICY "Intersection attribute values writable per member access" ON golden_master.intersection_attribute_values
    FOR ALL TO authenticated
    USING (tenancy.intersection_accessible(intersection_id, 'WRITE') AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()))
    WITH CHECK (tenancy.intersection_accessible(intersection_id, 'WRITE') AND attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids()));

-- ============================================================
-- 4. Definer functions that hand values to people
-- ============================================================
-- Each reads golden_master.entity_attribute_values through the same filter;
-- nothing else in them changes.

-- explain_golden_source: 1 read(s) filtered.
CREATE OR REPLACE FUNCTION golden_master.explain_golden_source(p_entity_id uuid, p_attribute_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'golden_master', 'entity_instances', 'metadata_register', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_attribute_id UUID;
    v_template_id UUID;
    v_decision RECORD;
    v_chain_version INTEGER;
    v_candidates JSONB;
BEGIN
    -- preference_decision reads every row of the record, so the caller must be able to read the record.
    IF NOT tenancy.is_backend_caller() THEN
        PERFORM tenancy.assert_entity_access(p_entity_id, 'READ');
    END IF;

    SELECT ar.id INTO v_attribute_id
    FROM metadata_register.attribute_register ar
    WHERE ar.attribute_code = p_attribute_code;
    IF v_attribute_id IS NULL THEN
        RAISE EXCEPTION 'Unknown attribute %', p_attribute_code USING ERRCODE = 'P0002';
    END IF;

    SELECT d.winner, d.tier INTO v_decision
    FROM golden_master.preference_decision(p_entity_id, v_attribute_id, NULL, NULL, NULL, FALSE) AS d;

    SELECT me.template_id INTO v_template_id FROM entity_instances.master_entities me WHERE me.id = p_entity_id;
    IF v_decision.tier = 'TEMPLATE_SEQUENCE' AND v_template_id IS NOT NULL THEN
        SELECT taa.chain_version INTO v_chain_version
        FROM metadata_register.template_attribute_assignments taa
        WHERE taa.template_id = v_template_id AND taa.attribute_id = v_attribute_id;
    END IF;

    -- The current values that competed: the winner first, then by rank.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'source', sr.source_code,
               'sourceId', sr.id,
               'value', eav.golden_value,
               'rank', eav.precedence_rank,
               'wins', sr.id = v_decision.winner
           ) ORDER BY (sr.id = v_decision.winner) DESC, eav.precedence_rank, sr.source_code), '[]'::jsonb)
      INTO v_candidates
    FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = v_attribute_id
      AND eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL;

    RETURN jsonb_build_object(
        'winningSourceId', v_decision.winner,
        'winningSource', (SELECT sr.source_code FROM entity_instances.source_registry sr WHERE sr.id = v_decision.winner),
        'tier', v_decision.tier,
        'chainVersion', COALESCE(v_chain_version, 0),
        'candidates', v_candidates
    );
END;
$function$;

-- dq_rule_preview: 1 read(s) filtered.
CREATE OR REPLACE FUNCTION public.dq_rule_preview(p_domain_code text, p_expression text, p_attribute_code text DEFAULT NULL::text, p_columns text[] DEFAULT NULL::text[], p_as_of date DEFAULT NULL::date, p_outcome text DEFAULT 'FAIL'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'data_quality', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_as_of date := COALESCE(p_as_of, CURRENT_DATE);
  v_outcome text := upper(COALESCE(NULLIF(btrim(p_outcome), ''), 'FAIL'));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_attr text := lower(regexp_replace(COALESCE(p_attribute_code, ''), '[^A-Za-z0-9_]', '', 'g'));
  v_passes_blank boolean := false;
  v_columns text[];
  v_compiled text;
  v_sql text;
  v_result jsonb;
BEGIN
  IF v_outcome NOT IN ('FAIL', 'PASS', 'ALL') THEN
    RAISE EXCEPTION 'Outcome must be FAIL, PASS or ALL';
  END IF;
  IF NULLIF(btrim(COALESCE(p_expression, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Rule expression is empty';
  END IF;

  v_compiled := data_quality.compile_rule_expression(p_expression);

  -- A rule written "ATTRIBUTE IS NULL OR ..." passes when the attribute has no value at all.
  IF v_attr <> '' THEN
    v_passes_blank := data_quality.rule_passes_when_blank(p_expression, v_attr);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT lower(c)), ARRAY[]::text[])
  INTO v_columns
  FROM unnest(COALESCE(p_columns, ARRAY[]::text[])) AS c;

  v_sql := format($q$
    WITH scoped AS MATERIALIZED (
      SELECT me.id, me.entity_code, me.entity_name
      FROM entity_instances.master_entities me
      WHERE me.is_active IS TRUE
        AND me.client_id IN (
          SELECT cid
          FROM tenancy.current_client_ids() AS cid
          WHERE tenancy.has_permission(cid, 'entity.read')
        )
        AND CASE
          WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
            THEN tenancy.has_entity_access(me.id, 'READ')
          ELSE TRUE
        END
        AND ($1 IS NULL OR me.domain_code = $1)
    ),
    resolved AS MATERIALIZED (
      SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
        eav.entity_id,
        eav.attribute_id,
        NULLIF(btrim(eav.golden_value), '') AS golden_value
      FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
      JOIN scoped s ON s.id = eav.entity_id
      WHERE eav.system_to = '9999-12-31 23:59:59'
        AND eav.valid_from <= $2
        AND eav.valid_to >= $2
      ORDER BY eav.entity_id, eav.attribute_id, eav.precedence_rank ASC, eav.valid_from DESC
    ),
    value_map AS MATERIALIZED (
      SELECT rv.entity_id,
             jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS vals
      FROM resolved rv
      JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
      WHERE rv.golden_value IS NOT NULL
      GROUP BY rv.entity_id
    ),
    checked AS (
      SELECT s.id, s.entity_code, s.entity_name,
             COALESCE(vm.vals, '{}'::jsonb) AS vals,
             $2::date AS as_of
      FROM scoped s
      LEFT JOIN value_map vm ON vm.entity_id = s.id
    ),
    evaluated AS MATERIALIZED (
      SELECT c.id, c.entity_code, c.entity_name, c.vals,
             CASE
               WHEN $3::boolean AND NOT jsonb_exists(c.vals, $4)
                 THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE (%s)
             END AS result
      FROM checked c
    ),
    outcome AS (
      SELECT e.*, COALESCE((e.result ->> 'passed')::boolean, false) AS passed
      FROM evaluated e
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM outcome),
      'passed', (SELECT count(*) FROM outcome WHERE passed),
      'failed', (SELECT count(*) FROM outcome WHERE NOT passed),
      'rows', COALESCE((
        SELECT jsonb_agg(r.row ORDER BY r.entity_code, r.id)
        FROM (
          SELECT o.id, o.entity_code,
                 jsonb_build_object(
                   'entityId', o.id,
                   'entityCode', o.entity_code,
                   'entityName', o.entity_name,
                   'passed', o.passed,
                   'message', o.result ->> 'message',
                   'actualValue', o.result ->> 'actualValue',
                   'values', COALESCE((
                     SELECT jsonb_object_agg(k, o.vals -> k)
                     FROM unnest($5::text[]) AS k
                     WHERE jsonb_exists(o.vals, k)
                   ), '{}'::jsonb)
                 ) AS row
          FROM outcome o
          WHERE $6 = 'ALL' OR ($6 = 'FAIL' AND NOT o.passed) OR ($6 = 'PASS' AND o.passed)
          ORDER BY o.entity_code, o.id
          LIMIT %s OFFSET %s
        ) r
      ), '[]'::jsonb)
    )
  $q$, v_compiled, v_limit, v_offset);

  EXECUTE v_sql INTO v_result USING v_domain, v_as_of, v_passes_blank, v_attr, v_columns, v_outcome;
  RETURN v_result;
END;
$function$;

-- dq_availability_detail: 1 read(s) filtered.
CREATE OR REPLACE FUNCTION public.dq_availability_detail(p_attribute_code text, p_domain_code text DEFAULT NULL::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_swap date;
  v_result jsonb;
BEGIN
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);
  IF v_from > v_to THEN
    v_swap := v_from;
    v_from := v_to;
    v_to := v_swap;
  END IF;

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
      AND me.client_id IN (
        SELECT cid
        FROM tenancy.current_client_ids() AS cid
        WHERE tenancy.has_permission(cid, 'entity.read')
      )
      AND CASE
        WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
          THEN tenancy.has_entity_access(me.id, 'READ')
        ELSE TRUE
      END
      AND (v_domain IS NULL OR me.domain_code = v_domain)
      AND (p_entity_id IS NULL OR me.id = p_entity_id)
  ),
  required_attr AS MATERIALIZED (
    SELECT s.id AS entity_id, s.entity_code, s.entity_name, s.domain_code, ar.id AS attribute_id
    FROM scoped s
    JOIN metadata_register.template_attribute_assignments taa
      ON taa.template_id = s.template_id
     AND taa.is_required IS TRUE
    JOIN metadata_register.attribute_register ar
      ON ar.id = taa.attribute_id
     AND ar.attribute_code = p_attribute_code
    WHERE s.template_id IS NOT NULL
    UNION
    SELECT s.id, s.entity_code, s.entity_name, s.domain_code, ar.id
    FROM scoped s
    JOIN metadata_register.attribute_register ar
      ON ar.domain_code = s.domain_code
     AND ar.is_required IS TRUE
     AND ar.attribute_code = p_attribute_code
    WHERE s.template_id IS NULL
  ),
  resolved AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, snapshot.as_of)
      eav.entity_id,
      eav.attribute_id,
      snapshot.as_of,
      NULLIF(btrim(eav.golden_value), '') AS golden_value
    FROM required_attr r
    JOIN (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
      ON eav.entity_id = r.entity_id
     AND eav.attribute_id = r.attribute_id
    JOIN (
      VALUES (v_from), (v_to)
    ) AS snapshot(as_of) ON TRUE
    WHERE (
      (p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59')
      OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)
    )
      AND eav.valid_from <= snapshot.as_of
      AND eav.valid_to >= snapshot.as_of
    ORDER BY eav.entity_id, eav.attribute_id, snapshot.as_of, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  required_values AS (
    SELECT DISTINCT
           r.entity_id,
           r.entity_code,
           r.entity_name,
           r.domain_code,
           rv.golden_value,
           fr.golden_value AS previous_value
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    LEFT JOIN resolved fr
      ON fr.entity_id = r.entity_id
     AND fr.attribute_id = r.attribute_id
     AND fr.as_of = v_from
     AND fr.golden_value IS NOT NULL
  )
  SELECT jsonb_build_object(
    'missingEntities', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', entity_id,
        'entityCode', entity_code,
        'entityName', entity_name,
        'domainCode', domain_code
      )
      ORDER BY entity_name, entity_code
    ) FILTER (WHERE golden_value IS NULL), '[]'::jsonb),
    'resolvedEntities', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', entity_id,
        'entityCode', entity_code,
        'entityName', entity_name,
        'domainCode', domain_code,
        'previousValue', NULL,
        'currentValue', golden_value
      )
      ORDER BY entity_name, entity_code
    ) FILTER (WHERE previous_value IS NULL AND golden_value IS NOT NULL), '[]'::jsonb),
    'introducedEntities', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', entity_id,
        'entityCode', entity_code,
        'entityName', entity_name,
        'domainCode', domain_code,
        'previousValue', previous_value,
        'currentValue', NULL
      )
      ORDER BY entity_name, entity_code
    ) FILTER (WHERE previous_value IS NOT NULL AND golden_value IS NULL), '[]'::jsonb)
  )
  INTO v_result
  FROM required_values;

  RETURN v_result;
END;
$function$;

-- stale_attributes: 1 read(s) filtered.
CREATE OR REPLACE FUNCTION public.stale_attributes(p_domain_code text DEFAULT NULL::text, p_older_than_days integer DEFAULT 30, p_as_of_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_days integer := LEAST(GREATEST(COALESCE(p_older_than_days, 30), 1), 3650);
  v_as_of date := COALESCE(p_as_of_date, CURRENT_DATE);
  v_cutoff timestamptz := NOW() - make_interval(days => v_days);
  v_known timestamptz := COALESCE(p_knowledge_date, clock_timestamp());
  v_result jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);
  PERFORM set_config('enable_nestloop', 'off', true);

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
      AND me.client_id IN (
        SELECT cid
        FROM tenancy.current_client_ids() AS cid
        WHERE tenancy.has_permission(cid, 'entity.read')
      )
      AND CASE
        WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
          THEN tenancy.has_entity_access(me.id, 'READ')
        ELSE TRUE
      END
      AND (v_domain IS NULL OR me.domain_code = v_domain)
      AND (p_entity_id IS NULL OR me.id = p_entity_id)
  ),
  winners AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
      eav.entity_id,
      eav.attribute_id,
      eav.source_id,
      NULLIF(btrim(eav.golden_value), '') AS golden_value,
      COALESCE(eav.last_received_at, eav.system_from) AS received_at
    FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
    JOIN scoped s ON s.id = eav.entity_id
    WHERE (
      (p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59')
      OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)
    )
      AND eav.valid_from <= v_as_of
      AND eav.valid_to >= v_as_of
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id,
      COALESCE(eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge_date), FALSE) DESC,
      eav.precedence_rank ASC,
      eav.valid_from DESC
  ),
  stale AS MATERIALIZED (
    SELECT
      s.id AS entity_id,
      s.entity_code,
      s.entity_name,
      s.domain_code,
      ar.attribute_code,
      ar.attribute_name,
      sr.source_code,
      sr.source_name,
      w.golden_value,
      w.received_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - w.received_at)) / 86400))::int AS age_days
    FROM winners w
    JOIN scoped s ON s.id = w.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id
    JOIN entity_instances.source_registry sr ON sr.id = w.source_id
    WHERE w.received_at < v_cutoff
      AND sr.source_code NOT IN ('DERIVED', 'CALCULATED')
  )
  SELECT jsonb_build_object(
    'olderThanDays', v_days,
    'asOfDate', v_as_of,
    'count', (SELECT count(*)::int FROM stale),
    'attributes', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'entityId', row.entity_id,
          'entityCode', row.entity_code,
          'entityName', row.entity_name,
          'domainCode', row.domain_code,
          'attributeCode', row.attribute_code,
          'attributeName', row.attribute_name,
          'sourceCode', row.source_code,
          'sourceName', row.source_name,
          'value', row.golden_value,
          'receivedAt', row.received_at,
          'ageDays', row.age_days
        )
        ORDER BY row.received_at ASC, row.entity_name, row.attribute_name
      )
      FROM (
        SELECT * FROM stale
        ORDER BY received_at ASC, entity_name, attribute_name
        LIMIT 200
      ) row
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- data_quality_dashboard: 2 read(s) filtered.
CREATE OR REPLACE FUNCTION public.data_quality_dashboard(p_domain_code text DEFAULT NULL::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_knowledge_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entity_id uuid DEFAULT NULL::uuid, p_sections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'data_quality', 'entity_instances', 'metadata_register', 'golden_master', 'pg_catalog'
AS $function$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_from date := COALESCE(p_from_date, COALESCE(p_to_date, CURRENT_DATE) - 1);
  v_known timestamptz := COALESCE(p_knowledge_date, clock_timestamp());
  v_swap date;
  v_result jsonb;
  v_lists boolean := p_sections IS NULL OR 'availabilityEntities' = ANY(p_sections);
  v_entities boolean := p_sections IS NULL OR 'entities' = ANY(p_sections);
  v_scope uuid[];
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);
  PERFORM set_config('enable_nestloop', 'off', true);
  PERFORM set_config('work_mem', '64MB', true);
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);
  IF v_from > v_to THEN
    v_swap := v_from;
    v_from := v_to;
    v_to := v_swap;
  END IF;

  -- The records in scope, found first. The value reads below filter on this list, so a
  -- scope of a few records reads those records' values by index and not the whole table.
  SELECT COALESCE(array_agg(me.id), '{}'::uuid[])
  INTO v_scope
  FROM entity_instances.master_entities me
  WHERE me.is_active IS TRUE
    AND me.client_id IN (
      SELECT cid
      FROM tenancy.current_client_ids() AS cid
      WHERE tenancy.has_permission(cid, 'entity.read')
    )
    AND CASE
      WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
        THEN tenancy.has_entity_access(me.id, 'READ')
      ELSE TRUE
    END
    AND (v_domain IS NULL OR me.domain_code = v_domain) AND (p_entity_id IS NULL OR me.id = p_entity_id);

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id
    FROM entity_instances.master_entities me
    WHERE me.id = ANY(v_scope)
  ),
  resolved AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, snapshot.as_of)
      eav.entity_id,
      eav.attribute_id,
      snapshot.as_of,
      NULLIF(btrim(eav.golden_value), '') AS golden_value
    FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN (
      VALUES (v_from), (v_to)
    ) AS snapshot(as_of) ON TRUE
    WHERE eav.entity_id = ANY(v_scope)
      AND (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
      AND eav.valid_from <= snapshot.as_of
      AND eav.valid_to >= snapshot.as_of
    ORDER BY eav.entity_id, eav.attribute_id, snapshot.as_of, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  required_attr AS (
    SELECT s.id AS entity_id, s.entity_code, s.entity_name, s.domain_code,
           ar.id AS attribute_id, ar.attribute_code, ar.attribute_name
    FROM scoped s
    JOIN metadata_register.template_attribute_assignments taa
      ON taa.template_id = s.template_id
     AND taa.is_required IS TRUE
    JOIN metadata_register.attribute_register ar ON ar.id = taa.attribute_id
    WHERE s.template_id IS NOT NULL
    UNION
    SELECT s.id, s.entity_code, s.entity_name, s.domain_code,
           ar.id, ar.attribute_code, ar.attribute_name
    FROM scoped s
    JOIN metadata_register.attribute_register ar
      ON ar.domain_code = s.domain_code
     AND ar.is_required IS TRUE
    WHERE s.template_id IS NULL
  ),
  missing AS (
    SELECT r.*
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    WHERE rv.entity_id IS NULL
  ),
  value_map AS MATERIALIZED (
    SELECT rv.entity_id,
           jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS values
    FROM resolved rv
    JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
    WHERE rv.as_of = v_to
      AND rv.golden_value IS NOT NULL
    GROUP BY rv.entity_id
  ),
  active_rules AS (
    SELECT r.id, r.rule_code, r.rule_name, r.domain_code, r.rule_type, r.rule_severity,
           r.rule_expression, r.rule_description, ar.attribute_code, ar.attribute_name,
           data_quality.apply_compiled_rule(r.id, '{}'::jsonb, v_to) AS probe,
           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* ('^' || ar.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')) AS passes_when_blank
    FROM data_quality.dq_rules r
    LEFT JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
    WHERE r.is_active IS TRUE
      AND (v_domain IS NULL OR r.domain_code IS NULL OR r.domain_code = v_domain)
  ),
  accepted AS (
    SELECT DISTINCT ON (ex.rule_id, ex.entity_id)
           ex.rule_id, ex.entity_id, ex.status, ex.resolution_notes
    FROM data_quality.dq_exceptions ex
    WHERE ex.status IN ('WAIVED', 'FALSE_POSITIVE')
      AND ex.valid_from <= v_to
      AND ex.valid_to >= v_to
      AND ex.entity_id IN (SELECT id FROM scoped)
    ORDER BY ex.rule_id, ex.entity_id, ex.updated_at DESC NULLS LAST, ex.detected_at DESC
  ),
  rule_scope AS MATERIALIZED (
    SELECT aru.id AS rule_id, aru.attribute_code, aru.passes_when_blank, s.id AS entity_id
    FROM active_rules aru
    JOIN scoped s ON s.domain_code = aru.domain_code
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
    UNION ALL
    SELECT aru.id, aru.attribute_code, aru.passes_when_blank, s.id
    FROM active_rules aru
    CROSS JOIN scoped s
    WHERE aru.domain_code IS NULL
      AND COALESCE((aru.probe->>'evaluated')::boolean, false)
  ),
  rule_checks AS MATERIALIZED (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'message' AS message,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_to)
             END AS result
      FROM rule_scope rs
      LEFT JOIN value_map vm ON vm.entity_id = rs.entity_id
      WHERE NOT EXISTS (
        SELECT 1 FROM accepted ax
        WHERE ax.rule_id = rs.rule_id AND ax.entity_id = rs.entity_id
      )
      OFFSET 0  -- keeps the rule from being evaluated once per column read from it
    ) c
  ),
  rule_counts AS (
    SELECT rule_id,
           count(*)::int AS entity_count,
           count(*) FILTER (WHERE NOT passed)::int AS failing_count,
           count(*) FILTER (WHERE passed)::int AS passing_count
    FROM rule_checks
    GROUP BY rule_id
  ),
  failing_checks AS MATERIALIZED (
    SELECT rc.rule_id, rc.entity_id, rc.message, rc.actual_value,
           s.entity_code, s.entity_name, s.domain_code
    FROM rule_checks rc
    JOIN scoped s ON s.id = rc.entity_id
    WHERE NOT rc.passed
  ),
  prior_value_map AS MATERIALIZED (
    SELECT rv.entity_id,
           jsonb_object_agg(lower(ar.attribute_code), rv.golden_value) AS values
    FROM resolved rv
    JOIN metadata_register.attribute_register ar ON ar.id = rv.attribute_id
    WHERE v_from <> v_to
      AND rv.as_of = v_from
      AND rv.golden_value IS NOT NULL
    GROUP BY rv.entity_id
  ),
  changed_entities AS (
    SELECT COALESCE(cur.entity_id, prev.entity_id) AS entity_id
    FROM value_map cur
    FULL JOIN prior_value_map prev ON prev.entity_id = cur.entity_id
    WHERE cur.values IS DISTINCT FROM prev.values
  ),
  prior_checks AS (
    SELECT c.rule_id,
           c.entity_id,
           COALESCE((c.result->>'passed')::boolean, false) AS passed,
           c.result->>'actualValue' AS actual_value
    FROM (
      SELECT rs.rule_id,
             rs.entity_id,
             CASE
               WHEN rs.attribute_code IS NOT NULL
                AND NOT jsonb_exists(COALESCE(vm.values, '{}'::jsonb), lower(rs.attribute_code))
                AND rs.passes_when_blank
               THEN jsonb_build_object('passed', true, 'evaluated', true, 'message', NULL, 'actualValue', NULL)
               ELSE data_quality.apply_compiled_rule(rs.rule_id, COALESCE(vm.values, '{}'::jsonb), v_from)
             END AS result
      FROM rule_scope rs
      JOIN changed_entities ce ON ce.entity_id = rs.entity_id
      LEFT JOIN prior_value_map vm ON vm.entity_id = rs.entity_id
      WHERE v_from <> v_to
      OFFSET 0
    ) c
  ),
  rule_shift AS MATERIALIZED (
    SELECT rc.rule_id,
           rc.entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           pc.passed AS prior_passed,
           rc.passed AS current_passed,
           pc.actual_value AS previous_value,
           rc.actual_value AS current_value
    FROM rule_checks rc
    JOIN prior_checks pc ON pc.rule_id = rc.rule_id AND pc.entity_id = rc.entity_id
    JOIN scoped s ON s.id = rc.entity_id
    WHERE pc.passed <> rc.passed  -- only a changed outcome is ever reported
  ),
  paired AS (
    SELECT entity_id,
           attribute_id,
           max(golden_value) FILTER (WHERE as_of = v_from) AS previous_value,
           max(golden_value) FILTER (WHERE as_of = v_to) AS current_value
    FROM resolved
    GROUP BY entity_id, attribute_id
    HAVING max(golden_value) FILTER (WHERE as_of = v_from)
       IS DISTINCT FROM
       max(golden_value) FILTER (WHERE as_of = v_to)
  ),
  changes AS (
    SELECT p.entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           ar.domain_code AS attribute_domain_code,
           p.previous_value,
           p.current_value
    FROM paired p
    JOIN scoped s ON s.id = p.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = p.attribute_id
  ),
  required_values AS (
    SELECT r.entity_id,
           r.entity_code,
           r.entity_name,
           r.domain_code,
           r.attribute_id,
           rv.golden_value,
           fr.golden_value AS previous_value,
           fr.golden_value IS NOT NULL AS present_from,
           rv.golden_value IS NOT NULL AS present_to
    FROM required_attr r
    LEFT JOIN resolved rv
      ON rv.entity_id = r.entity_id
     AND rv.attribute_id = r.attribute_id
     AND rv.as_of = v_to
     AND rv.golden_value IS NOT NULL
    LEFT JOIN resolved fr
      ON fr.entity_id = r.entity_id
     AND fr.attribute_id = r.attribute_id
     AND fr.as_of = v_from
     AND fr.golden_value IS NOT NULL
  ),
  availability_rows AS (
    SELECT ar.attribute_code AS "attributeCode",
           ar.attribute_name AS "attributeName",
           req.domain_code AS "domainCode",
           count(DISTINCT req.entity_id)::int AS "requiredCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NULL)::int AS "missingCount",
           round(
             100.0 * count(DISTINCT req.entity_id) FILTER (WHERE req.golden_value IS NOT NULL)
             / NULLIF(count(DISTINCT req.entity_id), 0),
             1
           ) AS "availabilityPercent",
           count(DISTINCT req.entity_id) FILTER (WHERE NOT req.present_from AND req.present_to)::int AS "resolvedCount",
           count(DISTINCT req.entity_id) FILTER (WHERE req.present_from AND NOT req.present_to)::int AS "introducedCount",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code
               )
             ) FILTER (WHERE v_lists AND req.golden_value IS NULL),
             '[]'::jsonb
           ) AS "missingEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', NULL,
                 'currentValue', req.golden_value
               )
             ) FILTER (WHERE v_lists AND NOT req.present_from AND req.present_to),
             '[]'::jsonb
           ) AS "resolvedEntities",
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object(
                 'id', req.entity_id,
                 'entityCode', req.entity_code,
                 'entityName', req.entity_name,
                 'domainCode', req.domain_code,
                 'previousValue', req.previous_value,
                 'currentValue', NULL
               )
             ) FILTER (WHERE v_lists AND req.present_from AND NOT req.present_to),
             '[]'::jsonb
           ) AS "introducedEntities"
    FROM required_values req
    JOIN metadata_register.attribute_register ar ON ar.id = req.attribute_id
    GROUP BY ar.attribute_code, ar.attribute_name, req.domain_code
  ),
  quality_rows AS (
    SELECT aru.id AS "ruleId",
           aru.rule_code AS "ruleCode",
           aru.rule_name AS "ruleName",
           aru.rule_type AS "ruleType",
           aru.rule_severity AS "severity",
           aru.domain_code AS "domainCode",
           aru.rule_expression AS "ruleExpression",
           aru.rule_description AS "ruleDescription",
           aru.attribute_code AS "attributeCode",
           aru.attribute_name AS "attributeName",
           (SELECT count(*)::int FROM accepted ax WHERE ax.rule_id = aru.id) AS "acceptedCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', me.id,
                 'entityCode', me.entity_code,
                 'entityName', me.entity_name,
                 'domainCode', me.domain_code,
                 'status', ax.status,
                 'notes', ax.resolution_notes
               )
               ORDER BY me.entity_name
             )
             FROM accepted ax
             JOIN entity_instances.master_entities me ON me.id = ax.entity_id
             WHERE ax.rule_id = aru.id
           ), '[]'::jsonb) AS "acceptedEntities",
           COALESCE((aru.probe->>'evaluated')::boolean, false) AS "evaluated",
           CASE
             WHEN COALESCE((aru.probe->>'evaluated')::boolean, false) THEN NULL
             ELSE aru.probe->>'message'
           END AS "evaluationMessage",
           COALESCE(cnt.entity_count, 0) AS "entityCount",
           COALESCE(cnt.failing_count, 0) AS "failingCount",
           COALESCE(cnt.passing_count, 0) AS "passingCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', fc.entity_id,
                 'entityCode', fc.entity_code,
                 'entityName', fc.entity_name,
                 'domainCode', fc.domain_code,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY fc.entity_name
             )
             FROM failing_checks fc
             WHERE fc.rule_id = aru.id
           ), '[]'::jsonb) AS "failingEntities",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed), 0) AS "resolvedCount",
           COALESCE((SELECT count(*)::int FROM rule_shift rs WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed), 0) AS "introducedCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND NOT rs.prior_passed AND rs.current_passed
           ), '[]'::jsonb) AS "resolvedEntities",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', rs.entity_id,
                 'entityCode', rs.entity_code,
                 'entityName', rs.entity_name,
                 'domainCode', rs.domain_code,
                 'previousValue', rs.previous_value,
                 'currentValue', rs.current_value
               )
               ORDER BY rs.entity_name
             )
             FROM rule_shift rs
             WHERE rs.rule_id = aru.id AND rs.prior_passed AND NOT rs.current_passed
           ), '[]'::jsonb) AS "introducedEntities"
    FROM active_rules aru
    LEFT JOIN rule_counts cnt ON cnt.rule_id = aru.id
  ),
  trajectory_rows AS (
    SELECT c.attribute_code AS "attributeCode",
           c.attribute_name AS "attributeName",
           c.attribute_domain_code AS "domainCode",
           count(*)::int AS "changeCount",
           jsonb_agg(
             jsonb_build_object(
               'id', c.entity_id,
               'entityCode', c.entity_code,
               'entityName', c.entity_name,
               'domainCode', c.domain_code,
               'previousValue', c.previous_value,
               'currentValue', c.current_value
             )
             ORDER BY c.entity_name
           ) AS "changes"
    FROM changes c
    GROUP BY c.attribute_code, c.attribute_name, c.attribute_domain_code
  ),
  open_source_values AS (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id, eav.source_id)
           eav.entity_id,
           eav.attribute_id,
           NULLIF(btrim(eav.golden_value), '') AS golden_value,
           eav.golden_value_numeric,
           eav.precedence_rank,
           eav.is_manual_override,
           eav.override_reason,
           sr.source_code,
           sr.source_name,
           COALESCE(eav.last_received_at, eav.system_from) AS received_at,
           COALESCE(eav.source_id = golden_master.golden_source_at(eav.id, eav.golden_source_id, p_knowledge_date), FALSE) AS is_golden
    FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
    JOIN scoped s ON s.id = eav.entity_id
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = ANY(v_scope)
      AND (((p_knowledge_date IS NULL AND eav.system_to = '9999-12-31 23:59:59') OR (p_knowledge_date IS NOT NULL AND eav.system_from <= p_knowledge_date AND eav.system_to > p_knowledge_date)))
      AND eav.valid_from <= v_to
      AND eav.valid_to >= v_to
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id, eav.source_id, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  manual_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, override_reason
    FROM open_source_values
    WHERE is_manual_override IS TRUE OR source_code = 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  priority_current AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id, attribute_id, golden_value, golden_value_numeric, source_code, source_name
    FROM open_source_values
    WHERE COALESCE(is_manual_override, false) IS NOT TRUE
      AND source_code IS DISTINCT FROM 'MANUAL'
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  override_matches AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           m.golden_value AS override_value,
           m.override_reason,
           p.source_code AS priority_source_code,
           p.source_name AS priority_source_name,
           p.golden_value AS priority_value,
           (
             p.entity_id IS NOT NULL
             AND (
               data_quality.values_match(m.golden_value, p.golden_value)
               OR (
                 m.golden_value_numeric IS NOT NULL
                 AND p.golden_value_numeric IS NOT NULL
                 AND m.golden_value_numeric = p.golden_value_numeric
               )
             )
           ) AS ready
    FROM manual_current m
    LEFT JOIN priority_current p
      ON p.entity_id = m.entity_id
     AND p.attribute_id = m.attribute_id
    JOIN scoped s ON s.id = m.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
  ),
  entity_missing AS (
    SELECT entity_id,
           count(*)::int AS missing_count,
           jsonb_agg(
             jsonb_build_object(
               'attributeCode', attribute_code,
               'attributeName', attribute_name
             )
             ORDER BY attribute_name
           ) FILTER (WHERE v_entities) AS missing_attributes
    FROM missing
    GROUP BY entity_id
  ),
  entity_required AS (
    SELECT entity_id, count(*)::int AS required_count
    FROM required_attr
    GROUP BY entity_id
  ),
  entity_rules AS (
    SELECT cnt.entity_id,
           cnt.rule_count,
           cnt.failing_count,
           COALESCE(f.failing_rules, '[]'::jsonb) AS failing_rules
    FROM (
      SELECT entity_id,
             count(*)::int AS rule_count,
             count(*) FILTER (WHERE NOT passed)::int AS failing_count
      FROM rule_checks
      GROUP BY entity_id
    ) cnt
    LEFT JOIN (
      SELECT fc.entity_id,
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'message', fc.message,
                 'actualValue', fc.actual_value
               )
               ORDER BY aru.rule_name
             ) AS failing_rules
      FROM failing_checks fc
      JOIN active_rules aru ON aru.id = fc.rule_id
      WHERE v_entities
      GROUP BY fc.entity_id
    ) f ON f.entity_id = cnt.entity_id
  ),
  entity_accepted AS (
    SELECT ax.entity_id,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'ruleId', aru.id,
                 'ruleCode', aru.rule_code,
                 'ruleName', aru.rule_name,
                 'severity', aru.rule_severity,
                 'attributeCode', aru.attribute_code,
                 'attributeName', aru.attribute_name,
                 'status', ax.status,
                 'notes', ax.resolution_notes
               )
               ORDER BY aru.rule_name
             ),
             '[]'::jsonb
           ) AS accepted_rules
    FROM accepted ax
    JOIN active_rules aru ON aru.id = ax.rule_id
    GROUP BY ax.entity_id
  ),
  entity_availability_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT present_from AND present_to)::int AS resolved_count,
           count(*) FILTER (WHERE present_from AND NOT present_to)::int AS introduced_count
    FROM required_values
    GROUP BY entity_id
  ),
  entity_quality_movement AS (
    SELECT entity_id,
           count(*) FILTER (WHERE NOT prior_passed AND current_passed)::int AS resolved_count,
           count(*) FILTER (WHERE prior_passed AND NOT current_passed)::int AS introduced_count
    FROM rule_shift
    GROUP BY entity_id
  ),
  entity_override_matches AS (
    SELECT entity_id,
           count(*) FILTER (WHERE ready)::int AS match_count,
           count(*)::int AS override_count
    FROM override_matches
    GROUP BY entity_id
  ),
  entity_changes AS (
    SELECT entity_id,
           count(*)::int AS change_count,
           jsonb_agg(
             jsonb_build_object(
               'attributeCode', attribute_code,
               'attributeName', attribute_name,
               'previousValue', previous_value,
               'currentValue', current_value
             )
             ORDER BY attribute_name
           ) FILTER (WHERE v_entities) AS changes
    FROM changes
    GROUP BY entity_id
  ),
  prevailing AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           golden_value,
           golden_value_numeric,
           received_at
    FROM open_source_values
    ORDER BY entity_id, attribute_id, is_golden DESC, precedence_rank ASC, golden_value
  ),
  fresh_checks AS (
    SELECT p.entity_id,
           (p.received_at::date >= (v_to - 30)) AS passed
    FROM prevailing p
    WHERE p.source_code IS DISTINCT FROM 'DERIVED'
      AND p.source_code IS DISTINCT FROM 'CALCULATED'
  ),
  golden_active AS (
    SELECT DISTINCT ON (entity_id, attribute_id)
           entity_id,
           attribute_id,
           source_code,
           source_name,
           golden_value,
           golden_value_numeric
    FROM open_source_values
    WHERE is_golden
    ORDER BY entity_id, attribute_id, precedence_rank ASC, golden_value
  ),
  consensus_other AS (
    SELECT g.entity_id,
           g.attribute_id,
           g.source_code AS golden_source_code,
           g.source_name AS golden_source_name,
           g.golden_value,
           g.golden_value_numeric,
           o.source_code,
           o.source_name,
           o.golden_value AS other_value,
           COALESCE(
             data_quality.values_match(o.golden_value, g.golden_value)
             OR (
               o.golden_value_numeric IS NOT NULL
               AND g.golden_value_numeric IS NOT NULL
               AND o.golden_value_numeric = g.golden_value_numeric
             ),
             false
           ) AS agrees
    FROM golden_active g
    JOIN open_source_values o
      ON o.entity_id = g.entity_id
     AND o.attribute_id = g.attribute_id
     AND NOT o.is_golden
  ),
  consensus_checks AS (
    SELECT entity_id,
           attribute_id,
           bool_and(agrees) AS passed
    FROM consensus_other
    GROUP BY entity_id, attribute_id
  ),
  consensus_conflict_rows AS (
    SELECT s.id AS entity_id,
           s.entity_code,
           s.entity_name,
           s.domain_code,
           ar.attribute_code,
           ar.attribute_name,
           c.golden_source_code,
           c.golden_source_name,
           c.golden_value,
           c.source_code,
           c.source_name,
           c.other_value
    FROM consensus_other c
    JOIN scoped s ON s.id = c.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = c.attribute_id
    WHERE NOT c.agrees
  ),
  score_by_entity AS (
    SELECT entity_id,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability' AND passed), 0)::int AS availability_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'availability'), 0)::int AS availability_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality' AND passed), 0)::int AS quality_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'quality'), 0)::int AS quality_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness' AND passed), 0)::int AS freshness_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'freshness'), 0)::int AS freshness_applicable,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'consensus' AND passed), 0)::int AS consensus_passing,
           COALESCE(sum(weight) FILTER (WHERE dimension = 'consensus'), 0)::int AS consensus_applicable
    FROM (
      SELECT entity_id, 'availability'::text AS dimension, 1::numeric AS weight, present_to AS passed
      FROM required_values
      UNION ALL
      SELECT rc.entity_id,
             'quality',
             CASE upper(COALESCE(aru.rule_severity, ''))
               WHEN 'CRITICAL' THEN 8
               WHEN 'HIGH' THEN 4
               WHEN 'MEDIUM' THEN 2
               ELSE 1
             END,
             rc.passed
      FROM rule_checks rc
      JOIN active_rules aru ON aru.id = rc.rule_id
      UNION ALL
      SELECT entity_id, 'freshness', 1, passed FROM fresh_checks
      UNION ALL
      SELECT entity_id, 'consensus', 1, passed FROM consensus_checks
    ) facts
    GROUP BY entity_id
  ),
  waived_by_entity AS (
    SELECT ax.entity_id, count(*)::int AS waived
    FROM accepted ax
    JOIN active_rules aru ON aru.id = ax.rule_id
    GROUP BY ax.entity_id
  ),
  type_score_rows AS (
    SELECT s.domain_code,
           count(*)::int AS entity_count,
           COALESCE(sum(sc.availability_passing), 0)::int AS availability_passing,
           COALESCE(sum(sc.availability_applicable), 0)::int AS availability_applicable,
           COALESCE(sum(sc.quality_passing), 0)::int AS quality_passing,
           COALESCE(sum(sc.quality_applicable), 0)::int AS quality_applicable,
           COALESCE(sum(sc.freshness_passing), 0)::int AS freshness_passing,
           COALESCE(sum(sc.freshness_applicable), 0)::int AS freshness_applicable,
           COALESCE(sum(sc.consensus_passing), 0)::int AS consensus_passing,
           COALESCE(sum(sc.consensus_applicable), 0)::int AS consensus_applicable,
           COALESCE(sum(wv.waived), 0)::int AS waived_checks
    FROM scoped s
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
    GROUP BY s.domain_code
  ),
  entity_rows AS (
    SELECT s.id AS "id",
           s.entity_code AS "entityCode",
           s.entity_name AS "entityName",
           s.domain_code AS "domainCode",
           COALESCE(er.required_count, 0) AS "requiredCount",
           COALESCE(em.missing_count, 0) AS "missingCount",
           CASE
             WHEN COALESCE(er.required_count, 0) = 0 THEN NULL
             ELSE round(100.0 * (er.required_count - COALESCE(em.missing_count, 0)) / er.required_count, 1)
           END AS "availabilityPercent",
           COALESCE(em.missing_attributes, '[]'::jsonb) AS "missingAttributes",
           COALESCE(ru.rule_count, 0) AS "ruleCount",
           COALESCE(ru.failing_count, 0) AS "failingRuleCount",
           CASE
             WHEN COALESCE(ru.rule_count, 0) = 0 THEN NULL
             ELSE round(100.0 * (ru.rule_count - COALESCE(ru.failing_count, 0)) / ru.rule_count, 1)
           END AS "qualityPercent",
           COALESCE(ru.failing_rules, '[]'::jsonb) AS "failingRules",
           COALESCE(ea.accepted_rules, '[]'::jsonb) AS "acceptedRules",
           COALESCE(ec.change_count, 0) AS "changeCount",
           COALESCE(ec.changes, '[]'::jsonb) AS "changes",
           COALESCE(am.resolved_count, 0) AS "availabilityResolvedCount",
           COALESCE(am.introduced_count, 0) AS "availabilityIntroducedCount",
           COALESCE(qm.resolved_count, 0) AS "qualityResolvedCount",
           COALESCE(qm.introduced_count, 0) AS "qualityIntroducedCount",
           COALESCE(om.match_count, 0) AS "overrideMatchCount",
           COALESCE(om.override_count, 0) AS "overrideCount",
           COALESCE(sc.availability_passing, 0) AS "availabilityPassing",
           COALESCE(sc.availability_applicable, 0) AS "availabilityApplicable",
           COALESCE(sc.quality_passing, 0) AS "qualityPassing",
           COALESCE(sc.quality_applicable, 0) AS "qualityApplicable",
           COALESCE(sc.freshness_passing, 0) AS "freshnessPassing",
           COALESCE(sc.freshness_applicable, 0) AS "freshnessApplicable",
           COALESCE(sc.consensus_passing, 0) AS "consensusPassing",
           COALESCE(sc.consensus_applicable, 0) AS "consensusApplicable",
           COALESCE(wv.waived, 0) AS "waivedChecks"
    FROM scoped s
    LEFT JOIN entity_required er ON er.entity_id = s.id
    LEFT JOIN entity_missing em ON em.entity_id = s.id
    LEFT JOIN entity_rules ru ON ru.entity_id = s.id
    LEFT JOIN entity_accepted ea ON ea.entity_id = s.id
    LEFT JOIN entity_changes ec ON ec.entity_id = s.id
    LEFT JOIN entity_availability_movement am ON am.entity_id = s.id
    LEFT JOIN entity_quality_movement qm ON qm.entity_id = s.id
    LEFT JOIN entity_override_matches om ON om.entity_id = s.id
    LEFT JOIN score_by_entity sc ON sc.entity_id = s.id
    LEFT JOIN waived_by_entity wv ON wv.entity_id = s.id
  ),
  summary AS (
    SELECT
      (SELECT count(*)::int FROM scoped) AS entity_count,
      (SELECT count(*)::int FROM required_attr) AS required_slots,
      (SELECT count(*)::int FROM missing) AS missing_slots,
      (SELECT count(DISTINCT entity_id)::int FROM missing) AS entities_missing,
      (SELECT count(*)::int FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)) AS rules_evaluated,
      (SELECT COALESCE(sum(passing_count), 0)::int FROM rule_counts) AS passing_checks,
      (SELECT COALESCE(sum(failing_count), 0)::int FROM rule_counts) AS failing_checks,
      (SELECT count(DISTINCT entity_id)::int FROM failing_checks) AS entities_failing,
      (SELECT count(DISTINCT attribute_code)::int FROM changes) AS changed_attributes,
      (SELECT count(DISTINCT entity_id)::int FROM changes) AS changed_entities,
      (SELECT count(*)::int FROM changes) AS attribute_changes,
      (SELECT count(*)::int FROM entity_rows
        WHERE "missingCount" = 0 AND "failingRuleCount" = 0 AND "changeCount" = 0 AND "overrideMatchCount" = 0) AS clear_entities,
      (SELECT count(*)::int FROM required_values WHERE NOT present_from AND present_to) AS availability_resolved,
      (SELECT count(*)::int FROM required_values WHERE present_from AND NOT present_to) AS availability_introduced,
      (SELECT count(*)::int FROM rule_shift WHERE NOT prior_passed AND current_passed) AS quality_resolved,
      (SELECT count(*)::int FROM rule_shift WHERE prior_passed AND NOT current_passed) AS quality_introduced,
      (SELECT count(*)::int FROM override_matches WHERE ready) AS override_match_count
  )
  SELECT jsonb_build_object(
    'fromDate', to_char(v_from, 'YYYY-MM-DD'),
    'toDate', to_char(v_to, 'YYYY-MM-DD'),
    'domains', COALESCE((
      SELECT jsonb_agg(domain_code ORDER BY domain_code)
      FROM (
        SELECT DISTINCT domain_code
        FROM entity_instances.master_entities
        WHERE is_active IS TRUE
          AND domain_code IS NOT NULL
          AND client_id IN (
            SELECT cid
            FROM tenancy.current_client_ids() AS cid
            WHERE tenancy.has_permission(cid, 'entity.read')
          )
      ) d
    ), '[]'::jsonb),
    'consensusConflicts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', entity_id,
          'entityCode', entity_code,
          'entityName', entity_name,
          'domainCode', domain_code,
          'attributeCode', attribute_code,
          'attributeName', attribute_name,
          'goldenSourceCode', golden_source_code,
          'goldenSourceName', golden_source_name,
          'goldenValue', golden_value,
          'sourceCode', source_code,
          'sourceName', source_name,
          'value', other_value
        )
        ORDER BY entity_name, attribute_name, source_name
      )
      FROM consensus_conflict_rows
    ), '[]'::jsonb),
    'scores', (
      SELECT jsonb_build_object(
        'availabilityPassing', COALESCE(sum(availability_passing), 0),
        'availabilityApplicable', COALESCE(sum(availability_applicable), 0),
        'qualityPassing', COALESCE(sum(quality_passing), 0),
        'qualityApplicable', COALESCE(sum(quality_applicable), 0),
        'freshnessPassing', COALESCE(sum(freshness_passing), 0),
        'freshnessApplicable', COALESCE(sum(freshness_applicable), 0),
        'consensusPassing', COALESCE(sum(consensus_passing), 0),
        'consensusApplicable', COALESCE(sum(consensus_applicable), 0),
        'waivedChecks', COALESCE(sum(waived_checks), 0)
      )
      FROM type_score_rows
    ),
    'entityTypeScores', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'domainCode', domain_code,
          'entityCount', entity_count,
          'availabilityPassing', availability_passing,
          'availabilityApplicable', availability_applicable,
          'qualityPassing', quality_passing,
          'qualityApplicable', quality_applicable,
          'freshnessPassing', freshness_passing,
          'freshnessApplicable', freshness_applicable,
          'consensusPassing', consensus_passing,
          'consensusApplicable', consensus_applicable,
          'waivedChecks', waived_checks
        )
        ORDER BY domain_code
      )
      FROM type_score_rows
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'entityCount', entity_count,
        'requiredSlots', required_slots,
        'populatedSlots', required_slots - missing_slots,
        'missingSlots', missing_slots,
        'entitiesMissingRequired', entities_missing,
        'availabilityPercent', CASE
          WHEN required_slots = 0 THEN NULL
          ELSE round(100.0 * (required_slots - missing_slots) / required_slots, 1)
        END,
        'rulesEvaluated', rules_evaluated,
        'passingChecks', passing_checks,
        'failingChecks', failing_checks,
        'entitiesFailingRules', entities_failing,
        'qualityPercent', CASE
          WHEN passing_checks + failing_checks = 0 THEN NULL
          WHEN failing_checks = 0 THEN 100.0
          ELSE least(99.9, round(100.0 * passing_checks / (passing_checks + failing_checks), 1))
        END,
        'changedAttributeCount', changed_attributes,
        'changedEntityCount', changed_entities,
        'attributeChangeCount', attribute_changes,
        'clearEntityCount', clear_entities,
        'availabilityResolvedCount', availability_resolved,
        'availabilityIntroducedCount', availability_introduced,
        'qualityResolvedCount', quality_resolved,
        'qualityIntroducedCount', quality_introduced,
        'overrideMatchCount', override_match_count
      )
      FROM summary
    ),
    'availability', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a."missingCount" DESC, a."attributeName")
      FROM availability_rows a
    ), '[]'::jsonb),
    'quality', COALESCE((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q."failingCount" DESC, q."ruleName")
      FROM quality_rows q
    ), '[]'::jsonb),
    'trajectory', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t."changeCount" DESC, t."attributeName")
      FROM trajectory_rows t
    ), '[]'::jsonb),
    'overrideMatches', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', o.entity_id,
          'entityCode', o.entity_code,
          'entityName', o.entity_name,
          'domainCode', o.domain_code,
          'attributeCode', o.attribute_code,
          'attributeName', o.attribute_name,
          'overrideValue', o.override_value,
          'overrideReason', o.override_reason,
          'prioritySourceCode', o.priority_source_code,
          'prioritySourceName', o.priority_source_name,
          'priorityValue', o.priority_value,
          'ready', o.ready
        )
        ORDER BY o.ready DESC, o.entity_name, o.attribute_name
      )
      FROM override_matches o
    ), '[]'::jsonb),
    'entities', CASE WHEN v_entities THEN COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY (e."missingCount" + e."failingRuleCount" + e."changeCount" + e."overrideMatchCount") DESC, e."entityName")
      FROM entity_rows e
      WHERE e."missingCount" > 0 OR e."failingRuleCount" > 0 OR e."changeCount" > 0 OR e."overrideMatchCount" > 0
         OR e."availabilityResolvedCount" > 0 OR e."availabilityIntroducedCount" > 0
         OR e."qualityResolvedCount" > 0 OR e."qualityIntroducedCount" > 0 OR e."overrideCount" > 0
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- confirm_attribute_receipt: 1 read(s) filtered.
CREATE OR REPLACE FUNCTION public.confirm_attribute_receipt(p_entity_id uuid, p_attribute_code text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_catalog'
AS $function$
DECLARE
  v_attribute_id uuid;
  v_id uuid;
  v_received timestamptz := clock_timestamp();
BEGIN
  IF p_entity_id IS NULL OR NULLIF(btrim(COALESCE(p_attribute_code, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Entity and attribute are required' USING ERRCODE = '22023';
  END IF;

  IF NOT tenancy.has_entity_access(p_entity_id, 'WRITE') THEN
    RAISE EXCEPTION 'You cannot update this entity' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_attribute_id
  FROM metadata_register.attribute_register
  WHERE attribute_code = btrim(p_attribute_code);

  IF v_attribute_id IS NULL THEN
    RAISE EXCEPTION 'Unknown attribute %', p_attribute_code USING ERRCODE = '22023';
  END IF;

  SELECT eav.id INTO v_id
  FROM (SELECT * FROM golden_master.entity_attribute_values WHERE attribute_id NOT IN (SELECT tenancy.hidden_attribute_ids())) eav
  WHERE eav.entity_id = p_entity_id
    AND eav.attribute_id = v_attribute_id
    AND eav.system_to = '9999-12-31 23:59:59'
    AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
  ORDER BY
    (eav.golden_source_id IS NOT NULL AND eav.source_id = eav.golden_source_id) DESC,
    eav.precedence_rank ASC,
    eav.valid_from DESC
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No current value to confirm' USING ERRCODE = '02000';
  END IF;

  UPDATE golden_master.entity_attribute_values
  SET last_received_at = v_received
  WHERE id = v_id;

  RETURN v_received;
END;
$function$;


-- set_client_attributes_hidden: showing an attribute again no longer drops its access level.
CREATE OR REPLACE FUNCTION public.set_client_attributes_hidden(p_attribute_ids uuid[], p_hidden boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'metadata_register', 'tenancy', 'pg_temp'
AS $function$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_count INTEGER;
  v_kept INTEGER := 0;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'Open one client to choose the fields it hides' USING ERRCODE = '42501';
  END IF;
  IF NOT tenancy.can_write_schema_row(v_client) THEN
    RAISE EXCEPTION 'You cannot change this client''s fields' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_hidden, FALSE) THEN
    INSERT INTO metadata_register.client_attribute_settings (client_id, attribute_id, is_hidden, updated_by)
    SELECT v_client, ar.id, TRUE, auth.uid()
    FROM metadata_register.attribute_register AS ar
    WHERE ar.id = ANY (COALESCE(p_attribute_ids, '{}'::uuid[]))
    ON CONFLICT (client_id, attribute_id)
    DO UPDATE SET is_hidden = TRUE, updated_by = EXCLUDED.updated_by;
  ELSE
    -- Showing an attribute again keeps its access level (20261126170000).
    UPDATE metadata_register.client_attribute_settings
    SET is_hidden = FALSE, updated_by = auth.uid()
    WHERE client_id = v_client
      AND attribute_id = ANY (COALESCE(p_attribute_ids, '{}'::uuid[]))
      AND access_level IS NOT NULL;
    GET DIAGNOSTICS v_kept = ROW_COUNT;
    DELETE FROM metadata_register.client_attribute_settings
    WHERE client_id = v_client
      AND attribute_id = ANY (COALESCE(p_attribute_ids, '{}'::uuid[]))
      AND access_level IS NULL;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_count := v_count + v_kept;
  RETURN v_count;
END;
$function$;

-- The attribute view the app reads: the catalog's level, the open client's own
-- level, and whether this caller's values are hidden (to show "Restricted").
CREATE OR REPLACE VIEW public.attribute_register WITH (security_invoker = on) AS
 SELECT id,
    attribute_code,
    attribute_name,
    data_type,
    description,
    unit_of_measure,
    validation_regex,
    is_required,
    is_multi_valued,
    reference_domain_code,
    default_precedence_rank,
    metadata,
    created_at,
    updated_at,
    is_derived,
    display_format,
    list_values,
    validation_rules,
    default_value,
    display_section,
    display_group,
    is_editable,
    (is_visible AND (NOT (id = ANY (( SELECT metadata_register.session_hidden_attribute_ids() AS session_hidden_attribute_ids)::uuid[])))) AS is_visible,
    derivation_formula,
    derivation_dependencies,
    derivation_type,
    formula_language,
    aggregation_type,
    weight_attribute_code,
    numeric_precision,
    domain_code,
    reference_list_code,
    is_time_varying,
    time_dimension,
    client_id,
    reporting_grain,
    period_alignment,
    period_rollup,
    display_span_columns,
    display_span_rows,
    reference_list_level,
    controlling_attribute_code,
    is_visible AS catalog_is_visible,
    (id = ANY (( SELECT metadata_register.session_hidden_attribute_ids() AS session_hidden_attribute_ids)::uuid[])) AS hidden_for_client,
    access_level,
    ( SELECT s.access_level
           FROM metadata_register.client_attribute_settings s
          WHERE s.client_id = tenancy.presentation_client_id() AND s.attribute_id = ar.id) AS client_access_level,
    (id IN ( SELECT tenancy.hidden_attribute_ids() AS hidden_attribute_ids)) AS value_hidden
   FROM metadata_register.attribute_register ar;

NOTIFY pgrst, 'reload schema';
