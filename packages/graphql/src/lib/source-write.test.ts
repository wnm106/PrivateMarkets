import { describe, expect, it } from 'vitest';
import { ManualOverrideError, storedOverrideValue, writeManualOverride } from './source-write';

/** A stand-in for the client that records each golden_master.write_value call. */
function fakeSupabase(options: { rpcError?: { code?: string; message: string } } = {}) {
  const writes: Array<{ schema: string; fn: string; args: Record<string, any> }> = [];
  const client = {
    writes,
    schema(name: string) {
      return {
        from() {
          const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: 'manual' }, error: null }) };
          return b;
        },
        rpc: async (fn: string, args: Record<string, any>) => {
          writes.push({ schema: name, fn, args });
          return options.rpcError ? { data: null, error: options.rpcError } : { data: 'v-new', error: null };
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
    from() {
      throw new Error('A value row was read or written directly; every write goes through write_value.');
    },
  };
  return client;
}

const nav = { id: 'attr-nav', data_type: 'CURRENCY' };

describe('writeManualOverride', () => {
  it('writes the Manual Entry source through write_value, from the date until its next later value', async () => {
    const supabase = fakeSupabase();
    const written = await writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '120', validFrom: '2026-12-31T00:00:00Z', reason: 'Q4 pack', userId: 'u1' });
    expect(written.id).toBe('v-new');
    expect(supabase.writes).toEqual([{
      schema: 'golden_master',
      fn: 'write_value',
      args: {
        p_entity_id: 'e1',
        p_attribute_id: 'attr-nav',
        p_source_id: 'manual',
        p_valid_from: '2026-12-31',
        p_value: { golden_value: '120', golden_value_numeric: 120, golden_value_date: null, precedence_rank: 1, is_manual_override: true, override_reason: 'Q4 pack' },
        p_valid_to: null,
      },
    }]);
  });

  it('stores the typed value the way a file load does', async () => {
    const supabase = fakeSupabase();
    const written = await writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '1,250,000.50', validFrom: '2026-09-30', reason: 'r', userId: 'u1' });
    expect(written.stored).toEqual({ golden_value: '1250000.5', golden_value_numeric: 1250000.5, golden_value_date: null });
    expect(supabase.writes[0].args.p_value).toMatchObject({ golden_value_numeric: 1250000.5 });
  });

  it('refuses a value that does not fit the type, and a missing reason, before writing', async () => {
    const supabase = fakeSupabase();
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: 'about a million', reason: 'r' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: '1', reason: '  ' }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(writeManualOverride(supabase as never, { entityId: 'e1', attribute: nav, value: 'n/a', reason: 'r' }))
      .rejects.toBeInstanceOf(ManualOverrideError);
    expect(supabase.writes).toEqual([]);
  });

  it('says so when row security refuses the record', async () => {
    const supabase = fakeSupabase({ rpcError: { code: '42501', message: 'new row violates row-level security policy' } });
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
