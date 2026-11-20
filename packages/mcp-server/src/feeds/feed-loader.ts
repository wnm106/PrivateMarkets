import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EntityMatchIndex, codeUnavailableMessage, identifierCatalog, type IdentifierCatalog, type IdentifierTerm, type MatchEntity, type ResolveHit } from './entity-match';
import { chooseRelationship, dependencyLoadOrder, dependencyLoadWaves, relationshipEndpoints, type RelationshipTypeRow } from './load-order';
import { readImportFile } from './intake';
import { parseTabularFile } from './parse-table';
import { POSITION_FILE_MAP } from './position-file-map';
import { normalizeSourceCode, resolveRowContext } from './row-context';
import { compactIdentifier } from '../../../graphql/src/lib/entity-resolution/similarity';
import type { DomainLoadStats, EntityResolution, EntityResolutionDecision, FeedLoadResult, FeedMap, FeedPreview, LoadReject, NormalizationHit, ParsedTable } from './types';
import { emptyReferenceIndex, indexReferences, matchReference, referenceLookups, type ReferenceIndex } from './references';
import { applyTransform, coerceAttributeValue, dayBefore, planPeriod, indexReferenceLists, normalizeToList, parseUsDate, type ListValueRow } from './values';

const OPEN_TO = '9999-12-31';
const OPEN_SYSTEM_TO = '9999-12-31 23:59:59';
const MAX_REJECTS = 500;
const DRY_PREFIX = 'dry:';
/** Client that scripts and tests load into. The app always passes the signed-in user's client instead. */
export const DEFAULT_CLIENT_CODE = 'MERIDIAN_INTERNAL';

interface AttributeMeta {
  id: string;
  attribute_code: string;
  data_type: string;
  reference_list_code: string | null;
  /** For REFERENCE attributes: the entity type the value names. */
  reference_domain_code: string | null;
}

/** The entity type a reference attribute points to. */
function referenceDomainOf(meta: AttributeMeta | undefined): string | null {
  return meta && meta.data_type === 'REFERENCE' && meta.reference_domain_code ? meta.reference_domain_code : null;
}

/** Values one source reported for one record as of one date. A file can hold several per record. */
interface ValuePeriod {
  asOf: string;
  sourceCode: string;
  attributes: Map<string, string>;
  /** The row and column each value was first read from, for pointing back at the source. */
  origins: Map<string, { row: number; column: string }>;
}

interface EntityDraft {
  code: string;
  name: string;
  /** Other names of this record, such as a project name for the borrower. */
  aliases: { aliasCode: string; aliasLabel: string }[];
  /** First non-blank value across all rows. Used to match the record to an existing one. */
  attributes: Map<string, string>;
  parents: Map<string, string>;
  /** Earliest as-of date on any row for this record. Links start here. */
  asOf: string;
  sourceCode: string;
  periods: Map<string, ValuePeriod>;
}

interface ValueSource {
  id: string;
  rank: number;
}

interface Catalog {
  clientId: string;
  sourceId: string;
  precedenceRank: number;
  templates: Map<string, string>;
  attributes: Map<string, AttributeMeta>;
  lists: ReturnType<typeof indexReferenceLists>;
  relationshipTypes: RelationshipTypeRow[];
}

function allowedDatabaseHosts(): Set<string> {
  const hosts = new Set<string>(['127.0.0.1', 'localhost']);
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  try {
    const host = new URL(configured).hostname;
    if (host) hosts.add(host);
  } catch {
    // An unset or unparseable project URL still allows localhost.
  }
  return hosts;
}

export function assertLocalSupabase(client: SupabaseClient) {
  const url = (client as SupabaseClient & { supabaseUrl?: string }).supabaseUrl || '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Supabase URL is not valid');
  }
  if (!allowedDatabaseHosts().has(host)) {
    throw new Error('Position file loads run only against the local database');
  }
}

export function localSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    throw new Error('Local Supabase URL and service role key are required');
  }
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  assertLocalSupabase(client);
  return client;
}

function mappedColumns(map: FeedMap): Set<string> {
  const columns = new Set<string>();
  if (map.asOfHintColumn) columns.add(map.asOfHintColumn);
  if (map.sourceHintColumn) columns.add(map.sourceHintColumn);
  if (map.rowFilter) columns.add(map.rowFilter.column);
  for (const domain of map.domains) {
    columns.add(domain.identityColumn);
    columns.add(domain.nameColumn);
    for (const alias of domain.aliasColumns || []) columns.add(alias.column);
    for (const attribute of domain.attributes) columns.add(attribute.column);
    for (const parent of domain.parents) columns.add(parent.column);
  }
  return columns;
}

function readCell(row: Record<string, string>, column: string, map: FeedMap): string {
  const raw = row[column] ?? '';
  const transform = map.transforms?.[column];
  if (!transform) return raw.trim();
  return applyTransform(raw, transform);
}

function filterRows(map: FeedMap, table: ParsedTable): Record<string, string>[] {
  if (!map.rowFilter) return table.rows;
  const { column, equals } = map.rowFilter;
  if (!table.headers.includes(column)) return table.rows;
  return table.rows.filter((row) => readCell(row, column, map) === equals);
}

function suggestedAsOf(map: FeedMap, rows: Record<string, string>[]): string | null {
  if (!map.asOfHintColumn) return null;
  const dates = new Set<string>();
  for (const row of rows) {
    const raw = readCell(row, map.asOfHintColumn, map);
    if (!raw) continue;
    const iso = parseUsDate(raw);
    if (iso) dates.add(iso);
  }
  return dates.size === 1 ? [...dates][0] : null;
}

function collectDrafts(
  map: FeedMap,
  rows: Record<string, string>[],
  fallback: { asOf: string; source: string },
  originOf: (row: Record<string, string>) => number | undefined = () => undefined,
): Map<string, EntityDraft[]> {
  const byDomain = new Map<string, Map<string, EntityDraft>>();
  for (const domain of map.domains) byDomain.set(domain.domainCode, new Map());

  for (const row of rows) {
    const context = resolveRowContext(row, map, fallback, (record, column) => readCell(record, column, map));
    for (const domain of map.domains) {
      const code = readCell(row, domain.identityColumn, map);
      if (!code) continue;
      const bucket = byDomain.get(domain.domainCode) as Map<string, EntityDraft>;
      let draft = bucket.get(code);
      if (!draft) {
        draft = {
          code,
          name: readCell(row, domain.nameColumn, map) || code,
          aliases: [],
          attributes: new Map(),
          parents: new Map(),
          asOf: context.asOf,
          sourceCode: context.source,
          periods: new Map(),
        };
        bucket.set(code, draft);
      }
      if (context.asOf < draft.asOf) draft.asOf = context.asOf;
      const periodKey = `${context.asOf}|${context.source}`;
      let period = draft.periods.get(periodKey);
      if (!period) {
        period = { asOf: context.asOf, sourceCode: context.source, attributes: new Map(), origins: new Map() };
        draft.periods.set(periodKey, period);
      }
      const name = readCell(row, domain.nameColumn, map);
      if (name && draft.name === draft.code) draft.name = name;
      for (const alias of domain.aliasColumns || []) {
        const value = readCell(row, alias.column, map);
        if (value && !draft.aliases.some((item) => item.aliasCode === alias.aliasCode)) {
          draft.aliases.push({ aliasCode: alias.aliasCode, aliasLabel: value });
        }
      }
      for (const attribute of domain.attributes) {
        const value = readCell(row, attribute.column, map);
        if (value && !draft.attributes.has(attribute.attributeCode)) {
          draft.attributes.set(attribute.attributeCode, value);
        }
        if (value && !period.attributes.has(attribute.attributeCode)) {
          period.attributes.set(attribute.attributeCode, value);
          const originRow = originOf(row);
          if (originRow !== undefined) period.origins.set(attribute.attributeCode, { row: originRow, column: attribute.column });
        }
      }
      for (const parent of domain.parents) {
        const parentCode = readCell(row, parent.column, map);
        if (!parentCode) continue;
        const key = parent.parentDomainCode;
        if (!draft.parents.has(key)) draft.parents.set(key, parentCode);
      }
    }
  }

  const result = new Map<string, EntityDraft[]>();
  for (const [domainCode, drafts] of byDomain) result.set(domainCode, [...drafts.values()]);
  return result;
}

