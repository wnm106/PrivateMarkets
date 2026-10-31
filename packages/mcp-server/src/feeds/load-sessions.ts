import type { SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import type { IntakeTable } from './intake-file';
import { intakeFile } from './intake-file';
import {
  mapsWithBuiltin,
  readSource,
  type SchemaRecommendation,
  type SpecialistCatalog,
  type SpecialistReading,
} from './specialist';
import type { FeedLoadResult, FeedMap } from './types';

export interface LoadSessionSummary {
  id: string;
  fileName: string;
  rowCount: number;
  status: string;
  extractionMethod: string;
  extractionNote: string | null;
  receivedAt: string;
  asOfDate: string | null;
  sourceCode: string | null;
  savedMapCode: string | null;
  errorMessage: string | null;
}

export interface SourceMapSummary {
  mapCode: string;
  name: string;
  sourceCode: string;
  description: string;
  domains: string[];
}

export interface LoadSessionDetail extends LoadSessionSummary {
  reading: SpecialistReading;
  result: FeedLoadResult | null;
  dismissedRecommendationIds: string[];
}

interface StoredTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

function useClient(client?: SupabaseClient): SupabaseClient {
  const db = client || localSupabase();
  assertLocalSupabase(db);
  return db;
}

async function specialistCatalog(client: SupabaseClient): Promise<SpecialistCatalog> {
  const [attributes, domains, sources, relationships, maps] = await Promise.all([
    client.schema('metadata_register').from('attribute_register').select('attribute_code, attribute_name, data_type, domain_code, reference_list_code').order('attribute_name'),
    client.schema('metadata_register').from('domain_types').select('domain_code, domain_name').eq('is_active', true).order('domain_code'),
    client.schema('entity_instances').from('source_registry').select('source_code, source_name').eq('is_active', true).order('source_name'),
    client.schema('metadata_register').from('relationship_types').select('relationship_code, relationship_name, parent_domain_code, child_domain_code').eq('is_active', true),
    client.schema('entity_instances').from('feed_maps').select('map_code, column_mappings').eq('is_active', true),
  ]);
  const failure = attributes.error || domains.error || sources.error || relationships.error || maps.error;
  if (failure) throw new Error(failure.message);
  const stored = (maps.data || [])
    .map((row: any) => row.column_mappings as FeedMap)
    .filter((map) => map && map.mapCode && Array.isArray(map.domains));
  return {
    attributes: (attributes.data || []).map((row: any) => ({
      attributeCode: row.attribute_code,
      attributeName: row.attribute_name,
      dataType: row.data_type,
      domainCode: row.domain_code,
      referenceListCode: row.reference_list_code,
    })),
    domains: (domains.data || []).map((row: any) => ({ code: row.domain_code, name: row.domain_name })),
    sources: (sources.data || []).map((row: any) => ({ code: row.source_code, name: row.source_name })),
    relationships: (relationships.data || []).map((row: any) => ({
      code: row.relationship_code,
      name: row.relationship_name,
      parentDomain: row.parent_domain_code,
      childDomain: row.child_domain_code,
    })),
    maps: mapsWithBuiltin(stored),
  };
}

function storedTables(value: unknown): StoredTable[] {
  if (!Array.isArray(value)) return [];
  return value.filter((table) => table && Array.isArray(table.headers) && Array.isArray(table.rows));
}

function activeTable(tables: StoredTable[], answer?: string): StoredTable | null {
  if (tables.length === 0) return null;
  if (answer) return tables.find((table) => table.id === answer) || tables[0];
  return [...tables].sort((left, right) => right.rows.length - left.rows.length)[0];
}

function statusFor(reading: SpecialistReading, method: string): string {
  if (method === 'needs_extract' || (reading.sampleRows.length === 0 && !reading.map)) return 'EXTRACTING';
  if (reading.blockedReasons.length === 0 && reading.map) return 'READY';
  return 'INTERVIEW';
}

function toSummary(row: any): LoadSessionSummary {
  return {
    id: row.id,
    fileName: row.file_name,
    rowCount: row.row_count,
    status: row.status,
    extractionMethod: row.extraction_method,
    extractionNote: row.extraction_note,
    receivedAt: row.created_at,
    asOfDate: row.as_of_date,
    sourceCode: row.source_code,
    savedMapCode: row.saved_map_code,
    errorMessage: row.error_message,
  };
}

async function readingFor(row: any, client: SupabaseClient): Promise<SpecialistReading> {
  const tables = storedTables(row.tables);
  const answers = (row.answers && typeof row.answers === 'object') ? row.answers : {};
  const table = activeTable(tables, answers.table);
  const catalog = await specialistCatalog(client);
  return readSource({
    fileName: row.file_name,
    headers: table?.headers || [],
    rows: table?.rows || [],
    catalog,
    answers,
    acceptedRecommendationIds: Array.isArray(row.accepted_recommendations) ? row.accepted_recommendations : [],
    dismissedRecommendationIds: Array.isArray(row.dismissed_recommendations) ? row.dismissed_recommendations : [],
    tables: tables.map((item) => ({
      id: item.id,
      name: item.name,
      rowCount: item.rows.length,
      headers: item.headers,
    })),
  });
}

async function persist(client: SupabaseClient, id: string, row: any, reading: SpecialistReading, answers: Record<string, string>, dismissed: string[]) {
  const table = activeTable(storedTables(row.tables), answers.table);
  const updated = await client.schema('entity_instances').from('load_sessions').update({
    status: statusFor(reading, row.extraction_method),
    headers: table?.headers || [],
    parsed_rows: table?.rows || [],
    row_count: table?.rows.length || 0,
    briefing: reading.briefing,
    questions: reading.questions,
    answers,
    recommendations: reading.recommendations,
    accepted_recommendations: reading.acceptedRecommendationIds,
    dismissed_recommendations: dismissed,
    column_mappings: reading.assignments,
    map_draft: reading.map,
    source_code: reading.sourceCode,
    as_of_date: reading.asOfDate,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (updated.error) throw new Error(updated.error.message);
}

export async function listSourceMaps(client: SupabaseClient = useClient()): Promise<SourceMapSummary[]> {
  assertLocalSupabase(client);
  const catalog = await specialistCatalog(client);
  return catalog.maps.map((map) => ({
    mapCode: map.mapCode,
    name: map.name,
    sourceCode: map.sourceCode,
    description: map.description,
    domains: map.domains.map((domain) => domain.domainCode),
  }));
}

export async function listLoadSessions(client: SupabaseClient = useClient()): Promise<LoadSessionSummary[]> {
  assertLocalSupabase(client);
  const rows = await client
    .schema('entity_instances')
    .from('load_sessions')
    .select('id, file_name, row_count, status, extraction_method, extraction_note, created_at, as_of_date, source_code, saved_map_code, error_message')
    .order('created_at', { ascending: false })
    .limit(40);
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map(toSummary);
}

export async function getLoadSession(id: string, client: SupabaseClient = useClient()): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('load_sessions').select('*').eq('id', id).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Load session not found');
  const reading = await readingFor(row.data, client);
  const dismissed = Array.isArray(row.data.dismissed_recommendations) ? row.data.dismissed_recommendations : [];
  return { ...toSummary(row.data), reading, result: row.data.result, dismissedRecommendationIds: dismissed };
}

export async function startLoadSession(fileName: string, mediaType: string, bytes: Buffer, client: SupabaseClient = useClient()): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const intake = await intakeFile(fileName, mediaType, bytes);
  const tables: StoredTable[] = intake.tables.map((table: IntakeTable) => ({
    id: table.id,
    name: table.name,
    headers: table.table.headers,
    rows: table.table.rows,
  }));
  const inserted = await client.schema('entity_instances').from('load_sessions').insert({
    file_name: fileName,
    media_type: mediaType,
    source_base64: bytes.toString('base64'),
    extraction_method: intake.method,
    extraction_note: intake.note,
    headers: tables[0]?.headers || [],
    parsed_rows: tables[0]?.rows || [],
    tables,
    row_count: tables[0]?.rows.length || 0,
    status: intake.tables.length === 0 ? 'EXTRACTING' : 'INTERVIEW',
    answers: {},
    accepted_recommendations: [],
    dismissed_recommendations: [],
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || 'The file could not be stored');
  const detail = await getLoadSession(inserted.data.id, client);
  await persist(client, detail.id, {
    ...{ tables, extraction_method: intake.method },
  }, detail.reading, {}, []);
  return getLoadSession(detail.id, client);
}

export async function answerLoadSession(
  id: string,
  answers: Record<string, string>,
  acceptedRecommendationIds: string[] | undefined,
  dismissedRecommendationIds: string[] | undefined,
  client: SupabaseClient = useClient()
): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('load_sessions').select('*').eq('id', id).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Load session not found');
  const mergedAnswers = { ...(row.data.answers || {}), ...(answers || {}) };
  const accepted = acceptedRecommendationIds ?? (Array.isArray(row.data.accepted_recommendations) ? row.data.accepted_recommendations : []);
  const dismissed = dismissedRecommendationIds ?? (Array.isArray(row.data.dismissed_recommendations) ? row.data.dismissed_recommendations : []);
  const reading = await readingFor({ ...row.data, answers: mergedAnswers, accepted_recommendations: accepted, dismissed_recommendations: dismissed }, client);
  await persist(client, id, row.data, reading, mergedAnswers, dismissed);
  return getLoadSession(id, client);
}

/** Re-read the stored file and run the current mapping against it. Previous answers are kept. */
export async function refreshLoadSession(id: string, client: SupabaseClient = useClient()): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('load_sessions').select('*').eq('id', id).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Load session not found');
  const current = row.data;
  let tables = storedTables(current.tables);
  let method = current.extraction_method;
  let note = current.extraction_note;
  if (current.source_base64) {
    try {
      const intake = await intakeFile(current.file_name, current.media_type || 'application/octet-stream', Buffer.from(current.source_base64, 'base64'));
      if (intake.tables.length > 0) {
        tables = intake.tables.map((table) => ({
          id: table.id,
          name: table.name,
          headers: table.table.headers,
          rows: table.table.rows,
        }));
        method = intake.method;
        note = intake.note;
      }
    } catch {
      // Keep the table already stored when the original bytes cannot be read again.
    }
  }
  const answers = current.answers && typeof current.answers === 'object' ? current.answers : {};
  const dismissed = Array.isArray(current.dismissed_recommendations) ? current.dismissed_recommendations : [];
  const accepted = Array.isArray(current.accepted_recommendations) ? current.accepted_recommendations : [];
  const nextRow = {
    ...current,
    tables,
    extraction_method: method,
    extraction_note: note,
    answers,
    accepted_recommendations: accepted,
    dismissed_recommendations: dismissed,
  };
  const reading = await readingFor(nextRow, client);
  const stored = await client.schema('entity_instances').from('load_sessions').update({
    tables,
    extraction_method: method,
    extraction_note: note,
  }).eq('id', id);
  if (stored.error) throw new Error(stored.error.message);
  await persist(client, id, nextRow, reading, answers, dismissed);
  if (current.status === 'LOADED' || current.status === 'FAILED') {
    const kept = await client.schema('entity_instances').from('load_sessions').update({ status: current.status }).eq('id', id);
    if (kept.error) throw new Error(kept.error.message);
  }
  return getLoadSession(id, client);
}

