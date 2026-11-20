/** Last valid day. Rows that run open-ended carry it as valid_to. */
export const OPEN_VALID_TO = '9999-12-31';

export interface SourceVersionRow {
  id: string;
  valid_from: string;
  valid_to: string;
}

export interface SourceVersionPlan<T extends SourceVersionRow> {
  /** Current rows to close in system time. Their belief is kept, not edited. */
  close: T[];
  /** The part of a closed row that still holds before the new value starts. */
  keepBefore: Array<{ row: T; validTo: string }>;
  /** Where the new value stops: the day before this source's next later value, or open-ended. */
  newValidTo: string;
}

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

export function dayBefore(isoDate: string): string {
  const [year, month, day] = dateOnly(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * How one source takes a new value from `validFrom`, bitemporally.
 * `rows` are that source's current rows (open in system time) that end on or after `validFrom`.
 * A row that covers `validFrom` is closed and its earlier days are written again as their own row,
 * so the value before the change is still there. A row that starts later is a value already
 * scheduled for the future; it stays, and the new value ends the day before it.
 */
export function planSourceVersion<T extends SourceVersionRow>(rows: T[], validFrom: string): SourceVersionPlan<T> {
  const start = dateOnly(validFrom);
  const close: T[] = [];
  const keepBefore: Array<{ row: T; validTo: string }> = [];
  let newValidTo = OPEN_VALID_TO;
  for (const row of rows) {
    const from = dateOnly(row.valid_from);
    const to = dateOnly(row.valid_to);
    if (to < start) continue;
    if (from > start) {
      const end = dayBefore(from);
      if (end < newValidTo) newValidTo = end;
      continue;
    }
    close.push(row);
    if (from < start) keepBefore.push({ row, validTo: dayBefore(start) });
  }
  return { close, keepBefore, newValidTo };
}

export interface VersionDeletePlan<T extends SourceVersionRow> {
  /** The same source's version that ends the day before the deleted one starts. */
  extend: T | null;
  /** Where that earlier version now ends: where the deleted one ended. */
  extendTo: string;
}

/**
 * Removing one version of a source's value. The version just before it, from the same source,
 * runs on to cover the deleted version's days, so the prior value resumes. Without one the days
 * are left to the other sources. `rows` are that source's current rows.
 */
export function planVersionDelete<T extends SourceVersionRow>(rows: T[], target: SourceVersionRow): VersionDeletePlan<T> {
  const start = dateOnly(target.valid_from);
  const touching = dayBefore(start);
  const extend = rows.find((row) => row.id !== target.id && dateOnly(row.valid_to) === touching) ?? null;
  return { extend, extendTo: dateOnly(target.valid_to) };
}
