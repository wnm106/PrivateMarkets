-- Curated client experience.
--
-- A client with curated_modules stays on the full catalog: every global entity
-- type, surface, shared workflow, and tool. A curated client sees only what a
-- tenant admin saved for it. Saving copies the module's contents into grants,
-- so a module that later gains a new entity type or workflow does not appear
-- for that client until an admin saves the choice again.
--
-- Client-owned workflows and client-owned entity types stay available. Turning
-- a module off hides its records and stops a shared workflow from starting. It
-- does not delete anything.

ALTER TABLE tenancy.clients
  ADD COLUMN IF NOT EXISTS curated_modules BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenancy.clients.curated_modules IS
  'When true, this client sees only the entities, surfaces, workflows, and tools last saved for it.';

CREATE TABLE IF NOT EXISTS tenancy.module_catalog (
  module_code TEXT PRIMARY KEY,
  module_name TEXT NOT NULL,
  description TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  domain_codes TEXT[] NOT NULL DEFAULT '{}',
  surface_codes TEXT[] NOT NULL DEFAULT '{}',
  workflow_codes TEXT[] NOT NULL DEFAULT '{}',
  tool_hrefs TEXT[] NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE tenancy.module_catalog IS
  'Product areas a tenant admin can turn on for a curated client. The arrays are the contents at the time this row was written.';

CREATE TABLE IF NOT EXISTS tenancy.client_modules (
  client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES tenancy.module_catalog(module_code),
  PRIMARY KEY (client_id, module_code)
);

COMMENT ON TABLE tenancy.client_modules IS
  'Modules a tenant admin last saved for a curated client. The grants table is what the app enforces.';

CREATE TABLE IF NOT EXISTS tenancy.client_module_grants (
  client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('domain', 'surface', 'workflow', 'tool')),
  code TEXT NOT NULL,
  PRIMARY KEY (client_id, kind, code)
);

COMMENT ON TABLE tenancy.client_module_grants IS
  'Expanded allowlist copied from the module catalog when an admin saves. Kind is domain, surface, workflow, or tool.';

CREATE INDEX IF NOT EXISTS idx_client_module_grants_lookup
  ON tenancy.client_module_grants (client_id, kind);

-- One module per catalog group, holding the global entity types in that group today.
INSERT INTO tenancy.module_catalog (module_code, module_name, description, display_order, domain_codes)
SELECT
  lower(g.group_code),
  g.group_name,
  COALESCE(NULLIF(btrim(g.description), ''), g.group_name),
  g.display_order,
  COALESCE((
    SELECT array_agg(dt.domain_code ORDER BY dt.display_order, dt.domain_code)
    FROM metadata_register.domain_types AS dt
    WHERE dt.group_id = g.id AND dt.client_id IS NULL
  ), '{}')
FROM metadata_register.domain_groups AS g;

UPDATE tenancy.module_catalog
SET surface_codes = ARRAY['fund-index'],
    workflow_codes = ARRAY['FUND_RECONCILIATION', 'NAV_REVIEW', 'CASH_TIE_OUT'],
    tool_hrefs = ARRAY['/fund-surface', '/fund-rec', '/workflows']
WHERE module_code = 'funds';

UPDATE tenancy.module_catalog
SET surface_codes = ARRAY['deal-pipeline'],
    workflow_codes = ARRAY['CLOSING_READINESS'],
    tool_hrefs = ARRAY['/s/deal-pipeline', '/workflows']
WHERE module_code = 'deals';

INSERT INTO tenancy.module_catalog (module_code, module_name, description, display_order, domain_codes, surface_codes, workflow_codes, tool_hrefs)
SELECT
  'other-records',
  'Other records',
  'Entity types that sit outside a catalog group.',
  80,
  COALESCE(array_agg(dt.domain_code ORDER BY dt.domain_code), '{}'),
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[]
FROM metadata_register.domain_types AS dt
WHERE dt.group_id IS NULL AND dt.client_id IS NULL
HAVING count(*) > 0;

INSERT INTO tenancy.module_catalog (module_code, module_name, description, display_order, workflow_codes, tool_hrefs)
VALUES
  (
    'file-intake',
    'File intake',
    'Load a file and run the published file intake workflow. Turn on the entity types that file writes to as well.',
    110,
    ARRAY['FILE_INTAKE'],
    ARRAY['/imports', '/workflows']
  ),
  (
    'documents',
    'Documents',
    'The document library.',
    120,
    '{}',
    ARRAY['/documents']
  ),
  (
    'assistant',
    'Assistant',
    'The assistant and its briefs. The assistant still has its own on switch.',
    130,
    '{}',
    ARRAY['/assistant']
  ),
  (
    'data-operations',
    'Data operations',
    'Resolution, reconciliation, value lists, composite entities, and data-quality workflows.',
    140,
    ARRAY['DATA_CLEANUP', 'DATA_QUALITY_BRIEF', 'REQUIRED_VALUES_CHECK'],
    ARRAY['/merge', '/reconcile', '/lists', '/intersections', '/quality', '/workflows']
  );

