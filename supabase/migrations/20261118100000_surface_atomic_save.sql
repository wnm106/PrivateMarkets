-- Surface phase 1: one caller identity for surface gating, and an atomic catalog save.
--
-- 1. tenancy.surface_caller() answers "who is this caller for surface purposes"
--    with the same rule the catalog resolver uses: the simulated client, else the
--    caller's only active membership, else no client.
-- 2. public.save_surface_catalog() replaces a surface's tabs in one transaction.
--    The resolver used to do this as dozens of separate requests; a failure midway
--    left the surface empty.

-- ============================================================
-- 1. Caller identity
-- ============================================================

CREATE OR REPLACE FUNCTION tenancy.surface_caller()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_admin BOOLEAN;
  v_impersonating UUID;
  v_members UUID[];
  v_client UUID;
  v_client_code TEXT;
  v_permissions JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  v_admin := tenancy.is_tenant_admin();
  v_impersonating := tenancy.active_impersonation_client_id();

  IF v_impersonating IS NOT NULL THEN
    v_client := v_impersonating;
  ELSE
    SELECT array_agg(client_id) INTO v_members
    FROM tenancy.client_users
    WHERE user_id = v_user AND is_active = TRUE;
    IF cardinality(v_members) = 1 THEN
      v_client := v_members[1];
    END IF;
  END IF;

  IF v_client IS NOT NULL THEN
    SELECT client_code INTO v_client_code FROM tenancy.clients WHERE id = v_client;
  END IF;

  IF v_impersonating IS NOT NULL AND v_admin THEN
    -- Matches tenancy.has_permission: an admin simulating a client holds every permission there.
    SELECT jsonb_agg(permission_code ORDER BY permission_code) INTO v_permissions
    FROM tenancy.permissions;
  ELSIF v_client IS NOT NULL THEN
    SELECT jsonb_agg(DISTINCT p.permission_code) INTO v_permissions
    FROM tenancy.user_roles ur
    JOIN tenancy.role_permissions rp ON rp.role_id = ur.role_id
    JOIN tenancy.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = v_user AND ur.client_id = v_client;
  ELSE
    -- No single working client. Permissions are the union across active memberships.
    SELECT jsonb_agg(DISTINCT p.permission_code) INTO v_permissions
    FROM tenancy.user_roles ur
    JOIN tenancy.client_users cu
      ON cu.client_id = ur.client_id AND cu.user_id = ur.user_id AND cu.is_active = TRUE
    JOIN tenancy.role_permissions rp ON rp.role_id = ur.role_id
    JOIN tenancy.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = v_user;
  END IF;

  RETURN jsonb_build_object(
    'clientId', v_client,
    'clientCode', v_client_code,
    'permissions', COALESCE(v_permissions, '[]'::jsonb),
    -- While simulating a client the admin sees what that client sees.
    'isTenantAdmin', v_admin AND v_impersonating IS NULL,
    'impersonating', v_impersonating IS NOT NULL
  );
END;
$$;

COMMENT ON FUNCTION tenancy.surface_caller() IS
  'Who the caller is for surface gating: working client (simulated, else only active membership), permission codes for it, and whether they act as a tenant admin. NULL when signed out.';

GRANT EXECUTE ON FUNCTION tenancy.surface_caller() TO authenticated;

-- ============================================================
-- 2. Atomic catalog save
-- ============================================================
--
-- p_catalog refers to rows by code, never by id:
--   experiences: [{ code, name, description, is_baseline, priority, display_order, rules }]
--   slots:       [{ code, name, description, display_order, optionality }]
--   variants:    [{ slot_code, code, name, description, priority, required: [experience code] }]
--   components:  [{ slot_code, variant_code, experience_code, code, name, description,
--                   display_order, client_id, panel_key, is_active }]
-- A component whose slot_code is not in slots is not written.
-- SECURITY INVOKER: row-level security still decides what the caller may write.

