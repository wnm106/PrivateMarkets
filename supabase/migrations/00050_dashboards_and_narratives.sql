-- Migration: Custom Dashboards & Narratives
-- Description: Per-entity-type, user-designed reporting templates.
--
--   dashboard_templates -- custom HTML + declarative data queries. The HTML is
--       rendered in a sandboxed iframe on an entity page; the data_queries
--       describe what must be retrieved (entity traversal, filters, group-by,
--       aggregations) and are executed by the data-query engine at view time
--       against whichever entity is being viewed + the user's filter inputs.
--
--   narrative_templates -- templated agentic reviews. Declares data queries,
--       analysis instructions and the desired output blocks (markdown / table /
--       chart / insights). An LLM run produces structured blocks.
--
--   narrative_runs -- stored output of narrative executions (cache + history).
--
-- Tables live in `public` (like reference lists / import maps) so PostgREST
-- needs no extra exposed schema. Tenancy: client_id NULL = shared template.

-- ============================================================
-- 1. dashboard_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dashboard_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_code VARCHAR(100) UNIQUE NOT NULL,
    dashboard_name VARCHAR(200) NOT NULL,
    description TEXT,

    -- The entity type this dashboard is attached to ("anchor" entity).
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),

    -- Custom HTML/CSS/JS. Rendered in a sandboxed iframe; receives data via postMessage.
    html_template TEXT NOT NULL DEFAULT '',

    -- Array of DataQuerySpec (see packages/graphql/src/lib/data-query-engine.ts)
    data_queries JSONB NOT NULL DEFAULT '[]',

    -- Array of user-facing filter inputs:
    --   { name, label, type: text|number|date|select|boolean, options?, default? }
    -- Values are bound into data_queries filters via filter.param = name.
    parameters JSONB NOT NULL DEFAULT '[]',

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    client_id UUID REFERENCES tenancy.clients(id),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_templates_domain ON public.dashboard_templates(domain_code);
CREATE INDEX IF NOT EXISTS idx_dashboard_templates_client ON public.dashboard_templates(client_id);

COMMENT ON TABLE public.dashboard_templates IS 'User-designed dashboards: custom HTML plus the declarative data queries that saturate it. Attached to an entity type.';

-- ============================================================
-- 2. narrative_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS public.narrative_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    narrative_code VARCHAR(100) UNIQUE NOT NULL,
    narrative_name VARCHAR(200) NOT NULL,
    description TEXT,

    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),

    -- Natural-language analysis instructions given to the model.
    instructions TEXT NOT NULL DEFAULT '',

    -- Data sets to retrieve before analysis (array of DataQuerySpec).
    data_queries JSONB NOT NULL DEFAULT '[]',

    -- User-facing inputs (same shape as dashboard parameters).
    parameters JSONB NOT NULL DEFAULT '[]',

    -- Requested output blocks, in order:
    --   { type: markdown|table|chart|insights, key, title, guidance? }
    output_blocks JSONB NOT NULL DEFAULT '[]',

    model VARCHAR(100),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    client_id UUID REFERENCES tenancy.clients(id),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_narrative_templates_domain ON public.narrative_templates(domain_code);
CREATE INDEX IF NOT EXISTS idx_narrative_templates_client ON public.narrative_templates(client_id);

COMMENT ON TABLE public.narrative_templates IS 'Templated agentic reviews: data queries + analysis instructions + requested output blocks. Attached to an entity type.';

-- ============================================================
-- 3. narrative_runs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.narrative_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    narrative_id UUID NOT NULL REFERENCES public.narrative_templates(id) ON DELETE CASCADE,
    entity_id UUID REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    parameters JSONB NOT NULL DEFAULT '{}',
    blocks JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'FAILED')),
    error_message TEXT,
    model VARCHAR(100),
    data_summary JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_narrative_runs_lookup ON public.narrative_runs(narrative_id, entity_id, created_at DESC);

COMMENT ON TABLE public.narrative_runs IS 'Stored output of narrative executions (latest run is shown as a cache; history is retained).';

-- ============================================================
-- 4. RLS
-- ============================================================
ALTER TABLE public.dashboard_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.narrative_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.narrative_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Dashboards readable by authenticated" ON public.dashboard_templates;
CREATE POLICY "Dashboards readable by authenticated" ON public.dashboard_templates
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Dashboards writable by tenant admins" ON public.dashboard_templates;
CREATE POLICY "Dashboards writable by tenant admins" ON public.dashboard_templates
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS "Narratives readable by authenticated" ON public.narrative_templates;
CREATE POLICY "Narratives readable by authenticated" ON public.narrative_templates
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Narratives writable by tenant admins" ON public.narrative_templates;
CREATE POLICY "Narratives writable by tenant admins" ON public.narrative_templates
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

-- Runs: visible if you can read the entity it is about (or you created it /
-- you are a tenant admin). Anyone may record a run they initiated.
DROP POLICY IF EXISTS "Narrative runs readable" ON public.narrative_runs;
CREATE POLICY "Narrative runs readable" ON public.narrative_runs
    FOR SELECT TO authenticated
    USING (
        created_by = auth.uid()
        OR tenancy.is_tenant_admin()
        OR (entity_id IS NOT NULL AND tenancy.has_entity_access(entity_id, 'READ'))
    );
