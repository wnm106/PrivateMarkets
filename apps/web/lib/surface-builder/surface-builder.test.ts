import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPrototype, readPrototypeWithViews, prototypeLabels } from './prototype';
import { inferDataType, labelSimilarity, matchLabels, suggestCode, type PlatformCatalog } from './catalog';
import { baselineBlueprint, blueprintMarkdown, decisionsFrom, exportBlockers, mergeModelBlueprint, normalizeBlueprint, readUnderstanding } from './blueprint';
import { SURFACE_STANDARDS, standardHowTo } from './standards';
import { extractHouseKit, houseDocument } from './house-kit';
import { checkAsk, designerSystem, readRedesignReply, redesignAsk, styleBlocks } from './redesign';
import { HandoffBlocked, handoffFiles, stopAndAsk } from './handoff';
import { auditFindings, auditView, auditViews } from './view-audit';
import { acceptanceScript } from './acceptance';
import { crc32, zipFiles } from '../zip';
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

describe('rendered views', () => {
  const SCRIPTED = `<!doctype html><html><head><title>Targets</title></head><body><div id="app"></div>
<script>document.getElementById('app').innerHTML = \`<svg class="chart">\${name}</svg>\`;</script></body></html>`;
  const views = [
    { label: 'Initial view', html: '<header><button aria-pressed="true">Assign targets</button><button aria-pressed="false">Pipeline</button></header>' },
    { label: 'Assign targets', html: '<div role="tablist"><button role="tab">Strategy</button><button role="tab">Pacing</button></div><table><thead><tr><th>Level</th><th>Target</th><th>Committed</th></tr></thead></table>' },
    { label: 'Pipeline', html: '<table><thead><tr><th>Deal</th><th>Sleeve</th><th>Allocation</th></tr></thead></table>' },
  ];

  it('reads no chart from a template string inside a script', () => {
    assert.deepEqual(readPrototype(SCRIPTED).charts, []);
  });

  it('builds the outline from what each view drew', () => {
    const outline = readPrototypeWithViews(SCRIPTED, views);
    assert.deepEqual(outline.views, ['Initial view', 'Assign targets', 'Pipeline']);
    for (const tab of ['Assign targets', 'Pipeline', 'Strategy', 'Pacing']) assert.ok(outline.tabs.includes(tab), tab);
    assert.equal(outline.tables.find((table) => table.columns.includes('Allocation'))?.where, 'Pipeline');
    const baseline = baselineBlueprint({ name: 'Targets', description: 'Set targets', html: SCRIPTED }, CATALOG, views);
    assert.ok(baseline.fields.some((field) => field.label === 'Committed'));
  });
});