-- ------------------------------------------------------------
-- Scope: who is looking, and which codes they may use
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION tenancy.catalog_restricted()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM tenancy.current_client_ids()) THEN FALSE
    -- A tenant admin setting up clients sees the whole product.
    -- While simulating a client, they see that client's experience.
    WHEN tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM tenancy.clients AS c
      JOIN tenancy.current_client_ids() AS ids ON ids = c.id
      WHERE c.curated_modules = FALSE
    )
  END;
$$;

COMMENT ON FUNCTION tenancy.catalog_restricted() IS
  'TRUE when every client in this session is curated. FALSE for a tenant admin who is not simulating a client, and when any current client uses the full catalog.';

CREATE OR REPLACE FUNCTION tenancy.enabled_grant_codes(p_kind TEXT)
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT DISTINCT g.code
  FROM tenancy.client_module_grants AS g
  JOIN tenancy.current_client_ids() AS ids ON ids = g.client_id
  WHERE g.kind = p_kind;
$$;

COMMENT ON FUNCTION tenancy.enabled_grant_codes(TEXT) IS
  'Codes of one kind granted to the clients in this session.';

CREATE OR REPLACE FUNCTION tenancy.domain_in_scope(p_domain_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, metadata_register, pg_temp
AS $$
  SELECT NOT tenancy.catalog_restricted()
    OR EXISTS (
      SELECT 1 FROM tenancy.enabled_grant_codes('domain') AS code WHERE code = p_domain_code
    )
    OR EXISTS (
      SELECT 1
      FROM metadata_register.domain_types AS dt
      WHERE dt.domain_code = p_domain_code
        AND dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    );
$$;

COMMENT ON FUNCTION tenancy.domain_in_scope(TEXT) IS
  'TRUE when this session may see an entity type: the catalog is open, the type was saved for the client, or the client owns the type.';

CREATE OR REPLACE FUNCTION tenancy.shared_workflow_visible(p_owner UUID, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT p_owner IS NOT NULL
    OR NOT tenancy.catalog_restricted()
    OR EXISTS (
      SELECT 1
      FROM tenancy.client_module_grants AS g
      JOIN tenancy.current_client_ids() AS ids ON ids = g.client_id
      WHERE g.kind = 'workflow' AND g.code = p_code
    );
$$;

COMMENT ON FUNCTION tenancy.shared_workflow_visible(UUID, TEXT) IS
  'A client-owned workflow stays visible. A shared workflow is visible when the session is unrestricted or the code was saved for a current client.';

CREATE OR REPLACE FUNCTION tenancy.client_workflow_allowed(p_client_id UUID, p_code TEXT, p_owner UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT p_owner IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM tenancy.clients AS c
      WHERE c.id = p_client_id AND c.curated_modules
    )
    OR EXISTS (
      SELECT 1
      FROM tenancy.client_module_grants AS g
      WHERE g.client_id = p_client_id AND g.kind = 'workflow' AND g.code = p_code
    );
$$;

COMMENT ON FUNCTION tenancy.client_workflow_allowed(UUID, TEXT, UUID) IS
  'Whether a run of this workflow may start for this client. Client-owned workflows are allowed. A shared workflow on a curated client must be in that client''s grants.';

CREATE OR REPLACE FUNCTION tenancy.module_scope()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT CASE
    WHEN NOT tenancy.catalog_restricted() THEN
      jsonb_build_object('restricted', FALSE, 'surfaces', '[]'::jsonb, 'tools', '[]'::jsonb)
    ELSE jsonb_build_object(
      'restricted', TRUE,
      'surfaces', COALESCE((SELECT jsonb_agg(DISTINCT code) FROM tenancy.enabled_grant_codes('surface') AS code), '[]'::jsonb),
      'tools', COALESCE((SELECT jsonb_agg(DISTINCT code) FROM tenancy.enabled_grant_codes('tool') AS code), '[]'::jsonb)
    )
  END;
$$;

COMMENT ON FUNCTION tenancy.module_scope() IS
  'Surfaces and tools for the sidebar. restricted is false when this session uses the full catalog.';

CREATE OR REPLACE FUNCTION tenancy.set_client_modules(
  p_client_id UUID,
  p_curated BOOLEAN,
  p_module_codes TEXT[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
  v_unknown TEXT;
BEGIN
  IF NOT tenancy.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin can choose a client''s experience' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenancy.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT chosen.code INTO v_unknown
  FROM unnest(COALESCE(p_module_codes, ARRAY[]::TEXT[])) AS chosen(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM tenancy.module_catalog AS catalog WHERE catalog.module_code = chosen.code
  )
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown module %', v_unknown USING ERRCODE = '22023';
  END IF;

  UPDATE tenancy.clients
  SET curated_modules = COALESCE(p_curated, FALSE)
  WHERE id = p_client_id;

  DELETE FROM tenancy.client_module_grants WHERE client_id = p_client_id;
  DELETE FROM tenancy.client_modules WHERE client_id = p_client_id;

  IF COALESCE(p_curated, FALSE) THEN
    INSERT INTO tenancy.client_modules (client_id, module_code)
    SELECT DISTINCT p_client_id, chosen.code
    FROM unnest(COALESCE(p_module_codes, ARRAY[]::TEXT[])) AS chosen(code);

    INSERT INTO tenancy.client_module_grants (client_id, kind, code)
    SELECT p_client_id, item.kind, item.code
    FROM tenancy.module_catalog AS catalog
    JOIN unnest(COALESCE(p_module_codes, ARRAY[]::TEXT[])) AS chosen(code)
      ON chosen.code = catalog.module_code
    CROSS JOIN LATERAL (
      SELECT 'domain'::TEXT AS kind, domain_code AS code FROM unnest(catalog.domain_codes) AS domain_code
      UNION ALL
      SELECT 'surface', surface_code FROM unnest(catalog.surface_codes) AS surface_code
      UNION ALL
      SELECT 'workflow', workflow_code FROM unnest(catalog.workflow_codes) AS workflow_code
      UNION ALL
      SELECT 'tool', tool_href FROM unnest(catalog.tool_hrefs) AS tool_href
    ) AS item
    WHERE item.code IS NOT NULL AND btrim(item.code) <> ''
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

COMMENT ON FUNCTION tenancy.set_client_modules(UUID, BOOLEAN, TEXT[]) IS
  'Tenant-admin-only. Turns curated mode on or off and replaces that client''s saved modules and grants.';

GRANT EXECUTE ON FUNCTION tenancy.catalog_restricted() TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.enabled_grant_codes(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.domain_in_scope(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.shared_workflow_visible(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.client_workflow_allowed(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.module_scope() TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.set_client_modules(UUID, BOOLEAN, TEXT[]) TO authenticated;

ALTER TABLE tenancy.module_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.client_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.client_module_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS module_catalog_read ON tenancy.module_catalog;
CREATE POLICY module_catalog_read ON tenancy.module_catalog
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS client_modules_read ON tenancy.client_modules;
CREATE POLICY client_modules_read ON tenancy.client_modules
  FOR SELECT TO authenticated
  USING (tenancy.is_tenant_admin() OR client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS client_module_grants_read ON tenancy.client_module_grants;
CREATE POLICY client_module_grants_read ON tenancy.client_module_grants
  FOR SELECT TO authenticated
  USING (tenancy.is_tenant_admin() OR client_id IN (SELECT tenancy.current_client_ids()));

GRANT SELECT ON tenancy.module_catalog TO authenticated, service_role;
GRANT SELECT ON tenancy.client_modules TO authenticated, service_role;
GRANT SELECT ON tenancy.client_module_grants TO authenticated, service_role;

-- Entity types and records follow the grants. Client-owned types stay visible to that client.
DROP POLICY IF EXISTS domain_types_module_scope ON metadata_register.domain_types;
CREATE POLICY domain_types_module_scope ON metadata_register.domain_types
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (tenancy.domain_in_scope(domain_code));

DROP POLICY IF EXISTS master_entities_module_select ON entity_instances.master_entities;
CREATE POLICY master_entities_module_select ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );

DROP POLICY IF EXISTS master_entities_module_insert ON entity_instances.master_entities;
CREATE POLICY master_entities_module_insert ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );

DROP POLICY IF EXISTS master_entities_module_update ON entity_instances.master_entities;
CREATE POLICY master_entities_module_update ON entity_instances.master_entities
  AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  )
  WITH CHECK (
    NOT tenancy.catalog_restricted()
    OR domain_code IN (SELECT tenancy.enabled_grant_codes('domain'))
    OR domain_code IN (
      SELECT dt.domain_code
      FROM metadata_register.domain_types AS dt
      WHERE dt.client_id IS NOT NULL
        AND dt.client_id IN (SELECT tenancy.current_client_ids())
    )
  );

-- Shared workflows follow the same grants. Client-owned workflows do not.
CREATE OR REPLACE FUNCTION public.workflow_list()
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(w) || jsonb_build_object(
        'can_manage', ops.workflow_can(w.client_id, 'workflow.manage'),
        'run_count', (SELECT count(*) FROM ops.workflow_runs AS r WHERE r.workflow_id = w.id AND ops.workflow_can_see(r.client_id)),
        'last_run_at', (SELECT max(r.created_at) FROM ops.workflow_runs AS r WHERE r.workflow_id = w.id AND ops.workflow_can_see(r.client_id))
    )
    FROM ops.workflows AS w
    WHERE w.is_active
      AND ops.workflow_can_see(w.client_id)
      AND tenancy.shared_workflow_visible(w.client_id, w.workflow_code)
    ORDER BY w.workflow_name;
$$;

CREATE OR REPLACE FUNCTION public.workflow_get(p_id UUID, p_version INTEGER DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(w) || jsonb_build_object(
        'can_manage', ops.workflow_can(w.client_id, 'workflow.manage'),
        'version', v.version,
        'graph', v.graph,
        'versions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'version', h.version, 'change_note', h.change_note, 'created_by', h.created_by, 'created_at', h.created_at
            ) ORDER BY h.version DESC)
            FROM ops.workflow_versions AS h WHERE h.workflow_id = w.id
        ), '[]'::jsonb)
    )
    FROM ops.workflows AS w
    LEFT JOIN ops.workflow_versions AS v
           ON v.workflow_id = w.id AND v.version = COALESCE(p_version, w.latest_version)
    WHERE w.id = p_id
      AND ops.workflow_can_see(w.client_id)
      AND tenancy.shared_workflow_visible(w.client_id, w.workflow_code);
$$;

CREATE OR REPLACE FUNCTION public.workflow_run_start(
    p_workflow_id UUID,
    p_client_id UUID,
    p_input JSONB DEFAULT '{}',
    p_version INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_workflow ops.workflows;
    v_version ops.workflow_versions;
    v_user UUID := auth.uid();
    v_run_id UUID;
BEGIN
    IF ops.is_service_role() THEN
        v_user := COALESCE(p_user_id, v_user);
    END IF;
    IF p_client_id IS NULL THEN
        RAISE EXCEPTION 'A run needs a client' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_workflow FROM ops.workflows WHERE id = p_workflow_id AND is_active;
    IF NOT FOUND OR NOT ops.workflow_can_see(v_workflow.client_id) THEN
        RAISE EXCEPTION 'Workflow was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_workflow.client_id IS NOT NULL AND v_workflow.client_id <> p_client_id THEN
        RAISE EXCEPTION 'This workflow belongs to another client' USING ERRCODE = '42501';
    END IF;
    IF NOT tenancy.client_workflow_allowed(p_client_id, v_workflow.workflow_code, v_workflow.client_id) THEN
        RAISE EXCEPTION 'This workflow is not enabled for this client' USING ERRCODE = '42501';
    END IF;
    IF NOT ops.workflow_can(p_client_id, 'workflow.run') THEN
        RAISE EXCEPTION 'You cannot run workflows for this client' USING ERRCODE = '42501';
    END IF;
    IF p_version IS NOT NULL AND p_version IS DISTINCT FROM v_workflow.published_version
       AND NOT ops.workflow_can(v_workflow.client_id, 'workflow.manage') THEN
        RAISE EXCEPTION 'Only the published version can be run' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(p_version, v_workflow.published_version) IS NULL THEN
        RAISE EXCEPTION 'This workflow has not been published' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_version FROM ops.workflow_versions
     WHERE workflow_id = p_workflow_id AND version = COALESCE(p_version, v_workflow.published_version);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That version does not exist' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO ops.workflow_runs (client_id, workflow_id, version_id, version, input, started_by)
    VALUES (p_client_id, p_workflow_id, v_version.id, v_version.version, COALESCE(p_input, '{}'::jsonb), v_user)
    RETURNING id INTO v_run_id;

    PERFORM ops.workflow_log(v_run_id, NULL, 'run.started', CASE WHEN v_user IS NULL THEN 'SYSTEM' ELSE 'USER' END, v_user,
        'Run started on version ' || v_version.version, jsonb_build_object('input', COALESCE(p_input, '{}'::jsonb)));
    PERFORM ops.workflow_queue_advance(v_run_id, p_client_id, v_user);
    RETURN v_run_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
