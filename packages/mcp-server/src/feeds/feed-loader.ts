import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EntityMatchIndex, identifierCatalog, type IdentifierCatalog, type MatchEntity } from './entity-match';
import { chooseRelationship, dependencyLoadOrder, dependencyLoadWaves, relationshipEndpoints, type RelationshipTypeRow } from './load-order';
import { parseTabularFile } from './parse-table';
import { POSITION_FILE_MAP } from './position-file-map';
import type { DomainLoadStats, FeedLoadResult, FeedMap, FeedPreview, NormalizationHit, ParsedTable } from './types';
import { applyTransform, coerceAttributeValue, dayBefore, indexReferenceLists, normalizeToList, parseUsDate, type ListValueRow } from './values';

const OPEN_TO = '9999-12-31';
const CLIENT_CODE = 'MERIDIAN_INTERNAL';

interface AttributeMeta {
  id: string;
  attribute_code: string;
  data_type: string;
  reference_list_code: string | null;
}

interface EntityDraft {
  code: string;
  name: string;
  attributes: Map<string, string>;
  parents: Map<string, string>;
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
  if (map.rowFilter) columns.add(map.rowFilter.column);
  for (const domain of map.domains) {
    columns.add(domain.identityColumn);
    columns.add(domain.nameColumn);
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

function collectDrafts(map: FeedMap, rows: Record<string, string>[]): Map<string, EntityDraft[]> {
  const byDomain = new Map<string, Map<string, EntityDraft>>();
  for (const domain of map.domains) byDomain.set(domain.domainCode, new Map());

  for (const row of rows) {
    for (const domain of map.domains) {
      const code = readCell(row, domain.identityColumn, map);
      if (!code) continue;
      const bucket = byDomain.get(domain.domainCode) as Map<string, EntityDraft>;
      let draft = bucket.get(code);
      if (!draft) {
        draft = {
          code,
          name: readCell(row, domain.nameColumn, map) || code,
          attributes: new Map(),
          parents: new Map(),
        };
        bucket.set(code, draft);
      }
      const name = readCell(row, domain.nameColumn, map);
      if (name && draft.name === draft.code) draft.name = name;
      for (const attribute of domain.attributes) {
        const value = readCell(row, attribute.column, map);
        if (value && !draft.attributes.has(attribute.attributeCode)) {
          draft.attributes.set(attribute.attributeCode, value);
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

async function loadCatalog(db: SupabaseClient, map: FeedMap, clientId?: string): Promise<Catalog> {
  const attributeCodes = [...new Set(map.domains.flatMap((domain) => domain.attributes.map((attribute) => attribute.attributeCode)))];
  const templateCodes = [...new Set(map.domains.map((domain) => domain.templateCode))];

  const [client, source, templates, attributes, listValues, relationshipTypes] = await Promise.all([
    clientId
      ? Promise.resolve({ data: { id: clientId }, error: null })
      : db.from('tenant_clients').select('id').eq('client_code', CLIENT_CODE).single(),
    db.schema('entity_instances').from('source_registry').select('id, precedence_rank').eq('source_code', map.sourceCode).single(),
    db.schema('metadata_register').from('domain_templates').select('id, template_code').in('template_code', templateCodes),
    db.schema('metadata_register').from('attribute_register').select('id, attribute_code, data_type, reference_list_code').in('attribute_code', attributeCodes),
    db.schema('metadata_register').from('reference_list_values').select('value_code, value_label, synonyms, list:reference_lists!inner(list_code)'),
    db.schema('metadata_register').from('relationship_types').select('relationship_code, parent_domain_code, child_domain_code, is_required').eq('is_active', true),
  ]);

  const failure = client.error || source.error || templates.error || attributes.error || listValues.error || relationshipTypes.error;
  if (failure) throw new Error(failure.message);
  if (!client.data?.id) throw new Error(`Client ${CLIENT_CODE} was not found`);
  if (!source.data?.id) throw new Error(`Source ${map.sourceCode} was not found.`);

  const lists: ListValueRow[] = (listValues.data || []).map((row: any) => ({
    list_code: row.list?.list_code,
    value_code: row.value_code,
    value_label: row.value_label,
    synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
  }));

  return {
    clientId: client.data.id,
    sourceId: source.data.id,
    precedenceRank: source.data.precedence_rank ?? 45,
    templates: new Map((templates.data || []).map((row: any) => [row.template_code, row.id])),
    attributes: new Map((attributes.data || []).map((row: any) => [row.attribute_code, row])),
    lists: indexReferenceLists(lists.filter((row) => row.list_code)),
    relationshipTypes: (relationshipTypes.data || []) as RelationshipTypeRow[],
  };
}

async function rememberMap(db: SupabaseClient, map: FeedMap, sourceId: string) {
  const payload = {
    map_code: map.mapCode,
    source_id: sourceId,
    map_name: map.name,
    description: map.description,
    column_mappings: map,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const existing = await db.schema('entity_instances').from('feed_maps').select('id').eq('map_code', map.mapCode).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const write = existing.data
    ? await db.schema('entity_instances').from('feed_maps').update(payload).eq('id', existing.data.id)
    : await db.schema('entity_instances').from('feed_maps').insert(payload);
  if (write.error) throw new Error(write.error.message);
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

function distinctNormalizations(hits: NormalizationHit[]): NormalizationHit[] {
  const seen = new Map<string, NormalizationHit>();
  for (const hit of hits) {
    const key = `${hit.attributeCode}|${hit.input}`;
    if (!seen.has(key)) seen.set(key, hit);
  }
  return [...seen.values()].sort((a, b) => a.attributeCode.localeCompare(b.attributeCode) || a.input.localeCompare(b.input));
}

export async function previewFeed(map: FeedMap, fileName: string, bytes: Buffer): Promise<FeedPreview> {
  const table = parseTabularFile(fileName, bytes);
  const rows = filterRows(map, table);
  const drafts = collectDrafts(map, rows);
  const db = localSupabase();
  const catalog = await loadCatalog(db, map);
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
      ...(map.asOfHintColumn ? [{ column: map.asOfHintColumn, purpose: 'Suggested as-of date. The date you choose is written on every value.' }] : []),
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
    .range(from, to));
  const codeRows: any[] = [];
  for (let offset = 0; offset < codes.length; offset += 100) {
    const chunk = codes.slice(offset, offset + 100);
    const existing = await db.schema('entity_instances').from('master_entities')
      .select('id, entity_code, entity_name, domain_code, client_id, is_active, merged_into_id')
      .in('entity_code', chunk);
    if (existing.error) throw new Error(existing.error.message);
    codeRows.push(...(existing.data || []));
  }

  const byId = new Map<string, any>();
  for (const row of [...domainRows, ...codeRows]) byId.set(row.id, row);
  const identifiers = new Map<string, Map<string, string[]>>();
  const codeByAttributeId = new Map<string, string>();
  for (const [code, id] of attributeIds) codeByAttributeId.set(id, code);
  const attributeIdList = [...attributeIds.values()];
  const entityIds = [...byId.keys()];
  if (attributeIdList.length && entityIds.length) {
    for (let offset = 0; offset < entityIds.length; offset += 150) {
      const chunk = entityIds.slice(offset, offset + 150);
      const values = await pageRows((from, to) => db.schema('golden_master').from('entity_attribute_values')
        .select('entity_id, attribute_id, golden_value')
        .in('entity_id', chunk)
        .in('attribute_id', attributeIdList)
        .eq('valid_to', OPEN_TO)
        .range(from, to));
      for (const value of values) {
        const attributeCode = codeByAttributeId.get(value.attribute_id);
        if (!attributeCode || value.golden_value == null || String(value.golden_value).trim() === '') continue;
        const perEntity = identifiers.get(value.entity_id) || new Map<string, string[]>();
        const list = perEntity.get(attributeCode) || [];
        list.push(String(value.golden_value));
        perEntity.set(attributeCode, list);
        identifiers.set(value.entity_id, perEntity);
      }
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
      identifiers: identifiers.get(row.id) || new Map(),
    };
    index.add(matchEntity);
  }
  return index;
}

function sameValue(existing: any, next: { golden_value: string; golden_value_numeric: number | null; golden_value_date: string | null }): boolean {
  if ((existing.golden_value ?? '') !== next.golden_value) return false;
  const existingNumber = existing.golden_value_numeric === null || existing.golden_value_numeric === undefined ? null : Number(existing.golden_value_numeric);
  if (existingNumber !== next.golden_value_numeric) return false;
  const existingDate = existing.golden_value_date ? String(existing.golden_value_date).slice(0, 10) : null;
  return existingDate === next.golden_value_date;
}

export async function executeFeed(map: FeedMap, fileName: string, bytes: Buffer, asOfDate: string, client?: SupabaseClient): Promise<FeedLoadResult> {
  return executeParsedFeed(map, fileName, parseTabularFile(fileName, bytes), asOfDate, client);
}

export async function executeParsedFeed(map: FeedMap, fileName: string, table: ParsedTable, asOfDate: string, client?: SupabaseClient, clientId?: string): Promise<FeedLoadResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error('As-of date must be YYYY-MM-DD');
  }
  const rows = filterRows(map, table);
  const drafts = collectDrafts(map, rows);
  const order = dependencyLoadOrder(map.domains);
  const waves = dependencyLoadWaves(map.domains);
  const db = client || localSupabase();
  assertLocalSupabase(db);
  const catalog = await loadCatalog(db, map, clientId);
  await rememberMap(db, map, catalog.sourceId);

  const ids = new Map<string, Map<string, string>>();
  const domainStats: DomainLoadStats[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const hits: NormalizationHit[] = [];
  const attributeStats = { created: 0, updated: 0, unchanged: 0 };
  const relationshipStats = { created: 0, matched: 0, failed: 0 };
  const receivedAt = new Date().toISOString();
  const domainByCode = new Map(map.domains.map((domain) => [domain.domainCode, domain]));

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
    let matchedByIdentity = 0;

    const rememberInserted = (fileCode: string, id: string) => {
      const provisionalId = `pending:${fileCode}`;
      for (const [code, target] of linkedTo) {
        if (code === fileCode || target === provisionalId) idByCode.set(code, id);
      }
    };

    for (const entity of entities) {
      const incoming = { code: entity.code, name: entity.name, attributes: entity.attributes };
      const hit = index.resolve(incoming);
      if (hit.kind === 'rejected') {
        stats.failed += 1;
        stats.errors.push(hit.message);
        errors.push(hit.message);
        continue;
      }
      if (hit.kind === 'match') {
        index.absorb(hit.entity.id, incoming);
        linkedTo.set(entity.code, hit.entity.id);
        if (!hit.entity.provisional) {
          const update = await db.schema('entity_instances').from('master_entities').update({
            entity_name: entity.name,
            ...(templateId ? { template_id: templateId } : {}),
            updated_at: new Date().toISOString(),
          }).eq('id', hit.entity.id);
          if (update.error) {
            stats.failed += 1;
            stats.errors.push(update.error.message);
            errors.push(update.error.message);
            linkedTo.delete(entity.code);
            continue;
          }
          idByCode.set(entity.code, hit.entity.id);
        }
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
      });
      pending.set(provisionalId, entity);
      linkedTo.set(entity.code, provisionalId);
    }
    if (matchedByIdentity) {
      warnings.push(`${domainCode}: matched ${matchedByIdentity} existing ${matchedByIdentity === 1 ? 'record' : 'records'} by name or identifier`);
    }

    const toCreate = [...pending.values()];
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
      }));
      const insert = await db.schema('entity_instances').from('master_entities').insert(payload).select('id, entity_code');
      if (insert.error || !insert.data) {
        for (const entity of chunk) {
          const single = await db.schema('entity_instances').from('master_entities').insert(payload.find((row) => row.entity_code === entity.code)!).select('id').single();
          if (single.error || !single.data) {
            stats.failed += 1;
            const message = single.error?.message || `Failed to create ${entity.code}`;
            stats.errors.push(message);
            errors.push(message);
            continue;
          }
          stats.created += 1;
          rememberInserted(entity.code, single.data.id);
        }
        continue;
      }
      stats.created += insert.data.length;
      for (const row of insert.data) rememberInserted(row.entity_code, row.id);
    }
    ids.set(domainCode, idByCode);

    const entityIds = [...new Set(idByCode.values())];
    const pageAttributeRows = async (column: 'valid_to' | 'valid_from', value: string) => {
      const rows: any[] = [];
      const pageSize = 1000;
      for (let idFrom = 0; idFrom < entityIds.length; idFrom += 150) {
        const idChunk = entityIds.slice(idFrom, idFrom + 150);
        for (let from = 0; ; from += pageSize) {
          const page = await db.schema('golden_master').from('entity_attribute_values').select('id, entity_id, attribute_id, valid_from, valid_to, golden_value, golden_value_numeric, golden_value_date').in('entity_id', idChunk).eq('source_id', catalog.sourceId).eq(column, value).range(from, from + pageSize - 1);
          if (page.error) throw new Error(page.error.message);
          rows.push(...(page.data || []));
          if ((page.data || []).length < pageSize) break;
        }
      }
      return rows;
    };
    const [openAttributeRows, datedAttributeRows] = entityIds.length
      ? await Promise.all([pageAttributeRows('valid_to', OPEN_TO), pageAttributeRows('valid_from', asOfDate)])
      : [[], []];
    const slicesByKey = new Map<string, any[]>();
    const seenIds = new Set<string>();
    for (const row of [...openAttributeRows, ...datedAttributeRows]) {
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

    for (const entity of entities) {
      const entityId = idByCode.get(entity.code);
      if (!entityId) continue;
      for (const [attributeCode, raw] of entity.attributes) {
        const meta = catalog.attributes.get(attributeCode);
        if (!meta) {
          warnings.push(`${domainCode} ${entity.code}: attribute ${attributeCode} is not registered`);
          continue;
        }
        const sourceColumn = domain.attributes.find((attribute) => attribute.attributeCode === attributeCode)?.column;
        const transformKind = sourceColumn ? map.transforms?.[sourceColumn]?.kind : undefined;
        const normalize = Boolean(meta.reference_list_code) && (transformKind === 'list' || (transformKind === undefined && !map.transforms));
        const { stored, hit } = normalize ? normalizationFor(catalog, attributeCode, raw) : { stored: raw, hit: null };
        if (hit) hits.push(hit);
        if (hit?.matchType === 'unmapped') {
          warnings.push(`${domainCode} ${entity.code}: ${attributeCode} value "${raw}" is not in ${hit.listCode}`);
        }
        const coerced = coerceAttributeValue(stored, meta.data_type);
        if (!coerced) continue;
        if ('error' in coerced) {
          warnings.push(`${domainCode} ${entity.code}: ${attributeCode} ${coerced.error}`);
          continue;
        }
        const value = {
          golden_value: coerced.golden_value,
          golden_value_numeric: coerced.golden_value_numeric,
          golden_value_date: coerced.golden_value_date,
        };
        const sliceKey = `${entityId}|${meta.id}`;
        if (queuedAttributes.has(sliceKey)) continue;
        const slices = slicesByKey.get(sliceKey) || [];
        const openRows = slices.filter((row) => String(row.valid_to).slice(0, 10) === OPEN_TO);
        const sameSlices = slices.filter((row) => String(row.valid_from).slice(0, 10) === asOfDate);
        if (sameSlices.length > 0) {
          let changed = false;
          for (const slice of sameSlices) {
            if (sameValue(slice, value)) {
              const touch = await db.schema('golden_master').from('entity_attribute_values').update({
                last_received_at: receivedAt,
              }).eq('id', slice.id);
              if (touch.error) errors.push(touch.error.message);
              continue;
            }
            const update = await db.schema('golden_master').from('entity_attribute_values').update({
              ...value,
              golden_source_id: catalog.sourceId,
              precedence_rank: catalog.precedenceRank,
              last_received_at: receivedAt,
              metadata: { raw_value: coerced.raw_value, list_code: hit?.listCode || null, match_type: hit?.matchType || null },
            }).eq('id', slice.id);
            if (update.error) errors.push(update.error.message);
            else changed = true;
          }
          if (changed) attributeStats.updated += 1;
          else attributeStats.unchanged += 1;
          queuedAttributes.add(sliceKey);
          continue;
        }

        const laterOpen = openRows.find((row) => String(row.valid_from).slice(0, 10) > asOfDate);
        const earlierOpen = openRows.find((row) => String(row.valid_from).slice(0, 10) < asOfDate);
        let validTo = OPEN_TO;
        if (laterOpen) validTo = dayBefore(String(laterOpen.valid_from).slice(0, 10));
        if (earlierOpen && !laterOpen) {
          const close = await db.schema('golden_master').from('entity_attribute_values').update({
            valid_to: dayBefore(asOfDate),
          }).eq('id', earlierOpen.id);
          if (close.error) errors.push(close.error.message);
        }
        queuedAttributes.add(sliceKey);
        pendingAttributes.push({
          label: `${entity.code} ${attributeCode}`,
          row: {
            entity_id: entityId,
            attribute_id: meta.id,
            source_id: catalog.sourceId,
            golden_source_id: catalog.sourceId,
            ...value,
            valid_from: asOfDate,
            valid_to: validTo,
            last_received_at: receivedAt,
            precedence_rank: catalog.precedenceRank,
            metadata: { raw_value: coerced.raw_value, list_code: hit?.listCode || null, match_type: hit?.matchType || null },
          },
        });
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
          continue;
        }
        const parentId = ids.get(parent.parentDomainCode)?.get(parentCode);
        if (!parentId) {
          relationshipStats.failed += 1;
          errors.push(`${domainCode} ${entity.code} references unknown ${parent.parentDomainCode} ${parentCode}`);
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
          valid_from: asOfDate,
          metadata: { feed_map: map.mapCode },
        });
      }
    }

    const existingRelationships = new Set<string>();
    const childIds = [...new Set(relationshipRows.map((row) => String(row.child_entity_id)))];
    for (let offset = 0; offset < childIds.length; offset += 150) {
      const chunk = childIds.slice(offset, offset + 150);
      const found = await db.schema('entity_instances').from('entity_relationships').select('parent_entity_id, child_entity_id, relationship_code').in('child_entity_id', chunk).eq('valid_from', asOfDate);
      if (found.error) throw new Error(found.error.message);
      for (const row of found.data || []) {
        existingRelationships.add(`${row.parent_entity_id}|${row.child_entity_id}|${row.relationship_code}`);
      }
    }
    const relationshipInserts: Record<string, unknown>[] = [];
    for (const row of relationshipRows) {
      const key = `${row.parent_entity_id}|${row.child_entity_id}|${row.relationship_code}`;
      if (existingRelationships.has(key)) relationshipStats.matched += 1;
      else {
        existingRelationships.add(key);
        relationshipInserts.push(row);
      }
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

  await db.schema('entity_instances').from('feed_lineage').insert({
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
  };
}

export function positionFileMap(): FeedMap {
  return POSITION_FILE_MAP;
}
