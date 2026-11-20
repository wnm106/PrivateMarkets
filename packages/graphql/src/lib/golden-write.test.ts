import { describe, expect, it, vi } from 'vitest';
import { endGoldenValue, writeGoldenValue } from './golden-write';
import { commitAllocation, type AllocationDraft } from './allocation-store';
import { setAttributes } from './rec-actions';
import { updateEntityAttributes } from './import-map/import-orchestrator';
import { fakeSupabase, filterValue, type FakeCall, type FakeHandler } from '../testing/fake-supabase';

const OPEN = '9999-12-31 23:59:59';
const writes = (calls: FakeCall[]) => calls.filter((call) => call.fn === 'write_value');
/**
 * Changes that rewrite or remove history, or that guard_value_rows refuses for a signed-in
 * caller: a delete or upsert, an update of anything but system_to, or a direct insert of a
 * new value through the public view instead of write_value.
 */
const valueEdits = (calls: FakeCall[]) => calls.filter((call) => call.table === 'entity_attribute_values' && (
  call.op === 'delete'
  || call.op === 'upsert'
  || (call.op === 'update' && Object.keys(call.payload as object).some((key) => key !== 'system_to'))
  || (call.op === 'insert' && call.schema === 'public')
));

describe('writeGoldenValue', () => {
  it('calls golden_master.write_value and leaves out columns that were not given', async () => {
    const db = fakeSupabase((call) => (call.fn === 'write_value' ? { data: 'v1' } : undefined));
    const id = await writeGoldenValue(db.client, {
      entityId: 'e', attributeId: 'a', sourceId: 's', validFrom: '2026-01-01',
      value: { golden_value: 'x', golden_value_numeric: undefined, precedence_rank: 3 },
    });
    expect(id).toBe('v1');
    expect(db.calls).toEqual([expect.objectContaining({
      schema: 'golden_master', fn: 'write_value',
      payload: { p_entity_id: 'e', p_attribute_id: 'a', p_source_id: 's', p_valid_from: '2026-01-01', p_value: { golden_value: 'x', precedence_rank: 3 }, p_valid_to: null },
    })]);
  });

  it('passes an explicit end date and surfaces the database message', async () => {
    const db = fakeSupabase(() => ({ error: { message: 'A value cannot end (2025-12-31) before it starts (2026-01-01)' } }));
    await expect(writeGoldenValue(db.client, { entityId: 'e', attributeId: 'a', sourceId: 's', validFrom: '2026-01-01', validTo: '2025-12-31', value: {} }))
      .rejects.toThrow(/cannot end/);
    expect((db.calls[0].payload as any).p_valid_to).toBe('2025-12-31');
  });
});

describe('endGoldenValue', () => {
  const row = {
    id: 'r1', entity_id: 'e', attribute_id: 'a', source_id: 's', golden_value: '7', golden_value_numeric: 7,
    valid_from: '2026-01-01', valid_to: '9999-12-31', precedence_rank: 1, is_manual_override: true,
    override_reason: 'why', metadata: { note: 'n' }, load_batch_id: 'b1',
  };
  const db = (closed: unknown[] = [{ id: 'r1' }]) => fakeSupabase((call) => {
    if (call.op === 'select') return { data: [row] };
    if (call.op === 'update') return { data: closed };
    return undefined;
  });

  it('keeps the part before the date as current knowledge, then ends the row in system time only', async () => {
    const { client, calls } = db();
    expect(await endGoldenValue(client, { entityId: 'e', attributeId: 'a', sourceId: 's', from: '2026-11-20' })).toBe(1);
    const [read, keep, end] = calls;
    expect(read).toMatchObject({ schema: 'golden_master', table: 'entity_attribute_values', op: 'select' });
    expect(filterValue(read, 'eq', 'system_to')).toBe(OPEN);
    expect(filterValue(read, 'lte', 'valid_from')).toBe('2026-11-20');
    expect(filterValue(read, 'gte', 'valid_to')).toBe('2026-11-20');
    expect(keep.op).toBe('insert');
    expect(keep.payload).toMatchObject({
      golden_value: '7', valid_from: '2026-01-01', valid_to: '2026-11-19', precedence_rank: 1, is_manual_override: true,
      override_reason: 'why', load_batch_id: 'b1', metadata: { note: 'n', reasserted_from: 'r1' },
    });
    expect(keep.payload).not.toHaveProperty('system_from');
    expect(keep.payload).not.toHaveProperty('created_by');
    expect(end.op).toBe('update');
    expect(Object.keys(end.payload as object)).toEqual(['system_to']);
    expect(filterValue(end, 'eq', 'id')).toBe('r1');
  });

  it('writes no earlier part for a row that starts on the date, and fails when the row was not ended', async () => {
    const { client, calls } = db([]);
    row.valid_from = '2026-11-20';
    try {
      await expect(endGoldenValue(client, { entityId: 'e', attributeId: 'a', sourceId: 's', from: '2026-11-20' })).rejects.toThrow(/could not be ended/);
      expect(calls.some((call) => call.op === 'insert')).toBe(false);
    } finally {
      row.valid_from = '2026-01-01';
    }
  });
});

