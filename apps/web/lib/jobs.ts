import { nextCronRun } from '@tapestrai/graphql/src/lib/cron';

/** Helpers for the admin jobs page. */

export interface JobTypeOption {
  code: string;
  label: string;
  description: string;
  scope: string;
  payloadExample: Record<string, unknown>;
}

/** A schedule code from its name: "Morning compliance check" becomes MORNING_COMPLIANCE_CHECK. */
export function codeFromName(name: string): string {
  const code = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return code || 'SCHEDULE';
}

export type ParsedPayload = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** Settings must be a JSON object. An empty box is an empty object. */
export function parsePayload(text: string): ParsedPayload {
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The settings are not valid JSON.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'The settings must be a JSON object, for example {"limit": 500}.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * Whether a schedule for this job type is a platform schedule. Null means this
 * person cannot schedule the type at all (a platform job, and they are not a
 * tenant admin).
 */
export function platformFor(type: Pick<JobTypeOption, 'scope'>, isTenantAdmin: boolean, wanted: boolean): boolean | null {
  if (type.scope === 'PLATFORM') return isTenantAdmin ? true : null;
  if (type.scope === 'CLIENT') return false;
  return isTenantAdmin ? wanted : false;
}

/** The next time a schedule runs, in words. Throws when the expression cannot be read. */
export function describeCron(expression: string, timeZone: string, now: Date = new Date()): string {
  const zone = timeZone.trim() || 'UTC';
  const next = nextCronRun(expression, now, zone);
  if (!next) return 'This schedule never runs. Check the day and month.';
  const text = next.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: zone });
  return `Next run: ${text} (${zone})`;
}

/** How long a run took, or has taken so far. */
export function duration(startedAt: string | null, finishedAt: string | null, now: Date = new Date()): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 1) return 'Under 1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
