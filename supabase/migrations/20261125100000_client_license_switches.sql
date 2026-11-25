-- License switches: turn one surface, workflow, page or assistant tool group on
-- or off for one client.
--
-- Modules (20261120160000_client_modules.sql) choose whole product areas for a
-- curated client. A switch sits on top of that, for any client, curated or not:
--   on   the item is available even if no saved module holds it
--   off  the item is unavailable even if a module holds it, or the client uses
--        the full catalog
--   no switch  the item follows the client's modules, as before
--
-- Kinds and codes:
--   surface         a surface code, such as the code in /s/<code>
--   workflow        a shared workflow's workflow_code
--   tool            a page href in the app, the same codes the module catalog holds
--   assistant_tool  a tool category in the tool registry (reconciliation,
--                   compliance, narrative, ...). Assistant tools are not part of
--                   modules, so a group is on until a switch turns it off.
--
-- tenancy.client_item_enabled is the one place that decides (with
-- tenancy.client_plan_enabled for what the modules give). The workflow
-- functions, module_scope, the web app and the tool registry all ask it.
-- A client-owned workflow is the client's own work and is not licensed, so
-- switches do not reach it.

-- ============================================================
-- 1. Switches
-- ============================================================
CREATE TABLE IF NOT EXISTS tenancy.client_license_switches (
  client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('surface', 'workflow', 'tool', 'assistant_tool')),
  code TEXT NOT NULL CHECK (btrim(code) <> ''),
  enabled BOOLEAN NOT NULL,
  note TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, kind, code)
);

COMMENT ON TABLE tenancy.client_license_switches IS
  'One client''s license switch for one surface, workflow, page or assistant tool group. Overrides the client''s modules either way. No row means the item follows the modules.';

ALTER TABLE tenancy.client_license_switches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_license_switches_read ON tenancy.client_license_switches;
CREATE POLICY client_license_switches_read ON tenancy.client_license_switches
  FOR SELECT TO authenticated
  USING (tenancy.is_tenant_admin() OR client_id IN (SELECT tenancy.current_client_ids()));

GRANT SELECT ON tenancy.client_license_switches TO authenticated, service_role;