describe('commitAllocation (caller JWT)', () => {
  const ASOF = '2026-11-20';
  function draft(adjustment: boolean): AllocationDraft {
    return {
      dealId: 'deal-1', dealCode: 'DEAL-1', dealName: 'Deal One', asOf: ASOF,
      request: {
        tranches: [{ id: 'tl', name: 'Term Loan', size: 10, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
        portfolios: [{
          id: 'solo', name: 'Solo', nav: 100, issuerLimit: 1, sponsorLimit: 1, unfundedLimit: 1, sponsorExposure: 0, unfundedExposure: 0,
          allowed: ['LOAN'], denyNote: '',
          sleeves: [{ id: 'solo', name: 'Solo', nav: 100, cash: 50, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' }],
        }],
        adjustments: adjustment ? [{ fundId: 'solo', trancheId: 'tl', type: 'override', amount: 4, reason: 'IC' }] : [],
      },
      tranches: [{ id: 'tl', code: 'TL', name: 'Term Loan', securityId: null }],
      positions: [
        { id: 'pos-main', code: 'P1', fundId: 'solo', trancheId: 'tl', role: 'PROPOSAL' },
        { id: 'pos-lock', code: 'L1', fundId: 'solo', trancheId: 'tl', role: 'LOCK' },
      ],
      portfolioIds: new Set(['solo']),
      clientId: 'client-a',
      facts: { description: '', stage: '', strategy: '', borrower: '', borrowerId: '', sponsor: '', sponsorId: '', pricing: '', oid: '', leverage: '', maturity: '', closeDate: '' },
      faces: {},
    };
  }
  const defs = ['TRANCHE_HOLD_PCT', 'MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'POSITION_ALLOCATION_ADJUSTMENT', 'POSITION_ALLOCATION_REASON']
    .map((code) => ({ id: `attr-${code}`, attribute_code: code, default_precedence_rank: 100 }));
  const savedOverride = { id: 'm1', entity_id: 'pos-main', attribute_id: 'attr-MARKET_VALUE', source_id: 'src-manual', golden_value: '7', valid_from: '2026-10-01', valid_to: '9999-12-31', precedence_rank: 100 };
  const database = () => fakeSupabase((call) => {
    if (call.table === 'attribute_register') return { data: defs };
    if (call.table === 'source_registry') return { data: { id: filterValue(call, 'eq', 'source_code') === 'MANUAL' ? 'src-manual' : 'src-engine' } };
    if (call.table === 'domain_templates' || call.table === 'relationship_types') return { data: null };
    if (call.fn === 'write_value') return { data: 'v' };
    if (call.schema === 'golden_master' && call.op === 'select') {
      return { data: filterValue(call, 'eq', 'entity_id') === 'pos-main' && filterValue(call, 'eq', 'attribute_id') === 'attr-MARKET_VALUE' ? [savedOverride] : [] };
    }
    if (call.op === 'update') return { data: [{ id: filterValue(call, 'eq', 'id') }] };
    return undefined;
  });

  it('writes every amount through write_value from the as-of date, by source', async () => {
    const db = database();
    const preview = await commitAllocation(db.client, draft(true), 'user-1');
    const amount = preview.rows[0].cells[0].amount;
    const by = (entity: string, attribute: string, source: string) => writes(db.calls)
      .map((call) => call.payload as any)
      .filter((payload) => payload.p_entity_id === entity && payload.p_attribute_id === `attr-${attribute}` && payload.p_source_id === source);

    for (const call of writes(db.calls)) {
      expect(call.payload).toMatchObject({ p_valid_from: ASOF, p_valid_to: null });
    }
    expect(by('tl', 'TRANCHE_HOLD_PCT', 'src-manual')[0].p_value).toMatchObject({ golden_value_numeric: 100, is_manual_override: true, override_reason: 'Allocation hold' });
    expect(by('pos-main', 'MARKET_VALUE', 'src-engine')[0].p_value).toMatchObject({ golden_value_numeric: amount, is_manual_override: false });
    expect(by('pos-main', 'MARKET_VALUE', 'src-manual')[0].p_value).toMatchObject({ golden_value_numeric: amount, is_manual_override: true, override_reason: 'IC' });
    expect(by('pos-main', 'POSITION_ALLOCATION_ADJUSTMENT', 'src-manual')[0].p_value).toMatchObject({ golden_value: 'OVERRIDE' });
    // A saved position this allocation does not write is set to nothing from the as-of date.
    expect(by('pos-lock', 'MARKET_VALUE', 'src-engine')[0].p_value).toMatchObject({ golden_value: '0', golden_value_numeric: 0 });
    expect(valueEdits(db.calls)).toEqual([]);
  });

  it('removes a saved override from the as-of date and keeps it for earlier dates', async () => {
    const db = database();
    await commitAllocation(db.client, draft(false), 'user-1');
    const golden = db.calls.filter((call) => call.schema === 'golden_master' && call.table === 'entity_attribute_values');
    const keep = golden.find((call) => call.op === 'insert')!;
    expect(keep.payload).toMatchObject({ entity_id: 'pos-main', source_id: 'src-manual', golden_value: '7', valid_from: '2026-10-01', valid_to: '2026-11-19' });
    const end = golden.find((call) => call.op === 'update')!;
    expect(filterValue(end, 'eq', 'id')).toBe('m1');
    expect(Object.keys(end.payload as object)).toEqual(['system_to']);
    // No manual MARKET_VALUE is written when there is no adjustment.
    expect(writes(db.calls).some((call) => (call.payload as any).p_source_id === 'src-manual' && (call.payload as any).p_attribute_id === 'attr-MARKET_VALUE')).toBe(false);
    expect(valueEdits(db.calls)).toEqual([]);
  });
});

describe('storeDealPerformance', () => {
  it('writes changed outputs through write_value and ends outputs the model no longer produces', async () => {
    vi.resetModules();
    vi.doMock('./allocation-store', async () => {
      const actual = await vi.importActual<typeof import('./allocation-store')>('./allocation-store');
      return {
        ...actual,
        loadAllocationDraft: async () => ({
          dealId: 'deal-1', dealCode: 'DEAL-1', dealName: 'Deal', asOf: '2026-11-20',
          request: { tranches: [], portfolios: [], adjustments: [] }, tranches: [], positions: [], portfolioIds: new Set(),
          clientId: 'c', faces: {},
          // No close date: the model is not run, so no output is produced.
          facts: { description: '', stage: '', strategy: '', borrower: '', borrowerId: '', sponsor: '', sponsorId: '', pricing: '', oid: '', leverage: '', maturity: '', closeDate: '' },
        }),
      };
    });
    const { storeDealPerformance } = await import('./deal-performance-store');
    const stale = { id: 'old', entity_id: 'deal-1', attribute_id: 'attr-DEAL_IRR', golden_value: '0.12' };
    const db = fakeSupabase((call) => {
      if (call.table === 'attribute_register') {
        const codes = filterValue(call, 'in', 'attribute_code') as string[];
        return { data: codes.map((code) => ({ id: `attr-${code}`, attribute_code: code })) };
      }
      if (call.table === 'source_registry') return { data: { id: 'src-perf', precedence_rank: 80 } };
      if (call.schema === 'public' && call.table === 'entity_attribute_values') return { data: [stale] };
      if (call.schema === 'golden_master' && call.op === 'select' && call.table) return { data: [{ ...stale, source_id: 'src-perf', valid_from: '2026-01-01', valid_to: '9999-12-31', precedence_rank: 80 }] };
      if (call.op === 'update') return { data: [{ id: 'old' }] };
      if (call.fn === 'winning_attribute_values') return { data: [] };
      return undefined;
    });
    const result = await storeDealPerformance(db.client, 'deal-1', '2026-11-20', 'user-1');
    expect(result).toEqual({ asOf: '2026-11-20', written: 0, closed: 1, unchanged: 0 });

    const current = db.calls.find((call) => call.schema === 'public' && call.table === 'entity_attribute_values')!;
    expect(filterValue(current, 'lte', 'valid_from')).toBe('2026-11-20');
    expect(filterValue(current, 'gte', 'valid_to')).toBe('2026-11-20');
    const golden = db.calls.filter((call) => call.schema === 'golden_master' && call.table === 'entity_attribute_values');
    expect(golden.find((call) => call.op === 'insert')!.payload).toMatchObject({ golden_value: '0.12', valid_from: '2026-01-01', valid_to: '2026-11-19' });
    expect(Object.keys(golden.find((call) => call.op === 'update')!.payload as object)).toEqual(['system_to']);
    expect(valueEdits(db.calls)).toEqual([]);
    vi.doUnmock('./allocation-store');
  });
});

describe('setAttributes (fund reconciliation)', () => {
  it('writes each manual value from the as-of date and keeps earlier ones', async () => {
    const db = fakeSupabase((call) => {
      if (call.table === 'source_registry') return { data: { id: 'src-manual' } };
      if (call.table === 'attribute_register') {
        return { data: [{ id: 'attr-notes', attribute_code: 'CLOSE_REC_NOTES', default_precedence_rank: 9 }, { id: 'attr-out', attribute_code: 'CLOSE_REC_OUTCOME', default_precedence_rank: 9 }] };
      }
      if (call.fn === 'write_value') return { data: 'v' };
      return undefined;
    });
    await setAttributes(db.client, 'close-1', { CLOSE_REC_NOTES: 'Tied out', CLOSE_REC_OUTCOME: '' }, '2026-09-30');
    expect(writes(db.calls).map((call) => call.payload)).toEqual([{
      p_entity_id: 'close-1', p_attribute_id: 'attr-notes', p_source_id: 'src-manual', p_valid_from: '2026-09-30', p_valid_to: null,
      p_value: { golden_value: 'Tied out', golden_value_numeric: null, precedence_rank: 1, is_manual_override: true },
    }]);
    expect(valueEdits(db.calls)).toEqual([]);
  });
});

describe('import update (graphql orchestrator)', () => {
  const handler: FakeHandler = (call) => {
    if (call.table === 'attribute_register') return { data: [{ attribute_code: 'NAV', id: 'attr-nav', default_precedence_rank: 40, reference_list_code: null }] };
    if (call.table === 'source_registry') return { data: { id: 'src-import' } };
    if (call.fn === 'write_value') return { data: 'v' };
    return undefined;
  };

  it('writes the imported value through write_value from today', async () => {
    const db = fakeSupabase(handler);
    await updateEntityAttributes('e1', { NAV: 1234.5 }, db.client, 'user-1');
    expect(writes(db.calls)[0].payload).toEqual({
      p_entity_id: 'e1', p_attribute_id: 'attr-nav', p_source_id: 'src-import', p_valid_from: new Date().toISOString().slice(0, 10), p_valid_to: null,
      p_value: { golden_value: null, golden_value_numeric: 1234.5, golden_value_date: null, precedence_rank: 40 },
    });
    expect(valueEdits(db.calls)).toEqual([]);
  });

  it('fails the record when the write is refused', async () => {
    const db = fakeSupabase((call) => (call.fn === 'write_value' ? { error: { message: 'permission denied' } } : handler(call)));
    await expect(updateEntityAttributes('e1', { NAV: '1' }, db.client)).rejects.toThrow(/permission denied/);
  });
});

describe('storeDealPerformance with a modelled deal', () => {
  it('writes each new output from the run date, then leaves unchanged outputs alone', async () => {
    vi.resetModules();
    vi.doMock('./allocation-store', async () => {
      const actual = await vi.importActual<typeof import('./allocation-store')>('./allocation-store');
      return {
        ...actual,
        loadAllocationDraft: async () => ({
          dealId: 'deal-1', dealCode: 'DEAL-1', dealName: 'Deal', asOf: '2026-11-20',
          request: {
            tranches: [{ id: 'tl', name: 'Term Loan', size: 10, holdPct: 100, unfunded: false, instrumentType: 'LOAN' }],
            portfolios: [{
              id: 'solo', name: 'Solo', nav: 100, issuerLimit: 1, sponsorLimit: 1, unfundedLimit: 1, sponsorExposure: 0, unfundedExposure: 0,
              allowed: ['LOAN'], denyNote: '',
              sleeves: [{ id: 'solo', name: 'Solo', nav: 100, cash: 50, undrawn: 0, line: 0, reserve: 0, allowed: ['LOAN'], denyNote: '' }],
            }],
            adjustments: [],
          },
          tranches: [{ id: 'tl', code: 'TL', name: 'Term Loan', securityId: null }],
          positions: [], portfolioIds: new Set(['solo']), clientId: 'c',
          faces: { tl: { rank: 1, label: 'Term Loan', pricing: 'S+550', callProtection: '', equityLinked: false, coverage: '', tickingFee: '', status: '', securityId: '' } },
          facts: { description: '', stage: '', strategy: '', borrower: '', borrowerId: '', sponsor: '', sponsorId: '', pricing: 'S+550', oid: '98', leverage: '', maturity: '2031-11-20', closeDate: '2026-12-15' },
        }),
      };
    });
    const { storeDealPerformance } = await import('./deal-performance-store');
    let current: Array<Record<string, unknown>> = [];
    const db = fakeSupabase((call) => {
      if (call.table === 'attribute_register') {
        const codes = filterValue(call, 'in', 'attribute_code') as string[];
        return { data: codes.map((code) => ({ id: `attr-${code}`, attribute_code: code })) };
      }
      if (call.table === 'source_registry') return { data: { id: 'src-perf', precedence_rank: 80 } };
      if (call.schema === 'public' && call.table === 'entity_attribute_values') return { data: current };
      if (call.fn === 'winning_attribute_values') return { data: [] };
      if (call.fn === 'write_value') return { data: 'v' };
      return undefined;
    });

    const first = await storeDealPerformance(db.client, 'deal-1', '2026-11-20', 'user-1');
    const firstWrites = writes(db.calls).map((call) => call.payload as any);
    expect(first.written).toBeGreaterThan(0);
    expect(firstWrites).toHaveLength(first.written);
    for (const payload of firstWrites) {
      expect(payload).toMatchObject({ p_source_id: 'src-perf', p_valid_from: '2026-11-20', p_valid_to: null });
      expect(payload.p_value).toMatchObject({ precedence_rank: 80, is_manual_override: false, metadata: { model: 'deal-performance' } });
    }
    expect(valueEdits(db.calls)).toEqual([]);

    // The same run again: every output already holds that value on the run date.
    current = firstWrites.map((payload, index) => ({ id: `row-${index}`, entity_id: payload.p_entity_id, attribute_id: payload.p_attribute_id, golden_value: payload.p_value.golden_value }));
    db.calls.length = 0;
    const second = await storeDealPerformance(db.client, 'deal-1', '2026-11-20', 'user-1');
    expect(second).toEqual({ asOf: '2026-11-20', written: 0, closed: 0, unchanged: first.written });
    expect(writes(db.calls)).toEqual([]);
    vi.doUnmock('./allocation-store');
  });
});
