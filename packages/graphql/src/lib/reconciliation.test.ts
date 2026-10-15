import { describe, expect, it } from 'vitest';
import {
  buildComparisons,
  comparisonVariance,
  parseIdentityChecks,
  pickLatest,
  withGolden,
  type LineRef,
  type StoredValue,
} from './reconciliation';

const fund: LineRef = { entityId: 'fund', entityCode: 'FCNTX', entityName: 'Fidelity Contrafund' };
const position: LineRef = { entityId: 'pos', entityCode: 'POS-1', entityName: 'Apple' };

function fact(overrides: Partial<StoredValue> & Pick<StoredValue, 'sourceCode' | 'value'>): StoredValue {
  return {
    entityId: 'pos',
    attributeCode: 'MARKET_VALUE',
    sourceName: overrides.sourceCode,
    numeric: overrides.value == null ? null : Number(overrides.value),
    precedenceRank: 10,
    isGolden: false,
    validFrom: '2024-12-31',
    systemFrom: '2024-12-31T00:00:00Z',
    asOfRole: 'CURRENT',
    ...overrides,
  };
}

describe('reconciliation comparisons', () => {
  it('treats a one percent market-value gap as inside tolerance and a larger gap as a break', () => {
    expect(comparisonVariance(
      { value: '101', numeric: 101 },
      { value: '100', numeric: 100 },
      'PERCENT',
      0.01,
    ).differ).toBe(false);
    expect(comparisonVariance(
      { value: '103', numeric: 103 },
      { value: '100', numeric: 100 },
      'PERCENT',
      0.01,
    ).differ).toBe(true);
  });

  it('flags a source that disagrees with the golden value', () => {
    const result = buildComparisons({
      anchor: fund,
      lines: [position],
      measures: [{ attributeCode: 'MARKET_VALUE', toleranceType: 'ABSOLUTE', tolerance: 1 }],
      identityChecks: [],
      compareMode: 'SOURCE',
      attributeNames: { MARKET_VALUE: 'Market Value' },
      facts: withGolden([
        fact({ sourceCode: 'ALLVUE', value: '100', isGolden: true, precedenceRank: 40 }),
        fact({ sourceCode: 'INTERNAL', value: '140', precedenceRank: 60 }),
      ]),
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].isBreak).toBe(true);
    expect(result.lines[0].goldenValue).toBe('100');
    expect(result.lines[0].cells.map((cell) => cell.key)).toEqual(['ALLVUE', 'INTERNAL']);
  });

  it('keeps an agreed source pair and a flat period as matched', () => {
    const result = buildComparisons({
      anchor: fund,
      lines: [position],
      measures: [{ attributeCode: 'QUANTITY', toleranceType: 'ABSOLUTE', tolerance: 0 }],
      identityChecks: [],
      compareMode: 'BOTH',
      attributeNames: { QUANTITY: 'Quantity' },
      facts: [
        fact({ attributeCode: 'QUANTITY', sourceCode: 'ALLVUE', value: '10', isGolden: true, asOfRole: 'CURRENT' }),
        fact({ attributeCode: 'QUANTITY', sourceCode: 'INTERNAL', value: '10', asOfRole: 'CURRENT' }),
        fact({ attributeCode: 'QUANTITY', sourceCode: 'ALLVUE', value: '10', isGolden: true, asOfRole: 'PRIOR', validFrom: '2024-09-30' }),
      ],
    });
    expect(result.lines.map((line) => line.breakKind)).toEqual(['SOURCE', 'PERIOD']);
    expect(result.lines.every((line) => !line.isBreak)).toBe(true);
  });

  it('breaks the per-share identity when the reported NAV does not foot', () => {
    const checks = parseIdentityChecks([{
      code: 'NAV_PER_SHARE',
      name: 'NAV per share',
      kind: 'EXPRESSION',
      compareAttributeCode: 'NAV_PER_SHARE',
      toleranceType: 'ABSOLUTE',
      tolerance: 0.01,
      expression: { op: 'div', args: [{ op: 'sub', args: [{ ref: 'TOTAL_ASSETS' }, { ref: 'TOTAL_LIABILITIES' }] }, { ref: 'SHARES_OUTSTANDING' }] },
    }]);
    const result = buildComparisons({
      anchor: fund,
      lines: [],
      measures: [],
      identityChecks: checks,
      compareMode: 'SOURCE',
      attributeNames: {},
      facts: [
        fact({ entityId: 'fund', attributeCode: 'TOTAL_ASSETS', sourceCode: 'ALLVUE', value: '1000', isGolden: true }),
        fact({ entityId: 'fund', attributeCode: 'TOTAL_LIABILITIES', sourceCode: 'ALLVUE', value: '100', isGolden: true }),
        fact({ entityId: 'fund', attributeCode: 'SHARES_OUTSTANDING', sourceCode: 'ALLVUE', value: '10', isGolden: true }),
        fact({ entityId: 'fund', attributeCode: 'NAV_PER_SHARE', sourceCode: 'ALLVUE', value: '100', isGolden: true }),
      ],
    });
    expect(result.identities[0].calculated).toBe(90);
    expect(result.identities[0].passed).toBe(false);
    expect(result.lines[0].breakKind).toBe('IDENTITY');
  });

  it('passes a position-book tie-out when the sum matches NAV', () => {
    const result = buildComparisons({
      anchor: fund,
      lines: [position, { entityId: 'pos-2', entityCode: 'POS-2', entityName: 'Tesla' }],
      measures: [],
      identityChecks: [{
        code: 'NAV_VS_POSITIONS',
        name: 'NAV vs position market value',
        kind: 'SUM_RELATED',
        childAttributeCode: 'MARKET_VALUE',
        anchorAttributeCode: 'NAV',
        toleranceType: 'ABSOLUTE',
        tolerance: 0,
      }],
      compareMode: 'SOURCE',
      attributeNames: {},
      facts: [
        fact({ sourceCode: 'ALLVUE', value: '40', isGolden: true }),
        fact({ entityId: 'pos-2', sourceCode: 'ALLVUE', value: '60', isGolden: true }),
        fact({ entityId: 'fund', attributeCode: 'NAV', sourceCode: 'ALLVUE', value: '100', isGolden: true }),
      ],
    });
    expect(result.identities[0].passed).toBe(true);
    expect(result.lines).toHaveLength(0);
  });

  it('picks the latest valid row and falls back to precedence when nothing is marked golden', () => {
    const latest = pickLatest([
      fact({ sourceCode: 'ALLVUE', value: '1', validFrom: '2024-01-01', systemFrom: '2024-01-01T00:00:00Z' }),
      fact({ sourceCode: 'ALLVUE', value: '2', validFrom: '2024-06-01', systemFrom: '2024-06-01T00:00:00Z' }),
    ]);
    expect(latest?.value).toBe('2');
    const marked = withGolden([
      fact({ sourceCode: 'SPCIQ', value: '9', precedenceRank: 50 }),
      fact({ sourceCode: 'BLOOMBERG', value: '8', precedenceRank: 10 }),
    ]);
    expect(marked.find((row) => row.isGolden)?.sourceCode).toBe('BLOOMBERG');
  });
});
