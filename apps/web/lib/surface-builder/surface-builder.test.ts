import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPrototype, prototypeLabels } from './prototype';
import { inferDataType, labelSimilarity, matchLabels, suggestCode, type PlatformCatalog } from './catalog';
import { baselineBlueprint, blueprintMarkdown, mergeModelBlueprint } from './blueprint';
import { SURFACE_STANDARDS } from './standards';
import { BUILDER_TABS, builderTabs } from './tabs';

const HTML = `<!doctype html><html><head><title>Credit watchlist</title>
<script src="https://cdn.example.com/chart.js"></script></head><body>
<h1>Credit watchlist</h1>
<div role="tablist"><button role="tab">Summary</button><button role="tab">Positions</button><button role="tab">Covenants</button></div>
<section data-tab="summary">
  <div class="kpi"><span class="kpi-label">Net Asset Value</span><span class="kpi-value">$1,240.5m</span></div>
  <div class="kpi"><span class="kpi-label">Watchlist names</span><span class="kpi-value">12</span></div>
  <canvas id="nav-line-chart"></canvas>
</section>
<section data-tab="positions">
  <table><thead><tr><th>Issuer</th><th>Sector</th><th>Fair Value</th><th>Maturity Date</th><th>Spread</th></tr></thead>
  <tbody><tr><td>Acme</td><td>Industrials</td><td>$12.0m</td><td>2028-06-30</td><td>5.25%</td></tr></tbody></table>
</section>
<dl><dt>Internal rating</dt><dd>4</dd></dl>
<button class="btn">Add to watchlist</button>
<p>As of 2026-09-30</p>
</body></html>`;

const CATALOG: PlatformCatalog = {
  domains: [{ code: 'FUND', name: 'Fund' }, { code: 'POSITION', name: 'Position', parentCode: null }],
  attributes: [
    { code: 'NET_ASSET_VALUE', name: 'Net Asset Value', dataType: 'CURRENCY', domainCode: 'FUND' },
    { code: 'FAIR_VALUE', name: 'Fair Value', dataType: 'CURRENCY', domainCode: 'POSITION' },
    { code: 'MATURITY_DATE', name: 'Maturity Date', dataType: 'DATE', domainCode: 'POSITION' },
    { code: 'SECTOR', name: 'Sector', dataType: 'LIST', domainCode: 'POSITION' },
  ],
  relationships: [],
  tools: [
    { name: 'query_data', description: 'Query attribute values for entities', readOnly: true, args: [] },
    { name: 'set_override', description: 'Set a manual override on an attribute value', readOnly: false, args: [] },
  ],
  skills: [],
  surfaces: [],
  gaps: [],
};

describe('readPrototype', () => {
  const outline = readPrototype(HTML);

  it('reads the title, tabs, tables, charts and actions', () => {
    assert.equal(outline.title, 'Credit watchlist');
    assert.deepEqual(outline.tabs, ['Summary', 'Positions', 'Covenants']);
    assert.deepEqual(outline.tables[0].columns, ['Issuer', 'Sector', 'Fair Value', 'Maturity Date', 'Spread']);
    assert.ok(outline.charts.length > 0);
    assert.ok(outline.actions.includes('Add to watchlist'));
    assert.ok(!outline.actions.includes('Summary'));
  });

  it('reads KPI and definition fields with samples, under their tab', () => {
    const nav = outline.fields.find((field) => field.label === 'Net Asset Value');
    assert.deepEqual({ kind: nav?.kind, sample: nav?.sample, where: nav?.where }, { kind: 'kpi', sample: '$1,240.5m', where: 'Summary' });
    assert.equal(outline.fields.find((field) => field.label === 'Internal rating')?.sample, '4');
  });

  it('notices external scripts and an As Of date', () => {
    assert.deepEqual(outline.signals.externalScripts, ['https://cdn.example.com/chart.js']);
    assert.equal(outline.signals.asOfDate, true);
  });
});

