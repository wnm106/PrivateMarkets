/**
 * Checks for arguments that end up inside a PostgREST filter string.
 * The Date and ID scalars have no parser, so they arrive as whatever text the
 * caller sent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new Error(`${field} must be an id.`);
  return value;
}

/**
 * A PostgREST .or() filter for catalog rows a client sees: the shared ones
 * (client_id null) and that client's own. With no client, the shared ones only.
 */
export function sharedOrClientFilter(clientId: string | null | undefined): string {
  return clientId ? `client_id.is.null,client_id.eq.${requireUuid(clientId, 'clientId')}` : 'client_id.is.null';
}

/** The calendar date of an ISO date or timestamp, or an error naming the field. */
export function requireIsoDate(value: unknown, field: string): string {
  const match = typeof value === 'string' ? ISO_DATE.exec(value.trim()) : null;
  if (!match) throw new Error(`${field} must be a date such as 2026-01-31.`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    throw new Error(`${field} must be a date such as 2026-01-31.`);
  }
  return `${year}-${month}-${day}`;
}
