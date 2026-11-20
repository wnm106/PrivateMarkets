import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entitiesFromConflicts, fieldsForEntity, valuesAgree, type ConflictRow, type LineageField } from './conflict-resolution';

const spread: ConflictRow = {
  id: 'e1',
  entityCode: 'SEC-1',
  entityName: 'Bench Security 1',
  domainCode: 'SECURITY',
  attributeCode: 'SPREAD',
  attributeName: 'Spread (bps)',
  goldenSourceCode: 'MANUAL',
  goldenSourceName: 'Manual Entry',
  goldenValue: '150',
  sourceCode: 'BLOOMBERG',
  sourceName: 'Bloomberg',
  value: '175',
};

describe('conflict resolution', () => {
  it('treats the same number in different text as agreement', () => {
    assert.equal(valuesAgree('8.50', '8.5'), true);
    assert.equal(valuesAgree(' BlueRiver ', 'blueriver'), true);
    assert.equal(valuesAgree('150', '175'), false);
    assert.equal(valuesAgree('', '175'), false);
  });

  it('lists each record once, with the most conflicts first', () => {
    const rows = entitiesFromConflicts([
      spread,
      { ...spread, id: 'e2', entityName: 'Alpha', attributeCode: 'COUPON', value: '1' },
      { ...spread, id: 'e2', attributeCode: 'MATURITY', sourceCode: 'WSO', value: '2' },
    ]);
    assert.deepEqual(rows.map((row) => [row.entityName, row.conflictCount]), [
      ['Alpha', 2],
      ['Bench Security 1', 1],
    ]);
  });

  it('builds a field from lineage and leaves out a field whose sources agree', () => {
    const lineage: LineageField[] = [
      {
        attributeCode: 'SPREAD',
        attributeName: 'Spread (bps)',
        currentValue: '150',
        resolutionRule: 'Manual, then Bloomberg',
        competingValues: [
          { source: 'MANUAL', sourceName: 'Manual Entry', value: '150', precedenceRank: 1, receivedAt: '2026-05-19' },
          { source: 'BLOOMBERG', sourceName: 'Bloomberg', value: '175', precedenceRank: 2, receivedAt: '2026-05-20' },
          { source: 'WSO', sourceName: 'WSO', value: '  ', precedenceRank: 3 },
        ],
      },
      {
        attributeCode: 'NAME',
        attributeName: 'Name',
        currentValue: 'Northwind',
        resolutionRule: null,
        competingValues: [
          { source: 'MANUAL', sourceName: 'Manual Entry', value: 'Northwind', precedenceRank: 1 },
          { source: 'BLOOMBERG', sourceName: 'Bloomberg', value: 'northwind', precedenceRank: 2 },
        ],
      },
    ];
    const fields = fieldsForEntity(lineage, [spread]);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].attributeName, 'Spread (bps)');
    assert.deepEqual(fields[0].candidates.map((row) => row.source), ['MANUAL', 'BLOOMBERG']);
    assert.equal(fields[0].candidates[0].golden, true);
    assert.equal(fields[0].rule, 'Manual, then Bloomberg');
  });

  it('uses the score rows when lineage has not loaded that field', () => {
    const fields = fieldsForEntity([], [spread, { ...spread, sourceCode: 'WSO', sourceName: 'WSO', value: '160' }]);
    assert.equal(fields.length, 1);
    assert.deepEqual(fields[0].candidates.map((row) => [row.source, row.value]), [
      ['MANUAL', '150'],
      ['BLOOMBERG', '175'],
      ['WSO', '160'],
    ]);
  });
});