async function ensureSource(client: SupabaseClient, code: string, name: string): Promise<string> {
  const existing = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', code).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) return existing.data.id;
  const inserted = await client.schema('entity_instances').from('source_registry').insert({
    source_code: code,
    source_name: name,
    source_type: 'VENDOR',
    vendor_name: name,
    feed_format: 'FILE',
    feed_frequency: 'AD_HOC',
    precedence_rank: 50,
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || `Source ${code} could not be created`);
  return inserted.data.id;
}

async function ensureDomain(client: SupabaseClient, code: string, name: string) {
  const existing = await client.schema('metadata_register').from('domain_types').select('domain_code').eq('domain_code', code).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return;
  const inserted = await client.schema('metadata_register').from('domain_types').insert({
    domain_code: code,
    domain_name: name,
    description: `Added while loading source data that did not fit an existing entity.`,
    is_active: true,
  });
  if (inserted.error) throw new Error(inserted.error.message);
}

async function ensureTemplate(client: SupabaseClient, templateCode: string, domainCode: string, domainName: string): Promise<string | null> {
  const existing = await client.schema('metadata_register').from('domain_templates').select('id').eq('template_code', templateCode).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) return existing.data.id;
  const inserted = await client.schema('metadata_register').from('domain_templates').insert({
    template_code: templateCode,
    domain_code: domainCode,
    template_name: `${domainName} standard`,
    description: `Standard template for ${domainName}.`,
    is_active: true,
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || `Template ${templateCode} could not be created`);
  return inserted.data.id;
}

async function ensureAttribute(client: SupabaseClient, recommendation: SchemaRecommendation): Promise<string | null> {
  const code = recommendation.payload.attributeCode;
  const domainCode = recommendation.payload.domainCode;
  if (!code || !domainCode) return null;
  const existing = await client.schema('metadata_register').from('attribute_register').select('id').eq('attribute_code', code).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) return existing.data.id;
  const inserted = await client.schema('metadata_register').from('attribute_register').insert({
    attribute_code: code,
    attribute_name: recommendation.payload.attributeName || code,
    data_type: recommendation.payload.dataType || 'STRING',
    domain_code: domainCode,
    description: recommendation.rationale,
    is_time_varying: true,
    time_dimension: 'VALID_TIME',
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || `Attribute ${code} could not be created`);
  return inserted.data.id;
}

async function assignAttribute(client: SupabaseClient, templateId: string | null, attributeId: string | null, label: string) {
  if (!templateId || !attributeId) return;
  const existing = await client.schema('metadata_register').from('template_attribute_assignments').select('id').eq('template_id', templateId).eq('attribute_id', attributeId).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return;
  const inserted = await client.schema('metadata_register').from('template_attribute_assignments').insert({
    template_id: templateId,
    attribute_id: attributeId,
    is_required: false,
    display_label: label,
  });
  if (inserted.error) throw new Error(inserted.error.message);
}

async function materialize(client: SupabaseClient, recommendations: SchemaRecommendation[], acceptedIds: string[]) {
  const accepted = new Set(acceptedIds);
  const chosen = recommendations.filter((item) => accepted.has(item.id));
  const templates = new Map<string, string | null>();
  for (const item of chosen.filter((recommendation) => recommendation.kind === 'domain')) {
    const code = item.payload.domainCode;
    const name = item.payload.domainName || code;
    if (!code || !name) continue;
    await ensureDomain(client, code, name);
    const templateId = await ensureTemplate(client, item.payload.templateCode || `${code}_STANDARD`, code, name);
    templates.set(code, templateId);
    for (const column of item.payload.columns || []) {
      if (column.role !== 'attribute' || !column.attributeCode) continue;
      const attributeId = await ensureAttribute(client, {
        ...item,
        payload: {
          ...item.payload,
          attributeCode: column.attributeCode,
          attributeName: column.attributeName,
          dataType: column.dataType,
          column: column.column,
        },
      });
      await assignAttribute(client, templateId, attributeId, column.attributeName || column.attributeCode);
    }
  }
  for (const item of chosen.filter((recommendation) => recommendation.kind === 'attribute')) {
    const domainCode = item.payload.domainCode;
    if (!domainCode) continue;
    if (!templates.has(domainCode)) {
      const domain = await client.schema('metadata_register').from('domain_types').select('domain_name').eq('domain_code', domainCode).maybeSingle();
      if (domain.error) throw new Error(domain.error.message);
      if (!domain.data) continue;
      templates.set(domainCode, await ensureTemplate(client, `${domainCode}_STANDARD`, domainCode, domain.data.domain_name));
    }
    const attributeId = await ensureAttribute(client, item);
    await assignAttribute(client, templates.get(domainCode) || null, attributeId, item.payload.attributeName || item.payload.attributeCode || '');
  }
  for (const item of chosen.filter((recommendation) => recommendation.kind === 'relationship')) {
    const code = item.payload.relationshipCode;
    const parent = item.payload.parentDomainCode;
    const child = item.payload.childDomainCode;
    if (!code || !parent || !child) continue;
    const existing = await client.schema('metadata_register').from('relationship_types').select('id').eq('relationship_code', code).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) continue;
    const inserted = await client.schema('metadata_register').from('relationship_types').insert({
      relationship_code: code,
      relationship_name: item.payload.relationshipName || code,
      parent_domain_code: parent,
      child_domain_code: child,
      description: item.rationale,
      is_active: true,
      is_required: false,
      cardinality: 'MANY_TO_ONE',
    });
    if (inserted.error) throw new Error(inserted.error.message);
  }
}

