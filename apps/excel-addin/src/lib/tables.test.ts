import { describe, expect, it, vi } from 'vitest';
import {
  gridInput,
  isReference,
  kindForDataType,
  MAX_TABLE_ROWS,
  PAGE_SIZE,
  parseRange,
  planBody,
  planColumns,
  rangesIntersect,
  readAllRows,
  referenceKey,
  referencesOf,
  RefreshScheduler,
  resolveFilters,
  rowsToCells,
  tableNameFor,
  columnFormats,
  type FieldKind,
  type TableColumn,
} from './tables';

const kinds = new Map<string, FieldKind>([['FUND', 'text'], ['AUM', 'num'], ['MATURITY', 'date'], ['ACTIVE', 'bool'], ['entity_code', 'text']]);

describe('references', () => {
  it('reads cells and ranges, on this sheet or another', () => {
    expect(parseRange('=B2', 'Grid')).toEqual({ sheet: 'Grid', top: 1, left: 1, bottom: 1, right: 1 });
    expect(parseRange("='Q3 inputs'!$B$2:$C$9")).toEqual({ sheet: 'Q3 inputs', top: 1, left: 1, bottom: 8, right: 2 });
    expect(parseRange('=SUM(A1)')).toBeNull();
  });

  it('only treats text starting with "=" as a reference, so a code like AB12 stays a code', () => {
    expect(isReference('=AB12')).toBe(true);
    expect(isReference('AB12')).toBe(false);
  });

  it('knows when an edit touches a filter cell', () => {
    const filter = parseRange('=Inputs!B2:B5') as NonNullable<ReturnType<typeof parseRange>>;
    expect(rangesIntersect(filter, parseRange('B4', 'Inputs')!)).toBe(true);
    expect(rangesIntersect(filter, parseRange('A1:A9', 'Inputs')!)).toBe(false);
    expect(rangesIntersect(filter, parseRange('B4', 'Other')!)).toBe(false);
  });

  it('lists each reference once', () => {
    expect(referencesOf({ filters: [{ field: 'FUND', op: 'eq', value: '=Inputs!B2' }, { field: 'AUM', op: 'gt', value: '100' }, { field: 'FUND', op: 'neq', value: '=Inputs!B2' }], asOf: '=Inputs!B1' }))
      .toEqual(['Inputs!B2', 'Inputs!B1']);
  });
});

