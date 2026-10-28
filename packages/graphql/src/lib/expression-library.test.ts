import { describe, expect, it } from 'vitest';
import { evalExpression, listExpressionFunctions, type Expression } from './expression-library';

describe('expression function library', () => {
  it('evaluates the callable row functions', () => {
    expect(evalExpression({ fn: 'ABS', args: [{ const: -4 }] }, {})).toBe(4);
    expect(evalExpression({ fn: 'ABS', args: [{ const: null }] }, {})).toBeNull();
    expect(evalExpression({ fn: 'ROUND', args: [{ const: 1.26 }, { const: 1 }] }, {})).toBeCloseTo(1.3);
    expect(evalExpression({ fn: 'ROUND', args: [{ const: -1.5 }] }, {})).toBe(-2);
    expect(evalExpression({ fn: 'FLOOR', args: [{ const: -1.2 }] }, {})).toBe(-2);
    expect(evalExpression({ fn: 'CEIL', args: [{ const: 1.1 }] }, {})).toBe(2);
    expect(evalExpression({ fn: 'MIN', args: [{ const: 3 }, { const: null }, { const: 1 }] }, {})).toBe(1);
    expect(evalExpression({ fn: 'MAX', args: [{ const: 3 }, { const: null }, { const: 1 }] }, {})).toBe(3);
    expect(evalExpression({ fn: 'COALESCE', args: [{ const: null }, { const: 'Alpha' }, { const: 'Beta' }] }, {})).toBe('Alpha');
    expect(evalExpression({ fn: 'CONCAT', args: [{ const: 'North' }, { const: null }, { const: ' Fund' }] }, {})).toBe('North Fund');
    expect(evalExpression({ fn: 'CONCAT', args: [{ const: 10 }, { const: '%' }] }, {})).toBe('10%');
    expect(evalExpression({ fn: 'UPPER', args: [{ const: 'spy' }] }, {})).toBe('SPY');
    expect(evalExpression({ fn: 'LOWER', args: [{ const: 'SPY' }] }, {})).toBe('spy');
    expect(evalExpression({ fn: 'TRIM', args: [{ const: '  North  ' }] }, {})).toBe('North');
    expect(evalExpression({ fn: 'LEFT', args: [{ const: 'ABCDEF' }, { const: 3 }] }, {})).toBe('ABC');
    expect(evalExpression({ fn: 'LENGTH', args: [{ const: 'ABC' }] }, {})).toBe(3);
    expect(evalExpression({ fn: 'NEG', args: [{ const: 3 }] }, {})).toBe(-3);
    expect(evalExpression({ fn: 'DIV', args: [{ const: 1 }, { const: 0 }] }, {})).toBeNull();
  });

  it('keeps the op form for arithmetic', () => {
    const expr: Expression = { op: 'mul', args: [{ ref: 'QUANTITY' }, { ref: 'PRICE' }] };
    expect(evalExpression(expr, { QUANTITY: 10, PRICE: 4.5 })).toBe(45);
    expect(evalExpression(expr, { QUANTITY: 10, PRICE: null })).toBeNull();
  });

  it('copies the current yield pattern', () => {
    const expr: Expression = { op: 'div', args: [{ ref: 'INCOME' }, { ref: 'PRICE' }] };
    expect(evalExpression(expr, { INCOME: 5, PRICE: 100 })).toBe(0.05);
  });

  it('rejects a function that is not in the row library', () => {
    expect(() => evalExpression({ fn: 'FORMAT', args: [{ const: 1 }] }, {})).toThrow(/Unknown expression function/);
  });

  it('lists row, group, domain, and display guidance', () => {
    const rows = listExpressionFunctions();
    expect(rows.map((row) => `${row.category}:${row.code}`)).toEqual([
      'ROW:ABS', 'ROW:ROUND', 'ROW:FLOOR', 'ROW:CEIL', 'ROW:MIN', 'ROW:MAX',
      'ROW:COALESCE', 'ROW:CONCAT', 'ROW:UPPER', 'ROW:LOWER', 'ROW:TRIM',
      'ROW:LEFT', 'ROW:LENGTH', 'ROW:ADD', 'ROW:SUB', 'ROW:MUL', 'ROW:DIV', 'ROW:NEG',
      'ROW:CURRENT_DATE', 'ROW:PREVIOUS_DAY', 'ROW:START_OF_MONTH', 'ROW:END_OF_MONTH',
      'ROW:START_OF_QUARTER', 'ROW:END_OF_QUARTER', 'ROW:START_OF_YEAR', 'ROW:END_OF_YEAR',
      'GROUP:SUM', 'GROUP:WAVG', 'GROUP:MIN', 'GROUP:MAX',
      'DOMAIN:XIRR', 'DOMAIN:CURRENT_YIELD', 'DOMAIN:UNREALIZED_PNL', 'DOMAIN:NET_MULTIPLE',
      'DISPLAY:FORMAT',
    ]);
    expect(listExpressionFunctions('row').every((row) => row.category === 'ROW')).toBe(true);
    const format = rows.find((row) => row.code === 'FORMAT');
    expect(format?.callable).toBe(false);
    expect(format?.description).toMatch(/displayFormat/);
    expect(rows.find((row) => row.id === 'GROUP:MIN')?.description).toMatch(/row function/);
    expect(rows.filter((row) => row.callable).every((row) => row.category === 'ROW')).toBe(true);
  });
});
