/**
 * Views: saved data tables that belong to an entity type.
 *
 * A column is an attribute of the view's entity type ("PRICE") or of a related
 * record reached through a lookup ("sec.PRICE"). It reads the golden value
 * unless it names a source; the grid field is then "PRICE@BLOOMBERG".
 * The server checks the same shape in packages/graphql/src/lib/entity-views.ts.
 */

export const GOLDEN = 'GOLDEN';
/** The grid is also asked for each lookup walked the other way, under this suffix. */
export const ALTERNATE_ALIAS_SUFFIX = '_alt';

export interface EntityViewLookup {
  alias: string;
  direction: 'UP' | 'DOWN';
  relationshipCode?: string;
  domainCode?: string;
  from?: string;
  label?: string;
}

export interface EntityViewColumn {
  field: string;
  source?: string;
  label?: string;
  /** Locked to the left edge of the grid. */
  pinned?: boolean;
}

export interface EntityViewSort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface EntityView {
  id: string;
  domainCode: string;
  viewName: string;
  description?: string | null;
  columns: EntityViewColumn[];
  lookups: EntityViewLookup[];
  sort: EntityViewSort[];
  displayOrder: number;
  updatedAt?: string | null;
}

export type EntityViewDraft = Omit<EntityView, 'id' | 'displayOrder' | 'updatedAt'> & { id?: string | null; displayOrder?: number };

const VIEW_FIELDS = 'id domainCode viewName description columns lookups sort displayOrder updatedAt';

export const ENTITY_VIEWS_QUERY = `
  query EntityViews($domainCode: String!) {
    entityViews(domainCode: $domainCode) { ${VIEW_FIELDS} }
  }
`;

export const SAVE_ENTITY_VIEW_MUTATION = `
  mutation SaveEntityView($id: ID, $input: EntityViewInput!) {
    saveEntityView(id: $id, input: $input) {
      view { ${VIEW_FIELDS} }
      errors { field message code }
    }
  }
`;

export const DELETE_ENTITY_VIEW_MUTATION = `
  mutation DeleteEntityView($id: ID!) {
    deleteEntityView(id: $id) { success errors { field message code } }
  }
`;

/** The field the grid reads for a column. */
export function viewGridField(column: Pick<EntityViewColumn, 'field' | 'source'>): string {
  const source = (column.source || '').trim();
  return source && source !== GOLDEN ? `${column.field}@${source}` : column.field;
}

export function columnAlias(field: string): string | null {
  const dot = field.indexOf('.');
  return dot >= 0 ? field.slice(0, dot) : null;
}

export function columnCode(field: string): string {
  const dot = field.indexOf('.');
  return dot >= 0 ? field.slice(dot + 1) : field;
}

function alternate(field: string): string | null {
  const alias = columnAlias(field);
  return alias ? `${alias}${ALTERNATE_ALIAS_SUFFIX}.${columnCode(field)}` : null;
}

export interface ViewGridRequest {
  start: 'DOMAIN';
  domainCode: string;
  asOfDate: string | null;
  knowledgeDate: string | null;
  lookups: EntityViewLookup[];
  columns: string[];
  sort: EntityViewSort[];
  offset: number;
  limit: number;
}

/**
 * The grid request for a view. A relationship can be stored either way round,
 * so each lookup is also walked in the opposite direction and the row takes
 * whichever side has a value (the same rule the entity register uses).
 */
export function viewGridRequest(
  view: Pick<EntityView, 'domainCode' | 'columns' | 'lookups' | 'sort'>,
  dates: { asOfDate?: string | null; knowledgeDate?: string | null },
  limit = 10000,
): ViewGridRequest {
  const lookups = view.lookups || [];
  const alternates = lookups.map((lookup) => ({
    ...lookup,
    alias: `${lookup.alias}${ALTERNATE_ALIAS_SUFFIX}`,
    direction: lookup.direction === 'UP' ? 'DOWN' as const : 'UP' as const,
  }));
  const fields = (view.columns || []).map(viewGridField);
  const altFields = (view.columns || [])
    .map((column) => alternate(viewGridField(column)))
    .filter((field): field is string => !!field);
  const builtins = new Set(['entity_code', 'entity_name']);
  // The related record each row reached, so a cell can open that record's sources.
  const recordFields = [...new Set(fields.map(columnAlias).filter((alias): alias is string => !!alias))]
    .flatMap((alias) => [alias, `${alias}${ALTERNATE_ALIAS_SUFFIX}`])
    .flatMap((alias) => [`${alias}.entity_id`, `${alias}.entity_name`]);
  return {
    start: 'DOMAIN',
    domainCode: view.domainCode,
    asOfDate: dates.asOfDate || null,
    knowledgeDate: dates.knowledgeDate || null,
    lookups: [...lookups, ...alternates],
    columns: [...new Set([...fields.filter((field) => !builtins.has(field)), ...altFields, ...recordFields])],
    sort: (view.sort && view.sort.length ? view.sort : [{ field: 'entity_name', dir: 'asc' as const }])
      .map((item) => ({ field: item.field, dir: item.dir })),
    offset: 0,
    limit,
  };
}

/** The related record a cell's value came from. */
export interface ViewCellRecord {
  id: string;
  name: string;
}

/** Key under which a view row keeps, per related column, the record its value came from. */
export const VIEW_ROW_RECORDS = '__records';

/**
 * One row per record, keyed by grid field, with each related value taken from
 * whichever side has it. Each related column also notes which record that was.
 */
