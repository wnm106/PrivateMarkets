import { type SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import { dependencyLoadWaves } from './load-order';
import { readImportFile } from './intake';
import { parseTabularFile } from './parse-table';
import {
  applyReusableMap,
  kindLabel,
  mapTitle,
  matchReusableMap,
  mergeAssignments,
  mergeHeaders,
  newMapCode,
  parseReusableMap,
  storeAssignment,
  type ReusableMap,
} from './reusable-map';
import { normalizeSourceCode } from './row-context';
import {
  applyListSuggestions,
  feedMapFromAssignments,
  suggestAssignments,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
  type ColumnHint,
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
  sourceCode: string | null;
  mapReuse: 'exact' | 'extended' | 'new';
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
    sourceCode: row.source_code || null,
    mapReuse: row.map_reuse === 'exact' || row.map_reuse === 'extended' ? row.map_reuse : 'new',
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
      .select('id, file_name, row_count, status, received_at, started_at, completed_at, as_of_date, source_code, error_message, runs, result, map_code, map_reuse')
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

async function columnsForTable(client: SupabaseClient, headers: string[], rows: Record<string, string>[], hints: ColumnHint[] = []): Promise<{ columnMappings: ColumnAssignment[]; identity: LoadMapIdentity }> {
  const [catalog, lists] = await Promise.all([attributeCatalog(client), listReferenceLists(client)]);
  const stored = await findStoredMap(client, headerSignature(headers));
  let suggested = suggestAssignments(headers, rows, catalog.attributes, hints);
  if (stored) suggested = overlayStoredMap(suggested, stored.template, stored.name);
  const reviewed = await reviewWithModel(suggested, catalog.attributes);
  const columnMappings = applyListSuggestions(reviewed, catalog.attributes, lists);
  const identity: LoadMapIdentity = stored
    ? { mapCode: stored.mapCode, sourceCode: stored.sourceCode, name: stored.name, description: stored.description }
    : proposeLoadIdentity(headers, columnMappings);
  return { columnMappings, identity };
}

export async function createImportInstance(
  fileName: string,
  mediaType: string,
  bytes: Buffer,
  client: SupabaseClient = useClient(),
  options?: { forceMapCode?: string; sourceCode?: string },
): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const upload = await readUpload(fileName, bytes, Boolean(options?.forceMapCode));
  const planned = await planColumns(client, upload, options?.forceMapCode);
  const identity = planned.identity;
  const columnMappings = planned.columnMappings;
  if (planned.artifact) await saveReusableMap(client, planned.artifact);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', identity.sourceCode).maybeSingle();
  if (source.error || !source.data) throw new Error(source.error?.message || `Source ${identity.sourceCode} was not found`);
  const fileSource = cleanSource(options?.sourceCode);
  const inserted = await client.schema('entity_instances').from('import_instances').insert({
    source_id: source.data.id,
    map_code: identity.mapCode,
    ...(planned.mapReuse ? { map_reuse: planned.mapReuse } : {}),
    ...(fileSource ? { source_code: fileSource } : {}),
    file_name: fileName,
    media_type: mediaType,
    source_base64: bytes.toString('base64'),
    headers: upload.headers,
    parsed_rows: upload.rows,
    column_mappings: columnMappings,
    as_of_date: suggestedAsOf(columnMappings, upload.rows),
    status: 'READY',
    row_count: upload.rows.length,
    runs: [],
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || 'The file could not be stored');
  return getImportInstance(inserted.data.id, client);
}

/** Re-read the stored file and replace the column mapping. Load history stays. */
export async function refreshImportInstance(id: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const existing = await client.schema('entity_instances').from('import_instances').select('id, file_name, source_base64').eq('id', id).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  if (!existing.data.source_base64) throw new Error('The original file is not stored, so it cannot be read again.');
  const upload = await readUpload(existing.data.file_name, Buffer.from(existing.data.source_base64, 'base64'), false);
  const planned = await planColumns(client, upload);
  if (planned.artifact) await saveReusableMap(client, planned.artifact);
  const { columnMappings, identity } = planned;
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', identity.sourceCode).maybeSingle();
  if (source.error) throw new Error(source.error.message);
  const updated = await client.schema('entity_instances').from('import_instances').update({
    headers: upload.headers,
    parsed_rows: upload.rows,
    column_mappings: columnMappings,
    row_count: upload.rows.length,
    as_of_date: suggestedAsOf(columnMappings, upload.rows),
    map_code: identity.mapCode,
    ...(planned.mapReuse ? { map_reuse: planned.mapReuse } : {}),
    ...(source.data?.id ? { source_id: source.data.id } : {}),
  }).eq('id', id);
  if (updated.error) throw new Error(updated.error.message);
  return getImportInstance(id, client);
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
  const reusable = await getReusableMap(identity.mapCode, db);
  if (reusable || existing.data.map_reuse) {
    await saveReusableMap(db, reusableFromAssignments(
      identity.mapCode,
      reusable?.kind || 'TABULAR',
      existing.data.headers || [],
      mappings,
      reusable,
    ));
  }
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
    }, asOf, db, clientId, cleanSource(existing.data.source_code) || undefined);
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

interface UploadTable {
  headers: string[];
  rows: Record<string, string>[];
  hints: ColumnHint[];
  kind: string | null;
}

async function readUpload(fileName: string, bytes: Buffer, forceInterpret: boolean): Promise<UploadTable> {
  const lower = fileName.toLowerCase();
  const document = lower.endsWith('.pdf') || lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.json');
  if (forceInterpret || document) {
    try {
      const read = await readImportFile(fileName, bytes);
      return { headers: read.table.headers, rows: read.table.rows, hints: read.hints, kind: read.kind };
    } catch (error) {
      if (document) throw error;
    }
  } else {
    try {
      const read = await readImportFile(fileName, bytes);
      if (read.kind === 'NAV_STATEMENT' || read.kind === 'FINANCIAL_STATEMENT') {
        return { headers: read.table.headers, rows: read.table.rows, hints: read.hints, kind: read.kind };
      }
    } catch {
      // A plain spreadsheet stays on the tabular parser.
    }
  }
  const table = parseTabularFile(fileName, bytes);
  return { headers: table.headers, rows: table.rows, hints: [], kind: null };
}

function cleanSource(value?: string | null): string | null {
  if (!value || !String(value).trim()) return null;
  const code = normalizeSourceCode(String(value));
  return code || null;
}

export class MapMismatchError extends Error {
  missingHeaders: string[];
  constructor(mapCode: string, missingHeaders: string[]) {
    super(missingHeaders.length
      ? `This file is missing ${missingHeaders.join(', ')} from map ${mapCode}.`
      : `This file does not match map ${mapCode}.`);
    this.name = 'MapMismatchError';
    this.missingHeaders = missingHeaders;
  }
}

async function planColumns(
  client: SupabaseClient,
  upload: UploadTable,
  forceMapCode?: string,
): Promise<{ columnMappings: ColumnAssignment[]; identity: LoadMapIdentity; mapReuse: 'exact' | 'extended' | 'new' | null; artifact: ReusableMap | null }> {
  const reusable = Boolean(forceMapCode)
    || upload.kind === 'NAV_STATEMENT'
    || upload.kind === 'FINANCIAL_STATEMENT'
    || (upload.kind !== null && upload.hints.length > 0);
  if (!reusable) {
    const planned = await columnsForTable(client, upload.headers, upload.rows, upload.hints);
    return { ...planned, mapReuse: null, artifact: null };
  }

  const saved = forceMapCode ? [await requireReusableMap(forceMapCode, client)] : await listReusableMaps(client);
  const match = matchReusableMap(upload.headers, saved, forceMapCode ? undefined : upload.kind || undefined);
  if (forceMapCode && match.type === 'none') throw new MapMismatchError(forceMapCode, match.missingHeaders);

  if (match.type === 'exact' || match.type === 'extended') {
    const fresh = match.type === 'extended'
      ? (await columnsForTable(
          client,
          match.newHeaders,
          upload.rows,
          upload.hints.filter((hint) => match.newHeaders.includes(hint.sourceColumn)),
        )).columnMappings
      : [];
    const columnMappings = applyReusableMap(upload.headers, upload.rows, match.map, fresh);
    const artifact = reusableFromAssignments(match.map.mapCode, match.map.kind, upload.headers, columnMappings, match.map);
    const stored = await findStoredMap(client, headerSignature(upload.headers));
    const proposed = proposeLoadIdentity(upload.headers, columnMappings);
    return {
      columnMappings,
      mapReuse: match.type,
      artifact,
      identity: {
        mapCode: match.map.mapCode,
        sourceCode: stored?.sourceCode || proposed.sourceCode,
        name: artifact.name,
        description: artifact.description,
      },
    };
  }

  const planned = await columnsForTable(client, upload.headers, upload.rows, upload.hints);
  const mapCode = newMapCode(upload.kind || 'TABULAR', upload.headers);
  const artifact = reusableFromAssignments(mapCode, upload.kind || 'TABULAR', upload.headers, planned.columnMappings, null);
  return {
    columnMappings: planned.columnMappings,
    mapReuse: 'new',
    artifact,
    identity: { ...planned.identity, mapCode, name: artifact.name, description: artifact.description },
  };
}

function reusableFromAssignments(
  mapCode: string,
  kind: string,
  fileHeaders: string[],
  assignments: ColumnAssignment[],
  existing: ReusableMap | null,
): ReusableMap {
  const headers = mergeHeaders(existing?.headers || [], fileHeaders);
  const coreHeaders = existing?.coreHeaders?.length ? existing.coreHeaders : fileHeaders.filter(Boolean);
  return {
    version: 1,
    mapCode,
    kind: existing?.kind || kind,
    name: existing?.name || mapTitle(kind, coreHeaders),
    description: existing?.description || `${kindLabel(kind)} column map. Load another file of this format with POST /api/feeds/maps/${mapCode}/load.`,
    coreHeaders,
    headers,
    assignments: mergeAssignments(existing?.assignments || [], assignments.map(storeAssignment)),
  };
}

export function assignmentsFromMap(map: ReusableMap): ColumnAssignment[] {
  return map.assignments.map((assignment) => ({
    ...assignment,
    samples: [],
    suggestion: { method: 'source_map' as const, confidence: 1, reason: `Saved map ${map.mapCode}` },
  }));
}

export async function listReusableMaps(client: SupabaseClient = useClient()): Promise<ReusableMap[]> {
  assertLocalSupabase(client);
  const rows = await client.schema('entity_instances').from('feed_maps').select('column_mappings').eq('is_active', true);
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map((row: { column_mappings: unknown }) => parseReusableMap(row.column_mappings)).filter((map): map is ReusableMap => Boolean(map));
}

export async function getReusableMap(mapCode: string, client: SupabaseClient = useClient()): Promise<ReusableMap | null> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('feed_maps').select('column_mappings').eq('map_code', mapCode).maybeSingle();
  if (row.error) throw new Error(row.error.message);
  return row.data ? parseReusableMap(row.data.column_mappings) : null;
}

