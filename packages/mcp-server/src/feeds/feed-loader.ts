import { createClient, SupabaseClient } from '@supabase/supabase-js';
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

export function assertLocalSupabase(client: SupabaseClient) {
  const url = (client as SupabaseClient & { supabaseUrl?: string }).supabaseUrl || '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Supabase URL is not valid');
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
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

async function loadCatalog(db: SupabaseClient, map: FeedMap): Promise<Catalog> {
  const attributeCodes = [...new Set(map.domains.flatMap((domain) => domain.attributes.map((attribute) => attribute.attributeCode)))];
  const templateCodes = [...new Set(map.domains.map((domain) => domain.templateCode))];

  const [client, source, templates, attributes, listValues, relationshipTypes] = await Promise.all([
    db.from('tenant_clients').select('id').eq('client_code', CLIENT_CODE).single(),
    db.schema('entity_instances').from('source_registry').select('id, precedence_rank').eq('source_code', map.sourceCode).single(),
    db.schema('metadata_register').from('domain_templates').select('id, template_code').in('template_code', templateCodes),
    db.schema('metadata_register').from('attribute_register').select('id, attribute_code, data_type, reference_list_code').in('attribute_code', attributeCodes),
    db.schema('metadata_register').from('reference_list_values').select('value_code, value_label, synonyms, list:reference_lists!inner(list_code)'),
    db.schema('metadata_register').from('relationship_types').select('relationship_code, parent_domain_code, child_domain_code, is_required').eq('is_active', true),
  ]);

  const failure = client.error || source.error || templates.error || attributes.error || listValues.error || relationshipTypes.error;
  if (failure) throw new Error(failure.message);
  if (!client.data?.id) throw new Error(`Client ${CLIENT_CODE} was not found`);
  if (!source.data?.id) throw new Error(`Source ${map.sourceCode} was not found. Apply the position file migration.`);

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

export async function executeParsedFeed(map: FeedMap, fileName: string, table: ParsedTable, asOfDate: string, client?: SupabaseClient): Promise<FeedLoadResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error('As-of date must be YYYY-MM-DD');
  }
  const rows = filterRows(map, table);
  const drafts = collectDrafts(map, rows);
  const order = dependencyLoadOrder(map.domains);
  const waves = dependencyLoadWaves(map.domains);
  const db = client || localSupabase();
  assertLocalSupabase(db);
  const catalog = await loadCatalog(db, map);
  await rememberMap(db, map, catalog.sourceId);

  const ids = new Map<string, Map<string, string>>();
  const domainStats: DomainLoadStats[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const hits: NormalizationHit[] = [];
  const attributeStats = { created: 0, updated: 0, unchanged: 0 };
  const relationshipStats = { created: 0, matched: 0, failed: 0 };
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
    const existingResult = codes.length
      ? await db.schema('entity_instances').from('master_entities').select('id, entity_code, domain_code').in('entity_code', codes)
      : { data: [], error: null };
    if (existingResult.error) throw new Error(existingResult.error.message);
    const existingByCode = new Map((existingResult.data || []).map((row: any) => [row.entity_code, row]));
    const idByCode = new Map<string, string>();

    for (const entity of entities) {
      const existing = existingByCode.get(entity.code);
      if (existing) {
        if (existing.domain_code !== domainCode) {
          stats.failed += 1;
          const message = `${entity.code} already exists as ${existing.domain_code}, not ${domainCode}`;
          stats.errors.push(message);
          errors.push(message);
          continue;
        }
        const update = await db.schema('entity_instances').from('master_entities').update({
          entity_name: entity.name,
          ...(templateId ? { template_id: templateId } : {}),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        if (update.error) {
          stats.failed += 1;
          stats.errors.push(update.error.message);
          errors.push(update.error.message);
          continue;
        }
        stats.matched += 1;
        idByCode.set(entity.code, existing.id);
        continue;
      }

      const insert = await db.schema('entity_instances').from('master_entities').insert({
        entity_code: entity.code,
        domain_code: domainCode,
        template_id: templateId,
        entity_name: entity.name,
        client_id: catalog.clientId,
        is_active: true,
        metadata: { feed_map: map.mapCode, source_code: map.sourceCode },
      }).select('id').single();
      if (insert.error || !insert.data) {
        stats.failed += 1;
        const message = insert.error?.message || `Failed to create ${entity.code}`;
        stats.errors.push(message);
        errors.push(message);
        continue;
      }
      stats.created += 1;
      idByCode.set(entity.code, insert.data.id);
    }
    ids.set(domainCode, idByCode);

    const entityIds = [...idByCode.values()];
    const pageAttributeRows = async (column: 'valid_to' | 'valid_from', value: string) => {
      const rows: any[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const page = await db.schema('golden_master').from('entity_attribute_values').select('id, entity_id, attribute_id, valid_from, valid_to, golden_value, golden_value_numeric, golden_value_date').in('entity_id', entityIds).eq('source_id', catalog.sourceId).eq(column, value).range(from, from + pageSize - 1);
        if (page.error) throw new Error(page.error.message);
        rows.push(...(page.data || []));
        if ((page.data || []).length < pageSize) break;
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
        const slices = slicesByKey.get(`${entityId}|${meta.id}`) || [];
        const openRows = slices.filter((row) => String(row.valid_to).slice(0, 10) === OPEN_TO);
        const sameSlices = slices.filter((row) => String(row.valid_from).slice(0, 10) === asOfDate);
        if (sameSlices.length > 0) {
          let changed = false;
          for (const slice of sameSlices) {
            if (sameValue(slice, value)) continue;
            const update = await db.schema('golden_master').from('entity_attribute_values').update({
              ...value,
              golden_source_id: catalog.sourceId,
              precedence_rank: catalog.precedenceRank,
              metadata: { raw_value: coerced.raw_value, list_code: hit?.listCode || null, match_type: hit?.matchType || null },
            }).eq('id', slice.id);
            if (update.error) errors.push(update.error.message);
            else changed = true;
          }
          if (changed) attributeStats.updated += 1;
          else attributeStats.unchanged += 1;
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
        const insert = await db.schema('golden_master').from('entity_attribute_values').insert({
          entity_id: entityId,
          attribute_id: meta.id,
          source_id: catalog.sourceId,
          golden_source_id: catalog.sourceId,
          ...value,
          valid_from: asOfDate,
          valid_to: validTo,
          precedence_rank: catalog.precedenceRank,
          metadata: { raw_value: coerced.raw_value, list_code: hit?.listCode || null, match_type: hit?.matchType || null },
        });
        if (insert.error) errors.push(`${entity.code} ${attributeCode}: ${insert.error.message}`);
        else attributeStats.created += 1;
      }
    }

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
        const found = await db.schema('entity_instances').from('entity_relationships').select('id').eq('parent_entity_id', endpoints.parentEntityId).eq('child_entity_id', endpoints.childEntityId).eq('relationship_code', relationship.relationship_code).eq('valid_from', asOfDate).maybeSingle();
        if (found.error) {
          relationshipStats.failed += 1;
          errors.push(found.error.message);
          continue;
        }
        if (found.data) {
          relationshipStats.matched += 1;
          continue;
        }
        const insert = await db.schema('entity_instances').from('entity_relationships').insert({
          parent_entity_id: endpoints.parentEntityId,
          child_entity_id: endpoints.childEntityId,
          relationship_type: relationship.relationship_code,
          relationship_code: relationship.relationship_code,
          is_primary: true,
          valid_from: asOfDate,
          metadata: { feed_map: map.mapCode },
        });
        if (insert.error) {
          relationshipStats.failed += 1;
          errors.push(insert.error.message);
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
    feed_received_at: new Date().toISOString(),
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
