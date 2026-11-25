import { describe, expect, it } from 'vitest';
import { importMapResolvers } from './importmap';
import { fakeSupabase, type FakeCall } from '../testing/fake-supabase';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

/** A caller in clients A and B, and one stored import map of a single FUND row. */
function context() {
  const db = fakeSupabase((call) => {
    if (call.table === 'profiles') return { data: { is_tenant_admin: false } };
    if (call.table === 'impersonation_sessions') return { data: null };
    if (call.table === 'client_users') return { data: [{ client_id: A }, { client_id: B }] };
    if (call.table === 'import_maps' && call.op === 'select') {
      return { data: {
        id: 'map-1', name: 'm', source_format: 'JSON', source_data: JSON.stringify([{ isin: 'x1' }]), options: {},
        domain_mappings: [{ domainCode: 'FUND', fieldMappings: [{ sourceField: 'isin', targetAttribute: 'isin', mappingType: 'manual' }] }],
      } };
    }
    if (call.table === 'master_entities' && call.op === 'select') return { data: [] };
    if (call.table === 'master_entities' && call.op === 'insert') return { data: { id: 'new-1' } };
    if (call.table === 'attribute_register') return { data: [{ attribute_code: 'isin', attribute_name: 'ISIN', data_type: 'STRING', id: 'attr-isin', default_precedence_rank: 10, reference_list_code: null }] };
    if (call.table === 'source_registry') return { data: { id: 'src-import' } };
    return undefined;
  });
  return { db, ctx: { supabase: db.client, user: { id: 'user-1' } } as any };
}

const entityWrites = (calls: FakeCall[]) => calls.filter((call) => call.table === 'master_entities' && call.op !== 'select');

describe('executeImportMap mutation', () => {
  it('imports into the client named in the input', async () => {
    const { db, ctx } = context();
    const result: any = await importMapResolvers.Mutation.executeImportMap(null, { input: { importMapId: 'map-1', clientId: B, skipValidation: true } }, ctx);

    expect(result.errors).toEqual([]);
    expect(entityWrites(db.calls).map((call) => call.payload)).toEqual([expect.objectContaining({ entity_code: 'FUND-X1', client_id: B })]);
    const read = db.calls.find((call) => call.table === 'import_maps' && call.op === 'select');
    expect(read?.filters).toContainEqual(['eq', 'id', 'map-1']);
  });

  it('refuses a client the caller is not in, before the map is read or a record written', async () => {
    const { db, ctx } = context();
    const result: any = await importMapResolvers.Mutation.executeImportMap(null, { input: { importMapId: 'map-1', clientId: C } }, ctx);

    expect(result.errors[0].message).toMatch(/cannot add records for that client/);
    expect(db.calls.some((call) => call.table === 'import_maps' && call.op === 'select')).toBe(false);
    expect(entityWrites(db.calls)).toEqual([]);
  });

  it('asks a caller in several clients to name one', async () => {
    const { db, ctx } = context();
    const result: any = await importMapResolvers.Mutation.executeImportMap(null, { input: { importMapId: 'map-1' } }, ctx);
    expect(result.errors[0].message).toMatch(/Open the client you are working in/);
    expect(entityWrites(db.calls)).toEqual([]);
  });
});

describe('analyzeImportMap mutation', () => {
  it('reads the catalog of the client named in the input', async () => {
    const { db, ctx } = context();
    const result: any = await importMapResolvers.Mutation.analyzeImportMap(null, { input: { importMapId: 'map-1', clientId: A } }, ctx);
    expect(result.errors).toEqual([]);
    const attributes = db.calls.filter((call) => call.table === 'attribute_register');
    expect(attributes.length).toBeGreaterThan(0);
    for (const call of attributes) expect(call.filters).toContainEqual(['or', `client_id.is.null,client_id.eq.${A}`]);
  });
});
