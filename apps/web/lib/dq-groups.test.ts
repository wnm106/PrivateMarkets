import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupByEntityType, splitChangesByEntityType, splitRulesByEntityType } from './dq-groups';

describe('groupByEntityType', () => {
  it('keeps row order inside a type and sorts types by label', () => {
    const groups = groupByEntityType(
      [
        { name: 'Zebra fund', domainCode: 'FUND' },
        { name: 'Issuer A', domainCode: 'ISSUER' },
        { name: 'Alpha fund', domainCode: 'FUND' },
        { name: 'Shared', domainCode: null },
      ],
      (row) => row.domainCode,
      (code) => ({ FUND: 'Fund', ISSUER: 'Issuer' }[code] || code),
    );
    assert.deepEqual(groups.map((group) => [group.code, group.items.map((item) => item.name)]), [
      ['FUND', ['Zebra fund', 'Alpha fund']],
      ['ISSUER', ['Issuer A']],
      ['', ['Shared']],
    ]);
  });
});

describe('splitRulesByEntityType', () => {
  it('keeps a rule on its entity type', () => {
    const [rule] = splitRulesByEntityType([
      {
        domainCode: 'FUND',
        entityCount: 4,
        failingCount: 1,
        acceptedCount: 0,
        resolvedCount: 0,
        introducedCount: 0,
        failingEntities: [{ domainCode: 'FUND' }],
        acceptedEntities: [],
        resolvedEntities: [],
        introducedEntities: [],
      },
    ]);
    assert.equal(rule.domainCode, 'FUND');
    assert.equal(rule.checkedKnown, true);
    assert.equal(rule.entityCount, 4);
  });

  it('repeats an unscoped rule under each entity type that has a result', () => {
    const rows = splitRulesByEntityType([
      {
        domainCode: null,
        entityCount: 20,
        failingCount: 2,
        acceptedCount: 0,
        resolvedCount: 1,
        introducedCount: 0,
        failingEntities: [{ id: 'i', domainCode: 'ISSUER' }, { id: 'f', domainCode: 'FUND' }],
        acceptedEntities: [],
        resolvedEntities: [{ id: 'i', domainCode: 'ISSUER' }],
        introducedEntities: [],
      },
    ]);
    const issuer = rows.find((row) => row.domainCode === 'ISSUER');
    const fund = rows.find((row) => row.domainCode === 'FUND');
    assert.equal(issuer?.checkedKnown, false);
    assert.equal(issuer?.failingCount, 1);
    assert.equal(issuer?.resolvedCount, 1);
    assert.equal(fund?.failingCount, 1);
    assert.equal(fund?.resolvedCount, 0);
  });
});

describe('splitChangesByEntityType', () => {
  it('splits a shared attribute into one row per entity type', () => {
    const rows = splitChangesByEntityType([
      {
        attributeCode: 'COUNTRY',
        domainCode: null,
        changeCount: 2,
        changes: [
          { id: 'i1', domainCode: 'ISSUER' },
          { id: 'f1', domainCode: 'FUND' },
        ],
      },
    ]);
    assert.deepEqual(rows.map((row) => [row.domainCode, row.changeCount, row.changes.map((change) => change.id)]), [
      ['FUND', 1, ['f1']],
      ['ISSUER', 1, ['i1']],
    ]);
  });
});