describe('resolveFilters', () => {
  it('types literal values by the field', () => {
    const resolved = resolveFilters({
      filters: [
        { field: 'AUM', op: 'gt', value: '1,000,000' },
        { field: 'MATURITY', op: 'between', value: '2026-01-01, 2026/12/31' },
        { field: 'entity_code', op: 'in', value: 'FUND-1; FUND-2' },
        { field: 'ACTIVE', op: 'eq', value: 'yes' },
        { field: 'FUND', op: 'eq', value: 'Smith, Jones & Co' },
        { field: 'FUND', op: 'notNull', value: '' },
      ],
      asOf: '2026-09-30',
    }, new Map(), kinds);
    expect(resolved).toMatchObject({
      ok: true,
      asOfDate: '2026-09-30',
      filters: [
        { field: 'AUM', op: 'gt', value: 1000000 },
        { field: 'MATURITY', op: 'between', value: ['2026-01-01', '2026-12-31'] },
        { field: 'entity_code', op: 'in', value: ['FUND-1', 'FUND-2'] },
        { field: 'ACTIVE', op: 'eq', value: true },
        { field: 'FUND', op: 'eq', value: 'Smith, Jones & Co' },
        { field: 'FUND', op: 'notNull' },
      ],
    });
  });

  it('reads cell values, including date cells and a list in a range', () => {
    const cells = new Map<string, unknown[][]>([
      [referenceKey('=Inputs!B1'), [[46295]]],
      [referenceKey('=Inputs!B2:B4'), [['FUND-1'], [''], ['FUND-3']]],
      [referenceKey('=Inputs!C1'), [[0.075]]],
    ]);
    const resolved = resolveFilters({
      filters: [{ field: 'entity_code', op: 'in', value: '=Inputs!B2:B4' }, { field: 'AUM', op: 'gte', value: '=Inputs!C1' }],
      asOf: '=Inputs!$B$1',
    }, cells, kinds);
    expect(resolved).toMatchObject({ ok: true, asOfDate: '2026-09-30', filters: [{ value: ['FUND-1', 'FUND-3'] }, { value: 0.075 }] });
  });

  it('drops a filter whose value is blank, so clearing a filter cell widens the table', () => {
    const resolved = resolveFilters({ filters: [{ field: 'FUND', op: 'eq', value: '=Inputs!B2' }, { field: 'AUM', op: 'gt', value: '' }], asOf: '' },
      new Map([[referenceKey('Inputs!B2'), [['']]]]), kinds);
    expect(resolved).toMatchObject({ ok: true, filters: [], asOfDate: null });
  });

  it('says which filter is wrong', () => {
    expect(resolveFilters({ filters: [{ field: 'AUM', op: 'gt', value: 'lots' }], asOf: '' }, new Map(), kinds, new Map([['AUM', 'Assets']])))
      .toEqual({ ok: false, message: 'Assets: "lots" is not a number.' });
    expect(resolveFilters({ filters: [{ field: 'AUM', op: 'between', value: '5' }], asOf: '' }, new Map(), kinds)).toMatchObject({ ok: false });
    expect(resolveFilters({ filters: [], asOf: 'soon' }, new Map(), kinds)).toMatchObject({ ok: false });
  });

  it('gives the same signature for the same question, and a different one when a filter cell changes', () => {
    const definition = { filters: [{ field: 'FUND', op: 'eq' as const, value: '=B2' }], asOf: '' };
    const one = resolveFilters(definition, new Map([[referenceKey('B2'), [['A']]]]), kinds);
    const again = resolveFilters(definition, new Map([[referenceKey('B2'), [['A']]]]), kinds);
    const changed = resolveFilters(definition, new Map([[referenceKey('B2'), [['B']]]]), kinds);
    expect(one.ok && again.ok && one.signature === again.signature).toBe(true);
    expect(one.ok && changed.ok && one.signature !== changed.signature).toBe(true);
  });
});

describe('the query', () => {
  const columns: TableColumn[] = [{ code: 'entity_code', label: 'Code', kind: 'text' }, { code: 'AUM', label: 'AUM', kind: 'num' }, { code: 'MATURITY', label: 'Maturity', kind: 'date' }];

  it('asks for the columns, filters and as-of, sorted so paging is stable', () => {
    expect(gridInput({ domainCode: 'FUND', columns, sort: [{ field: 'AUM', dir: 'desc' }] }, { filters: [{ field: 'AUM', op: 'gt', value: 0 }], asOfDate: '2026-09-30' }, 2000)).toEqual({
      start: 'DOMAIN', domainCode: 'FUND', columns: ['entity_code', 'AUM', 'MATURITY'],
      filters: [{ field: 'AUM', op: 'gt', value: 0 }],
      sort: [{ field: 'AUM', dir: 'desc' }, { field: 'entity_code', dir: 'asc' }],
      asOfDate: '2026-09-30', offset: 2000, limit: PAGE_SIZE,
    });
  });

  it('reads page after page until every match is in', async () => {
    const pages = [
      { mode: 'rows', total: 3, matched: 3, rows: [{ entity_code: 'A' }, { entity_code: 'B' }], columns: [{ code: 'entity_code', kind: 'text' }] },
      { mode: 'rows', total: 3, matched: 3, rows: [{ entity_code: 'C' }], columns: [] },
    ];
    const fetchPage = vi.fn(async (offset: number) => pages[offset / PAGE_SIZE]);
    const result = await readAllRows(fetchPage);
    expect(result).toMatchObject({ ok: true, rows: [{ entity_code: 'A' }, { entity_code: 'B' }, { entity_code: 'C' }] });
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([0, PAGE_SIZE]);
  });

  it('refuses more rows than a table holds, before reading them', async () => {
    const result = await readAllRows(async () => ({ mode: 'rows', total: MAX_TABLE_ROWS + 1, matched: MAX_TABLE_ROWS + 1, rows: [{}], columns: [] }));
    expect(result).toMatchObject({ ok: false });
  });

  it('writes numbers as numbers, dates as Excel dates, and blanks as blank', () => {
    expect(rowsToCells(columns, [{ entity_code: '00123', AUM: 750000000, MATURITY: '2026-09-30' }, { entity_code: 'X' }]))
      .toEqual([['00123', 750000000, 46295], ['X', '', '']]);
    expect(columnFormats(columns)).toEqual(['@', null, 'yyyy-mm-dd']);
  });

  it('never writes database text as a formula', () => {
    expect(rowsToCells([{ code: 'entity_name', label: 'Name', kind: 'text' }], [{ entity_name: '=WEBSERVICE("https://x")' }, { entity_name: '+cmd' }, { entity_name: '-5 bps' }]))
      .toEqual([["'=WEBSERVICE(\"https://x\")"], ["'+cmd"], ['-5 bps']]);
  });
});

