/**
 * Words people use for an entity type, for a record's name, and for a field.
 * The stored lists are domain_aliases, entity_name_aliases, attribute_aliases,
 * and entity_aliases. Matching compares a normalized phrase, so "Project Name"
 * and "project_name" are the same words.
 */

export interface DomainAlias {
  domainCode: string;
  aliasLabel: string;
  aliasCode: string;
}

export interface EntityNameAlias {
  domainCode: string;
  aliasLabel: string;
  aliasCode: string;
}

export interface AttributeAlias {
  attributeCode: string;
  aliasLabel: string;
  domainCode?: string | null;
}

export type HeaderKind = 'entity_name' | 'attribute_alias' | 'none';

export interface HeaderClassification {
  kind: HeaderKind;
  domainCode: string | null;
  aliasLabel: string | null;
  aliasCode: string | null;
  attributeCode: string | null;
}

export function aliasPhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function phrasesEqual(left: string, right: string): boolean {
  const a = aliasPhrase(left);
  const b = aliasPhrase(right);
  return a.length > 0 && a === b;
}

function scoped<T extends { domainCode?: string | null }>(rows: readonly T[], domainCode?: string | null): T[] {
  if (!domainCode) return [...rows];
  const code = domainCode.toUpperCase();
  return rows.filter((row) => !row.domainCode || row.domainCode.toUpperCase() === code);
}

/**
 * What a column header is, before a fuzzy attribute match.
 * A name alias such as "Project name" is the record's name.
 * A type alias on its own, such as "Borrower", is that record's name too.
 * An attribute alias such as "Ending NAV" is that field.
 */
export function classifyHeader(
  header: string,
  input: {
    domainCode?: string | null;
    domainAliases?: readonly DomainAlias[];
    nameAliases?: readonly EntityNameAlias[];
    attributeAliases?: readonly AttributeAlias[];
  },
): HeaderClassification {
  const empty: HeaderClassification = {
    kind: 'none',
    domainCode: input.domainCode || null,
    aliasLabel: null,
    aliasCode: null,
    attributeCode: null,
  };
  const phrase = aliasPhrase(header);
  if (!phrase) return empty;

  const name = scoped(input.nameAliases || [], input.domainCode).find((alias) => phrasesEqual(header, alias.aliasLabel) || phrasesEqual(header, alias.aliasCode));
  if (name) {
    return {
      kind: 'entity_name',
      domainCode: name.domainCode,
      aliasLabel: name.aliasLabel,
      aliasCode: name.aliasCode,
      attributeCode: null,
    };
  }

  const attribute = scoped(input.attributeAliases || [], input.domainCode).find((alias) => phrasesEqual(header, alias.aliasLabel));
  if (attribute) {
    return {
      kind: 'attribute_alias',
      domainCode: input.domainCode || attribute.domainCode || null,
      aliasLabel: attribute.aliasLabel,
      aliasCode: null,
      attributeCode: attribute.attributeCode,
    };
  }

  const typeAlias = scoped(input.domainAliases || [], input.domainCode).find((alias) => phrasesEqual(header, alias.aliasLabel) || phrasesEqual(header, alias.aliasCode));
  if (typeAlias) {
    return {
      kind: 'entity_name',
      domainCode: typeAlias.domainCode,
      aliasLabel: typeAlias.aliasLabel,
      aliasCode: typeAlias.aliasCode,
      attributeCode: null,
    };
  }

  return empty;
}

export interface AttributeSearchHit {
  attribute_code: string;
  attribute_name: string | null;
  description: string | null;
  data_type: string | null;
  reference_domain_code: string | null;
  domain_code: string | null;
  matched_alias: string | null;
  match: 'attribute' | 'attribute_alias' | 'entity_name';
}

export interface EntityTypeSearchHit {
  domain_code: string;
  domain_name: string | null;
  matched_alias: string | null;
  match: 'entity_type';
}

export interface AliasSearchResult {
  attributes: AttributeSearchHit[];
  entityTypes: EntityTypeSearchHit[];
  entityNames: AttributeSearchHit[];
}

