/**
 * Reference output stored on a skill. The body is injected only in the phases
 * where the model is producing that output, and the same body is used on every run.
 */
export interface SkillArtifact {
  id: string;
  title: string;
  phases: Array<'guided' | 'spec' | 'build' | 'apply'>;
  /** How the model should use the body. */
  instruction: string;
  body: string;
}

export const DASHBOARD_SHELL: SkillArtifact = {
  id: 'dashboard-shell',
  title: 'Dashboard shell',
  phases: ['build', 'apply'],
  instruction:
    'Match this shell: one primary figure, then one chart, then one table. Keep the class names, spacing, and right-aligned figures. Replace the labels, attribute codes, and numbers with the ledger and the previewed queries.',
  body: `<div class="wrap">
  <header class="head">
    <div>
      <div class="kicker" id="domain"></div>
      <h2 id="title">Loading…</h2>
    </div>
    <div class="asof" id="asof"></div>
  </header>
  <section class="primary" id="primary"></section>
  <section class="chart" id="chart"></section>
  <section>
    <h3 id="table-title">Detail</h3>
    <div id="table"></div>
  </section>
</div>
<style>
  .wrap { padding: 16px; color: #18181b; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 16px; }
  .kicker { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #71717a; }
  h2 { margin: 2px 0 0; font-size: 20px; font-weight: 600; }
  h3 { margin: 20px 0 8px; font-size: 14px; font-weight: 600; }
  .asof { font-size: 12px; color: #71717a; font-variant-numeric: tabular-nums; }
  .primary { border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 20px; }
  .primary .label { font-size: 12px; color: #71717a; }
  .primary .value { display: block; margin-top: 4px; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; color: #1d4ed8; }
  .primary .note { font-size: 12px; color: #71717a; }
  .chart { margin-top: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border-bottom: 1px solid #f4f4f5; padding: 8px; text-align: left; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #fafafa; }
  button:focus-visible, a:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
</style>
<script>
tapestr.onData(function (payload) {
  var entity = payload.entity || {};
  var rows = (payload.data.by_type && payload.data.by_type.rows) || [];
  document.getElementById('domain').textContent = entity.domainName || '';
  document.getElementById('title').textContent = entity.entityName || 'Dashboard';
  document.getElementById('asof').textContent = payload.params && payload.params.asOfDate ? payload.params.asOfDate : '';
  var total = rows.reduce(function (sum, row) { return sum + Number(row.value || 0); }, 0);
  var primary = document.getElementById('primary');
  if (!rows.length) {
    primary.innerHTML = '<div class="label">No rows</div><div class="note">Nothing matched this as-of date.</div>';
    document.getElementById('chart').innerHTML = '';
    document.getElementById('table').innerHTML = '';
    return;
  }
  primary.innerHTML = '<div class="label">Open items</div><span class="value">' + tapestr.fmt.number(total, 0) + '</span><div class="note">across ' + rows.length + ' groups</div>';
  document.getElementById('chart').innerHTML = tapestr.charts.bar(rows.map(function (row) {
    return { label: row.label, value: Number(row.value || 0) };
  }), { width: 560, height: 160, color: '#1d4ed8' });
  tapestr.table(document.getElementById('table'), rows, [
    { key: 'label', label: 'Group' },
    { key: 'value', label: 'Value', align: 'right' }
  ]);
});
</script>`,
};

export const NARRATIVE_BLOCKS: SkillArtifact = {
  id: 'narrative-blocks',
  title: 'Narrative blocks',
  phases: ['build', 'apply'],
  instruction:
    'Match this block order and the way instructions cite query keys. Replace the question, keys, and attribute codes with the ledger. Do not keep the sample findings.',
  body: `{
  "narrativeName": "Morning breach review",
  "description": "What changed overnight that a portfolio manager must act on.",
  "persona": "You are a credit analyst briefing a portfolio manager before the open.",
  "audience": "Portfolio manager",
  "exposedDomains": ["FUND"],
  "allowExternalSearch": false,
  "parameters": [],
  "sections": [
    {
      "key": "breaches",
      "title": "Covenant breaches",
      "purpose": "Which borrowers breached a covenant, and how far?",
      "instructions": "Answer only from the breaches data set and the thin_cushion screen. Cite query keys in each sentence that contains a figure. If breaches.rows is empty, say there were none. Do not estimate a number that is not in the rows.",
      "dataQueries": [
        { "key": "breaches", "start": "CONTEXT", "select": ["BORROWER", "COVENANT", "HEADROOM"], "limit": 500 }
      ],
      "comparisons": [{ "label": "Today" }, { "label": "Last quarter", "offset": { "months": 3 } }],
      "measures": [{ "query": "breaches", "alias": "cushion", "expr": "HEADROOM / 100", "unit": "percent" }],
      "screens": [{ "key": "thin_cushion", "label": "Cushion under 15%", "query": "breaches", "when": "cushion < 0.15", "severity": "high" }],
      "blocks": [
        { "type": "markdown", "key": "lead", "title": "What needs a decision", "guidance": "Two sentences. Name the count from the thin_cushion screen and the thinnest cushion." },
        { "type": "scorecard", "key": "breach-table", "title": "Breaches", "statusColumn": "Status", "guidance": "One row per flagged borrower. Columns: borrower, covenant, cushion, status." },
        { "type": "chart", "key": "by-covenant", "title": "Breaches by covenant", "guidance": "Bar chart of breaches grouped by covenant. Direct labels, one muted color." }
      ]
    },
    {
      "key": "summary",
      "title": "Next action",
      "instructions": "One action, tied to a flagged borrower. No action if nothing was flagged.",
      "dependsOn": ["breaches"],
      "dataQueries": [],
      "blocks": [{ "type": "insights", "key": "next", "title": "Next action", "guidance": "One item." }]
    }
  ]
}`,
};

export const ENTITY_SPEC: SkillArtifact = {
  id: 'entity-spec',
  title: 'Entity spec',
  phases: ['spec', 'apply'],
  instruction:
    'Present the model in this shape before you ask for confirmation, and create records in this order. Reuse the pattern (existing versus new, display order, one primary identifier). Replace every code with one returned by the tools.',
  body: `{
  "domain": { "action": "create", "domainCode": "CAPITAL_CALL", "domainName": "Capital call" },
  "template": { "action": "create", "templateCode": "CAPITAL_CALL", "templateName": "Capital call" },
  "fields": [
    { "action": "reuse", "attributeCode": "EFFECTIVE_DATE", "dataType": "DATE", "required": true, "displayOrder": 10 },
    { "action": "new", "attributeCode": "CALL_AMOUNT", "attributeName": "Call amount", "dataType": "CURRENCY", "required": true, "displayOrder": 20 },
    { "action": "new", "attributeCode": "DUE_DATE", "attributeName": "Due date", "dataType": "DATE", "required": true, "displayOrder": 30 }
  ],
  "identifier": { "identifierCode": "CAPITAL_CALL_KEY", "attributeCodes": ["EFFECTIVE_DATE", "CALL_AMOUNT"], "isPrimary": true },
  "relationships": [
    { "action": "create", "relationshipCode": "CALL_FUND", "parentDomainCode": "FUND", "childDomainCode": "CAPITAL_CALL", "cardinality": "ONE_TO_MANY" }
  ]
}`,
};
