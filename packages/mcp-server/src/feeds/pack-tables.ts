/**
 * Loading a pack one table at a time.
 *
 * An administrator pack is usually a workbook: a balance sheet, a schedule of
 * investments, a cash ledger. Load data stores every table of the file and
 * loads the one that is selected. A workflow has to see all of them before it
 * decides anything, and then load each with its own mapping, so these read any
 * table of a stored file, try a mapping on it without writing, and load it.
 *
 * A mapping given here is checked against the catalog before it is used. A
 * column, record type, or attribute that does not exist is refused by name,
 * instead of being dropped quietly by the loader.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertLocalSupabase, executeParsedFeed, localSupabase } from './feed-loader';
import { listMappingCatalog, listSources, processImportInstance } from './import-instances';
import { findStoredMap, headerSignature, proposeLoadIdentity, type LoadMapIdentity } from './load-maps';
import { normalizeSourceCode } from './row-context';
import { describeOrphans, feedMapFromAssignments, orphanColumns, type AssignmentRole, type ColumnAssignment } from './suggest';
import type { CellLocation, FeedLoadResult, PageSize, TransformKind } from './types';

const ROLES: readonly AssignmentRole[] = ['ignore', 'filter', 'as_of', 'source', 'identity', 'name', 'alias', 'attribute', 'parent'];
const TRANSFORMS: readonly TransformKind[] = ['none', 'trim', 'number', 'percent', 'date', 'uppercase', 'lowercase', 'list', 'replace'];
const NEEDS_DOMAIN: readonly AssignmentRole[] = ['identity', 'name', 'alias', 'attribute', 'parent'];

export interface MappingCatalog {
  attributes: Array<{ attributeCode: string; domainCode?: string | null }>;
  domains: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turns the mapping an agent or a person wrote into full column assignments
 * for a table, or says exactly what is wrong with it. A header the mapping
 * does not mention is not loaded.
 */