CREATE OR REPLACE FUNCTION public.save_surface_catalog(p_surface_id UUID, p_catalog JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.surface_writable(p_surface_id) THEN
    RAISE EXCEPTION 'You cannot change this surface.' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_catalog -> 'slots') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_catalog -> 'slots') = 0 THEN
    RAISE EXCEPTION 'A surface needs at least one tab.' USING ERRCODE = '22023';
  END IF;

  -- Two saves of the same surface run one after the other.
  PERFORM 1 FROM public.surface_definitions WHERE id = p_surface_id FOR UPDATE;

  DELETE FROM public.surface_components WHERE surface_id = p_surface_id;
  DELETE FROM public.surface_page_slots WHERE surface_id = p_surface_id;
  DELETE FROM public.surface_experiences WHERE surface_id = p_surface_id;

  INSERT INTO public.surface_experiences (
    surface_id, experience_code, experience_name, description, is_baseline,
    qualification_priority, display_order, applicability_rules
  )
  SELECT p_surface_id, e.code, e.name, e.description, COALESCE(e.is_baseline, FALSE),
         COALESCE(e.priority, 100), COALESCE(e.display_order, 0),
         COALESCE(e.rules, '{"logic":"AND","conditions":[]}'::jsonb)
  FROM jsonb_to_recordset(COALESCE(p_catalog -> 'experiences', '[]'::jsonb)) AS e(
    code TEXT, name TEXT, description TEXT, is_baseline BOOLEAN,
    priority INTEGER, display_order INTEGER, rules JSONB
  );

  INSERT INTO public.surface_page_slots (
    surface_id, slot_code, slot_name, description, display_order, optionality
  )
  SELECT p_surface_id, s.code, s.name, s.description, COALESCE(s.display_order, 0), s.optionality
  FROM jsonb_to_recordset(p_catalog -> 'slots') AS s(
    code TEXT, name TEXT, description TEXT, display_order INTEGER, optionality TEXT
  );

  INSERT INTO public.surface_page_variants (
    slot_id, variant_code, variant_name, description, qualification_priority
  )
  SELECT slot.id, v.code, v.name, v.description, COALESCE(v.priority, 100)
  FROM jsonb_to_recordset(COALESCE(p_catalog -> 'variants', '[]'::jsonb)) AS v(
    slot_code TEXT, code TEXT, name TEXT, description TEXT, priority INTEGER
  )
  JOIN public.surface_page_slots AS slot
    ON slot.surface_id = p_surface_id AND slot.slot_code = v.slot_code;

  INSERT INTO public.surface_variant_requirements (variant_id, experience_id)
  SELECT variant.id, experience.id
  FROM jsonb_to_recordset(COALESCE(p_catalog -> 'variants', '[]'::jsonb)) AS v(
    slot_code TEXT, code TEXT, required JSONB
  )
  JOIN public.surface_page_slots AS slot
    ON slot.surface_id = p_surface_id AND slot.slot_code = v.slot_code
  JOIN public.surface_page_variants AS variant
    ON variant.slot_id = slot.id AND variant.variant_code = v.code
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(v.required, '[]'::jsonb)) AS needed(code)
  JOIN public.surface_experiences AS experience
    ON experience.surface_id = p_surface_id AND experience.experience_code = needed.code
  ON CONFLICT DO NOTHING;

  INSERT INTO public.surface_components (
    surface_id, slot_id, variant_id, experience_id, component_code, component_name,
    description, display_order, client_id, panel_key, is_active
  )
  SELECT p_surface_id, slot.id, variant.id, experience.id, c.code, c.name,
         c.description, COALESCE(c.display_order, 0), c.client_id, c.panel_key,
         COALESCE(c.is_active, TRUE)
  FROM jsonb_to_recordset(COALESCE(p_catalog -> 'components', '[]'::jsonb)) AS c(
    slot_code TEXT, variant_code TEXT, experience_code TEXT, code TEXT, name TEXT,
    description TEXT, display_order INTEGER, client_id UUID, panel_key TEXT, is_active BOOLEAN
  )
  JOIN public.surface_page_slots AS slot
    ON slot.surface_id = p_surface_id AND slot.slot_code = c.slot_code
  LEFT JOIN public.surface_page_variants AS variant
    ON variant.slot_id = slot.id AND variant.variant_code = c.variant_code
  LEFT JOIN public.surface_experiences AS experience
    ON experience.surface_id = p_surface_id AND experience.experience_code = c.experience_code;
END;
$$;

COMMENT ON FUNCTION public.save_surface_catalog(UUID, JSONB) IS
  'Replaces a surface''s experiences, tabs, layouts and components in one transaction. Rows are named by code. Any error leaves the surface as it was.';

GRANT EXECUTE ON FUNCTION public.save_surface_catalog(UUID, JSONB) TO authenticated;
