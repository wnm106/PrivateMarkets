import { describe, expect, it } from 'vitest';
import { planTapOverrides, submitTapOverrides } from './tap-override';

type Row = Record<string, any>;

const navRow = { attribute_id: 'a-nav', attribute_code: 'NAV', attribute_name: 'Net asset value', data_type: 'CURRENCY', domain_code: 'FUND', match_kind: 'CODE' };
const lockedRow = { attribute_id: 'a-locked', attribute_code: 'LOCKED', attribute_name: 'Locked', data_type: 'STRING', domain_code: 'FUND', match_kind: 'CODE' };
const fundRow = { id: 'e-fund', entity_code: 'FUND-1', entity_name: 'Apex Fund', domain_code: 'FUND', match_kind: 'CODE' };
const otherRow = { id: 'e-other', entity_code: 'FUND-2', entity_name: 'Other Fund', domain_code: 'FUND', match_kind: 'CODE' };

function fakeSupabase(options: {
  writable?: Record<string, boolean>;
  decision?: Row;
  current?: Record<string, string>;
  fourEyes?: boolean;
} = {}) {
  const calls: Array<{ fn: string; args?: unknown }> = [];
  const inserted: Row[] = [];
  const refreshed: string[] = [];
  const rpc = (fn: string, args: Record<string, any>) => {
    calls.push({ fn, args });
    if (fn === 'tap_attribute_matches') {
      return Promise.resolve({ data: (args.p_refs as string[]).flatMap((ref) => [navRow, lockedRow].filter((row) => row.attribute_code.toLowerCase() === ref.toLowerCase()).map((row) => ({ ...row, ref }))), error: null });
    }
    if (fn === 'tap_entity_matches') {
      return Promise.resolve({ data: (args.p_refs as string[]).flatMap((ref) => [fundRow, otherRow].filter((row) => row.entity_code.toLowerCase() === ref.toLowerCase()).map((row) => ({ ...row, ref }))), error: null });
    }
    if (fn === 'process_entity_calculated_attributes') {
      refreshed.push(args.p_entity_id);
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: [], error: null });
  };
  const table = (rows: Row[]) => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, gte: () => b,
      update: () => b,
      insert: (row: Row) => { inserted.push(row); const done: any = { select: () => done, single: async () => ({ data: { id: `v${inserted.length}` }, error: null }), then: (r: any) => r({ error: null }) }; return done; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows, error: null }),
    };
    return b;
  };
  return {
    calls, inserted, refreshed,
    rpc,
    from(name: string) {
      if (name === 'attribute_register') return table([{ id: 'a-nav', is_editable: true }, { id: 'a-locked', is_editable: false }]);
      return table([]);
    },
    schema(name: string) {
      return {
        rpc(fn: string, args: Record<string, any>) {
          calls.push({ fn, args });
          if (name === 'golden_master' && fn === 'submit_manual_override') {
            inserted.push({ ...args.p_value, valid_from: args.p_valid_from, source_id: args.p_source_id, entity_id: args.p_entity_id });
            if (options.fourEyes) return Promise.resolve({ data: { status: 'PENDING', requestId: `r${inserted.length}` }, error: null });
            return Promise.resolve({ data: { status: 'APPLIED', id: `v${inserted.length}` }, error: null });
          }
          if (name === 'golden_master') {
            const rows = (args.p_entity_ids as string[]).flatMap((entityId) => {
              const value = options.current?.[entityId];
              return value === undefined ? [] : [{ entity_id: entityId, attribute_id: 'a-nav', golden_value: value, golden_value_numeric: Number(value), valid_from: '2026-06-30' }];
            });
            return Promise.resolve({ data: rows, error: null });
          }
          if (fn === 'has_entity_access') return Promise.resolve({ data: options.writable?.[args.p_entity_id] ?? true, error: null });
          if (fn === 'current_sign_in_decision') return Promise.resolve({ data: options.decision ?? { allowed: true }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        from: () => table([{ id: 'manual' }]),
      };
    },
  };
}

describe('planTapOverrides', () => {
  it('reads the current value the way TAP does and types the new one the way a load does', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' } });
    const [plan] = await planTapOverrides(supabase, [{ attribute: 'nav', entity: 'fund-1', validFrom: '2026-09-30', value: '1,100' }]);
    expect(plan).toMatchObject({
      status: 'READY', attributeCode: 'NAV', entityCode: 'FUND-1', validFrom: '2026-09-30',
      currentValue: 1000, currentText: '1000', newValue: 1100, newText: '1100',
    });
    expect(supabase.inserted).toEqual([]);
  });

  it('skips a value that is already stored, so it is not pinned as a manual entry', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' } });
    const [plan] = await planTapOverrides(supabase, [{ attribute: 'NAV', entity: 'FUND-1', value: '1,000.00' }]);
    expect(plan.status).toBe('UNCHANGED');
  });

  it('flags each row that cannot be saved, and why', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000', 'e-other': '5' }, writable: { 'e-other': false } });
    const plans = await planTapOverrides(supabase, [
      { attribute: 'NAV', entity: 'FUND-1', value: 'about a million' },
      { attribute: 'NAV', entity: 'FUND-1', value: '1200', expected: '900' },
      { attribute: 'LOCKED', entity: 'FUND-1', value: 'x' },
      { attribute: 'ENTITY_NAME', entity: 'FUND-1', value: 'New name' },
      { attribute: 'NAV', entity: 'FUND-2', value: '6' },
      { attribute: 'NAV', entity: 'NOPE', value: '1' },
      { attribute: 'NAV', entity: 'FUND-1', validFrom: 'soon', value: '1' },
    ]);
    expect(plans.map((plan) => plan.status)).toEqual(['INVALID_VALUE', 'STALE', 'NOT_EDITABLE', 'NOT_EDITABLE', 'NO_ACCESS', 'UNKNOWN_ENTITY', 'INVALID_REQUEST']);
    expect(plans[1].message).toBe('The value changed since it was checked. It is now 1000.');
  });

  it('keeps a later row that matches today when an earlier row would carry over to it', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000', 'e-other': '1000' } });
    const plans = await planTapOverrides(supabase, [
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-12-31', value: '1000' },
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-09-30', value: '1100' },
      { attribute: 'NAV', entity: 'FUND-2', validFrom: '2026-12-31', value: '1000' },
    ]);
    expect(plans.map((plan) => plan.status)).toEqual(['READY', 'READY', 'UNCHANGED']);
    expect(plans[0].message).toBe('Saved too, so the entry from 2026-09-30 does not carry over to this date.');
  });

  it('refuses the same value listed twice', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' } });
    const plans = await planTapOverrides(supabase, [
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-09-30', value: '1100' },
      { attribute: 'nav', entity: 'Fund-1', validFrom: '2026-09-30', value: '1200' },
    ]);
    expect(plans.map((plan) => plan.status)).toEqual(['READY', 'DUPLICATE']);
  });
});

