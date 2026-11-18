/**
 * Position file instance queue.
 * Stores the uploaded file, suggests column mappings, and reprocesses the stored rows.
 */

import type { JSONSchema7 } from 'json-schema';
import { withSupabaseCaller } from '../agent/harness';
import { sessionClientId } from '../feeds/session-client';
import { ToolRegistry } from '../lib/tool-registry.js';
import { ToolDefinition } from '../lib/types.js';
import {
  createImportInstance,
  getImportInstance,
  listImportInstances,
  listMappingCatalog,
  processImportInstance,
  saveImportInstance,
} from '../feeds/import-instances';
import { getImportTables, loadImportTable, previewImportTable } from '../feeds/pack-tables';
import { mappingTargets } from '../feeds/suggest';
import type { ColumnAssignment } from '../feeds/suggest';

const columnMappingSchema: JSONSchema7 = {
  type: 'object',
  description: 'One source column. Pass back the object returned by get_position_file_import, with any edits.',
  properties: {
    sourceColumn: { type: 'string' },
    role: { type: 'string', enum: ['ignore', 'filter', 'as_of', 'identity', 'name', 'attribute', 'parent'] },
    domainCode: { type: 'string' },
    attributeCode: { type: 'string' },
    parentDomainCode: { type: 'string' },
    filterEquals: { type: 'string' },
    transform: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['none', 'trim', 'number', 'percent', 'date', 'uppercase', 'lowercase', 'list', 'replace'] },
        find: { type: 'string' },
        replaceWith: { type: 'string' },
      },
      required: ['kind'],
    },
  },
  required: ['sourceColumn', 'role'],
};

const listPositionFileImportsTool: ToolDefinition = {
  name: 'list_position_file_imports',
  description: 'Stored position-file imports: file, received time, status, and each process result. Call this before loading or reloading. Use the returned instance id with get_position_file_import or process_position_file_import. status READY means the file is stored and has not been loaded. Newest first.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Only files in this status: READY, PROCESSING, SUCCEEDED, or FAILED. Several can be given, separated by commas.' },
      limit: { type: 'number', description: 'The most files to return. Leave out for all of them.' },
    },
  },
  execute: async (args, supabase) => {
    const all = await listImportInstances(await sessionClientId(supabase));
    const wanted = new Set(String(args.status || '').toUpperCase().split(',').map((status) => status.trim()).filter(Boolean));
    const matching = wanted.size > 0 ? all.filter((instance) => wanted.has(instance.status)) : all;
    const limit = Math.trunc(Number(args.limit)) || 0;
    const instances = limit > 0 ? matching.slice(0, limit) : matching;
    return { sourceCode: 'POSITION_FILE', instances, ...(instances.length < matching.length ? { notShown: matching.length - instances.length } : {}) };
  },
};

const listPositionFileTargetsTool: ToolDefinition = {
  name: 'list_position_file_mapping_targets',
  description: 'Every attribute a position-file column is allowed to map to, including entity code, entity name, parent links, as-of date, and row filter. Use a returned key when you change a mapping. Do not invent an attribute code. The full list is long: narrow it with domainCodes or search.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      domainCodes: { type: 'array', items: { type: 'string' }, description: 'Only targets of these record types, for example ["NAV_STATEMENT", "POSITION"]. The file-level targets are always included.' },
      search: { type: 'string', description: 'Only targets whose label or attribute code contains this text.' },
    },
  },
  execute: async (args, supabase) => {
    const catalog = await listMappingCatalog(await sessionClientId(supabase));
    const all = mappingTargets(catalog.attributes, catalog.domains);
    const domains = new Set((Array.isArray(args.domainCodes) ? args.domainCodes : []).map((code: unknown) => String(code).trim().toUpperCase()).filter(Boolean));
    const search = String(args.search || '').trim().toLowerCase();
    const targets = all.filter((target) => {
      if (!target.domainCode) return true;
      if (domains.size > 0 && !domains.has(target.domainCode)) return false;
      return !search || target.label.toLowerCase().includes(search) || String(target.attributeCode || '').toLowerCase().includes(search);
    });
    return { targets, recordTypes: catalog.domains, ...(targets.length < all.length ? { notShown: all.length - targets.length } : {}) };
  },
};

const createPositionFileImportTool: ToolDefinition = {
  name: 'create_position_file_import',
  description: 'Store a CSV or Excel position file. Returns a suggested mapping for each column, using only targets from list_position_file_mapping_targets. Does not load records. Call process_position_file_import after the mapping is accepted.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      fileName: { type: 'string', description: 'File name ending in .csv, .xlsx, or .xls' },
      contentBase64: { type: 'string', description: 'Base64-encoded file bytes. Use this for Excel files.' },
      csvText: { type: 'string', description: 'Raw CSV text. Used when contentBase64 is omitted.' },
    },
    required: ['fileName'],
  },
  execute: async (args, supabase) => {
    if (!args.contentBase64 && !args.csvText) throw new Error('Provide contentBase64 or csvText');
    const bytes = args.contentBase64
      ? Buffer.from(String(args.contentBase64), 'base64')
      : Buffer.from(String(args.csvText), 'utf8');
    const fileName = String(args.fileName);
    const mediaType = fileName.toLowerCase().endsWith('.csv')
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const clientId = await sessionClientId(supabase);
    return withSupabaseCaller(supabase, clientId, { feature: 'feed-intake', activity: 'feed.import', metadata: { fileName } }, () =>
      createImportInstance(fileName, mediaType, bytes, clientId),
    );
  },
};

