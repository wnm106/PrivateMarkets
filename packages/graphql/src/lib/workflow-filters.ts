/**
 * Which records a workflow run works on.
 *
 * A workflow says what is done. It does not say to which records: that is
 * given when a run starts, as `filters` in the run's input, in the same shape
 * for every workflow. A "Select records" step turns the filters into a list,
 * and the steps after it work on that list.
 *
 * No filters means no restriction: the run covers every record its steps
 * apply to. Filters that match nothing mean the run has nothing to do. The two
 * are kept apart all the way down, so an empty match is never read as "all".
 */

export interface RecordFilters {
  /** The type of record: FUND, POSITION, ISSUER. */
  domainCode: string | null;
  entityCodes: string[];
  entityIds: string[];
  /** Part of the record's name, in any case. */
  nameContains: string | null;
  limit: number;
}

export const DEFAULT_FILTER_LIMIT = 100;
export const MAX_FILTER_LIMIT = 500;

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function word(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Cleans what a run was started with. Codes may be given as a list or as text separated by commas. */
export function parseFilters(raw: unknown): RecordFilters {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const limit = Math.trunc(Number(row.limit));
  return {
    domainCode: word(row.domainCode)?.toUpperCase() ?? null,
    entityCodes: list(row.entityCodes),
    entityIds: list(row.entityIds),
    nameContains: word(row.nameContains),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_FILTER_LIMIT) : DEFAULT_FILTER_LIMIT,
  };
}

/** Whether the filters restrict anything. A limit alone does not. */
export function hasFilters(filters: RecordFilters): boolean {
  return Boolean(filters.domainCode || filters.nameContains || filters.entityCodes.length > 0 || filters.entityIds.length > 0);
}

/** The filters in words, for the run's history. */
export function describeFilters(filters: RecordFilters): string {
  if (!hasFilters(filters)) return 'every record';
  const parts: string[] = [];
  if (filters.domainCode) parts.push(`type ${filters.domainCode}`);
  if (filters.entityCodes.length > 0) parts.push(`code ${filters.entityCodes.join(', ')}`);
  if (filters.entityIds.length > 0) parts.push(`${filters.entityIds.length} record id${filters.entityIds.length === 1 ? '' : 's'}`);
  if (filters.nameContains) parts.push(`name containing "${filters.nameContains}"`);
  return parts.join('; ');
}

/**
 * The record ids a step was given, read from a tool's settings.
 * null: nothing was given, so there is no restriction.
 * []:   a selection was given and it is empty, so there is nothing to work on.
 */
export function selectedIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  return list(value);
}
