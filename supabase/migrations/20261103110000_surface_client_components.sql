-- Persisted surface components may belong to one client.
-- A null client_id is the global component, visible to every client.
-- The same surface code can exist once globally and once per client.
-- panel_key names the host panel this build mounts. Null means the tab is registered and not built.

ALTER TABLE public.surface_definitions
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

ALTER TABLE public.surface_components
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id),
  ADD COLUMN IF NOT EXISTS panel_key VARCHAR(100);

COMMENT ON COLUMN public.surface_definitions.client_id IS
  'Owning client. NULL is the global surface, used when the caller has no surface of their own.';
COMMENT ON COLUMN public.surface_components.client_id IS
  'Owning client. NULL is the global component. A client row with the same component code replaces the global one.';
COMMENT ON COLUMN public.surface_components.panel_key IS
  'Host panel mounted when this component qualifies, such as nav or capital. NULL means the tab is not built in this app.';

ALTER TABLE public.surface_definitions DROP CONSTRAINT IF EXISTS surface_definitions_surface_code_key;
DROP INDEX IF EXISTS public.surface_definitions_surface_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_surface_definitions_global_code
  ON public.surface_definitions (surface_code)
  WHERE client_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_surface_definitions_client_code
  ON public.surface_definitions (surface_code, client_id)
  WHERE client_id IS NOT NULL;

ALTER TABLE public.surface_components DROP CONSTRAINT IF EXISTS surface_components_surface_id_component_code_key;
DROP INDEX IF EXISTS public.surface_components_surface_id_component_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_surface_components_global_code
  ON public.surface_components (surface_id, component_code)
  WHERE client_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_surface_components_client_code
  ON public.surface_components (surface_id, component_code, client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_surface_definitions_client
  ON public.surface_definitions (client_id);

CREATE INDEX IF NOT EXISTS idx_surface_components_client
  ON public.surface_components (surface_id, client_id);

-- Fund and deal tabs that this app already paints.
UPDATE public.surface_components AS component
SET panel_key = seed.panel_key
FROM public.surface_definitions AS surface
JOIN (VALUES
  ('FUND_SURFACE', 'NAV', 'nav'),
  ('FUND_SURFACE', 'PACING', 'pacing'),
  ('FUND_SURFACE', 'ACTIVITY', 'activity'),
  ('FUND_SURFACE', 'REVIEW', 'review'),
  ('FUND_SURFACE', 'RETURNS', 'returns'),
  ('FUND_SURFACE', 'LIQUIDITY', 'liquidity'),
  ('FUND_SURFACE', 'INVESTORS', 'investors'),
  ('FUND_SURFACE', 'EXPOSURE', 'exposure'),
  ('FUND_SURFACE', 'ACCOUNTS', 'accounts'),
  ('FUND_SURFACE', 'FILINGS', 'filings'),
  ('DEAL_PIPELINE', 'CAPITAL', 'capital'),
  ('DEAL_PIPELINE', 'MEMO', 'memo'),
  ('DEAL_PIPELINE', 'COMPLIANCE', 'compliance'),
  ('DEAL_PIPELINE', 'SYNDICATE', 'syndicate'),
  ('DEAL_PIPELINE', 'CLOSING', 'closing'),
  ('DEAL_PIPELINE', 'SERVICING', 'servicing')
) AS seed(surface_code, component_code, panel_key)
  ON surface.surface_code = seed.surface_code
  AND surface.client_id IS NULL
WHERE component.surface_id = surface.id
  AND component.component_code = seed.component_code
  AND component.client_id IS NULL;

-- Financials and performance are built panels. Attach them when those slots exist.
INSERT INTO public.surface_components (
  surface_id, slot_id, variant_id, experience_id, component_code, component_name, description, display_order, client_id, panel_key
)
SELECT surface.id, slot.id, variant.id, experience.id, slot.slot_code, slot.slot_name, slot.slot_name, slot.display_order, NULL, lower(slot.slot_code)
FROM public.surface_definitions AS surface
JOIN public.surface_page_slots AS slot ON slot.surface_id = surface.id
JOIN public.surface_page_variants AS variant ON variant.slot_id = slot.id AND variant.variant_code = slot.slot_code
JOIN LATERAL (
  SELECT id
  FROM public.surface_experiences
  WHERE surface_id = surface.id AND is_baseline
  ORDER BY display_order
  LIMIT 1
) AS experience ON TRUE
WHERE surface.surface_code = 'DEAL_PIPELINE'
  AND surface.client_id IS NULL
  AND slot.slot_code IN ('FINANCIALS', 'PERFORMANCE')
  AND NOT EXISTS (
    SELECT 1
    FROM public.surface_components AS existing
    WHERE existing.surface_id = surface.id
      AND existing.component_code = slot.slot_code
      AND existing.client_id IS NULL
  );

-- Visibility follows the schema catalog: null is global, a client id is that client.
CREATE OR REPLACE FUNCTION public.surface_visible(p_surface_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, tenancy, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.surface_definitions AS surface
    WHERE surface.id = p_surface_id
      AND tenancy.schema_row_visible(surface.client_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.surface_writable(p_surface_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, tenancy, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.surface_definitions AS surface
    WHERE surface.id = p_surface_id
      AND tenancy.can_write_schema_row(surface.client_id)
  );
$$;

COMMENT ON FUNCTION public.surface_visible(UUID) IS
  'TRUE when the caller may see this surface: global, their client, or a tenant admin who is not impersonating.';
COMMENT ON FUNCTION public.surface_writable(UUID) IS
  'TRUE when the caller may change this surface''s structure. A client component overlay does not require this.';

GRANT EXECUTE ON FUNCTION public.surface_visible(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.surface_writable(UUID) TO authenticated;

DROP POLICY IF EXISTS surface_definitions_select ON public.surface_definitions;
DROP POLICY IF EXISTS surface_definitions_write ON public.surface_definitions;
CREATE POLICY surface_definitions_select ON public.surface_definitions
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY surface_definitions_write ON public.surface_definitions
  FOR ALL TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS surface_experiences_select ON public.surface_experiences;
DROP POLICY IF EXISTS surface_experiences_write ON public.surface_experiences;
CREATE POLICY surface_experiences_select ON public.surface_experiences
  FOR SELECT TO authenticated
  USING (public.surface_visible(surface_id));
CREATE POLICY surface_experiences_write ON public.surface_experiences
  FOR ALL TO authenticated
  USING (public.surface_writable(surface_id))
  WITH CHECK (public.surface_writable(surface_id));

DROP POLICY IF EXISTS surface_page_slots_select ON public.surface_page_slots;
DROP POLICY IF EXISTS surface_page_slots_write ON public.surface_page_slots;
CREATE POLICY surface_page_slots_select ON public.surface_page_slots
  FOR SELECT TO authenticated
  USING (public.surface_visible(surface_id));
CREATE POLICY surface_page_slots_write ON public.surface_page_slots
  FOR ALL TO authenticated
  USING (public.surface_writable(surface_id))
  WITH CHECK (public.surface_writable(surface_id));

DROP POLICY IF EXISTS surface_page_variants_select ON public.surface_page_variants;
DROP POLICY IF EXISTS surface_page_variants_write ON public.surface_page_variants;
CREATE POLICY surface_page_variants_select ON public.surface_page_variants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.surface_page_slots AS slot
      WHERE slot.id = slot_id
        AND public.surface_visible(slot.surface_id)
    )
  );
CREATE POLICY surface_page_variants_write ON public.surface_page_variants
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.surface_page_slots AS slot
      WHERE slot.id = slot_id
        AND public.surface_writable(slot.surface_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.surface_page_slots AS slot
      WHERE slot.id = slot_id
        AND public.surface_writable(slot.surface_id)
    )
  );

DROP POLICY IF EXISTS surface_variant_requirements_select ON public.surface_variant_requirements;
DROP POLICY IF EXISTS surface_variant_requirements_write ON public.surface_variant_requirements;
CREATE POLICY surface_variant_requirements_select ON public.surface_variant_requirements
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.surface_page_variants AS variant
      JOIN public.surface_page_slots AS slot ON slot.id = variant.slot_id
      WHERE variant.id = variant_id
        AND public.surface_visible(slot.surface_id)
    )
  );
