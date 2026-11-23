-- Surface Builder: saved blueprints.
--
-- A blueprint is the Surface Builder's analysis of one prototype: the request
-- (name, purpose, entity type, placement), the prototype HTML, and the build
-- instructions it produced (fields, new attributes, tabs, capabilities,
-- workflows, standards, build steps, HTML artifacts) as one JSON document.
-- Analyzing again overwrites the document and bumps the revision.
--
-- The Surface Builder is a tenant admin tool, so only tenant admins read or
-- write blueprints. client_id records the client the caller was working in,
-- for context; it does not scope access.

CREATE TABLE IF NOT EXISTS public.surface_blueprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE SET NULL,
    surface_name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    audience TEXT,
    domain_code VARCHAR(50),
    placement VARCHAR(20),
    prototype_html TEXT NOT NULL DEFAULT '',
    blueprint JSONB,
    -- model: refined by the model. baseline: the deterministic draft only.
    blueprint_source VARCHAR(20),
    revision INTEGER NOT NULL DEFAULT 1,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT surface_blueprints_name_not_blank CHECK (btrim(surface_name) <> ''),
    CONSTRAINT surface_blueprints_placement CHECK (placement IS NULL OR placement IN ('record-tab', 'sdk-surface', 'app-page')),
    CONSTRAINT surface_blueprints_source CHECK (blueprint_source IS NULL OR blueprint_source IN ('model', 'baseline')),
    CONSTRAINT surface_blueprints_object CHECK (blueprint IS NULL OR jsonb_typeof(blueprint) = 'object'),
    CONSTRAINT surface_blueprints_html_size CHECK (length(prototype_html) <= 400000)
);

CREATE INDEX IF NOT EXISTS idx_surface_blueprints_updated
    ON public.surface_blueprints (updated_at DESC);

COMMENT ON TABLE public.surface_blueprints IS
    'Surface Builder analyses: a prototype, what the surface is for, and the build instructions produced for it. Tenant admins only.';

ALTER TABLE public.surface_blueprints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS surface_blueprints_select ON public.surface_blueprints;
CREATE POLICY surface_blueprints_select ON public.surface_blueprints
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_blueprints_insert ON public.surface_blueprints;
CREATE POLICY surface_blueprints_insert ON public.surface_blueprints
    FOR INSERT TO authenticated
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_blueprints_update ON public.surface_blueprints;
CREATE POLICY surface_blueprints_update ON public.surface_blueprints
    FOR UPDATE TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_blueprints_delete ON public.surface_blueprints;
CREATE POLICY surface_blueprints_delete ON public.surface_blueprints
    FOR DELETE TO authenticated
    USING (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_blueprints TO authenticated;
GRANT ALL ON public.surface_blueprints TO service_role;
