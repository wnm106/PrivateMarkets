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
    'Match this shell: one primary figure, then one chart, then one table, with loading, empty and error states and the As Of date. Keep the x- class pattern (one style block, tokens only), the bindings on every figure, and right-aligned figures. Replace the labels, attribute codes, query keys and numbers with the ledger and the previewed queries.',
  body: `<div class="x-wrap">
  <header class="x-head">
    <div>
      <div class="x-kicker" id="domain"></div>
      <h2 id="title">Dashboard</h2>
    </div>
    <div class="x-asof" id="asof"></div>
  </header>
  <section class="x-primary" id="primary"><div class="t-loading">Loading…</div></section>
  <section class="x-chart" id="chart"></section>
  <section id="detail">
    <h3>Positions</h3>
    <div id="table"></div>
  </section>
</div>
<style>
  .x-wrap { padding: 16px; }
  .x-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 12px; }
  .x-kicker { font-size: 12px; color: var(--ink-3); }
  .x-wrap h2 { margin: 2px 0 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
  .x-wrap h3 { margin: 16px 0 8px; font-size: 14px; font-weight: 600; }
  .x-asof { font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .x-primary { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 12px 16px; }
  .x-label { font-size: 12px; color: var(--ink-3); }
  .x-value { display: inline-block; margin-top: 4px; font-size: 28px; font-weight: 600; color: var(--accent); }
  .x-note { font-size: 12px; color: var(--ink-3); }
  .x-chart { margin-top: 16px; }
</style>
<script>
tapestr.onData(function (payload) {
  var entity = payload.entity || {};
  var set = payload.data.positions || {};
  var rows = set.rows || [];
  document.getElementById('domain').innerHTML = tapestr.esc(entity.domainName || '');
  document.getElementById('title').innerHTML = '<span' + tapestr.bind.attr('ENTITY_NAME', null, 'Name') + '>' + tapestr.esc(entity.entityName || 'Dashboard') + '</span>';
  document.getElementById('asof').textContent = payload.params && payload.params.asOfDate ? 'As of ' + tapestr.fmt.date(payload.params.asOfDate) : '';
  var primary = document.getElementById('primary');
  var chart = document.getElementById('chart');
  var table = document.getElementById('table');
  document.getElementById('detail').hidden = !!set.error || !rows.length;
  if (set.error) {
    primary.innerHTML = '<div class="t-error">The positions could not be read: ' + tapestr.esc(set.error) + '. Change the As Of date or ask an administrator to check the query.</div>';
    chart.innerHTML = '';
    table.innerHTML = '';
    return;
  }
  if (!rows.length) {
    primary.innerHTML = '<div class="t-empty">No positions at this As Of date.</div>';
    chart.innerHTML = '';
    table.innerHTML = '';
    return;
  }
  var total = rows.reduce(function (sum, row) { return sum + Number(row.MARKET_VALUE || 0); }, 0);
  primary.innerHTML = '<div class="x-label">Market value</div>'
    + '<span class="x-value num"' + tapestr.bind.derived('Sum of market value across the positions below', 'positions', 'MARKET_VALUE') + '>' + tapestr.fmt.currency(total) + '</span>'
    + '<div class="x-note">across <span' + tapestr.bind.derived('Count of positions', 'positions') + '>' + rows.length + '</span> positions</div>';
  chart.innerHTML = tapestr.charts.bar(rows.slice(0, 12).map(function (row) {
    return { label: row.entity_name, value: Number(row.MARKET_VALUE || 0) };
  }), { width: 640, height: 200 });
  tapestr.table(table, rows, [
    { key: 'entity_name', label: 'Position' },
    { key: 'MARKET_VALUE', label: 'Market value', align: 'right', format: function (v) { return tapestr.fmt.currency(v); } },
    { key: 'share', label: 'Share', align: 'right', derived: 'Market value divided by the total above', format: function (v, row) { return tapestr.fmt.percent(Number(row.MARKET_VALUE || 0) / (total || 1)); } }
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
