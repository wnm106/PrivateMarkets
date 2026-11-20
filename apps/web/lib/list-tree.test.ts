import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fillAncestors, optionsAtLevel, optionsUnder, outsideParent, type TreeField, type TreeOption } from './list-tree';

const values: TreeOption[] = [
  { value: '10', parent: null, level: 1 },
  { value: '1010', parent: '10', level: 2 },
  { value: '101010', parent: '1010', level: 3 },
  { value: '10101010', parent: '101010', level: 4 },
  { value: '10101020', parent: '101010', level: 4 },
  { value: '101020', parent: '1010', level: 3 },
  { value: '10102010', parent: '101020', level: 4 },
  { value: '45', parent: null, level: 1 },
  { value: '4510', parent: '45', level: 2 },
  { value: '451030', parent: '4510', level: 3 },
  { value: '45103010', parent: '451030', level: 4 },
];
const all = new Map(values.map((value) => [value.value, value]));

const fields: Record<string, TreeField> = {
  SECTOR: { listCode: 'GICS', listLevel: 1, controllingCode: null },
  GROUP: { listCode: 'GICS', listLevel: 2, controllingCode: 'SECTOR' },
  INDUSTRY: { listCode: 'GICS', listLevel: 3, controllingCode: 'GROUP' },
  SUB: { listCode: 'GICS', listLevel: 4, controllingCode: 'INDUSTRY' },
};
const fieldOf = (code: string) => fields[code];

describe('optionsAtLevel', () => {
  it('keeps one level of the tree', () => {
    assert.deepEqual(optionsAtLevel(values, 3).map((value) => value.value), ['101010', '101020', '451030']);
  });

  it('keeps every value when the field takes no level', () => {
    assert.equal(optionsAtLevel(values, null).length, values.length);
  });
});

describe('optionsUnder', () => {
  const industries = optionsAtLevel(values, 3);

  it('offers only children of the controlling value', () => {
    assert.deepEqual(optionsUnder(industries, '1010', all).map((value) => value.value), ['101010', '101020']);
  });

  it('offers every choice when the controlling field is blank or off the list', () => {
    assert.equal(optionsUnder(industries, '', all).length, 3);
    assert.equal(optionsUnder(industries, 'Energy', all).length, 3);
  });
});

describe('outsideParent', () => {
  it('flags a value under a different parent', () => {
    assert.equal(outsideParent('451030', '1010', all), true);
  });

  it('accepts a child, and ignores blanks and values off the list', () => {
    assert.equal(outsideParent('101010', '1010', all), false);
    assert.equal(outsideParent('', '1010', all), false);
    assert.equal(outsideParent('101010', '', all), false);
    assert.equal(outsideParent('Oil', '1010', all), false);
  });
});

describe('fillAncestors', () => {
  it('fills every level above a picked sub-industry', () => {
    assert.deepEqual(fillAncestors('SUB', '45103010', fieldOf, all, {}), {
      SUB: '45103010',
      INDUSTRY: '451030',
      GROUP: '4510',
      SECTOR: '45',
    });
  });

  it('leaves levels that already hold the right value', () => {
    assert.deepEqual(fillAncestors('SUB', '10102010', fieldOf, all, { SECTOR: '10', GROUP: '1010', INDUSTRY: '101010' }), {
      SUB: '10102010',
      INDUSTRY: '101020',
    });
  });

  it('stops at a controlling field on another list', () => {
    const mixed = { ...fields, GROUP: { listCode: 'OTHER', listLevel: 2, controllingCode: 'SECTOR' } };
    assert.deepEqual(fillAncestors('INDUSTRY', '101010', (code) => mixed[code as keyof typeof mixed], all, {}), { INDUSTRY: '101010' });
  });

  it('does nothing above a top-level value', () => {
    assert.deepEqual(fillAncestors('SECTOR', '10', fieldOf, all, {}), { SECTOR: '10' });
  });
});
