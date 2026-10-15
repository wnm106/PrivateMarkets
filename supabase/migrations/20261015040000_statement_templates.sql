-- Statement templates: ordered sections, source wording, and attribute aliases.
-- A fund NAV statement and a company financial statement can share a canonical
-- attribute while keeping the label and the section sequence each statement uses.

ALTER TABLE metadata_register.template_attribute_assignments
  ADD COLUMN IF NOT EXISTS section_id UUID;

CREATE TABLE IF NOT EXISTS metadata_register.template_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES metadata_register.domain_templates(id) ON DELETE CASCADE,
  section_code VARCHAR(100) NOT NULL,
  section_name VARCHAR(200) NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, section_code)
);

CREATE INDEX IF NOT EXISTS idx_template_sections_template
  ON metadata_register.template_sections(template_id, display_order);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'template_attribute_assignments_section_id_fkey'
  ) THEN
    ALTER TABLE metadata_register.template_attribute_assignments
      ADD CONSTRAINT template_attribute_assignments_section_id_fkey
      FOREIGN KEY (section_id) REFERENCES metadata_register.template_sections(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_taa_section
  ON metadata_register.template_attribute_assignments(section_id);

COMMENT ON TABLE metadata_register.template_sections IS
  'Ordered sections of a statement template, such as Assets or Income.';
COMMENT ON COLUMN metadata_register.template_attribute_assignments.section_id IS
  'Section this line belongs to. Display order inside the template follows the section sequence.';

CREATE TABLE IF NOT EXISTS metadata_register.attribute_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
  alias_label VARCHAR(300) NOT NULL,
  alias_code VARCHAR(100) NOT NULL,
  domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
  template_id UUID REFERENCES metadata_register.domain_templates(id) ON DELETE CASCADE,
  match_kind VARCHAR(20) NOT NULL DEFAULT 'semantic' CHECK (match_kind IN ('exact', 'semantic', 'manual')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attribute_alias_scope
  ON metadata_register.attribute_aliases (
    alias_code,
    COALESCE(domain_code, ''),
    COALESCE(template_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_attribute_aliases_attribute
  ON metadata_register.attribute_aliases(attribute_id);

COMMENT ON TABLE metadata_register.attribute_aliases IS
  'Statement wording that means an existing attribute. One alias maps to one attribute inside a domain.';

CREATE TABLE IF NOT EXISTS metadata_register.template_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES metadata_register.domain_templates(id) ON DELETE CASCADE,
  source_kind VARCHAR(20) NOT NULL CHECK (source_kind IN ('image', 'file', 'paste')),
  source_name VARCHAR(300) NOT NULL,
  content_type VARCHAR(120),
  excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_sources_template
  ON metadata_register.template_sources(template_id, created_at);

COMMENT ON TABLE metadata_register.template_sources IS
  'Images, files, and pasted tables that were aggregated into a statement template.';

ALTER TABLE metadata_register.template_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.attribute_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.template_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_sections_select_authenticated ON metadata_register.template_sections;
CREATE POLICY template_sections_select_authenticated ON metadata_register.template_sections
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS template_sections_write_tenant_admin ON metadata_register.template_sections;
CREATE POLICY template_sections_write_tenant_admin ON metadata_register.template_sections
  FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS attribute_aliases_select_authenticated ON metadata_register.attribute_aliases;
CREATE POLICY attribute_aliases_select_authenticated ON metadata_register.attribute_aliases
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS attribute_aliases_write_tenant_admin ON metadata_register.attribute_aliases;
CREATE POLICY attribute_aliases_write_tenant_admin ON metadata_register.attribute_aliases
  FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS template_sources_select_authenticated ON metadata_register.template_sources;
CREATE POLICY template_sources_select_authenticated ON metadata_register.template_sources
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS template_sources_write_tenant_admin ON metadata_register.template_sources;
CREATE POLICY template_sources_write_tenant_admin ON metadata_register.template_sources
  FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.template_sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.attribute_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.template_sources TO authenticated;

DROP VIEW IF EXISTS public.template_attribute_assignments CASCADE;
CREATE VIEW public.template_attribute_assignments AS
  SELECT * FROM metadata_register.template_attribute_assignments;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_attribute_assignments TO authenticated;
GRANT SELECT ON public.template_attribute_assignments TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.domain_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribute_register TO authenticated;

CREATE OR REPLACE VIEW public.template_sections
  WITH (security_invoker = true) AS
  SELECT * FROM metadata_register.template_sections;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_sections TO authenticated;
GRANT SELECT ON public.template_sections TO anon;

CREATE OR REPLACE VIEW public.attribute_aliases
  WITH (security_invoker = true) AS
  SELECT * FROM metadata_register.attribute_aliases;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribute_aliases TO authenticated;
GRANT SELECT ON public.attribute_aliases TO anon;

CREATE OR REPLACE VIEW public.template_sources
  WITH (security_invoker = true) AS
  SELECT * FROM metadata_register.template_sources;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_sources TO authenticated;
GRANT SELECT ON public.template_sources TO anon;

NOTIFY pgrst, 'reload schema';
