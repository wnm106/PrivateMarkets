import { describe, expect, it, vi } from 'vitest';
import { tenancyResolvers } from './tenancy';
import { entityResolutionResolvers } from './entity-resolution';
import { lineageResolvers } from './lineage';
import { goldenSourceResolvers } from './goldensource';
import { callerClientId } from './jobs';
import { requireIsoDate } from '../lib/input-guards';
import { fakeSupabase, filterValue, type FakeHandler } from '../testing/fake-supabase';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const ROLE = '33333333-3333-4333-8333-333333333333';

function context(handler: FakeHandler, admin: unknown = null) {
  const db = fakeSupabase(handler);
  return {
    db,
    ctx: {
      supabase: db.client,
      supabaseAdmin: admin,
      user: { id: 'user-1', email: 'a@example.com', role: 'readonly' as const },
      requestId: 'test',
      loaders: {} as any,
    } as any,
  };
}

describe('writes that row level security can silently skip', () => {
  it('revokeRole fails when no role row was removed, and succeeds when one was', async () => {
    const none = context(() => ({ data: [] }));
    const refused = await tenancyResolvers.Mutation.revokeRole(undefined, { clientId: CLIENT, userId: 'u', roleId: ROLE }, none.ctx);
    expect(refused.success).toBe(false);
    expect(none.db.calls[0]).toMatchObject({ op: 'delete', table: 'user_roles', returning: true });

    const one = context(() => ({ data: [{ id: 'ur-1' }] }));
    expect((await tenancyResolvers.Mutation.revokeRole(undefined, { clientId: CLIENT, userId: 'u', roleId: ROLE }, one.ctx)).success).toBe(true);
  });

  it('deactivateClientUser and revokeEntityAccess fail when nothing changed', async () => {
    const none = context(() => ({ data: [] }));
    expect((await tenancyResolvers.Mutation.deactivateClientUser(undefined, { clientId: CLIENT, userId: 'u' }, none.ctx)).success).toBe(false);
    expect((await tenancyResolvers.Mutation.revokeEntityAccess(undefined, { id: 'grant-1' }, none.ctx)).success).toBe(false);
    expect(none.db.calls.every((call) => call.returning)).toBe(true);
  });

  it('updateMatchRule reports a rule it could not change', async () => {
    const none = context(() => ({ data: [] }));
    const result = await entityResolutionResolvers.Mutation.updateMatchRule(undefined, { input: { id: 'rule-1', ruleName: 'X' } }, none.ctx);
    expect(result.rule).toBeNull();
    expect(result.errors[0].message).toMatch(/not saved/);
  });

  it('qualifyEntityTemplate reports a template change it could not make', async () => {
    const none = context((call) => {
      if (call.table === 'domain_templates') {
        return { data: [{ id: 't1', template_code: 'T1', applicability_rules: { logic: 'AND', conditions: [{ attributeCode: 'KIND', operator: 'equals', value: 'A' }] } }] };
      }
      if (call.table === 'source_attribute_values') return { data: [{ attribute_code: 'KIND', attribute_value: 'A' }] };
      if (call.table === 'master_entities') return { data: [] };
      return undefined;
    });
    await expect(goldenSourceResolvers.Query.qualifyEntityTemplate(undefined, { entityId: 'e1', domainCode: 'FUND' }, none.ctx)).rejects.toThrow(/not changed/);
  });
});

