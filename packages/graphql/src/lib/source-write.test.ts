import { describe, expect, it } from 'vitest';
import { ManualOverrideError, OPEN_SYSTEM_TO, storedOverrideValue, writeManualOverride } from './source-write';

type Row = Record<string, any>;

/** A stand-in for the value table that records what a write does. */
function fakeSupabase(rows: Row[], options: { insertError?: { code?: string; message: string } } = {}) {
  const ops: Array<{ op: string; row?: Row; id?: string }> = [];
  let nextId = 1;
  const client = {
    ops,
    rows,
    schema() {
      return {
        from() {
          const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: 'manual' }, error: null }) };
          return b;
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      let pendingInsert: Row | null = null;
      const b: any = {
        select: () => b,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return b; },
        gte: (column: string, value: string) => { filters.push((row) => String(row[column]) >= value); return b; },
        update: (patch: Row) => { pendingUpdate = patch; return b; },
        insert: (row: Row) => {
          if (options.insertError) {
            const failed: any = { select: () => failed, single: async () => ({ data: null, error: options.insertError }), then: (resolve: any) => resolve({ error: options.insertError }) };
            return failed;
          }
          pendingInsert = { id: `new-${nextId++}`, ...row };
          rows.push(pendingInsert);
          ops.push({ op: 'insert', row: pendingInsert });
          return b;
        },
        single: async () => ({ data: pendingInsert, error: null }),
        then: (resolve: any) => {
          const matched = rows.filter((row) => filters.every((filter) => filter(row)));
          if (pendingUpdate) {
            for (const row of matched) { Object.assign(row, pendingUpdate); ops.push({ op: 'close', id: row.id }); }
            return resolve({ data: null, error: null });
          }
          if (pendingInsert) return resolve({ data: pendingInsert, error: null });
          return resolve({ data: matched.map((row) => ({ ...row })), error: null });
        },
      };
      return b;
    },
  };
  return client;
}

const nav = { id: 'attr-nav', data_type: 'CURRENCY' };
const open = (row: Row) => row.system_to === OPEN_SYSTEM_TO;

describe('writeManualOverride', () => {
  it('keeps an earlier manual entry for its own period when a later one is added', async () => {
    const supabase = fakeSupabase([
      { id: 'sep', entity_id: 'e1', attribute_id: 'attr-nav', source_id: 'manual', golden_value: '100', valid_from: '2026-09-30', valid_to: '9999-12-31', system_to: OPEN_SYSTEM_TO, is_manual_override: true, override_reason: 'Q3 pack' },
    ]);
    await writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '120', validFrom: '2026-12-31', reason: 'Q4 pack', userId: 'u1' });
    const live = supabase.rows.filter(open).map((row) => [row.golden_value, row.valid_from, row.valid_to]);
    expect(live).toEqual([['100', '2026-09-30', '2026-12-30'], ['120', '2026-12-31', '9999-12-31']]);
    expect(supabase.rows.find((row) => row.id === 'sep')?.system_to).not.toBe(OPEN_SYSTEM_TO);
  });

  it('ends a new entry the day before one already scheduled later', async () => {
    const supabase = fakeSupabase([
      { id: 'later', entity_id: 'e1', attribute_id: 'attr-nav', source_id: 'manual', golden_value: '150', valid_from: '2027-03-31', valid_to: '9999-12-31', system_to: OPEN_SYSTEM_TO },
    ]);
    await writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '120', validFrom: '2026-12-31', reason: 'Q4' });
    const added = supabase.ops.find((op) => op.op === 'insert')?.row;
    expect(added).toMatchObject({ valid_from: '2026-12-31', valid_to: '2027-03-30', precedence_rank: 1, is_manual_override: true, override_reason: 'Q4' });
    expect(supabase.ops.filter((op) => op.op === 'close')).toEqual([]);
  });

  it('stores the typed value the way a file load does', async () => {
    const supabase = fakeSupabase([]);
    const written = await writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '1,250,000.50', validFrom: '2026-09-30', reason: 'r', userId: 'u1' });
    expect(written.stored).toEqual({ golden_value: '1250000.5', golden_value_numeric: 1250000.5, golden_value_date: null });
    expect(supabase.ops[0].row).toMatchObject({ golden_value_numeric: 1250000.5, created_by: 'u1', source_id: 'manual' });
  });

  it('refuses a value that does not fit the type, and a missing reason, before writing', async () => {
    const supabase = fakeSupabase([]);
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: 'about a million', reason: 'r' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '1', reason: '  ' }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: 'n/a', reason: 'r' }))
      .rejects.toBeInstanceOf(ManualOverrideError);
    expect(supabase.ops).toEqual([]);
  });

  it('says so when row security refuses the record', async () => {
    const supabase = fakeSupabase([], { insertError: { code: '42501', message: 'new row violates row-level security policy' } });
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '1', reason: 'r' }))
      .rejects.toMatchObject({ code: 'NO_ACCESS', message: 'You cannot change this record.' });
  });
});

describe('storedOverrideValue', () => {
  it('reads percentages, dates and text', () => {
    expect(storedOverrideValue('7.5%', 'PERCENTAGE')).toEqual({ ok: true, stored: { golden_value: '0.075', golden_value_numeric: 0.075, golden_value_date: null } });
    expect(storedOverrideValue('9/30/2026', 'DATE')).toEqual({ ok: true, stored: { golden_value: '2026-09-30', golden_value_numeric: null, golden_value_date: '2026-09-30' } });
    expect(storedOverrideValue(' Vertical software ', 'STRING')).toMatchObject({ ok: true, stored: { golden_value: 'Vertical software' } });
    expect(storedOverrideValue('2026-02-30', 'DATE')).toMatchObject({ ok: false });
  });
});