export async function defaultClientId(db: SupabaseClient): Promise<string> {
  const found = await db.schema('tenancy').from('clients').select('id').eq('client_code', DEFAULT_CLIENT_CODE).single();
  if (found.error || !found.data?.id) throw new Error(`Client ${DEFAULT_CLIENT_CODE} was not found`);
  return found.data.id;
}

async function loadCatalog(db: SupabaseClient, map: FeedMap, clientId: string): Promise<Catalog> {
  const attributeCodes = [...new Set(map.domains.flatMap((domain) => domain.attributes.map((attribute) => attribute.attributeCode)))];
  const templateCodes = [...new Set(map.domains.map((domain) => domain.templateCode))];

  if (!clientId) throw new Error('A client is required to load a file');
  const [source, templates, attributes, listValues, relationshipTypes] = await Promise.all([
    db.schema('entity_instances').from('source_registry').select('id, precedence_rank').eq('source_code', map.sourceCode).single(),
    templateCodes.length
      ? db.schema('metadata_register').from('domain_templates').select('id, template_code').in('template_code', templateCodes)
      : Promise.resolve({ data: [], error: null }),
    attributeCodes.length
      ? db.schema('metadata_register').from('attribute_register').select('id, attribute_code, data_type, reference_list_code, reference_domain_code').in('attribute_code', attributeCodes)
      : Promise.resolve({ data: [], error: null }),
    db.schema('metadata_register').from('reference_list_values').select('value_code, value_label, synonyms, list:reference_lists!inner(list_code)'),
    db.schema('metadata_register').from('relationship_types').select('relationship_code, parent_domain_code, child_domain_code, is_required').eq('is_active', true),
  ]);

  const failure = source.error || templates.error || attributes.error || listValues.error || relationshipTypes.error;
  if (failure) throw new Error(failure.message);
  if (!source.data?.id) throw new Error(`Source ${map.sourceCode} is not in the source registry.`);

  const lists: ListValueRow[] = (listValues.data || []).map((row: any) => ({
    list_code: row.list?.list_code,
    value_code: row.value_code,
    value_label: row.value_label,
    synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
  }));

  return {
    clientId,
    sourceId: source.data.id,
    precedenceRank: source.data.precedence_rank ?? 45,
    templates: new Map((templates.data || []).map((row: any) => [row.template_code, row.id])),
    attributes: new Map((attributes.data || []).map((row: any) => [row.attribute_code, row])),
    lists: indexReferenceLists(lists.filter((row) => row.list_code)),
    relationshipTypes: (relationshipTypes.data || []) as RelationshipTypeRow[],
  };
}

async function rememberMap(db: SupabaseClient, clientId: string, map: FeedMap, sourceId: string) {
  const payload = {
    client_id: clientId,
    map_code: map.mapCode,
    source_id: sourceId,
    map_name: map.name,
    description: map.description,
    column_mappings: map,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const existing = await db.schema('entity_instances').from('feed_maps').select('id').eq('client_id', clientId).eq('map_code', map.mapCode).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const write = existing.data
    ? await db.schema('entity_instances').from('feed_maps').update(payload).eq('id', existing.data.id)
    : await db.schema('entity_instances').from('feed_maps').insert(payload);
  if (write.error) throw new Error(write.error.message);
}

/** Where a stored value came from: the file, the cell, and its place on the page. */
function sourceRef(
  table: ParsedTable,
  origin: { row: number; column: string },
  provenance: { instanceId: string; tableId: string | null },
) {
  const columnIndex = table.headers.indexOf(origin.column);
  const location = columnIndex >= 0 ? table.locations?.[origin.row]?.[columnIndex] || null : null;
  const size = location ? table.pages?.find((page) => page.page === location.page) || null : null;
  return {
    instance_id: provenance.instanceId,
    table_id: provenance.tableId,
    row: origin.row,
    column: origin.column,
    location,
    page_size: size ? { width: size.width, height: size.height } : null,
  };
}

function normalizationFor(
  catalog: Catalog,
  attributeCode: string,
  raw: string
): { stored: string; hit: NormalizationHit | null } {
  const meta = catalog.attributes.get(attributeCode);
  if (!meta?.reference_list_code) return { stored: raw, hit: null };
  const normalized = normalizeToList(catalog.lists, meta.reference_list_code, raw);
  if (!normalized) return { stored: raw, hit: null };
  const hit: NormalizationHit = {
    attributeCode,
    listCode: meta.reference_list_code,
    input: raw,
    canonicalCode: normalized.canonicalCode,
    canonicalLabel: normalized.canonicalLabel,
    matchType: normalized.matchType,
  };
  return { stored: normalized.canonicalCode || raw, hit };
}

/**
 * Lookups for every record the reference values in these drafts could name:
 * records in this file (already given ids) and records already stored for the client.
 */
async function loadReferenceIndexes(
  db: SupabaseClient,
  catalog: Catalog,
  entities: EntityDraft[],
  fileIds: Map<string, Map<string, string>>,
  drafts: Map<string, EntityDraft[]>,
): Promise<Map<string, ReferenceIndex>> {
  const rawsByDomain = new Map<string, Set<string>>();
  for (const entity of entities) {
    for (const period of entity.periods.values()) {
      for (const [attributeCode, raw] of period.attributes) {
        const target = referenceDomainOf(catalog.attributes.get(attributeCode));
        if (!target || !raw.trim()) continue;
        if (!rawsByDomain.has(target)) rawsByDomain.set(target, new Set());
        rawsByDomain.get(target)!.add(raw.trim());
      }
    }
  }

  const indexes = new Map<string, ReferenceIndex>();
  for (const [target, raws] of rawsByDomain) {
    const index = emptyReferenceIndex();
    const inFile = fileIds.get(target);
    if (inFile) {
      indexReferences(index, (drafts.get(target) || []).flatMap((draft) => {
        const id = inFile.get(draft.code);
        return id ? [{ id, code: draft.code, name: draft.name }] : [];
      }));
    }
    const { ids, texts } = referenceLookups(raws);
    const lookups: Array<{ column: 'id' | 'entity_code' | 'entity_name'; values: string[] }> = [
      { column: 'id', values: ids },
      { column: 'entity_code', values: texts },
      { column: 'entity_name', values: texts },
    ];
    for (const lookup of lookups) {
      for (let from = 0; from < lookup.values.length; from += 200) {
        const found = await db.schema('entity_instances').from('master_entities')
          .select('id, entity_code, entity_name')
          .eq('domain_code', target)
          .eq('client_id', catalog.clientId)
          .is('merged_into_id', null)
          .in(lookup.column, lookup.values.slice(from, from + 200));
        if (found.error) throw new Error(found.error.message);
        indexReferences(index, (found.data || []).map((row: any) => ({ id: row.id, code: row.entity_code, name: row.entity_name })));
      }
    }
    indexes.set(target, index);
  }
  return indexes;
}

function distinctNormalizations(hits: NormalizationHit[]): NormalizationHit[] {
  const seen = new Map<string, NormalizationHit>();
  for (const hit of hits) {
    const key = `${hit.attributeCode}|${hit.input}`;
    if (!seen.has(key)) seen.set(key, hit);
  }
  return [...seen.values()].sort((a, b) => a.attributeCode.localeCompare(b.attributeCode) || a.input.localeCompare(b.input));
}

async function tableFromFile(fileName: string, bytes: Buffer): Promise<ParsedTable> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.json')) {
    return (await readImportFile(fileName, bytes)).table;
  }
  try {
    const read = await readImportFile(fileName, bytes);
    if (read.kind === 'NAV_STATEMENT' || read.kind === 'FINANCIAL_STATEMENT') return read.table;
  } catch {
    // A plain spreadsheet stays on the tabular parser.
  }
  return parseTabularFile(fileName, bytes);
}

