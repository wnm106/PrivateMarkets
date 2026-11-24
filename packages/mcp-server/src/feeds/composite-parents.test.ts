import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EntityMatchIndex, identifierCatalog, type MatchEntity } from './entity-match';
import { createRecordLookup, identifierAttributes } from './feed-loader';
import type { FeedDomainSpec, FeedMap } from './types';

const FUND_ID = '11111111-1111-4111-8111-111111111111';
const SECURITY_ID = '22222222-2222-4222-8222-222222222222';
const POSITION_ID = '33333333-3333-4333-8333-333333333333';

const positionKey = identifierCatalog([['PORTFOLIO_FUND_ID', 'SECURITY_ID', 'TRADE_DATE']]);
const attributeMeta = new Map([
  ['PORTFOLIO_FUND_ID', { id: 'a1', data_type: 'REFERENCE', reference_domain_code: 'FUND', reference_list_code: null }],
  ['SECURITY_ID', { id: 'a2', data_type: 'REFERENCE', reference_domain_code: 'SECURITY', reference_list_code: null }],
  ['TRADE_DATE', { id: 'a3', data_type: 'DATE', reference_domain_code: null, reference_list_code: null }],
]);

function record(partial: Partial<MatchEntity> & Pick<MatchEntity, 'id' | 'code' | 'name' | 'domainCode'>): MatchEntity {
  return { clientId: 'client-1', active: true, provisional: false, identifiers: new Map(), ...partial };
}

function setup() {
  const funds = new EntityMatchIndex(identifierCatalog([]), 'FUND', 'client-1');
  funds.add(record({ id: FUND_ID, code: 'FND-7', name: 'Meridian Credit Fund II', domainCode: 'FUND' }));
  const securities = new EntityMatchIndex(identifierCatalog([['ISIN']]), 'SECURITY', 'client-1');
  securities.add(record({ id: SECURITY_ID, code: 'SEC-9', name: 'Apex Term Loan B', domainCode: 'SECURITY', identifiers: new Map([['ISIN', ['US0378331005']]]) }));
  // A stored position holds its fund and security as record ids and its trade date in ISO form.
  const positions = new EntityMatchIndex(positionKey, 'POSITION', 'client-1');
  positions.add(record({
    id: POSITION_ID, code: 'POS-STORED', name: 'Stored position', domainCode: 'POSITION',
    identifierTerms: new Map([
      ['PORTFOLIO_FUND_ID', [{ value: FUND_ID, validFrom: '2026-01-01', validTo: '9999-12-31' }]],
      ['SECURITY_ID', [{ value: SECURITY_ID, validFrom: '2026-01-01', validTo: '9999-12-31' }]],
      ['TRADE_DATE', [{ value: '2026-01-05', validFrom: '2026-01-01', validTo: '9999-12-31' }]],
    ]),
  }));
  const pass = { indexes: new Map([['FUND', funds], ['SECURITY', securities]]), ids: new Map<string, Map<string, string>>() };
  const lookup = createRecordLookup({} as SupabaseClient, 'client-1', pass, new Map());
  return { positions, lookup };
}

const domain: FeedDomainSpec = {
  domainCode: 'POSITION',
  templateCode: 'POSITION_STANDARD',
  identityColumn: 'position',
  nameColumn: 'position',
  attributes: [{ column: 'trade date', attributeCode: 'TRADE_DATE' }],
  parents: [
    { column: 'fund', parentDomainCode: 'FUND', existing: true },
    { column: 'isin', parentDomainCode: 'SECURITY', existing: true },
  ],
};
const map = { mapCode: 'TEST', sourceCode: 'TEST', name: 'Test', description: '', domains: [domain] } as FeedMap;
const catalog = { attributes: new Map() } as unknown as Parameters<typeof identifierAttributes>[3];

function draft(attributes: Record<string, string>, parents: Record<string, string>) {
  return {
    code: 'NEW-ROW-CODE',
    name: 'NEW-ROW-CODE',
    aliases: [],
    attributes: new Map(Object.entries(attributes)),
    parents: new Map(Object.entries(parents)),
    asOf: '2026-03-31',
    sourceCode: 'TEST',
    periods: new Map(),
  };
}

