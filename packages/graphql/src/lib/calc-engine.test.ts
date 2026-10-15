import { describe, expect, it } from 'vitest';
import { calcOrder, evalNumericExpr, mergeWindow, periodEnds, xirr, type Expr } from './calc-engine';

describe('calculated attributes', () => {
  it('multiplies quantity by price and drops a missing input', () => {
    const expr: Expr = {
      op: 'mul',
      args: [{ ref: 'QUANTITY' }, { ref: 'PRICE' }],
    };
    expect(evalNumericExpr(expr, { QUANTITY: 10, PRICE: 4.5 })).toBe(45);
    expect(evalNumericExpr(expr, { QUANTITY: 10, PRICE: null })).toBeNull();
    expect(evalNumericExpr({ op: 'div', args: [{ const: 1 }, { const: 0 }] }, {})).toBeNull();
  });

  it('solves a one-year cash flow at ten percent', () => {
    const rate = xirr(['2023-01-01', '2024-01-01'], [-1000, 1100]);
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.1, 6);
  });

  it('includes a terminal value in the rate', () => {
    const rate = xirr(
      ['2024-01-01', '2024-06-30', '2024-12-31'],
      [-1000, 50, 1000],
    );
    expect(rate).not.toBeNull();
    expect(Math.abs(rate!)).toBeLessThan(1);
  });

  it('lists quarter ends from a change date through today', () => {
    expect(periodEnds('QUARTER_END', '2024-06-01', '9999-12-31', '2024-10-14')).toEqual([
      '2024-06-30',
      '2024-09-30',
    ]);
    expect(periodEnds('QUARTER_END', '2024-07-01', '9999-12-31', '2024-08-01')).toEqual([]);
    expect(periodEnds('QUARTER_END', '2024-06-01', '9999-12-31', '2024-12-31')).toContain('2024-12-31');
  });

  it('collapses overlapping dirty windows to the earliest start', () => {
    const merged = mergeWindow(
      { start: '2024-09-01', end: '9999-12-31' },
      { start: '2024-06-01', end: '9999-12-31' },
    );
    expect(merged).toEqual({ start: '2024-06-01', end: '9999-12-31' });
  });

  it('orders a price, market value, gross asset value, and IRR chain', () => {
    const order = calcOrder(
      [
        { code: 'MARKET_VALUE', inputs: ['QUANTITY', 'PRICE'] },
        { code: 'GROSS_ASSET_VALUE', inputs: ['MARKET_VALUE'] },
        { code: 'IRR', inputs: ['AMOUNT', 'CASHFLOW_DATE', 'GROSS_ASSET_VALUE'] },
      ],
      new Set(['MARKET_VALUE', 'GROSS_ASSET_VALUE', 'IRR']),
    );
    expect(order).toEqual(['MARKET_VALUE', 'GROSS_ASSET_VALUE', 'IRR']);
  });

  it('rejects a cycle between calculated attributes', () => {
    expect(() =>
      calcOrder(
        [
          { code: 'A', inputs: ['B'] },
          { code: 'B', inputs: ['A'] },
        ],
        new Set(['A', 'B']),
      ),
    ).toThrow(/cycle/i);
  });
});
