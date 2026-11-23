import { isoDateToSerial, parseAsOf, serialToIsoDate } from './excel-date';
import { splitAddress } from './overrides';

/**
 * Synced tables (docs/EXCEL_ADDIN.md): the records of one entity type, with chosen
 * columns and filters, read through the platform's grid query and written as an
 * Excel table. The definition is stored in the workbook, so Refresh runs the same
 * query again for whoever opens it, under their own access.
 *
 * A filter value is typed text, or a reference that starts with "=" (=B2,
 * =Inputs!B2:B9), read from the workbook at each refresh. A blank value drops
 * that filter, so clearing a filter cell widens the table.
 */

export const TABLE_SETTINGS_KEY = 'tapestry.tables';
export const PAGE_SIZE = 2000;
export const MAX_TABLE_ROWS = 50_000;

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'contains' | 'startsWith' | 'between' | 'isNull' | 'notNull';

export const FILTER_OPS: Array<{ op: FilterOp; label: string }> = [
  { op: 'eq', label: 'is' },
  { op: 'neq', label: 'is not' },
  { op: 'in', label: 'is one of' },
  { op: 'nin', label: 'is not one of' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'between', label: 'between' },
  { op: 'contains', label: 'contains' },
  { op: 'startsWith', label: 'starts with' },
  { op: 'isNull', label: 'is blank' },
  { op: 'notNull', label: 'is not blank' },
];

export type FieldKind = 'text' | 'num' | 'date' | 'bool';

export interface TableColumn {
  code: string;
  label: string;
  kind: FieldKind;
}

export interface TableFilter {
  field: string;
  op: FilterOp;
  /** Typed text, or "=A1" / "=Sheet!A1:A9" to read from the workbook. Empty for isNull and notNull. */
  value: string;
  /** How the value is read. A filter can be on a field the table does not show. */
  kind?: FieldKind;
  label?: string;
}

export interface TableDefinition {
  /** The Excel table's name. Unique in the workbook. */
  tableName: string;
  domainCode: string;
  domainName: string;
  columns: TableColumn[];
  filters: TableFilter[];
  /** Typed date, "=B1", or empty for today. */
  asOf: string;
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
  autoRefresh: boolean;
  /** Where the table's top-left cell was last written, to put it back if it is deleted. */
  location?: { sheet: string; address: string };
  /** What the last refresh asked for, to tell whether the filters changed. */
  lastSignature?: string;
  lastRefreshed?: string;
  rowCount?: number;
}

/** The fields every record has. Each table starts with them. */
export const BUILT_IN_COLUMNS: TableColumn[] = [
  { code: 'entity_code', label: 'Code', kind: 'text' },
  { code: 'entity_name', label: 'Name', kind: 'text' },
];

export function kindForDataType(dataType: string | null | undefined): FieldKind {
  const type = String(dataType || '').toUpperCase();
  if (['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE', 'FLOAT'].includes(type)) return 'num';
  if (type === 'DATE' || type === 'TIMESTAMP') return 'date';
  if (type === 'BOOLEAN') return 'bool';
  return 'text';
}

