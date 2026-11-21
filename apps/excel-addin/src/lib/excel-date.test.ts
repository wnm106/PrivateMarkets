import { describe, expect, it } from 'vitest';
import { isoDateToSerial, parseAsOf, serialToIsoDate } from './excel-date';

describe('Excel serial dates', () => {
  it('matches the dates Excel shows', () => {
    expect(serialToIsoDate(1)).toBe('1900-01-01');
    expect(serialToIsoDate(59)).toBe('1900-02-28');
    expect(serialToIsoDate(61)).toBe('1900-03-01');
    expect(serialToIsoDate(46295)).toBe('2026-09-30');
    expect(serialToIsoDate(46295.75)).toBe('2026-09-30');
  });

  it('has no 1900-02-29, which never happened', () => {
    expect(serialToIsoDate(60)).toBeNull();
  });

  it('goes both ways', () => {
    for (const day of ['1900-01-01', '1900-02-28', '1900-03-01', '2024-02-29', '2026-09-30', '9999-12-31']) {
      const serial = isoDateToSerial(day);
      expect(serial).not.toBeNull();
      expect(serialToIsoDate(serial as number)).toBe(day);
    }
  });
});

describe('parseAsOf', () => {
  it('treats an omitted or empty argument as today', () => {
    for (const value of [undefined, null, '', '  ', 0]) expect(parseAsOf(value)).toEqual({ ok: true, date: null });
  });

  it('reads a date cell, DATE(), and typed dates', () => {
    expect(parseAsOf(46295)).toEqual({ ok: true, date: '2026-09-30' });
    expect(parseAsOf('2026-09-30')).toEqual({ ok: true, date: '2026-09-30' });
    expect(parseAsOf('2026/9/30')).toEqual({ ok: true, date: '2026-09-30' });
    expect(parseAsOf('20260930')).toEqual({ ok: true, date: '2026-09-30' });
  });

  it('refuses what is not a date rather than guessing day and month', () => {
    expect(parseAsOf('09/30/2026').ok).toBe(false);
    expect(parseAsOf('2026-02-30').ok).toBe(false);
    expect(parseAsOf('next quarter').ok).toBe(false);
    expect(parseAsOf(true).ok).toBe(false);
    expect(parseAsOf(-5).ok).toBe(false);
  });
});
