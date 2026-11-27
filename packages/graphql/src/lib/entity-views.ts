/**
 * Views: saved data tables that belong to an entity type.
 *
 * A view column names an attribute of the view's entity type ("PRICE") or of a
 * related record reached through a lookup ("sec.PRICE"). It reads the golden
 * value unless it names a source, in which case the grid field is
 * "PRICE@BLOOMBERG" and reporting.grid reads the value that source supplied.
 */

export interface EntityViewLookup {
  alias: string;
  direction: 'UP' | 'DOWN';
  relationshipCode?: string;
  domainCode?: string;
  /** Alias of an earlier lookup to start from. Omit to start from the view's own records. */
  from?: string;
  label?: string;
}

export interface EntityViewColumn {
  /** Attribute code, entity_code or entity_name, optionally prefixed "<alias>." */
  field: string;
  /** Source code to read instead of the golden value. Omit for golden. */
  source?: string;
  label?: string;
  /** Locked to the left edge of the grid. */
  pinned?: boolean;
}

export interface EntityViewSort {
  /** A column's grid field (see viewGridField). */
  field: string;
  dir: 'asc' | 'desc';
}

export interface EntityViewInput {
  domainCode: string;
  viewName: string;
  description?: string | null;
  columns: EntityViewColumn[];
  lookups: EntityViewLookup[];
  sort: EntityViewSort[];
  /** The saved population filter the view opens with. */
  filterId?: string | null;
  displayOrder?: number | null;
}

export interface ViewValidationError {
  field: string;
  message: string;
  code: string;
}

export const MAX_VIEW_COLUMNS = 80;
export const MAX_VIEW_LOOKUPS = 6;
/** The grid is also asked for each lookup walked the other way, under this suffix. */
export const ALTERNATE_ALIAS_SUFFIX = '_alt';

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ATTRIBUTE = /^[A-Za-z0-9_-]+$/;
const SOURCE = /^[A-Za-z0-9_-]+$/;
const BUILTINS = new Set(['entity_code', 'entity_name']);

/** The field the grid reads for a column: "[alias.]CODE" or "[alias.]CODE@SOURCE". */
export function viewGridField(column: Pick<EntityViewColumn, 'field' | 'source'>): string {
  const source = (column.source || '').trim();
  return source ? `${column.field}@${source}` : column.field;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function invalid(field: string, message: string): ViewValidationError {
  return { field, message, code: 'VALIDATION_ERROR' };
}

/** Clean a view definition and list what is wrong with it. */
export function normalizeEntityView(raw: any): { value: EntityViewInput; errors: ViewValidationError[] } {
  const errors: ViewValidationError[] = [];
  const domainCode = text(raw?.domainCode);
  const viewName = text(raw?.viewName);
  if (!domainCode) errors.push(invalid('domainCode', 'Choose the entity type the view belongs to.'));
  if (!viewName) errors.push(invalid('viewName', 'Give the view a name.'));
  if (viewName.length > 200) errors.push(invalid('viewName', 'Keep the name under 200 characters.'));

  const lookups: EntityViewLookup[] = [];
  const aliases = new Set<string>();
  const rawLookups: any[] = Array.isArray(raw?.lookups) ? raw.lookups : [];
  if (rawLookups.length > MAX_VIEW_LOOKUPS) {
    errors.push(invalid('lookups', `A view can reach at most ${MAX_VIEW_LOOKUPS} related entity types.`));
  }
  rawLookups.slice(0, MAX_VIEW_LOOKUPS).forEach((item, index) => {
    const alias = text(item?.alias);
    const direction = text(item?.direction).toUpperCase();
    const from = text(item?.from);
    const where = `lookups[${index}]`;
    if (!ALIAS.test(alias) || alias.endsWith(ALTERNATE_ALIAS_SUFFIX)) {
      errors.push(invalid(where, `Related entity ${index + 1} needs a short name of letters, digits and _.`));
      return;
    }
    if (aliases.has(alias)) {
      errors.push(invalid(where, `Two related entities are both called ${alias}.`));
      return;
    }
    if (direction !== 'UP' && direction !== 'DOWN') {
      errors.push(invalid(where, `Related entity ${alias} needs a direction.`));
      return;
    }
    if (from && !aliases.has(from)) {
      errors.push(invalid(where, `Related entity ${alias} starts from ${from}, which is not listed before it.`));
      return;
    }
    aliases.add(alias);
    lookups.push({
      alias,
      direction,
      ...(text(item?.relationshipCode) ? { relationshipCode: text(item.relationshipCode) } : {}),
      ...(text(item?.domainCode) ? { domainCode: text(item.domainCode) } : {}),
      ...(from ? { from } : {}),
      ...(text(item?.label) ? { label: text(item.label).slice(0, 200) } : {}),
    });
  });

  const columns: EntityViewColumn[] = [];
  const seen = new Set<string>();
  const rawColumns: any[] = Array.isArray(raw?.columns) ? raw.columns : [];
  if (rawColumns.length === 0) errors.push(invalid('columns', 'Add at least one column.'));
  if (rawColumns.length > MAX_VIEW_COLUMNS) {
    errors.push(invalid('columns', `A view can have at most ${MAX_VIEW_COLUMNS} columns.`));
  }
  rawColumns.slice(0, MAX_VIEW_COLUMNS).forEach((item, index) => {
    const field = text(item?.field);
    const source = text(item?.source);
    const where = `columns[${index}]`;
    const dot = field.indexOf('.');
    const alias = dot >= 0 ? field.slice(0, dot) : '';
    const code = dot >= 0 ? field.slice(dot + 1) : field;
    if (alias && !aliases.has(alias)) {
      errors.push(invalid(where, `Column ${field} uses a related entity the view does not define.`));
      return;
    }
    if (!BUILTINS.has(code) && !ATTRIBUTE.test(code)) {
      errors.push(invalid(where, `Column ${index + 1} does not name an attribute.`));
      return;
    }
    if (source && (BUILTINS.has(code) || !SOURCE.test(source))) {
      errors.push(invalid(where, BUILTINS.has(code)
        ? `Column ${field} is the record's own ${code === 'entity_code' ? 'code' : 'name'} and has no source.`
        : `Column ${field} names a source that is not a source code.`));
      return;
    }
    const column: EntityViewColumn = {
      field,
      ...(source ? { source } : {}),
      ...(text(item?.label) ? { label: text(item.label).slice(0, 200) } : {}),
      ...(item?.pinned === true ? { pinned: true } : {}),
    };
    const key = viewGridField(column);
    if (seen.has(key)) {
      errors.push(invalid(where, `Column ${key} is listed twice.`));
      return;
    }
    seen.add(key);
    columns.push(column);
  });

  const sort: EntityViewSort[] = [];
  const rawSort: any[] = Array.isArray(raw?.sort) ? raw.sort : [];
  for (const item of rawSort.slice(0, 4)) {
    const field = text(item?.field);
    if (!field || !(seen.has(field) || BUILTINS.has(field))) continue;
    sort.push({ field, dir: text(item?.dir).toLowerCase() === 'desc' ? 'desc' : 'asc' });
  }

  const order = Number(raw?.displayOrder);
  return {
    value: {
      domainCode,
      viewName,
      description: text(raw?.description) || null,
      columns,
      lookups,
      sort,
      filterId: text(raw?.filterId) || null,
      displayOrder: Number.isFinite(order) ? Math.trunc(order) : null,
    },
    errors,
  };
}