describe('composite keys that name parent records', () => {
  it('finds the parents by name and identifier and matches the stored position', async () => {
    const { positions, lookup } = setup();
    const row = draft({ TRADE_DATE: '1/5/2026' }, { FUND: 'Meridian Credit Fund II', SECURITY: 'US0378331005' });
    const attributes = await identifierAttributes(row, domain, map, catalog, positionKey, attributeMeta, lookup, row.asOf);
    expect(attributes.get('PORTFOLIO_FUND_ID')).toBe(FUND_ID);
    expect(attributes.get('SECURITY_ID')).toBe(SECURITY_ID);
    expect(attributes.get('TRADE_DATE')).toBe('2026-01-05');
    const hit = positions.resolve({ code: row.code, name: row.name, attributes }, row.asOf);
    expect(hit.kind === 'match' && [hit.entity.id, hit.via]).toEqual([POSITION_ID, 'identifier']);
  });

  it('looks up reference columns the file maps itself', async () => {
    const { positions, lookup } = setup();
    const row = draft({ PORTFOLIO_FUND_ID: 'FND 7', SECURITY_ID: 'Apex Term Loan B', TRADE_DATE: '2026-01-05' }, {});
    const attributes = await identifierAttributes(row, domain, map, catalog, positionKey, attributeMeta, lookup, row.asOf);
    const hit = positions.resolve({ code: row.code, name: row.name, attributes }, row.asOf);
    expect(hit.kind === 'match' && hit.entity.id).toBe(POSITION_ID);
  });

  it('does not match when one part names a different parent', async () => {
    const { positions, lookup } = setup();
    const row = draft({ TRADE_DATE: '1/5/2026' }, { FUND: 'Some Other Fund', SECURITY: 'US0378331005' });
    const attributes = await identifierAttributes(row, domain, map, catalog, positionKey, attributeMeta, lookup, row.asOf);
    expect(attributes.get('PORTFOLIO_FUND_ID')).toBe('Some Other Fund');
    expect(positions.resolve({ code: row.code, name: row.name, attributes }, row.asOf).kind).toBe('none');
  });

  it('does not tie a position to another client\'s fund or security', async () => {
    const funds = new EntityMatchIndex(identifierCatalog([]), 'FUND', 'client-1');
    funds.add(record({ id: 'their-fund', code: 'FND-X', name: 'Other Client Fund', domainCode: 'FUND', clientId: 'client-2' }));
    const securities = new EntityMatchIndex(identifierCatalog([['ISIN']]), 'SECURITY', 'client-1');
    securities.add(record({ id: 'their-sec', code: 'SEC-X', name: 'Other Client Loan', domainCode: 'SECURITY', clientId: 'client-2', identifiers: new Map([['ISIN', ['US9999999999']]]) }));
    const pass = { indexes: new Map([['FUND', funds], ['SECURITY', securities]]), ids: new Map<string, Map<string, string>>() };
    const lookup = createRecordLookup({} as SupabaseClient, 'client-1', pass, new Map());
    const row = draft({ TRADE_DATE: '1/5/2026' }, { FUND: 'FND-X', SECURITY: 'US9999999999' });
    const attributes = await identifierAttributes(row, domain, map, catalog, positionKey, attributeMeta, lookup, row.asOf);
    expect(attributes.get('PORTFOLIO_FUND_ID')).toBe('FND-X');
    expect(attributes.get('SECURITY_ID')).toBe('US9999999999');
    expect((await lookup('FUND', 'Other Client Fund', row.asOf)).kind).toBe('none');
  });

  it('finds a parent the same file loads by its code in the file', async () => {
    const { lookup } = setup();
    const pass = { indexes: new Map<string, EntityMatchIndex>(), ids: new Map([['FUND', new Map([['NEW-FUND', 'dry:FUND:NEW-FUND']])]]) };
    const fileLookup = createRecordLookup({} as SupabaseClient, 'client-1', pass, new Map());
    expect(await fileLookup('FUND', 'NEW-FUND', '2026-03-31')).toEqual({ kind: 'match', id: 'dry:FUND:NEW-FUND', via: 'code' });
    expect((await lookup('FUND', 'meridian credit fund ii', '2026-03-31')).kind).toBe('match');
  });
});
