import { describe, expect, it } from 'vitest';
import { planTreeValues, type TreeAttribute } from './tree-values';
import { indexListParents, indexReferenceLists, listLevelKey, normalizeToList, type ListValueRow } from './values';

const rows: ListValueRow[] = [
  { list_code: 'GICS', value_code: '10', value_label: 'Energy', synonyms: ['ENERGY'], level: 1, parent_code: null },
  { list_code: 'GICS', value_code: '1010', value_label: 'Energy', synonyms: [], level: 2, parent_code: '10' },
  { list_code: 'GICS', value_code: '101020', value_label: 'Oil, Gas & Consumable Fuels', synonyms: [], level: 3, parent_code: '1010' },
  { list_code: 'GICS', value_code: '10102010', value_label: 'Integrated Oil & Gas', synonyms: [], level: 4, parent_code: '101020' },
  { list_code: 'GICS', value_code: '45', value_label: 'Information Technology', synonyms: ['IT'], level: 1, parent_code: null },
  { list_code: 'GICS', value_code: '4510', value_label: 'Software & Services', synonyms: [], level: 2, parent_code: '45' },
  { list_code: 'GICS', value_code: '451030', value_label: 'Software', synonyms: [], level: 3, parent_code: '4510' },
  { list_code: 'GICS', value_code: '45103010', value_label: 'Application Software', synonyms: [], level: 4, parent_code: '451030' },
  { list_code: 'CCY', value_code: 'USD', value_label: 'US Dollar', synonyms: [] },
];

const fields: Record<string, TreeAttribute> = {
  SECTOR: { listCode: 'GICS', level: 1, controllingCode: null },
  GROUP: { listCode: 'GICS', level: 2, controllingCode: 'SECTOR' },
  INDUSTRY: { listCode: 'GICS', level: 3, controllingCode: 'GROUP' },
  SUB: { listCode: 'GICS', level: 4, controllingCode: 'INDUSTRY' },
};
const attributeOf = (code: string) => fields[code];
const parents = indexListParents(rows);

describe('tree list matching', () => {
  const lists = indexReferenceLists(rows);

  it('matches a label within the field’s level', () => {
    expect(normalizeToList(lists, listLevelKey('GICS', 1), 'Energy')?.canonicalCode).toBe('10');
    expect(normalizeToList(lists, listLevelKey('GICS', 2), 'Energy')?.canonicalCode).toBe('1010');
  });

  it('does not match a value from another level', () => {
    expect(normalizeToList(lists, listLevelKey('GICS', 1), 'Software')?.matchType).toBe('unmapped');
  });

  it('keeps flat lists as they were', () => {
    expect(normalizeToList(lists, listLevelKey('CCY', null), 'us dollar')?.canonicalCode).toBe('USD');
    expect(indexListParents(rows).has('CCY')).toBe(false);
  });
});

describe('planTreeValues', () => {
  it('fills every level above a sub-industry', () => {
    const plan = planTreeValues(new Map([['SUB', '45103010']]), attributeOf, parents);
    expect(plan.conflicts).toEqual([]);
    expect(Object.fromEntries(plan.fills.map((fill) => [fill.attributeCode, fill.value]))).toEqual({ INDUSTRY: '451030', GROUP: '4510', SECTOR: '45' });
    expect(plan.fills.every((fill) => fill.from === 'SUB')).toBe(true);
  });

  it('fills only what the file left out', () => {
    const plan = planTreeValues(new Map([['SUB', '45103010'], ['GROUP', '4510']]), attributeOf, parents);
    expect(plan.fills.map((fill) => fill.attributeCode).sort()).toEqual(['INDUSTRY', 'SECTOR']);
  });

  it('flags a value under a different parent and fills nothing above it', () => {
    const plan = planTreeValues(new Map([['INDUSTRY', '451030'], ['GROUP', '1010']]), attributeOf, parents);
    expect(plan.conflicts).toEqual([{ attributeCode: 'INDUSTRY', value: '451030', controllingCode: 'GROUP', controllingValue: '1010', expected: '4510' }]);
    // The group the file gave still fills its sector.
    expect(plan.fills).toEqual([{ attributeCode: 'SECTOR', value: '10', from: 'GROUP' }]);
  });

  it('accepts a consistent set', () => {
    const plan = planTreeValues(new Map([['SECTOR', '10'], ['GROUP', '1010'], ['INDUSTRY', '101020'], ['SUB', '10102010']]), attributeOf, parents);
    expect(plan).toEqual({ fills: [], conflicts: [] });
  });

  it('ignores values that are not on the list', () => {
    expect(planTreeValues(new Map([['SUB', 'Widgets']]), attributeOf, parents)).toEqual({ fills: [], conflicts: [] });
  });
});
