import { describe, expect, it } from 'vitest';
import { assertSchedulable, nextCronRun, parseCron } from './cron';

const next = (expression: string, after: string, timeZone?: string) =>
  nextCronRun(expression, new Date(after), timeZone)?.toISOString();

describe('parseCron', () => {
  it('reads stars, lists, ranges, and steps', () => {
    const fields = parseCron('*/15 6-8 1,15 * 1-5');
    expect([...fields.minutes]).toEqual([0, 15, 30, 45]);
    expect([...fields.hours]).toEqual([6, 7, 8]);
    expect([...fields.daysOfMonth]).toEqual([1, 15]);
    expect(fields.months.size).toBe(12);
    expect([...fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('rejects the wrong number of fields and values out of range', () => {
    expect(() => parseCron('0 6 * *')).toThrow(/five fields/);
    expect(() => parseCron('60 6 * * *')).toThrow(/between 0 and 59/);
    expect(() => parseCron('0 6 * * mon')).toThrow(/not valid/);
    expect(() => parseCron('*/0 6 * * *')).toThrow(/step/);
  });
});

describe('nextCronRun', () => {
  it('returns the next matching minute, never the current one', () => {
    expect(next('0 6 * * *', '2026-11-14T05:59:30Z')).toBe('2026-11-14T06:00:00.000Z');
    expect(next('0 6 * * *', '2026-11-14T06:00:00Z')).toBe('2026-11-15T06:00:00.000Z');
    expect(next('*/15 * * * *', '2026-11-14T06:07:00Z')).toBe('2026-11-14T06:15:00.000Z');
  });

  it('skips weekends for a weekday schedule', () => {
    // 14 November 2026 is a Saturday.
    expect(next('30 7 * * 1-5', '2026-11-14T08:00:00Z')).toBe('2026-11-16T07:30:00.000Z');
  });

  it('runs on month end dates and rolls over the year', () => {
    expect(next('0 0 1 1 *', '2026-11-14T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-11-14T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('matches either day field when both are restricted', () => {
    // The 15th or any Monday. 16 November 2026 is a Monday.
    expect(next('0 9 15 * 1', '2026-11-14T10:00:00Z')).toBe('2026-11-15T09:00:00.000Z');
    expect(next('0 9 15 * 1', '2026-11-15T10:00:00Z')).toBe('2026-11-16T09:00:00.000Z');
  });

  it('keeps local time across a daylight saving change', () => {
    // New York is UTC-5 in winter and UTC-4 in summer. Clocks move forward on 14 March 2027.
    expect(next('0 6 * * *', '2027-03-13T12:00:00Z', 'America/New_York')).toBe('2027-03-14T10:00:00.000Z');
    expect(next('0 6 * * *', '2027-03-12T12:00:00Z', 'America/New_York')).toBe('2027-03-13T11:00:00.000Z');
  });

  it('handles a zone with a half-hour offset', () => {
    // Kolkata is UTC+5:30, so 09:00 local is 03:30 UTC.
    expect(next('0 9 * * *', '2026-11-14T00:00:00Z', 'Asia/Kolkata')).toBe('2026-11-14T03:30:00.000Z');
  });

  it('returns null for a date that never comes', () => {
    expect(nextCronRun('0 0 30 2 *', new Date('2026-11-14T00:00:00Z'))).toBeNull();
  });
});

describe('assertSchedulable', () => {
  it('rejects an unknown time zone and a schedule that never runs', () => {
    expect(() => assertSchedulable('0 6 * * *', 'Mars/Olympus')).toThrow(/time zone/);
    expect(() => assertSchedulable('0 0 30 2 *')).toThrow(/never runs/);
    expect(() => assertSchedulable('0 6 * * 1-5', 'America/New_York')).not.toThrow();
  });
});
