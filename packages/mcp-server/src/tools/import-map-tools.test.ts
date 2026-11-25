import { describe, expect, it } from 'vitest';
import { fakeSupabase } from '@tapestrai/graphql/src/testing/fake-supabase';
import { ToolRegistry } from '../lib/tool-registry';
import { registerImportMapTools } from './import-map-tools';
import { LOAD_WRITE_REFUSED, OTHER_CLIENT_MESSAGE, SEVERAL_CLIENTS_MESSAGE } from '../feeds/session-client';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

/**
 * The import tools work in one client: the one the caller names with clientId, if the
 * session may act in it, or else the session's one client. Codes are unique per client,
 * so the client is settled before anything is read or written, and it is the client
 * every create, every lookup by code and every catalog read is for.
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
    if (call.table === 'attribute_register') return { data: [{ attribute_code: 'isin', attribute_name: 'ISIN', data_type: 'STRING', id: 'attr-isin', default_precedence_rank: 10, reference_list_code: null }] };
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
    const db = session([A], ['entity.write'], [{ id: 'b-fund', client_id: B, entity_code: 'FUND-X1', domain_code: 'FUND' }]);
    const result: any = await tools().executeTool('execute_import_map', ARGS, db.client);

    expect(result.results[0]).toMatchObject({ recordsCreated: 1, recordsUpdated: 0, recordsFailed: 0 });
    const insert = db.calls.find((call) => call.table === 'master_entities' && call.op === 'insert');
    expect(insert?.payload).toMatchObject({ entity_code: 'FUND-X1', client_id: A });
  });

  it('refuses a session in several clients before reading or writing anything', async () => {
    const db = session([A, B], ['entity.write']);
    await expect(tools().executeTool('execute_import_map', ARGS, db.client)).rejects.toThrow(SEVERAL_CLIENTS_MESSAGE);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });

  it('refuses a caller who may not edit records in the client', async () => {
    const db = session([A], ['entity.read']);
    await expect(tools().executeTool('execute_import_map', ARGS, db.client)).rejects.toThrow(LOAD_WRITE_REFUSED);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });

  it('writes into the client the caller names, for a session in several clients', async () => {
    const db = session([A, B], ['entity.write'], [{ id: 'a-fund', client_id: A, entity_code: 'FUND-X1', domain_code: 'FUND' }]);
    const result: any = await tools().executeTool('execute_import_map', { ...ARGS, clientId: B }, db.client);

    expect(result.results[0]).toMatchObject({ recordsCreated: 1, recordsUpdated: 0 });
    const insert = db.calls.find((call) => call.table === 'master_entities' && call.op === 'insert');
    expect(insert?.payload).toMatchObject({ entity_code: 'FUND-X1', client_id: B });
    const permission = db.calls.find((call) => call.fn === 'has_permission');
    expect(permission?.payload).toEqual({ p_client_id: B, p_permission_code: 'entity.write' });
  });

  it('refuses a client the session cannot act in, before reading or writing anything', async () => {
    const db = session([A], ['entity.write']);
    await expect(tools().executeTool('execute_import_map', { ...ARGS, clientId: C }, db.client)).rejects.toThrow(OTHER_CLIENT_MESSAGE);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });
});

describe('analyze_import_map', () => {
  it('reads the catalog of the client the caller names', async () => {
    const db = session([A, B], ['entity.read']);
    await tools().executeTool('analyze_import_map', { ...ARGS, clientId: B }, db.client);
    const attributes = db.calls.filter((call) => call.table === 'attribute_register');
    expect(attributes.length).toBeGreaterThan(0);
    for (const call of attributes) expect(call.filters).toContainEqual(['or', `client_id.is.null,client_id.eq.${B}`]);
  });

  it('refuses a session in several clients that names none, and a client it cannot act in', async () => {
    await expect(tools().executeTool('analyze_import_map', ARGS, session([A, B], []).client)).rejects.toThrow(SEVERAL_CLIENTS_MESSAGE);
    const db = session([A], []);
    await expect(tools().executeTool('analyze_import_map', { ...ARGS, clientId: C }, db.client)).rejects.toThrow(OTHER_CLIENT_MESSAGE);
    expect(db.calls.filter((call) => call.table)).toEqual([]);
  });
});