describe('callerClientId', () => {
  const ids = (rows: unknown[]) => context((call) => (call.fn === 'current_client_ids' ? { data: rows } : undefined)).ctx;

  it('returns the one client the caller works in, or null for none', async () => {
    expect(await callerClientId(ids([]))).toBeNull();
    expect(await callerClientId(ids([CLIENT]))).toBe(CLIENT);
    expect(await callerClientId(ids([{ current_client_ids: CLIENT }]))).toBe(CLIENT);
  });

  it('refuses a caller in more than one client instead of picking one', async () => {
    await expect(callerClientId(ids([CLIENT, OTHER_CLIENT]))).rejects.toThrow(/more than one client/);
  });

  it('surfaces a failed lookup', async () => {
    const failing = context((call) => (call.fn === 'current_client_ids' ? { error: { message: 'boom' } } : undefined)).ctx;
    await expect(callerClientId(failing)).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('ids and dates that go into filter strings', () => {
  it('roles accepts only an id for clientId', async () => {
    const bad = context(() => ({ data: [] }));
    await expect(tenancyResolvers.Query.roles(undefined, { clientId: `${CLIENT}),id.neq.(x` }, bad.ctx)).rejects.toThrow(/clientId must be an id/);
    expect(bad.db.calls).toHaveLength(0);

    const good = context(() => ({ data: [] }));
    await tenancyResolvers.Query.roles(undefined, { clientId: CLIENT }, good.ctx);
    expect(good.db.calls[0].filters.some(([name, value]) => name === 'or' && value === `client_id.is.null,client_id.eq.${CLIENT}`)).toBe(true);
  });

  it('requireIsoDate keeps the calendar date and refuses anything else', () => {
    expect(requireIsoDate('2026-01-31', 'd')).toBe('2026-01-31');
    expect(requireIsoDate('2026-01-31T10:00:00Z', 'd')).toBe('2026-01-31');
    for (const value of ['2026-02-30', '2026-01-31,valid_to.gte.1900-01-01', '', 'yesterday', null]) {
      expect(() => requireIsoDate(value, 'd')).toThrow(/must be a date/);
    }
  });

  it('temporalHistory keeps values that overlap the window, and checks its dates first', async () => {
    const bad = context(() => ({ data: [] }));
    await expect(lineageResolvers.Query.temporalHistory(undefined, { entityId: 'e', attributeCode: 'A', fromDate: '2026-01-01', toDate: '2026-12-31),or(id.gt.0' }, bad.ctx)).rejects.toThrow(/toDate must be a date/);
    expect(bad.db.calls).toHaveLength(0);

    const good = context((call) => (call.table === 'attribute_register' ? { data: { id: 'attr-1' } } : { data: [] }));
    await lineageResolvers.Query.temporalHistory(undefined, { entityId: 'e', attributeCode: 'A', fromDate: '2026-01-01', toDate: '2026-12-31' }, good.ctx);
    const read = good.db.calls.find((call) => call.table === 'entity_attribute_values')!;
    // Both ends must hold: starts by the window's end AND ends on or after its start.
    expect(filterValue(read, 'lte', 'valid_from')).toBe('2026-12-31');
    expect(filterValue(read, 'gte', 'valid_to')).toBe('2026-01-01');
    expect(read.filters.some(([name]) => name === 'or')).toBe(false);
  });
});

describe('roles from another client', () => {
  it('assignRole refuses a role owned by a different client and writes nothing', async () => {
    const db = context((call) => (call.table === 'roles' ? { data: [{ id: ROLE, client_id: OTHER_CLIENT }] } : undefined));
    const result = await tenancyResolvers.Mutation.assignRole(undefined, { input: { clientId: CLIENT, userId: 'u', roleId: ROLE } }, db.ctx);
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/different client/);
    expect(db.db.calls.some((call) => call.op === 'upsert')).toBe(false);
  });

  it('assignRole accepts a shared role', async () => {
    const db = context((call) => (call.table === 'roles' ? { data: [{ id: ROLE, client_id: null }] } : undefined));
    expect((await tenancyResolvers.Mutation.assignRole(undefined, { input: { clientId: CLIENT, userId: 'u', roleId: ROLE } }, db.ctx)).success).toBe(true);
  });

  it('inviteUser finds an existing account past the first page of users', async () => {
    const pages: number[] = [];
    const admin = {
      auth: {
        admin: {
          inviteUserByEmail: async () => ({ data: null, error: { message: 'already registered' } }),
          listUsers: async ({ page }: { page: number }) => {
            pages.push(page);
            const users = page === 1
              ? Array.from({ length: 1000 }, (_, index) => ({ id: `u-${index}`, email: `person${index}@example.com` }))
              : [{ id: 'found-user', email: 'Late@Example.com' }];
            return { data: { users }, error: null };
          },
        },
      },
    };
    const db = context((call) => {
      if (call.fn === 'has_permission') return { data: true };
      if (call.fn === 'is_tenant_admin') return { data: false };
      if (call.table === 'roles') return { data: [{ id: ROLE, client_id: CLIENT }] };
      return undefined;
    }, admin);
    const result = await tenancyResolvers.Mutation.inviteUser(undefined, { input: { clientId: CLIENT, email: 'late@example.com', roleIds: [ROLE] } }, db.ctx);
    expect(result).toEqual({ success: true, errors: [] });
    expect(pages).toEqual([1, 2]);
    const membership = db.db.calls.find((call) => call.table === 'client_users' && call.op === 'upsert')!;
    expect((membership.payload as any).user_id).toBe('found-user');
  });
});

describe('batchResolveGoldenSources', () => {
  it('reads every page of entities, not only the first 1,000', async () => {
    // Each entity's re-resolve fails against the stand-in database and is logged; only the paging matters here.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const total = 2300;
    const db = context((call) => {
      if (call.table === 'entity_master') {
        const range = call.filters.find(([name]) => name === 'range') as [string, number, number];
        const [, from, to] = range;
        const count = Math.max(0, Math.min(total, to + 1) - from);
        return { data: Array.from({ length: count }, (_, index) => ({ entity_id: `e-${from + index}`, template_id: null, domain_code: 'FUND' })) };
      }
      return undefined;
    });
    await goldenSourceResolvers.Mutation.batchResolveGoldenSources(undefined, { domainCode: 'FUND', attributeCode: 'NAV' }, db.ctx);
    const ranges = db.db.calls.filter((call) => call.table === 'entity_master').map((call) => call.filters.find(([name]) => name === 'range')!.slice(1));
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2300, 3299]]);
    quiet.mockRestore();
  });

  it('refuses a template code it cannot find instead of re-resolving the whole domain', async () => {
    const db = context(() => undefined);
    const result = await goldenSourceResolvers.Mutation.batchResolveGoldenSources(undefined, { domainCode: 'FUND', attributeCode: 'NAV', templateCode: 'MISSING' }, db.ctx);
    expect(result.success).toBe(false);
    expect(db.db.calls.some((call) => call.table === 'entity_master')).toBe(false);
  });
});
