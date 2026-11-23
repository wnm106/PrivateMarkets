/**
 * The full record over effective time: one version for each day any field's winning value
 * changes. Which value wins on a day is decided by `golden_master.winning_attribute_values`
 * (through `loadWinningValues`); this module only picks the days to ask about and compares
 * each day's record with the one before it.
 */

const OPEN_END = '9999-12-31';

/** A stored version's effective span, as believed at the knowledge time. */
export interface VersionSpan {
  validFrom: string;
  validTo: string | null;
}

function day(value: string): string {
  return String(value).slice(0, 10);
}

export function nextDay(isoDate: string): string {
  const [year, month, date] = day(isoDate).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function previousDay(isoDate: string): string {
  const [year, month, date] = day(isoDate).split('-').map(Number);
  const prior = new Date(Date.UTC(year, month - 1, date));
  prior.setUTCDate(prior.getUTCDate() - 1);
  return prior.toISOString().slice(0, 10);
}

/**
 * Every day on which some winning value may change: each version's first day, and the day
 * after each version that ends. Ascending and without repeats.
 */
export function candidateChangeDays(spans: readonly VersionSpan[]): string[] {
  const days = new Set<string>();
  for (const span of spans) {
    if (span.validFrom) days.add(day(span.validFrom));
    const end = span.validTo ? day(span.validTo) : OPEN_END;
    if (end < OPEN_END) days.add(nextDay(end));
  }
  return [...days].sort();
}

/** One field on one version of the record. A missing value is null. */
export interface TimelineCell {
  value: string | null;
  sourceId: string | null;
}

export interface TimelineVersion {
  /** First day this version of the record is in force. */
  effectiveFrom: string;
  /** Last day it is in force, or null while it still is. */
  effectiveTo: string | null;
  /** The value of every field on this version, keyed by attribute code. */
  values: Record<string, TimelineCell>;
  /** The fields whose value differs from the version before. Every field with a value on the first version. */
  changed: string[];
}

function sameValue(a: TimelineCell | undefined, b: TimelineCell | undefined): boolean {
  const left = a?.value ?? null;
  const right = b?.value ?? null;
  return (left === '' ? null : left) === (right === '' ? null : right);
}

/**
 * Builds the versions from the record read on each candidate day, oldest first. A day whose
 * record matches the day before (a version that never won, or one replaced by the same value)
 * does not start a new version.
 */
export function buildTimelineVersions(
  snapshots: ReadonlyArray<{ day: string; values: Record<string, TimelineCell> }>,
  attributeCodes: readonly string[],
): TimelineVersion[] {
  const ordered = [...snapshots].sort((a, b) => a.day.localeCompare(b.day));
  const versions: TimelineVersion[] = [];
  let prior: Record<string, TimelineCell> | null = null;
  for (const snapshot of ordered) {
    const changed = attributeCodes.filter((code) => (
      prior ? !sameValue(prior[code], snapshot.values[code]) : (snapshot.values[code]?.value ?? '') !== ''
    ));
    if (changed.length === 0) continue;
    if (versions.length) versions[versions.length - 1].effectiveTo = previousDay(snapshot.day);
    versions.push({ effectiveFrom: snapshot.day, effectiveTo: null, values: snapshot.values, changed });
    prior = snapshot.values;
  }
  return versions;
}
