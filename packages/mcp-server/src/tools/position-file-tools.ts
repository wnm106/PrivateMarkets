/**
 * Position file instance queue.
 * Stores the uploaded file, suggests column mappings, and reprocesses the stored rows.
 */

import type { JSONSchema7 } from 'json-schema';
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
  description: 'List position-file import instances for the POSITION_FILE source. Each instance keeps the original file, the time it was received, its status, and every process result. Use process_position_file_import to load or reload one.',
  category: 'import',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => {
    const instances = await listImportInstances(supabase);
    return { sourceCode: 'POSITION_FILE', instances };
  },
};

const listPositionFileTargetsTool: ToolDefinition = {
  name: 'list_position_file_mapping_targets',
  description: 'List every entity attribute a position-file column can map to, including entity code, entity name, parent links, as-of date, and row filter. Use the key when changing a column mapping.',
  category: 'import',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => {
    const catalog = await listMappingCatalog(supabase);
    return { targets: mappingTargets(catalog.attributes, catalog.domains) };
  },
};

const createPositionFileImportTool: ToolDefinition = {
  name: 'create_position_file_import',
  description: 'Store a CSV or Excel position file as an import instance. The original bytes are kept. Returns a suggested mapping for every source column. Does not load entities until process_position_file_import is called.',
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
    return createImportInstance(fileName, mediaType, bytes, supabase);
  },
};

const getPositionFileImportTool: ToolDefinition = {
  name: 'get_position_file_import',
  description: 'Get one position-file import instance, including its column mappings, transforms, suggestions, as-of date, and process history. The original file stays stored on the instance.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Import instance id' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => getImportInstance(String(args.instanceId), supabase),
};

const updatePositionFileImportTool: ToolDefinition = {
  name: 'update_position_file_import',
  description: 'Save a new column mapping and as-of date on a position-file instance. Does not load entities. Change any column role, domain, attribute, or transform, then call process_position_file_import.',
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
    return saveImportInstance(String(args.instanceId), mappings, asOfDate, supabase);
  },
};

const processPositionFileImportTool: ToolDefinition = {
  name: 'process_position_file_import',
  description: 'Load or reload a stored position-file instance. Uses the stored file, so the upload is not required again. Parents load before children. Pass columnMappings and asOfDate to override the stored mapping for this run. Omit both to reprocess the stored mapping and date.',
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
    Array.isArray(args.columnMappings) ? args.columnMappings as ColumnAssignment[] : undefined,
    args.asOfDate ? String(args.asOfDate) : undefined,
    supabase
  ),
};

export function registerPositionFileTools(registry: ToolRegistry): void {
  registry.registerTool(listPositionFileImportsTool);
  registry.registerTool(listPositionFileTargetsTool);
  registry.registerTool(createPositionFileImportTool);
  registry.registerTool(getPositionFileImportTool);
  registry.registerTool(updatePositionFileImportTool);
  registry.registerTool(processPositionFileImportTool);
}
