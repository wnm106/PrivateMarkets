import { describe, expect, it } from 'vitest';
import { fakeSupabase } from '@tapestrai/graphql/src/testing/fake-supabase';
import { ToolRegistry } from '../lib/tool-registry';
import { registerImportMapTools } from './import-map-tools';
import { LOAD_WRITE_REFUSED, SEVERAL_CLIENTS_MESSAGE } from '../feeds/session-client';

/**
 * execute_import_map writes into the one client the session is in. Codes are unique per
 * client, so the client is settled before anything is read or written, and it is the
 * client every create and every lookup by code is for.
 */

function session(clientIds: string[], permissions: string[], existing: Array<{ id: string; client_id: string; entity_code: string; domain_code: string }> = []) {
  return fakeSupabase((call) => {
    if (call.fn === 'current_client_ids') return { data: clientIds.map((id) => ({ current_client_ids: id })) };
    if (call.fn === 'has_permission') return { data: permissions.includes((call.payload as any).p_permission_code) };
    if (call.table === 'master_entities' && call.op === 'select') {
      const eqs = call.filters.filter(([op]) => op === 'eq') as Array<[string, string, unknown]>;
      return { data: existing.filter((row) => eqs.every(([, column, value]) => (row as any)[column] === value)) };
    }
    if (call.table === 'master_entities' && call.op === 'insert') return { data: { id: 'new-1', ...(call.payload as object) } };
    if (call.table === 'attribute_register') return { data: [{ attribute_code: 'isin', id: 'attr-isin', default_precedence_rank: 10, reference_list_code: null }] };
    if (call.table === 'source_registry') return { data: { id: 'src-import' } };
    return undefined;
  });
}

const ARGS = {
  sourceFormat: 'json',
  sourceData: JSON.stringify([{ isin: 'x1' }]),
  domainMappings: [{ domainCode: 'FUND', fieldMappings: [{ sourceField: 'isin', targetAttribute: 'isin', mappingType: 'manual' }] }],
  options: { skipValidation: true },
};

function tools() {
  const registry = new ToolRegistry();
  registerImportMapTools(registry);
  return registry;
}

describe('execute_import_map', () => {
  it('creates the record in the session\'s client, even when another client has the code', async () => {
    const db = session(['client-a'], ['entity.write'], [{ id: 'b-fund', client_id: 'client-b', entity_code: 'FUND-X1', domain_code: 'FUND' }]);
    const result: any = await tools().executeTool('execute_import_map', ARGS, db.client);

    expect(result.results[0]).toMatchObject({ recordsCreated: 1, recordsUpdated: 0, recordsFailed: 0 });
    const insert = db.calls.find((call) => call.table === 'master_entities' && call.op === 'insert');
    expect(insert?.payload).toMatchObject({ entity_code: 'FUND-X1', client_id: 'client-a' });
  });

  it('refuses a session in several clients before reading or writing anything', async () => {
    const db = session(['client-a', 'client-b'], ['entity.write']);
    await expect(tools().executeTool('execute_import_map', ARGS, db.client)).rejects.toThrow(SEVERAL_CLIENTS_MESSAGE);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });

  it('refuses a caller who may not edit records in the client', async () => {
    const db = session(['client-a'], ['entity.read']);
    await expect(tools().executeTool('execute_import_map', ARGS, db.client)).rejects.toThrow(LOAD_WRITE_REFUSED);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });
});
