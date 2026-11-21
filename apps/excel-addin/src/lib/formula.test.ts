import { describe, expect, it } from 'vitest';
import { asOfArgument, buildTapFormula, looksLikeReference, parseTapFormula, quoteExcelString, SHORT_NAME_FORMULA, splitArguments } from './formula';

describe('buildTapFormula', () => {
  it('writes =TAP when the workbook has the name, and the full name when it does not', () => {
    const formula = { attribute: { kind: 'text' as const, value: 'NAV' }, entity: { kind: 'text' as const, value: 'FUND-1' }, asOf: null };
    expect(buildTapFormula(formula, true)).toBe('=TAP("NAV", "FUND-1")');
    expect(buildTapFormula(formula, false)).toBe('=TAPESTRY.TAP("NAV", "FUND-1")');
  });

  it('quotes text and keeps a cell reference as a reference', () => {
    const formula = {
      attribute: { kind: 'text' as const, value: 'Ending NAV' },
      entity: { kind: 'text' as const, value: 'The "Apex" Fund' },
      asOf: asOfArgument('$B$1'),
    };
    expect(buildTapFormula(formula, true)).toBe('=TAP("Ending NAV", "The ""Apex"" Fund", $B$1)');
  });

  it('quotes a typed date', () => {
    expect(asOfArgument('2026-09-30')).toEqual({ kind: 'text', value: '2026-09-30' });
    expect(asOfArgument('  ')).toBeNull();
  });
});

describe('parseTapFormula', () => {
  it('reads back what the builder writes', () => {
    const written = '=TAP("Ending NAV", "The ""Apex"" Fund", $B$1)';
    expect(parseTapFormula(written)).toEqual({
      attribute: { kind: 'text', value: 'Ending NAV' },
      entity: { kind: 'text', value: 'The "Apex" Fund' },
      asOf: { kind: 'expression', value: '$B$1' },
    });
  });

  it('reads the full name, any case, and expressions with commas inside', () => {
    expect(parseTapFormula('=tapestry.tap(A2, "FUND-1", DATE(2026, 9, 30))')).toEqual({
      attribute: { kind: 'expression', value: 'A2' },
      entity: { kind: 'text', value: 'FUND-1' },
      asOf: { kind: 'expression', value: 'DATE(2026, 9, 30)' },
    });
  });

  it('ignores formulas that are not one TAP call', () => {
    expect(parseTapFormula('=SUM(A1:A3)')).toBeNull();
    expect(parseTapFormula('=TAP("NAV")')).toBeNull();
    expect(parseTapFormula('=TAP("NAV","X")+1')).toBeNull();
    expect(parseTapFormula('=TAP("NAV, "X")')).toBeNull();
    expect(parseTapFormula(42)).toBeNull();
  });
});

describe('helpers', () => {
  it('escapes quotes the way Excel does', () => {
    expect(quoteExcelString('a"b')).toBe('"a""b"');
  });

  it('splits only at top-level commas', () => {
    expect(splitArguments('"a,b", C1, IF(x, 1, 2)')).toEqual(['"a,b"', 'C1', 'IF(x, 1, 2)']);
    expect(splitArguments('"open')).toBeNull();
  });

  it('knows a cell reference', () => {
    for (const ref of ['B1', '$B$1', 'Sheet1!B1', "'Q3 marks'!$C$12"]) expect(looksLikeReference(ref)).toBe(true);
    for (const text of ['2026-09-30', 'NAV', 'B', '1']) expect(looksLikeReference(text)).toBe(false);
  });

  it('keeps the as-of optional in the TAP name', () => {
    expect(SHORT_NAME_FORMULA).toBe('=LAMBDA(attribute, entity, [as_of], TAPESTRY.TAP(attribute, entity, IF(ISOMITTED(as_of), "", as_of)))');
  });
});
