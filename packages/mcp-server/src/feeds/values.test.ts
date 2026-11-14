import { describe, expect, it } from 'vitest';
import { applyTransform, coerceAttributeValue, parseNumber, parseUsDate, planPeriod } from './values';

describe('parseUsDate', () => {
  it('accepts real days in common formats', () => {
    expect(parseUsDate('2025-02-28')).toBe('2025-02-28');
    expect(parseUsDate('2025-2-8')).toBe('2025-02-08');
    expect(parseUsDate('2/8/2025')).toBe('2025-02-08');
    expect(parseUsDate('1/2/25')).toBe('2025-01-02');
    expect(parseUsDate('31-Mar-2025')).toBe('2025-03-31');
    expect(parseUsDate('March 31, 2025')).toBe('2025-03-31');
    expect(parseUsDate('2024-02-29')).toBe('2024-02-29');
    expect(parseUsDate('2025-03-31T00:00:00Z')).toBe('2025-03-31');
  });

  it('rejects days that do not exist', () => {
    expect(parseUsDate('2025-02-31')).toBeNull();
    expect(parseUsDate('2/31/2025')).toBeNull();
    expect(parseUsDate('2025-02-29')).toBeNull();
    expect(parseUsDate('2025-13-01')).toBeNull();
    expect(parseUsDate('31-Feb-2025')).toBeNull();
  });

  it('reads day-first only when month-first is impossible', () => {
    expect(parseUsDate('13/01/2025')).toBe('2025-01-13');
    expect(parseUsDate('01/02/2025')).toBe('2025-01-02');
  });
});

describe('parseNumber', () => {
  it('reads US and European grouping', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('1,234,567')).toBe(1234567);
    expect(parseNumber('1.234.567')).toBe(1234567);
    expect(parseNumber('1234,56')).toBe(1234.56);
    expect(parseNumber('1,234')).toBe(1234);
  });

  it('reads currency, parentheses, and trailing minus', () => {
    expect(parseNumber('$1,000')).toBe(1000);
    expect(parseNumber('(1,234.50)')).toBe(-1234.5);
    expect(parseNumber('$(2,000)')).toBe(-2000);
    expect(parseNumber('500-')).toBe(-500);
    expect(parseNumber('-12.5')).toBe(-12.5);
    expect(parseNumber('1e3')).toBe(1000);
  });

  it('rejects text that is not a number', () => {
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1,2,3')).toBeNull();
    expect(parseNumber('12.3.4')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

describe('coerceAttributeValue', () => {
  it('stores currency and accounting numbers without a transform', () => {
    expect(coerceAttributeValue('$1,000', 'CURRENCY')).toMatchObject({ golden_value_numeric: 1000 });
    expect(coerceAttributeValue('(1,000)', 'NUMBER')).toMatchObject({ golden_value_numeric: -1000 });
    expect(coerceAttributeValue('1.234,56', 'NUMBER')).toMatchObject({ golden_value_numeric: 1234.56 });
  });

  it('treats placeholders as blank, not as errors', () => {
    expect(coerceAttributeValue('-', 'NUMBER')).toBeNull();
    expect(coerceAttributeValue('N/A', 'NUMBER')).toBeNull();
    expect(coerceAttributeValue('n/a', 'DATE')).toBeNull();
  });

  it('still reports real errors', () => {
    expect(coerceAttributeValue('twelve', 'NUMBER')).toEqual({ error: '"twelve" is not a number' });
    expect(coerceAttributeValue('2025-02-31', 'DATE')).toEqual({ error: '"2025-02-31" is not a date' });
  });

  it('converts percent text to a decimal', () => {
    expect(coerceAttributeValue('5%', 'PERCENTAGE')).toMatchObject({ golden_value_numeric: 0.05 });
  });
});

describe('applyTransform number', () => {
  it('strips currency and reads accounting negatives', () => {
    expect(applyTransform('(1,234.50)', { kind: 'number' })).toBe('-1234.50');
    expect(applyTransform('€1.234,56', { kind: 'number' })).toBe('1234.56');
    expect(applyTransform('n/a', { kind: 'number' })).toBe('n/a');
  });
});

describe('planPeriod', () => {
  const OPEN = '9999-12-31';

  it('closes the open period and stays open when loading forward', () => {
    expect(planPeriod([{ id: 'a', validFrom: '2026-01-01', validTo: OPEN }], '2026-06-01'))
      .toEqual({ validTo: OPEN, closeId: 'a', closeTo: '2026-05-31' });
  });

  it('keeps a first period open when there is no history', () => {
    expect(planPeriod([], '2026-06-01')).toEqual({ validTo: OPEN, closeId: null, closeTo: null });
  });

  it('ends before the next later period when loading into the past', () => {
    expect(planPeriod([{ id: 'b', validFrom: '2026-11-13', validTo: OPEN }], '2026-10-01'))
      .toEqual({ validTo: '2026-11-12', closeId: null, closeTo: null });
  });

  it('splits a closed period instead of overlapping it', () => {
    const history = [
      { id: 'a', validFrom: '2024-01-01', validTo: '2024-12-31' },
      { id: 'b', validFrom: '2025-01-01', validTo: OPEN },
    ];
    expect(planPeriod(history, '2024-06-01')).toEqual({ validTo: '2024-12-31', closeId: 'a', closeTo: '2024-05-31' });
  });
});