async function remember(client: SupabaseClient, map: FeedMap, sourceId: string) {
  const payload = {
    map_code: map.mapCode,
    source_id: sourceId,
    map_name: map.name,
    description: map.description,
    column_mappings: map,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const existing = await client.schema('entity_instances').from('feed_maps').select('id').eq('map_code', map.mapCode).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const write = existing.data
    ? await client.schema('entity_instances').from('feed_maps').update(payload).eq('id', existing.data.id)
    : await client.schema('entity_instances').from('feed_maps').insert(payload);
  if (write.error) throw new Error(write.error.message);
}

export async function saveSourceMap(id: string, name: string | undefined, client: SupabaseClient = useClient()): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const detail = await getLoadSession(id, client);
  if (!detail.reading.map || !detail.reading.sourceCode) throw new Error(detail.reading.blockedReasons[0] || 'The map is not ready to save');
  const map = { ...detail.reading.map, name: name?.trim() || detail.reading.map.name };
  const sourceId = await ensureSource(client, map.sourceCode, detail.reading.sourceCode);
  await remember(client, map, sourceId);
  const saved = await client.schema('entity_instances').from('load_sessions').update({
    saved_map_code: map.mapCode,
    map_draft: map,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (saved.error) throw new Error(saved.error.message);
  return getLoadSession(id, client);
}

export async function runLoadSession(id: string, client: SupabaseClient = useClient()): Promise<LoadSessionDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('load_sessions').select('*').eq('id', id).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Load session not found');
  const reading = await readingFor(row.data, client);
  if (!reading.map || !reading.asOfDate || reading.blockedReasons.length > 0) {
    throw new Error(reading.blockedReasons[0] || 'This file is not ready to load');
  }
  const marked = await client.schema('entity_instances').from('load_sessions').update({
    status: 'LOADING',
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (marked.error) throw new Error(marked.error.message);
  try {
    await ensureSource(client, reading.map.sourceCode, reading.sourceCode || reading.map.sourceCode);
    await materialize(client, reading.recommendations, reading.acceptedRecommendationIds);
    const table = activeTable(storedTables(row.data.tables), (row.data.answers || {}).table);
    const result = await executeParsedFeed(reading.map, row.data.file_name, {
      headers: table?.headers || [],
      rows: table?.rows || [],
    }, reading.asOfDate, client);
    const failed = result.errors.length > 0 || result.domains.some((domain) => domain.failed > 0);
    const saved = await client.schema('entity_instances').from('load_sessions').update({
      status: failed ? 'FAILED' : 'LOADED',
      result,
      saved_map_code: reading.map.mapCode,
      error_message: failed ? result.errors.slice(0, 3).join(' ') : null,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (saved.error) throw new Error(saved.error.message);
    return getLoadSession(id, client);
  } catch (error: any) {
    await client.schema('entity_instances').from('load_sessions').update({
      status: 'FAILED',
      error_message: error?.message || 'Load failed',
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    throw error;
  }
}