export function viewRows(
  rows: Array<Record<string, unknown>>,
  view: Pick<EntityView, 'columns'>,
): Array<Record<string, unknown>> {
  const fields = (view.columns || []).map(viewGridField);
  const text = (value: unknown) => (value == null ? '' : String(value));
  return rows.map((row) => {
    const next: Record<string, unknown> = {
      entity_id: row.entity_id,
      entity_code: row.entity_code,
      entity_name: row.entity_name,
    };
    const records: Record<string, ViewCellRecord> = {};
    for (const field of fields) {
      const primary = row[field];
      const alias = columnAlias(field);
      const alt = alternate(field);
      const fromAlt = (primary == null || primary === '') && alt != null && row[alt] != null && row[alt] !== '';
      next[field] = fromAlt ? row[alt!] : primary ?? null;
      if (alias) {
        // The record the value came from; with no value, whichever record the row reached.
        const side = fromAlt || (row[`${alias}.entity_id`] == null) ? `${alias}${ALTERNATE_ALIAS_SUFFIX}` : alias;
        const id = text(row[`${side}.entity_id`]);
        if (id) records[field] = { id, name: text(row[`${side}.entity_name`]) };
      }
    }
    if (Object.keys(records).length) next[VIEW_ROW_RECORDS] = records;
    return next;
  });
}

/** The next free lookup alias, such as r1, r2. */
export function nextLookupAlias(lookups: Array<Pick<EntityViewLookup, 'alias'>>): string {
  const used = new Set(lookups.map((lookup) => lookup.alias));
  let index = 1;
  while (used.has(`r${index}`)) index += 1;
  return `r${index}`;
}

/** Remove a lookup, every lookup chained from it, and their columns. */
export function withoutLookup<T extends Pick<EntityView, 'lookups' | 'columns' | 'sort'>>(view: T, alias: string): T {
  const removed = new Set([alias]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const lookup of view.lookups) {
      if (lookup.from && removed.has(lookup.from) && !removed.has(lookup.alias)) {
        removed.add(lookup.alias);
        grew = true;
      }
    }
  }
  const columns = view.columns.filter((column) => !removed.has(columnAlias(column.field) || ''));
  const kept = new Set(columns.map(viewGridField));
  return {
    ...view,
    lookups: view.lookups.filter((lookup) => !removed.has(lookup.alias)),
    columns,
    sort: view.sort.filter((item) => kept.has(item.field) || item.field === 'entity_code' || item.field === 'entity_name'),
  };
}

export interface ViewRelationshipType {
  relationshipCode: string;
  relationshipName?: string | null;
  parentDomainCode?: string | null;
  childDomainCode?: string | null;
  isActive?: boolean | null;
}

export interface RelatedEntity {
  domainCode: string;
  label: string;
  /** The way the relationship is defined. The grid also walks the other way. */
  direction: 'UP' | 'DOWN';
}

function titleCase(code: string): string {
  return code.toLowerCase().split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The entity types related to one entity type, once each.
 *
 * A view reaches a related entity by its type, not by one relationship code:
 * links can be stored under either of two codes, or the other way round from
 * the definition, and the grid finds them all when the lookup names only the
 * related type and is walked both ways (see viewGridRequest).
 */
export function relatedEntities(
  domainCode: string,
  types: ViewRelationshipType[],
  names: Record<string, string> = {},
): RelatedEntity[] {
  const found = new Map<string, RelatedEntity>();
  for (const type of types) {
    if (type.isActive === false) continue;
    if (type.childDomainCode === domainCode && type.parentDomainCode && type.parentDomainCode !== domainCode) {
      found.set(type.parentDomainCode, { domainCode: type.parentDomainCode, label: names[type.parentDomainCode] || titleCase(type.parentDomainCode), direction: 'UP' });
    }
    if (type.parentDomainCode === domainCode && type.childDomainCode && type.childDomainCode !== domainCode && !found.has(type.childDomainCode)) {
      found.set(type.childDomainCode, { domainCode: type.childDomainCode, label: names[type.childDomainCode] || titleCase(type.childDomainCode), direction: 'DOWN' });
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The lookup that reaches this related entity from `from` (a lookup alias, or the view's own records). */
export function findLookup(
  view: Pick<EntityView, 'lookups'>,
  from: string | null,
  domainCode: string,
): EntityViewLookup | null {
  return view.lookups.find((lookup) => (lookup.from || null) === from && lookup.domainCode === domainCode) || null;
}

/** Add a lookup for a related entity unless the view already has one. */
export function ensureLookup<T extends Pick<EntityView, 'lookups'>>(
  view: T,
  from: string | null,
  entity: RelatedEntity,
): { view: T; alias: string } {
  const existing = findLookup(view, from, entity.domainCode);
  if (existing) return { view, alias: existing.alias };
  const alias = nextLookupAlias(view.lookups);
  const lookup: EntityViewLookup = {
    alias,
    direction: entity.direction,
    domainCode: entity.domainCode,
    label: entity.label,
    ...(from ? { from } : {}),
  };
  return { view: { ...view, lookups: [...view.lookups, lookup] }, alias };
}

/** Drop lookups no column uses, keeping the ones a used lookup starts from. */
export function pruneLookups<T extends Pick<EntityView, 'lookups' | 'columns'>>(view: T): T {
  const keep = new Set<string>();
  for (const column of view.columns) {
    let alias = columnAlias(column.field);
    while (alias && !keep.has(alias)) {
      keep.add(alias);
      alias = view.lookups.find((lookup) => lookup.alias === alias)?.from || null;
    }
  }
  return { ...view, lookups: view.lookups.filter((lookup) => keep.has(lookup.alias)) };
}
