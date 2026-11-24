import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Commitment, Deal, Fund, OcioData, Taxonomy } from '@surfaces/ocio/src/lib/types';
import { emptyMatrix } from '@surfaces/ocio/src/lib/types';
import { actualMap, bandStatus, buildTrees, childSums, effUsd, measureStatus } from '@surfaces/ocio/src/lib/tree';
import { pacingOf, yearTarget } from '@surfaces/ocio/src/lib/pacing';
import { profileFor, runAllocation } from '@surfaces/ocio/src/lib/sharing';
import { rulesFromSnapshot, type SnapshotLine } from '@surfaces/ocio/src/lib/compliance';
import { knowledgeArg, shapeData, targetChanges } from '@surfaces/ocio/src/lib/data';
import { summarize } from '@surfaces/ocio/src/lib/summary';
import { buildTabs } from '@surfaces/ocio/src/lib/publish';

const tax: Taxonomy = {
  strategy: [
    { code: 'PE', label: 'Private Equity', parent: null, level: 1 },
    { code: 'BUYOUT', label: 'Buyout', parent: 'PE', level: 2 },
    { code: 'VC', label: 'Venture Capital', parent: 'PE', level: 2 },
  ],
  structure: [
    { code: 'PRIMARY', label: 'Primary', parent: null, level: 1 },
    { code: 'SECONDARY', label: 'Secondary', parent: null, level: 1 },
  ],
  region: [{ code: 'NA', label: 'North America', parent: null, level: 1 }],
  labels: { PE: 'Private Equity', BUYOUT: 'Buyout', VC: 'Venture Capital', PRIMARY: 'Primary', SECONDARY: 'Secondary', NA: 'North America' },
};
const trees = buildTrees(tax);

function fund(id: string, over: Partial<Fund> = {}): Fund {
  return {
    id, code: id, name: id, kind: 'sleeve', parentId: 'client', programUsd: 1_000_000_000, programN: 20, basis: 'PROGRAM',
    annual: 200_000_000, start: '2024-01-01', end: '2029-01-01', overrides: {}, matrix: emptyMatrix(), targets: {}, currency: 'USD', eligible: true, ...over,
  };
}

function commitment(id: string, sleeveId: string, amount: number, date: string, st = 'BUYOUT'): Commitment {
  return {
    id, code: id, name: id, sleeveId, amount, date, currency: 'USD', allocationYear: `${date.slice(0, 4)} Allocation`, followOn: false,
    contractual: 'Cleared', esg: 'Compliant', strategyReview: 'Pass', securityId: `s-${id}`, asset: id, manager: 'M',
    tags: { cat: 'PRIMARY', ac: 'PE', st, sub: null, rg: 'NA', ty: null, det: null },
    investmentType: 'Primary Fund', market: 'US', country: 'None', geo: 'US', sector: 'Industrials', fundSize: null, firstTime: false,
    relationship: 'Third Party', listed: false, fof: false, vintage: date.slice(0, 4),
  };
}

