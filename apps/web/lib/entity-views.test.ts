import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VIEW_ROW_RECORDS, nextLookupAlias, viewGridField, viewGridRequest, viewRows, withoutLookup } from './entity-views';

const view = {
  domainCode: 'POSITION',
  lookups: [
    { alias: 'r1', direction: 'UP' as const, domainCode: 'SECURITY', label: 'Security' },
    { alias: 'r2', direction: 'UP' as const, domainCode: 'ISSUER', from: 'r1', label: 'Issuer' },
  ],
  columns: [
    { field: 'entity_name' },
    { field: 'MARKET_VALUE' },
    { field: 'r1.PRICE', source: 'BLOOMBERG' },
    { field: 'r1.PRICE', source: 'GOLDEN' },
    { field: 'r2.RATING' },
  ],
  sort: [{ field: 'r1.PRICE@BLOOMBERG', dir: 'desc' as const }],
};

describe('entity views', () => {
  it('reads golden unless a column names a source', () => {
    assert.equal(viewGridField({ field: 'PRICE' }), 'PRICE');
    assert.equal(viewGridField({ field: 'PRICE', source: 'GOLDEN' }), 'PRICE');
    assert.equal(viewGridField({ field: 'r1.PRICE', source: 'WSO' }), 'r1.PRICE@WSO');
  });

  it('asks the grid for each related column both ways round', () => {
    const request = viewGridRequest(view, { asOfDate: '2026-11-21', knowledgeDate: '2026-11-22' });
    assert.deepEqual(request.columns, [
      'MARKET_VALUE', 'r1.PRICE@BLOOMBERG', 'r1.PRICE', 'r2.RATING',
      'r1_alt.PRICE@BLOOMBERG', 'r1_alt.PRICE', 'r2_alt.RATING',
      'r1.entity_id', 'r1.entity_name', 'r1_alt.entity_id', 'r1_alt.entity_name',
      'r2.entity_id', 'r2.entity_name', 'r2_alt.entity_id', 'r2_alt.entity_name',
    ]);
    assert.deepEqual(request.lookups.map((l) => `${l.alias}:${l.direction}`), ['r1:UP', 'r2:UP', 'r1_alt:DOWN', 'r2_alt:DOWN']);
    assert.equal(request.asOfDate, '2026-11-21');
    assert.deepEqual(request.sort, [{ field: 'r1.PRICE@BLOOMBERG', dir: 'desc' }]);
  });

  it('takes a related value from whichever side has it', () => {
    const [row] = viewRows([{ entity_id: 'p1', entity_name: 'Pos', 'r1.PRICE@BLOOMBERG': null, 'r1_alt.PRICE@BLOOMBERG': 101, 'r1.PRICE': 100 }], view);
    assert.equal(row['r1.PRICE@BLOOMBERG'], 101);
    assert.equal(row['r1.PRICE'], 100);
    assert.equal(row['r2.RATING'], null);
  });

  it('notes the related record each value came from', () => {
    const [row] = viewRows([{
      entity_id: 'p1',
      'r1.entity_id': 's1', 'r1.entity_name': 'Sec One',
      'r1_alt.entity_id': 's2', 'r1_alt.entity_name': 'Sec Two',
      'r1.PRICE@BLOOMBERG': null, 'r1_alt.PRICE@BLOOMBERG': 101, 'r1.PRICE': 100,
    }], view);
    const records = row[VIEW_ROW_RECORDS] as Record<string, { id: string; name: string }>;
    assert.deepEqual(records['r1.PRICE'], { id: 's1', name: 'Sec One' });
    assert.deepEqual(records['r1.PRICE@BLOOMBERG'], { id: 's2', name: 'Sec Two' });
    assert.equal(records['r2.RATING'], undefined);
  });

  it('removes a related entity with what hangs off it', () => {
    const next = withoutLookup(view, 'r1');
    assert.deepEqual(next.lookups, []);
    assert.deepEqual(next.columns.map((c) => c.field), ['entity_name', 'MARKET_VALUE']);
    assert.deepEqual(next.sort, []);
    assert.equal(nextLookupAlias(view.lookups), 'r3');
  });
});

describe('related entities a view can reach', () => {
  const types = [
    { relationshipCode: 'POSITION_SECURITY', parentDomainCode: 'POSITION', childDomainCode: 'SECURITY' },
    { relationshipCode: 'SECURITY_POSITION', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION' },
    { relationshipCode: 'POSITION_FUND', parentDomainCode: 'POSITION', childDomainCode: 'FUND' },
    { relationshipCode: 'OLD', parentDomainCode: 'POSITION', childDomainCode: 'DEAL', isActive: false },
  ];

  it('lists each related entity type once, by type', async () => {
    const { relatedEntities } = await import('./entity-views');
    assert.deepEqual(relatedEntities('POSITION', types, { SECURITY: 'Security' }), [
      { domainCode: 'FUND', label: 'Fund', direction: 'DOWN' },
      { domainCode: 'SECURITY', label: 'Security', direction: 'UP' },
    ]);
  });

  it('reuses a lookup for the same entity and drops unused ones', async () => {
    const { ensureLookup, pruneLookups } = await import('./entity-views');
    const start = { lookups: [] as any[], columns: [] as any[] };
    const first = ensureLookup(start, null, { domainCode: 'SECURITY', label: 'Security', direction: 'UP' });
    const again = ensureLookup(first.view, null, { domainCode: 'SECURITY', label: 'Security', direction: 'UP' });
    assert.equal(again.alias, first.alias);
    assert.equal(again.view.lookups.length, 1);
    assert.equal(again.view.lookups[0].relationshipCode, undefined);
    const chained = ensureLookup(again.view, first.alias, { domainCode: 'ISSUER', label: 'Issuer', direction: 'UP' });
    const used = pruneLookups({ ...chained.view, columns: [{ field: `${chained.alias}.RATING` }] });
    assert.deepEqual(used.lookups.map((l: any) => l.alias), [first.alias, chained.alias]);
    assert.deepEqual(pruneLookups({ ...chained.view, columns: [] }).lookups, []);
  });
});

describe('viewGridRequest population filter', () => {
  const view = { domainCode: 'FUND', columns: [{ field: 'entity_name' }], lookups: [], sort: [] };
  it('leaves populationConditions out when there is no filter', () => {
    assert.equal('populationConditions' in viewGridRequest(view, {}), false);
  });
  it('sends the conditions it is given', () => {
    const rows = [{ attributeCode: 'STATUS', operator: 'equals', value: 'ACTIVE' }];
    assert.deepEqual(viewGridRequest(view, {}, 10000, rows).populationConditions, rows);
  });
});