export async function previewFeed(map: FeedMap, fileName: string, bytes: Buffer, clientId: string): Promise<FeedPreview> {
  const table = await tableFromFile(fileName, bytes);
  const rows = filterRows(map, table);
  const drafts = collectDrafts(map, rows, { asOf: suggestedAsOf(map, rows) || '1970-01-01', source: map.sourceCode });
  const db = localSupabase();
  const catalog = await loadCatalog(db, map, clientId);
  const used = mappedColumns(map);
  const hits: NormalizationHit[] = [];
  const warnings: string[] = [];

  for (const domain of map.domains) {
    for (const draft of drafts.get(domain.domainCode) || []) {
      for (const [attributeCode, raw] of draft.attributes) {
        if (!catalog.attributes.has(attributeCode)) {
          warnings.push(`${domain.domainCode}.${attributeCode} is not in the attribute register`);
          continue;
        }
        const { hit } = normalizationFor(catalog, attributeCode, raw);
        if (hit) hits.push(hit);
      }
    }
  }

  const domains = map.domains.map((domain) => ({
    domainCode: domain.domainCode,
    templateCode: domain.templateCode,
    identityColumn: domain.identityColumn,
    nameColumn: domain.nameColumn,
    distinctEntities: (drafts.get(domain.domainCode) || []).length,
    attributeColumns: domain.attributes,
    parentColumns: domain.parents.map((parent) => ({
      column: parent.column,
      parentDomainCode: parent.parentDomainCode,
      relationshipCode: chooseRelationship(domain.domainCode, parent.parentDomainCode, catalog.relationshipTypes)?.relationship_code || null,
    })),
  }));

  const unmapped = hits.filter((hit) => hit.matchType === 'unmapped');
  for (const hit of distinctNormalizations(unmapped)) {
    warnings.push(`${hit.attributeCode} value "${hit.input}" is not in list ${hit.listCode}`);
  }

  return {
    mapCode: map.mapCode,
    sourceCode: map.sourceCode,
    fileName,
    rowCount: rows.length,
    headers: table.headers,
    loadWaves: dependencyLoadWaves(map.domains),
    domains,
    unmappedColumns: table.headers.filter((header) => !used.has(header)),
    contextColumns: [
      ...(map.rowFilter ? [{ column: map.rowFilter.column, purpose: `Keep rows where the value is ${map.rowFilter.equals}` }] : []),
      ...(map.asOfHintColumn ? [{ column: map.asOfHintColumn, purpose: 'As-of date for each row. A blank cell keeps the date chosen for the file.' }] : []),
      ...(map.sourceHintColumn ? [{ column: map.sourceHintColumn, purpose: 'Source for each row. A blank cell keeps the file source.' }] : []),
    ],
    suggestedAsOfDate: suggestedAsOf(map, rows),
    normalizations: distinctNormalizations(hits),
    warnings: [...new Set(warnings)],
  };
}

async function pageRows(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>,
): Promise<any[]> {
  const pageSize = 1000;
  const rows: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (page.error) throw new Error(page.error.message);
    rows.push(...(page.data || []));
    if ((page.data || []).length < pageSize) break;
  }
  return rows;
}

