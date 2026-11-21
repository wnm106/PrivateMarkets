import { describe, expect, it } from 'vitest';
import { complianceResolvers } from './compliance';
import { fakeSupabase, filterValue, type FakeHandler } from '../testing/fake-supabase';

function context(supabase: unknown, options: { user?: boolean; admin?: unknown } = {}) {
  return {
    supabase,
    supabaseAdmin: options.admin ?? null,
    user: options.user === false ? null : { id: 'user-1', email: 'a@example.com', role: 'readonly' as const },
    requestId: 'test',
    loaders: {} as any,
  } as any;
}

/** A service-role client that fails the test if anything reaches it. */
const untouchable = new Proxy({}, {
  get(_target, property) {
    throw new Error(`service role used: ${String(property)}`);
  },
});

describe('scoreDealCompliance access', () => {
  const score = complianceResolvers.Mutation.scoreDealCompliance;

  it('refuses a caller with no session before reading anything', async () => {
    const caller = fakeSupabase();
    const result = await score(undefined, { dealId: 'deal-1' }, context(caller.client, { user: false, admin: untouchable }));
    expect(result.errors[0].message).toBe('Not authenticated');
    expect(caller.calls).toHaveLength(0);
  });

  it('asks the database, as the caller, for write access to the deal', async () => {
    const caller = fakeSupabase((call) => (call.fn === 'has_entity_access' ? { data: false } : undefined));
    const result = await score(undefined, { dealId: 'deal-1' }, context(caller.client, { admin: untouchable }));
    expect(result.errors[0].message).toBe('You do not have access to score this deal.');
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]).toMatchObject({ schema: 'tenancy', fn: 'has_entity_access', payload: { p_entity_id: 'deal-1', p_level: 'WRITE' } });
  });

  it('fails closed when the access check itself errors', async () => {
    const caller = fakeSupabase((call) => (call.fn === 'has_entity_access' ? { error: { message: 'permission denied' } } : undefined));
    const result = await score(undefined, { dealId: 'deal-1' }, context(caller.client, { admin: untouchable }));
    expect(result.errors[0].message).toBe('You do not have access to score this deal.');
  });
});

describe('createComplianceRuleVersion', () => {
  const create = complianceResolvers.Mutation.createComplianceRuleVersion;
  const input = {
    ruleId: 'rule-1',
    validFrom: '2027-01-01',
    ruleName: 'Issuer limit',
    baseDomainCode: 'POSITION',
    numeratorAttributeCode: 'MARKET_VALUE',
    numeratorAggregation: 'SUM',
    conditions: [{ appliesTo: 'BASE', attributeCode: 'ASSET_CLASS', operator: 'EQUALS', value: 'LOAN' }],
    measureLines: [{ side: 'NUMERATOR', kind: 'ATTRIBUTE', attributeCode: 'MARKET_VALUE', conditions: [{ attributeCode: 'RATING', operator: 'EQUALS', value: 'B' }] }],
  };

  function database(extra: FakeHandler = () => undefined) {
    return fakeSupabase((call) => {
      const answered = extra(call);
      if (answered) return answered;
      if (call.table === 'rule_versions' && call.op === 'select' && call.columns?.startsWith('id, version_number')) {
        return { data: [{ id: 'v1', version_number: 1, limit_direction: 'MAX', consolidate_descendants: true }] };
      }
      if (call.fn === 'create_rule_version') return { data: 'v2' };
      if (call.table === 'rule_versions' && call.op === 'select') {
        return { data: { id: 'v2', rule_id: 'rule-1', version_number: 2, valid_from: '2027-01-01', conditions: [] } };
      }
      if (call.table === 'rule_measure_lines') return { data: [] };
      return undefined;
    });
  }

  it('saves the version, its conditions and measure lines in one call and leaves the live version alone', async () => {
    const db = database();
    const result = await create(undefined, { input }, context(db.client));
    expect(result.errors).toEqual([]);
    expect(result.version?.id).toBe('v2');

    // The live version stays in effect until the new valid_from, so nothing updates or closes it.
    expect(db.calls.filter((call) => call.op !== 'select' && call.op !== 'rpc')).toEqual([]);
    const save = db.calls.find((call) => call.fn === 'create_rule_version')!;
    const payload = save.payload as any;
    expect(save.schema).toBe('compliance');
    expect(payload.p_rule_id).toBe('rule-1');
    expect(payload.p_version).toMatchObject({ valid_from: '2027-01-01', valid_to: '9999-12-31', limit_direction: 'MAX', consolidate_descendants: true });
    expect(payload.p_version).not.toHaveProperty('system_to');
    expect(payload.p_version).not.toHaveProperty('version_number');
    expect(payload.p_conditions).toEqual([expect.objectContaining({ applies_to: 'BASE', attribute_code: 'ASSET_CLASS', condition_order: 1 })]);
    expect(payload.p_conditions[0]).not.toHaveProperty('rule_version_id');
    expect(payload.p_measure_lines).toEqual([
      expect.objectContaining({
        side: 'NUMERATOR',
        line_order: 1,
        conditions: [expect.objectContaining({ applies_to: 'LINE', filter_role: 'WHERE', attribute_code: 'RATING' })],
      }),
    ]);
  });

  it('reports a failed save and writes nothing else', async () => {
    const db = database((call) => (call.fn === 'create_rule_version' ? { error: { message: 'new row violates row-level security policy' } } : undefined));
    const result = await create(undefined, { input }, context(db.client));
    expect(result.version).toBeNull();
    expect(result.errors[0].message).toMatch(/row-level security/);
    expect(db.calls.filter((call) => call.op !== 'select' && call.op !== 'rpc')).toEqual([]);
    expect(db.calls.some((call) => call.table === 'rule_versions' && filterValue(call, 'eq', 'id') === 'v2')).toBe(false);
  });
});
