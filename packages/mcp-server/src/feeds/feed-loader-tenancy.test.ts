import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeParsedFeed } from './feed-loader';
import type { EntityResolutionDecision, FeedMap, ParsedTable } from './types';

/**
 * The loader writes with the service role, which row security does not hold
 * back. These run it against an in-memory database that holds two clients and
 * check that a load for one never reads out, matches, or writes to the other's
 * records, whatever the caller passes in.
 */

type Row = Record<string, any>;

const CLIENT_A = '00000000-0000-4000-8000-00000000000a';
const CLIENT_B = '00000000-0000-4000-8000-00000000000b';
const ACTOR = '00000000-0000-4000-8000-0000000000ac';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const B1 = '00000000-0000-4000-8000-0000000000b1';
const B_FUND = '00000000-0000-4000-8000-0000000000bf';
const A_CODE1 = '00000000-0000-4000-8000-0000000000c1';
const A_CODE2 = '00000000-0000-4000-8000-0000000000c2';
const B_CODE = '00000000-0000-4000-8000-0000000000c3';
const OPEN_SYSTEM_TO = '9999-12-31 23:59:59';
const LEI = '549300SHARED0000001';

interface Write {
  table: string;
  kind: 'insert' | 'update' | 'upsert';
  rows: Row[];
  patch?: Row;
}

