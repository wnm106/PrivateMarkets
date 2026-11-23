import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateNumber, attributeAggregation, gridAggFunc, numericValue } from './grid-aggregation';

describe('grid aggregation', () => {
  it('uses the register, else totals by data type', () => {
    assert.equal(attributeAggregation('MAX', 'CURRENCY'), 'MAX');
    assert.equal(attributeAggregation('NONE', 'CURRENCY'), 'SUM');
    assert.equal(attributeAggregation(null, 'PERCENTAGE'), 'AVG');
    assert.equal(attributeAggregation('', 'STRING'), 'NONE');
  });

  it('maps to the grid function', () => {
    const valueOf = (data: any) => numericValue(data?.v);
    assert.equal(gridAggFunc('SUM', valueOf), 'sum');
    assert.equal(gridAggFunc('WEIGHTED_AVG', valueOf, null), 'avg');
    assert.equal(gridAggFunc('NONE', valueOf), undefined);
  });

  it('weights each row', () => {
    const fn = gridAggFunc('WEIGHTED_AVG', (d) => numericValue(d?.v), (d) => numericValue(d?.w)) as (p: any) => number | null;
    const rowNode = { allLeafChildren: [{ data: { v: 10, w: 1 } }, { data: { v: 20, w: 3 } }, { data: { v: null, w: 5 } }] };
    assert.equal(fn({ rowNode }), 17.5);
  });

  it('reads numbers and the grid average', () => {
    assert.equal(numericValue('1,250.5'), 1250.5);
    assert.equal(numericValue(''), null);
    assert.equal(aggregateNumber({ value: 4, count: 2 }), 4);
    assert.equal(aggregateNumber(7), 7);
  });
});
