import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRecordRelationships, orderRelationshipGrids, relationshipGrids, singularRelatedRefs } from './relationship-grids';

describe('relationshipGrids', () => {
  it('lists parent types before child types', () => {
    const grids = relationshipGrids(
      [{ entityId: 'f1', domainCode: 'fund' }],
      [
        { entityId: 'p1', domainCode: 'POSITION' },
        { entityId: 's1', domainCode: 'security' },
      ],
    );
    assert.deepEqual(grids.map((grid) => `${grid.side}:${grid.domainCode}`), [
      'parent:FUND',
      'child:POSITION',
      'child:SECURITY',
    ]);
  });

  it('keeps one row per entity and gives members their own type grid', () => {
    const grids = relationshipGrids(
      [{
        entityId: 'f1',
        domainCode: 'FUND',
        members: [
          { entityId: 'f1', domainCode: 'FUND' },
          { entityId: 'i1', domainCode: 'INVESTOR' },
        ],
      }],
      [],
    );
    assert.deepEqual(
      grids.map((grid) => [grid.domainCode, grid.entityIds]),
      [
        ['FUND', ['f1']],
        ['INVESTOR', ['i1']],
      ],
    );
  });

  it('leaves out the entity being viewed', () => {
    const grids = relationshipGrids(
      [
        { entityId: 'self', domainCode: 'FUND' },
        { entityId: 'other', domainCode: 'FUND' },
      ],
      [],
      'self',
    );
    assert.deepEqual(grids[0].entityIds, ['other']);
  });

  it('returns nothing when there are no related entities', () => {
    assert.deepEqual(relationshipGrids([], []), []);
  });

  it('keeps the same type on both sides, parent first', () => {
    const grids = relationshipGrids(
      [{ entityId: 'p', domainCode: 'FUND' }],
      [{ entityId: 'c', domainCode: 'FUND' }],
    );
    assert.deepEqual(grids.map((grid) => [grid.side, grid.entityIds[0]]), [
      ['parent', 'p'],
      ['child', 'c'],
    ]);
  });
});

describe('classifyRecordRelationships', () => {
  it('presents a security stored as the parent of an issuer as its child', () => {
    const placed = classifyRecordRelationships(
      'ISSUER',
      [{ entityId: 'sec', domainCode: 'SECURITY' }, { entityId: 'hold', domainCode: 'ISSUER' }],
      [{ entityId: 'period', domainCode: 'FINANCIAL_PERIOD' }],
    );
    assert.deepEqual(placed.parents.map((row) => row.entityId), ['hold']);
    assert.deepEqual(placed.children.map((row) => row.entityId), ['period', 'sec']);
  });

  it('presents the issuer stored as the child of a security as its parent', () => {
    const placed = classifyRecordRelationships(
      'security',
      [{ entityId: 'fund', domainCode: 'FUND' }],
      [{ entityId: 'iss', domainCode: 'ISSUER' }, { entityId: 'price', domainCode: 'PRICE' }],
    );
    assert.deepEqual(placed.parents.map((row) => row.entityId), ['fund', 'iss']);
    assert.deepEqual(placed.children.map((row) => row.entityId), ['price']);
  });

  it('leaves other records unchanged', () => {
    const parents = [{ entityId: 'fund', domainCode: 'FUND' }];
    const children = [{ entityId: 'sec', domainCode: 'SECURITY' }];
    assert.deepEqual(classifyRecordRelationships('POSITION', parents, children), { parents, children });
  });
});

describe('singularRelatedRefs', () => {
  const relationships = [
    { relationshipCode: 'DEAL_ISSUER', parentDomainCode: 'DEAL', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE' },
    { relationshipCode: 'DEAL_SECURITY', parentDomainCode: 'DEAL', childDomainCode: 'SECURITY', cardinality: 'ONE_TO_MANY' },
    { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'SECURITY', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE' },
  ];
  const counts = [
    { relationshipCode: 'DEAL_ISSUER', parentDomainCode: 'DEAL', childDomainCode: 'ISSUER', linkCount: 17, maxPerParent: 1, maxPerChild: 3 },
    { relationshipCode: 'DEAL_SECURITY', parentDomainCode: 'DEAL', childDomainCode: 'SECURITY', linkCount: 30, maxPerParent: 3, maxPerChild: 2 },
    { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 302, maxPerParent: 9, maxPerChild: 1 },
  ];

  it('keeps the one issuer on a deal and drops the securities', () => {
    const kept = singularRelatedRefs('DEAL', [
      { entityId: 'iss', domainCode: 'ISSUER', relationshipCode: 'DEAL_ISSUER' },
      { entityId: 'sec', domainCode: 'SECURITY', relationshipCode: 'DEAL_SECURITY' },
    ], relationships, counts);
    assert.deepEqual(kept.map((row) => row.entityId), ['iss']);
  });

  it('drops deals and securities from an issuer', () => {
    const kept = singularRelatedRefs('ISSUER', [
      { entityId: 'deal', domainCode: 'DEAL', relationshipCode: 'DEAL_ISSUER' },
      { entityId: 'sec', domainCode: 'SECURITY', relationshipCode: 'SECURITY_ISSUER' },
    ], relationships, counts);
    assert.deepEqual(kept, []);
  });
});

describe('orderRelationshipGrids', () => {
  it('sorts each side by the entity type name', () => {
    const ordered = orderRelationshipGrids(
      [
        { side: 'child', domainCode: 'SECURITY', entityIds: ['s'] },
        { side: 'parent', domainCode: 'ISSUER', entityIds: ['i'] },
        { side: 'parent', domainCode: 'FUND', entityIds: ['f'] },
        { side: 'child', domainCode: 'POSITION', entityIds: ['p'] },
      ],
      { FUND: 'Fund', ISSUER: 'Issuer', SECURITY: 'Security', POSITION: 'Position' },
    );
    assert.deepEqual(ordered.map((grid) => grid.domainCode), ['FUND', 'ISSUER', 'POSITION', 'SECURITY']);
  });
});
