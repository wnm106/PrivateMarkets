-- Reconciliation definitions, runs, and comparison lines.
-- A definition says which domain is reviewed, whether lines are the entity
-- itself or a related set, and which attributes are compared across sources
-- and across two as-of dates. A run is one review of one entity.

CREATE TABLE IF NOT EXISTS metadata_register.reconciliation_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_code VARCHAR(100) UNIQUE NOT NULL,
  definition_name VARCHAR(200) NOT NULL,
  description TEXT,
  domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
  compare_mode VARCHAR(20) NOT NULL CHECK (compare_mode IN ('SOURCE', 'PERIOD', 'BOTH')),
  grain VARCHAR(20) NOT NULL CHECK (grain IN ('ENTITY', 'RELATED')),
  relationship_code VARCHAR(100),
  relationship_direction VARCHAR(20) NOT NULL DEFAULT 'CHILD'
    CHECK (relationship_direction IN ('PARENT', 'CHILD')),
  measures JSONB NOT NULL DEFAULT '[]',
  identity_checks JSONB NOT NULL DEFAULT '[]',
  stages JSONB NOT NULL DEFAULT '["Select","Sync","Exception handling","Review","Approved"]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  client_id UUID REFERENCES tenancy.clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata_register.reconciliation_definitions IS
  'How to review one domain. ENTITY grain compares the anchor attributes. RELATED grain compares entities reached through relationship_code. CHILD means the anchor is the child of that relationship.';
COMMENT ON COLUMN metadata_register.reconciliation_definitions.measures IS
  'Attribute comparisons: attributeCode, toleranceType EXACT|ABSOLUTE|PERCENT, tolerance, role MEASURE.';
COMMENT ON COLUMN metadata_register.reconciliation_definitions.identity_checks IS
  'Tie-out checks. EXPRESSION evaluates a calc against the anchor. SUM_RELATED sums a child attribute and compares it to an anchor attribute.';

CREATE INDEX IF NOT EXISTS idx_reconciliation_definitions_domain
  ON metadata_register.reconciliation_definitions(domain_code);

