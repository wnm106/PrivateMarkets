/**
 * The as-of argument of =TAP. Excel passes a date cell or DATE() as a serial number,
 * typed text as text, and an omitted or empty argument as null, undefined or "".
 * The server takes YYYY-MM-DD.
 */

export type AsOfArgument = { ok: true; date: string | null } | { ok: false; message: string };

const MS_PER_DAY = 86_400_000;
/** 1899-12-30: day zero of the 1900 date system, after Excel's fictitious 1900-02-29. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const MAX_SERIAL = 2_958_465; // 9999-12-31

function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** An Excel serial date (1900 date system) as YYYY-MM-DD. A time of day is dropped. */
export function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_SERIAL) return null;
  const whole = Math.floor(serial);
  // Serial 60 is 1900-02-29, a day that did not exist. Excel keeps it for Lotus compatibility.
  if (whole === 60) return null;
  const days = whole < 60 ? whole + 1 : whole;
  return new Date(EPOCH_1900 + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** YYYY-MM-DD as an Excel serial date. */
export function isoDateToSerial(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const day = iso(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!day) return null;
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - EPOCH_1900) / MS_PER_DAY);
  return days <= 60 ? days - 1 : days;
}

export function parseAsOf(value: unknown): AsOfArgument {
  if (value === null || value === undefined || value === '' || value === 0) return { ok: true, date: null };
  if (typeof value === 'number') {
    const date = serialToIsoDate(value);
    return date ? { ok: true, date } : { ok: false, message: `As of ${value} is not a date.` };
  }
  if (typeof value === 'boolean') return { ok: false, message: 'As of must be a date.' };
  const text = String(value).trim();
  if (!text) return { ok: true, date: null };
  const dashed = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  const parts = dashed || compact;
  if (parts) {
    const date = iso(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    if (date) return { ok: true, date };
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const date = serialToIsoDate(Number(text));
    if (date) return { ok: true, date };
  }
  return { ok: false, message: `As of "${text}" is not a date. Use a date cell, DATE(), or YYYY-MM-DD.` };
}
