import { describe, expect, it } from 'vitest';
import {
  applyMeasures,
  blocksToMarkdown,
  collapseGapColumns,
  compileExpression,
  evaluateScenarios,
  evaluateScreens,
  narrativeSections,
  narrativeSystemPrompt,
  normalizeBlocks,
  resolveAsOfSet,
  sectionRunOrder,
  sectionUserPrompt,
  shiftDate,
  splitBatches,
  validateNarrativeSpec,
  verifyBlocks,
  type NarrativeSection,
} from './narrative-spec';

const run = (src: string, vars: Record<string, unknown> = {}) => compileExpression(src).run(vars);

describe('expressions', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('-A / 4', { A: 8 })).toBe(-2);
  });

  it('makes arithmetic null and comparisons false when an input is missing', () => {
    expect(run('(CURRENT - LEVEL) / LEVEL', { CURRENT: 5 })).toBeNull();
    expect(run('CUSHION < 0.15', { CUSHION: null })).toBe(false);
    expect(run('1 / 0')).toBeNull();
  });

  it('supports logic, strings, and functions', () => {
    expect(run("STATUS == 'PIK' || MARK < 90", { STATUS: 'PIK', MARK: 99 })).toBe(true);
    expect(run('if(A > 1, 10, 20)', { A: 2 })).toBe(10);
    expect(run('coalesce(A, B, 3)', { B: null })).toBe(3);
    expect(run('round(2.456, 1)')).toBe(2.5);
    expect(run('isnull(A)', {})).toBe(true);
    expect(run('sec.INDUSTRY == "Software"', { 'sec.INDUSTRY': 'Software' })).toBe(true);
  });

  it('rejects bad syntax and unknown functions when compiled', () => {
    expect(() => compileExpression('1 +')).toThrow();
    expect(() => compileExpression('evil(1)')).toThrow(/Unknown function/);
    expect(() => compileExpression('A $ B')).toThrow();
  });

  it('lists the variables an expression reads', () => {
    expect(compileExpression('A / B + abs(C)').variables.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('dates', () => {
  it('shifts back by years, quarters, and months and clamps the day', () => {
    expect(shiftDate('2026-09-30', { quarters: 1 })).toBe('2026-06-30');
    expect(shiftDate('2026-05-31', { months: 3 })).toBe('2026-02-28');
    expect(shiftDate('2026-03-15', { years: 1 })).toBe('2025-03-15');
  });

  it('resolves comparisons and flags an unknown inception date', () => {
    const set = resolveAsOfSet(
      [{ label: 'Current' }, { label: '1 year ago', offset: { years: 1 } }, { label: 'Inception', param: 'inceptionDate' }],
      '2026-09-30',
      {},
    );
    expect(set.map((s) => s.date)).toEqual(['2026-09-30', '2025-09-30', null]);
    expect(set[2].reason).toMatch(/inceptionDate/);
    const known = resolveAsOfSet([{ label: 'Inception', param: 'inceptionDate' }], '2026-09-30', { inceptionDate: '2021-04-01' });
    expect(known[0].date).toBe('2021-04-01');
  });
});

describe('sections', () => {
  const section = (key: string, dependsOn?: string[]): NarrativeSection => ({
    key, title: key, instructions: 'x', blocks: [{ type: 'markdown', key: 'a' }], dependsOn,
  });

  it('runs dependencies first and keeps the listed order otherwise', () => {
    expect(sectionRunOrder([section('summary', ['a', 'b']), section('a'), section('b', ['a'])])).toEqual(['a', 'b', 'summary']);
  });

  it('rejects a loop and an unknown dependency', () => {
    expect(() => sectionRunOrder([section('a', ['b']), section('b', ['a'])])).toThrow(/loop/);
    expect(() => sectionRunOrder([section('a', ['zzz'])])).toThrow(/unknown/);
  });

  it('wraps a legacy template as one section', () => {
    const s = narrativeSections({ narrativeName: 'Old', instructions: 'Do it', dataQueries: [], outputBlocks: [{ type: 'markdown', key: 'summary' }] });
    expect(s).toHaveLength(1);
    expect(s[0].instructions).toBe('Do it');
  });

  it('validates blocks, expressions, and references', () => {
    const errors = validateNarrativeSpec({
      sections: [{
        key: 'one', title: 'One', instructions: 'x',
        blocks: [{ type: 'markdown', key: 'a' }, { type: 'nope' as any, key: 'a' }],
        dataQueries: [{ key: 'q', start: 'DOMAIN' }],
        measures: [{ query: 'missing', alias: 'm', expr: '1 +' }],
        screens: [{ key: 's', label: 'S', query: 'q', when: 'A <', severity: 'high' }],
      }],
    });
    expect(errors.join('\n')).toMatch(/unknown block type/);
    expect(errors.join('\n')).toMatch(/unknown query "missing"/);
    expect(errors.join('\n')).toMatch(/screen s/);
  });

  it('keeps a monthly series of 13 dates and rejects more instead of dropping them', () => {
    const months = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? { label: 'Current' } : { label: `${i} months ago`, offset: { months: i } }));
    const dates = resolveAsOfSet(months(13), '2026-11-21');
    expect(dates).toHaveLength(13);
    expect(dates[12].date).toBe('2025-11-21');
    const section = { key: 'one', title: 'One', instructions: 'x', blocks: [{ type: 'kpis' as const, key: 'k' }] };
    expect(validateNarrativeSpec({ sections: [{ ...section, comparisons: months(13) }] })).toEqual([]);
    expect(validateNarrativeSpec({ sections: [{ ...section, comparisons: months(14) }] }).join(' ')).toMatch(/at most 13 comparison dates/);
  });

  it('accepts a well-formed section', () => {
    expect(validateNarrativeSpec({
      sections: [{
        key: 'one', title: 'One', instructions: 'x', blocks: [{ type: 'kpis', key: 'k' }],
        dataQueries: [{ key: 'q', start: 'DOMAIN' }],
        measures: [{ query: 'q', alias: 'cushion', expr: '(A - B) / B' }],
        screens: [{ key: 's', label: 'Thin', query: 'q', when: 'cushion < 0.15', severity: 'high' }],
        scenarios: [{ key: 'up', label: '+100bps', query: 'q', expr: 'FLOAT * MV * shock', agg: 'SUM', params: { shock: 0.01 } }],
      }],
    })).toEqual([]);
  });

  it('batches rows', () => {
    expect(splitBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('measures, screens, scenarios', () => {
  const rows = [
    { entity_name: 'Acme', COVENANT_CURRENT: 4.0, COVENANT_LEVEL: 5.0, MV: 100, FLOAT: 1 },
    { entity_name: 'Beta', COVENANT_CURRENT: 4.9, COVENANT_LEVEL: 5.0, MV: 300, FLOAT: 1 },
    { entity_name: 'Gamma', COVENANT_CURRENT: null, COVENANT_LEVEL: 5.0, MV: 50, FLOAT: 0 },
  ];

  it('adds a derived column and leaves a gap null, not zero', () => {
    const { rows: out } = applyMeasures(rows, [{ query: 'q', alias: 'cushion', expr: '(COVENANT_LEVEL - COVENANT_CURRENT) / COVENANT_LEVEL' }]);
    expect(out[0].cushion).toBeCloseTo(0.2);
    expect(out[1].cushion).toBeCloseTo(0.02);
    expect(out[2].cushion).toBeNull();
  });

  it('flags rows by a test and reports the ones it could not test', () => {
    const { rows: withCushion } = applyMeasures(rows, [{ query: 'q', alias: 'cushion', expr: '(COVENANT_LEVEL - COVENANT_CURRENT) / COVENANT_LEVEL' }]);
    const { results } = evaluateScreens({ q: withCushion }, [{ key: 'thin', label: 'Cushion under 15%', query: 'q', when: 'cushion < 0.15', severity: 'high' }]);
    expect(results[0].flaggedCount).toBe(1);
    expect(results[0].flagged[0].entity_name).toBe('Beta');
    expect(results[0].notEvaluable).toBe(1);
  });

  it('runs a what-if over every row, or only the largest few', () => {
    const { results } = evaluateScenarios({ q: rows }, [
      { key: 'up', label: '+100bps', query: 'q', expr: 'FLOAT * MV * shock', agg: 'SUM', params: { shock: 0.01 } },
      { key: 'stress', label: 'Two largest stop paying', query: 'q', expr: 'MV', agg: 'SUM', rankBy: 'MV', top: 2 },
    ]);
    expect(results[0].value).toBeCloseTo(4);
    expect(results[1].value).toBe(400);
    expect(results[1].names).toEqual(['Beta', 'Acme']);
  });
});

describe('blocks', () => {
  it('normalizes every block type and drops unsafe urls', () => {
    const blocks = normalizeBlocks({
      blocks: [
        { type: 'markdown', key: 'a', text: 'Hello' },
        { type: 'scorecard', key: 'b', columns: ['Name', 'Status'], rows: [['A', 'Watchlist']], statusColumn: 'Status' },
        { type: 'kpis', key: 'c', items: [{ label: 'IRR', value: '12.1%', trend: 'up' }, { label: '', value: 'x' }] },
        { type: 'chart', key: 'd', chartType: 'waterfall', labels: ['a', 'b'], series: [{ name: 'NAV', values: [1, '2'] }], totals: [1, -3] },
        { type: 'callouts', key: 'e', items: [{ title: 'Name', severity: 'high', fields: [{ label: 'Action', value: 'Engage' }] }] },
        { type: 'sources', key: 'f', items: [{ title: 'News', url: 'javascript:alert(1)' }, { title: 'Ok', url: 'https://example.com/x' }] },
        { type: 'mystery', key: 'g' },
      ],
    });
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'scorecard', 'kpis', 'chart', 'callouts', 'sources']);
    expect((blocks[1] as any).statusColumn).toBe('Status');
    expect((blocks[2] as any).items).toHaveLength(1);
    expect((blocks[3] as any).totals).toEqual([1]);
    expect((blocks[5] as any).items[0].url).toBeUndefined();
    expect((blocks[5] as any).items[1].url).toBe('https://example.com/x');
  });

  it('drops blocks with nothing to show instead of rendering empty frames', () => {
    const blocks = normalizeBlocks([
      { type: 'chart', key: 'a', chartType: 'waterfall', labels: [], series: [] },
      { type: 'chart', key: 'b', chartType: 'bar', labels: ['x'], series: [{ name: 's', values: [1] }] },
      { type: 'kpis', key: 'c', items: [] },
      { type: 'table', key: 'd', columns: ['A'], rows: [] },
      { type: 'markdown', key: 'e', text: '   ' },
      { type: 'markdown', key: 'f', text: 'Kept' },
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['b', 'f']);
  });

  it('collapses rows that are only gaps into one line, keeping rows that have data', () => {
    const blocks = normalizeBlocks([
      {
        type: 'table', key: 'metrics', columns: ['Metric', 'Now', 'Last year'],
        rows: [['NAV', 1164561112.67, 'data not available'], ['Spread', 'data not available', 'Data not available: no spread field'], ['LTV', '', 'data not available']],
      },
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['metrics', 'metrics_gaps']);
    expect((blocks[0] as any).rows).toHaveLength(1);
    expect((blocks[1] as any).text).toBe('**Data not available:** Spread; LTV.');
  });

  it('leaves only the gap line when a table has no data at all', () => {
    const blocks = normalizeBlocks([
      { type: 'table', key: 't', columns: ['Name', 'Value'], rows: [['A', 'data not available'], ['B', 'data not available']] },
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['t_gaps']);
  });

  it('removes columns that are empty for every row, once the whole set is known', () => {
    const blocks = collapseGapColumns(normalizeBlocks([
      {
        type: 'scorecard', key: 'sc', statusColumn: 'Status', columns: ['Company', 'Sponsor', 'Exposure', 'Coverage', 'Status'],
        rows: [['A', 'data not available', 100, 'data not available', 'data not available'], ['B', '', 50, 'data not available', 'Watchlist']],
      },
    ]));
    const card = blocks[0] as any;
    expect(card.columns).toEqual(['Company', 'Exposure', 'Status']);
    expect(card.rows).toEqual([['A', 100, 'data not available'], ['B', 50, 'Watchlist']]);
    expect(card.statusColumn).toBe('Status');
    expect((blocks[1] as any).text).toBe('**Not available for any row:** Sponsor; Coverage.');
  });

  it('keeps a table whole when every column has some data, and drops one that has nothing left', () => {
    const full = collapseGapColumns(normalizeBlocks([{ type: 'table', key: 't', columns: ['A', 'B', 'C'], rows: [['x', 1, 2]] }]));
    expect(full).toHaveLength(1);
    const empty = collapseGapColumns(normalizeBlocks([
      { type: 'table', key: 'u', columns: ['A', 'B', 'C'], rows: [['x', 'data not available', 'data not available'], ['y', 1, 'data not available']] },
    ]));
    expect((empty[0] as any).columns).toEqual(['A', 'B']);
    const none = collapseGapColumns([{ type: 'table', key: 'v', columns: ['A', 'B', 'C'], rows: [['x', '', ''], ['y', '', '']] }]);
    expect(none.map((b) => b.type)).toEqual(['markdown']);
  });

  it('asks for every named subject when a coverage list is given', () => {
    const prompt = sectionUserPrompt({
      section: { key: 's', title: 'S', instructions: 'x', blocks: [{ type: 'table', key: 't' }] },
      params: {}, asOfDate: '2026-09-30', evidence: {}, mustCover: ['Issuer 1', 'Issuer 2'],
    });
    expect(prompt).toContain('# Coverage');
    expect(prompt).toContain('Issuer 1; Issuer 2');
  });

  it('tells the composer not to invent statuses or facts about the manager', () => {
    const system = narrativeSystemPrompt({ narrativeName: 'x' });
    expect(system).toMatch(/Never assign a status/);
    expect(system).toMatch(/Do not invent facts about the manager/);
  });

  it('exports markdown', () => {
    const md = blocksToMarkdown(normalizeBlocks([
      { type: 'markdown', key: 'a', title: 'Lead', text: 'Hello' },
      { type: 'table', key: 'b', columns: ['A', 'B'], rows: [['x', 1500]] },
    ]));
    expect(md).toContain('#### Lead');
    expect(md).toContain('| x | 1,500 |');
  });
});

describe('verification', () => {
  const evidence = [{ rows: [{ MARKET_VALUE: 15650000000, share: 0.343, spread: 6.5 }, { MARKET_VALUE: 400000000 }], matched: 6203 }];

  it('traces rounded and scaled figures to the evidence', () => {
    const blocks = normalizeBlocks([
      { type: 'markdown', key: 'a', text: 'Exposure is $15.65B across 6,203 positions, 34.3% in software at a 6.5x spread, $400M largest.' },
    ]);
    const v = verifyBlocks(blocks, evidence);
    expect(v.unmatched).toEqual([]);
    expect(v.matched).toBe(v.checked);
  });

  it('flags a figure that is not in the evidence', () => {
    const blocks = normalizeBlocks([{ type: 'markdown', key: 'a', text: 'Net IRR is 14.2% and exposure is $15.65B.' }]);
    const v = verifyBlocks(blocks, evidence);
    expect(v.unmatched.map((u) => u.figure)).toEqual(['14.2%']);
  });

  it('treats the day in a written date as a date, not a figure', () => {
    const blocks = normalizeBlocks([
      { type: 'markdown', key: 'a', text: 'As of November 13, 2026 and again on 13 November 2026, exposure is $400M.' },
    ]);
    const v = verifyBlocks(blocks, evidence);
    expect(v.unmatched).toEqual([]);
    expect(v.checked).toBe(1);
  });

  it('reads a thousands-separated figure whole and ignores a trailing comma', () => {
    const blocks = normalizeBlocks([{ type: 'markdown', key: 'a', text: 'We hold 6,203 positions, and $1,164,561,112.67 of NAV.' }]);
    const v = verifyBlocks(blocks, [{ matched: 6203, nav: 1164561112.67 }]);
    expect(v.unmatched).toEqual([]);
    expect(v.checked).toBe(2);
  });

  it('allows numbers that came from the instructions, and ignores years and small counts', () => {
    const blocks = normalizeBlocks([{ type: 'markdown', key: 'a', text: 'In 2026 we flag cushion under 15% on 3 names.' }]);
    expect(verifyBlocks(blocks, [], ['Flag cushion under 15%']).unmatched).toEqual([]);
  });
});