describe('OCIO target math', () => {
  it('builds the strategy tree as category, asset class and strategy', () => {
    assert.deepEqual(trees.roots.strategy.children.map((n) => n.key), ['PRIMARY', 'SECONDARY']);
    assert.ok(trees.nodes.strategy['PRIMARY/PE/BUYOUT']);
    assert.ok(trees.nodes.region['NA/PE']);
  });

  it('reads a percent target against the level above on the parent basis', () => {
    const f = fund('a', { basis: 'PARENT_LEVEL' });
    f.matrix.strategy['PRIMARY'] = { usd: 600_000_000 };
    f.matrix.strategy['PRIMARY/PE'] = { pct: 50 };
    assert.equal(effUsd(f, 'strategy', trees.nodes.strategy['PRIMARY/PE']), 300_000_000);
    assert.equal(effUsd(fund('b', { matrix: { ...emptyMatrix(), strategy: { 'PRIMARY/PE': { pct: 50 } } } }), 'strategy', trees.nodes.strategy['PRIMARY/PE']), 500_000_000);
  });

  it('judges a band below its min, in range and above its max', () => {
    assert.equal(bandStatus(5, 10, 20, 30).cls, 'below');
    assert.equal(bandStatus(15, 10, 20, 30).cls, 'in');
    assert.equal(bandStatus(20, 10, 20, 30).cls, 'at');
    assert.equal(bandStatus(31, 10, 20, 30).cls, 'above');
    assert.equal(bandStatus(5, null, null, null).cls, 'none');
  });

  it('measures actuals at every level a commitment counts toward', () => {
    const f = fund('a');
    f.matrix.strategy['PRIMARY'] = { usdMax: 100_000_000 };
    const A = actualMap([commitment('c1', 'a', 80_000_000, '2025-01-01'), commitment('c2', 'a', 40_000_000, '2025-02-01', 'VC')], 'strategy');
    assert.equal(A['PRIMARY'].usd, 120_000_000);
    assert.equal(A['PRIMARY/PE/VC'].n, 1);
    assert.equal(measureStatus(f, 'strategy', trees.nodes.strategy['PRIMARY'], A, 'usd').st.cls, 'above');
  });

  it('compares the next level’s targets with the row', () => {
    const f = fund('a');
    f.matrix.strategy['PRIMARY'] = { usd: 400_000_000 };
    f.matrix.strategy['PRIMARY/PE'] = { usd: 300_000_000 };
    const [s] = childSums(f, 'strategy', trees.nodes.strategy['PRIMARY']);
    assert.equal(s.sym, '$');
    assert.equal(s.tone, 'under');
  });

});

describe('OCIO targets are records, one attribute per value', () => {
  const empty = { edges: [] };
  const target = (id: string, hierarchy: string, level: string, values: Record<string, unknown>) => ({
    node: {
      id, entityCode: id, entityName: `Sleeve · ${hierarchy} · ${level}`,
      attributes: { OCIO_TARGET_HIERARCHY: hierarchy, OCIO_TARGET_LEVEL: level, ...values },
      childRelationships: [{ childEntityId: 'f1', relationshipCode: 'OCIO_TARGET_FUND' }],
    },
  });

  it('reads each minimum, target and maximum from its own attribute on the level’s record', () => {
    const data = shapeData({
      funds: { edges: [{ node: { id: 'f1', entityCode: 'F1', entityName: 'Sleeve', attributes: { OCIO_TARGET_PERCENT_BASIS: 'PROGRAM', FUND_TOTAL_COMMITMENTS: '1000' }, parentRelationships: [] } }] },
      targets: { edges: [
        target('t1', 'STRATEGY', 'PRIMARY/PE', { OCIO_TARGET_USD_MIN: '5', OCIO_TARGET_PCT: { value: '40', value_numeric: 40 } }),
        target('t2', 'PROGRAM', 'TOTAL', { OCIO_TARGET_COUNT_MAX: '30' }),
        target('t3', 'YEAR', '2027', { OCIO_TARGET_USD: '150000000' }),
        target('t4', 'REGION', 'NA', {}),
        target('t5', 'UNKNOWN', 'X', { OCIO_TARGET_USD: '1' }),
      ] },
      positions: empty, securities: empty, deals: empty, tranches: empty, plans: empty,
      strategyList: null, structureList: null, regionList: null, stageList: null,
    } as Parameters<typeof shapeData>[0]);
    const [f] = data.funds;
    assert.deepEqual(f.matrix.strategy, { 'PRIMARY/PE': { usdMin: 5, pct: 40 } });
    assert.deepEqual(f.matrix.program, { nMax: 30 });
    assert.deepEqual(f.overrides, { 2027: 150_000_000 });
    // A level whose record holds no value yet is not a target, but its record is known so the next edit reuses it.
    assert.deepEqual(f.matrix.region, {});
    assert.equal(f.targets['region|NA'].id, 't4');
    assert.equal(f.targets['strategy|PRIMARY/PE'].id, 't1');
    assert.equal(f.targets['program|'].id, 't2');
    assert.equal(f.targets['year|2027'].id, 't3');
  });

  it('a fund belongs to the surface when it has a percent basis, not a stored document', () => {
    const data = shapeData({
      funds: { edges: [{ node: { id: 'x', entityCode: 'X', entityName: 'Not OCIO', attributes: { FUND_TOTAL_COMMITMENTS: '1' }, parentRelationships: [] } }] },
      targets: empty, positions: empty, securities: empty, deals: empty, tranches: empty, plans: empty,
      strategyList: null, structureList: null, regionList: null, stageList: null,
    } as Parameters<typeof shapeData>[0]);
    assert.equal(data.funds.length, 0);
  });

  it('saves only the values that changed', () => {
    const before = fund('a', { overrides: { 2026: 100 } });
    before.matrix.program = { usdMin: 1 };
    before.matrix.strategy['PRIMARY'] = { usd: 400, pct: 40 };
    before.matrix.strategy['PRIMARY/PE'] = { n: 3 };
    const after = structuredClone(before);
    after.matrix.strategy['PRIMARY'] = { usd: 500, pct: 40 };
    delete after.matrix.strategy['PRIMARY/PE'];
    after.matrix.region['NA'] = { pctMax: 70 };
    after.overrides = { 2027: 150 };
    assert.deepEqual(targetChanges(before, after), [
      { scope: 'strategy', level: 'PRIMARY', field: 'usd', value: 500 },
      { scope: 'strategy', level: 'PRIMARY/PE', field: 'n', value: null },
      { scope: 'region', level: 'NA', field: 'pctMax', value: 70 },
      { scope: 'year', level: '2026', field: 'usd', value: null },
      { scope: 'year', level: '2027', field: 'usd', value: 150 },
    ]);
    assert.deepEqual(targetChanges(before, before), []);
  });
});

