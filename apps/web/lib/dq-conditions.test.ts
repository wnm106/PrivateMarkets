import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rowsFromExpression, rowsToExpression } from './dq-conditions';

const roundTrip = (expression: string) => {
  const { rows, raw } = rowsFromExpression(expression);
  assert.equal(raw, false, `${expression} should be buildable`);
  return rowsToExpression(rows);
};

describe('dq conditions', () => {
  it('round-trips the checks the builder understands', () => {
    const cases = [
      'ISIN IS NOT NULL',
      "ISIN IS NULL OR ISIN ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'",
      "COUNTRY IN ('US', 'GB') AND CURRENCY = 'USD'",
      'COUPON >= 0 AND COUPON <= 25',
      "MATURITY_DATE > CURRENT_DATE OR STATUS = 'CALLED'",
      'MATURITY_DATE >= START_OF_MONTH(CURRENT_DATE)',
      'ISSUE_DATE <= END_OF_MONTH(PRICING_DATE)',
      'INTEREST_COVERAGE_RATIO >= MIN_INTEREST_COVERAGE',
      "NAME LIKE '%FUND%' AND NAME ILIKE '%usd%'",
      "CURRENCY !~ '^[A-Z]{3}$'",
      "PAYMENT_STATUS NOT IN ('EXPECTED', 'RECEIVED') AND CASHFLOW_DATE < CURRENT_DATE",
    ];
    for (const expression of cases) {
      const out = roundTrip(expression);
      assert.equal(out.issue, null, expression);
      assert.equal(out.expression, expression);
    }
  });

  it('puts AND rows in a group and starts a new group at each OR', () => {
    const { rows } = rowsFromExpression("A = 1 AND B = 2 OR C = 3");
    assert.deepEqual(rows.map((row) => [row.attributeCode, row.conditionGroup]), [['A', 1], ['B', 1], ['C', 2]]);
  });

  it('shows A OR B as one group of two conditions', () => {
    const { rows } = rowsFromExpression('MARKET_CAP IS NULL OR MARKET_CAP >= 0');
    assert.deepEqual(rows.map((row) => [row.conditionGroup, row.logicOperator]), [[1, 'AND'], [1, 'OR']]);
    const mixed = rowsFromExpression('A = 1 OR B = 2 OR C = 3 AND D = 4').rows;
    assert.deepEqual(mixed.map((row) => [row.attributeCode, row.conditionGroup, row.logicOperator]), [['A', 1, 'AND'], ['B', 1, 'OR'], ['C', 2, 'AND'], ['D', 2, 'AND']]);
  });

  it('writes an ANY group as OR', () => {
    const { rows } = rowsFromExpression('A = 1 AND B = 2');
    const any = rows.map((row, index) => ({ ...row, logicOperator: index === 0 ? 'AND' as const : 'OR' as const }));
    assert.equal(rowsToExpression(any).expression, 'A = 1 OR B = 2');
  });

  it('reports an unfinished or unsupported row', () => {
    const { rows } = rowsFromExpression('A = 1');
    assert.match(rowsToExpression([{ ...rows[0], rightText: '' }]).issue || '', /number|value|compare/i);
    assert.ok(rowsToExpression([{ ...rows[0], rightText: 'A + 1' }]).issue);
    assert.ok(rowsToExpression([{ ...rows[0], attributeCode: '' }]).issue);
  });

  it('hands back text it cannot show as rows', () => {
    assert.equal(rowsFromExpression('(A = 1 OR B = 2) AND C = 3').raw, true);
  });
});