describe('submitTapOverrides', () => {
  it('saves READY rows as Manual Entry with the reason, skips the rest, and refreshes calculations once per record', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' } });
    const plans = await submitTapOverrides(supabase, [
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-09-30', value: '1100', expected: '1000' },
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-12-31', value: '1150', reason: 'Q4 pack' },
      { attribute: 'NAV', entity: 'FUND-1', validFrom: '2027-03-31', value: '1000' },
    ], 'Q3 administrator pack', 'user-1');
    // The last row matches today's value, but the 2026-09-30 entry would carry over to it, so it is saved too.
    expect(plans.map((plan) => plan.status)).toEqual(['SAVED', 'SAVED', 'SAVED']);
    // Written through golden_master.submit_manual_override, which stamps the caller from the session.
    expect(supabase.inserted.map((row) => [row.golden_value, row.valid_from, row.source_id, row.override_reason, row.precedence_rank]))
      .toEqual([
        ['1100', '2026-09-30', 'manual', 'Q3 administrator pack', 1],
        ['1150', '2026-12-31', 'manual', 'Q4 pack', 1],
        ['1000', '2027-03-31', 'manual', 'Q3 administrator pack', 1],
      ]);
    expect(supabase.refreshed).toEqual(['e-fund']);
  });

  it('sends each row for approval where the client requires four eyes, and refreshes nothing', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' }, fourEyes: true });
    const plans = await submitTapOverrides(supabase, [{ attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-09-30', value: '1100' }], 'Q3 pack', 'user-1');
    expect(plans.map((plan) => plan.status)).toEqual(['PENDING_APPROVAL']);
    expect(plans[0].message).toMatch(/^Sent for approval/);
    expect(supabase.refreshed).toEqual([]);
  });

  it('writes nothing until the organization’s authenticator step is met', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' }, decision: { allowed: true, mfa_required: true, mfa_satisfied: false } });
    await expect(submitTapOverrides(supabase, [{ attribute: 'NAV', entity: 'FUND-1', value: '1100' }], 'r', 'u'))
      .rejects.toThrow(/requires an authenticator/);
    expect(supabase.inserted).toEqual([]);
  });

  it('needs a reason', async () => {
    const supabase = fakeSupabase({ current: { 'e-fund': '1000' } });
    await expect(submitTapOverrides(supabase, [{ attribute: 'NAV', entity: 'FUND-1', value: '1100' }], '  ', 'u'))
      .rejects.toThrow(/reason is required/);
  });
});
