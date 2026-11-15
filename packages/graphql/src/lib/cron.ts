/**
 * Five-field cron expressions: minute hour day-of-month month day-of-week.
 *
 * Each field takes a star, a number, a range (1-5), a list (1,15), or a step
 * (star/15, 0-30/10). Day of week is 0-6 with Sunday as 0; 7 also means Sunday.
 * When both day fields are restricted, a date matches if either one does, which
 * is how cron has always read them.
 *
 * Times are read in the schedule's time zone, so "0 6 * * 1-5" in
 * America/New_York stays at 6am local through daylight saving changes.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text: string, name: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [rangeText, stepText, extra] = part.split('/');
    if (!rangeText || extra !== undefined) throw new Error(`The ${name} field "${text}" is not valid.`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`The ${name} field has a step that is not a positive whole number.`);

    let from: number;
    let to: number;
    if (rangeText === '*') {
      from = min;
      to = max;
    } else {
      const [fromText, toText, more] = rangeText.split('-');
      if (more !== undefined) throw new Error(`The ${name} field "${text}" is not valid.`);
      from = Number(fromText);
      to = toText === undefined ? (stepText === undefined ? from : max) : Number(toText);
      if (!/^\d+$/.test(fromText) || (toText !== undefined && !/^\d+$/.test(toText))) {
        throw new Error(`The ${name} field "${text}" is not valid.`);
      }
    }
    if (from < min || to > max || from > to) {
      throw new Error(`The ${name} field must stay between ${min} and ${max}.`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronFields {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('A schedule needs five fields: minute, hour, day of month, month, day of week.');
  }
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parts.map((part, index) =>
    parseField(part, RANGES[index].name, RANGES[index].min, RANGES[index].max),
  );
  const daysOfWeek = new Set<number>();
  for (const day of rawDaysOfWeek) daysOfWeek.add(day === 7 ? 0 : day);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: !parts[2].startsWith('*'),
    dayOfWeekRestricted: !parts[4].startsWith('*'),
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instant: Date, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, weekday };
}

function dayMatches(fields: CronFields, local: LocalParts): boolean {
  if (!fields.months.has(local.month)) return false;
  const byMonthDay = fields.daysOfMonth.has(local.day);
  const byWeekDay = fields.daysOfWeek.has(local.weekday);
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return byMonthDay || byWeekDay;
  return byMonthDay && byWeekDay;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Far enough to reach 29 February from any start. */
const SEARCH_LIMIT = 5 * 366 * 24 * HOUR;

/**
 * The first matching minute strictly after `after`. Returns null when nothing
 * matches within five years (for example 30 February).
 */
export function nextCronRun(expression: string, after: Date, timeZone = 'UTC'): Date | null {
  const fields = parseCron(expression);
  if (!isValidTimeZone(timeZone)) throw new Error(`"${timeZone}" is not a time zone.`);

  let cursor = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = cursor + SEARCH_LIMIT;
  while (cursor <= end) {
    const local = localParts(new Date(cursor), timeZone);
    // Skip to the next local hour when the day or the hour is wrong. Stepping by
    // the hour, not the day, keeps this right across daylight saving changes.
    if (!dayMatches(fields, local) || !fields.hours.has(local.hour)) {
      cursor += (60 - local.minute) * MINUTE;
      continue;
    }
    if (fields.minutes.has(local.minute)) return new Date(cursor);
    cursor += MINUTE;
  }
  return null;
}

/** Throws a readable error when the expression or time zone cannot be used. */
export function assertSchedulable(expression: string, timeZone = 'UTC'): void {
  parseCron(expression);
  if (!isValidTimeZone(timeZone)) throw new Error(`"${timeZone}" is not a time zone.`);
  if (!nextCronRun(expression, new Date(), timeZone)) {
    throw new Error('This schedule never runs. Check the day and month.');
  }
}
