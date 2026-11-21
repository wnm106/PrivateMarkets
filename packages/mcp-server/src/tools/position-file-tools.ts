/**
 * Position file instance queue.
 * Stores the uploaded file, suggests column mappings, and reprocesses the stored rows.
 *
 * The functions these tools call write with the service role, so each tool that
 * writes first asks the database, as the caller, whether they may: requireLoadWrite
 * (entity.write) for anything that stores or changes a file or a staged batch,
 * requireLoadPromote (load.promote) for anything that writes live records:
 * promoting or reverting a batch, and loading a file without staging it. A tool
 * that only reads asks which client the caller is in.
 */

import type { JSONSchema7 } from 'json-schema';
import { withSupabaseCaller } from '../agent/harness';
import { requireLoadPromote, requireLoadWrite, sessionClientId } from '../feeds/session-client';
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
import { userIdOf } from '../agent/harness';
import { indexImportFile, understandImportFile } from '../feeds/import-document';
import {
  discardBatch,
  editStagedValue,
  getBatch,
  listBatches,
  listStagedValues,
  promoteBatch,
  revertBatch,
  stageImportInstance,
} from '../feeds/load-batches';
import { mappingTargets } from '../feeds/suggest';
import type { ColumnAssignment } from '../feeds/suggest';

const columnMappingSchema: JSONSchema7 = {
  type: 'object',
  description: 'One source column. Pass back the object returned by get_position_file_import, with any edits.',
  properties: {
    sourceColumn: { type: 'string' },
    role: { type: 'string', enum: ['ignore', 'filter', 'as_of', 'identity', 'name', 'alias', 'attribute', 'parent'] },
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
    const all = mappingTargets(catalog.attributes, catalog.domains, { domains: catalog.domainAliases, names: catalog.nameAliases });
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
    const clientId = await requireLoadWrite(supabase);
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
    return saveImportInstance(String(args.instanceId), mappings, asOfDate, await requireLoadWrite(supabase));
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
  // Writes live records without a staged review, so it needs what promoting a batch needs.
  execute: async (args, supabase) => processImportInstance(
    String(args.instanceId),
    await requireLoadPromote(supabase),
    Array.isArray(args.columnMappings) ? args.columnMappings as ColumnAssignment[] : undefined,
    args.asOfDate ? String(args.asOfDate) : undefined,
    undefined,
    undefined,
    undefined,
    { actorId: await userIdOf(supabase) },
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
  // Writes live records without a staged review, so it needs what promoting a batch needs.
  execute: async (args, supabase) => loadImportTable(String(args.instanceId), await requireLoadPromote(supabase), args, undefined, { actorId: await userIdOf(supabase) }),
};

const stageImportTool: ToolDefinition = {
  name: 'stage_position_file_import',
  description: 'Stage a stored file: run the load without writing to live records and keep what it would do as a batch. Returns the batch with its counts and its data quality checks, run on each record as it would stand once promoted. Nothing is live until promote_load_batch. Staging a file again replaces its earlier staged batch. If a record in the file matches more than one stored record, nothing is staged and the choices are returned: pass them back as resolutions.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      asOfDate: { type: 'string', description: 'YYYY-MM-DD. Omit to use the date stored on the instance.' },
      columnMappings: { type: 'array', items: columnMappingSchema },
      resolutions: { type: 'array', items: { type: 'object' }, description: 'One decision per ambiguous record: { domainCode, fileCode, action: map | create | ignore, entityId }.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => stageImportInstance(String(args.instanceId), await requireLoadWrite(supabase), {
    columnMappings: Array.isArray(args.columnMappings) ? args.columnMappings as ColumnAssignment[] : undefined,
    asOfDate: args.asOfDate ? String(args.asOfDate) : undefined,
    decisions: Array.isArray(args.resolutions) ? args.resolutions : undefined,
    userId: await userIdOf(supabase),
  }),
};

const listLoadBatchesTool: ToolDefinition = {
  name: 'list_load_batches',
  description: 'Load batches, newest first: staged ones waiting to be promoted, promoted ones that can be reverted, and reverted ones. Pass instanceId for the batches of one stored file.',
  category: 'import',
  inputSchema: { type: 'object', properties: { instanceId: { type: 'string' } } },
  execute: async (args, supabase) => listBatches(await sessionClientId(supabase), args.instanceId ? String(args.instanceId) : null),
};

const getLoadBatchTool: ToolDefinition = {
  name: 'get_load_batch',
  description: 'One load batch: what it would write or wrote, and for a staged batch its data quality checks. Each failing check says whether the batch brings it (NEW) or the record already fails it today (EXISTING), and names the staged value behind it (valueId) when that value can be corrected. blockedBy says why the batch cannot be promoted as it stands.',
  category: 'import',
  inputSchema: { type: 'object', properties: { batchId: { type: 'string' } }, required: ['batchId'] },
  execute: async (args, supabase) => getBatch(String(args.batchId), await sessionClientId(supabase)),
};

const getLoadBatchValuesTool: ToolDefinition = {
  name: 'get_load_batch_values',
  description: 'The values a staged batch would write: the value in the file, the value as it would be stored, the value held today, and any correction. Pass recordId (from get_load_batch) for one record, editedOnly for corrections, changesOnly to leave out values that would not change.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      batchId: { type: 'string' },
      recordId: { type: 'string' },
      editedOnly: { type: 'boolean' },
      changesOnly: { type: 'boolean' },
      limit: { type: 'number', description: 'Default 200, at most 1000.' },
    },
    required: ['batchId'],
  },
  execute: async (args, supabase) => listStagedValues(String(args.batchId), await sessionClientId(supabase), {
    recordId: args.recordId ? String(args.recordId) : undefined,
    editedOnly: args.editedOnly === true,
    changesOnly: args.changesOnly === true,
    limit: Number(args.limit) || undefined,
  }),
};

