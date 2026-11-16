import { describe, expect, it } from 'vitest';
import { normalizeAssignments, type MappingCatalog } from './pack-tables';

const catalog: MappingCatalog = {
  domains: ['POSITION', 'FUND', 'NAV_STATEMENT'],
  attributes: [
    { attributeCode: 'MARKET_VALUE', domainCode: 'POSITION' },
    { attributeCode: 'POSITION_MARK', domainCode: 'POSITION' },
  ],
};
const headers = ['Position ID', 'Investment', 'Fair Value', 'Fund', 'Comment'];

describe('normalizeAssignments', () => {
  it('fills in a partial mapping and leaves unmentioned columns out of the load', () => {
    const { assignments, problems } = normalizeAssignments(headers, [
      { sourceColumn: 'Position ID', role: 'identity', domainCode: 'POSITION' },
      { sourceColumn: 'Investment', role: 'name', domainCode: 'POSITION' },
      { sourceColumn: 'Fair Value', role: 'attribute', attributeCode: 'MARKET_VALUE', transform: { kind: 'number' } },
      { sourceColumn: 'Fund', role: 'parent', domainCode: 'POSITION', parentDomainCode: 'FUND', parentExisting: true },
    ], catalog);
    expect(problems).toEqual([]);
    expect(assignments.map((assignment) => assignment.sourceColumn)).toEqual(headers);
    expect(assignments[2]).toMatchObject({ role: 'attribute', domainCode: 'POSITION', attributeCode: 'MARKET_VALUE', transform: { kind: 'number' } });
    expect(assignments[3]).toMatchObject({ role: 'parent', parentDomainCode: 'FUND', parentExisting: true });
    expect(assignments[4]).toMatchObject({ role: 'ignore', domainCode: null, attributeCode: null, transform: { kind: 'none' } });
  });

  it('names a column, record type, or attribute that does not exist', () => {
    const { problems } = normalizeAssignments(headers, [
      { sourceColumn: 'Position ID', role: 'identity', domainCode: 'LOAN_POSITION' },
      { sourceColumn: 'Fair Value', role: 'attribute', domainCode: 'POSITION', attributeCode: 'FAIR_VALUE_USD' },
      { sourceColumn: 'Market Value', role: 'attribute', attributeCode: 'MARKET_VALUE' },
      { sourceColumn: 'Fund', role: 'parent', domainCode: 'POSITION' },
      { sourceColumn: 'Comment', role: 'filter' },
      { sourceColumn: 'Investment', role: 'name', domainCode: 'POSITION', transform: { kind: 'titlecase' } },
      { sourceColumn: 'Investment', role: 'ignore' },
    ], catalog);
    expect(problems).toEqual([
      '"Position ID" is mapped to the record type LOAN_POSITION, which does not exist.',
      '"Fair Value" is mapped to FAIR_VALUE_USD, which is not an attribute. Use a target from list_position_file_mapping_targets.',
      '"Market Value" is not a column of this table.',
      '"Fund" links to a parent record but does not say which type (parentDomainCode).',
      '"Comment" is a row filter but has no value to keep (filterEquals).',
      '"Investment" has the cleanup "titlecase". Use one of: none, trim, number, percent, date, uppercase, lowercase, list, replace.',
      '"Investment" is mapped twice.',
    ]);
  });

  it('refuses a mapping that cannot identify its records', () => {
    expect(normalizeAssignments(headers, [{ sourceColumn: 'Fair Value', role: 'attribute', attributeCode: 'MARKET_VALUE' }], catalog).problems[0]).toMatch(/No column identifies the records/);
    const orphan = normalizeAssignments(headers, [
      { sourceColumn: 'Fund', role: 'identity', domainCode: 'FUND' },
      { sourceColumn: 'Fair Value', role: 'attribute', attributeCode: 'MARKET_VALUE' },
    ], catalog);
    expect(orphan.problems.join(' ')).toMatch(/"Fair Value" belongs to POSITION, which has no identity column/);
  });
});
