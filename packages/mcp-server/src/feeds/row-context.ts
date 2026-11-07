import type { FeedMap } from './types';
import { parseUsDate } from './values';

export const DEFAULT_IMPORT_SOURCE = 'POSITION_FILE';

export interface RowContext {
  asOf: string;
  source: string;
}

/** Match a source code case-insensitively, and treat spaces or hyphens as underscores. */
export function normalizeSourceCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * A mapped as-of or source column supplies the row. A blank cell uses the
 * date or source chosen for the whole file.
 */
export function resolveRowContext(
  row: Record<string, string>,
  map: Pick<FeedMap, 'asOfHintColumn' | 'sourceHintColumn'>,
  fallback: RowContext,
  read: (row: Record<string, string>, column: string) => string = (record, column) => record[column] || '',
): RowContext {
  let asOf = fallback.asOf;
  if (map.asOfHintColumn) {
    const raw = read(row, map.asOfHintColumn).trim();
    const iso = raw ? parseUsDate(raw) : null;
    if (iso) asOf = iso;
  }
  let source = normalizeSourceCode(fallback.source || DEFAULT_IMPORT_SOURCE);
  if (map.sourceHintColumn) {
    const raw = read(row, map.sourceHintColumn).trim();
    if (raw) source = normalizeSourceCode(raw);
  }
  return { asOf, source };
}
