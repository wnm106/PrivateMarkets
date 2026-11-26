/**
 * The "For this client" settings of an entity type: what the client calls the
 * type and which shared fields it hides. The database holds and applies both
 * (docs/ALIASES.md, "Per client"); this is how the screen reads them.
 */

export interface ClientCatalogField {
  attributeId: string;
  attributeCode: string;
  attributeName: string;
  displaySection: string;
  isRequired: boolean;
  isDerived: boolean;
  /** False when the catalog hides the field for every client. */
  catalogIsVisible: boolean;
  /** True when this client hides it. */
  hidden: boolean;
  /** Records of this type holding a value today. Null when it was not counted. */
  recordsWithValue: number | null;
  /** Who sees the values by the catalog: STANDARD, CONFIDENTIAL or RESTRICTED. */
  accessLevel?: string;
  /** This client's own level, when it set one. */
  clientAccessLevel?: string | null;
}

export const ACCESS_LEVEL_LABEL: Record<string, string> = {
  STANDARD: 'Everyone',
  CONFIDENTIAL: 'Confidential',
  RESTRICTED: 'Restricted',
};

/** The level in force for this client, and whether it is the client's own choice. */
export function effectiveAccessLevel(field: Pick<ClientCatalogField, 'accessLevel' | 'clientAccessLevel'>): { level: string; own: boolean } {
  if (field.clientAccessLevel) return { level: field.clientAccessLevel, own: true };
  return { level: field.accessLevel || 'STANDARD', own: false };
}

export interface ClientTypeAlias {
  id: string;
  label: string;
  /** True for a shared alias every client reads; false for this client's own. */
  shared: boolean;
}

export interface ClientCatalogSettings {
  clientId: string | null;
  clientName: string | null;
  canEdit: boolean;
  domainCode: string;
  catalogName: string;
  displayName: string | null;
  recordCount: number | null;
  aliases: ClientTypeAlias[];
  fields: ClientCatalogField[];
}

/**
 * Every word import mapping and search match to this type for the client:
 * the name the client gives it, the catalog name, its own aliases, then the
 * shared ones. The first two are not aliases and cannot be removed here.
 */
export function matchedWords(settings: ClientCatalogSettings): Array<{ key: string; label: string; kind: 'name' | 'catalog' | 'own' | 'shared'; id?: string }> {
  const words: Array<{ key: string; label: string; kind: 'name' | 'catalog' | 'own' | 'shared'; id?: string }> = [];
  if (settings.displayName) words.push({ key: 'name', label: settings.displayName, kind: 'name' });
  words.push({ key: 'catalog', label: settings.catalogName, kind: 'catalog' });
  for (const alias of settings.aliases || []) {
    words.push({ key: alias.id, label: alias.label, kind: alias.shared ? 'shared' : 'own', id: alias.id });
  }
  return words;
}

export type FieldState = 'shown' | 'hidden' | 'required' | 'catalog-hidden';
export type FieldFilter = 'all' | 'hidden' | 'unused';

/** Why a field's Hide box is on, off, or cannot be changed. */
export function fieldState(field: ClientCatalogField): FieldState {
  if (!field.catalogIsVisible) return 'catalog-hidden';
  if (field.hidden) return 'hidden';
  if (field.isRequired) return 'required';
  return 'shown';
}

/** A field this client can hide or show. */
export function canToggle(field: ClientCatalogField): boolean {
  const state = fieldState(field);
  return state === 'shown' || state === 'hidden';
}

/** Shown fields no record holds a value in. Empty when usage was not counted. */
export function unusedFields(fields: readonly ClientCatalogField[]): ClientCatalogField[] {
  return fields.filter((field) => fieldState(field) === 'shown' && field.recordsWithValue === 0);
}

export function filterFields(
  fields: readonly ClientCatalogField[],
  filter: FieldFilter,
  search: string,
): ClientCatalogField[] {
  const words = search.trim().toLowerCase();
  const unused = filter === 'unused' ? new Set(unusedFields(fields).map((field) => field.attributeId)) : null;
  return fields.filter((field) => {
    if (filter === 'hidden' && !field.hidden) return false;
    if (unused && !unused.has(field.attributeId)) return false;
    if (!words) return true;
    return field.attributeName.toLowerCase().includes(words)
      || field.attributeCode.toLowerCase().includes(words)
      || field.displaySection.toLowerCase().includes(words);
  });
}

/**
 * The settings after a change. A change answers without recounting usage, so
 * the counts already on screen are kept and only the names and flags move.
 */
export function mergeSettings(current: ClientCatalogSettings | null, next: ClientCatalogSettings): ClientCatalogSettings {
  if (!current) return next;
  const counts = new Map(current.fields.map((field) => [field.attributeId, field.recordsWithValue]));
  return {
    ...next,
    recordCount: next.recordCount ?? current.recordCount,
    fields: next.fields.map((field) => ({
      ...field,
      recordsWithValue: field.recordsWithValue ?? counts.get(field.attributeId) ?? null,
    })),
  };
}

/** "12 of 113", "None", or a dash when usage was not counted. */
export function usageLabel(field: ClientCatalogField, recordCount: number | null): string {
  if (field.recordsWithValue === null) return '\u2014';
  if (field.recordsWithValue === 0) return 'None';
  const count = field.recordsWithValue.toLocaleString('en-US');
  return recordCount && recordCount > 0 ? `${count} of ${recordCount.toLocaleString('en-US')}` : count;
}

/** One line under the field list's title. */
export function fieldSummary(fields: readonly ClientCatalogField[]): string {
  const hidden = fields.filter((field) => field.hidden).length;
  const unused = unusedFields(fields).length;
  const parts = [`${fields.length} field${fields.length === 1 ? '' : 's'}`, `${hidden} hidden`];
  if (fields.some((field) => field.recordsWithValue !== null)) parts.push(`${unused} shown with no value`);
  return parts.join(' \u00b7 ');
}

/** What the name box holds when it opens, and whether saving would change anything. */
export function nameChanged(settings: ClientCatalogSettings, draft: string): boolean {
  return draft.trim() !== (settings.displayName || '');
}