CREATE POLICY surface_variant_requirements_write ON public.surface_variant_requirements
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.surface_page_variants AS variant
      JOIN public.surface_page_slots AS slot ON slot.id = variant.slot_id
      WHERE variant.id = variant_id
        AND public.surface_writable(slot.surface_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.surface_page_variants AS variant
      JOIN public.surface_page_slots AS slot ON slot.id = variant.slot_id
      WHERE variant.id = variant_id
        AND public.surface_writable(slot.surface_id)
    )
  );

DROP POLICY IF EXISTS surface_components_select ON public.surface_components;
DROP POLICY IF EXISTS surface_components_write ON public.surface_components;
CREATE POLICY surface_components_select ON public.surface_components
  FOR SELECT TO authenticated
  USING (
    tenancy.schema_row_visible(client_id)
    AND public.surface_visible(surface_id)
  );
CREATE POLICY surface_components_write ON public.surface_components
  FOR ALL TO authenticated
  USING (
    tenancy.can_write_schema_row(client_id)
    AND public.surface_visible(surface_id)
  )
  WITH CHECK (
    tenancy.can_write_schema_row(client_id)
    AND public.surface_visible(surface_id)
  );

DROP POLICY IF EXISTS surface_sample_profiles_select ON public.surface_sample_profiles;
DROP POLICY IF EXISTS surface_sample_profiles_write ON public.surface_sample_profiles;
CREATE POLICY surface_sample_profiles_select ON public.surface_sample_profiles
  FOR SELECT TO authenticated
  USING (public.surface_visible(surface_id));
CREATE POLICY surface_sample_profiles_write ON public.surface_sample_profiles
  FOR ALL TO authenticated
  USING (public.surface_writable(surface_id))
  WITH CHECK (public.surface_writable(surface_id));