const editStagedValueTool: ToolDefinition = {
  name: 'edit_staged_value',
  description: 'Correct one value of a staged batch before it is promoted. The value must fit the type of its attribute. Live records are not changed. Returns the batch with its checks run again. A blank value takes the correction back.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      batchId: { type: 'string' },
      valueId: { type: 'string', description: 'From a failing check in get_load_batch, or from get_load_batch_values.' },
      value: { type: 'string' },
      reason: { type: 'string', description: 'Why the value in the file is wrong.' },
    },
    required: ['batchId', 'valueId', 'value'],
  },
  execute: async (args, supabase) => editStagedValue(String(args.batchId), String(args.valueId), await requireLoadWrite(supabase), {
    value: String(args.value ?? ''),
    reason: args.reason ? String(args.reason) : null,
    userId: await userIdOf(supabase),
  }),
};

const promoteLoadBatchTool: ToolDefinition = {
  name: 'promote_load_batch',
  description: 'Write a staged batch to live records, with its corrections. Refused while a critical check fails because of the batch, unless overrideReason says why it should go ahead. Returns the batch, with any difference between what was staged and what was written.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      batchId: { type: 'string' },
      overrideReason: { type: 'string', description: 'Only to promote despite a critical failing check.' },
    },
    required: ['batchId'],
  },
  execute: async (args, supabase) => {
    // Promoting changes live records, so the caller must hold load.promote in the client.
    const clientId = await requireLoadPromote(supabase);
    return promoteBatch(String(args.batchId), clientId, {
      userId: await userIdOf(supabase),
      overrideReason: args.overrideReason ? String(args.overrideReason) : null,
    });
  },
};

const revertLoadBatchTool: ToolDefinition = {
  name: 'revert_load_batch',
  description: 'Take back what a promoted batch wrote, where it still stands: values it added are retired, rows it changed are put back, links it added are removed, and records it created are made inactive when nothing else has been added to them. Whatever has changed since is left alone and counted in the result.',
  category: 'import',
  inputSchema: { type: 'object', properties: { batchId: { type: 'string' } }, required: ['batchId'] },
  execute: async (args, supabase) => {
    const clientId = await requireLoadPromote(supabase);
    return revertBatch(String(args.batchId), clientId, await userIdOf(supabase));
  },
};

const discardLoadBatchTool: ToolDefinition = {
  name: 'discard_load_batch',
  description: 'Drop a staged batch. Nothing live was changed, so there is nothing to undo.',
  category: 'import',
  inputSchema: { type: 'object', properties: { batchId: { type: 'string' } }, required: ['batchId'] },
  execute: async (args, supabase) => discardBatch(String(args.batchId), await requireLoadWrite(supabase)),
};

const indexImportTool: ToolDefinition = {
  name: 'index_position_file_import',
  description: 'Keep a stored file as a searchable document: the file itself when its text can be read, otherwise a text rendering of the tables read from it. The document is paired with the file. Does not load records. A file that cannot be indexed is reported with the reason and does not fail the step. Calling it again returns the document already made.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      typeCode: { type: 'string', description: 'The document type to file it under. Leave out to use the kind the file was read as.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => indexImportFile(String(args.instanceId), await requireLoadWrite(supabase), { typeCode: args.typeCode ? String(args.typeCode) : null }),
};

const understandImportTool: ToolDefinition = {
  name: 'get_position_file_understanding',
  description: 'What a stored file is and what was found in it: the kind of file, how it was read, each table with its first rows, the types of record it holds, the one record it is about when it is about one (such as a borrower\'s statement) with the stored records that could be, and the searchable document it was indexed as. Reads only.',
  category: 'import',
  inputSchema: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] },
  execute: async (args, supabase) => understandImportFile(String(args.instanceId), await sessionClientId(supabase)),
};

export function registerPositionFileTools(registry: ToolRegistry): void {
  registry.registerTool(indexImportTool);
  registry.registerTool(understandImportTool);
  registry.registerTool(stageImportTool);
  registry.registerTool(listLoadBatchesTool);
  registry.registerTool(getLoadBatchTool);
  registry.registerTool(getLoadBatchValuesTool);
  registry.registerTool(editStagedValueTool);
  registry.registerTool(promoteLoadBatchTool);
  registry.registerTool(revertLoadBatchTool);
  registry.registerTool(discardLoadBatchTool);
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