CREATE TABLE IF NOT EXISTS data_quality.reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES metadata_register.reconciliation_definitions(id),
  anchor_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
  as_of_date DATE NOT NULL,
  compare_as_of_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'EXCEPTIONS'
    CHECK (status IN ('EXCEPTIONS', 'REVIEW', 'APPROVED', 'SENT_BACK')),
  stage_index INTEGER NOT NULL DEFAULT 2,
  assigned_to TEXT,
  open_break_count INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}',
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  decision_notes TEXT,
  client_id UUID REFERENCES tenancy.clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE data_quality.reconciliation_runs IS
  'One review of one anchor entity at an as-of date, optionally against a prior date.';

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_anchor
  ON data_quality.reconciliation_runs(anchor_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status
  ON data_quality.reconciliation_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS data_quality.reconciliation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES data_quality.reconciliation_runs(id) ON DELETE CASCADE,
  line_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
  line_code TEXT NOT NULL,
  line_name TEXT NOT NULL,
  attribute_code TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  break_kind VARCHAR(20) NOT NULL CHECK (break_kind IN ('SOURCE', 'PERIOD', 'IDENTITY')),
  cells JSONB NOT NULL DEFAULT '[]',
  golden_value TEXT,
  variance NUMERIC,
  is_break BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'MATCHED'
    CHECK (status IN ('MATCHED', 'OPEN', 'ACCEPTED', 'OVERRIDDEN', 'WAIVED')),
  resolution_source_code TEXT,
  resolution_value TEXT,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE data_quality.reconciliation_lines IS
  'One compared attribute on a run. MATCHED rows agree. OPEN rows are breaks awaiting a decision.';

CREATE INDEX IF NOT EXISTS idx_reconciliation_lines_run
  ON data_quality.reconciliation_lines(run_id, is_break, attribute_code);

ALTER TABLE metadata_register.reconciliation_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality.reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality.reconciliation_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reconciliation_definitions_select ON metadata_register.reconciliation_definitions;
DROP POLICY IF EXISTS reconciliation_definitions_insert ON metadata_register.reconciliation_definitions;
DROP POLICY IF EXISTS reconciliation_definitions_update ON metadata_register.reconciliation_definitions;
DROP POLICY IF EXISTS reconciliation_definitions_delete ON metadata_register.reconciliation_definitions;
CREATE POLICY reconciliation_definitions_select ON metadata_register.reconciliation_definitions
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY reconciliation_definitions_insert ON metadata_register.reconciliation_definitions
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY reconciliation_definitions_update ON metadata_register.reconciliation_definitions
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY reconciliation_definitions_delete ON metadata_register.reconciliation_definitions
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS reconciliation_runs_select ON data_quality.reconciliation_runs;
DROP POLICY IF EXISTS reconciliation_runs_insert ON data_quality.reconciliation_runs;
DROP POLICY IF EXISTS reconciliation_runs_update ON data_quality.reconciliation_runs;
DROP POLICY IF EXISTS reconciliation_runs_delete ON data_quality.reconciliation_runs;
CREATE POLICY reconciliation_runs_select ON data_quality.reconciliation_runs
  FOR SELECT TO authenticated
  USING (tenancy.has_entity_access(anchor_entity_id, 'READ'));
CREATE POLICY reconciliation_runs_insert ON data_quality.reconciliation_runs
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.has_entity_access(anchor_entity_id, 'WRITE'));
CREATE POLICY reconciliation_runs_update ON data_quality.reconciliation_runs
  FOR UPDATE TO authenticated
  USING (tenancy.has_entity_access(anchor_entity_id, 'WRITE'))
  WITH CHECK (tenancy.has_entity_access(anchor_entity_id, 'WRITE'));
CREATE POLICY reconciliation_runs_delete ON data_quality.reconciliation_runs
  FOR DELETE TO authenticated
  USING (tenancy.has_entity_access(anchor_entity_id, 'WRITE'));

DROP POLICY IF EXISTS reconciliation_lines_select ON data_quality.reconciliation_lines;
DROP POLICY IF EXISTS reconciliation_lines_insert ON data_quality.reconciliation_lines;
DROP POLICY IF EXISTS reconciliation_lines_update ON data_quality.reconciliation_lines;
DROP POLICY IF EXISTS reconciliation_lines_delete ON data_quality.reconciliation_lines;
CREATE POLICY reconciliation_lines_select ON data_quality.reconciliation_lines
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_quality.reconciliation_runs run
    WHERE run.id = run_id AND tenancy.has_entity_access(run.anchor_entity_id, 'READ')
  ));
CREATE POLICY reconciliation_lines_insert ON data_quality.reconciliation_lines
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM data_quality.reconciliation_runs run
    WHERE run.id = run_id AND tenancy.has_entity_access(run.anchor_entity_id, 'WRITE')
  ));
CREATE POLICY reconciliation_lines_update ON data_quality.reconciliation_lines
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_quality.reconciliation_runs run
    WHERE run.id = run_id AND tenancy.has_entity_access(run.anchor_entity_id, 'WRITE')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM data_quality.reconciliation_runs run
    WHERE run.id = run_id AND tenancy.has_entity_access(run.anchor_entity_id, 'WRITE')
  ));
CREATE POLICY reconciliation_lines_delete ON data_quality.reconciliation_lines
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_quality.reconciliation_runs run
    WHERE run.id = run_id AND tenancy.has_entity_access(run.anchor_entity_id, 'WRITE')
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.reconciliation_definitions TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_quality.reconciliation_runs TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_quality.reconciliation_lines TO authenticated, service_role;

CREATE OR REPLACE VIEW public.reconciliation_definitions
WITH (security_invoker = true) AS
SELECT * FROM metadata_register.reconciliation_definitions;

