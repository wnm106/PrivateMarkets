import { describe, expect, it } from 'vitest';
import { executeImportMap, findEntityByCode, type ImportMap } from './import-orchestrator';
import { fakeSupabase, filterValue, type FakeCall } from '../../testing/fake-supabase';

const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';

interface EntityRow { id: string; client_id: string; entity_code: string; domain_code: string }

/**
 * master_entities as the caller's connection sees it: someone in clients A and B reads both
 * clients' rows, so a lookup by code alone finds two. Other tables answer what the import needs.
 */
function database(rows: EntityRow[]) {
  const entities = [...rows];
  const db = fakeSupabase((call) => {
    if (call.table === 'master_entities' && call.op === 'select') {
      const eqs = call.filters.filter(([op]) => op === 'eq') as Array<[string, string, unknown]>;
      return { data: entities.filter((row) => eqs.every(([, column, value]) => (row as any)[column] === value)) };
    }
    if (call.table === 'master_entities' && call.op === 'insert') {
      const payload = call.payload as Omit<EntityRow, 'id'>;
      if (!payload.client_id) return { error: { code: '23502', message: 'null value in column "client_id" violates not-null constraint' } };
      const row = { ...payload, id: `new-${entities.length}` } as EntityRow;
      entities.push(row);
      return { data: row };
    }
    if (call.table === 'attribute_register') return { data: [{ attribute_code: 'isin', id: 'attr-isin', default_precedence_rank: 10, reference_list_code: null }] };
    if (call.table === 'source_registry') return { data: { id: 'src-import' } };
    if (call.fn === 'write_value') return { data: 'v' };
    return undefined;
  });
  return { ...db, entities };
}

const importOf = (records: object[], extra: Partial<ImportMap['domainMappings'][number]> = {}, domainCode = 'FUND'): ImportMap => ({
  name: 'test',
  sourceFormat: 'json',
  sourceData: JSON.stringify(records),
  domainMappings: [{ domainCode, fieldMappings: [{ sourceField: 'isin', targetAttribute: 'isin', confidence: 1, mappingType: 'manual' } as any], ...extra }],
  options: { skipValidation: true },
});

const entityInserts = (calls: FakeCall[]) => calls.filter((call) => call.table === 'master_entities' && call.op === 'insert');
const entityLookups = (calls: FakeCall[]) => calls.filter((call) => call.table === 'master_entities' && call.op === 'select');

describe('executeImportMap in one client', () => {
  it('creates the record in the working client when another client already has the code', async () => {
    const db = database([{ id: 'b-fund', client_id: CLIENT_B, entity_code: 'FUND-X1', domain_code: 'FUND' }]);
    const result = await executeImportMap(importOf([{ isin: 'x1' }]), db.client, CLIENT_A, 'user-1');

    expect(result.errors).toEqual([]);
    expect(result.results[0]).toMatchObject({ recordsCreated: 1, recordsUpdated: 0, recordsFailed: 0 });
    expect(entityInserts(db.calls)[0].payload).toMatchObject({ entity_code: 'FUND-X1', domain_code: 'FUND', client_id: CLIENT_A });
    for (const lookup of entityLookups(db.calls)) expect(filterValue(lookup, 'eq', 'client_id')).toBe(CLIENT_A);
    // Client B's record is not touched.
    expect(db.calls.some((call) => call.fn === 'write_value' && (call.payload as any).p_entity_id === 'b-fund')).toBe(false);
  });

  it('updates the working client\'s record, not the other client\'s with the same code', async () => {
    const db = database([
      { id: 'b-fund', client_id: CLIENT_B, entity_code: 'FUND-X1', domain_code: 'FUND' },
      { id: 'a-fund', client_id: CLIENT_A, entity_code: 'FUND-X1', domain_code: 'FUND' },
    ]);
    const result = await executeImportMap(importOf([{ isin: 'x1' }]), db.client, CLIENT_A, 'user-1');

    expect(result.results[0]).toMatchObject({ recordsCreated: 0, recordsUpdated: 1, recordsFailed: 0 });
    expect(entityInserts(db.calls)).toEqual([]);
    const written = db.calls.filter((call) => call.fn === 'write_value').map((call) => (call.payload as any).p_entity_id);
    expect(written).toEqual(['a-fund']);
  });

  it('links a child to the parent with that code in the working client', async () => {
    const db = database([
      { id: 'b-issuer', client_id: CLIENT_B, entity_code: 'ISSUER-P1', domain_code: 'ISSUER' },
      { id: 'a-issuer', client_id: CLIENT_A, entity_code: 'ISSUER-P1', domain_code: 'ISSUER' },
    ]);
    const map = importOf([{ isin: 'x1', issuer: 'p1' }], {
      relationshipMappings: [{ relationshipCode: 'ISSUER_SECURITY', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', parentKeyField: 'issuer', childKeyField: 'isin' }],
    }, 'SECURITY');
    const result = await executeImportMap(map, db.client, CLIENT_A);

    expect(result.results[0]).toMatchObject({ recordsCreated: 1, recordsFailed: 0 });
    const link = db.calls.find((call) => call.table === 'entity_relationships' && call.op === 'insert');
    expect(link?.payload).toMatchObject({ parent_entity_id: 'a-issuer', child_entity_id: 'new-2' });
  });

  it('refuses to run without a client', async () => {
    const db = database([]);
    await expect(executeImportMap(importOf([{ isin: 'x1' }]), db.client, '')).rejects.toThrow(/Choose the client/);
    expect(db.calls).toEqual([]);
  });
});

describe('findEntityByCode', () => {
  it('fails on a read error instead of reporting no record', async () => {
    const db = fakeSupabase(() => ({ error: { code: '42501', message: 'permission denied for view master_entities' } }));
    await expect(findEntityByCode(db.client, CLIENT_A, 'FUND', 'FUND-X1')).rejects.toThrow();
  });

  it('fails when more than one record answers, instead of treating the code as new', async () => {
    const db = fakeSupabase(() => ({ data: [{ id: 'one' }, { id: 'two' }] }));
    await expect(findEntityByCode(db.client, CLIENT_A, 'FUND', 'FUND-X1')).rejects.toThrow(/More than one FUND record/);
  });
});