interface AttributeRow {
  id?: string;
  attribute_code: string;
  attribute_name?: string | null;
  description?: string | null;
  data_type?: string | null;
  reference_domain_code?: string | null;
  domain_code?: string | null;
}

/**
 * Keep the rows whose code, name, description, or stored alias actually contains
 * the words. A database filter may return a wider set; this is the list chat sees.
 */
export function assembleAttributeSearch(
  query: string,
  input: {
    attributes?: readonly AttributeRow[];
    attributeAliases?: readonly { attributeId?: string; attributeCode?: string; aliasLabel: string; aliasCode?: string; domainCode?: string | null }[];
    nameAliases?: readonly EntityNameAlias[];
    domainAliases?: readonly DomainAlias[];
    domains?: readonly { domainCode: string; domainName?: string | null }[];
    limit?: number;
  },
): AliasSearchResult {
  const phrase = aliasPhrase(query);
  const cap = Math.min(Math.max(input.limit || 15, 1), 30);
  if (phrase.length < 2) return { attributes: [], entityTypes: [], entityNames: [] };

  const contains = (value: string | null | undefined) => aliasPhrase(value || '').includes(phrase);
  const byId = new Map((input.attributes || []).filter((row) => row.id).map((row) => [row.id as string, row]));
  const byCode = new Map((input.attributes || []).map((row) => [row.attribute_code, row]));

  const attributes: AttributeSearchHit[] = [];
  const seen = new Set<string>();
  const pushAttribute = (hit: AttributeSearchHit) => {
    if (seen.has(hit.attribute_code) || attributes.length >= cap) return;
    seen.add(hit.attribute_code);
    attributes.push(hit);
  };

  for (const row of input.attributes || []) {
    if (contains(row.attribute_code) || contains(row.attribute_name) || contains(row.description)) {
      pushAttribute({
        attribute_code: row.attribute_code,
        attribute_name: row.attribute_name || null,
        description: row.description || null,
        data_type: row.data_type || null,
        reference_domain_code: row.reference_domain_code || null,
        domain_code: row.domain_code || null,
        matched_alias: null,
        match: 'attribute',
      });
    }
  }

  for (const alias of input.attributeAliases || []) {
    if (!contains(alias.aliasLabel) && !contains(alias.aliasCode)) continue;
    const row = (alias.attributeId && byId.get(alias.attributeId)) || (alias.attributeCode && byCode.get(alias.attributeCode)) || null;
    const code = row?.attribute_code || alias.attributeCode;
    if (!code) continue;
    if (seen.has(code)) continue;
    pushAttribute({
      attribute_code: code,
      attribute_name: row?.attribute_name || null,
      description: row?.description || null,
      data_type: row?.data_type || null,
      reference_domain_code: row?.reference_domain_code || null,
      domain_code: alias.domainCode || row?.domain_code || null,
      matched_alias: alias.aliasLabel,
      match: 'attribute_alias',
    });
  }

  const entityNames: AttributeSearchHit[] = [];
  for (const alias of input.nameAliases || []) {
    if (entityNames.length >= cap) break;
    if (!contains(alias.aliasLabel) && !contains(alias.aliasCode)) continue;
    entityNames.push({
      attribute_code: 'entity_name',
      attribute_name: 'Name',
      description: `${alias.aliasLabel} is the name of a ${alias.domainCode} record.`,
      data_type: 'STRING',
      reference_domain_code: null,
      domain_code: alias.domainCode,
      matched_alias: alias.aliasLabel,
      match: 'entity_name',
    });
  }

  const domainName = new Map((input.domains || []).map((domain) => [domain.domainCode, domain.domainName || domain.domainCode]));
  const entityTypes: EntityTypeSearchHit[] = [];
  const seenTypes = new Set<string>();
  for (const alias of input.domainAliases || []) {
    if (entityTypes.length >= cap) break;
    if (!contains(alias.aliasLabel) && !contains(alias.aliasCode)) continue;
    if (seenTypes.has(alias.domainCode)) continue;
    seenTypes.add(alias.domainCode);
    entityTypes.push({
      domain_code: alias.domainCode,
      domain_name: domainName.get(alias.domainCode) || null,
      matched_alias: alias.aliasLabel,
      match: 'entity_type',
    });
  }

  return { attributes, entityTypes, entityNames };
}