CREATE OR REPLACE VIEW public.reconciliation_runs
WITH (security_invoker = true) AS
SELECT * FROM data_quality.reconciliation_runs;

CREATE OR REPLACE VIEW public.reconciliation_lines
WITH (security_invoker = true) AS
SELECT * FROM data_quality.reconciliation_lines;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_definitions TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_runs TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_lines TO authenticated, service_role;

INSERT INTO metadata_register.attribute_register (
  attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank, domain_code
) VALUES
  ('TOTAL_ASSETS', 'Total Assets', 'NUMBER', 'Fund total assets', FALSE, 100, 'FUND'),
  ('TOTAL_LIABILITIES', 'Total Liabilities', 'NUMBER', 'Fund total liabilities', FALSE, 100, 'FUND'),
  ('SHARES_OUTSTANDING', 'Shares Outstanding', 'NUMBER', 'Fund shares outstanding', FALSE, 100, 'FUND'),
  ('NAV_PER_SHARE', 'NAV per Share', 'NUMBER', 'Net asset value per share', FALSE, 100, 'FUND')
ON CONFLICT (attribute_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
  template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT template.id, attribute.id, FALSE, 100, 100
FROM metadata_register.domain_templates template
JOIN metadata_register.attribute_register attribute
  ON attribute.attribute_code IN ('TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'SHARES_OUTSTANDING', 'NAV_PER_SHARE')
WHERE template.template_code = 'FUND_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.reconciliation_definitions (
  definition_code, definition_name, description, domain_code, compare_mode, grain,
  relationship_code, relationship_direction, measures, identity_checks, stages
) VALUES (
  'FUND_NAV_TIEOUT',
  'Fund NAV tie-out',
  'Compare a fund''s positions across sources and against the prior period, and tie NAV to the position book and the per-share identity.',
  'FUND',
  'BOTH',
  'RELATED',
  'POSITION_FUND',
  'PARENT',
  '[
    {"attributeCode":"MARKET_VALUE","toleranceType":"PERCENT","tolerance":0.01,"role":"MEASURE"},
    {"attributeCode":"QUANTITY","toleranceType":"ABSOLUTE","tolerance":0.0001,"role":"MEASURE"}
  ]'::jsonb,
  '[
    {"code":"NAV_PER_SHARE","name":"NAV per share","kind":"EXPRESSION","compareAttributeCode":"NAV_PER_SHARE","toleranceType":"ABSOLUTE","tolerance":0.01,
     "expression":{"op":"div","args":[{"op":"sub","args":[{"ref":"TOTAL_ASSETS"},{"ref":"TOTAL_LIABILITIES"}]},{"ref":"SHARES_OUTSTANDING"}]}},
    {"code":"NAV_VS_POSITIONS","name":"NAV vs position market value","kind":"SUM_RELATED","childAttributeCode":"MARKET_VALUE","anchorAttributeCode":"NAV","toleranceType":"PERCENT","tolerance":0.01}
  ]'::jsonb,
  '["Select fund","Sync external data","Exception handling","Operations review","Approved"]'::jsonb
), (
  'SECURITY_REFERENCE_CLEANSE',
  'Security reference cleanse',
  'Compare security identifiers and classifications across sources, and confirm changes since the prior date.',
  'SECURITY',
  'BOTH',
  'ENTITY',
  NULL,
  'CHILD',
  '[
    {"attributeCode":"ISIN","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"},
    {"attributeCode":"CUSIP","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"},
    {"attributeCode":"TICKER","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"},
    {"attributeCode":"SECURITY_TYPE","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"},
    {"attributeCode":"CURRENCY","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"},
    {"attributeCode":"EXCHANGE","toleranceType":"EXACT","tolerance":0,"role":"MEASURE"}
  ]'::jsonb,
  '[]'::jsonb,
  '["Select security","Sync sources","Exception handling","Steward review","Approved"]'::jsonb
)
ON CONFLICT (definition_code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