DROP POLICY IF EXISTS "Narrative runs insertable by creator" ON public.narrative_runs;
CREATE POLICY "Narrative runs insertable by creator" ON public.narrative_runs
    FOR INSERT TO authenticated
    WITH CHECK (
        created_by = auth.uid()
        AND (entity_id IS NULL OR tenancy.has_entity_access(entity_id, 'READ'))
    );
DROP POLICY IF EXISTS "Narrative runs deletable by admins" ON public.narrative_runs;
CREATE POLICY "Narrative runs deletable by admins" ON public.narrative_runs
    FOR DELETE TO authenticated USING (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.narrative_templates TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.narrative_runs TO authenticated;

-- ============================================================
-- 5. Starter templates (generic -- rely on no domain-specific attribute codes)
-- ============================================================
INSERT INTO public.dashboard_templates (dashboard_code, dashboard_name, description, domain_code, html_template, data_queries, parameters)
SELECT
    'FUND_RELATIONSHIP_OVERVIEW',
    'Relationship Overview',
    'Starter dashboard: shows the fund and a breakdown of everything related to it, by entity type.',
    'FUND',
    $html$
<div class="wrap">
  <h2 id="title">Loading…</h2>
  <div class="muted" id="sub"></div>
  <div class="grid" id="kpis"></div>
  <h3>Related entities by type</h3>
  <div id="chart"></div>
  <h3>Related entities</h3>
  <div id="tbl"></div>
</div>
<style>
  .wrap{padding:16px;font-family:system-ui,sans-serif;color:#1c1c1c}
  .muted{color:#777;font-size:12px;margin-bottom:12px}
  .grid{display:flex;gap:12px;margin:12px 0}
  .kpi{border:1px solid #ddd;padding:10px 16px;min-width:120px}
  .kpi b{display:block;font-size:22px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
</style>
<script>
tapestr.onData(function (d) {
  var e = d.entity || {};
  document.getElementById('title').textContent = e.entityName || 'Fund';
  document.getElementById('sub').textContent = (e.entityCode || '') + ' · ' + (e.domainName || '');
  var byType = d.data.related_by_type.rows;
  var total = byType.reduce(function (s, r) { return s + r.related_count; }, 0);
  document.getElementById('kpis').innerHTML =
    '<div class="kpi"><b>' + total + '</b>related entities</div>' +
    '<div class="kpi"><b>' + byType.length + '</b>entity types</div>';
  document.getElementById('chart').innerHTML = tapestr.charts.bar(
    byType.map(function (r) { return { label: r.domain_code, value: r.related_count }; }));
  tapestr.table(document.getElementById('tbl'), d.data.related.rows,
    ['entity_code', 'entity_name', 'domain_code']);
});
</script>
$html$,
    '[
      {"key":"related_by_type","label":"Related entities by type","start":"CONTEXT",
       "path":[{"direction":"DOWN"}],
       "groupBy":["domain_code"],
       "metrics":[{"alias":"related_count","agg":"COUNT"}],
       "orderBy":[{"field":"related_count","dir":"desc"}]},
      {"key":"related","label":"Related entities","start":"CONTEXT",
       "path":[{"direction":"DOWN"}],
       "select":["entity_code","entity_name","domain_code"],"limit":100}
    ]'::jsonb,
    '[]'::jsonb
WHERE EXISTS (SELECT 1 FROM metadata_register.domain_types WHERE domain_code = 'FUND')
ON CONFLICT (dashboard_code) DO NOTHING;

INSERT INTO public.narrative_templates (narrative_code, narrative_name, description, domain_code, instructions, data_queries, parameters, output_blocks)
SELECT
    'FUND_DATA_COMPLETENESS_REVIEW',
    'Fund Data Review',
    'Starter narrative: summarises what the fund is connected to and highlights data gaps.',
    'FUND',
    'Review the fund and everything related to it. Summarise the shape of the portfolio (what types of entities are connected and how many). Point out anything that looks incomplete, inconsistent or unusual in the data provided. Do not invent figures that are not in the data.',
    '[
      {"key":"fund","label":"The fund itself","start":"CONTEXT","limit":1},
      {"key":"related_by_type","label":"Related entities by type","start":"CONTEXT",
       "path":[{"direction":"DOWN"}],"groupBy":["domain_code"],
       "metrics":[{"alias":"related_count","agg":"COUNT"}]}
    ]'::jsonb,
    '[]'::jsonb,
    '[
      {"type":"markdown","key":"summary","title":"Summary","guidance":"3-5 sentence executive summary."},
      {"type":"table","key":"composition","title":"Composition","guidance":"One row per related entity type with its count."},
      {"type":"insights","key":"flags","title":"Things to look at","guidance":"Up to 5 concise findings."}
    ]'::jsonb
WHERE EXISTS (SELECT 1 FROM metadata_register.domain_types WHERE domain_code = 'FUND')
ON CONFLICT (narrative_code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