async function requireReusableMap(mapCode: string, client: SupabaseClient): Promise<ReusableMap> {
  const map = await getReusableMap(mapCode, client);
  if (!map) throw new Error(`Map ${mapCode} was not found.`);
  return map;
}

export async function saveReusableMap(client: SupabaseClient, artifact: ReusableMap): Promise<void> {
  assertLocalSupabase(client);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', 'POSITION_FILE').maybeSingle();
  if (source.error) throw new Error(source.error.message);
  const payload = {
    map_code: artifact.mapCode,
    ...(source.data?.id ? { source_id: source.data.id } : {}),
    map_name: artifact.name.slice(0, 200),
    description: artifact.description,
    column_mappings: artifact,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const existing = await client.schema('entity_instances').from('feed_maps').select('id').eq('map_code', artifact.mapCode).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const write = existing.data
    ? await client.schema('entity_instances').from('feed_maps').update(payload).eq('id', existing.data.id)
    : await client.schema('entity_instances').from('feed_maps').insert(payload);
  if (write.error) throw new Error(write.error.message);
}

export async function loadFileWithMap(
  mapCode: string,
  fileName: string,
  mediaType: string,
  bytes: Buffer,
  asOfDate?: string,
  client: SupabaseClient = useClient(),
  sourceCode?: string,
): Promise<ImportInstanceDetail> {
  const instance = await createImportInstance(fileName, mediaType, bytes, client, { forceMapCode: mapCode, sourceCode });
  const asOf = asOfDate || instance.asOfDate || new Date().toISOString().slice(0, 10);
  return processImportInstance(instance.id, instance.columnMappings, asOf, client);
}