export function normalizeAssignments(headers: string[], raw: unknown, catalog: MappingCatalog): { assignments: ColumnAssignment[]; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(headers);
  const domains = new Set(catalog.domains);
  const attributes = new Map(catalog.attributes.map((attribute) => [attribute.attributeCode, attribute]));
  const byColumn = new Map<string, ColumnAssignment>();

  for (const entry of Array.isArray(raw) ? raw : []) {
    const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const sourceColumn = typeof row.sourceColumn === 'string' ? row.sourceColumn : '';
    if (!known.has(sourceColumn)) {
      problems.push(`"${sourceColumn}" is not a column of this table.`);
      continue;
    }
    if (byColumn.has(sourceColumn)) {
      problems.push(`"${sourceColumn}" is mapped twice.`);
      continue;
    }
    const role = (text(row.role) || 'ignore') as AssignmentRole;
    if (!ROLES.includes(role)) {
      problems.push(`"${sourceColumn}" has the role "${role}". Use one of: ${ROLES.join(', ')}.`);
      continue;
    }
    let domainCode = text(row.domainCode) || null;
    const attributeCode = text(row.attributeCode) || null;
    const parentDomainCode = text(row.parentDomainCode) || null;

    if (role === 'attribute') {
      const attribute = attributeCode ? attributes.get(attributeCode) : undefined;
      if (!attributeCode) problems.push(`"${sourceColumn}" is mapped to an attribute but names none.`);
      else if (!attribute) problems.push(`"${sourceColumn}" is mapped to ${attributeCode}, which is not an attribute. Use a target from list_position_file_mapping_targets.`);
      else if (!domainCode) domainCode = attribute.domainCode || null;
    }
    if (NEEDS_DOMAIN.includes(role)) {
      if (!domainCode) problems.push(`"${sourceColumn}" needs the record type it belongs to (domainCode).`);
      else if (!domains.has(domainCode)) problems.push(`"${sourceColumn}" is mapped to the record type ${domainCode}, which does not exist.`);
    }
    if (role === 'parent') {
      if (!parentDomainCode) problems.push(`"${sourceColumn}" links to a parent record but does not say which type (parentDomainCode).`);
      else if (!domains.has(parentDomainCode)) problems.push(`"${sourceColumn}" links to the record type ${parentDomainCode}, which does not exist.`);
    }
    if (role === 'filter' && !text(row.filterEquals)) problems.push(`"${sourceColumn}" is a row filter but has no value to keep (filterEquals).`);

    const given = row.transform && typeof row.transform === 'object' ? (row.transform as Record<string, unknown>) : {};
    const kind = (text(given.kind) || 'none') as TransformKind;
    if (!TRANSFORMS.includes(kind)) problems.push(`"${sourceColumn}" has the cleanup "${kind}". Use one of: ${TRANSFORMS.join(', ')}.`);

    byColumn.set(sourceColumn, {
      sourceColumn,
      samples: [],
      role,
      domainCode: NEEDS_DOMAIN.includes(role) ? domainCode : null,
      attributeCode: role === 'attribute' ? attributeCode : null,
      parentDomainCode: role === 'parent' ? parentDomainCode : null,
      ...(row.parentExisting === true ? { parentExisting: true } : {}),
      filterEquals: role === 'filter' ? text(row.filterEquals) : null,
      transform: {
        kind,
        ...(typeof given.find === 'string' ? { find: given.find } : {}),
        ...(typeof given.replaceWith === 'string' ? { replaceWith: given.replaceWith } : {}),
        ...(Array.isArray(given.values) ? { values: given.values as { from: string; to: string }[] } : {}),
      },
      suggestion: { method: 'manual', confidence: 1, reason: 'Set in a workflow' },
    });
  }

  const assignments = headers.map((header) => byColumn.get(header) || {
    sourceColumn: header,
    samples: [],
    role: 'ignore' as const,
    domainCode: null,
    attributeCode: null,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'none' as const },
    suggestion: { method: 'manual' as const, confidence: 1, reason: 'Not mapped' },
  });
  if (problems.length === 0) {
    if (!assignments.some((assignment) => assignment.role === 'identity')) problems.push('No column identifies the records. Map one column to a record type\'s code.');
    const orphans = orphanColumns(assignments);
    if (orphans.length > 0) problems.push(`${describeOrphans(orphans)}. Map a column to that record type's code, or leave these columns out.`);
  }
  return { assignments, problems };
}

interface StoredTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  locations?: (CellLocation | null)[][];
  pages?: PageSize[];
}

interface InstanceRow {
  id: string;
  file_name: string;
  status: string;
  as_of_date: string | null;
  source_code: string | null;
  source_id: string | null;
  map_code: string | null;
  headers: string[] | null;
  parsed_rows: Record<string, string>[] | null;
  column_mappings: ColumnAssignment[] | null;
  tables: StoredTable[] | null;
  table_id: string | null;
}

/** A file with one table has no stored list. It is shown as a single table with this id. */
const ONLY_TABLE = 'file';

function db(client?: SupabaseClient): SupabaseClient {
  const found = client || localSupabase();
  assertLocalSupabase(found);
  return found;
}

async function readInstance(client: SupabaseClient, id: string, clientId: string): Promise<InstanceRow> {
  const row = await client
    .schema('entity_instances')
    .from('import_instances')
    .select('id, file_name, status, as_of_date, source_code, source_id, map_code, headers, parsed_rows, column_mappings, tables, table_id')
    .eq('id', id)
    .eq('client_id', clientId)
    .single();
  if (row.error || !row.data) throw new Error(row.error?.message || 'That file is not stored for this client.');
  return row.data as InstanceRow;
}

