import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { registerExternalIdTools } from './external-id-tools';

/** A Supabase stand-in that records RPC calls and answers entity code lookups. */
function fakeSupabase(rpcData: Record<string, unknown>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: any = {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: rpcData[fn] ?? null, error: null };
    },
    schema: () => ({
      from: () => ({
        select: () => ({
          in: async (_column: string, codes: string[]) => ({
            data: codes.includes('FUND-001') ? [{ id: '11111111-1111-1111-1111-111111111111', entity_code: 'FUND-001' }] : [],
            error: null,
          }),
        }),
      }),
    }),
  };
  return client;
}

const ROW = {
  entity_id: '11111111-1111-1111-1111-111111111111',
  entity_code: 'FUND-001',
  entity_name: 'Fund I',
  domain_code: 'FUND',
  source_code: 'DEALCLOUD',
  source_name: 'DealCloud',
  external_id: 'DC-42',
  valid_from: '1900-01-01',
  origin: 'MANUAL',
  servers: ['CRM'],
};

function registry(supabase: any) {
  const r = new ToolRegistry(supabase);
  registerExternalIdTools(r);
  return r;
}

describe('external id tools', () => {
  it('resolves entity codes and groups ids by record', async () => {
    const supabase = fakeSupabase({ entity_external_ids_for: [ROW] });
    const result = await registry(supabase).executeTool('get_external_ids', { entityIds: ['FUND-001'], asOfDate: '2026-09-30' }, supabase);
    expect(supabase.calls[0]).toEqual({
      fn: 'entity_external_ids_for',
      args: { p_entity_ids: [ROW.entity_id], p_as_of: '2026-09-30', p_knowledge: null },
    });
    expect(result.records).toEqual([
      { entityId: ROW.entity_id, entityCode: 'FUND-001', entityName: 'Fund I', ids: [{ source: 'DEALCLOUD', sourceName: 'DealCloud', externalId: 'DC-42', servers: ['CRM'], origin: 'MANUAL' }] },
    ]);
  });

  it('says when no record matched', async () => {
    const supabase = fakeSupabase({});
    const result = await registry(supabase).executeTool('get_external_ids', { entityIds: ['NOPE'] }, supabase);
    expect(result.records).toEqual([]);
    expect(supabase.calls).toHaveLength(0);
  });

  it('finds a record from an outside id', async () => {
    const supabase = fakeSupabase({ entity_external_id_find: [ROW] });
    const result = await registry(supabase).executeTool('find_entity_by_external_id', { source: 'DEALCLOUD', externalId: 'DC-42' }, supabase);
    expect(result.matches[0].entityCode).toBe('FUND-001');
  });

  it('saves a match only once the user confirmed it, and records that the assistant made it', async () => {
    const supabase = fakeSupabase({ entity_external_id_save: ROW });
    const r = registry(supabase);
    await expect(r.executeTool('save_external_id', { entityId: 'FUND-001', source: 'DEALCLOUD', externalId: 'DC-42' }, supabase)).rejects.toThrow(/confirm/);
    const result = await r.executeTool('save_external_id', { entityId: 'FUND-001', source: 'DEALCLOUD', externalId: 'DC-42', confirmedByUser: true }, supabase);
    expect(supabase.calls.at(-1)).toMatchObject({ fn: 'entity_external_id_save', args: { p_origin: 'ASSISTANT', p_entity_id: ROW.entity_id } });
    expect(result.saved.externalId).toBe('DC-42');
  });

  it('keeps reads in domain-read and the save in external', () => {
    const r = registry(fakeSupabase({}));
    const categories = Object.fromEntries(r.listTools().map((t) => [t.name, t.category]));
    expect(categories).toEqual({ get_external_ids: 'domain-read', find_entity_by_external_id: 'domain-read', save_external_id: 'external' });
  });
});
