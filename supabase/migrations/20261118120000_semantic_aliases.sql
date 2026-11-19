-- Words people use for an entity type, for a record's name, and for a specific record.
-- Attribute aliases already live in metadata_register.attribute_aliases.
-- See docs/ALIASES.md.

CREATE TABLE IF NOT EXISTS metadata_register.domain_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code) ON DELETE CASCADE,
  alias_label VARCHAR(200) NOT NULL,
  alias_code VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_alias_code
  ON metadata_register.domain_aliases (alias_code);

CREATE INDEX IF NOT EXISTS idx_domain_aliases_domain
  ON metadata_register.domain_aliases (domain_code)
  WHERE is_active;

COMMENT ON TABLE metadata_register.domain_aliases IS
  'Another name for an entity type. Borrower means ISSUER. One alias code belongs to one entity type.';

-- Words for the name of a record of that entity type. Project name means the borrower name.
CREATE TABLE IF NOT EXISTS metadata_register.entity_name_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code) ON DELETE CASCADE,
  alias_label VARCHAR(200) NOT NULL,
  alias_code VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_name_alias
  ON metadata_register.entity_name_aliases (domain_code, alias_code);

CREATE INDEX IF NOT EXISTS idx_entity_name_aliases_domain
  ON metadata_register.entity_name_aliases (domain_code)
  WHERE is_active;

COMMENT ON TABLE metadata_register.entity_name_aliases IS
  'Column words that mean entity_name for an entity type. Project name is the borrower''s name, not a separate field.';

-- Another name of one record. Project Falcon is the borrower whose legal name is Acme Holdings.
CREATE TABLE IF NOT EXISTS entity_instances.entity_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
  alias_label VARCHAR(500) NOT NULL,
  alias_code VARCHAR(100) NOT NULL,
  alias_kind VARCHAR(50) NOT NULL DEFAULT 'name',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, alias_code)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
  ON entity_instances.entity_aliases (entity_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_entity_aliases_label_trgm
  ON entity_instances.entity_aliases
  USING gin (alias_label extensions.gin_trgm_ops)
  WHERE is_active;

COMMENT ON TABLE entity_instances.entity_aliases IS
  'Another name of one record. Search and import matching treat it as the record''s name. alias_code says which name it is, such as PROJECT_NAME.';

INSERT INTO metadata_register.domain_aliases (domain_code, alias_label, alias_code)
SELECT seed.domain_code, seed.alias_label, seed.alias_code
FROM (VALUES
  ('ISSUER', 'Borrower', 'BORROWER'),
  ('ISSUER', 'Obligor', 'OBLIGOR'),
  ('ISSUER', 'Company', 'COMPANY'),
  ('SECURITY', 'Tranche', 'TRANCHE'),
  ('SECURITY', 'Instrument', 'INSTRUMENT'),
  ('FUND', 'Portfolio', 'PORTFOLIO'),
  ('FUND', 'Vehicle', 'VEHICLE'),
  ('POSITION', 'Holding', 'HOLDING'),
  ('DEAL', 'Transaction', 'TRANSACTION'),
  ('CASH_FLOW', 'Cash flow', 'CASHFLOW')
) AS seed(domain_code, alias_label, alias_code)
WHERE EXISTS (
  SELECT 1 FROM metadata_register.domain_types dt WHERE dt.domain_code = seed.domain_code
)
ON CONFLICT (alias_code) DO NOTHING;

INSERT INTO metadata_register.entity_name_aliases (domain_code, alias_label, alias_code)
SELECT seed.domain_code, seed.alias_label, seed.alias_code
FROM (VALUES
  ('ISSUER', 'Borrower name', 'BORROWER_NAME'),
  ('ISSUER', 'Project name', 'PROJECT_NAME'),
  ('ISSUER', 'Company name', 'COMPANY_NAME'),
  ('ISSUER', 'Obligor name', 'OBLIGOR_NAME'),
  ('SECURITY', 'Tranche name', 'TRANCHE_NAME'),
  ('SECURITY', 'Instrument name', 'INSTRUMENT_NAME'),
  ('FUND', 'Portfolio name', 'PORTFOLIO_NAME'),
  ('FUND', 'Vehicle name', 'VEHICLE_NAME'),
  ('POSITION', 'Holding name', 'HOLDING_NAME'),
  ('DEAL', 'Transaction name', 'TRANSACTION_NAME')
) AS seed(domain_code, alias_label, alias_code)
WHERE EXISTS (
  SELECT 1 FROM metadata_register.domain_types dt WHERE dt.domain_code = seed.domain_code
)
ON CONFLICT (domain_code, alias_code) DO NOTHING;

ALTER TABLE metadata_register.domain_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.entity_name_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.entity_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_aliases_select_authenticated ON metadata_register.domain_aliases;
CREATE POLICY domain_aliases_select_authenticated ON metadata_register.domain_aliases
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS domain_aliases_write_tenant_admin ON metadata_register.domain_aliases;
CREATE POLICY domain_aliases_write_tenant_admin ON metadata_register.domain_aliases
  FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS entity_name_aliases_select_authenticated ON metadata_register.entity_name_aliases;
CREATE POLICY entity_name_aliases_select_authenticated ON metadata_register.entity_name_aliases
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS entity_name_aliases_write_tenant_admin ON metadata_register.entity_name_aliases;
CREATE POLICY entity_name_aliases_write_tenant_admin ON metadata_register.entity_name_aliases
  FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS entity_aliases_select ON entity_instances.entity_aliases;
CREATE POLICY entity_aliases_select ON entity_instances.entity_aliases
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM entity_instances.master_entities me
      WHERE me.id = entity_aliases.entity_id
    )
  );
