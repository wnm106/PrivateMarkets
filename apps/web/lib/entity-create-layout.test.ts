import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCreateAttributes } from './entity-create-layout';

describe('groupCreateAttributes', () => {
  it('keeps template attributes in their display sections and column counts', () => {
    const groups = groupCreateAttributes(
      [
        { name: 'Sector', displaySection: 'Classification', displayGroup: 20, displayOrder: 4 },
        { name: 'Issuer Legal Name', displaySection: 'Identity', displayGroup: 1, displayOrder: 1 },
        { name: 'State / Region Code', displaySection: 'Identity', displayGroup: 3, displayOrder: 3 },
        { name: 'Country', displaySection: null, displayGroup: 0, displayOrder: 2 },
      ],
      [],
      [
        { sectionName: 'Identity', displayOrder: 0, columnCount: 2 },
        { sectionName: 'Classification', displayOrder: 10, columnCount: 4 },
      ],
    );

    assert.deepEqual(
      groups.map((group) => ({
        section: group.section,
        columnCount: group.columnCount,
        names: group.items.map((item) => item.name),
      })),
      [
        { section: 'Identity', columnCount: 2, names: ['Issuer Legal Name', 'State / Region Code'] },
        { section: 'Classification', columnCount: 4, names: ['Sector'] },
        { section: 'General', columnCount: 4, names: ['Country'] },
      ],
    );
  });

  it('uses the template section when the template assigns one', () => {
    const groups = groupCreateAttributes(
      [
        { name: 'Cash', templateSection: 'Assets', displaySection: 'Balance sheet', displayOrder: 2, displayGroup: 1 },
        { name: 'Revenue', templateSection: 'Income', displaySection: 'Income statement', displayOrder: 1, displayGroup: 1 },
        { name: 'Investments', templateSection: 'assets', displaySection: 'Balance sheet', displayOrder: 1, displayGroup: 2 },
      ],
      [
        { sectionName: 'Assets', displayOrder: 0 },
        { sectionName: 'Income', displayOrder: 10 },
      ],
      [
        { sectionName: 'Income statement', displayOrder: 0, columnCount: 1 },
        { sectionName: 'Assets', displayOrder: 50, columnCount: 3 },
      ],
    );

    assert.deepEqual(
      groups.map((group) => [group.section, group.columnCount, group.items.map((item) => item.name)]),
      [
        ['Assets', 3, ['Investments', 'Cash']],
        ['Income', 4, ['Revenue']],
      ],
    );
  });
});