-- ============================================================
-- 2. The one decision
-- ============================================================
-- What the client's modules give it, before any switch.
CREATE OR REPLACE FUNCTION tenancy.client_plan_enabled(p_client_id UUID, p_kind TEXT, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT CASE
    -- Assistant tool groups are not in modules: on until switched off.
    WHEN p_kind = 'assistant_tool' THEN TRUE
    -- A client on the full catalog has everything.
    WHEN NOT EXISTS (
      SELECT 1 FROM tenancy.clients AS c WHERE c.id = p_client_id AND c.curated_modules
    ) THEN TRUE
    -- A curated client has what its saved modules granted.
    ELSE EXISTS (
      SELECT 1
      FROM tenancy.client_module_grants AS g
      WHERE g.client_id = p_client_id AND g.kind = p_kind AND g.code = p_code
    )
  END;
$$;

COMMENT ON FUNCTION tenancy.client_plan_enabled(UUID, TEXT, TEXT) IS
  'Whether one client''s modules give it one item, before any license switch. Assistant tool groups and full-catalog clients default to on.';

CREATE OR REPLACE FUNCTION tenancy.client_item_enabled(p_client_id UUID, p_kind TEXT, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT COALESCE(
    (
      SELECT s.enabled
      FROM tenancy.client_license_switches AS s
      WHERE s.client_id = p_client_id AND s.kind = p_kind AND s.code = p_code
    ),
    tenancy.client_plan_enabled(p_client_id, p_kind, p_code)
  );
$$;

COMMENT ON FUNCTION tenancy.client_item_enabled(UUID, TEXT, TEXT) IS
  'Whether one client is licensed for one surface, workflow, page or assistant tool group: its switch if it has one, else its modules.';

CREATE OR REPLACE FUNCTION tenancy.item_enabled(p_kind TEXT, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT CASE
    -- The same sessions catalog_restricted leaves open: no client in the
    -- session (the service role), or a tenant admin who is not simulating a client.
    WHEN NOT EXISTS (SELECT 1 FROM tenancy.current_client_ids()) THEN TRUE
    WHEN tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL THEN TRUE
    ELSE EXISTS (
      SELECT 1
      FROM tenancy.current_client_ids() AS ids(id)
      WHERE tenancy.client_item_enabled(ids.id, p_kind, p_code)
    )
  END;
$$;

COMMENT ON FUNCTION tenancy.item_enabled(TEXT, TEXT) IS
  'Whether this session may use one surface, workflow, page or assistant tool group: TRUE when any client in the session is licensed for it.';

-- ============================================================
-- 3. Setting a switch
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.set_client_license_switch(
  p_client_id UUID,
  p_kind TEXT,
  p_code TEXT,
  p_enabled BOOLEAN,
  p_note TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
  IF NOT tenancy.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin can change a client''s license' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenancy.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('surface', 'workflow', 'tool', 'assistant_tool') THEN
    RAISE EXCEPTION 'Unknown kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'A switch needs a code' USING ERRCODE = '22023';
  END IF;

  -- Null clears the switch, so the item follows the client's modules again.
  IF p_enabled IS NULL THEN
    DELETE FROM tenancy.client_license_switches
    WHERE client_id = p_client_id AND kind = p_kind AND code = btrim(p_code);
    RETURN;
  END IF;

  INSERT INTO tenancy.client_license_switches (client_id, kind, code, enabled, note, updated_by, updated_at)
  VALUES (p_client_id, p_kind, btrim(p_code), p_enabled, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid(), NOW())
  ON CONFLICT (client_id, kind, code) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
END;
$$;

COMMENT ON FUNCTION tenancy.set_client_license_switch(UUID, TEXT, TEXT, BOOLEAN, TEXT) IS
  'Tenant-admin-only. Turns one item on or off for one client. p_enabled null removes the switch.';

-- What the admin screen shows: for each item asked about, what the modules
-- give, the switch if there is one, and the result. Tenant admins only.
CREATE OR REPLACE FUNCTION tenancy.client_license_state(p_client_id UUID, p_items JSONB)
RETURNS TABLE (kind TEXT, code TEXT, plan_enabled BOOLEAN, switch_enabled BOOLEAN, note TEXT, enabled BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
  IF NOT tenancy.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin can read a client''s license' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    item.kind,
    item.code,
    tenancy.client_plan_enabled(p_client_id, item.kind, item.code),
    s.enabled,
    s.note,
    tenancy.client_item_enabled(p_client_id, item.kind, item.code)
  FROM (
    SELECT DISTINCT btrim(value->>'kind') AS kind, btrim(value->>'code') AS code
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
    UNION
    -- A switch on an item the caller did not ask about is still shown.
    SELECT sw.kind, sw.code FROM tenancy.client_license_switches AS sw WHERE sw.client_id = p_client_id
  ) AS item
  LEFT JOIN tenancy.client_license_switches AS s
    ON s.client_id = p_client_id AND s.kind = item.kind AND s.code = item.code
  WHERE item.kind IN ('surface', 'workflow', 'tool', 'assistant_tool')
    AND item.code IS NOT NULL AND item.code <> ''
  ORDER BY item.kind, item.code;
END;
$$;

COMMENT ON FUNCTION tenancy.client_license_state(UUID, JSONB) IS
  'Tenant-admin-only. For each {kind, code} given, and each switch the client has: what its modules give, its switch, and the result.';

-- ============================================================
-- 4. Readers follow the switches
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.shared_workflow_visible(p_owner UUID, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT p_owner IS NOT NULL OR tenancy.item_enabled('workflow', p_code);
$$;

COMMENT ON FUNCTION tenancy.shared_workflow_visible(UUID, TEXT) IS
  'A client-owned workflow stays visible. A shared workflow is visible when a client in the session is licensed for it.';

CREATE OR REPLACE FUNCTION tenancy.client_workflow_allowed(p_client_id UUID, p_code TEXT, p_owner UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT p_owner IS NOT NULL OR tenancy.client_item_enabled(p_client_id, 'workflow', p_code);
$$;

COMMENT ON FUNCTION tenancy.client_workflow_allowed(UUID, TEXT, UUID) IS
  'Whether a run of this workflow may start for this client. Client-owned workflows are allowed. A shared workflow needs the client''s license.';

-- What the web app reads. surfaces and tools are the allow lists of a curated
-- session, as before. blocked holds, for every session, the codes a switch
-- turned off for every client in it, so a full-catalog client can lose one item.
CREATE OR REPLACE FUNCTION tenancy.module_scope()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  WITH ids AS (
    SELECT id FROM tenancy.current_client_ids() AS ids(id)
  ),
  candidates AS (
    SELECT g.kind, g.code FROM tenancy.client_module_grants AS g WHERE g.client_id IN (SELECT id FROM ids)
    UNION
    SELECT s.kind, s.code FROM tenancy.client_license_switches AS s WHERE s.client_id IN (SELECT id FROM ids)
  ),
  judged AS (
    SELECT c.kind, c.code, tenancy.item_enabled(c.kind, c.code) AS enabled FROM candidates AS c
  ),
  restricted AS (
    SELECT tenancy.catalog_restricted() AS value
  )
  SELECT jsonb_build_object(
    'restricted', (SELECT value FROM restricted),
    'surfaces', CASE WHEN (SELECT value FROM restricted) THEN COALESCE(
      (SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'surface' AND enabled), '[]'::jsonb) ELSE '[]'::jsonb END,
    'tools', CASE WHEN (SELECT value FROM restricted) THEN COALESCE(
      (SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'tool' AND enabled), '[]'::jsonb) ELSE '[]'::jsonb END,
    'blocked', jsonb_build_object(
      'surface', COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'surface' AND NOT enabled), '[]'::jsonb),
      'workflow', COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'workflow' AND NOT enabled), '[]'::jsonb),
      'tool', COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'tool' AND NOT enabled), '[]'::jsonb),
      'assistant_tool', COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM judged WHERE kind = 'assistant_tool' AND NOT enabled), '[]'::jsonb)
    )
  );
$$;

COMMENT ON FUNCTION tenancy.module_scope() IS
  'Surfaces, pages and assistant tool groups for this session. restricted is false when the session uses the full catalog; blocked lists what license switches turned off either way.';

-- ============================================================
-- 5. Grants
-- ============================================================
REVOKE ALL ON FUNCTION tenancy.client_item_enabled(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tenancy.client_item_enabled(UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION tenancy.client_plan_enabled(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tenancy.client_plan_enabled(UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION tenancy.client_license_state(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.client_license_state(UUID, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION tenancy.item_enabled(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.item_enabled(TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION tenancy.set_client_license_switch(UUID, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.set_client_license_switch(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
