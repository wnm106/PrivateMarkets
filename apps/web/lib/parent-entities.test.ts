import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeParentColumns, parentEntityColumns, recordParentLinks, withParentNames } from './parent-entities';

const relationships = [
  { relationshipCode: 'POSITION_FUND', parentDomainCode: 'FUND', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationshipCode: 'POSITION_SECURITY', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationshipCode: 'SECURITY_POSITION', parentDomainCode: 'SECURITY', childDomainCode: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'SECURITY', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE' },
  { relationshipCode: 'ISSUER_SECURITY', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', cardinality: 'ONE_TO_MANY' },
  { relationshipCode: 'COMMITMENT_FUND', parentDomainCode: 'INVESTOR_COMMITMENT', childDomainCode: 'FUND', cardinality: 'MANY_TO_ONE' },
];

const names = { FUND: 'Fund', SECURITY: 'Security', ISSUER: 'Issuer' };

describe('parentEntityColumns', () => {
  it('lists a position as its fund and its security', () => {
    const columns = parentEntityColumns('POSITION', relationships, names);
    assert.deepEqual(columns.map((column) => column.header), ['Fund', 'Security']);
    assert.equal(columns.find((column) => column.domainCode === 'SECURITY')?.relationshipCode, 'POSITION_SECURITY');
    assert.equal(columns.every((column) => column.direction === 'UP' && column.field === 'entity_name'), true);
  });

  it('follows stored links when the declared parent and child are reversed', () => {
    const columns = parentEntityColumns('SECURITY', relationships, names, [
      { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 302 },
      { relationshipCode: 'ISSUER_SECURITY', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 300 },
    ]);
    assert.equal(columns.length, 1);
    assert.equal(columns[0].domainCode, 'ISSUER');
    assert.equal(columns[0].relationshipCode, 'SECURITY_ISSUER');
    assert.equal(columns[0].header, 'Issuer');
  });

  it('does not add a column for a many-to-one child', () => {
    const columns = parentEntityColumns('FUND', relationships, { FUND: 'Fund' });
    assert.deepEqual(columns, []);
  });

  it('lists the fund a capital activity belongs to', () => {
    const columns = parentEntityColumns('CAPITAL_ACTIVITY', [
      { relationshipCode: 'ACTIVITY_FUND', parentDomainCode: 'CAPITAL_ACTIVITY', childDomainCode: 'FUND', cardinality: 'MANY_TO_ONE' },
    ], names);
    assert.equal(columns.length, 1);
    assert.equal(columns[0].domainCode, 'FUND');
    assert.equal(columns[0].direction, 'DOWN');
    assert.equal(columns[0].header, 'Fund');
  });
});

describe('recordParentLinks', () => {
  it('lists a fund stored as the child of a position', () => {
    const links = recordParentLinks(
      [],
      [
        { childEntityId: 'fund', childEntityName: 'Halyard Senior Credit Fund II', childDomainCode: 'FUND', relationshipCode: 'POSITION_FUND' },
        { childEntityId: 'sec', childEntityName: 'Atlas Industrial Rentals loan', childDomainCode: 'SECURITY', relationshipCode: 'POSITION_SECURITY' },
        { childEntityId: 'other', childEntityName: 'Not a parent', childDomainCode: 'CASH_FLOW', relationshipCode: 'POSITION_CASHFLOW' },
      ],
      [
        ...relationships,
        { relationshipCode: 'POSITION_CASHFLOW', parentDomainCode: 'POSITION', childDomainCode: 'CASH_FLOW', cardinality: 'ONE_TO_MANY' },
      ],
    );
    assert.deepEqual(links.map((link) => link.entityName), ['Halyard Senior Credit Fund II', 'Atlas Industrial Rentals loan']);
  });

  it('lists the fund on a capital activity and not the activities on a fund', () => {
    const types = [
      { relationshipCode: 'ACTIVITY_FUND', parentDomainCode: 'CAPITAL_ACTIVITY', childDomainCode: 'FUND', cardinality: 'MANY_TO_ONE' },
    ];
    const activity = recordParentLinks(
      [],
      [{ childEntityId: 'fund', childEntityName: 'Halyard Senior Credit Fund II', childDomainCode: 'FUND', relationshipCode: 'ACTIVITY_FUND' }],
      types,
      'CAPITAL_ACTIVITY',
    );
    const fund = recordParentLinks(
      [{ parentEntityId: 'act', parentEntityName: 'Call 1', parentDomainCode: 'CAPITAL_ACTIVITY', relationshipCode: 'ACTIVITY_FUND' }],
      [],
      types,
      'FUND',
    );
    assert.deepEqual(activity.map((link) => link.entityName), ['Halyard Senior Credit Fund II']);
    assert.deepEqual(fund, []);
  });
});

describe('withParentNames', () => {
  it('fills a blank parent from the opposite direction', () => {
    const rows = withParentNames(
      [{ 'fund.entity_name': '', 'fundAlt.entity_name': 'Halyard Senior Credit Fund II' }],
      [{ alias: 'fund', field: 'entity_name' }],
    );
    assert.equal(rows[0]['fund.entity_name'], 'Halyard Senior Credit Fund II');
  });
});

describe('mergeParentColumns', () => {
  it('keeps an explicit column for a domain the catalog also finds', () => {
    const explicit = [{
      alias: 'fund',
      label: 'Fund',
      direction: 'UP' as const,
      relationshipCode: 'POSITION_FUND',
      domainCode: 'FUND',
      field: 'entity_name',
      header: 'Fund',
    }];
    const discovered = parentEntityColumns('POSITION', relationships, names);
    const merged = mergeParentColumns(explicit, discovered);
    assert.equal(merged.filter((column) => column.domainCode === 'FUND').length, 1);
    assert.equal(merged.some((column) => column.domainCode === 'SECURITY'), true);
  });
});
