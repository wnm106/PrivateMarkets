-- Record experiences compose an anchor entity with related entities into one
-- working screen. A pipeline on the experience is the list that opens it.
-- Dashboards stay read-only and are embedded by section, not edited here.

CREATE TABLE IF NOT EXISTS public.record_experiences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experience_code VARCHAR(100) UNIQUE NOT NULL,
    experience_name VARCHAR(200) NOT NULL,
    description TEXT,
    anchor_domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    sections JSONB NOT NULL DEFAULT '[]',
    pipeline JSONB,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    client_id UUID REFERENCES tenancy.clients(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_experiences_anchor
    ON public.record_experiences(anchor_domain_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_experiences_one_default
    ON public.record_experiences(anchor_domain_code)
    WHERE is_default AND is_active;

COMMENT ON TABLE public.record_experiences IS
    'Named working screens. Each section is a form, grid, or dashboard reached from the anchor by an optional relationship.';
COMMENT ON COLUMN public.record_experiences.sections IS
    'Ordered slots: key, title, kind FORM|GRID|DASHBOARD, placement CANVAS|TAB|BELOW, domainCode, relationshipCode, direction UP|DOWN, columns, dashboardCode, templateCode.';
COMMENT ON COLUMN public.record_experiences.pipeline IS
    'Optional board: stageAttribute, stages [{code,label}], cardAttributes. Opening a card loads this experience.';

ALTER TABLE public.record_experiences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Record experiences readable by authenticated" ON public.record_experiences;
CREATE POLICY "Record experiences readable by authenticated" ON public.record_experiences
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Record experiences writable by tenant admins" ON public.record_experiences;
CREATE POLICY "Record experiences writable by tenant admins" ON public.record_experiences
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.record_experiences TO authenticated;

-- Deal stage is an ordinary attribute, so the pipeline and the deal form stay in sync.
ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description,
    domain_code, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible
) VALUES (
    'DEAL_STAGE', 'Deal Stage', 'STRING', 'Where the deal sits in the pipeline.',
    'DEAL', FALSE, 100, 'Pipeline', 1, TRUE, TRUE
)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = TRUE,
    is_visible = TRUE;

UPDATE metadata_register.attribute_register
SET display_section = 'Terms', display_group = 10
WHERE attribute_code = 'DEAL_TYPE';
UPDATE metadata_register.attribute_register
SET display_section = 'Terms', display_group = 11
WHERE attribute_code = 'DEAL_VALUE';
UPDATE metadata_register.attribute_register
SET display_section = 'Terms', display_group = 12
WHERE attribute_code = 'DEAL_DATE';
UPDATE metadata_register.attribute_register
SET display_section = 'Pipeline', display_group = 2
WHERE attribute_code = 'STATUS' AND domain_code = 'DEAL';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, 0
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a ON a.attribute_code = 'DEAL_STAGE'
WHERE t.template_code = 'DEAL_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES (
    'DEAL_SECURITY', 'Deal securities', 'DEAL', 'SECURITY',
    'Securities financed or issued in a deal', 'ONE_TO_MANY', FALSE
)
ON CONFLICT (relationship_code) DO UPDATE
SET cardinality = EXCLUDED.cardinality,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description;

UPDATE metadata_register.relationship_types
SET cardinality = 'ONE_TO_ONE'
WHERE relationship_code = 'DEAL_ISSUER';

-- Insight dashboards sit under the working record. They reuse the relationship overview query.
INSERT INTO public.dashboard_templates (
    dashboard_code, dashboard_name, description, domain_code, html_template, data_queries, parameters
)
SELECT
    v.dashboard_code,
    v.dashboard_name,
    v.description,
    v.domain_code,
    $html$
<div class="wrap">
  <h2 id="title">Loading…</h2>
  <div class="muted" id="sub"></div>
  <div class="grid" id="kpis"></div>
  <h3>Related by type</h3>
  <div id="chart"></div>
  <h3>Related records</h3>
  <div id="tbl"></div>