/** A table name Excel accepts, not used yet in this workbook. */
export function tableNameFor(domainCode: string, taken: readonly string[]): string {
  const base = `Tapestry_${domainCode.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 200);
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let index = 1; ; index += 1) {
    const name = `${base}_${index}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

// ---------------------------------------------------------------- references

export interface CellRange {
  sheet: string;
  /** 0-based, inclusive. */
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function columnNumber(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** "=Inputs!$B$2:$B$9" or "B2" to its sheet and bounds. The sheet defaults to `defaultSheet`. */
export function parseRange(reference: string, defaultSheet = ''): CellRange | null {
  const text = reference.trim().replace(/^=/, '');
  const { sheet, address } = splitAddress(text);
  const match = address.match(/^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/);
  if (!match) return null;
  const top = Number(match[2]) - 1;
  const left = columnNumber(match[1]);
  const bottom = match[4] ? Number(match[4]) - 1 : top;
  const right = match[3] ? columnNumber(match[3]) : left;
  return { sheet: sheet || defaultSheet, top: Math.min(top, bottom), left: Math.min(left, right), bottom: Math.max(top, bottom), right: Math.max(left, right) };
}

export function isReference(value: string): boolean {
  return value.trim().startsWith('=') && parseRange(value) !== null;
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return a.sheet.toLowerCase() === b.sheet.toLowerCase()
    && a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/** Every cell range the table reads its filters and as-of from. */
export function referencesOf(definition: Pick<TableDefinition, 'filters' | 'asOf'>): string[] {
  const values = [...definition.filters.map((filter) => filter.value), definition.asOf];
  return [...new Set(values.filter((value) => value && isReference(value)).map((value) => value.trim().replace(/^=/, '')))];
}

// ---------------------------------------------------------------- filters

export interface GridFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export type Resolved =
  | { ok: true; filters: GridFilter[]; asOfDate: string | null; signature: string }
  | { ok: false; message: string };

function literalParts(text: string): string[] {
  return text.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
}

function cellParts(cells: unknown[][] | undefined): unknown[] {
  return (cells || []).flat().filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/[$€£¥,\s]/g, '');
  const percent = text.endsWith('%');
  const number = Number(percent ? text.slice(0, -1) : text);
  if (!text || !Number.isFinite(number)) return null;
  return percent ? number / 100 : number;
}

function asDate(value: unknown): string | null {
  if (typeof value === 'number') return serialToIsoDate(value);
  const parsed = parseAsOf(value);
  return parsed.ok ? parsed.date : null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(text)) return true;
  if (['false', 'no', 'n', '0'].includes(text)) return false;
  return null;
}

function typed(value: unknown, kind: FieldKind): { ok: true; value: unknown } | { ok: false } {
  if (kind === 'num') { const number = asNumber(value); return number === null ? { ok: false } : { ok: true, value: number }; }
  if (kind === 'date') { const date = asDate(value); return date ? { ok: true, value: date } : { ok: false }; }
  if (kind === 'bool') { const bool = asBool(value); return bool === null ? { ok: false } : { ok: true, value: bool }; }
  return { ok: true, value: typeof value === 'number' ? String(value) : String(value).trim() };
}

const KIND_WORD: Record<FieldKind, string> = { num: 'a number', date: 'a date', bool: 'true or false', text: 'text' };

/**
 * The filters and as-of as the grid query takes them. `cells` holds the values of
 * every reference, keyed by referenceKey. `kinds` gives each field's kind.
 */
export function resolveFilters(
  definition: Pick<TableDefinition, 'filters' | 'asOf'>,
  cells: ReadonlyMap<string, unknown[][]>,
  kinds: ReadonlyMap<string, FieldKind>,
  labels: ReadonlyMap<string, string> = new Map(),
): Resolved {
  const read = (value: string): unknown[] => (isReference(value) ? cellParts(cells.get(referenceKey(value))) : literalParts(value));
  const filters: GridFilter[] = [];
  for (const filter of definition.filters) {
    const label = labels.get(filter.field) || filter.field;
    if (filter.op === 'isNull' || filter.op === 'notNull') {
      filters.push({ field: filter.field, op: filter.op });
      continue;
    }
    const raw = isReference(filter.value) || ['in', 'nin', 'between'].includes(filter.op)
      ? read(filter.value)
      : (filter.value.trim() ? [filter.value.trim()] : []);
    if (!raw.length) continue; // A blank value drops the filter.
    const kind = kinds.get(filter.field) || 'text';
    const values: unknown[] = [];
    for (const part of raw) {
      const value = typed(part, kind);
      if (!value.ok) return { ok: false, message: `${label}: "${String(part)}" is not ${KIND_WORD[kind]}.` };
      values.push(value.value);
    }
    if (filter.op === 'in' || filter.op === 'nin') {
      filters.push({ field: filter.field, op: filter.op, value: values });
    } else if (filter.op === 'between') {
      if (values.length < 2) return { ok: false, message: `${label}: between needs two values, such as "1, 10" or two cells.` };
      filters.push({ field: filter.field, op: 'between', value: [values[0], values[1]] });
    } else {
      filters.push({ field: filter.field, op: filter.op, value: values[0] });
    }
  }
  let asOfDate: string | null = null;
  if (definition.asOf.trim()) {
    const raw = isReference(definition.asOf) ? cellParts(cells.get(referenceKey(definition.asOf)))[0] : definition.asOf.trim();
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      asOfDate = asDate(raw);
      if (!asOfDate) return { ok: false, message: `As of: "${String(raw)}" is not a date.` };
    }
  }
  return { ok: true, filters, asOfDate, signature: JSON.stringify({ filters, asOfDate }) };
}

export function referenceKey(reference: string): string {
  return reference.trim().replace(/^=/, '').replace(/\$/g, '').toUpperCase();
}

// ---------------------------------------------------------------- the query

export const TABLE_QUERY = `query TapTable($input: GridQueryInput!) {
  gridQuery(input: $input) { mode total matched rows columns { code name kind } asOfDate }
}`;

export interface GridPage {
  mode: string;
  total: number;
  matched: number;
  rows: Array<Record<string, unknown>>;
  columns: Array<{ code: string; name?: string | null; kind?: string | null }>;
  asOfDate?: string | null;
}

/** One page of the table. A final sort by code keeps paging stable. */
export function gridInput(
  definition: Pick<TableDefinition, 'domainCode' | 'columns' | 'sort'>,
  resolved: { filters: GridFilter[]; asOfDate: string | null },
  offset: number,
  limit = PAGE_SIZE,
) {
  const sort = [...definition.sort.filter((entry) => entry.field)];
  if (!sort.some((entry) => entry.field === 'entity_code')) sort.push({ field: 'entity_code', dir: 'asc' });
  return {
    start: 'DOMAIN',
    domainCode: definition.domainCode,
    columns: definition.columns.map((column) => column.code),
    filters: resolved.filters,
    sort,
    asOfDate: resolved.asOfDate,
    offset,
    limit,
  };
}

/** Read every page. Stops with a message when more rows match than a table holds. */
export async function readAllRows(
  fetchPage: (offset: number) => Promise<GridPage>,
  onProgress?: (read: number, matched: number) => void,
): Promise<{ ok: true; rows: Array<Record<string, unknown>>; columns: GridPage['columns'] } | { ok: false; message: string }> {
  const rows: Array<Record<string, unknown>> = [];
  let columns: GridPage['columns'] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(offset);
    if (page.mode !== 'rows') return { ok: false, message: 'The table query did not return rows.' };
    if (offset === 0) {
      columns = page.columns;
      if (page.matched > MAX_TABLE_ROWS) {
        return { ok: false, message: `${page.matched.toLocaleString()} records match. A table holds at most ${MAX_TABLE_ROWS.toLocaleString()}; narrow the filters.` };
      }
    }
    rows.push(...page.rows);
    onProgress?.(rows.length, page.matched);
    if (!page.rows.length || rows.length >= page.matched) break;
  }
  return { ok: true, rows, columns };
}

