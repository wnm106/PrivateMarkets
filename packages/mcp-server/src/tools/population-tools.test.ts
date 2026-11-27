import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { registerPopulationTools } from './population-tools';

const row = (over: Record<string, unknown> = {}) => ({
  population_code: 'ACTIVE_FUNDS', filter_name: 'Active funds', domain_code: 'FUND', description: 'Funds that are open for investment.',
  conditions: [{ attributeCode: 'STATUS', operator: 'equals', value: 'ACTIVE', conditionGroup: 1, conditionOrder: 1 }],
  certified_at: '2026-11-25T10:00:00Z', certification_note: 'Reviewed with the CIO', ...over,
});

/** A stand-in for the supabase client: the chain ends in a promise or maybeSingle. */
function fakeDb(rows: any[]) {
  const seen: Record<string, any> = {};
  const chain: any = {
    select: () => chain,
    not: (_c: string, _op: string, _v: unknown) => { seen.certifiedOnly = true; rows = rows.filter((r) => r.certified_at); return chain; },
    order: () => chain,
    eq: (col: string, value: unknown) => { rows = rows.filter((r) => r[col] === value); return chain; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return { from: () => chain, seen } as any;
}

const registry = new ToolRegistry();
registerPopulationTools(registry);
const run = (name: string, args: any, db: any) => (registry as any).tools.get(name).execute(args, db);

describe('population tools', () => {
  it('are reads', () => {
    expect(registry.effectOf('list_populations')).toBe('read');
    expect(registry.effectOf('get_population')).toBe('read');
  });

  it('list only certified populations, with what they mean', async () => {
    const db = fakeDb([row(), row({ population_code: 'DRAFT', certified_at: null })]);
    const out = await run('list_populations', {}, db);
    expect(db.seen.certifiedOnly).toBe(true);
    expect(out.populations.map((p: any) => p.code)).toEqual(['ACTIVE_FUNDS']);
    expect(out.populations[0].definition).toBe('STATUS equals ACTIVE.');
  });

  it('give a certified population in full', async () => {
    const out = await run('get_population', { code: 'active_funds' }, fakeDb([row()]));
    expect(out.certificationNote).toBe('Reviewed with the CIO');
    expect(out.conditions).toHaveLength(1);
  });

  it('refuse an uncertified or unknown code the same way', async () => {
    const draft = await run('get_population', { code: 'DRAFT' }, fakeDb([row({ population_code: 'DRAFT', certified_at: null })]));
    const none = await run('get_population', { code: 'NOPE' }, fakeDb([]));
    expect(draft.error).toMatch(/No certified population/);
    expect(none.error).toMatch(/No certified population/);
  });
});
