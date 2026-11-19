import { describe, expect, it } from 'vitest';
import { covenantCushion, covenantStatus, isStale, mapCovenantTest } from './covenant-test';

describe('covenant status', () => {
  it('passes, watches, and breaches a maximum', () => {
    expect(covenantStatus('MAX', 3.25, 2.5)).toBe('PASS');
    expect(covenantStatus('MAX', 3.25, 2.97)).toBe('WATCH');
    expect(covenantStatus('MAX', 3.25, 3.3)).toBe('BREACH');
  });

  it('measures a minimum against the value', () => {
    expect(covenantCushion('MIN', 2.75, 2.81)).toBeCloseTo((2.81 - 2.75) / 2.81);
    expect(covenantStatus('MIN', 2.75, 2.81)).toBe('WATCH');
    expect(covenantStatus('MIN', 2.75, 2.5)).toBe('BREACH');
    expect(covenantStatus('MIN', 1.75, 2.9)).toBe('PASS');
  });

  it('has no status without a value or a level', () => {
    expect(covenantStatus('MAX', 3, null)).toBe('NO_DATA');
    expect(covenantStatus('MAX', null, 2)).toBe('NO_DATA');
    expect(covenantCushion('MAX', 0, 2)).toBeNull();
  });
});

describe('stale stored value', () => {
  it('is behind when the definition now gives something else', () => {
    expect(isStale(2.5, 2.97, false)).toBe(true);
    expect(isStale(2.97, 2.97 + 1e-12, false)).toBe(false);
    expect(isStale(null, 2.97, false)).toBe(true);
    expect(isStale(null, null, false)).toBe(false);
  });

  it('never calls a manual override behind', () => {
    expect(isStale(4, 2.97, true)).toBe(false);
  });
});

describe('mapping the database result', () => {
  const row = {
    covenantId: 'c1',
    code: 'HALY-COV-HALYARD-1',
    name: 'Maximum net leverage',
    dealId: 'd1',
    dealName: 'Project Halyard',
    metric: 'NET_LEVERAGE',
    direction: 'MAX',
    unit: 'MULTIPLE',
    level: 3.25,
    firstTest: '2027-02-12',
    asOf: '2026-11-19',
    testDate: '2026-09-30',
    value: 2.9706,
    numerator: '135062000.00',
    denominator: 45465809.01,
    stored: 2.9706,
    house: 2.5698,
    houseId: 'h1',
    houseName: 'House standard: net leverage',
    isLibrary: false,
    isHouse: false,
    missing: [],
    reported: [{ sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Borrower Compliance Certificate', value: 2.76, validFrom: '2026-09-30' }],
    components: [
      { id: 'x2', name: 'EBITDA', side: 'DENOMINATOR', sign: 'ADD', measure: 'LTM', capType: 'NONE', active: true, raw: 41000000, applied: 41000000, capped: false },
      { id: 'x1', name: 'Term loan', side: 'NUMERATOR', sign: 'ADD', measure: 'POINT', capType: 'NONE', active: true, raw: 140000000, applied: 140000000, capped: false },
      { id: 'x0', name: 'Old cash cap', side: 'NUMERATOR', sign: 'SUBTRACT', measure: 'POINT', capType: 'AMOUNT', capValue: 10000000, active: false, effectiveTo: '2026-03-31', capped: false },
    ],
    history: [{ testDate: '2026-06-30', value: 3.07, house: 2.75, level: '3.25', tested: true }, { testDate: '2025-06-30', value: 3.49, level: 4, tested: false }, { testDate: null, value: 1 }],
  };

  it('reads numbers, statuses, and the certificate difference', () => {
    const test = mapCovenantTest(row);
    expect(test.numerator).toBe(135062000);
    expect(test.status).toBe('WATCH');
    expect(test.beforeFirstTest).toBe(true);
    expect(test.stale).toBe(false);
    expect(test.manualOverride).toBe(false);
    expect(test.reportedDifference).toBeCloseTo(2.76 - 2.9706);
    expect(test.history).toHaveLength(2);
    expect(test.history[0]).toMatchObject({ level: 3.25, tested: true });
    expect(test.history[1]).toMatchObject({ level: 4, tested: false });
  });

  it('lists the numerator first and lines in force before closed ones', () => {
    const test = mapCovenantTest(row);
    expect(test.components.map((item) => item.id)).toEqual(['x1', 'x0', 'x2']);
    expect(test.components[1].effectiveTo).toBe('2026-03-31');
  });

  it('treats a manual entry as an override, not as the certificate', () => {
    const test = mapCovenantTest({
      ...row,
      stored: 3.1,
      reported: [
        { sourceCode: 'MANUAL', sourceName: 'Manual', value: 3.1 },
        { sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Borrower Compliance Certificate', value: 2.76 },
      ],
    });
    expect(test.manualOverride).toBe(true);
    expect(test.stale).toBe(false);
    expect(test.reportedDifference).toBeCloseTo(2.76 - 2.9706);
  });
});