describe('OCIO pacing', () => {
  it('prorates the first year and honours a year override', () => {
    const asOf = new Date(2026, 5, 30);
    const f = fund('a', { start: '2024-07-01', overrides: { 2025: 150_000_000 } });
    assert.ok(Math.abs(yearTarget(f, 2024, asOf) - 100_546_448) < 50_000);
    assert.equal(yearTarget(f, 2025, asOf), 150_000_000);
    assert.equal(yearTarget(f, 2026, asOf), 200_000_000);
  });

  it('ignores commitments after the As Of date', () => {
    const asOf = new Date(2026, 0, 31);
    const p = pacingOf(fund('a'), [commitment('c1', 'a', 10_000_000, '2026-01-10'), commitment('c2', 'a', 10_000_000, '2026-03-01')], asOf);
    assert.equal(p.count, 1);
    assert.equal(p.current?.deployed, 10_000_000);
  });
});

describe('OCIO sharing ratios', () => {
  const deal: Deal = {
    ...commitment('d', 'none', 0, '2026-12-01'), id: 'deal', code: 'D', name: 'Deal', stage: 'ALLOCATION', close: '2026-12-01', description: null, size: 1e9,
    tranches: [{ id: 't1', name: 'Commitment', hold: 30_000_000, size: 1e9, rank: 1 }], plans: [],
  } as Deal;
  const asOf = new Date(2026, 10, 1);

  it('splits the hold by annual need and fills a capped sleeve to its capacity first', () => {
    const a = fund('a');
    const b = fund('b');
    a.matrix.strategy['PRIMARY/PE/BUYOUT'] = { usd: 300_000_000 };
    b.matrix.strategy['PRIMARY/PE/BUYOUT'] = { usd: 100_000_000 };
    const all = { funds: [a, b], commitments: [] as Commitment[] };
    const pa = profileFor(a, deal, all.funds, all.commitments, trees, asOf, false);
    const pb = profileFor(b, deal, all.funds, all.commitments, trees, asOf, false);
    const open = runAllocation(deal, [{ fund: a, profile: pa, engineCap: null, bindingRule: null, headroom: null }, { fund: b, profile: pb, engineCap: null, bindingRule: null, headroom: null }], {});
    assert.equal(Math.round(open.rows[0].ratio * 100), 75);
    assert.equal(Math.round(open.allocated), 30_000_000);
    const capped = runAllocation(deal, [{ fund: a, profile: pa, engineCap: 5_000_000, bindingRule: 'LIMIT', headroom: null }, { fund: b, profile: pb, engineCap: null, bindingRule: null, headroom: null }], {});
    assert.equal(Math.round(capped.rows[0].total), 5_000_000);
    assert.equal(Math.round(capped.rows[1].total), 25_000_000);
    assert.equal(capped.rows[0].binding, 'LIMIT');
  });

  it('leaves out a sleeve with no target for the profile', () => {
    const p = profileFor(fund('c'), deal, [fund('c')], [], trees, asOf, false);
    assert.equal(p.eligible, false);
    assert.equal(p.reason, 'No target for this profile');
  });
});