export interface StoredAlias {
  aliasCode: string;
  aliasLabel: string;
}

/** Pull entity_name and entity_alias:<CODE> out of a mapped attribute bag. */
export function takeIdentityTargets(attributes: Record<string, unknown>): {
  attributes: Record<string, unknown>;
  entityName: string | null;
  aliases: StoredAlias[];
} {
  const rest: Record<string, unknown> = {};
  let entityName: string | null = null;
  const aliases: StoredAlias[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'entity_name') {
      entityName = String(value);
      continue;
    }
    if (key.startsWith('entity_alias:')) {
      const aliasCode = key.slice('entity_alias:'.length).trim();
      if (aliasCode) aliases.push({ aliasCode, aliasLabel: String(value) });
      continue;
    }
    rest[key] = value;
  }
  return { attributes: rest, entityName, aliases };
}

/** A code that can be stored on one record. Letters, digits, and underscores. */
export function aliasCodeFromLabel(label: string): string {
  const code = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_').slice(0, 100);
  return code || 'ALIAS';
}

export function entityAliasKind(aliasCode: string): string {
  return aliasCode.includes('PROJECT') ? 'project' : 'name';
}

/**
 * The code stored for one other name. A catalog code such as PROJECT_NAME is kept
 * when it is one of this entity type's name aliases. Anything else is taken from the words.
 */
export function resolveStoredAlias(
  label: string,
  requestedCode: string | null | undefined,
  allowedCodes: readonly string[],
): { aliasLabel: string; aliasCode: string; aliasKind: string } | { error: string } {
  const aliasLabel = label.trim().slice(0, 500);
  if (!aliasLabel) return { error: 'A name is required' };
  const requested = (requestedCode || '').trim().toUpperCase();
  const aliasCode = requested && allowedCodes.includes(requested) ? requested : aliasCodeFromLabel(aliasLabel);
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(aliasCode)) return { error: 'That name cannot be stored' };
  return { aliasLabel, aliasCode, aliasKind: entityAliasKind(aliasCode) };
}