function tablesOf(row: InstanceRow): { tables: StoredTable[]; selectedId: string } {
  const stored = Array.isArray(row.tables) ? row.tables : [];
  if (stored.length === 0) {
    return { tables: [{ id: ONLY_TABLE, name: row.file_name, headers: row.headers || [], rows: row.parsed_rows || [] }], selectedId: ONLY_TABLE };
  }
  const selected = stored.find((table) => table.id === row.table_id) || stored[0];
  return { tables: stored, selectedId: selected.id };
}

function pick(row: InstanceRow, tableId: string | null | undefined): { table: StoredTable; selected: boolean } {
  const { tables, selectedId } = tablesOf(row);
  const wanted = tableId || selectedId;
  const table = tables.find((candidate) => candidate.id === wanted);
  if (!table) throw new Error(`"${wanted}" is not a table of this file. Its tables: ${tables.map((candidate) => candidate.id).join(', ')}.`);
  return { table, selected: table.id === selectedId };
}

const clipCell = (value: unknown): string => {
  const cell = String(value ?? '');
  return cell.length > 80 ? `${cell.slice(0, 80)}…` : cell;
};

/** Every table of a stored file, with its columns and a few rows, and the sources a load can be filed under. */
export async function getImportTables(id: string, clientId: string, sampleRows = 5, client?: SupabaseClient) {
  const database = db(client);
  const row = await readInstance(database, id, clientId);
  const { tables, selectedId } = tablesOf(row);
  const size = Math.min(20, Math.max(1, Math.trunc(sampleRows) || 5));
  return {
    instanceId: row.id,
    fileName: row.file_name,
    status: row.status,
    asOfDate: row.as_of_date,
    sourceCode: row.source_code,
    tables: tables.map((table) => ({
      tableId: table.id,
      name: table.name,
      selected: table.id === selectedId,
      rowCount: table.rows.length,
      headers: table.headers,
      sampleRows: table.rows.slice(0, size).map((cells) => Object.fromEntries(table.headers.map((header) => [header, clipCell(cells[header])]))),
    })),
    sources: await listSources(database),
  };
}

export interface TableLoadInput {
  tableId?: string | null;
  columnMappings?: unknown;
  asOfDate?: string | null;
  sourceCode?: string | null;
}

interface Planned {
  row: InstanceRow;
  table: StoredTable;
  selected: boolean;
  assignments: ColumnAssignment[];
  asOf: string;
  sourceCode: string | null;
}

async function plan(database: SupabaseClient, id: string, clientId: string, input: TableLoadInput): Promise<Planned> {
  const row = await readInstance(database, id, clientId);
  const { table, selected } = pick(row, input.tableId);
  let assignments: ColumnAssignment[];
  if (Array.isArray(input.columnMappings)) {
    const checked = normalizeAssignments(table.headers, input.columnMappings, await listMappingCatalog(clientId, database));
    if (checked.problems.length > 0) throw new Error(`The mapping cannot be used. ${checked.problems.join(' ')}`);
    assignments = checked.assignments;
  } else if (selected && Array.isArray(row.column_mappings) && row.column_mappings.length > 0) {
    assignments = row.column_mappings;
  } else {
    throw new Error('Give columnMappings for this table. Only the selected table has a stored mapping.');
  }
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(input.asOfDate || '')) ? String(input.asOfDate) : row.as_of_date;
  if (!asOf) throw new Error('Give asOfDate (YYYY-MM-DD): the date the values in this table are as of.');
  const sourceCode = input.sourceCode ? normalizeSourceCode(String(input.sourceCode)) || null : row.source_code;
  return { row, table, selected, assignments, asOf, sourceCode };
}

async function identityFor(database: SupabaseClient, clientId: string, planned: Planned): Promise<LoadMapIdentity> {
  const stored = await findStoredMap(database, clientId, headerSignature(planned.table.headers));
  return stored
    ? { mapCode: stored.mapCode, sourceCode: stored.sourceCode, name: stored.name, description: stored.description }
    : proposeLoadIdentity(planned.table.headers, planned.assignments);
}

const FIRST_ISSUES = 25;

