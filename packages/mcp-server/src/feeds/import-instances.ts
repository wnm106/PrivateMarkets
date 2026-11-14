import { type SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import { reviewColumns, type ReviewContext } from './semantic-review';
import { intakeFile, type IntakeTable } from './intake-file';
import { ensureSource, materialize } from './load-sessions';
import { profileDocument, formatOf, type DocumentProfile } from './llama-parse';
import { parseWorkbook } from './parse-table';
import type { SchemaRecommendation } from './specialist';
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
  describeOrphans,
  feedMapFromAssignments,
  orphanColumns,
  suggestAssignments,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
  type ColumnHint,
  type ListChoice,
} from './suggest';
import type { CellLocation, FeedLoadResult, LoadReject, PageSize } from './types';
import { parseUsDate } from './values';
import {
  findStoredMap,
  preferOwnMap,
  visibleToClient,
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

export interface ImportIntake {
  method: string;
  note: string | null;
  profile: DocumentProfile | null;
}

export interface ImportTableChoice {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  /** The original document can show where each value came from. */
  located: boolean;
}

export interface ImportInstanceDetail extends ImportInstanceSummary {
  /** How the file was read, and why. */
  intake: ImportIntake | null;
  /** Every table found in the file. Empty for a plain CSV. */
  tables: ImportTableChoice[];
  tableId: string | null;
  /** Issues from the latest load: refused records, skipped values, links that could not be made. */
  lastIssues: { rejects: LoadReject[]; total: number } | null;
  columnMappings: ColumnAssignment[];
  loadWaves: string[][];
  headers: string[];
}

function useClient(client?: SupabaseClient): SupabaseClient {
  const db = client || localSupabase();
  assertLocalSupabase(db);
  return db;
}

/** The shared catalog plus this client's own additions. Another client's fields and record types stay out. */
async function attributeCatalog(client: SupabaseClient, clientId: string): Promise<{ attributes: AttributeChoice[]; domains: string[] }> {
  const [attributes, domains] = await Promise.all([
    visibleToClient(client.schema('metadata_register').from('attribute_register').select('attribute_code, attribute_name, data_type, domain_code, reference_list_code'), clientId).order('attribute_name'),
    visibleToClient(client.schema('metadata_register').from('domain_types').select('domain_code').eq('is_active', true), clientId).order('domain_code'),
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

export async function listMappingCatalog(clientId: string, client: SupabaseClient = useClient()) {
  assertLocalSupabase(client);
  const catalog = await attributeCatalog(client, clientId);
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

async function savedMaps(client: SupabaseClient, clientId: string): Promise<Map<string, { name: string | null; saved: boolean }>> {
  const maps = await visibleToClient(client.schema('entity_instances').from('feed_maps').select('map_code, map_name, header_signature'), clientId);
  if (maps.error) throw new Error(maps.error.message);
  return new Map((maps.data || []).map((row: any) => [row.map_code, { name: row.map_name, saved: Boolean(row.header_signature) }]));
}

export async function listImportInstances(clientId: string, client: SupabaseClient = useClient()): Promise<ImportInstanceSummary[]> {
  assertLocalSupabase(client);
  const [rows, maps] = await Promise.all([
    client
      .schema('entity_instances')
      .from('import_instances')
      .select('id, file_name, row_count, status, received_at, started_at, completed_at, as_of_date, source_code, error_message, runs, result, map_code, map_reuse')
      .eq('client_id', clientId)
      .order('received_at', { ascending: false }),
    savedMaps(client, clientId),
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

async function columnsForTable(client: SupabaseClient, clientId: string, headers: string[], rows: Record<string, string>[], hints: ColumnHint[] = [], context: ReviewContext = {}): Promise<{ columnMappings: ColumnAssignment[]; identity: LoadMapIdentity }> {
  const [catalog, lists] = await Promise.all([attributeCatalog(client, clientId), listReferenceLists(client)]);
  const stored = await findStoredMap(client, clientId, headerSignature(headers));
  let suggested = suggestAssignments(headers, rows, catalog.attributes, hints);
  if (stored) suggested = overlayStoredMap(suggested, stored.template, stored.name);
  const reviewed = await reviewColumns(suggested, catalog.attributes, catalog.domains, { ...context, rowCount: rows.length });
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
  clientId: string,
  client: SupabaseClient = useClient(),
  options?: { forceMapCode?: string; sourceCode?: string },
): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const upload = await readUpload(fileName, mediaType, bytes, Boolean(options?.forceMapCode));
  upload.context = { fileName, note: upload.intake?.note };
  const planned = await planColumns(client, clientId, upload, options?.forceMapCode);
  const identity = planned.identity;
  const columnMappings = planned.columnMappings;
  if (planned.artifact) await saveReusableMap(client, clientId, planned.artifact);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', identity.sourceCode).maybeSingle();
  if (source.error || !source.data) throw new Error(source.error?.message || `Source ${identity.sourceCode} was not found`);
  const fileSource = cleanSource(options?.sourceCode);
  const inserted = await client.schema('entity_instances').from('import_instances').insert({
    client_id: clientId,
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
    ...intakeColumns(upload),
  }).select('id').single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || 'The file could not be stored');
  return getImportInstance(inserted.data.id, clientId, client);
}

/** Re-read the stored file and replace the column mapping. Load history stays. */
export async function refreshImportInstance(id: string, clientId: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const existing = await client.schema('entity_instances').from('import_instances').select('id, file_name, media_type, source_base64, intake_method, tables, table_id').eq('id', id).eq('client_id', clientId).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  if (!existing.data.source_base64) throw new Error('The original file is not stored, so it cannot be read again.');
  // A document that was read by an outside reader keeps its tables. Reading it again would cost another parse.
  const stored = storedUpload(existing.data);
  const upload = stored || await readUpload(existing.data.file_name, existing.data.media_type || '', Buffer.from(existing.data.source_base64, 'base64'), false);
  upload.context = { fileName: existing.data.file_name, note: upload.intake?.note };
  const planned = await planColumns(client, clientId, upload);
  if (planned.artifact) await saveReusableMap(client, clientId, planned.artifact);
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
  }).eq('id', id).eq('client_id', clientId);
  if (updated.error) throw new Error(updated.error.message);
  return getImportInstance(id, clientId, client);
}

export async function getImportInstance(id: string, clientId: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('import_instances').select('*').eq('id', id).eq('client_id', clientId).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Import instance not found');
  const mappings = (row.data.column_mappings || []) as ColumnAssignment[];
  const maps = await savedMaps(client, clientId);
  const map = feedMapFromAssignments(mappings);
  return {
    ...toSummary(row.data, maps.get(row.data.map_code)),
    lastIssues: row.data.result?.rejects
      ? { rejects: row.data.result.rejects as LoadReject[], total: Number(row.data.result.rejectCount ?? row.data.result.rejects.length) }
      : null,
    intake: row.data.intake_method
      ? { method: row.data.intake_method, note: row.data.intake_note || null, profile: (row.data.intake_profile as DocumentProfile | null) || null }
      : null,
    tables: (Array.isArray(row.data.tables) ? row.data.tables : []).map((table: StoredImportTable) => ({
      id: table.id,
      name: table.name,
      rowCount: table.rows.length,
      columnCount: table.headers.length,
      located: Boolean(table.locations?.length),
    })),
    tableId: row.data.table_id || null,
    columnMappings: mappings,
    headers: row.data.headers || [],
    loadWaves: map.domains.length > 0 ? dependencyLoadWaves(map.domains) : [],
  };
}

export async function saveImportInstance(id: string, columnMappings: ColumnAssignment[], asOfDate: string | null, clientId: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const updated = await client.schema('entity_instances').from('import_instances').update({
    column_mappings: columnMappings,
    as_of_date: asOfDate,
  }).eq('id', id).eq('client_id', clientId);
  if (updated.error) throw new Error(updated.error.message);
  return getImportInstance(id, clientId, client);
}

/** Switch which table of a multi-table file is loaded. The mapping is suggested again for it. */
export async function selectImportTable(id: string, clientId: string, tableId: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const existing = await client.schema('entity_instances').from('import_instances').select('id, file_name, tables, intake_method, intake_note').eq('id', id).eq('client_id', clientId).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  const tables = (Array.isArray(existing.data.tables) ? existing.data.tables : []) as StoredImportTable[];
  const chosen = tables.find((table) => table.id === tableId);
  if (!chosen) throw new Error('That table is not in this file.');
  const upload: UploadTable = { headers: chosen.headers, rows: chosen.rows, hints: [], kind: null, context: { fileName: existing.data.file_name, note: existing.data.intake_note } };
  const planned = await planColumns(client, clientId, upload);
  if (planned.artifact) await saveReusableMap(client, clientId, planned.artifact);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', planned.identity.sourceCode).maybeSingle();
  if (source.error) throw new Error(source.error.message);
  const updated = await client.schema('entity_instances').from('import_instances').update({
    table_id: chosen.id,
    headers: chosen.headers,
    parsed_rows: chosen.rows,
    row_count: chosen.rows.length,
    column_mappings: planned.columnMappings,
    as_of_date: suggestedAsOf(planned.columnMappings, chosen.rows),
    map_code: planned.identity.mapCode,
    ...(planned.mapReuse ? { map_reuse: planned.mapReuse } : {}),
    ...(source.data?.id ? { source_id: source.data.id } : {}),
  }).eq('id', id).eq('client_id', clientId);
  if (updated.error) throw new Error(updated.error.message);
  return getImportInstance(id, clientId, client);
}

/** The original bytes of an upload, for showing the source document. */
export async function getImportFile(id: string, clientId: string, client: SupabaseClient = useClient()): Promise<{ fileName: string; mediaType: string; bytes: Buffer }> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('import_instances').select('file_name, media_type, source_base64').eq('id', id).eq('client_id', clientId).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Import instance not found');
  if (!row.data.source_base64) throw new Error('The original file is not stored.');
  return { fileName: row.data.file_name, mediaType: row.data.media_type || 'application/octet-stream', bytes: Buffer.from(row.data.source_base64, 'base64') };
}

export interface ImportLocations {
  tableId: string | null;
  headers: string[];
  pages: PageSize[];
  /** One entry per row, one per column. Null where the reader gave no position. */
  locations: (CellLocation | null)[][];
}

/** Where each value of the loaded table sits in the original document. Null when the file has no layout. */
export async function getImportLocations(id: string, clientId: string, client: SupabaseClient = useClient()): Promise<ImportLocations | null> {
  assertLocalSupabase(client);
  const row = await client.schema('entity_instances').from('import_instances').select('tables, table_id').eq('id', id).eq('client_id', clientId).single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'Import instance not found');
  const table = activeStoredTable(row.data);
  if (!table?.locations?.length) return null;
  return { tableId: table.id, headers: table.headers, pages: table.pages || [], locations: table.locations };
}

export interface SourceChoice {
  code: string;
  name: string;
}

export async function listSources(client: SupabaseClient = useClient()): Promise<SourceChoice[]> {
  assertLocalSupabase(client);
  const rows = await client.schema('entity_instances').from('source_registry').select('source_code, source_name').eq('is_active', true).order('source_name');
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map((row: any) => ({ code: row.source_code, name: row.source_name }));
}

/** Which source the values in this file belong to. A name that is not in the registry is created when the file loads. */
export async function setImportSource(id: string, clientId: string, source: string | null, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const code = cleanSource(source);
  const updated = await client.schema('entity_instances').from('import_instances').update({ source_code: code }).eq('id', id).eq('client_id', clientId).select('id');
  if (updated.error) throw new Error(updated.error.message);
  if (!updated.data || updated.data.length === 0) throw new Error('Import instance not found');
  return getImportInstance(id, clientId, client);
}

function sourceTitle(code: string): string {
  return code.toLowerCase().split('_').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function attributeCodeFrom(text: string): string {
  return text.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/**
 * Add a field to the catalog for a column that has nowhere to live, and put it on
 * the record type's standard template. Nothing is created unless the user asks.
 */
export async function trackImportAttribute(
  input: { domainCode: string; attributeName: string; dataType?: string; column?: string },
  clientId: string,
  client: SupabaseClient = useClient(),
): Promise<{ attributeCode: string; domainCode: string }> {
  assertLocalSupabase(client);
  const attributeCode = attributeCodeFrom(input.attributeName);
  if (!attributeCode) throw new Error('Name the field first.');
  if (!input.domainCode) throw new Error('Choose which record type the field belongs to.');
  const dataType = ['STRING', 'NUMBER', 'DATE', 'PERCENTAGE', 'CURRENCY', 'BOOLEAN'].includes(String(input.dataType)) ? String(input.dataType) : 'STRING';
  const recommendation: SchemaRecommendation = {
    id: `track:${input.domainCode}:${attributeCode}`,
    kind: 'attribute',
    title: input.attributeName,
    rationale: `Added from a file load${input.column ? ` for the column "${input.column}"` : ''}.`,
    payload: { domainCode: input.domainCode, attributeCode, attributeName: input.attributeName.trim(), dataType, column: input.column },
  };
  await materialize(client, clientId, [recommendation], [recommendation.id]);
  return { attributeCode, domainCode: input.domainCode };
}

/** A load still marked PROCESSING after this long is treated as abandoned. */
const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

export async function processImportInstance(id: string, clientId: string, columnMappings?: ColumnAssignment[], asOfDate?: string, client?: SupabaseClient): Promise<ImportInstanceDetail> {
  const db = client || useClient();
  assertLocalSupabase(db);
  const existing = await db.schema('entity_instances').from('import_instances').select('*').eq('id', id).eq('client_id', clientId).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  const mappings = columnMappings || (existing.data.column_mappings as ColumnAssignment[]);
  const asOf = asOfDate || existing.data.as_of_date;
  if (!asOf) throw new Error('Choose today or a specific as-of date');
  const sourceRow = await db.schema('entity_instances').from('source_registry').select('source_code').eq('id', existing.data.source_id).maybeSingle();
  if (sourceRow.error) throw new Error(sourceRow.error.message);
  const signature = headerSignature(existing.data.headers || []);
  const stored = await findStoredMap(db, clientId, signature);
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
  const orphans = orphanColumns(mappings);
  if (orphans.length > 0) {
    throw new Error(`${describeOrphans(orphans)}. Choose an identity column for it, or set the column to "do not load".`);
  }
  await saveLoadMap(db, { ...identity, clientId, signature, template: templateFromAssignments(mappings), feedMap: map });
  const reusable = await getReusableMap(identity.mapCode, clientId, db);
  if (reusable || existing.data.map_reuse) {
    await saveReusableMap(db, clientId, reusableFromAssignments(
      identity.mapCode,
      reusable?.kind || 'TABULAR',
      existing.data.headers || [],
      mappings,
      reusable,
    ));
  }
  const startedAt = new Date().toISOString();
  const fileSource = cleanSource(existing.data.source_code);
  if (fileSource) await ensureSource(db, fileSource, sourceTitle(fileSource));
  // Claim the file. A second request finds it already PROCESSING and is refused,
  // unless that run started long ago and was most likely cut off.
  const staleBefore = new Date(Date.now() - PROCESSING_TIMEOUT_MS).toISOString();
  const marked = await db.schema('entity_instances').from('import_instances').update({
    status: 'PROCESSING',
    started_at: startedAt,
    column_mappings: mappings,
    map_code: identity.mapCode,
    as_of_date: asOf,
    error_message: null,
  }).eq('id', id).eq('client_id', clientId).or(`status.neq.PROCESSING,started_at.lt.${staleBefore}`).select('id');
  if (marked.error) throw new Error(marked.error.message);
  if (!marked.data || marked.data.length === 0) {
    throw new Error('This file is already loading. Wait for it to finish before loading it again.');
  }

  try {
    const located = activeStoredTable(existing.data);
    const result = await executeParsedFeed(map, existing.data.file_name, {
      headers: existing.data.headers || [],
      rows: existing.data.parsed_rows || [],
      locations: located?.locations,
      pages: located?.pages,
    }, asOf, db, clientId, cleanSource(existing.data.source_code) || undefined, { provenance: { instanceId: id, tableId: existing.data.table_id || null } });
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
    }).eq('id', id).eq('client_id', clientId);
    if (saved.error) throw new Error(saved.error.message);
    return getImportInstance(id, clientId, db);
  } catch (error: any) {
    const completedAt = new Date().toISOString();
    const runs = Array.isArray(existing.data.runs) ? existing.data.runs : [];
    runs.push({ startedAt, completedAt, asOfDate: asOf, status: 'FAILED', created: 0, matched: 0, failed: 1 });
    await db.schema('entity_instances').from('import_instances').update({
      status: 'FAILED',
      completed_at: completedAt,
      runs,
      error_message: error?.message || 'Process failed',
    }).eq('id', id).eq('client_id', clientId);
    throw error;
  }
}

/**
 * Run the load without writing anything. Matching, coercion, and the slice
 * rules are the real ones, so the counts are what a load would produce now.
 * The instance, the saved map, and the data are all left as they were.
 */
export async function previewImportInstance(
  id: string,
  clientId: string,
  columnMappings?: ColumnAssignment[],
  asOfDate?: string,
  client?: SupabaseClient,
): Promise<FeedLoadResult> {
  const db = client || useClient();
  assertLocalSupabase(db);
  const existing = await db.schema('entity_instances').from('import_instances').select('*').eq('id', id).eq('client_id', clientId).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  const mappings = columnMappings || (existing.data.column_mappings as ColumnAssignment[]);
  const asOf = asOfDate || existing.data.as_of_date;
  if (!asOf) throw new Error('Choose today or a specific as-of date');
  const sourceRow = await db.schema('entity_instances').from('source_registry').select('source_code').eq('id', existing.data.source_id).maybeSingle();
  if (sourceRow.error) throw new Error(sourceRow.error.message);
  const stored = await findStoredMap(db, clientId, headerSignature(existing.data.headers || []));
  const identity: LoadMapIdentity = stored
    ? { mapCode: stored.mapCode, sourceCode: stored.sourceCode, name: stored.name, description: stored.description }
    : {
        mapCode: existing.data.map_code || 'IMPORT',
        sourceCode: sourceRow.data?.source_code || 'IMPORT',
        name: mapNameFromAssignments(mappings),
        description: 'Preview only.',
      };
  const map = feedMapFromAssignments(mappings, identity);
  if (map.domains.length === 0) throw new Error('Choose which column identifies each record before loading.');
  const orphans = orphanColumns(mappings);
  if (orphans.length > 0) {
    throw new Error(`${describeOrphans(orphans)}. Choose an identity column for it, or set the column to "do not load".`);
  }
  const located = activeStoredTable(existing.data);
  return executeParsedFeed(
    map,
    existing.data.file_name,
    { headers: existing.data.headers || [], rows: existing.data.parsed_rows || [], locations: located?.locations, pages: located?.pages },
    asOf,
    db,
    clientId,
    cleanSource(existing.data.source_code) || undefined,
    { dryRun: true },
  );
}

interface StoredImportTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  /** Where each value sits in the original document. Same shape as rows by headers. */
  locations?: (CellLocation | null)[][];
  pages?: PageSize[];
}

interface UploadTable {
  headers: string[];
  rows: Record<string, string>[];
  hints: ColumnHint[];
  kind: string | null;
  intake?: { method: string; note: string | null; profile: DocumentProfile | null };
  /** What the semantic review is told about the file. */
  context?: ReviewContext;
  /** Every table in the file, when there is more than one or a document reader found them. */
  tables?: StoredImportTable[];
  tableId?: string;
}

const DOCUMENT_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.docx', '.doc'];

/** Only what this file has to record, so a plain CSV never touches the intake columns. */
function intakeColumns(upload: UploadTable) {
  const columns: Record<string, unknown> = {};
  if (upload.intake) {
    columns.intake_method = upload.intake.method;
    columns.intake_note = upload.intake.note;
    columns.intake_profile = upload.intake.profile;
  }
  if (upload.tables) {
    columns.tables = upload.tables;
    columns.table_id = upload.tableId || null;
  }
  return columns;
}

/**
 * The table to load by default. One that is at least three times the size of
 * the next is obvious. Otherwise the first, and the review asks the user to confirm.
 */
export function pickTable(tables: { id: string; table: { rows: unknown[] } }[]): string {
  const ranked = [...tables].sort((left, right) => right.table.rows.length - left.table.rows.length);
  if (ranked.length > 1 && ranked[0].table.rows.length >= ranked[1].table.rows.length * 3) return ranked[0].id;
  return tables[0].id;
}

function uploadFromTables(
  tables: IntakeTable[],
  intake: { method: string; note: string | null; profile: DocumentProfile | null },
  chosenId?: string,
): UploadTable {
  const chosen = tables.find((table) => table.id === chosenId) || tables.find((table) => table.id === pickTable(tables)) || tables[0];
  return {
    headers: chosen.table.headers,
    rows: chosen.table.rows,
    hints: [],
    kind: null,
    intake,
    tables: tables.map((table) => ({ id: table.id, name: table.name, headers: table.table.headers, rows: table.table.rows, locations: table.table.locations, pages: table.table.pages })),
    tableId: chosen.id,
  };
}

function activeStoredTable(row: { tables?: unknown; table_id?: string | null }): StoredImportTable | null {
  const tables = (Array.isArray(row.tables) ? row.tables : []) as StoredImportTable[];
  return tables.find((table) => table.id === row.table_id) || tables[0] || null;
}

/** A document read by an outside reader is not read again. Its stored tables are used. */
function storedUpload(row: { intake_method?: string | null; tables?: unknown; table_id?: string | null }): UploadTable | null {
  if (!row.intake_method || !['llamaparse', 'azure_layout', 'agent'].includes(row.intake_method)) return null;
  const tables = (Array.isArray(row.tables) ? row.tables : []) as StoredImportTable[];
  if (tables.length === 0) return null;
  return uploadFromTables(
    tables.map((table) => ({ id: table.id, name: table.name, table: { headers: table.headers, rows: table.rows, locations: table.locations, pages: table.pages } })),
    { method: row.intake_method, note: null, profile: null },
    row.table_id || undefined,
  );
}

async function readUpload(fileName: string, mediaType: string, bytes: Buffer, forceInterpret: boolean): Promise<UploadTable> {
  const lower = fileName.toLowerCase();
  const isDocument = DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
  const textual = lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.json');

  if (isDocument) {
    // A short statement with a text layer is read here, which keeps its column hints.
    const profile = await profileDocument(fileName, bytes);
    if (formatOf(fileName) === 'pdf' && profile.route === 'local') {
      try {
        const read = await readImportFile(fileName, bytes);
        return { headers: read.table.headers, rows: read.table.rows, hints: read.hints, kind: read.kind, intake: { method: 'local', note: profile.reasons[0] || null, profile } };
      } catch {
        // Not a statement the built-in reader knows. The document readers get a turn.
      }
    }
    const intake = await intakeFile(fileName, mediaType, bytes);
    if (intake.tables.length === 0) throw new Error(intake.note);
    return uploadFromTables(intake.tables, { method: intake.method, note: intake.note, profile: intake.profile || profile });
  }

  if (forceInterpret || textual) {
    try {
      const read = await readImportFile(fileName, bytes);
      return { headers: read.table.headers, rows: read.table.rows, hints: read.hints, kind: read.kind };
    } catch (error) {
      if (textual) throw error;
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

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const sheets = parseWorkbook(bytes).filter((sheet) => sheet.table.headers.length > 0 && sheet.table.rows.length > 0);
    if (sheets.length > 1) {
      return uploadFromTables(sheets, { method: 'tabular', note: `The workbook has ${sheets.length} sheets.`, profile: null });
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
  clientId: string,
  upload: UploadTable,
  forceMapCode?: string,
): Promise<{ columnMappings: ColumnAssignment[]; identity: LoadMapIdentity; mapReuse: 'exact' | 'extended' | 'new' | null; artifact: ReusableMap | null }> {
  const reusable = Boolean(forceMapCode)
    || upload.kind === 'NAV_STATEMENT'
    || upload.kind === 'FINANCIAL_STATEMENT'
    || (upload.kind !== null && upload.hints.length > 0);
  if (!reusable) {
    const planned = await columnsForTable(client, clientId, upload.headers, upload.rows, upload.hints, upload.context);
    return { ...planned, mapReuse: null, artifact: null };
  }

  const saved = forceMapCode ? [await requireReusableMap(forceMapCode, clientId, client)] : await listReusableMaps(clientId, client);
  const match = matchReusableMap(upload.headers, saved, forceMapCode ? undefined : upload.kind || undefined);
  if (forceMapCode && match.type === 'none') throw new MapMismatchError(forceMapCode, match.missingHeaders);

  if (match.type === 'exact' || match.type === 'extended') {
    const fresh = match.type === 'extended'
      ? (await columnsForTable(
          client,
          clientId,
          match.newHeaders,
          upload.rows,
          upload.hints.filter((hint) => match.newHeaders.includes(hint.sourceColumn)),
          upload.context,
        )).columnMappings
      : [];
    const columnMappings = applyReusableMap(upload.headers, upload.rows, match.map, fresh);
    const artifact = reusableFromAssignments(match.map.mapCode, match.map.kind, upload.headers, columnMappings, match.map);
    const stored = await findStoredMap(client, clientId, headerSignature(upload.headers));
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

  const planned = await columnsForTable(client, clientId, upload.headers, upload.rows, upload.hints, upload.context);
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

export async function listReusableMaps(clientId: string, client: SupabaseClient = useClient()): Promise<ReusableMap[]> {
  assertLocalSupabase(client);
  const rows = await visibleToClient(client.schema('entity_instances').from('feed_maps').select('column_mappings').eq('is_active', true), clientId);
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map((row: { column_mappings: unknown }) => parseReusableMap(row.column_mappings)).filter((map): map is ReusableMap => Boolean(map));
}

export async function getReusableMap(mapCode: string, clientId: string, client: SupabaseClient = useClient()): Promise<ReusableMap | null> {
  assertLocalSupabase(client);
  const rows = await visibleToClient(client.schema('entity_instances').from('feed_maps').select('column_mappings, client_id').eq('map_code', mapCode), clientId);
  if (rows.error) throw new Error(rows.error.message);
  const row = preferOwnMap(rows.data as any[], clientId);
  return row ? parseReusableMap(row.column_mappings) : null;
}

async function requireReusableMap(mapCode: string, clientId: string, client: SupabaseClient): Promise<ReusableMap> {
  const map = await getReusableMap(mapCode, clientId, client);
  if (!map) throw new Error(`Map ${mapCode} was not found.`);
  return map;
}

export async function saveReusableMap(client: SupabaseClient, clientId: string, artifact: ReusableMap): Promise<void> {
  assertLocalSupabase(client);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', 'POSITION_FILE').maybeSingle();
  if (source.error) throw new Error(source.error.message);
  const payload = {
    client_id: clientId,
    map_code: artifact.mapCode,
    ...(source.data?.id ? { source_id: source.data.id } : {}),
    map_name: artifact.name.slice(0, 200),
    description: artifact.description,
    column_mappings: artifact,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const existing = await client.schema('entity_instances').from('feed_maps').select('id').eq('client_id', clientId).eq('map_code', artifact.mapCode).maybeSingle();
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
  clientId: string,
  asOfDate?: string,
  client: SupabaseClient = useClient(),
  sourceCode?: string,
): Promise<ImportInstanceDetail> {
  const instance = await createImportInstance(fileName, mediaType, bytes, clientId, client, { forceMapCode: mapCode, sourceCode });
  const asOf = asOfDate || instance.asOfDate || new Date().toISOString().slice(0, 10);
  return processImportInstance(instance.id, clientId, instance.columnMappings, asOf, client);
}
