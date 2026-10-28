import { type SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import { dependencyLoadWaves } from './load-order';
import { parseTabularFile } from './parse-table';
import {
  applyListSuggestions,
  feedMapFromAssignments,
  suggestAssignments,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
  type ListChoice,
} from './suggest';
import type { FeedLoadResult } from './types';
import { parseUsDate } from './values';
import {
  findStoredMap,
  headerSignature,
  mapNameFromAssignments,
  overlayStoredMap,
  proposeLoadIdentity,
  saveLoadMap,
  templateFromAssignments,
  type LoadMapIdentity,
} from './load-maps';

export interface ImportInstanceSummary {
  id: string;
  fileName: string;
  rowCount: number;
  status: string;
  receivedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  asOfDate: string | null;
  errorMessage: string | null;
  runs: InstanceRun[];
  resultSummary: {
    created: number;
    matched: number;
    failed: number;
    attributesCreated: number;
    attributesUpdated: number;
    attributesUnchanged: number;
    relationshipsMatched: number;
    relationshipsCreated?: number;
  } | null;
  mapCode: string;
  mapName: string | null;
  mapSaved: boolean;
}

export interface InstanceRun {
  startedAt: string;
  completedAt: string;
  asOfDate: string;
  status: string;
  created: number;
  matched: number;
  failed: number;
}

export interface ImportInstanceDetail extends ImportInstanceSummary {
  columnMappings: ColumnAssignment[];
  loadWaves: string[][];
  headers: string[];
}

function useClient(client?: SupabaseClient): SupabaseClient {
  const db = client || localSupabase();
  assertLocalSupabase(db);
  return db;
}

async function attributeCatalog(client: SupabaseClient): Promise<{ attributes: AttributeChoice[]; domains: string[] }> {
  const [attributes, domains] = await Promise.all([
    client.schema('metadata_register').from('attribute_register').select('attribute_code, attribute_name, data_type, domain_code, reference_list_code').order('attribute_name'),
    client.schema('metadata_register').from('domain_types').select('domain_code').eq('is_active', true).order('domain_code'),
  ]);
  if (attributes.error) throw new Error(attributes.error.message);
  if (domains.error) throw new Error(domains.error.message);
  return {
    attributes: (attributes.data || []).map((row: any) => ({
      attributeCode: row.attribute_code,
      attributeName: row.attribute_name,
      dataType: row.data_type,
      domainCode: row.domain_code,
      referenceListCode: row.reference_list_code,
    })),
    domains: (domains.data || []).map((row: any) => row.domain_code),
  };
}

export async function listMappingCatalog(client: SupabaseClient = useClient()) {
  assertLocalSupabase(client);
  const catalog = await attributeCatalog(client);
  return catalog;
}

export interface ReferenceListCatalog {
  listCode: string;
  values: ListChoice[];
}

export async function listReferenceLists(client: SupabaseClient = useClient()): Promise<ReferenceListCatalog[]> {
  assertLocalSupabase(client);
  const rows = await client.schema('metadata_register').from('reference_list_values').select('value_code, value_label, synonyms, display_order, list:reference_lists!inner(list_code)').order('display_order');
  if (rows.error) throw new Error(rows.error.message);
  const grouped = new Map<string, ListChoice[]>();
  for (const row of rows.data || []) {
    const listCode = (row as any).list?.list_code as string | undefined;
    if (!listCode) continue;
    const values = grouped.get(listCode) || [];
    const synonyms = Array.isArray(row.synonyms) ? row.synonyms.map(String) : [];
    values.push({ code: row.value_code, label: row.value_label, synonyms });
    grouped.set(listCode, values);
  }
  return [...grouped.entries()].map(([listCode, values]) => ({ listCode, values }));
}

function summarize(result: FeedLoadResult | null): ImportInstanceSummary['resultSummary'] {
  if (!result?.domains) return null;
  const entities = result.domains.reduce(
    (sum, domain) => ({
      created: sum.created + domain.created,
      matched: sum.matched + domain.matched,
      failed: sum.failed + domain.failed,
    }),
    { created: 0, matched: 0, failed: 0 }
  );
  return {
    ...entities,
    attributesCreated: result.attributes?.created || 0,
    attributesUpdated: result.attributes?.updated || 0,
    attributesUnchanged: result.attributes?.unchanged || 0,
    relationshipsMatched: result.relationships?.matched || 0,
    relationshipsCreated: result.relationships?.created || 0,
  };
}

function toSummary(row: any, map?: { name: string | null; saved: boolean }): ImportInstanceSummary {
  return {
    id: row.id,
    fileName: row.file_name,
    rowCount: row.row_count,
    status: row.status,
    receivedAt: row.received_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    asOfDate: row.as_of_date,
    errorMessage: row.error_message,
    runs: Array.isArray(row.runs) ? row.runs : [],
    resultSummary: summarize(row.result),
    mapCode: row.map_code || '',
    mapName: map?.name ?? (row.map_code === 'POSITION_FILE' ? 'Position file' : null),
    mapSaved: Boolean(map?.saved),
  };
}

async function savedMaps(client: SupabaseClient): Promise<Map<string, { name: string | null; saved: boolean }>> {
  const maps = await client.schema('entity_instances').from('feed_maps').select('map_code, map_name, header_signature');
  if (maps.error) throw new Error(maps.error.message);
  return new Map((maps.data || []).map((row: any) => [row.map_code, { name: row.map_name, saved: Boolean(row.header_signature) }]));
}

export async function listImportInstances(client: SupabaseClient = useClient()): Promise<ImportInstanceSummary[]> {
  assertLocalSupabase(client);
  const [rows, maps] = await Promise.all([
    client
      .schema('entity_instances')
      .from('import_instances')
      .select('id, file_name, row_count, status, received_at, started_at, completed_at, as_of_date, error_message, runs, result, map_code')
      .order('received_at', { ascending: false }),
    savedMaps(client),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map((row) => toSummary(row, maps.get(row.map_code)));
}

function suggestedAsOf(assignments: ColumnAssignment[], rows: Record<string, string>[]): string | null {
  const column = assignments.find((assignment) => assignment.role === 'as_of')?.sourceColumn;
  if (!column) return null;
  const dates = new Set<string>();
  for (const row of rows) {
    const iso = parseUsDate(row[column] || '');
    if (iso) dates.add(iso);
  }
  return dates.size === 1 ? [...dates][0] : null;
}

export async function createImportInstance(fileName: string, mediaType: string, bytes: Buffer, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const table = parseTabularFile(fileName, bytes);
  const [catalog, lists] = await Promise.all([attributeCatalog(client), listReferenceLists(client)]);
  const signature = headerSignature(table.headers);
  const stored = await findStoredMap(client, signature);
  let suggested = suggestAssignments(table.headers, table.rows, catalog.attributes);
  if (stored) suggested = overlayStoredMap(suggested, stored.template, stored.name);
  const reviewed = await reviewWithModel(suggested, catalog.attributes);
  const columnMappings = applyListSuggestions(reviewed, catalog.attributes, lists);
  const identity: LoadMapIdentity = stored
    ? { mapCode: stored.mapCode, sourceCode: stored.sourceCode, name: stored.name, description: stored.description }
    : proposeLoadIdentity(table.headers, columnMappings);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', identity.sourceCode).maybeSingle();
  if (source.error || !source.data) throw new Error(source.error?.message || `Source ${identity.sourceCode} was not found`);
  const inserted = await client.schema('entity_instances').from('import_instances').insert({
    source_id: source.data.id,
    map_code: identity.mapCode,
    file_name: fileName,
    media_type: mediaType,
    source_base64: bytes.toString('base64'),
    headers: table.headers,
    parsed_rows: table.rows,
    column_mappings: columnMappings,
    as_of_date: suggestedAsOf(columnMappings, table.rows),
    status: 'READY',
    row_count: table.rows.length,
    runs: [],
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || 'The file could not be stored');
  return getImportInstance(inserted.data.id, client);
}

export async function getImportInstance(id: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('import_instances').select('*').eq('id', id).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Import instance not found');
  const mappings = (row.data.column_mappings || []) as ColumnAssignment[];
  const maps = await savedMaps(client);
  const map = feedMapFromAssignments(mappings);
  return {
    ...toSummary(row.data, maps.get(row.data.map_code)),
    columnMappings: mappings,
    headers: row.data.headers || [],
    loadWaves: map.domains.length > 0 ? dependencyLoadWaves(map.domains) : [],
  };
}

export async function saveImportInstance(id: string, columnMappings: ColumnAssignment[], asOfDate: string | null, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const updated = await client.schema('entity_instances').from('import_instances').update({
    column_mappings: columnMappings,
    as_of_date: asOfDate,
  }).eq('id', id);
  if (updated.error) throw new Error(updated.error.message);
  return getImportInstance(id, client);
}

export async function processImportInstance(id: string, columnMappings?: ColumnAssignment[], asOfDate?: string, client?: SupabaseClient, clientId?: string): Promise<ImportInstanceDetail> {
  const db = client || useClient();
  assertLocalSupabase(db);
  const existing = await db.schema('entity_instances').from('import_instances').select('*').eq('id', id).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  const mappings = columnMappings || (existing.data.column_mappings as ColumnAssignment[]);
  const asOf = asOfDate || existing.data.as_of_date;
  if (!asOf) throw new Error('Choose today or a specific as-of date');
  const sourceRow = await db.schema('entity_instances').from('source_registry').select('source_code').eq('id', existing.data.source_id).maybeSingle();
  if (sourceRow.error) throw new Error(sourceRow.error.message);
  const signature = headerSignature(existing.data.headers || []);
  const stored = await findStoredMap(db, signature);
  const identity: LoadMapIdentity = stored
    ? { mapCode: stored.mapCode, sourceCode: stored.sourceCode, name: stored.name, description: stored.description }
    : {
        mapCode: existing.data.map_code || 'IMPORT',
        sourceCode: sourceRow.data?.source_code || 'IMPORT',
        name: existing.data.map_code === 'POSITION_FILE' ? 'Position file' : mapNameFromAssignments(mappings),
        description: 'Saved from a confirmed file load.',
      };
  const map = feedMapFromAssignments(mappings, identity);
  if (map.domains.length === 0) throw new Error('Choose which column identifies each record before loading.');
  await saveLoadMap(db, { ...identity, signature, template: templateFromAssignments(mappings), feedMap: map });
  const startedAt = new Date().toISOString();
  const marked = await db.schema('entity_instances').from('import_instances').update({
    status: 'PROCESSING',
    started_at: startedAt,
    column_mappings: mappings,
    map_code: identity.mapCode,
    as_of_date: asOf,
    error_message: null,
  }).eq('id', id);
  if (marked.error) throw new Error(marked.error.message);

  try {
    const result = await executeParsedFeed(map, existing.data.file_name, {
      headers: existing.data.headers || [],
      rows: existing.data.parsed_rows || [],
    }, asOf, db, clientId);
    const summary = summarize(result);
    const failed = (summary?.failed || 0) > 0 || result.errors.length > 0;
    const completedAt = new Date().toISOString();
    const runs = Array.isArray(existing.data.runs) ? existing.data.runs : [];
    runs.push({
      startedAt,
      completedAt,
      asOfDate: asOf,
      status: failed ? 'FAILED' : 'SUCCEEDED',
      created: summary?.created || 0,
      matched: summary?.matched || 0,
      failed: summary?.failed || 0,
    });
    const saved = await db.schema('entity_instances').from('import_instances').update({
      status: failed ? 'FAILED' : 'SUCCEEDED',
      completed_at: completedAt,
      result,
      runs,
      error_message: failed ? result.errors.slice(0, 3).join(' ') : null,
    }).eq('id', id);
    if (saved.error) throw new Error(saved.error.message);
    return getImportInstance(id, db);
  } catch (error: any) {
    const completedAt = new Date().toISOString();
    const runs = Array.isArray(existing.data.runs) ? existing.data.runs : [];
    runs.push({ startedAt, completedAt, asOfDate: asOf, status: 'FAILED', created: 0, matched: 0, failed: 1 });
    await db.schema('entity_instances').from('import_instances').update({
      status: 'FAILED',
      completed_at: completedAt,
      runs,
      error_message: error?.message || 'Process failed',
    }).eq('id', id);
    throw error;
  }
}

async function reviewWithModel(assignments: ColumnAssignment[], attributes: AttributeChoice[]): Promise<ColumnAssignment[]> {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
    '';
  if (!key) return assignments;
  const unmapped = assignments.filter((assignment) => assignment.role === 'ignore');
  if (unmapped.length === 0) return assignments;
  const catalog = attributes.slice(0, 180).map((attribute) => `${attribute.domainCode || 'SHARED'}:${attribute.attributeCode}`).join(', ');
  const columns = unmapped.map((assignment) => `${assignment.sourceColumn} (samples: ${assignment.samples.join(' | ')})`).join('\n');
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Map source columns to entity attributes. Reply with a JSON array only. Each item is {"sourceColumn","domainCode","attributeCode"}. Use only attribute codes from this catalog: ${catalog}. Columns:\n${columns}`,
            }],
          }],
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!response.ok) return assignments;
    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return assignments;
    const proposed = JSON.parse(match[0]) as { sourceColumn: string; domainCode: string; attributeCode: string }[];
    return assignments.map((assignment) => {
      if (assignment.role !== 'ignore') return assignment;
      const hit = proposed.find((item) => item.sourceColumn === assignment.sourceColumn);
      const attribute = hit && attributes.find((item) => item.attributeCode === hit.attributeCode);
      if (!hit || !attribute) return assignment;
      const domainCode = attribute.domainCode || hit.domainCode;
      if (!domainCode) return assignment;
      return {
        ...assignment,
        role: 'attribute' as const,
        domainCode,
        attributeCode: attribute.attributeCode,
        transform: suggestTransform(assignment.samples, attribute.dataType, attribute.referenceListCode),
        suggestion: { method: 'ai' as const, confidence: 0.72, reason: `AI suggested ${attribute.attributeName}. Confirm it and the map is saved for the next file like this.` },
      };
    });
  } catch {
    return assignments;
  }
}
