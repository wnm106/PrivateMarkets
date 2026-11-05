-- Entity type catalog: groups, display parent, core flag, and order.
--
-- Groups are how the entity type directory is organized (Securities, Funds, Deals).
-- parent_domain_code is the directory parent, such as a tranche shown under its deal.
-- It is not a relationship type and not an intersection member.
-- is_core marks the foundational types behind "Core entities only".

CREATE TABLE IF NOT EXISTS metadata_register.domain_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code VARCHAR(50) UNIQUE NOT NULL,
  group_name VARCHAR(200) NOT NULL,
  description TEXT,
  color VARCHAR(20) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata_register.domain_groups IS
  'Catalog bands for entity types: name, sentence, color, and order.';
COMMENT ON COLUMN metadata_register.domain_groups.color IS
  'CSS color for the group mark. Every entity type in the group uses it.';
COMMENT ON COLUMN metadata_register.domain_groups.display_order IS
  'Band sequence in the directory. Lower numbers appear first.';

INSERT INTO metadata_register.domain_groups (group_code, group_name, description, color, display_order)
VALUES
  ('SECURITIES', 'Securities & market data', 'What is held and how it is priced', '#2563eb', 10),
  ('FUNDS', 'Funds & investors', 'Vehicles, capital, NAV and limits', '#7c3aed', 20),
  ('DEALS', 'Deals', 'Transactions, diligence and approvals', '#059669', 30)
ON CONFLICT (group_code) DO UPDATE
SET group_name = EXCLUDED.group_name,
    description = EXCLUDED.description,
    color = EXCLUDED.color,
    display_order = EXCLUDED.display_order,
    updated_at = NOW();

ALTER TABLE metadata_register.domain_types
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES metadata_register.domain_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_core BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE metadata_register.domain_types
  DROP CONSTRAINT IF EXISTS domain_types_parent_not_self;
ALTER TABLE metadata_register.domain_types
  ADD CONSTRAINT domain_types_parent_not_self
  CHECK (parent_domain_code IS NULL OR parent_domain_code <> domain_code);

COMMENT ON COLUMN metadata_register.domain_types.group_id IS
  'Catalog band this entity type belongs to.';
COMMENT ON COLUMN metadata_register.domain_types.parent_domain_code IS
  'Entity type this one is listed under in the directory. Not a record relationship.';
COMMENT ON COLUMN metadata_register.domain_types.is_core IS
  'Foundational entity type. The directory can hide the rest.';
COMMENT ON COLUMN metadata_register.domain_types.display_order IS
  'Sequence within the catalog band. Lower numbers appear first.';

CREATE INDEX IF NOT EXISTS idx_domain_types_group_order
  ON metadata_register.domain_types (group_id, display_order);
CREATE INDEX IF NOT EXISTS idx_domain_types_parent
  ON metadata_register.domain_types (parent_domain_code);

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = v.is_core = 'true',
    updated_at = NOW()