type AliasWriter = {
  from: (table: string) => {
    upsert: (rows: unknown[], options: { onConflict: string }) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/** Store other names of one record. The same alias code on that record is replaced. */
export async function saveEntityAliases(
  supabase: AliasWriter,
  entityId: string,
  aliases: readonly StoredAlias[],
): Promise<void> {
  const rows = aliases
    .map((alias) => ({
      entity_id: entityId,
      alias_code: alias.aliasCode.slice(0, 100),
      alias_label: alias.aliasLabel.trim().slice(0, 500),
      alias_kind: alias.aliasCode.includes('PROJECT') ? 'project' : 'name',
      is_active: true,
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.alias_code && row.alias_label);
  if (rows.length === 0) return;
  const { error } = await supabase.from('entity_aliases').upsert(rows, { onConflict: 'entity_id,alias_code' });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// The alias lists, read in one place
// ---------------------------------------------------------------------------

export interface AttributeAliasWord {
  attributeId: string;
  aliasLabel: string;
  aliasCode: string | null;
  domainCode: string | null;
}

/**
 * The words one client uses: its own aliases and the names it gives entity
 * types first, then the shared aliases those do not replace. The database puts
 * the lists together (metadata_register.alias_words), so import mapping, chat
 * search and the Excel formula builder all read the same words.
 */
export interface AliasWords {
  /** The client the words are for. Null means the shared lists only. */
  clientId: string | null;
  /** Entity type code to the name the client gives that type. */
  labels: Record<string, string>;
  domainAliases: DomainAlias[];
  nameAliases: EntityNameAlias[];
  attributeAliases: AttributeAliasWord[];
  /** Fields the client hides. Still stored and loadable; shown as hidden where a person picks a field. */
  hiddenAttributeIds: string[];
}

export const NO_ALIAS_WORDS: AliasWords = {
  clientId: null,
  labels: {},
  domainAliases: [],
  nameAliases: [],
  attributeAliases: [],
  hiddenAttributeIds: [],
};

function mapTypeWord(row: any): DomainAlias {
  return { domainCode: String(row.domain_code), aliasLabel: String(row.alias_label), aliasCode: String(row.alias_code || '') };
}

function mapAttributeWord(row: any): AttributeAliasWord {
  return {
    attributeId: String(row.attribute_id),
    aliasLabel: String(row.alias_label),
    aliasCode: row.alias_code ? String(row.alias_code) : null,
    domainCode: row.domain_code ? String(row.domain_code) : null,
  };
}

/** The answer of metadata_register.alias_words, as the app reads it. */
export function parseAliasWords(value: unknown): AliasWords {
  const row = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, any> | null;
  if (!row || typeof row !== 'object') return NO_ALIAS_WORDS;
  const list = (key: string): any[] => (Array.isArray(row[key]) ? row[key] : []);
  const labels: Record<string, string> = {};
  if (row.labels && typeof row.labels === 'object') {
    for (const [code, name] of Object.entries(row.labels)) {
      if (typeof name === 'string' && name.trim()) labels[code] = name;
    }
  }
  return {
    clientId: row.client_id ? String(row.client_id) : null,
    labels,
    domainAliases: list('types').filter((item) => item?.domain_code && item?.alias_label).map(mapTypeWord),
    nameAliases: list('names').filter((item) => item?.domain_code && item?.alias_label).map(mapTypeWord),
    attributeAliases: list('attributes').filter((item) => item?.attribute_id && item?.alias_label).map(mapAttributeWord),
    hiddenAttributeIds: list('hidden_attribute_ids').map(String),
  };
}

/** Field id to the other words for that field. */
export function aliasLabelsByAttribute(words: Pick<AliasWords, 'attributeAliases'>): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const alias of words.attributeAliases) {
    const list = labels.get(alias.attributeId) || [];
    if (!list.includes(alias.aliasLabel)) list.push(alias.aliasLabel);
    labels.set(alias.attributeId, list);
  }
  return labels;
}

type AliasReader = {
  from: (table: string) => any;
  rpc?: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  schema?: (name: string) => any;
};

/**
 * The shared lists read from the three tables, as every reader did before the
 * database could put them together. Used when that function is not there yet,
 * so a build deployed ahead of its migration reads what it always read.
 */
async function sharedAliasWords(tables: { from: (table: string) => any }): Promise<AliasWords> {
  const [types, names, attributes] = await Promise.all([
    tables.from('domain_aliases').select('domain_code, alias_label, alias_code').eq('is_active', true),
    tables.from('entity_name_aliases').select('domain_code, alias_label, alias_code').eq('is_active', true),
    tables.from('attribute_aliases').select('attribute_id, alias_label, alias_code, domain_code').eq('is_active', true),
  ]);
  const failure = types.error || names.error || attributes.error;
  if (failure) throw new Error(failure.message);
  return {
    ...NO_ALIAS_WORDS,
    domainAliases: (types.data || []).map(mapTypeWord),
    nameAliases: (names.data || []).map(mapTypeWord),
    attributeAliases: (attributes.data || []).map(mapAttributeWord),
  };
}

/**
 * The words to match on. With no `clientId`, the caller's own session decides
 * the client (a signed-in request). Server code that reads everything passes
 * the client a job is for, or null for the shared lists.
 */
export async function loadAliasWords(
  supabase: AliasReader,
  options: { clientId?: string | null } = {},
): Promise<AliasWords> {
  const forNamedClient = 'clientId' in options;
  const register = forNamedClient && supabase.schema ? supabase.schema('metadata_register') : supabase;
  try {
    const call = forNamedClient
      ? register.rpc?.('alias_words', { p_client_id: options.clientId ?? null })
      : supabase.rpc?.('session_alias_words');
    if (call) {
      const { data, error } = await call;
      if (!error && data) return parseAliasWords(data);
    }
  } catch {
    // Fall through to the tables.
  }
  return sharedAliasWords(register);
}
