import { describe, expect, it } from 'vitest';
import { parseTapFormula, tapFormulaForValue } from './tap-formula';

describe('tapFormulaForValue', () => {
  it('names the record and attribute by code, and leaves today out', () => {
    expect(tapFormulaForValue({ attributeCode: 'NAV', entityCode: 'FUND-1', asOfDate: '2026-11-23' }, '2026-11-23'))
      .toBe('=TAP("NAV", "FUND-1")');
    expect(tapFormulaForValue({ attributeCode: 'NAV', entityCode: 'FUND-1' }, '2026-11-23'))
      .toBe('=TAP("NAV", "FUND-1")');
  });

  it('writes an earlier as-of as DATE(), which reads back', () => {
    const formula = tapFormulaForValue({ attributeCode: 'NAV', entityCode: 'FUND-1', asOfDate: '2026-09-30' }, '2026-11-23');
    expect(formula).toBe('=TAP("NAV", "FUND-1", DATE(2026,9,30))');
    expect(parseTapFormula(formula)?.asOf).toEqual({ kind: 'expression', value: 'DATE(2026,9,30)' });
  });

  it('quotes codes that hold quotes, and can use the qualified name', () => {
    expect(tapFormulaForValue({ attributeCode: 'NAV', entityCode: 'A "B" C' }, '2026-11-23', false))
      .toBe('=TAPESTRY.TAP("NAV", "A ""B"" C")');
  });
});