const getPositionFileImportTool: ToolDefinition = {
  name: 'get_position_file_import',
  description: 'One stored position file: column mappings, transforms, suggestions, as-of date, and process history. instanceId comes from list_position_file_imports or create_position_file_import.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Import instance id' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => getImportInstance(String(args.instanceId), await sessionClientId(supabase)),
};

const updatePositionFileImportTool: ToolDefinition = {
  name: 'update_position_file_import',
  description: 'Save a column mapping and as-of date on a stored position file. Attribute targets must be keys from list_position_file_mapping_targets. Does not load records. Call process_position_file_import to load.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD. Omit to keep the stored date.' },
      columnMappings: { type: 'array', items: columnMappingSchema },
    },
    required: ['instanceId', 'columnMappings'],
  },
  execute: async (args, supabase) => {
    const mappings = args.columnMappings as ColumnAssignment[];
    if (!Array.isArray(mappings)) throw new Error('columnMappings must be a list');
    const asOfDate = args.asOfDate ? String(args.asOfDate) : null;
    return saveImportInstance(String(args.instanceId), mappings, asOfDate, await sessionClientId(supabase));
  },
};

const processPositionFileImportTool: ToolDefinition = {
  name: 'process_position_file_import',
  description: 'Load or reload a stored position file. instanceId comes from list_position_file_imports. The original file stays on the instance, so it does not need to be uploaded again. Parents load before children. Pass columnMappings only to override the stored mapping, and those targets must come from list_position_file_mapping_targets. Omit columnMappings and asOfDate to rerun what is stored.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD. Omit to use the date stored on the instance.' },
      columnMappings: { type: 'array', items: columnMappingSchema },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => processImportInstance(
    String(args.instanceId),
    await sessionClientId(supabase),
    Array.isArray(args.columnMappings) ? args.columnMappings as ColumnAssignment[] : undefined,
    args.asOfDate ? String(args.asOfDate) : undefined
  ),
};

const tableLoadProperties: Record<string, JSONSchema7> = {
  instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
  tableId: { type: 'string', description: 'The table of the file, from get_position_file_tables. Leave out for the selected table.' },
  asOfDate: { type: 'string', description: 'YYYY-MM-DD: the date the values in this table are as of. For an administrator pack, the period end.' },
  sourceCode: { type: 'string', description: 'The source these values are filed under, from the sources get_position_file_tables lists: FUND_ADMIN for an administrator pack, INTERNAL for our own books. Leave out to keep the source the file already has.' },
  columnMappings: { type: 'array', items: columnMappingSchema, description: 'One entry per column that is loaded. A column left out is not loaded.' },
};

const getPositionFileTablesTool: ToolDefinition = {
  name: 'get_position_file_tables',
  description: 'Every table of one stored file (each sheet of a workbook, each table a document reader found), with its columns and its first rows, and the sources a load can be filed under. Use it to see what a pack holds before mapping it. get_position_file_import returns the suggested mapping of the selected table only.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      sampleRows: { type: 'number', description: 'Rows to show from each table. Default 5, at most 20.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => getImportTables(String(args.instanceId), await sessionClientId(supabase), Number(args.sampleRows) || 5),
};

const previewPositionFileLoadTool: ToolDefinition = {
  name: 'preview_position_file_load',
  description: 'Try loading one table of a stored file with a mapping, without writing anything. Matching and value cleanup are the real ones, so the counts are what a load would do now: records created and matched by type, values added and changed, links made, and every row or value that would be refused, with the reason. A mapping that names a column, record type, or attribute that does not exist is refused by name. Run this until the mapping loads cleanly before proposing the load.',
  category: 'import',
  inputSchema: { type: 'object', properties: tableLoadProperties, required: ['instanceId'] },
  execute: async (args, supabase) => previewImportTable(String(args.instanceId), await sessionClientId(supabase), args),
};

const loadPositionFileTableTool: ToolDefinition = {
  name: 'load_position_file_table',
  description: 'Load one table of a stored file: select the table, save its mapping, its as-of date and its source, and load its records. The mapping is saved for the next file with the same columns. Use the mapping that preview_position_file_load showed loading cleanly. One call per table. Loading the same table again updates the records it loaded before.',
  category: 'import',
  inputSchema: { type: 'object', properties: tableLoadProperties, required: ['instanceId', 'columnMappings', 'asOfDate'] },
  execute: async (args, supabase) => loadImportTable(String(args.instanceId), await sessionClientId(supabase), args),
};

export function registerPositionFileTools(registry: ToolRegistry): void {
  registry.registerTool(getPositionFileTablesTool);
  registry.registerTool(previewPositionFileLoadTool);
  registry.registerTool(loadPositionFileTableTool);
  registry.registerTool(listPositionFileImportsTool);
  registry.registerTool(listPositionFileTargetsTool);
  registry.registerTool(createPositionFileImportTool);
  registry.registerTool(getPositionFileImportTool);
  registry.registerTool(updatePositionFileImportTool);
  registry.registerTool(processPositionFileImportTool);
}
