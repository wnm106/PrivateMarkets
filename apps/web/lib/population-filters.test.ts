import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conditionsFromInput, conditionsToInput, filterSummary, sameConditions } from './population-filters';

const rows = [
  { appliesTo: 'BASE', conditionGroup: 1, conditionOrder: 1, attributeCode: 'STATUS', operator: 'equals', value: 'ACTIVE', logicOperator: 'AND' },
  {
    appliesTo: 'BASE', conditionGroup: 1, conditionOrder: 2, attributeCode: 'REGION', operator: 'in', value: '["EU","US"]', logicOperator: 'AND',
    attributeDimension: { relationshipPath: [{ relationshipCode: 'FUND_TO_MANAGER', direction: 'UP', recursive: false }] },
  },
];

describe('population filter conditions', () => {
  it('round-trips through the builder rows, keeping the relationship path', () => {
    const builder = conditionsFromInput(rows);
    assert.deepEqual(builder[1].attributePath, [{ relationshipCode: 'FUND_TO_MANAGER', direction: 'UP' }]);
    assert.equal(sameConditions(conditionsToInput(builder), rows.map((r) => JSON.parse(JSON.stringify(r)))), true);
  });

  it('drops lines with no attribute and turns a plain list into JSON', () => {
    const builder = conditionsFromInput([{ attributeCode: 'REGION', operator: 'in', value: 'EU, US' }, { attributeCode: '' }]);
    const out = conditionsToInput(builder);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, '["EU","US"]');
  });

  it('says what a filter asks in a line', () => {
    assert.equal(filterSummary(rows), 'STATUS = ACTIVE and REGION (related) in EU,US');
    assert.equal(filterSummary([]), 'No conditions');
  });
});