</div>
<style>
  .wrap{padding:8px 4px 4px;font-family:system-ui,sans-serif;color:#142033}
  .muted{color:#566a88;font-size:12px;margin-bottom:12px}
  .grid{display:flex;gap:12px;margin:12px 0}
  .kpi{border:1px solid #dde6f1;padding:10px 16px;min-width:120px}
  .kpi b{display:block;font-size:22px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{border-bottom:1px solid #e8eef6;padding:6px 8px;text-align:left}
</style>
<script>
tapestr.onData(function (d) {
  var e = d.entity || {};
  document.getElementById('title').textContent = e.entityName || 'Record';
  document.getElementById('sub').textContent = (e.entityCode || '') + ' · related records as of this view';
  var byType = (d.data.related_by_type && d.data.related_by_type.rows) || [];
  var related = (d.data.related && d.data.related.rows) || [];
  var total = byType.reduce(function (s, r) { return s + Number(r.related_count || 0); }, 0);
  document.getElementById('kpis').innerHTML =
    '<div class="kpi"><b>' + total + '</b>related records</div>' +
    '<div class="kpi"><b>' + byType.length + '</b>entity types</div>';
  document.getElementById('chart').innerHTML = tapestr.charts.bar(
    byType.map(function (r) { return { label: r.domain_code, value: Number(r.related_count || 0) }; }));
  tapestr.table(document.getElementById('tbl'), related, ['entity_code', 'entity_name', 'domain_code']);
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
FROM (VALUES
    ('DEAL_NETWORK', 'Deal network', 'Related issuers, securities, and funds on this deal.', 'DEAL'),
    ('POSITION_NETWORK', 'Position network', 'The fund and security connected to this position.', 'POSITION')
) AS v(dashboard_code, dashboard_name, description, domain_code)
WHERE EXISTS (
    SELECT 1 FROM metadata_register.domain_types d WHERE d.domain_code = v.domain_code
)
ON CONFLICT (dashboard_code) DO NOTHING;

INSERT INTO public.record_experiences (
    experience_code, experience_name, description, anchor_domain_code,
    sections, pipeline, is_default, is_active
) VALUES
(
    'DEAL_MANAGEMENT',
    'Deal Management',
    'Edit the deal and its issuer together, keep the securities in a grid, and read the deal network underneath.',
    'DEAL',
    '[
      {"key":"deal","title":"Deal","kind":"FORM","placement":"CANVAS","domainCode":"DEAL","templateCode":"DEAL_STANDARD"},
      {"key":"issuer","title":"Issuer","kind":"FORM","placement":"CANVAS","domainCode":"ISSUER","relationshipCode":"DEAL_ISSUER","direction":"DOWN","templateCode":"ISSUER_STANDARD"},
      {"key":"securities","title":"Securities","kind":"GRID","placement":"TAB","domainCode":"SECURITY","relationshipCode":"DEAL_SECURITY","direction":"DOWN","templateCode":"SECURITY_STANDARD","columns":["ISIN","INSTRUMENT_TYPE","CURRENCY","MATURITY_DATE","COUPON_RATE","PRICE"]},
      {"key":"insights","title":"Deal network","kind":"DASHBOARD","placement":"TAB","dashboardCode":"DEAL_NETWORK"}
    ]'::jsonb,
    '{
      "stageAttribute":"DEAL_STAGE",
      "stages":[
        {"code":"ORIGINATION","label":"Origination"},
        {"code":"DILIGENCE","label":"Diligence"},
        {"code":"COMMITTEE","label":"Committee"},
        {"code":"CLOSING","label":"Closing"},
        {"code":"CLOSED","label":"Closed"}
      ],
      "cardAttributes":["DEAL_TYPE","DEAL_VALUE"]
    }'::jsonb,
    TRUE,
    TRUE
),
(
    'FUND_MANAGEMENT',
    'Fund Management',
    'Edit the fund, review the deals it sponsors, and keep the relationship overview underneath.',
    'FUND',
    '[
      {"key":"fund","title":"Fund","kind":"FORM","placement":"CANVAS","domainCode":"FUND","templateCode":"FUND_STANDARD"},
      {"key":"deals","title":"Deals","kind":"GRID","placement":"TAB","domainCode":"DEAL","relationshipCode":"DEAL_FUND","direction":"UP","templateCode":"DEAL_STANDARD","columns":["DEAL_STAGE","DEAL_TYPE","DEAL_VALUE","DEAL_DATE"]},
      {"key":"insights","title":"Relationship overview","kind":"DASHBOARD","placement":"TAB","dashboardCode":"FUND_RELATIONSHIP_OVERVIEW"}
    ]'::jsonb,
    NULL,
    TRUE,
    TRUE
),
(
    'POSITION_WORKSPACE',
    'Position Workspace',
    'Edit the position with its fund and security on the same screen.',
    'POSITION',
    '[
      {"key":"position","title":"Position","kind":"FORM","placement":"CANVAS","domainCode":"POSITION","templateCode":"POSITION_STANDARD"},
      {"key":"fund","title":"Fund","kind":"FORM","placement":"CANVAS","domainCode":"FUND","relationshipCode":"POSITION_FUND","direction":"DOWN","templateCode":"FUND_STANDARD"},
      {"key":"security","title":"Security","kind":"FORM","placement":"TAB","domainCode":"SECURITY","relationshipCode":"POSITION_SECURITY","direction":"DOWN","templateCode":"SECURITY_STANDARD"},
      {"key":"insights","title":"Position network","kind":"DASHBOARD","placement":"TAB","dashboardCode":"POSITION_NETWORK"}
    ]'::jsonb,
    NULL,
    TRUE,
    TRUE
)
ON CONFLICT (experience_code) DO UPDATE
SET experience_name = EXCLUDED.experience_name,
    description = EXCLUDED.description,
    anchor_domain_code = EXCLUDED.anchor_domain_code,
    sections = EXCLUDED.sections,
    pipeline = EXCLUDED.pipeline,
    is_default = EXCLUDED.is_default,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- Sample pipeline. Reuses the data-quality issuers and securities when they exist.
DO $$
DECLARE
    v_client uuid;
    v_source uuid;
BEGIN
    SELECT client_id INTO v_client
    FROM entity_instances.master_entities
    WHERE entity_code = 'DQ-ISS-NORTHWIND';

    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;

    SELECT id INTO v_source
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_client IS NULL OR v_source IS NULL THEN
        RAISE NOTICE 'Skipping pipeline sample: client % source %', v_client, v_source;
        RETURN;
    END IF;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT v.entity_code, v.domain_code, t.id, v.entity_name, v.description, v_client, '{"pipelineSample":true}'::jsonb
    FROM (VALUES
        ('PIPE-FUND-I', 'FUND', 'FUND_STANDARD', 'Meridian Credit Fund I', 'Sponsor fund for the sample deal pipeline.'),
        ('PIPE-SEC-NORTHWIND-2L', 'SECURITY', 'SECURITY_STANDARD', 'Northwind Second Lien 2031', 'Second lien held alongside the Northwind unitranche.'),
        ('PIPE-DEAL-NORTHWIND', 'DEAL', 'DEAL_STANDARD', 'Northwind Unitranche', 'Origination. Issuer and two securities sit on the working record.'),
        ('PIPE-DEAL-HARBOR', 'DEAL', 'DEAL_STANDARD', 'Harborline Add-on', 'Diligence on the Harborline mezzanine.'),
        ('PIPE-DEAL-CEDAR', 'DEAL', 'DEAL_STANDARD', 'Cedar Ridge Revolver', 'In committee.'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DEAL', 'DEAL_STANDARD', 'Northwind Refinancing', 'Moving through closing.'),
        ('PIPE-DEAL-LEGACY', 'DEAL', 'DEAL_STANDARD', 'Legacy Packaging Exit', 'Closed exit of the Northwind platform.')
    ) AS v(entity_code, domain_code, template_code, entity_name, description)
    JOIN metadata_register.domain_templates t ON t.template_code = v.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        template_id = EXCLUDED.template_id,
        domain_code = EXCLUDED.domain_code,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id
      AND me.entity_code LIKE 'PIPE-%';

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_source, v.golden_value, DATE '2020-01-01', DATE '9999-12-31', 100, '{"pipelineSample":true}'::jsonb
    FROM (VALUES
        ('PIPE-FUND-I', 'FUND_TYPE', 'Private Credit'),
        ('PIPE-FUND-I', 'FUND_STATUS', 'Open'),
        ('PIPE-FUND-I', 'MANAGER', 'Meridian Credit'),
        ('PIPE-FUND-I', 'AUM', '750000000'),
        ('PIPE-FUND-I', 'INCEPTION_DATE', '2019-06-01'),
        ('PIPE-SEC-NORTHWIND-2L', 'ISIN', 'US0NWN000002'),
        ('PIPE-SEC-NORTHWIND-2L', 'INSTRUMENT_TYPE', 'LOAN'),
        ('PIPE-SEC-NORTHWIND-2L', 'CURRENCY', 'USD'),
        ('PIPE-SEC-NORTHWIND-2L', 'MATURITY_DATE', '2031-06-15'),
        ('PIPE-SEC-NORTHWIND-2L', 'COUPON_RATE', '11.25'),
        ('PIPE-SEC-NORTHWIND-2L', 'PRICE', '97.50'),
        ('PIPE-DEAL-NORTHWIND', 'DEAL_STAGE', 'ORIGINATION'),
        ('PIPE-DEAL-NORTHWIND', 'DEAL_TYPE', 'Unitranche'),
        ('PIPE-DEAL-NORTHWIND', 'DEAL_VALUE', '150000000'),
        ('PIPE-DEAL-NORTHWIND', 'DEAL_DATE', '2026-03-12'),
        ('PIPE-DEAL-NORTHWIND', 'STATUS', 'Active'),
        ('PIPE-DEAL-HARBOR', 'DEAL_STAGE', 'DILIGENCE'),
        ('PIPE-DEAL-HARBOR', 'DEAL_TYPE', 'Add-on'),
        ('PIPE-DEAL-HARBOR', 'DEAL_VALUE', '40000000'),
        ('PIPE-DEAL-HARBOR', 'DEAL_DATE', '2026-05-02'),
        ('PIPE-DEAL-HARBOR', 'STATUS', 'Active'),
        ('PIPE-DEAL-CEDAR', 'DEAL_STAGE', 'COMMITTEE'),
        ('PIPE-DEAL-CEDAR', 'DEAL_TYPE', 'Revolver'),
        ('PIPE-DEAL-CEDAR', 'DEAL_VALUE', '25000000'),
        ('PIPE-DEAL-CEDAR', 'DEAL_DATE', '2026-06-18'),
        ('PIPE-DEAL-CEDAR', 'STATUS', 'Active'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DEAL_STAGE', 'CLOSING'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DEAL_TYPE', 'Refinancing'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DEAL_VALUE', '90000000'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DEAL_DATE', '2026-08-01'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'STATUS', 'Active'),
        ('PIPE-DEAL-LEGACY', 'DEAL_STAGE', 'CLOSED'),
        ('PIPE-DEAL-LEGACY', 'DEAL_TYPE', 'Exit'),
        ('PIPE-DEAL-LEGACY', 'DEAL_VALUE', '60000000'),
        ('PIPE-DEAL-LEGACY', 'DEAL_DATE', '2025-11-20'),
        ('PIPE-DEAL-LEGACY', 'STATUS', 'Closed')
    ) AS v(entity_code, attribute_code, golden_value)
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT p.id, c.id, v.relationship_type, v.relationship_code, TRUE, DATE '2020-01-01'
    FROM (VALUES
        ('PIPE-DEAL-NORTHWIND', 'DQ-ISS-NORTHWIND', 'Deal with issuer', 'DEAL_ISSUER'),
        ('PIPE-DEAL-NORTHWIND', 'DQ-SEC-NORTHWIND', 'Deal securities', 'DEAL_SECURITY'),
        ('PIPE-DEAL-NORTHWIND', 'PIPE-SEC-NORTHWIND-2L', 'Deal securities', 'DEAL_SECURITY'),
        ('PIPE-DEAL-NORTHWIND', 'PIPE-FUND-I', 'Deal sponsored by fund', 'DEAL_FUND'),
        ('PIPE-DEAL-HARBOR', 'DQ-ISS-HARBOR', 'Deal with issuer', 'DEAL_ISSUER'),
        ('PIPE-DEAL-HARBOR', 'DQ-SEC-HARBOR', 'Deal securities', 'DEAL_SECURITY'),
        ('PIPE-DEAL-HARBOR', 'PIPE-FUND-I', 'Deal sponsored by fund', 'DEAL_FUND'),
        ('PIPE-DEAL-CEDAR', 'DQ-ISS-CEDAR', 'Deal with issuer', 'DEAL_ISSUER'),
        ('PIPE-DEAL-CEDAR', 'DQ-SEC-CEDAR', 'Deal securities', 'DEAL_SECURITY'),
        ('PIPE-DEAL-CEDAR', 'PIPE-FUND-I', 'Deal sponsored by fund', 'DEAL_FUND'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DQ-ISS-NORTHWIND', 'Deal with issuer', 'DEAL_ISSUER'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'DQ-SEC-NORTHWIND', 'Deal securities', 'DEAL_SECURITY'),
        ('PIPE-DEAL-NORTHWIND-REFIN', 'PIPE-FUND-I', 'Deal sponsored by fund', 'DEAL_FUND'),
        ('PIPE-DEAL-LEGACY', 'DQ-ISS-NORTHWIND', 'Deal with issuer', 'DEAL_ISSUER'),
        ('PIPE-DEAL-LEGACY', 'PIPE-FUND-I', 'Deal sponsored by fund', 'DEAL_FUND'),
        ('DQ-POS-NORTHWIND', 'PIPE-FUND-I', 'Position held in fund', 'POSITION_FUND'),
        ('DQ-POS-NORTHWIND', 'DQ-SEC-NORTHWIND', 'Position in security', 'POSITION_SECURITY'),
        ('DQ-POS-HARBOR', 'PIPE-FUND-I', 'Position held in fund', 'POSITION_FUND'),
        ('DQ-POS-HARBOR', 'DQ-SEC-HARBOR', 'Position in security', 'POSITION_SECURITY'),
        ('DQ-POS-CEDAR', 'PIPE-FUND-I', 'Position held in fund', 'POSITION_FUND'),
        ('DQ-POS-CEDAR', 'DQ-SEC-CEDAR', 'Position in security', 'POSITION_SECURITY')
    ) AS v(parent_code, child_code, relationship_type, relationship_code)
    JOIN entity_instances.master_entities p ON p.entity_code = v.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = v.child_code
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