function digest(result: FeedLoadResult) {
  return {
    dryRun: result.dryRun === true,
    asOfDate: result.asOfDate,
    sourceCode: result.sourceCode,
    rowCount: result.rowCount,
    records: result.domains.map((domain) => ({ ...domain, errors: domain.errors.slice(0, 5) })),
    attributes: result.attributes,
    relationships: result.relationships,
    warnings: result.warnings.slice(0, 10),
    errors: result.errors.slice(0, 10),
    rejectCount: result.rejectCount ?? result.rejects?.length ?? 0,
    rejects: (result.rejects || []).slice(0, FIRST_ISSUES),
  };
}

/** What loading a table with this mapping would do. Nothing is written. */
export async function previewImportTable(id: string, clientId: string, input: TableLoadInput, client?: SupabaseClient) {
  const database = db(client);
  const planned = await plan(database, id, clientId, input);
  const map = feedMapFromAssignments(planned.assignments, await identityFor(database, clientId, planned));
  const result = await executeParsedFeed(
    map,
    planned.row.file_name,
    { headers: planned.table.headers, rows: planned.table.rows, locations: planned.table.locations, pages: planned.table.pages },
    planned.asOf,
    database,
    clientId,
    planned.sourceCode || undefined,
    { dryRun: true },
  );
  return { instanceId: id, fileName: planned.row.file_name, tableId: planned.table.id, table: planned.table.name, ...digest(result) };
}

/** Select a table of a stored file, save its mapping, its as-of date and its source, and load it. */
export async function loadImportTable(id: string, clientId: string, input: TableLoadInput, client?: SupabaseClient, options: { actorId?: string | null } = {}) {
  const database = db(client);
  const planned = await plan(database, id, clientId, input);
  if (planned.row.status === 'PROCESSING') throw new Error('This file is already loading. Wait for it to finish before loading it again.');

  const patch: Record<string, unknown> = {};
  if (!planned.selected) {
    // The stored map belongs to the table that was selected before. This table gets its own.
    const identity = await identityFor(database, clientId, planned);
    Object.assign(patch, {
      table_id: planned.table.id,
      headers: planned.table.headers,
      parsed_rows: planned.table.rows,
      row_count: planned.table.rows.length,
      map_code: identity.mapCode,
      map_reuse: null,
    });
  }
  if (planned.sourceCode !== planned.row.source_code) patch.source_code = planned.sourceCode;
  if (Object.keys(patch).length > 0) {
    const updated = await database.schema('entity_instances').from('import_instances').update(patch).eq('id', id).eq('client_id', clientId);
    if (updated.error) throw new Error(updated.error.message);
  }

  let loaded;
  try {
    loaded = await processImportInstance(id, clientId, planned.assignments, planned.asOf, database, undefined, undefined, { actorId: options.actorId });
  } catch (error) {
    // The load records its own failure on the file. What it loaded before is still there.
    throw new Error(`${planned.table.name} did not load. ${error instanceof Error ? error.message : 'The load failed.'}`);
  }
  if (loaded.status !== 'SUCCEEDED') {
    const summary = loaded.resultSummary;
    const counts = summary ? ` ${summary.created} created, ${summary.matched} matched, ${summary.failed} failed.` : '';
    // Rows that loaded stay loaded. The step is reported as failed so the gap is seen.
    throw new Error(`${planned.table.name} loaded with problems.${counts} ${loaded.errorMessage || 'Open the file in Load data to see what was refused.'}`.trim());
  }
  return {
    instanceId: id,
    fileName: loaded.fileName,
    tableId: planned.table.id,
    table: planned.table.name,
    status: loaded.status,
    asOfDate: loaded.asOfDate,
    sourceCode: loaded.sourceCode,
    result: loaded.resultSummary,
    errorMessage: loaded.errorMessage,
    issueCount: loaded.lastIssues?.total ?? 0,
    issues: (loaded.lastIssues?.rejects || []).slice(0, FIRST_ISSUES),
  };
}
