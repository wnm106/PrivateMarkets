/**
 * What one client calls an entity type, and which shared fields it hides.
 *
 * The database decides both (supabase/migrations/20261124120000): the public
 * views give the session its client's names and hidden fields, and
 * `client_catalog_settings`, `set_client_domain_label` and
 * `set_client_attributes_hidden` read and change them. This module only shapes
 * what the settings screen shows.
 */
import type { GridRequest } from './data-query-engine';

/** The answer of public.client_catalog_settings. */
export interface ClientCatalogRow {
  client_id: string | null;
  can_edit: boolean;
  domain_code: string;
  catalog_name: string;
  display_name: string | null;
  hidden_attribute_ids: string[];
  /** The type's shared aliases and this client's own. Absent until the alias migration is in. */
  aliases: Array<{ id: string; label: string; client: boolean }>;
}

export interface ClientTypeAlias {
  id: string;
  label: string;
  /** True for a shared alias every client reads; false for this client's own. */
  shared: boolean;
}

/** The client's own words first, then the shared ones, each in name order. */
export function shapeAliases(aliases: ClientCatalogRow['aliases']): ClientTypeAlias[] {
  return aliases
    .map((alias) => ({ id: alias.id, label: alias.label, shared: !alias.client }))
    .sort((a, b) => Number(a.shared) - Number(b.shared) || a.label.localeCompare(b.label));
}

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
  /** Records of this type holding a value today. Null when it could not be counted. */
  recordsWithValue: number | null;
}

/** How many fields one grid request counts. Each is a column of the pivot. */
export const USAGE_BATCH = 100;

export function parseSettingsRow(value: unknown): ClientCatalogRow {
  const row = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<ClientCatalogRow> | null;
  if (!row || typeof row !== 'object' || !row.domain_code) {
    throw new Error('The client settings could not be read.');
  }
  return {
    client_id: row.client_id ?? null,
    can_edit: row.can_edit === true,
    domain_code: String(row.domain_code),
    catalog_name: String(row.catalog_name ?? row.domain_code),
    display_name: row.display_name ? String(row.display_name) : null,
    hidden_attribute_ids: Array.isArray(row.hidden_attribute_ids) ? row.hidden_attribute_ids.map(String) : [],
    aliases: (Array.isArray(row.aliases) ? row.aliases : [])
      .filter((alias: any) => alias?.id && alias?.label)
      .map((alias: any) => ({ id: String(alias.id), label: String(alias.label), client: alias.client === true })),
  };
}

/**
 * Grid requests that count, for each field, the records of one entity type
 * holding a value. The grid reads values the way every list does and runs as
 * the caller, so the count covers the records the session's client can see.
 */
export function usageRequests(domainCode: string, attributeCodes: readonly string[]): GridRequest[] {
  const codes = [...new Set(attributeCodes.filter((code) => /^[A-Za-z0-9_]+$/.test(code)))];
  const requests: GridRequest[] = [];
  for (let index = 0; index < codes.length; index += USAGE_BATCH) {
    requests.push({
      start: 'DOMAIN',
      domainCode,
      flat: true,
      metrics: codes.slice(index, index + USAGE_BATCH).map((code) => ({ alias: code, agg: 'COUNT', field: code })),
      limit: 1,
    });
  }
  return requests;
}

/** Field code to record count, from the single row each usage request returns. */
export function usageCounts(rows: ReadonlyArray<Record<string, unknown> | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const [code, value] of Object.entries(row || {})) {
      const count = Number(value);
      if (Number.isFinite(count)) counts.set(code, count);
    }
  }
  return counts;
}

/**
 * The fields of one entity type as the settings screen lists them: by section,
 * then by name. `usage` is null when the counts could not be read.
 */
export function shapeFields(
  attributes: ReadonlyArray<Record<string, any>>,
  hiddenIds: readonly string[],
  usage: Map<string, number> | null,
): ClientCatalogField[] {
  const hidden = new Set(hiddenIds);
  return attributes
    .map((row) => ({
      attributeId: String(row.id),
      attributeCode: String(row.attribute_code),
      attributeName: String(row.attribute_name || row.attribute_code),
      displaySection: String(row.display_section || 'General'),
      isRequired: row.is_required === true,
      isDerived: row.is_derived === true,
      catalogIsVisible: (row.catalog_is_visible ?? row.is_visible) !== false,
      hidden: hidden.has(String(row.id)),
      recordsWithValue: usage ? usage.get(String(row.attribute_code)) ?? 0 : null,
    }))
    .sort((a, b) =>
      a.displaySection.localeCompare(b.displaySection) || a.attributeName.localeCompare(b.attributeName));
}

/** A database refusal in the words the screen shows. */
export function settingsError(message: string | null | undefined): string {
  const text = String(message || '').trim();
  if (!text) return 'The change could not be saved.';
  if (/row-level security/i.test(text)) return 'You cannot change this client\'s settings.';
  if (/Could not find the function|does not exist/i.test(text)) {
    return 'Client names and hidden fields are not set up on this database yet.';
  }
  return text;
}
