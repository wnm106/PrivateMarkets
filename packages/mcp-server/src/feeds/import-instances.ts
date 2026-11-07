import { type SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import { dependencyLoadWaves } from './load-order';
import { readImportFile } from './intake';
import { POSITION_FILE_MAP } from './position-file-map';
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
import {
  feedMapFromAssignments,
  suggestAssignments,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
} from './suggest';
import type { FeedLoadResult } from './types';
import { parseUsDate } from './values';

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
  mapCode: string;
  mapReuse: 'exact' | 'extended' | 'new';
  resultSummary: {
    created: number;
    matched: number;
    failed: number;
    attributesCreated: number;
    attributesUpdated: number;
    attributesUnchanged: number;
    relationshipsMatched: number;
  } | null;
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
  };
}

function toSummary(row: any): ImportInstanceSummary {
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
    mapCode: row.map_code,
    mapReuse: row.map_reuse === 'exact' || row.map_reuse === 'extended' ? row.map_reuse : 'new',
    resultSummary: summarize(row.result),
  };
}

export async function listImportInstances(client: SupabaseClient = useClient()): Promise<ImportInstanceSummary[]> {
  assertLocalSupabase(client);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', POSITION_FILE_MAP.sourceCode).single();
  if (source.error || !source.data) throw new Error(source.error?.message || 'Position File source is missing');
  const rows = await client
    .schema('entity_instances')
    .from('import_instances')
    .select('id, file_name, row_count, status, received_at, started_at, completed_at, as_of_date, error_message, runs, result, map_code, map_reuse')
    .eq('source_id', source.data.id)
    .order('received_at', { ascending: false });
  if (rows.error) throw new Error(rows.error.message);
  return (rows.data || []).map(toSummary);
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

export async function createImportInstance(
  fileName: string,
  mediaType: string,
  bytes: Buffer,
  client: SupabaseClient = useClient(),
  options?: { forceMapCode?: string },
): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const read = await readImportFile(fileName, bytes);
  const table = read.table;
  const catalog = await attributeCatalog(client);
  const savedMaps = options?.forceMapCode
    ? [await requireReusableMap(options.forceMapCode, client)]
    : await listReusableMaps(client);
  const match = matchReusableMap(table.headers, savedMaps, options?.forceMapCode ? undefined : read.kind);
  if (options?.forceMapCode && match.type === 'none') {
    throw new MapMismatchError(options.forceMapCode, match.missingHeaders);
  }
  let columnMappings: ColumnAssignment[];
  let mapCode = newMapCode(read.kind, table.headers);
  let mapReuse: 'exact' | 'extended' | 'new' = 'new';
  if (match.type === 'exact') {
    columnMappings = applyReusableMap(table.headers, table.rows, match.map, []);
    mapCode = match.map.mapCode;
    mapReuse = 'exact';
  } else if (match.type === 'extended') {
    const fresh = await reviewWithModel(
      suggestAssignments(match.newHeaders, table.rows, openAttributes(catalog.attributes, match.map, table.headers), read.hints),
      catalog.attributes,
    );
    columnMappings = applyReusableMap(table.headers, table.rows, match.map, fresh);
    mapCode = match.map.mapCode;
    mapReuse = 'extended';
  } else {
    columnMappings = await reviewWithModel(
      suggestAssignments(table.headers, table.rows, catalog.attributes, read.hints),
      catalog.attributes,
    );
  }
  const artifact = reusableFromAssignments(mapCode, read.kind, table.headers, columnMappings, match.type === 'none' ? null : match.map);
  await saveReusableMap(client, artifact);
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', POSITION_FILE_MAP.sourceCode).single();
  if (source.error || !source.data) throw new Error(source.error?.message || 'Position File source is missing');
  const inserted = await client.schema('entity_instances').from('import_instances').insert({
    source_id: source.data.id,
    map_code: mapCode,
    map_reuse: mapReuse,
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
  const map = feedMapFromAssignments(mappings);
  return {
    ...toSummary(row.data),
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

export async function processImportInstance(id: string, columnMappings?: ColumnAssignment[], asOfDate?: string, client: SupabaseClient = useClient()): Promise<ImportInstanceDetail> {
  assertLocalSupabase(client);
  const existing = await client.schema('entity_instances').from('import_instances').select('*').eq('id', id).single();
  if (existing.error || !existing.data) throw new Error(existing.error?.message || 'Import instance not found');
  const mappings = columnMappings || (existing.data.column_mappings as ColumnAssignment[]);
  const asOf = asOfDate || existing.data.as_of_date;
  if (!asOf) throw new Error('Choose today or a specific as-of date');
  const startedAt = new Date().toISOString();
  const marked = await client.schema('entity_instances').from('import_instances').update({
    status: 'PROCESSING',
    started_at: startedAt,
    column_mappings: mappings,
    as_of_date: asOf,
    error_message: null,
  }).eq('id', id);
  if (marked.error) throw new Error(marked.error.message);

  try {
    const mapCode = existing.data.map_code || newMapCode('TABULAR', existing.data.headers || []);
    const savedMap = await getReusableMap(mapCode, client);
    const artifact = reusableFromAssignments(mapCode, savedMap?.kind || 'TABULAR', existing.data.headers || [], mappings, savedMap);
    const map = feedMapFromAssignments(mappings, {
      mapCode,
      name: artifact.name,
      description: artifact.description,
    });
    if (map.domains.length === 0) throw new Error('Map at least one column to an entity code before processing');
    await ensureImportAttributes(client, mappings);
    const result = await executeParsedFeed(map, existing.data.file_name, {
      headers: existing.data.headers || [],
      rows: existing.data.parsed_rows || [],
    }, asOf, client);
    await saveReusableMap(client, artifact);
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
    const saved = await client.schema('entity_instances').from('import_instances').update({
      status: failed ? 'FAILED' : 'SUCCEEDED',
      completed_at: completedAt,
      result,
      runs,
      error_message: failed ? result.errors.slice(0, 3).join(' ') : null,
    }).eq('id', id);
    if (saved.error) throw new Error(saved.error.message);
    return getImportInstance(id, client);
  } catch (error: any) {
    const completedAt = new Date().toISOString();
    const runs = Array.isArray(existing.data.runs) ? existing.data.runs : [];
    runs.push({ startedAt, completedAt, asOfDate: asOf, status: 'FAILED', created: 0, matched: 0, failed: 1 });
    await client.schema('entity_instances').from('import_instances').update({
      status: 'FAILED',
      completed_at: completedAt,
      runs,
      error_message: error?.message || 'Process failed',
    }).eq('id', id);
    throw error;
  }
}

const TEMPLATE_FOR_DOMAIN: Record<string, string> = {
  FUND: 'FUND_STANDARD',
  ISSUER: 'ISSUER_STANDARD',
  SECURITY: 'SECURITY_STANDARD',
  POSITION: 'POSITION_STANDARD',
  DEAL: 'DEAL_STANDARD',
  CASH_FLOW: 'STANDARD_CASHFLOW',
};

async function ensureImportAttributes(client: SupabaseClient, assignments: ColumnAssignment[]): Promise<void> {
  const specs = new Map<string, { name: string; dataType: string; domainCode: string }>();
  for (const assignment of assignments) {
    if (assignment.role !== 'attribute' || !assignment.attributeCode || !assignment.domainCode) continue;
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(assignment.attributeCode) || specs.has(assignment.attributeCode)) continue;
    const dataType = assignment.transform.kind === 'date'
      ? 'DATE'
      : assignment.transform.kind === 'percent'
        ? 'PERCENTAGE'
        : assignment.transform.kind === 'number'
          ? 'NUMBER'
          : 'STRING';
    specs.set(assignment.attributeCode, {
      name: assignment.sourceColumn.slice(0, 200),
      dataType,
      domainCode: assignment.domainCode,
    });
  }
  if (specs.size === 0) return;
  const existing = await client.schema('metadata_register').from('attribute_register').select('id, attribute_code').in('attribute_code', [...specs.keys()]);
  if (existing.error) throw new Error(existing.error.message);
  const have = new Set((existing.data || []).map((row: { attribute_code: string }) => row.attribute_code));
  const missing = [...specs.entries()].filter(([code]) => !have.has(code));
  let created: Array<{ id: string; attribute_code: string }> = [];
  if (missing.length > 0) {
    const inserted = await client.schema('metadata_register').from('attribute_register').insert(missing.map(([code, spec]) => ({
      attribute_code: code,
      attribute_name: spec.name,
      data_type: spec.dataType,
      description: `Imported from “${spec.name}”.`,
      domain_code: spec.domainCode,
      is_required: false,
      display_section: 'Imported',
    }))).select('id, attribute_code');
    if (inserted.error) throw new Error(inserted.error.message);
    created = inserted.data || [];
  }
  if (created.length === 0) return;
  const templates = await client.schema('metadata_register').from('domain_templates').select('id, template_code');
  if (templates.error || !templates.data) return;
  const templateId = new Map(templates.data.map((row: { id: string; template_code: string }) => [row.template_code, row.id]));
  const rows = created.flatMap((row) => {
    const spec = specs.get(row.attribute_code);
    const template = spec ? templateId.get(TEMPLATE_FOR_DOMAIN[spec.domainCode] || '') : undefined;
    if (!template) return [];
    return [{
      template_id: template,
      attribute_id: row.id,
      is_required: false,
      display_order: 500,
      display_label: spec?.name.slice(0, 200),
    }];
  });
  if (rows.length === 0) return;
  const assigned = await client.schema('metadata_register').from('template_attribute_assignments').insert(rows);
  if (assigned.error && !/duplicate|unique/i.test(assigned.error.message)) {
    throw new Error(assigned.error.message);
  }
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

function openAttributes(attributes: AttributeChoice[], map: ReusableMap, fileHeaders: string[]): AttributeChoice[] {
  const present = new Set(fileHeaders.map((header) => header.trim().toLowerCase()));
  const claimed = map.assignments.filter((assignment) => (
    assignment.role === 'attribute'
    && assignment.attributeCode
    && present.has(assignment.sourceColumn.trim().toLowerCase())
  ));
  return attributes.filter((attribute) => !claimed.some((saved) => (
    saved.attributeCode === attribute.attributeCode
    && (!attribute.domainCode || !saved.domainCode || attribute.domainCode === saved.domainCode)
  )));
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
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', POSITION_FILE_MAP.sourceCode).single();
  if (source.error || !source.data) throw new Error(source.error?.message || 'Position File source is missing');
  const payload = {
    map_code: artifact.mapCode,
    source_id: source.data.id,
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
): Promise<ImportInstanceDetail> {
  const instance = await createImportInstance(fileName, mediaType, bytes, client, { forceMapCode: mapCode });
  const asOf = asOfDate || instance.asOfDate || new Date().toISOString().slice(0, 10);
  return processImportInstance(instance.id, instance.columnMappings, asOf, client);
}

async function reviewWithModel(assignments: ColumnAssignment[], attributes: AttributeChoice[]): Promise<ColumnAssignment[]> {
  const key = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
  if (!key) return assignments;
  const unmapped = assignments.filter((assignment) => assignment.role === 'ignore');
  if (unmapped.length === 0) return assignments;
  const catalog = attributes.slice(0, 180).map((attribute) => `${attribute.domainCode || 'SHARED'}:${attribute.attributeCode}`).join(', ');
  const columns = unmapped.map((assignment) => `${assignment.sourceColumn} (samples: ${assignment.samples.join(' | ')})`).join('\n');
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
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
        suggestion: { method: 'ai' as const, confidence: 0.8, reason: `AI review matched ${attribute.attributeName}` },
      };
    });
  } catch {
    return assignments;
  }
}