describe('matching', () => {
  it('scores labels', () => {
    assert.equal(labelSimilarity('Fair Value', 'FAIR_VALUE'), 1);
    assert.equal(labelSimilarity('NAV', 'Net Asset Value'), 1);
    assert.equal(labelSimilarity('Issuer', 'Sector'), 0);
  });

  it('matches existing attributes and leaves the rest unmatched', () => {
    const matches = matchLabels(prototypeLabels(readPrototype(HTML)), CATALOG, 'POSITION');
    const byLabel = Object.fromEntries(matches.map((match) => [match.label, match]));
    assert.equal(byLabel['Fair Value'].verdict, 'exact');
    assert.equal(byLabel['Fair Value'].candidates[0].code, 'FAIR_VALUE');
    assert.equal(byLabel['Spread'].verdict, 'none');
    assert.equal(byLabel['Spread'].inferredType, 'PERCENTAGE');
  });

  it('infers types and codes', () => {
    assert.equal(inferDataType('Maturity', '2028-06-30'), 'DATE');
    assert.equal(inferDataType('Commitment', '$5m'), 'CURRENCY');
    assert.equal(suggestCode('Spread %'), 'SPREAD_PCT');
  });
});

describe('blueprint', () => {
  const request = { name: 'Credit watchlist', description: 'Names to watch', domainCode: 'POSITION', placement: 'record-tab' as const, html: HTML };

  it('builds a baseline with every standard and new attributes for unmatched values', () => {
    const baseline = baselineBlueprint(request, CATALOG);
    assert.equal(baseline.source, 'baseline');
    assert.deepEqual(baseline.standards.map((finding) => finding.id), SURFACE_STANDARDS.map((standard) => standard.id));
    assert.equal(baseline.standards.find((finding) => finding.id === 'design-system')?.level, 'gap');
    assert.ok(baseline.newAttributes.map((attribute) => attribute.code).includes('SPREAD'));
    assert.deepEqual(baseline.tabs.map((tab) => tab.label), ['Summary', 'Positions', 'Covenants']);
  });

  it('never lets the model pass off an invented code as existing', () => {
    const baseline = baselineBlueprint(request, CATALOG);
    const merged = mergeModelBlueprint(baseline, {
      fields: [
        { label: 'Fair Value', decision: 'reuse', attributeCode: 'FAIR_VALUE' },
        { label: 'Spread', decision: 'reuse', attributeCode: 'CREDIT_SPREAD' },
      ],
      capabilities: [{ title: 'Watchlist add', status: 'exists', tools: ['add_to_watchlist'] }],
      standards: [{ id: 'right-click-inspect', note: 'Bind all five columns.' }],
    }, CATALOG);
    assert.deepEqual({ decision: merged.fields[0].decision, domainCode: merged.fields[0].domainCode, dataType: merged.fields[0].dataType }, { decision: 'reuse', domainCode: 'POSITION', dataType: 'CURRENCY' });
    assert.equal(merged.fields[1].decision, 'new');
    assert.equal(merged.newAttributes.some((attribute) => attribute.code === 'CREDIT_SPREAD'), true);
    assert.equal(merged.capabilities[0].status, 'new');
    assert.equal(merged.standards.length, SURFACE_STANDARDS.length);
    assert.equal(merged.standards.find((finding) => finding.id === 'right-click-inspect')?.note, 'Bind all five columns.');
    assert.equal(merged.warnings.some((warning) => warning.includes('CREDIT_SPREAD')), true);
  });

  it('exports build instructions', () => {
    const markdown = blueprintMarkdown(baselineBlueprint(request, CATALOG));
    assert.ok(markdown.includes('# Build instructions: Credit watchlist'));
    assert.ok(markdown.includes('`FAIR_VALUE`'));
    assert.ok(markdown.includes('Every tab is published to the assistant'));
  });
});

describe('builderTabs', () => {
  it('publishes every tab, with null data before an analysis', () => {
    const empty = builderTabs(null);
    assert.deepEqual(Object.keys(empty), BUILDER_TABS.map((tab) => tab.key));
    for (const tab of Object.values(empty)) {
      assert.equal(tab.data, null);
      assert.ok(tab.label && tab.purpose);
    }
    const full = builderTabs(baselineBlueprint({ name: 'X', description: 'Y', html: HTML }, CATALOG));
    for (const tab of Object.values(full)) assert.notEqual(tab.data, null);
  });
});