describe('OCIO compliance results', () => {
  const line = (over: Partial<SnapshotLine>): SnapshotLine => ({
    ruleCode: 'R', ruleName: 'Rule', groupByValue: null, limitDirection: 'MAX', numeratorValue: null, denominatorValue: null,
    computedValue: 1, softLimitValue: null, hardLimitValue: 10, status: 'PASS', resultUnit: 'PERCENTAGE', ...over,
  });

  it('ranks the worst group and marks a near-limit pass as watch', () => {
    const [r] = rulesFromSnapshot([line({ groupByValue: 'A', computedValue: 9.5 }), line({ groupByValue: 'B', computedValue: 2 })], new Map());
    assert.equal(r.status, 'watch');
    assert.equal(r.worst, 'A');
  });

  it('reads an open attestation as pending, not a breach', () => {
    const meta = new Map([['R', { ruleCode: 'R', ruleName: 'ESG', description: null, category: 'OTHER', attestation: true, dimension: null }]]);
    const [r] = rulesFromSnapshot([line({ status: 'SOFT_BREACH', softLimitValue: 0, hardLimitValue: null, computedValue: 1, resultUnit: 'COUNT' })], meta);
    assert.equal(r.status, 'pending');
  });
});

describe('OCIO knowledge date', () => {
  it('reads a past day as the end of that day and today as now', () => {
    assert.equal(knowledgeArg('2020-01-31'), '2020-01-31T23:59:59.999Z');
    assert.equal(knowledgeArg(new Date().toISOString().slice(0, 10)), null);
    assert.equal(knowledgeArg('2020-01-31T10:00'), '2020-01-31T10:00');
    assert.equal(knowledgeArg(''), null);
  });
});

describe('OCIO tabs for the assistant', () => {
  const keys = ['strategy', 'region', 'structure', 'pacing', 'commitments', 'compliance', 'overview', 'pipeline'];

  it('publishes every tab with null data before anything loads', () => {
    const tabs = buildTabs({ open: null, summaries: [], data: null, trees: null, asOf: new Date(), complianceLoaded: false });
    assert.deepEqual(Object.keys(tabs).sort(), [...keys].sort());
    for (const k of keys) {
      assert.equal(tabs[k as keyof typeof tabs].data, null);
      assert.ok(tabs[k as keyof typeof tabs].label && tabs[k as keyof typeof tabs].purpose);
    }
  });

  it('fills every tab once loaded, and compliance only once it is scored', () => {
    const client = fund('client', { kind: 'client', parentId: null });
    const a = fund('a');
    a.matrix.strategy['PRIMARY'] = { usd: 500_000_000 };
    const data: OcioData = { funds: [client, a], commitments: [commitment('c1', 'a', 50_000_000, '2025-03-01')], deals: [], taxonomy: tax, stages: [] };
    const asOf = new Date(2026, 5, 30);
    const summaries = data.funds.map((f) => summarize(f, data, trees, asOf, null));
    const tabs = buildTabs({ open: summaries[1], summaries, data, trees, asOf, complianceLoaded: false });
    for (const k of keys.filter((x) => x !== 'compliance')) assert.ok(tabs[k as keyof typeof tabs].data, k);
    assert.equal(tabs.compliance.data, null);
    assert.equal((tabs.strategy.data as { targetsAssigned: number }).targetsAssigned, 1);
  });
});
