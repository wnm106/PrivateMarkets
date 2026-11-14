import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { definingParentDomains, mergeParentColumns, parentEntityColumns, singularRelationshipCodes, toParentLinkCounts, withParentNames } from './parent-entities';

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

  it('leaves deals and securities off an issuer when each issuer can have many', () => {
    const relationships = [
      { relationshipCode: 'DEAL_ISSUER', parentDomainCode: 'DEAL', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE' },
      { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'SECURITY', childDomainCode: 'ISSUER', cardinality: 'ONE_TO_ONE' },
      { relationshipCode: 'ISSUER_SECURITY', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', cardinality: 'ONE_TO_MANY' },
    ];
    const counts = [
      { relationshipCode: 'DEAL_ISSUER', parentDomainCode: 'DEAL', childDomainCode: 'ISSUER', linkCount: 17, maxPerParent: 1, maxPerChild: 3 },
      { relationshipCode: 'SECURITY_ISSUER', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 302, maxPerParent: 9, maxPerChild: 1 },
      { relationshipCode: 'ISSUER_SECURITY', parentDomainCode: 'ISSUER', childDomainCode: 'SECURITY', linkCount: 300, maxPerParent: 9, maxPerChild: 1 },
    ];
    const names = { DEAL: 'Deal', ISSUER: 'Issuer', SECURITY: 'Security' };
    assert.deepEqual(parentEntityColumns('ISSUER', relationships, names, counts), []);
    assert.deepEqual(
      parentEntityColumns('DEAL', relationships, names, counts).map((column) => column.domainCode),
      ['ISSUER'],
    );
    assert.deepEqual(
      parentEntityColumns('SECURITY', relationships, names, counts).map((column) => column.domainCode),
      ['ISSUER'],
    );
    assert.deepEqual(
      [...singularRelationshipCodes('ISSUER', relationships, counts)],
      [],
    );
    assert.equal(singularRelationshipCodes('DEAL', relationships, counts).has('DEAL_ISSUER'), true);
  });

  it('leaves a deal tranche off a position whose parents are the fund and the security', () => {
    const withTranche = [
      ...relationships,
      { relationshipCode: 'POSITION_TRANCHE', parentDomainCode: 'POSITION', childDomainCode: 'DEAL_TRANCHE', cardinality: 'MANY_TO_ONE' },
    ];
    const names = { FUND: 'Fund', SECURITY: 'Security', DEAL_TRANCHE: 'Deal Tranche' };
    assert.deepEqual(
      parentEntityColumns('POSITION', withTranche, names).map((column) => column.domainCode),
      ['DEAL_TRANCHE', 'FUND', 'SECURITY'],
    );
    assert.deepEqual(
      parentEntityColumns('POSITION', withTranche, names, [], ['FUND', 'SECURITY', 'ISSUER', 'DEAL']).map((column) => column.header),
      ['Fund', 'Security'],
    );
    assert.equal(
      singularRelationshipCodes('POSITION', withTranche, [], ['FUND', 'SECURITY']).has('POSITION_TRANCHE'),
      false,
    );
  });

  it('reads the members of the intersection that is this entity type', () => {
    const intersections = [{
      intersectionCode: 'POSITION',
      isActive: true,
      members: [
        { domainCode: 'FUND' },
        { domainCode: 'SECURITY' },
        { domainCode: 'POSITION' },
      ],
    }];
    assert.deepEqual(definingParentDomains('POSITION', intersections), ['FUND', 'SECURITY']);
    assert.deepEqual(definingParentDomains('FUND', intersections), []);
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

describe('toParentLinkCounts', () => {
  it('reads the most records on each side', () => {
    const counts = toParentLinkCounts([
      { relationship_code: 'DEAL_ISSUER', parent_domain_code: 'DEAL', child_domain_code: 'ISSUER', link_count: 17, max_per_parent: 1, max_per_child: '3' },
    ]);
    assert.equal(counts[0].maxPerParent, 1);
    assert.equal(counts[0].maxPerChild, 3);
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