describe('entity model', () => {
  const request = { name: 'Targets', description: 'Set targets', domainCode: 'FUND', html: HTML };

  it('keeps only catalog codes as existing and flags JSON records', () => {
    const merged = mergeModelBlueprint(baselineBlueprint(request, CATALOG), {
      entityTypes: [
        { code: 'FUND', status: 'reuse', purpose: 'Client or sleeve' },
        { code: 'MANDATE', status: 'reuse', purpose: 'Invented as existing' },
        { code: 'ALLOCATION_TARGET', status: 'new', identity: 'one per fund, hierarchy and node', attributes: ['target_usd'] },
      ],
      relationshipTypes: [{ code: 'TARGET_FUND', status: 'reuse', fromDomain: 'ALLOCATION_TARGET', toDomain: 'FUND' }],
      newAttributes: [
        { code: 'FUND_TARGET_MATRIX', name: 'Target matrix', domainCode: 'FUND', dataType: 'JSON' },
        { code: 'TARGET_USD', name: 'Target $', domainCode: 'ALLOCATION_TARGET', dataType: 'CURRENCY' },
        { code: 'ORPHAN', name: 'Orphan', domainCode: 'NOWHERE', dataType: 'NUMBER' },
      ],
      computations: [{ name: 'Sharing ratio', runsIn: '' }],
      compliance: [{ prototypeRule: 'Sleeve cap', mapsTo: 'threshold', tables: ['compliance.rule_thresholds'] }],
    }, CATALOG);
    assert.deepEqual(merged.entityTypes.map((plan) => [plan.code, plan.status]), [['FUND', 'reuse'], ['MANDATE', 'new'], ['ALLOCATION_TARGET', 'new']]);
    assert.deepEqual(merged.entityTypes[2].attributes, ['TARGET_USD']);
    assert.equal(merged.relationshipTypes[0].status, 'new');
    assert.equal(merged.compliance[0].mapsTo, 'threshold');
    const warns = merged.warnings.join('\n');
    assert.ok(warns.includes('FUND_TARGET_MATRIX is a JSON attribute'));
    assert.ok(warns.includes('ORPHAN is placed on entity type NOWHERE'));
    assert.ok(!warns.includes('TARGET_USD is placed'));
    assert.ok(warns.includes('"Sharing ratio" does not say where it runs'));
    const markdown = blueprintMarkdown(merged);
    assert.ok(markdown.includes('## Entity model'));
    assert.ok(markdown.includes('## Compliance mapping'));
  });

  it('records answers, and the recommendation where a question was skipped', () => {
    const understanding = readUnderstanding({
      summary: 'Targets by sleeve',
      questions: [
        { question: 'One target record per node?', options: ['Yes', 'No'], recommended: 'Yes' },
        { id: 'basis', question: 'Percent basis per sleeve or per client?', options: ['Sleeve', 'Client'], recommended: 'Sleeve' },
      ],
    });
    assert.deepEqual(understanding.questions.map((question) => question.id), ['q1', 'basis']);
    assert.deepEqual(decisionsFrom(understanding, { basis: 'Client' }), [
      { question: 'One target record per node?', answer: 'Yes', source: 'assumed' },
      { question: 'Percent basis per sleeve or per client?', answer: 'Client', source: 'admin' },
    ]);
  });

  it('opens a blueprint saved before the entity model existed', () => {
    const old = { ...baselineBlueprint(request, CATALOG) } as Record<string, unknown>;
    for (const key of ['entityTypes', 'relationshipTypes', 'taxonomies', 'compliance', 'computations', 'decisions']) delete old[key];
    const markdown = blueprintMarkdown(normalizeBlueprint(old as unknown as ReturnType<typeof baselineBlueprint>));
    assert.ok(markdown.includes('# Build instructions: Targets'));
  });
});

describe('house kit and redesign', () => {
  const CSS = `@tailwind base;
@layer base { :root { --ink: #0f172a; } body { color: var(--ink); } }
@layer components { .crumbs { display: flex; } .btn.icm-state { color: red; } }
.da-tabs button.on, .home-hero { color: blue; }
.pillar { color: green; }
.rb-seg button:not(.on) .attr-field-filter-count { color: gray; }
@media (max-width: 900px) { .da-facts { display: block; } .home-x { display: none; } }
@keyframes spin { from { opacity: 0; } to { opacity: 1; } }`;

  it('keeps tokens, base rules and house families only', () => {
    const kit = extractHouseKit(CSS);
    assert.ok(kit.includes(':root { --ink: #0f172a; }'));
    assert.ok(kit.includes('body { color: var(--ink); }'));
    assert.ok(kit.includes('.crumbs { display: flex; }'));
    assert.ok(kit.includes('.da-tabs button.on { color: blue; }'));
    assert.ok(kit.includes('@media (max-width: 900px) {\n.da-facts { display: block; }\n}'));
    for (const dropped of ['icm-state', 'home-hero', '.pillar', 'attr-field-filter-count', 'home-x', 'keyframes', '@tailwind']) assert.ok(!kit.includes(dropped), dropped);
  });

  it('puts the kit around a fragment for previews', () => {
    const page = houseDocument('<div class="da">x</div>', '.da { color: red; }');
    assert.ok(page.startsWith('<!doctype html>'));
    assert.ok(page.includes('<style>.da { color: red; }'));
    assert.ok(page.includes('<body><div class="da">x</div></body>'));
  });

  it('reads the HTML and notes from a redesign reply', () => {
    const reply = readRedesignReply('Here it is.\n```html\n<div class="da"><h1>PE</h1></div>\n```\nNOTES:\n- Ribbon is da-ribbon\n- Band bar is x-band');
    assert.deepEqual(reply, { html: '<div class="da"><h1>PE</h1></div>', notes: ['Ribbon is da-ribbon', 'Band bar is x-band'] });
    assert.equal(readRedesignReply('I could not do it.'), null);
  });
});