DROP POLICY IF EXISTS entity_aliases_write ON entity_instances.entity_aliases;
CREATE POLICY entity_aliases_write ON entity_instances.entity_aliases
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM entity_instances.master_entities me
      WHERE me.id = entity_aliases.entity_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM entity_instances.master_entities me
      WHERE me.id = entity_aliases.entity_id
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.domain_aliases TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.entity_name_aliases TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.entity_aliases TO authenticated, service_role;

CREATE OR REPLACE VIEW public.domain_aliases
  WITH (security_invoker = true) AS
  SELECT * FROM metadata_register.domain_aliases;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.domain_aliases TO authenticated, service_role;
GRANT SELECT ON public.domain_aliases TO anon;

CREATE OR REPLACE VIEW public.entity_name_aliases
  WITH (security_invoker = true) AS
  SELECT * FROM metadata_register.entity_name_aliases;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_name_aliases TO authenticated, service_role;
GRANT SELECT ON public.entity_name_aliases TO anon;

CREATE OR REPLACE VIEW public.entity_aliases
  WITH (security_invoker = true) AS
  SELECT * FROM entity_instances.entity_aliases;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_aliases TO authenticated, service_role;
GRANT SELECT ON public.entity_aliases TO anon;

-- Return type gains matched_alias, so the previous function has to be dropped first.
DROP FUNCTION IF EXISTS public.search_entity_names(text, integer);

CREATE OR REPLACE FUNCTION public.search_entity_names(
  p_query text,
  p_per_domain integer DEFAULT 8
)
RETURNS TABLE (
  id uuid,
  entity_code text,
  entity_name text,
  domain_code text,
  is_active boolean,
  matched_alias text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = entity_instances, public, pg_temp
AS $$
  WITH needle AS (
    SELECT btrim(COALESCE(p_query, '')) AS q
  ),
  pattern AS (
    SELECT CASE
      WHEN char_length(q) < 2 THEN NULL
      ELSE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    END AS like_pattern
    FROM needle
  ),
  hits AS (
    SELECT
      me.id,
      me.entity_code::text AS entity_code,
      me.entity_name::text AS entity_name,
      me.domain_code::text AS domain_code,
      me.is_active,
      NULL::text AS matched_alias,
      0 AS rank
    FROM entity_instances.master_entities me
    CROSS JOIN pattern
    WHERE pattern.like_pattern IS NOT NULL
      AND me.is_active
      AND me.entity_name ILIKE pattern.like_pattern ESCAPE '\'
    UNION ALL
    SELECT
      me.id,
      me.entity_code::text,
      me.entity_name::text,
      me.domain_code::text,
      me.is_active,
      ea.alias_label::text,
      1
    FROM entity_instances.entity_aliases ea
    JOIN entity_instances.master_entities me ON me.id = ea.entity_id
    CROSS JOIN pattern
    WHERE pattern.like_pattern IS NOT NULL
      AND ea.is_active
      AND me.is_active
      AND ea.alias_label ILIKE pattern.like_pattern ESCAPE '\'
      AND me.entity_name NOT ILIKE pattern.like_pattern ESCAPE '\'
  ),
  deduped AS (
    SELECT DISTINCT ON (id)
      id, entity_code, entity_name, domain_code, is_active, matched_alias
    FROM hits
    ORDER BY id, rank, matched_alias
  )
  SELECT ranked.id, ranked.entity_code, ranked.entity_name, ranked.domain_code, ranked.is_active, ranked.matched_alias
  FROM (
    SELECT
      d.id,
      d.entity_code,
      d.entity_name,
      d.domain_code,
      d.is_active,
      d.matched_alias,
      row_number() OVER (PARTITION BY d.domain_code ORDER BY d.entity_name, d.entity_code) AS rn
    FROM deduped d
  ) ranked
  WHERE ranked.rn <= GREATEST(1, LEAST(COALESCE(p_per_domain, 8), 30));
$$;

REVOKE ALL ON FUNCTION public.search_entity_names(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_entity_names(text, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_entity_names(text, integer) IS
  'Active records whose name or stored alias contains the query, capped per entity type. matched_alias is the other name that matched, and is null when the record name itself matched.';

NOTIFY pgrst, 'reload schema';