FROM (VALUES
  ('ISSUER', 'SECURITIES', 10, '', 'true'),
  ('SECURITY', 'SECURITIES', 20, '', 'true'),
  ('PRICE', 'SECURITIES', 30, '', 'true'),
  ('POSITION', 'SECURITIES', 40, '', 'true'),
  ('CASH_FLOW', 'SECURITIES', 50, '', 'true'),

  ('FUND', 'FUNDS', 10, '', 'true'),
  ('INVESTOR', 'FUNDS', 20, '', 'false'),
  ('INVESTOR_COMMITMENT', 'FUNDS', 30, 'INVESTOR', 'false'),
  ('CAPITAL_ACTIVITY', 'FUNDS', 40, '', 'false'),
  ('CAPITAL_PLAN', 'FUNDS', 50, '', 'false'),
  ('CASH_FORECAST', 'FUNDS', 60, '', 'false'),
  ('CREDIT_FACILITY', 'FUNDS', 70, '', 'false'),
  ('EXPOSURE_LIMIT', 'FUNDS', 80, '', 'false'),
  ('NAV_STATEMENT', 'FUNDS', 90, '', 'false'),
  ('NAV_LINE', 'FUNDS', 100, 'NAV_STATEMENT', 'false'),

  ('DEAL', 'DEALS', 10, '', 'true'),
  ('DEAL_TRANCHE', 'DEALS', 20, 'DEAL', 'false'),
  ('SPONSOR', 'DEALS', 30, '', 'false'),
  ('DEAL_FUNDING_PLAN', 'DEALS', 40, '', 'false'),
  ('DEAL_MEMO_POINT', 'DEALS', 50, '', 'false'),
  ('DEAL_CAPITAL_ITEM', 'DEALS', 60, '', 'false'),
  ('FINANCIAL_PERIOD', 'DEALS', 70, '', 'false'),
  ('IC_APPROVAL', 'DEALS', 80, '', 'false'),
  ('DEAL_OPEN_ITEM', 'DEALS', 90, '', 'false')
) AS v(domain_code, group_code, display_order, parent_code, is_core)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

ALTER TABLE metadata_register.domain_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_groups_select_scoped ON metadata_register.domain_groups;
DROP POLICY IF EXISTS domain_groups_insert_scoped ON metadata_register.domain_groups;
DROP POLICY IF EXISTS domain_groups_update_scoped ON metadata_register.domain_groups;
DROP POLICY IF EXISTS domain_groups_delete_scoped ON metadata_register.domain_groups;
CREATE POLICY domain_groups_select_scoped ON metadata_register.domain_groups
  FOR SELECT TO authenticated
  USING (true);
CREATE POLICY domain_groups_insert_scoped ON metadata_register.domain_groups
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(NULL));
CREATE POLICY domain_groups_update_scoped ON metadata_register.domain_groups
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(NULL))
  WITH CHECK (tenancy.can_write_schema_row(NULL));
CREATE POLICY domain_groups_delete_scoped ON metadata_register.domain_groups
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(NULL));

-- Append catalog columns. Existing view columns stay in place so replace succeeds.
CREATE OR REPLACE VIEW public.domain_types AS
SELECT
  id,
  domain_code,
  domain_name,
  description,
  is_active,
  created_at,
  updated_at,
  temporal_model,
  as_of_date_granularity,
  as_of_date_label,
  client_id,
  group_id,
  parent_domain_code,
  is_core,
  display_order
FROM metadata_register.domain_types;

ALTER VIEW public.domain_types SET (security_invoker = on);

CREATE OR REPLACE VIEW public.domain_groups
WITH (security_invoker = true) AS
SELECT id, group_code, group_name, description, color, display_order, created_at, updated_at
FROM metadata_register.domain_groups;

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.domain_groups TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.domain_groups TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.domain_type_catalog_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = metadata_register, pg_temp
AS $$
  SELECT jsonb_build_object(
    'shared', (SELECT count(*) FROM metadata_register.attribute_register WHERE domain_code IS NULL),
    'owned', COALESCE((
      SELECT jsonb_object_agg(domain_code, cnt)
      FROM (
        SELECT domain_code, count(*) AS cnt
        FROM metadata_register.attribute_register
        WHERE domain_code IS NOT NULL
        GROUP BY domain_code
      ) owned_counts
    ), '{}'::jsonb),
    'templates', COALESCE((
      SELECT jsonb_object_agg(domain_code, cnt)
      FROM (
        SELECT domain_code, count(*) AS cnt
        FROM metadata_register.domain_templates
        WHERE is_active
        GROUP BY domain_code
      ) template_counts
    ), '{}'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.domain_type_catalog_counts() IS
  'Owned attribute counts per entity type, active template counts, and the shared (unowned) attribute total.';

GRANT EXECUTE ON FUNCTION public.domain_type_catalog_counts() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