async function loadIdentifierCatalog(db: SupabaseClient, domainCode: string): Promise<{ catalog: IdentifierCatalog; attributeIds: Map<string, string> }> {
  const definitions = await db.schema('metadata_register').from('entity_identifier_definitions').select('attribute_codes').eq('domain_code', domainCode).eq('is_active', true);
  if (definitions.error) throw new Error(definitions.error.message);
  const catalog = identifierCatalog((definitions.data || []).map((row: { attribute_codes?: string[] }) => row.attribute_codes || []));
  const codes = [...new Set([...catalog.singles, ...catalog.composites.flat()])];
  const attributeIds = new Map<string, string>();
  if (!codes.length) return { catalog, attributeIds };
  const attributes = await db.schema('metadata_register').from('attribute_register').select('id, attribute_code').in('attribute_code', codes);
  if (attributes.error) throw new Error(attributes.error.message);
  for (const row of attributes.data || []) attributeIds.set(String(row.attribute_code).toUpperCase(), row.id);
  return { catalog, attributeIds };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Of these record ids, the ones that belong to the client. An id of another
 * client's record is dropped, and so is one that does not exist. The loader
 * writes with the service role, so this is what keeps a write inside the client.
 */
async function clientEntityIds(db: SupabaseClient, clientId: string, ids: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
  const own = new Set<string>();
  for (let offset = 0; offset < wanted.length; offset += 150) {
    const found = await db.schema('entity_instances').from('master_entities')
      .select('id')
      .eq('client_id', clientId)
      .in('id', wanted.slice(offset, offset + 150));
    if (found.error) throw new Error(found.error.message);
    for (const row of found.data || []) own.add(row.id);
  }
  return own;
}

/**
 * The records a file row may match: this client's, and no one else's. The
 * loader reads with the service role, so every read here names the client.
 */
async function loadEntityMatchIndex(
  db: SupabaseClient,
  domainCode: string,
  clientId: string,
  codes: string[],
  catalog: IdentifierCatalog,
  attributeIds: Map<string, string>,
): Promise<EntityMatchIndex> {
  const index = new EntityMatchIndex(catalog, domainCode, clientId);
  const domainRows = await pageRows((from, to) => db.schema('entity_instances').from('master_entities')
    .select('id, entity_code, entity_name, domain_code, client_id, is_active, merged_into_id')
    .eq('domain_code', domainCode)
    .eq('client_id', clientId)
    .range(from, to));
  const codeRows: any[] = [];
  for (let offset = 0; offset < codes.length; offset += 100) {
    const chunk = codes.slice(offset, offset + 100);
    // This client's records of any type, so a code it already uses for another type is refused by name.
    const existing = await db.schema('entity_instances').from('master_entities')
      .select('id, entity_code, entity_name, domain_code, client_id, is_active, merged_into_id')
      .eq('client_id', clientId)
      .in('entity_code', chunk);
    if (existing.error) throw new Error(existing.error.message);
    codeRows.push(...(existing.data || []));
    // Codes are unique across every client. One held elsewhere cannot be created here, and the
    // code is all that is read about it: no id, no name, nothing that can reach the caller.
    const taken = await db.schema('entity_instances').from('master_entities')
      .select('entity_code')
      .neq('client_id', clientId)
      .in('entity_code', chunk);
    if (taken.error) throw new Error(taken.error.message);
    for (const row of taken.data || []) index.reserveCode(String(row.entity_code));
  }

  const byId = new Map<string, any>();
  for (const row of [...domainRows, ...codeRows]) byId.set(row.id, row);
  const terms = new Map<string, Map<string, IdentifierTerm[]>>();
  const codeByAttributeId = new Map<string, string>();
  for (const [code, id] of attributeIds) codeByAttributeId.set(id, code);
  const attributeIdList = [...attributeIds.values()];
  const entityIds = [...byId.keys()];
  if (attributeIdList.length && entityIds.length) {
    for (let offset = 0; offset < entityIds.length; offset += 150) {
      const chunk = entityIds.slice(offset, offset + 150);
      const values = await pageRows((from, to) => db.schema('golden_master').from('entity_attribute_values')
        .select('entity_id, attribute_id, golden_value, valid_from, valid_to')
        .in('entity_id', chunk)
        .in('attribute_id', attributeIdList)
        .eq('system_to', OPEN_SYSTEM_TO)
        .range(from, to));
      for (const value of values) {
        const attributeCode = codeByAttributeId.get(value.attribute_id);
        if (!attributeCode || value.golden_value == null || String(value.golden_value).trim() === '') continue;
        const perEntity = terms.get(value.entity_id) || new Map<string, IdentifierTerm[]>();
        const list = perEntity.get(attributeCode) || [];
        list.push({
          value: String(value.golden_value),
          validFrom: String(value.valid_from).slice(0, 10),
          validTo: String(value.valid_to).slice(0, 10),
        });
        perEntity.set(attributeCode, list);
        terms.set(value.entity_id, perEntity);
      }
    }
  }

  const aliasByEntity = new Map<string, string[]>();
  for (let offset = 0; offset < entityIds.length; offset += 150) {
    const chunk = entityIds.slice(offset, offset + 150);
    const stored = await db.schema('entity_instances').from('entity_aliases').select('entity_id, alias_label').eq('is_active', true).in('entity_id', chunk);
    if (stored.error) throw new Error(stored.error.message);
    for (const row of stored.data || []) {
      const label = String(row.alias_label || '').trim();
      if (!label) continue;
      const list = aliasByEntity.get(row.entity_id) || [];
      list.push(label);
      aliasByEntity.set(row.entity_id, list);
    }
  }

  for (const row of byId.values()) {
    const matchEntity: MatchEntity = {
      id: row.id,
      code: row.entity_code,
      name: row.entity_name || '',
      domainCode: row.domain_code,
      clientId: row.client_id,
      active: row.is_active !== false && !row.merged_into_id,
      provisional: false,
      identifiers: new Map(),
      identifierTerms: terms.get(row.id) || new Map(),
      aliases: aliasByEntity.get(row.id) || [],
    };
    index.add(matchEntity);
  }
  return index;
}

async function storeDraftAliases(db: SupabaseClient, entities: EntityDraft[], idByCode: Map<string, string>): Promise<void> {
  const rows: { entity_id: string; alias_code: string; alias_label: string; alias_kind: string; is_active: boolean; updated_at: string }[] = [];
  for (const entity of entities) {
    const id = idByCode.get(entity.code);
    if (!id || id.startsWith('pending:') || id.startsWith(DRY_PREFIX)) continue;
    for (const alias of entity.aliases) {
      const label = alias.aliasLabel.trim();
      if (!label || !alias.aliasCode) continue;
      rows.push({
        entity_id: id,
        alias_code: alias.aliasCode.slice(0, 100),
        alias_label: label.slice(0, 500),
        alias_kind: alias.aliasCode.includes('PROJECT') ? 'project' : 'name',
        is_active: true,
        updated_at: new Date().toISOString(),
      });
    }
  }
  if (rows.length === 0) return;
  const saved = await db.schema('entity_instances').from('entity_aliases').upsert(rows, { onConflict: 'entity_id,alias_code' });
  if (saved.error) throw new Error(saved.error.message);
}

function sameValue(existing: any, next: { golden_value: string; golden_value_numeric: number | null; golden_value_date: string | null }): boolean {
  if ((existing.golden_value ?? '') !== next.golden_value) return false;
  const existingNumber = existing.golden_value_numeric === null || existing.golden_value_numeric === undefined ? null : Number(existing.golden_value_numeric);
  if (existingNumber !== next.golden_value_numeric) return false;
  const existingDate = existing.golden_value_date ? String(existing.golden_value_date).slice(0, 10) : null;
  return existingDate === next.golden_value_date;
}

async function loadValueSources(db: SupabaseClient, codes: string[], allowMissing = false): Promise<Map<string, ValueSource>> {
  const wanted = [...new Set(codes.map((code) => normalizeSourceCode(code)).filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = await db.schema('entity_instances').from('source_registry').select('id, source_code, precedence_rank').in('source_code', wanted);
  if (rows.error) throw new Error(rows.error.message);
  const found = new Map<string, ValueSource>();
  for (const row of rows.data || []) {
    found.set(normalizeSourceCode(String(row.source_code)), { id: row.id, rank: row.precedence_rank ?? 100 });
  }
  const missing = wanted.filter((code) => !found.has(code));
  if (missing.length > 0 && allowMissing) {
    // A review can run before a new source is created. Rank it like any other file source.
    for (const code of missing) found.set(code, { id: `${DRY_PREFIX}source:${code}`, rank: 50 });
  } else if (missing.length > 0) {
    throw new Error(`Source ${missing.join(', ')} was not found.`);
  }
  return found;
}

function decisionFor(decisions: EntityResolutionDecision[] | undefined, domainCode: string, fileCode: string) {
  return decisions?.find((item) => item.domainCode === domainCode && item.fileCode === fileCode);
}

function sharedIdentifiers(entity: EntityDraft, catalog: IdentifierCatalog): { attributeCode: string; value: string }[] {
  const tracked = new Set([...catalog.singles, ...catalog.composites.flat()]);
  const found: { attributeCode: string; value: string }[] = [];
  for (const [code, value] of entity.attributes) {
    const key = code.trim().toUpperCase();
    if (!tracked.has(key) || !value.trim()) continue;
    found.push({ attributeCode: key, value });
  }
  return found;
}

function resolutionFrom(domainCode: string, entity: EntityDraft, hit: Extract<ResolveHit, { kind: 'ambiguous' }>, asOf: string, catalog: IdentifierCatalog, clientId: string): EntityResolution {
  return {
    domainCode,
    fileCode: entity.code,
    fileName: entity.name,
    asOf: entity.asOf || asOf,
    via: hit.via,
    message: hit.message,
    // These go back to the person loading the file, so only their own client's records are named.
    candidates: hit.entities.filter((item) => !item.provisional && item.clientId === clientId).map((item) => ({ id: item.id, code: item.code, name: item.name })),
    identifiers: sharedIdentifiers(entity, catalog),
  };
}

/** A unique-key failure on the record code. The database says which key, which is more than the caller should learn. */
function isDuplicateCode(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error) && (error?.code === '23505' || /duplicate key|entity_code/i.test(error?.message || ''));
}

/**
 * Close identifier values on records the file row was told apart from. Only
 * records of this client are touched, whatever ids are passed in.
 */
async function cleanseDuplicateIdentifiers(
  db: SupabaseClient,
  clientId: string,
  entityIds: string[],
  entity: EntityDraft,
  catalog: IdentifierCatalog,
  attributeIds: Map<string, string>,
  asOf: string,
  actor: { updated_by?: string } = {},
) {
  const shared = sharedIdentifiers(entity, catalog);
  if (!shared.length || !entityIds.length) return;
  const own = await clientEntityIds(db, clientId, entityIds);
  if (own.size === 0) return;
  const now = new Date().toISOString();
  for (const identifier of shared) {
    const attributeId = attributeIds.get(identifier.attributeCode);
    if (!attributeId) continue;
    const wanted = compactIdentifier(identifier.value);
    for (const entityId of own) {
      const rows = await db.schema('golden_master').from('entity_attribute_values')
        .select('*')
        .eq('entity_id', entityId)
        .eq('attribute_id', attributeId)
        .eq('system_to', OPEN_SYSTEM_TO);
      if (rows.error) throw new Error(rows.error.message);
      for (const row of rows.data || []) {
        if (compactIdentifier(String(row.golden_value || '')) !== wanted) continue;
        const started = String(row.valid_from).slice(0, 10);
        const ended = String(row.valid_to).slice(0, 10);
        if (ended < asOf || started > asOf) continue;
        const close = await db.schema('golden_master').from('entity_attribute_values').update({ system_to: now, ...actor }).eq('id', row.id);
        if (close.error) throw new Error(close.error.message);
        if (started >= asOf) continue;
        const historyEnd = dayBefore(asOf);
        if (historyEnd < started) continue;
        const copy = { ...row };
        delete copy.id;
        delete copy.created_at;
        copy.valid_from = started;
        copy.valid_to = historyEnd;
        copy.system_from = now;
        copy.system_to = OPEN_SYSTEM_TO;
        Object.assign(copy, actor);
        const insert = await db.schema('golden_master').from('entity_attribute_values').insert(copy);
        if (insert.error) throw new Error(insert.error.message);
      }
    }
  }
}

/**
 * What a load does, told as it happens. A dry run tells the records and values it
 * would write, which is how a batch is staged. A real load tells each live row it
 * changes in place, which is what lets the batch be reverted.
 */
export interface LoadRecorder {
  record?(event: {
    domainCode: string;
    fileCode: string;
    name: string;
    action: 'CREATE' | 'MATCH';
    entityId: string | null;
    templateId: string | null;
    via?: string;
  }): void;
  value?(event: {
    domainCode: string;
    fileCode: string;
    attributeCode: string;
    attributeId: string;
    sourceId: string | null;
    precedenceRank: number;
    validFrom: string;
    action: 'INSERT' | 'UPDATE' | 'UNCHANGED';
    raw: string;
    proposed: string | null;
    current: string | null;
    row?: number;
    column?: string;
  }): void;
  journal?(event: {
    kind: 'VALUE_UPDATE' | 'VALUE_CLOSE' | 'LINK_CLOSE' | 'RECORD_RENAME';
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }): void;
}

export interface LoadOptions {
  dryRun?: boolean;
  provenance?: { instanceId: string; tableId: string | null };
  decisions?: EntityResolutionDecision[];
  recorder?: LoadRecorder;
  /** Stamped on every value, link and record a real load writes. */
  batchId?: string;
  /**
   * The signed-in user the load runs for. Recorded as who created or changed
   * each record and value. Left out for an unattended feed, which has no person.
   */
  actorId?: string | null;
}

export async function executeFeed(map: FeedMap, fileName: string, bytes: Buffer, asOfDate: string, client?: SupabaseClient, clientId?: string): Promise<FeedLoadResult> {
  const db = client || localSupabase();
  return executeParsedFeed(map, fileName, await tableFromFile(fileName, bytes), asOfDate, db, clientId || await defaultClientId(db));
}

export async function executeParsedFeed(
  map: FeedMap,
  fileName: string,
  table: ParsedTable,
  asOfDate: string,
  client: SupabaseClient | undefined,
  clientId: string,
  fallbackSource?: string,
  options: LoadOptions = {},
): Promise<FeedLoadResult> {
  const dry = options.dryRun === true;
  const decisions = options.decisions;
  const recorder = options.recorder;
  const batchTag: Record<string, string> = !dry && options.batchId ? { load_batch_id: options.batchId } : {};
  const actorId = !dry && options.actorId && UUID.test(options.actorId) ? options.actorId : null;
  const createdBy: { created_by?: string; updated_by?: string } = actorId ? { created_by: actorId, updated_by: actorId } : {};
  const updatedBy: { updated_by?: string } = actorId ? { updated_by: actorId } : {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error('As-of date must be YYYY-MM-DD');
  }
  const rows = filterRows(map, table);
  const rowNumber = new Map<Record<string, string>, number>();
  table.rows.forEach((row, index) => rowNumber.set(row, index));
  const drafts = collectDrafts(map, rows, { asOf: asOfDate, source: fallbackSource || map.sourceCode }, (row) => rowNumber.get(row));
  const order = dependencyLoadOrder(map.domains);
  const waves = dependencyLoadWaves(map.domains);
  const db = client || localSupabase();
  assertLocalSupabase(db);
  const catalog = await loadCatalog(db, map, clientId);
  const mapSource = normalizeSourceCode(map.sourceCode);
  const draftSources = new Set<string>([mapSource]);
  const asOfDates = new Set<string>([asOfDate]);
  for (const entities of drafts.values()) {
    for (const entity of entities) {
      for (const period of entity.periods.values()) {
        draftSources.add(normalizeSourceCode(period.sourceCode));
        asOfDates.add(period.asOf);
      }
    }
  }
  const varying = [...draftSources].some((code) => code !== mapSource) || [...asOfDates].some((date) => date !== asOfDate);
  const valueSources = varying
    ? await loadValueSources(db, [...draftSources], dry)
    : new Map<string, ValueSource>([[mapSource, { id: catalog.sourceId, rank: catalog.precedenceRank }]]);
  if (!dry) await rememberMap(db, clientId, map, catalog.sourceId);

  const ids = new Map<string, Map<string, string>>();
  const domainByCode = new Map(map.domains.map((domain) => [domain.domainCode, domain]));
  const externalByDomain = new Map<string, Set<string>>();
  for (const domain of map.domains) {
    for (const parent of domain.parents) {
      if (domainByCode.has(parent.parentDomainCode) || !parent.existing) continue;
      const codes = externalByDomain.get(parent.parentDomainCode) || new Set<string>();
      for (const entity of drafts.get(domain.domainCode) || []) {
        const code = entity.parents.get(parent.parentDomainCode);
        if (code) codes.add(code);
      }
      externalByDomain.set(parent.parentDomainCode, codes);
    }
  }
  const externalIds = new Map<string, Map<string, string>>();
  for (const [domainCode, codes] of externalByDomain) {
    const list = [...codes];
    // A parent named by code is looked for among this client's records only.
    const found = list.length
      ? await db.schema('entity_instances').from('master_entities').select('id, entity_code').eq('domain_code', domainCode).eq('client_id', catalog.clientId).in('entity_code', list)
      : { data: [], error: null };
    if (found.error) throw new Error(found.error.message);
    externalIds.set(domainCode, new Map((found.data || []).map((row: any) => [row.entity_code, row.id])));
  }
  const domainStats: DomainLoadStats[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const hits: NormalizationHit[] = [];
  const rejects: LoadReject[] = [];
  let rejectCount = 0;
  const reject = (item: LoadReject) => {
    rejectCount += 1;
    if (rejects.length < MAX_REJECTS) rejects.push(item);
  };
  const attributeStats = { created: 0, updated: 0, unchanged: 0 };
  const relationshipStats = { created: 0, matched: 0, failed: 0 };
  const receivedAt = new Date().toISOString();
  const resolutions: EntityResolution[] = [];

  // A "map" decision names the stored record a file row is. The id comes from the caller, so it is
  // checked against the database before anything else: it must be a record of this client.
  const mapTargets = (decisions || []).filter((item) => item.action === 'map' && item.entityId).map((item) => String(item.entityId));
  const mappable = mapTargets.length ? await clientEntityIds(db, catalog.clientId, mapTargets) : new Set<string>();
  const chosenFor = (hit: Extract<ResolveHit, { kind: 'ambiguous' }>, decision: EntityResolutionDecision) =>
    hit.entities.find((item) => item.id === decision.entityId && item.clientId === catalog.clientId && mappable.has(item.id));

  for (const domainCode of order) {
    const domain = domainByCode.get(domainCode);
    if (!domain) continue;
    const entities = drafts.get(domainCode) || [];
    const { catalog: matchCatalog, attributeIds } = await loadIdentifierCatalog(db, domainCode);
    const index = await loadEntityMatchIndex(db, domainCode, catalog.clientId, entities.map((entity) => entity.code), matchCatalog, attributeIds);
    for (const entity of entities) {
      const incoming = { code: entity.code, name: entity.name, attributes: entity.attributes, aliases: entity.aliases.map((alias) => alias.aliasLabel) };
      const hit = index.resolve(incoming, entity.asOf || asOfDate);
      const decision = decisionFor(decisions, domainCode, entity.code);
      if (hit.kind === 'ambiguous' && !decision) {
        resolutions.push(resolutionFrom(domainCode, entity, hit, asOfDate, matchCatalog, catalog.clientId));
        continue;
      }
      if (hit.kind === 'ambiguous' && decision?.action === 'ignore') continue;
      if (hit.kind === 'ambiguous' && decision?.action === 'map') {
        const chosen = chosenFor(hit, decision);
        if (chosen) index.absorb(chosen.id, incoming);
        continue;
      }
      if (hit.kind === 'match') {
        index.absorb(hit.entity.id, incoming);
        continue;
      }
      if (hit.kind === 'rejected') continue;
      const identifiers = new Map<string, string[]>();
      for (const [attributeCode, value] of entity.attributes) {
        if (!value.trim()) continue;
        identifiers.set(attributeCode.toUpperCase(), [value]);
      }
      index.add({
        id: `pending:${entity.code}`,
        code: entity.code,
        name: entity.name,
        domainCode,
        clientId: catalog.clientId,
        active: true,
        provisional: true,
        identifiers,
        aliases: entity.aliases.map((alias) => alias.aliasLabel),
      });
    }
  }

  if (resolutions.length > 0) {
    const count = resolutions.length;
    return {
      mapCode: map.mapCode,
      sourceCode: map.sourceCode,
      asOfDate,
      fileName,
      rowCount: rows.length,
      loadWaves: waves,
      domains: order.filter((domainCode) => domainByCode.has(domainCode)).map((domainCode) => ({
        domainCode,
        distinctEntities: (drafts.get(domainCode) || []).length,
        created: 0,
        matched: 0,
        failed: 0,
        errors: [],
      })),
      relationships: { created: 0, matched: 0, failed: 0 },
      attributes: { created: 0, updated: 0, unchanged: 0 },
      normalizations: [],
      warnings: [`${count} ${count === 1 ? 'record matches' : 'records match'} more than one entity. Nothing was written.`],
      errors: [],
      resolutions,
    };
  }

  for (const domainCode of order) {
    const domain = domainByCode.get(domainCode);
    if (!domain) continue;
    const stats: DomainLoadStats = {
      domainCode,
      distinctEntities: 0,
      created: 0,
      matched: 0,
      failed: 0,
      errors: [],
    };
    const entities = drafts.get(domainCode) || [];
    stats.distinctEntities = entities.length;
    const templateId = catalog.templates.get(domain.templateCode) || null;
    if (!templateId) warnings.push(`Template ${domain.templateCode} was not found. Entities will load without it.`);

    const codes = entities.map((entity) => entity.code);
    const { catalog: matchCatalog, attributeIds } = await loadIdentifierCatalog(db, domainCode);
    const index = await loadEntityMatchIndex(db, domainCode, catalog.clientId, codes, matchCatalog, attributeIds);
    const idByCode = new Map<string, string>();
    const linkedTo = new Map<string, string>();
    const pending = new Map<string, EntityDraft>();
    const cleanseIds = new Map<string, string[]>();
    let matchedByIdentity = 0;

    const rememberInserted = (fileCode: string, id: string) => {
      const provisionalId = `pending:${fileCode}`;
      for (const [code, target] of linkedTo) {
        if (code === fileCode || target === provisionalId) idByCode.set(code, id);
      }
    };

    for (const entity of entities) {
      const incoming = { code: entity.code, name: entity.name, attributes: entity.attributes, aliases: entity.aliases.map((alias) => alias.aliasLabel) };
      let hit = index.resolve(incoming, entity.asOf || asOfDate);
      const decision = decisionFor(decisions, domainCode, entity.code);
      if (hit.kind === 'ambiguous') {
        if (decision?.action === 'ignore') continue;
        if (decision?.action === 'map') {
          const chosen = chosenFor(hit, decision);
          hit = chosen
            ? { kind: 'match', entity: chosen, via: hit.via }
            : { kind: 'rejected', message: `${entity.code} was not mapped to one of the matching records.` };
        } else if (decision?.action === 'create') {
          if (index.codeReserved(entity.code)) {
            hit = { kind: 'rejected', message: codeUnavailableMessage(entity.code) };
          } else {
            cleanseIds.set(entity.code, hit.entities.filter((item) => !item.provisional && item.clientId === catalog.clientId).map((item) => item.id));
            hit = { kind: 'none' };
          }
        }
      }
      if (hit.kind === 'ambiguous') {
        stats.failed += 1;
        stats.errors.push(hit.message);
        errors.push(hit.message);
        continue;
      }
      if (hit.kind === 'rejected') {
        stats.failed += 1;
        stats.errors.push(hit.message);
        errors.push(hit.message);
        reject({ kind: 'record', domainCode, entityCode: entity.code, message: hit.message });
        continue;
      }
      if (hit.kind === 'match') {
        index.absorb(hit.entity.id, incoming);
        linkedTo.set(entity.code, hit.entity.id);
        if (!hit.entity.provisional) {
          // The name changes only when the file has a name column of its own and this row filled it.
          // A code used as the name, or a blank cell, must never overwrite the stored name.
          const separateName = Boolean(domain.nameColumn) && domain.nameColumn !== domain.identityColumn;
          const rowName = separateName && entity.name && entity.name !== entity.code ? entity.name : null;
          const update = dry || !rowName ? { error: null } : await db.schema('entity_instances').from('master_entities').update({
            entity_name: rowName,
            updated_at: new Date().toISOString(),
            ...updatedBy,
          }).eq('id', hit.entity.id).eq('client_id', catalog.clientId);
          if (update.error) {
            stats.failed += 1;
            stats.errors.push(update.error.message);
            errors.push(update.error.message);
            linkedTo.delete(entity.code);
            continue;
          }
          if (!dry && rowName && rowName !== hit.entity.name) {
            recorder?.journal?.({ kind: 'RECORD_RENAME', targetId: hit.entity.id, before: { entity_name: hit.entity.name }, after: { entity_name: rowName } });
          }
          idByCode.set(entity.code, hit.entity.id);
        }
        recorder?.record?.({
          domainCode,
          fileCode: entity.code,
          name: entity.name,
          action: hit.entity.provisional ? 'CREATE' : 'MATCH',
          entityId: hit.entity.provisional ? null : hit.entity.id,
          templateId,
          via: hit.via,
        });
        if (hit.via !== 'code' && !hit.entity.provisional) matchedByIdentity += 1;
        stats.matched += 1;
        continue;
      }
      const provisionalId = `pending:${entity.code}`;
      const identifiers = new Map<string, string[]>();
      for (const [attributeCode, value] of entity.attributes) {
        if (!value.trim()) continue;
        identifiers.set(attributeCode.toUpperCase(), [value]);
      }
      index.add({
        id: provisionalId,
        code: entity.code,
        name: entity.name,
        domainCode,
        clientId: catalog.clientId,
        active: true,
        provisional: true,
        identifiers,
        aliases: entity.aliases.map((alias) => alias.aliasLabel),
      });
      pending.set(provisionalId, entity);
      linkedTo.set(entity.code, provisionalId);
      recorder?.record?.({ domainCode, fileCode: entity.code, name: entity.name, action: 'CREATE', entityId: null, templateId });
    }
    if (matchedByIdentity) {
      warnings.push(`${domainCode}: matched ${matchedByIdentity} existing ${matchedByIdentity === 1 ? 'record' : 'records'} by name or identifier`);
    }

    const toCreate = [...pending.values()];
    if (dry) {
      for (const entity of toCreate) {
        stats.created += 1;
        rememberInserted(entity.code, `${DRY_PREFIX}${domainCode}:${entity.code}`);
      }
      toCreate.length = 0;
    }
    for (const entity of toCreate) {
      const targets = cleanseIds.get(entity.code) || [];
      if (!targets.length) continue;
      await cleanseDuplicateIdentifiers(db, catalog.clientId, targets, entity, matchCatalog, attributeIds, entity.asOf || asOfDate, updatedBy);
    }
    for (let offset = 0; offset < toCreate.length; offset += 200) {
      const chunk = toCreate.slice(offset, offset + 200);
      const payload = chunk.map((entity) => ({
        entity_code: entity.code,
        domain_code: domainCode,
        template_id: templateId,
        entity_name: entity.name,
        client_id: catalog.clientId,
        is_active: true,
        metadata: { feed_map: map.mapCode, source_code: map.sourceCode },
        ...batchTag,
        ...createdBy,
      }));
      const insert = await db.schema('entity_instances').from('master_entities').insert(payload).select('id, entity_code');
      if (insert.error || !insert.data) {
        for (const entity of chunk) {
          const created = await db.schema('entity_instances').from('master_entities').insert(payload.find((row) => row.entity_code === entity.code)!).select('id').single();
          if (created.error || !created.data) {
            stats.failed += 1;
            // A code that is already taken is reported in the same words whoever holds it. The
            // database's own message is not passed on, and no other code is tried in its place.
            const taken = isDuplicateCode(created.error);
            const message = taken ? codeUnavailableMessage(entity.code) : created.error?.message || `Failed to create ${entity.code}`;
            stats.errors.push(message);
            errors.push(message);
            if (taken) reject({ kind: 'record', domainCode, entityCode: entity.code, message });
            continue;
          }
          stats.created += 1;
          rememberInserted(entity.code, created.data.id);
        }
        continue;
      }
      stats.created += insert.data.length;
      for (const row of insert.data) rememberInserted(row.entity_code, row.id);
    }
    if (!dry) await storeDraftAliases(db, entities, idByCode);
    ids.set(domainCode, idByCode);

    const entityIds = [...new Set(idByCode.values())].filter((id) => !id.startsWith(DRY_PREFIX));
    // The whole history of these values for this source, so a load into the past
    // can see every period it would overlap, closed ones included.
    const pageAttributeRows = async () => {
      const rows: any[] = [];
      if (entityIds.length === 0) return rows;
      const pageSize = 1000;
      // A source that does not exist yet (a review before the file loads) has no stored values to read.
      const sourceIds = [...new Set([...valueSources.values()].map((source) => source.id))].filter((sourceId) => !sourceId.startsWith(DRY_PREFIX));
      if (varying && sourceIds.length === 0) return rows;
      for (let idFrom = 0; idFrom < entityIds.length; idFrom += 150) {
        const idChunk = entityIds.slice(idFrom, idFrom + 150);
        for (let from = 0; ; from += pageSize) {
          const select = 'id, entity_id, attribute_id, source_id, valid_from, valid_to, golden_value, golden_value_numeric, golden_value_date';
          let query = db.schema('golden_master').from('entity_attribute_values').select(select).in('entity_id', idChunk).eq('system_to', OPEN_SYSTEM_TO);
          query = varying ? query.in('source_id', sourceIds) : query.eq('source_id', catalog.sourceId);
          const page = await query.order('valid_from', { ascending: true }).range(from, from + pageSize - 1);
          if (page.error) throw new Error(page.error.message);
          rows.push(...(page.data || []));
          if ((page.data || []).length < pageSize) break;
        }
      }
      return rows;
    };
    const attributeHistory = await pageAttributeRows();
    const slicesByKey = new Map<string, any[]>();
    const seenIds = new Set<string>();
    for (const row of attributeHistory) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      const key = `${row.entity_id}|${row.attribute_id}`;
      const list = slicesByKey.get(key) || [];
      list.push(row);
      slicesByKey.set(key, list);
    }

    const pendingAttributes: { label: string; row: Record<string, unknown> }[] = [];
    const queuedAttributes = new Set<string>();
    const flushAttributes = async () => {
      if (dry) {
        attributeStats.created += pendingAttributes.length;
        pendingAttributes.length = 0;
        return;
      }
      for (let offset = 0; offset < pendingAttributes.length; offset += 200) {
        const chunk = pendingAttributes.slice(offset, offset + 200);
        const insert = await db.schema('golden_master').from('entity_attribute_values').insert(chunk.map((item) => item.row));
        if (!insert.error) {
          attributeStats.created += chunk.length;
          continue;
        }
        for (const item of chunk) {
          const single = await db.schema('golden_master').from('entity_attribute_values').insert(item.row);
          if (single.error) errors.push(`${item.label}: ${single.error.message}`);
          else attributeStats.created += 1;
        }
      }
      pendingAttributes.length = 0;
    };

    const referenceIndexes = await loadReferenceIndexes(db, catalog, entities, ids, drafts);

    for (const entity of entities) {
      const entityId = idByCode.get(entity.code);
      if (!entityId) continue;
      const entityPeriods = [...entity.periods.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
      for (const period of entityPeriods) {
      const valueSource = valueSources.get(normalizeSourceCode(period.sourceCode)) || { id: catalog.sourceId, rank: catalog.precedenceRank };
      const validFrom = period.asOf || asOfDate;
      for (const [attributeCode, raw] of period.attributes) {
        const origin = period.origins.get(attributeCode);
        const meta = catalog.attributes.get(attributeCode);
        if (!meta) {
          warnings.push(`${domainCode} ${entity.code}: attribute ${attributeCode} is not registered`);
          continue;
        }
        const sourceColumn = domain.attributes.find((attribute) => attribute.attributeCode === attributeCode)?.column;
        const transformKind = sourceColumn ? map.transforms?.[sourceColumn]?.kind : undefined;
        const normalize = Boolean(meta.reference_list_code) && (transformKind === 'list' || (transformKind === undefined && !map.transforms));
        const normalized = normalize ? normalizationFor(catalog, attributeCode, raw) : { stored: raw, hit: null };
        const hit = normalized.hit;
        let stored = normalized.stored;
        if (hit) hits.push(hit);
        // A reference stores the id of the record it names, found by id, code or name.
        const referenceDomain = referenceDomainOf(meta);
        let referenceMatch: string | null = null;
        if (referenceDomain) {
          const match = matchReference(referenceIndexes.get(referenceDomain) || emptyReferenceIndex(), raw);
          if (match.kind === 'match') {
            stored = match.id;
            referenceMatch = match.matchType;
          } else {
            referenceMatch = match.kind;
            const why = match.kind === 'ambiguous'
              ? `More than one ${referenceDomain} record is named "${raw}". Stored as typed.`
              : `No ${referenceDomain} record matches "${raw}". Stored as typed.`;
            warnings.push(`${domainCode} ${entity.code}: ${attributeCode} ${why}`);
            reject({ kind: 'value', domainCode, entityCode: entity.code, attributeCode, value: raw, message: why, row: origin?.row, column: origin?.column });
          }
        }
        if (hit?.matchType === 'unmapped') {
          warnings.push(`${domainCode} ${entity.code}: ${attributeCode} value "${raw}" is not in ${hit.listCode}`);
          reject({ kind: 'value', domainCode, entityCode: entity.code, attributeCode, value: raw, message: `Not on list ${hit.listCode}. Stored as typed.`, row: origin?.row, column: origin?.column });
        }
        const coerced = coerceAttributeValue(stored, meta.data_type);
        if (!coerced) continue;
        if ('error' in coerced) {
          warnings.push(`${domainCode} ${entity.code}: ${attributeCode} ${coerced.error}`);
          reject({ kind: 'value', domainCode, entityCode: entity.code, attributeCode, value: raw, message: coerced.error, row: origin?.row, column: origin?.column });
          continue;
        }
        const value = {
          golden_value: coerced.golden_value,
          golden_value_numeric: coerced.golden_value_numeric,
          golden_value_date: coerced.golden_value_date,
        };
        const valueMetadata = {
          raw_value: referenceDomain ? raw.trim() : coerced.raw_value,
          list_code: hit?.listCode || null,
          match_type: hit?.matchType || null,
          ...(referenceDomain ? { reference_domain: referenceDomain, reference_match: referenceMatch } : {}),
          ...(origin && options.provenance ? { source_ref: sourceRef(table, origin, options.provenance) } : {}),
        };
        const sliceKey = varying ? `${entityId}|${meta.id}|${valueSource.id}|${validFrom}` : `${entityId}|${meta.id}|${validFrom}`;
        if (queuedAttributes.has(sliceKey)) continue;
        const tell = (action: 'INSERT' | 'UPDATE' | 'UNCHANGED', current: string | null) => recorder?.value?.({
          domainCode,
          fileCode: entity.code,
          attributeCode,
          attributeId: meta.id,
          sourceId: valueSource.id.startsWith(DRY_PREFIX) ? null : valueSource.id,
          precedenceRank: valueSource.rank,
          validFrom,
          action,
          raw,
          proposed: coerced.golden_value,
          current,
          row: origin?.row,
          column: origin?.column,
        });
        const slices = (slicesByKey.get(`${entityId}|${meta.id}`) || []).filter((row) => !varying || row.source_id === valueSource.id);
        const sameSlices = slices.filter((row) => String(row.valid_from).slice(0, 10) === validFrom);
        if (sameSlices.length > 0) {
          let changed = false;
          for (const slice of sameSlices) {
            if (sameValue(slice, value)) {
              const touch = dry ? { error: null } : await db.schema('golden_master').from('entity_attribute_values').update({
                last_received_at: receivedAt,
              }).eq('id', slice.id);
              if (touch.error) errors.push(touch.error.message);
              continue;
            }
            const update = dry ? { error: null } : await db.schema('golden_master').from('entity_attribute_values').update({
              ...value,
              golden_source_id: valueSource.id,
              precedence_rank: valueSource.rank,
              last_received_at: receivedAt,
              metadata: valueMetadata,
              ...updatedBy,
            }).eq('id', slice.id);
            if (update.error) errors.push(update.error.message);
            else {
              changed = true;
              if (!dry) {
                recorder?.journal?.({
                  kind: 'VALUE_UPDATE',
                  targetId: slice.id,
                  before: {
                    golden_value: slice.golden_value ?? null,
                    golden_value_numeric: slice.golden_value_numeric ?? null,
                    golden_value_date: slice.golden_value_date ?? null,
                  },
                  after: value,
                });
              }
            }
          }
          tell(changed ? 'UPDATE' : 'UNCHANGED', sameSlices[0]?.golden_value ?? null);
          if (changed) attributeStats.updated += 1;
          else attributeStats.unchanged += 1;
          queuedAttributes.add(sliceKey);
          continue;
        }
        // The same value already holds on this date inside a period that began earlier: nothing to write, only note it was received.
        const alreadyTrue = slices.filter((row) => String(row.valid_from).slice(0, 10) <= validFrom && String(row.valid_to).slice(0, 10) >= validFrom && sameValue(row, value));
        if (alreadyTrue.length > 0) {
          for (const slice of alreadyTrue) {
            if (dry || String(slice.id).startsWith('pending:') || slice.source_id !== valueSource.id) continue;
            const touch = await db.schema('golden_master').from('entity_attribute_values').update({ last_received_at: receivedAt }).eq('id', slice.id);
            if (touch.error) errors.push(touch.error.message);
          }
          attributeStats.unchanged += 1;
          queuedAttributes.add(sliceKey);
          tell('UNCHANGED', alreadyTrue[0]?.golden_value ?? null);
          continue;
        }

        const holding = slices.find((row) => String(row.valid_from).slice(0, 10) <= validFrom && String(row.valid_to).slice(0, 10) >= validFrom);
        tell('INSERT', holding?.golden_value ?? holding?.queued?.golden_value ?? null);
        const planned = planPeriod(slices.map((row) => ({ id: row.id, validFrom: String(row.valid_from).slice(0, 10), validTo: String(row.valid_to).slice(0, 10) })), validFrom);
        const validTo = planned.validTo;
        if (planned.closeId) {
          const covering = slices.find((row) => row.id === planned.closeId);
          const queuedRow = planned.closeId.startsWith('pending:') ? (covering as any)?.queued : null;
          if (queuedRow) queuedRow.valid_to = planned.closeTo;
          const close = dry || queuedRow ? { error: null } : await db.schema('golden_master').from('entity_attribute_values').update({
            valid_to: planned.closeTo,
            ...updatedBy,
          }).eq('id', planned.closeId);
          if (close.error) errors.push(close.error.message);
          else if (covering) {
            if (!dry && !queuedRow) {
              recorder?.journal?.({
                kind: 'VALUE_CLOSE',
                targetId: planned.closeId,
                before: { valid_to: String(covering.valid_to).slice(0, 10) },
                after: { valid_to: planned.closeTo },
              });
            }
            covering.valid_to = planned.closeTo;
          }
        }
        queuedAttributes.add(sliceKey);
        const queuedValues: Record<string, unknown> = {
          entity_id: entityId,
          attribute_id: meta.id,
          source_id: valueSource.id,
          golden_source_id: valueSource.id,
          ...value,
          valid_from: validFrom,
          valid_to: validTo,
          last_received_at: receivedAt,
          precedence_rank: valueSource.rank,
          metadata: valueMetadata,
          ...batchTag,
          ...createdBy,
        };
        const historyKey = `${entityId}|${meta.id}`;
        slicesByKey.set(historyKey, [...(slicesByKey.get(historyKey) || []), {
          id: `pending:${pendingAttributes.length}:${entity.code}:${attributeCode}:${validFrom}`,
          entity_id: entityId,
          attribute_id: meta.id,
          source_id: valueSource.id,
          valid_from: validFrom,
          valid_to: validTo,
          queued: queuedValues,
        }]);
        pendingAttributes.push({
          label: `${entity.code} ${attributeCode}`,
          row: queuedValues,
        });
      }
      }
    }
    await flushAttributes();

    const relationshipRows: Record<string, unknown>[] = [];
    for (const entity of entities) {
      const entityId = idByCode.get(entity.code);
      if (!entityId) continue;
      for (const parent of domain.parents) {
        const parentCode = entity.parents.get(parent.parentDomainCode);
        if (!parentCode) {
          relationshipStats.failed += 1;
          errors.push(`${domainCode} ${entity.code} is missing ${parent.parentDomainCode}`);
          reject({ kind: 'link', domainCode, entityCode: entity.code, message: `No ${parent.parentDomainCode} code on this row` });
          continue;
        }
        const parentId = ids.get(parent.parentDomainCode)?.get(parentCode) || externalIds.get(parent.parentDomainCode)?.get(parentCode);
        if (!parentId) {
          relationshipStats.failed += 1;
          errors.push(`${domainCode} ${entity.code} references unknown ${parent.parentDomainCode} ${parentCode}`);
          reject({ kind: 'link', domainCode, entityCode: entity.code, value: parentCode, message: `${parent.parentDomainCode} ${parentCode} was not found` });
          continue;
        }
        const relationship = chooseRelationship(domainCode, parent.parentDomainCode, catalog.relationshipTypes);
        if (!relationship) {
          relationshipStats.failed += 1;
          errors.push(`No relationship type connects ${domainCode} and ${parent.parentDomainCode}`);
          continue;
        }
        const endpoints = relationshipEndpoints(relationship, domainCode, entityId, parent.parentDomainCode, parentId);
        relationshipRows.push({
          parent_entity_id: endpoints.parentEntityId,
          child_entity_id: endpoints.childEntityId,
          relationship_type: relationship.relationship_code,
          relationship_code: relationship.relationship_code,
          is_primary: true,
          valid_from: entity.asOf || asOfDate,
          metadata: { feed_map: map.mapCode },
          ...batchTag,
        });
      }
    }

    // A link is current when it is open on the load date, whatever date it started on.
    // Reloading the same hierarchy at a later date must not stack a second copy.
    type StoredLink = { id: string; parent_entity_id: string; child_entity_id: string; relationship_code: string; valid_from: string; valid_to: string; metadata: { feed_map?: string } | null };
    const storedLinks = new Map<string, StoredLink[]>();
    const childIds = [...new Set(relationshipRows.map((row) => String(row.child_entity_id)))].filter((id) => !id.startsWith(DRY_PREFIX));
    for (let offset = 0; offset < childIds.length; offset += 150) {
      const chunk = childIds.slice(offset, offset + 150);
      const found = await db.schema('entity_instances').from('entity_relationships')
        .select('id, parent_entity_id, child_entity_id, relationship_code, valid_from, valid_to, metadata')
        .in('child_entity_id', chunk)
        .gte('system_to', receivedAt);
      if (found.error) throw new Error(found.error.message);
      for (const row of (found.data || []) as StoredLink[]) {
        const key = `${row.child_entity_id}|${row.relationship_code}`;
        const list = storedLinks.get(key) || [];
        list.push(row);
        storedLinks.set(key, list);
      }
    }
    const day = (value: unknown) => String(value).slice(0, 10);
    const relationshipInserts: Record<string, unknown>[] = [];
    const replaced: { id: string; validTo: string; was: string }[] = [];
    for (const row of relationshipRows) {
      const date = day(row.valid_from);
      const links = storedLinks.get(`${row.child_entity_id}|${row.relationship_code}`) || [];
      const covering = links.filter((link) => day(link.valid_from) <= date && day(link.valid_to) >= date);
      if (covering.some((link) => link.parent_entity_id === row.parent_entity_id)) {
        relationshipStats.matched += 1;
        continue;
      }
      // The file now names a different parent. Close the link an earlier load made, so the child has one current parent.
      for (const link of covering) {
        if (link.metadata?.feed_map && day(link.valid_from) < date && day(link.valid_to) === OPEN_TO) {
          replaced.push({ id: link.id, validTo: dayBefore(date), was: day(link.valid_to) });
          link.valid_to = dayBefore(date);
        }
      }
      links.push({ id: '', parent_entity_id: String(row.parent_entity_id), child_entity_id: String(row.child_entity_id), relationship_code: String(row.relationship_code), valid_from: date, valid_to: OPEN_TO, metadata: { feed_map: map.mapCode } });
      storedLinks.set(`${row.child_entity_id}|${row.relationship_code}`, links);
      relationshipInserts.push(row);
    }
    if (!dry) {
      for (const change of replaced) {
        const closed = await db.schema('entity_instances').from('entity_relationships').update({ valid_to: change.validTo }).eq('id', change.id);
        if (closed.error) errors.push(closed.error.message);
        else recorder?.journal?.({ kind: 'LINK_CLOSE', targetId: change.id, before: { valid_to: change.was }, after: { valid_to: change.validTo } });
      }
    }
    if (replaced.length > 0) warnings.push(`${domainCode}: ${replaced.length} ${replaced.length === 1 ? 'link was' : 'links were'} moved to a new parent as of this load`);
    if (dry) {
      relationshipStats.created += relationshipInserts.length;
      relationshipInserts.length = 0;
    }
    for (let offset = 0; offset < relationshipInserts.length; offset += 200) {
      const chunk = relationshipInserts.slice(offset, offset + 200);
      const insert = await db.schema('entity_instances').from('entity_relationships').insert(chunk);
      if (!insert.error) {
        relationshipStats.created += chunk.length;
        continue;
      }
      for (const row of chunk) {
        const single = await db.schema('entity_instances').from('entity_relationships').insert(row);
        if (single.error) {
          relationshipStats.failed += 1;
          errors.push(single.error.message);
        } else {
          relationshipStats.created += 1;
        }
      }
    }

    domainStats.push(stats);
  }

  if (!dry) await db.schema('entity_instances').from('feed_lineage').insert({
    source_id: catalog.sourceId,
    feed_batch_id: crypto.randomUUID(),
    feed_received_at: receivedAt,
    feed_processed_at: new Date().toISOString(),
    record_count: rows.length,
    success_count: domainStats.reduce((sum, stats) => sum + stats.created + stats.matched, 0),
    error_count: errors.length,
    feed_status: domainStats.some((stats) => stats.failed > 0) || relationshipStats.failed > 0 ? 'FAILED' : 'COMPLETED',
    feed_metadata: { mapCode: map.mapCode, asOfDate, fileName, attributeStats, relationshipStats },
  });

  return {
    mapCode: map.mapCode,
    sourceCode: map.sourceCode,
    asOfDate,
    fileName,
    rowCount: rows.length,
    loadWaves: waves,
    domains: domainStats,
    relationships: relationshipStats,
    attributes: attributeStats,
    normalizations: distinctNormalizations(hits),
    warnings: [...new Set(warnings)],
    errors,
    dryRun: dry,
    rejects,
    rejectCount,
    resolutions,
  };
}

export function positionFileMap(): FeedMap {
  return POSITION_FILE_MAP;
}