describe('helpers', () => {
  it('maps data types to kinds', () => {
    expect(['CURRENCY', 'PERCENTAGE', 'DATE', 'BOOLEAN', 'REFERENCE'].map(kindForDataType)).toEqual(['num', 'num', 'date', 'bool', 'text']);
  });

  it('names tables uniquely', () => {
    expect(tableNameFor('FUND', ['Tapestry_FUND_1', 'tapestry_fund_2'])).toBe('Tapestry_FUND_3');
    expect(tableNameFor('CASH FLOW', [])).toBe('Tapestry_CASH_FLOW_1');
  });

  it('changes a table body in place', () => {
    expect(planBody(10, 4)).toEqual({ overwrite: 4, deleteFrom: 4, deleteCount: 6, append: 0, blankFirst: false });
    expect(planBody(3, 8)).toEqual({ overwrite: 3, deleteFrom: 3, deleteCount: 0, append: 5, blankFirst: false });
    expect(planBody(5, 0)).toEqual({ overwrite: 0, deleteFrom: 1, deleteCount: 4, append: 0, blankFirst: true });
    expect(planBody(1, 1)).toEqual({ overwrite: 1, deleteFrom: 1, deleteCount: 0, append: 0, blankFirst: false });
  });

  it('changes columns in place when the ones that stay keep their order', () => {
    expect(planColumns(['entity_code', 'entity_name', 'NAV', 'IRR', 'TVPI'], ['entity_code', 'entity_name', 'TVPI', 'DPI', 'MOIC']))
      .toEqual({ remove: [3, 2], add: ['DPI', 'MOIC'] });
    expect(planColumns(['entity_code', 'entity_name'], ['entity_code', 'entity_name'])).toEqual({ remove: [], add: [] });
    expect(planColumns(['entity_code', 'entity_name', 'NAV', 'IRR'], ['entity_code', 'entity_name', 'IRR', 'NAV'])).toBeNull();
    expect(planColumns(['entity_code', 'entity_name', 'NAV'], ['entity_code', 'DPI', 'entity_name', 'NAV'])).toBeNull();
  });
});

describe('RefreshScheduler', () => {
  it('waits for typing to stop, and runs again when a change arrives mid-refresh', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const runs: string[] = [];
      const scheduler = new RefreshScheduler(async (name) => {
        runs.push(name);
        if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      }, 500);
      scheduler.request('T1');
      scheduler.request('T1');
      await vi.advanceTimersByTimeAsync(499);
      expect(runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toEqual(['T1']);
      scheduler.request('T1');
      await vi.advanceTimersByTimeAsync(500);
      expect(runs).toEqual(['T1']);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toEqual(['T1', 'T1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