/** Just enough of the PostgREST builder for the loader: filters, ranges, single rows, and writes. */
function memoryDatabase(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const writes: Write[] = [];
  const reads: { table: string; columns: string }[] = [];
  let sequence = 0;
  const rowsOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function query(name: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let payload: any = null;
    let columns = '*';
    let window: [number, number] | null = null;
    let one: 'single' | 'maybe' | null = null;

    const project = (row: Row) => {
      if (columns === '*' || /[:(]/.test(columns)) return { ...row };
      const out: Row = {};
      for (const column of columns.split(',').map((part) => part.trim()).filter(Boolean)) out[column] = row[column];
      return out;
    };

    const run = () => {
      const table = rowsOf(name);
      let result: Row[] = [];
      if (mode === 'select') {
        reads.push({ table: name, columns });
        result = table.filter((row) => filters.every((keep) => keep(row)));
      } else if (mode === 'insert' || mode === 'upsert') {
        const incoming: Row[] = (payload as Row[]).map((row) => ({ id: row.id || `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`, ...row }));
        if (name === 'entity_instances.master_entities') {
          // As the database: codes are unique within a client.
          const codes = new Set(table.map((row) => `${row.client_id}|${row.entity_code}`));
          const clash = incoming.find((row) => codes.has(`${row.client_id}|${row.entity_code}`));
          if (clash) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "master_entities_client_entity_code_key" Key (client_id, entity_code)=(${clash.client_id}, ${clash.entity_code}) already exists.` } };
          }
        }
        table.push(...incoming);
        writes.push({ table: name, kind: mode, rows: incoming });
        result = incoming;
      } else {
        const matched = table.filter((row) => filters.every((keep) => keep(row)));
        for (const row of matched) Object.assign(row, payload);
        writes.push({ table: name, kind: 'update', rows: matched.map((row) => ({ ...row })), patch: payload });
        result = matched;
      }
      let data: any = result.map(project);
      if (window) data = data.slice(window[0], window[1] + 1);
      if (one) {
        if (data.length === 0) return one === 'single' ? { data: null, error: { message: 'No rows found' } } : { data: null, error: null };
        data = data[0];
      }
      return { data, error: null };
    };

    const builder: any = {
      select(list = '*') { columns = list; return builder; },
      insert(rows: Row | Row[]) { mode = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return builder; },
      upsert(rows: Row | Row[]) { mode = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; return builder; },
      update(patch: Row) { mode = 'update'; payload = patch; return builder; },
      eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return builder; },
      neq(column: string, value: unknown) { filters.push((row) => row[column] != null && row[column] !== value); return builder; },
      in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return builder; },
      is(column: string, value: unknown) { filters.push((row) => (row[column] ?? null) === value); return builder; },
      gte(column: string, value: any) { filters.push((row) => row[column] >= value); return builder; },
      order() { return builder; },
      limit() { return builder; },
      range(from: number, to: number) { window = [from, to]; return builder; },
      single() { one = 'single'; return builder; },
      maybeSingle() { one = 'maybe'; return builder; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  const client = {
    supabaseUrl: 'http://127.0.0.1:54321',
    schema: (schema: string) => ({ from: (table: string) => query(`${schema}.${table}`) }),
    from: (table: string) => query(`public.${table}`),
  };
  return { client: client as unknown as SupabaseClient, tables, writes, reads };
}

function entityRow(id: string, code: string, name: string, clientId: string, domainCode = 'ISSUER'): Row {
  return { id, entity_code: code, entity_name: name, domain_code: domainCode, client_id: clientId, is_active: true, merged_into_id: null };
}

function leiRow(id: string, entityId: string): Row {
  return {
    id,
    entity_id: entityId,
    attribute_id: 'attr-lei',
    source_id: 'src-file',
    golden_value: LEI,
    golden_value_numeric: null,
    golden_value_date: null,
    valid_from: '2026-01-01',
    valid_to: '9999-12-31',
    system_from: '2026-01-01T00:00:00Z',
    system_to: OPEN_SYSTEM_TO,
    precedence_rank: 50,
    metadata: {},
  };
}

/**
 * Client A has two issuers called Acme with one LEI. Client B has a third with
 * the same name and LEI, a fund, and a record whose code a file may ask for.
 * Each client also has a ZETA 1 record, by a code spelled differently.
 */
function twoClients() {
  return memoryDatabase({
    'entity_instances.source_registry': [{ id: 'src-file', source_code: 'FILE', precedence_rank: 50 }],
    'metadata_register.domain_templates': [{ id: 'tpl-issuer', template_code: 'ISSUER_STD' }],
    'metadata_register.attribute_register': [
      { id: 'attr-lei', attribute_code: 'LEI', data_type: 'TEXT', reference_list_code: null, reference_domain_code: null },
    ],
    'metadata_register.reference_list_values': [],
    'metadata_register.relationship_types': [
      { relationship_code: 'FUND_ISSUER', parent_domain_code: 'FUND', child_domain_code: 'ISSUER', is_required: false, is_active: true },
    ],
    'metadata_register.entity_identifier_definitions': [{ domain_code: 'ISSUER', attribute_codes: ['LEI'], is_active: true }],
    'entity_instances.feed_maps': [],
    'entity_instances.entity_aliases': [],
    'entity_instances.entity_relationships': [],
    'entity_instances.feed_lineage': [],
    'entity_instances.master_entities': [
      entityRow(A1, 'ACME-A1', 'Acme', CLIENT_A),
      entityRow(A2, 'ACME-A2', 'Acme', CLIENT_A),
      entityRow(B1, 'ACME-B1', 'Acme', CLIENT_B),
      entityRow(B_FUND, 'FUND-B', 'Client B Fund', CLIENT_B, 'FUND'),
      entityRow('00000000-0000-4000-8000-0000000000b2', 'SECRET-DEAL', 'Project X', CLIENT_B),
      // Codes that read the same once punctuation is dropped: two of client A's, one of client B's.
      entityRow(A_CODE1, 'ZETA1', 'Zeta One', CLIENT_A),
      entityRow(A_CODE2, 'ZETA_1', 'Zeta Uno', CLIENT_A),
      entityRow(B_CODE, 'ZETA-1', 'Victim Holdings', CLIENT_B),
    ],
    'golden_master.entity_attribute_values': [leiRow('v-a1', A1), leiRow('v-a2', A2), leiRow('v-b1', B1)],
  });
}

const issuerMap = (parents: FeedMap['domains'][number]['parents'] = []): FeedMap => ({
  mapCode: 'TEST_ISSUERS',
  sourceCode: 'FILE',
  name: 'Issuers',
  description: 'Issuers for the tenancy test',
  domains: [{
    domainCode: 'ISSUER',
    templateCode: 'ISSUER_STD',
    identityColumn: 'Code',
    nameColumn: 'Name',
    attributes: [{ column: 'LEI', attributeCode: 'LEI' }],
    parents,
  }],
});

const fileOf = (rows: Record<string, string>[]): ParsedTable => ({ headers: Object.keys(rows[0]), rows });

const acmeRow = { Code: 'ACME-NEW', Name: 'Acme', LEI };

function touched(writes: Write[], id: string): Write[] {
  return writes.filter((write) => write.rows.some((row) => row.id === id || row.entity_id === id || row.parent_entity_id === id || row.child_entity_id === id));
}

describe('a load for one client', () => {
  it('offers only that client\'s records as choices, and reads nothing of the other\'s', async () => {
    const db = twoClients();
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([acmeRow]), '2026-09-30', db.client, CLIENT_A);

    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].candidates.map((item) => item.id).sort()).toEqual([A1, A2]);
    expect(JSON.stringify(result)).not.toContain('ACME-B1');
    expect(JSON.stringify(result)).not.toContain(B1);
    // Every read of records names the client. Codes are unique within a client, so nothing reads across clients.
    const entityReads = db.reads.filter((read) => read.table === 'entity_instances.master_entities');
    expect(entityReads.every((read) => read.columns.includes('id'))).toBe(true);
    expect(db.writes.filter((write) => write.table !== 'entity_instances.feed_maps')).toEqual([]);
  });

  it('offers only that client\'s records when a file code reads like another client\'s code', async () => {
    const db = twoClients();
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([{ Code: 'Zeta 1', Name: 'Zeta', LEI: '' }]), '2026-09-30', db.client, CLIENT_A);

    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].via).toBe('code');
    expect(result.resolutions[0].candidates.map((item) => item.id).sort()).toEqual([A_CODE1, A_CODE2]);
    expect(JSON.stringify(result)).not.toMatch(/ZETA-1|Victim/);
  });

  it('refuses a "map" choice of another client\'s record that reads like the file code', async () => {
    const db = twoClients();
    const decisions: EntityResolutionDecision[] = [{ domainCode: 'ISSUER', fileCode: 'Zeta 1', action: 'map', entityId: B_CODE }];
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([{ Code: 'Zeta 1', Name: 'Renamed by A', LEI: '' }]), '2026-09-30', db.client, CLIENT_A, undefined, { decisions, actorId: ACTOR });

    expect(result.errors).toContain('Zeta 1 was not mapped to one of the matching records.');
    expect(touched(db.writes, B_CODE)).toEqual([]);
    expect(db.tables.get('entity_instances.master_entities')!.find((row) => row.id === B_CODE)!.entity_name).toBe('Victim Holdings');
  });

  it('refuses a "map" choice that names another client\'s record, and writes nothing to it', async () => {
    const db = twoClients();
    const decisions: EntityResolutionDecision[] = [{ domainCode: 'ISSUER', fileCode: 'ACME-NEW', action: 'map', entityId: B1 }];
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([acmeRow]), '2026-09-30', db.client, CLIENT_A, undefined, { decisions, actorId: ACTOR });

    expect(result.errors).toContain('ACME-NEW was not mapped to one of the matching records.');
    expect(touched(db.writes, B1)).toEqual([]);
    expect(db.tables.get('entity_instances.master_entities')!.find((row) => row.id === B1)!.entity_name).toBe('Acme');
  });

  it('maps a row to the client\'s own record when the choice is one of the candidates', async () => {
    const db = twoClients();
    const decisions: EntityResolutionDecision[] = [{ domainCode: 'ISSUER', fileCode: 'ACME-NEW', action: 'map', entityId: A2 }];
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([acmeRow]), '2026-09-30', db.client, CLIENT_A, undefined, { decisions, actorId: ACTOR });

    expect(result.errors).toEqual([]);
    expect(result.domains[0]).toMatchObject({ matched: 1, created: 0, failed: 0 });
    expect(touched(db.writes, B1)).toEqual([]);
  });

  it('on "create", closes the shared identifier on the client\'s own records only, and records who did it', async () => {
    const db = twoClients();
    const decisions: EntityResolutionDecision[] = [{ domainCode: 'ISSUER', fileCode: 'ACME-NEW', action: 'create' }];
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([acmeRow]), '2026-09-30', db.client, CLIENT_A, undefined, { decisions, actorId: ACTOR });

    expect(result.errors).toEqual([]);
    expect(result.domains[0]).toMatchObject({ created: 1, failed: 0 });
    const values = db.tables.get('golden_master.entity_attribute_values')!;
    expect(values.find((row) => row.id === 'v-b1')!.system_to).toBe(OPEN_SYSTEM_TO);
    expect(values.find((row) => row.id === 'v-a1')!.system_to).not.toBe(OPEN_SYSTEM_TO);
    expect(values.find((row) => row.id === 'v-a2')!.system_to).not.toBe(OPEN_SYSTEM_TO);
    expect(touched(db.writes, B1)).toEqual([]);

    const created = db.tables.get('entity_instances.master_entities')!.find((row) => row.entity_code === 'ACME-NEW')!;
    expect(created).toMatchObject({ client_id: CLIENT_A, created_by: ACTOR, updated_by: ACTOR });
    const newValue = values.find((row) => row.entity_id === created.id)!;
    expect(newValue).toMatchObject({ created_by: ACTOR, updated_by: ACTOR });
  });

  it('creates a record whose code another client also uses, and leaves theirs alone', async () => {
    const db = twoClients();
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([{ Code: 'SECRET-DEAL', Name: 'Mine', LEI: '' }]), '2026-09-30', db.client, CLIENT_A);

    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Project X/i);
    const holders = db.tables.get('entity_instances.master_entities')!.filter((row) => row.entity_code === 'SECRET-DEAL');
    expect(holders.map((row) => row.client_id).sort()).toEqual([CLIENT_A, CLIENT_B].sort());
    expect(holders.find((row) => row.client_id === CLIENT_B)!.entity_name).toBe('Project X');
  });

  it('gives the same words when the database refuses the code at insert', async () => {
    const db = twoClients();
    // The code is taken in this client between the check and the insert.
    const original = db.client.schema.bind(db.client);
    let raced = false;
    (db.client as any).schema = (schema: string) => {
      const handle = original(schema);
      return {
        from(table: string) {
          const builder = handle.from(table);
          if (schema === 'entity_instances' && table === 'master_entities' && !raced) {
            const insert = builder.insert.bind(builder);
            builder.insert = (rows: Row | Row[]) => {
              raced = true;
              db.tables.get('entity_instances.master_entities')!.push(entityRow('00000000-0000-4000-8000-0000000000b3', 'LATE-CODE', 'Late', CLIENT_A));
              return insert(rows);
            };
          }
          return builder;
        },
      };
    };
    const result = await executeParsedFeed(issuerMap(), 'issuers.csv', fileOf([{ Code: 'LATE-CODE', Name: 'Mine', LEI: '' }]), '2026-09-30', db.client, CLIENT_A);

    expect(result.errors).toEqual(['LATE-CODE is not available as a record code. Use a different code.']);
    expect(db.tables.get('entity_instances.master_entities')!.filter((row) => row.entity_code.startsWith('LATE-CODE'))).toHaveLength(1);
  });

  it('does not link a row to a parent another client owns', async () => {
    const db = twoClients();
    const map = issuerMap([{ column: 'Fund', parentDomainCode: 'FUND', existing: true }]);
    const result = await executeParsedFeed(map, 'issuers.csv', fileOf([{ Code: 'ISS-NEW', Name: 'New Issuer', LEI: '', Fund: 'FUND-B' }]), '2026-09-30', db.client, CLIENT_A);

    expect(result.errors).toContain('ISSUER ISS-NEW references unknown FUND FUND-B');
    expect(db.tables.get('entity_instances.entity_relationships')).toEqual([]);
    expect(touched(db.writes, B_FUND)).toEqual([]);
  });
});