/**
 * Text from the database must never become a formula in someone's workbook: a value
 * such as "=WEBSERVICE(...)" or "+cmd" is written with a leading apostrophe, which
 * Excel shows as the plain text.
 */
export function safeText(value: string): string {
  return /^[=+@]/.test(value) ? `'${value}` : value;
}

/** The kinds of the table's columns and filters, and their labels, for resolveFilters. */
export function fieldKinds(definition: Pick<TableDefinition, 'columns' | 'filters'>): { kinds: Map<string, FieldKind>; labels: Map<string, string> } {
  const kinds = new Map<string, FieldKind>();
  const labels = new Map<string, string>();
  for (const column of definition.columns) { kinds.set(column.code, column.kind); labels.set(column.code, column.label); }
  for (const filter of definition.filters) {
    if (filter.kind && !kinds.has(filter.field)) kinds.set(filter.field, filter.kind);
    if (filter.label && !labels.has(filter.field)) labels.set(filter.field, filter.label);
  }
  return { kinds, labels };
}

/** Rows as cell values. Numbers stay numbers; dates become Excel dates; blanks stay blank. */
export function rowsToCells(columns: readonly TableColumn[], rows: ReadonlyArray<Record<string, unknown>>): unknown[][] {
  return rows.map((row) => columns.map((column) => {
    const value = row[column.code];
    if (value === null || value === undefined || value === '') return '';
    if (column.kind === 'num') {
      const number = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(number) ? number : String(value);
    }
    if (column.kind === 'date') {
      const day = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      const serial = day ? isoDateToSerial(day) : null;
      return serial ?? String(value);
    }
    if (column.kind === 'bool') return typeof value === 'boolean' ? value : safeText(String(value));
    return safeText(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }));
}

/** The number format each column's cells get: text stays text, dates show as dates, numbers keep the person's format. */
export function columnFormats(columns: readonly TableColumn[]): Array<string | null> {
  return columns.map((column) => (column.kind === 'text' ? '@' : column.kind === 'date' ? 'yyyy-mm-dd' : null));
}

/** The kinds the grid reports, mapped onto the definition's columns. */
export function withGridKinds(columns: readonly TableColumn[], gridColumns: GridPage['columns']): TableColumn[] {
  const kinds = new Map(gridColumns.map((column) => [column.code, column.kind]));
  return columns.map((column) => {
    const kind = kinds.get(column.code);
    return kind === 'num' || kind === 'date' || kind === 'bool' || kind === 'text' ? { ...column, kind } : column;
  });
}

// ---------------------------------------------------------------- writing in place

/**
 * How to turn a table body of `current` rows into one of `next` rows without moving
 * anything around it: overwrite what both have, then delete the rows left over or
 * append the rows missing. Excel keeps at least one body row, so an empty result
 * leaves one blank row.
 */
export function planBody(current: number, next: number): { overwrite: number; deleteFrom: number; deleteCount: number; append: number; blankFirst: boolean } {
  const existing = Math.max(current, 1);
  if (next === 0) return { overwrite: 0, deleteFrom: 1, deleteCount: existing - 1, append: 0, blankFirst: true };
  if (next <= existing) return { overwrite: next, deleteFrom: next, deleteCount: existing - next, append: 0, blankFirst: false };
  return { overwrite: existing, deleteFrom: existing, deleteCount: 0, append: next - existing, blankFirst: false };
}

/**
 * How to change a table's columns where it stands. Columns that stay keep their place,
 * so formulas that refer to them keep working; removed ones are deleted (from the right,
 * so earlier indexes hold) and new ones are added at the right. Null when the new list
 * is not the old one, less some, plus new ones at the end: the table is then rebuilt.
 * The pane only ever makes that shape.
 */
export function planColumns(before: readonly string[], after: readonly string[]): { remove: number[]; add: string[] } | null {
  const kept = after.filter((code) => before.includes(code));
  const added = after.filter((code) => !before.includes(code));
  const keptInOrder = before.filter((code) => after.includes(code));
  if (JSON.stringify(after) !== JSON.stringify([...kept, ...added])) return null;
  if (JSON.stringify(kept) !== JSON.stringify(keptInOrder)) return null;
  const remove = before.flatMap((code, index) => (after.includes(code) ? [] : [index])).reverse();
  return { remove, add: added };
}

// ---------------------------------------------------------------- refreshing

/**
 * Debounced refreshes, one at a time per table. A request while a table is
 * refreshing runs once more after it, so the last change always wins.
 */
export class RefreshScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private again = new Set<string>();

  constructor(private readonly run: (tableName: string) => Promise<void>, private readonly delayMs = 800) {}

  request(tableName: string): void {
    const timer = this.timers.get(tableName);
    if (timer) clearTimeout(timer);
    this.timers.set(tableName, setTimeout(() => {
      this.timers.delete(tableName);
      void this.start(tableName);
    }, this.delayMs));
  }

  private async start(tableName: string): Promise<void> {
    if (this.running.has(tableName)) {
      this.again.add(tableName);
      return;
    }
    this.running.add(tableName);
    try {
      await this.run(tableName);
    } catch {
      /* The run reports its own errors. */
    } finally {
      this.running.delete(tableName);
      if (this.again.delete(tableName)) void this.start(tableName);
    }
  }
}
