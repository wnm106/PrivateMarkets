import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entityTypeName, groupRecordsByType } from './entity-groups';

describe('entityTypeName', () => {
  it('prefers a registered name over the code and the search label', () => {
    assert.equal(entityTypeName('EXPECTED_DRAW', 'Expected Draw', 'EXPECTED_DRAW'), 'Expected Draw');
  });

  it('uses the search label when the registry only has the code', () => {
    assert.equal(entityTypeName('DEAL', 'DEAL', 'Deal'), 'Deal');
  });

  it('turns a bare code into words', () => {
    assert.equal(entityTypeName('EXPECTED_DRAW', 'EXPECTED_DRAW', ''), 'Expected Draw');
    assert.equal(entityTypeName('', '', ''), 'Record');
  });
});

describe('groupRecordsByType', () => {
  it('groups by type, links the type home and each record, and sorts by name', () => {
    const groups = groupRecordsByType(
      [
        { id: 'p2', entityName: 'Zebra position', domainCode: 'POSITION', domainName: 'Position' },
        { id: 'd1', entityName: 'Project Brightwater', domainCode: 'DEAL', domainName: 'Deal' },
        { id: 'p1', entityName: 'Alpha position', domainCode: 'POSITION', domainName: 'Position' },
        { id: 'd1', entityName: 'Project Brightwater', domainCode: 'DEAL', domainName: 'Deal' },
        { id: 'e1', entityName: 'Add-on acquisition', domainCode: 'EXPECTED_DRAW', domainName: 'EXPECTED_DRAW' },
      ],
      (record) => entityTypeName(record.domainCode, record.domainCode === 'EXPECTED_DRAW' ? 'Expected Draw' : record.domainName),
    );

    assert.deepEqual(
      groups.map((group) => ({
        name: group.name,
        href: group.href,
        records: group.records.map((record) => ({ name: record.entityName, href: record.href })),
      })),
      [
        { name: 'Deal', href: '/deals', records: [{ name: 'Project Brightwater', href: '/deals/d1' }] },
        { name: 'Expected Draw', href: '/expected-draws', records: [{ name: 'Add-on acquisition', href: '/expected-draws/e1' }] },
        {
          name: 'Position',
          href: '/positions',
          records: [
            { name: 'Alpha position', href: '/positions/p1' },
            { name: 'Zebra position', href: '/positions/p2' },
          ],
        },
      ],
    );
  });
});
