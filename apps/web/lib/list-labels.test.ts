import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { labelsFromValues, listLabel } from './list-labels';

describe('list labels', () => {
  const labels = labelsFromValues([
    { valueCode: '601010', valueLabel: 'Equity Real Estate Investment Trusts (REITs)' },
    { valueCode: '45', valueLabel: '' },
    { valueCode: ' ', valueLabel: 'blank code is ignored' },
  ]);

  it('shows the label for a stored code', () => {
    assert.equal(listLabel(labels, '601010'), 'Equity Real Estate Investment Trusts (REITs)');
    assert.equal(listLabel(labels, 601010), 'Equity Real Estate Investment Trusts (REITs)');
  });

  it('keeps the code when the list has no label or no such value', () => {
    assert.equal(listLabel(labels, '45'), '45');
    assert.equal(listLabel(labels, '999999'), '999999');
    assert.equal(listLabel(undefined, '601010'), '601010');
  });

  it('labels each code in a multi-valued attribute', () => {
    assert.equal(listLabel(labels, ['601010', '999999']), 'Equity Real Estate Investment Trusts (REITs), 999999');
    assert.equal(listLabel(labels, null), '');
  });
});

describe('list filters', () => {
  it('turns a typed label into the codes it means', async () => {
    const { labelsFromValues, listFilterToCodes, NO_LIST_MATCH } = await import('./list-labels');
    const labels = labelsFromValues([
      { valueCode: '601010', valueLabel: 'Diversified REITs' },
      { valueCode: '601025', valueLabel: 'Industrial REITs' },
      { valueCode: '451020', valueLabel: 'IT Services' },
    ]);
    assert.deepEqual(listFilterToCodes({ field: 'G', op: 'contains', value: 'reit' }, labels), { field: 'G', op: 'in', value: ['601010', '601025'] });
    assert.deepEqual(listFilterToCodes({ field: 'G', op: 'contains', value: '4510' }, labels), { field: 'G', op: 'in', value: ['451020'] });
    assert.deepEqual(listFilterToCodes({ field: 'G', op: 'eq', value: 'IT services' }, labels), { field: 'G', op: 'in', value: ['451020'] });
    assert.deepEqual(listFilterToCodes({ field: 'G', op: 'neq', value: 'IT Services' }, labels), { field: 'G', op: 'nin', value: ['451020'] });
    assert.deepEqual(listFilterToCodes({ field: 'G', op: 'contains', value: 'bank' }, labels), { field: 'G', op: 'in', value: [NO_LIST_MATCH] });
  });

  it('leaves other filters, and lists not loaded yet, as they are', async () => {
    const { listFilterToCodes } = await import('./list-labels');
    const blank = { field: 'G', op: 'isNull' };
    assert.deepEqual(listFilterToCodes(blank, new Map([['1', 'One']])), blank);
    const typed = { field: 'G', op: 'contains', value: 'reit' };
    assert.deepEqual(listFilterToCodes(typed, undefined), typed);
  });
});
