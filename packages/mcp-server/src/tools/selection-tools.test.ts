import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { registerDQTools } from './dq-tools';
import { registerSelectionTools } from './selection-tools';

/** A stand-in that records each filter a query applied and answers with fixed rows. */
function fakeSupabase(rows: any[], count = rows.length) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: any = new Proxy({}, {
    get: (_target, method: string) => {
      if (method === 'then') return (resolve: any) => resolve({ data: rows, error: null, count });
      return (...args: unknown[]) => {
        calls.push([method, ...args]);
        return builder;
      };
    },
  });
  return { client: { from: () => builder } as never, calls };
}

const registry = new ToolRegistry(null as never);
registerSelectionTools(registry);
registerDQTools(registry);

describe('find_records', () => {
  it('returns no list when the run has no filters, and does not read anything', async () => {
    const { client, calls } = fakeSupabase([]);
    const out: any = await registry.executeTool('find_records', { domainCode: '', entityCodes: [], limit: 50 }, client);
    expect(out.filtered).toBe(false);
    expect(out).not.toHaveProperty('entityIds');
    expect(calls).toEqual([]);
  });

  it('applies every filter given and names a code that matched nothing', async () => {
    const { client, calls } = fakeSupabase([{ id: 'f1', entity_code: 'HSCF2', entity_name: 'Halyard Senior Credit Fund II', domain_code: 'FUND' }]);
    const out: any = await registry.executeTool('find_records', { domainCode: 'fund', entityCodes: ['HSCF2', 'NOPE'] }, client);
    expect(calls).toContainEqual(['eq', 'domain_code', 'FUND']);
    expect(calls).toContainEqual(['in', 'entity_code', ['HSCF2', 'NOPE']]);
    expect(calls).toContainEqual(['eq', 'is_active', true]);
    expect(out).toMatchObject({ filtered: true, count: 1, entityIds: ['f1'], entityCodes: ['HSCF2'], notFound: ['NOPE'] });
    expect(out.records[0]).toEqual({ entityId: 'f1', entityCode: 'HSCF2', entityName: 'Halyard Senior Credit Fund II', domainCode: 'FUND' });
  });

  it('says so when the filters match more than it returns', async () => {
    const { client } = fakeSupabase([{ id: 'p1', entity_code: 'P1', entity_name: 'One', domain_code: 'POSITION' }], 240);
    const out: any = await registry.executeTool('find_records', { domainCode: 'POSITION', limit: 1 }, client);
    expect(out).toMatchObject({ count: 1, totalCount: 240, notShown: 239 });
    expect(out.note).toMatch(/match 240 records/);
    expect(out).not.toHaveProperty('notFound');
  });

  it('returns an empty list, not "everything", when the filters match nothing', async () => {
    const { client } = fakeSupabase([]);
    const out: any = await registry.executeTool('find_records', { entityCodes: ['NOPE'] }, client);
    expect(out).toMatchObject({ filtered: true, count: 0, entityIds: [], notFound: ['NOPE'] });
  });
});

describe('list_dq_exceptions for a selection', () => {
  it('reads nothing for an empty selection', async () => {
    const { client, calls } = fakeSupabase([{ id: 'x' }]);
    expect(await registry.executeTool('list_dq_exceptions', { status: 'OPEN', entityIds: [] }, client)).toEqual({ exceptions: [], totalCount: 0 });
    expect(calls).toEqual([]);
  });

  it('limits to the selected records, and to none when there is no selection', async () => {
    const selected = fakeSupabase([]);
    await registry.executeTool('list_dq_exceptions', { status: 'OPEN', entityIds: ['a', 'b'] }, selected.client);
    expect(selected.calls).toContainEqual(['in', 'entity_id', ['a', 'b']]);

    const all = fakeSupabase([]);
    await registry.executeTool('list_dq_exceptions', { status: 'OPEN' }, all.client);
    expect(all.calls.some(([method]) => method === 'in')).toBe(false);
  });
});
