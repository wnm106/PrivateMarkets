import { describe, expect, it } from 'vitest';
import * as engineModule from './compliance-engine';
import { ComplianceEngine, probeAttributesFor } from './compliance-engine';
import { complianceResolvers } from '../resolvers/compliance';
import { fakeSupabase } from '../testing/fake-supabase';

// Formerly a process-wide singleton: the first caller's client was kept and every
// later request, from any tenant, ran its rules through it.

function client(label: string) {
  return fakeSupabase((call) => (call.op === 'rpc' ? { error: { message: `rpc via ${label}` } } : undefined));
}

function context(supabase: unknown, userId: string | null = 'user-1') {
  return {
    supabase,
    supabaseAdmin: null,
    user: userId ? { id: userId, email: 'a@example.com', role: 'readonly' as const } : null,
    requestId: 'test',
    loaders: {} as any,
  } as any;
}

describe('compliance engine client scope', () => {
  it('no longer offers a shared engine', () => {
    expect('getComplianceEngine' in engineModule).toBe(false);
  });

  it('runs each engine through the client it was made with', async () => {
    const tenantA = client('TENANT_A_JWT');
    const serviceRole = client('SERVICE_ROLE');
    const tenantB = client('TENANT_B_JWT');
    for (const [who, made] of [['A', tenantA], ['admin', serviceRole], ['B', tenantB]] as const) {
      const engine = new ComplianceEngine(made.client);
      await expect(engine.evaluateRule({ ruleCode: 'X', asOfDate: '2026-01-01' } as any)).rejects.toThrow(/rpc via/);
      expect(made.calls.map((call) => `${call.schema}.${call.fn}`), who).toEqual(['compliance.evaluate_rule']);
    }
  });

  it('evaluates a rule with the requesting caller\'s own client, request after request', async () => {
    const tenantA = client('TENANT_A_JWT');
    const tenantB = client('TENANT_B_JWT');
    const evaluate = complianceResolvers.Mutation.evaluateComplianceRule;
    const input = { input: { ruleCode: 'X', asOfDate: '2026-01-01' } };

    const first = await evaluate(undefined, input, context(tenantA.client));
    const second = await evaluate(undefined, input, context(tenantB.client));

    expect(first.errors[0].message).toMatch(/rpc via TENANT_A_JWT$/);
    expect(second.errors[0].message).toMatch(/rpc via TENANT_B_JWT$/);
    expect(tenantA.calls).toHaveLength(1);
    expect(tenantB.calls).toHaveLength(1);
  });

  it('refuses to evaluate without a signed-in user', async () => {
    const anonymous = client('ANON');
    const result = await complianceResolvers.Mutation.evaluateComplianceRule(undefined, { input: { ruleCode: 'X' } }, context(anonymous.client, null));
    expect(result.errors[0].message).toBe('Not authenticated');
    expect(anonymous.calls).toHaveLength(0);
  });
});

describe('probeAttributesFor', () => {
  it('gives the probed buy its fixed attributes and the probed par', () => {
    expect(probeAttributesFor({ probeAttributes: { YEAR: '2026 Allocation', SIZE: 5, SKIP: null }, probeParAttributes: ['AMOUNT'] }, 2_500_000))
      .toEqual({ YEAR: '2026 Allocation', SIZE: '5', AMOUNT: '2500000' });
  });

  it('leaves a plain probe without attributes', () => {
    expect(probeAttributesFor({}, 1_000_000)).toBeNull();
  });
});