describe('handoff bundle', () => {
  it('writes a valid stored zip', () => {
    assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
    const zip = zipFiles([{ path: 'a/b.txt', data: 'hello' }, { path: 'c.bin', data: new Uint8Array([1, 2, 3]) }]);
    const view = new DataView(zip.buffer);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    const end = zip.length - 22;
    assert.equal(view.getUint32(end, true), 0x06054b50);
    assert.equal(view.getUint16(end + 10, true), 2);
    assert.equal(new TextDecoder().decode(zip.slice(30 + 7, 30 + 7 + 5)), 'hello');
  });

  it('lays out the brief, blueprint, prototype and each redesigned view', () => {
    const blueprint = baselineBlueprint({ name: 'Mandate Target Manager', description: 'Set targets', placement: 'sdk-surface', html: HTML }, CATALOG);
    blueprint.artifacts = [
      { title: 'Pacing (house design)', purpose: 'p', view: 'Pacing', html: '<div class="da">P</div>', checked: true },
      { title: 'Pacing again', purpose: 'p', view: 'Pacing', html: '<div class="da">Q</div>' },
      { title: 'Described only', purpose: 'p' },
    ];
    const files = handoffFiles({ blueprint, kit: '.da{color:red}', prototypeHtml: HTML, originals: { Pacing: btoa('jpg') } });
    const paths = files.map((file) => file.path);
    const folder = 'docs/surfaces/mandate-target-manager';
    assert.deepEqual(paths, [
      `${folder}/README.md`, `${folder}/build.md`, `${folder}/blueprint.json`, `${folder}/acceptance.js`, `${folder}/prototype.html`,
      `${folder}/views/shared.css`,
      `${folder}/views/pacing.html`, `${folder}/views/pacing.preview.html`, `${folder}/views/pacing.original.jpg`,
      `${folder}/views/pacing-2.html`, `${folder}/views/pacing-2.preview.html`, `${folder}/views/pacing-2.original.jpg`,
    ]);
    const readme = files[0].data as string;
    assert.match(readme, /`views\/pacing-2\.html` \|.*\| no \|/);
    assert.match(readme, /surfaces\/mandate-target-manager\//);
    const byPath = (suffix: string) => files.find((file) => file.path.endsWith(suffix))!.data;
    assert.match(byPath('views/pacing.preview.html') as string, /\.da\{color:red\}/);
    assert.equal(byPath('prototype.html'), HTML);
    assert.equal(handoffFiles({ blueprint, kit: '' }).some((file) => file.path.endsWith('prototype.html')), false);
  });
});

describe('hardened handoff', () => {
  const STRATEGY = `<div class="da"><style>
.x-shell{display:grid;grid-template-columns:204px 1fr}
.x-trio input{width:44px;font-size:12px}
.x-sub{font-size:11px;color:var(--ink-3)}
.x-dot{background:var(--red)}
</style>
<header><button class="btn">Copy CSV</button><button class="btn">+ Add mandate sleeve</button></header>
<strong data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$1.2B</strong>
<small><span data-derived="committed over program">74%</span> committed</small>
<table><thead><tr><th>Level</th><th>2026 target</th></tr></thead><tbody>
<tr><td>Buyout</td><td><div data-attr="FUND_TARGET_MATRIX"><input aria-label="Buyout Dollars min" value="$450M"></div></td><td>$520M</td><td>1.06x</td></tr>
</tbody></table></div>`;
  const PACING = `<div class="da"><style>
.x-shell{display:grid;grid-template-columns:232px 1fr}
.x-dot{background:var(--amber)}
.x-bar{fill:var(--accent-2)}
@media (max-width:900px){.x-shell{grid-template-columns:1fr}}
</style><span data-attr="MYSTERY_CODE">$70M</span><select aria-label="Year"><option>2026</option></select></div>`;

  it('counts what a view binds, and finds the figures it leaves bare', () => {
    const audit = auditView('Strategy', STRATEGY);
    assert.deepEqual(audit.bound, { FUND_TOTAL_COMMITMENTS: 1, FUND_TARGET_MATRIX: 1 });
    assert.equal(audit.derived, 1);
    assert.equal(audit.editable, 1);
    // The input sits inside a bound cell; the two loose cells do not. A column heading is a label, not a figure.
    assert.deepEqual(audit.unbound, ['$520M', '1.06x']);
    assert.deepEqual(audit.controls, ['Copy CSV', '+ Add mandate sleeve', 'Buyout Dollars min']);
    assert.deepEqual(audit.smallText, ['.x-sub']);
    assert.deepEqual(audit.narrowInputs, ['.x-trio input']);
    const findings = auditFindings(audit).join(' ');
    assert.match(findings, /2 figure\(s\) carry neither data-attr nor data-derived/);
    assert.match(findings, /Inputs narrower than 56px/);
  });

  it('finds classes two views define differently, and merges the rest once', () => {
    const audit = auditViews([{ label: 'Strategy', html: STRATEGY }, { label: 'Pacing', html: PACING }], ['FUND_TOTAL_COMMITMENTS', 'FUND_TARGET_MATRIX']);
    assert.deepEqual(audit.conflicts.map((conflict) => conflict.selector).sort(), ['.x-dot', '.x-shell']);
    assert.deepEqual(audit.unknownCodes, ['MYSTERY_CODE']);
    assert.equal((audit.sharedCss.match(/\.x-shell \{/g) || []).length, 1);
    assert.ok(audit.sharedCss.includes('.x-bar { fill:var(--accent-2) }'));
    assert.ok(audit.sharedCss.includes('@media (max-width:900px)'));
    assert.match(audit.sharedCss, /2 class\(es\) are defined differently/);
  });

  it('writes a brief that says what to ask, what to count and how done is measured', () => {
    const blueprint = baselineBlueprint({ name: 'OCIO', description: 'Set targets', placement: 'sdk-surface', html: HTML }, CATALOG);
    blueprint.openQuestions = ['Save on blur, or stage edits for a commit?'];
    blueprint.fields.push({ label: 'Pacing velocity', decision: 'derived' });
    blueprint.artifacts = [
      { title: 'Strategy (house design)', purpose: 'p', view: 'Strategy', html: STRATEGY, checked: true },
      { title: 'Pacing (house design)', purpose: 'p', view: 'Pacing', html: PACING, checked: true },
    ];
    const files = handoffFiles({ blueprint, kit: '' });
    const text = (suffix: string) => files.find((file) => file.path.endsWith(suffix))!.data as string;
    const readme = text('README.md');
    assert.match(readme, /## 1\. Before you write code: ask/);
    assert.match(readme, /1\. Save on blur, or stage edits for a commit\?/);
    assert.match(readme, /names no home for them/);
    assert.match(readme, /`MYSTERY_CODE`, which `build\.md` does not list/);
    assert.match(readme, /\| Strategy \| `views\/strategy\.html` \| 2 \| 1 \| 1 \| 2 \| 3 \| yes \|/);
    assert.match(readme, /Class conflicts[\s\S]*`\.x-dot`: Strategy \/ Pacing/);
    assert.match(readme, /Do not paste the views' `<style>` blocks together/);
    assert.match(readme, /inputs under 56px in `\.x-trio input`/);
    assert.match(readme, /Surface code:\*\* `ocio`/);
    assert.match(readme, /A failing line means the surface is not done/);
    assert.ok(!readme.includes('InspectValue'));
    assert.equal(stopAndAsk(blueprint, null).length, 2);
    assert.match(text('acceptance.js'), /"Strategy": 2/);
    assert.ok(text('views/shared.css').includes('.x-trio input'));
  });

  it('gives each standard its rule, how to meet it here, and what to measure', () => {
    for (const standard of SURFACE_STANDARDS) assert.ok(standard.accept.length > 0, standard.id);
    for (const id of ['legibility', 'one-stylesheet', 'view-fidelity', 'measured-done']) assert.ok(SURFACE_STANDARDS.some((standard) => standard.id === id), id);
    const rightClick = SURFACE_STANDARDS.find((standard) => standard.id === 'right-click-inspect')!;
    assert.match(standardHowTo(rightClick, 'sdk-surface'), /host\.inspectAttribute/);
    assert.match(standardHowTo(rightClick, 'record-tab'), /InspectValue with attrBind/);

    const sdk = baselineBlueprint({ name: 'OCIO', description: 'Set targets', placement: 'sdk-surface', html: HTML }, CATALOG);
    const merged = mergeModelBlueprint(sdk, {
      standards: [
        { id: 'right-click-inspect', note: 'Wrap every metric in InspectValue with attrBind.' },
        { id: 'legibility', note: 'The target grid has three measures of three inputs each.' },
      ],
      buildSteps: [{ title: 'Build', detail: 'Copy surfaces/fund-index.', files: ['surfaces/ocio-target-manager/src/index.tsx', 'apps/web/lib/surface-registry.ts'] }],
      fields: [{ label: 'Pacing velocity', decision: 'derived' }],
    }, CATALOG);
    // A note that tells a client surface to import the app is dropped; the house rule stands.
    assert.ok(!merged.standards.find((finding) => finding.id === 'right-click-inspect')!.note.includes('attrBind'));
    assert.equal(merged.standards.find((finding) => finding.id === 'legibility')!.note, 'The target grid has three measures of three inputs each.');
    assert.deepEqual(merged.buildSteps[0].files, ['surfaces/ocio/src/index.tsx', 'apps/web/lib/surface-registry.ts']);
    assert.ok(merged.warnings.some((warning) => warning.includes('names no calculation')));
    const markdown = blueprintMarkdown({ ...merged, openQuestions: ['Save on blur?'] });
    assert.match(markdown, /## Before you start: ask[\s\S]*- Save on blur\?/);
    assert.match(markdown, /### \[ \] Right-click opens the value/);
    assert.match(markdown, /\*\*Accept:\*\* On every tab, the acceptance script reports 0 figures/);
    assert.match(markdown, /\*\*How:\*\* Call host\.inspectAttribute/);
    assert.match(markdown, /\*\*For this surface:\*\* The target grid has three measures/);
    assert.ok(!markdown.includes('attrBind'));
  });

  it('tells the designer to bind every figure, keep it legible and reuse shared classes', () => {
    const system = designerSystem('.da{}');
    assert.match(system, /data-derived=/);
    assert.match(system, /Never on a table, a row or a wrapper/);
    assert.match(system, /No text below 12px/);
    assert.match(system, /SHARED CLASSES/);
    assert.match(redesignAsk('Pacing', undefined, [], '.x-shell{display:grid}'), /SHARED CLASSES already defined[\s\S]*\.x-shell\{display:grid\}/);
    assert.ok(!redesignAsk('Pacing', undefined, []).includes('SHARED CLASSES'));
    assert.match(checkAsk('Pacing', ['2 figure(s) carry neither data-attr nor data-derived']), /Fix every one:\n- 2 figure/);
    assert.equal(styleBlocks(STRATEGY).includes('.x-trio input{width:44px'), true);
  });

  it('ships an acceptance script that parses', () => {
    const script = acceptanceScript({ root: '.ocio', minBound: { Strategy: 46 } });
    assert.doesNotThrow(() => new Function(`return function () { return ${script.replace(/^\/\/.*$/gm, '').trim().replace(/;$/, '')}; }`));
    for (const check of ['The tab shows data', 'answers right-click', 'clipped in an input', 'No text cut off', 'below 12px', 'row of empty boxes', 'keep their header', 'defined once', 'sideways']) assert.ok(script.includes(check), check);
  });
});

describe('a blueprint that may not be handed off', () => {
  const request = { name: 'OCIO', description: 'Set targets', domainCode: 'FUND', placement: 'sdk-surface' as const, html: HTML };

  it('refuses a JSON attribute: targets are records, one attribute per value', () => {
    const merged = mergeModelBlueprint(baselineBlueprint(request, CATALOG), {
      newAttributes: [{ code: 'FUND_TARGET_MATRIX', name: 'Target matrix', domainCode: 'FUND', dataType: 'JSON' }],
      entityTypes: [{ code: 'FUND', name: 'Fund', status: 'reuse', purpose: 'The fund', attributes: [] }],
    }, CATALOG);
    const blockers = exportBlockers(merged);
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /FUND_TARGET_MATRIX is a JSON attribute[\s\S]*one record per intersection[\s\S]*one attribute per value/);
    assert.throws(() => handoffFiles({ blueprint: merged, kit: '' }), (error: unknown) => error instanceof HandoffBlocked && error.reasons.length === 1);
    assert.match(blueprintMarkdown(merged), /## Do not build from this blueprint/);
  });

  it('refuses a model review that predates the entity model, and passes one that has it', () => {
    const old = { ...baselineBlueprint({ ...request, domainCode: null }, CATALOG), source: 'model' as const };
    assert.match(exportBlockers(old)[0], /earlier version of the builder/);
    const modelled = mergeModelBlueprint(baselineBlueprint(request, CATALOG), {
      entityTypes: [{ code: 'FUND', name: 'Fund', status: 'reuse', purpose: 'The fund', attributes: [] }, { code: 'ALLOCATION_TARGET', name: 'Allocation target', status: 'new', purpose: 'One per fund, hierarchy and level', identity: 'fund, hierarchy, level', attributes: ['TARGET_USD_MIN', 'TARGET_USD', 'TARGET_USD_MAX'] }],
      newAttributes: [{ code: 'TARGET_USD', name: 'Target dollars', domainCode: 'ALLOCATION_TARGET', dataType: 'CURRENCY' }],
    }, CATALOG);
    assert.deepEqual(exportBlockers(modelled), []);
    assert.doesNotThrow(() => handoffFiles({ blueprint: modelled, kit: '' }));
    assert.deepEqual(exportBlockers(baselineBlueprint(request, CATALOG)), []);
  });
});
