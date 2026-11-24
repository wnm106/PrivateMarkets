import type { SupabaseClient } from '@supabase/supabase-js';
import { ambiguousCodeMessage } from '@tapestrai/graphql/src/lib/entity-code';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * The identifier crosswalk: a Tapestry record's id in each other system.
 *
 * The ids are keyed by source (source_registry), the same sources the
 * golden-source waterfall and lineage name. Each row says which of the
 * client's MCP servers reach that system (`servers`), so the assistant can
 * pass the right id to the right server.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, any>;

/** Accepts record ids or readable entity codes and returns record ids. */
async function resolveEntityIds(supabase: SupabaseClient, refs: unknown): Promise<string[]> {
  const list = (Array.isArray(refs) ? refs : [refs]).map((r) => String(r ?? '').trim()).filter(Boolean).slice(0, 100);
  const ids = list.filter((r) => UUID.test(r));
  const codes = list.filter((r) => !UUID.test(r));
  if (codes.length) {
    const { data, error } = await supabase
      .schema('entity_instances')
      .from('master_entities')
      .select('id, entity_code')
      .in('entity_code', codes);
    if (error) throw error;
    // A code is unique within a client only. A caller in two clients may see it twice; say so rather than mix them.
    const seen = new Set<string>();
    for (const row of (data || []) as Row[]) {
      if (seen.has(row.entity_code)) throw new Error(ambiguousCodeMessage(row.entity_code));
      seen.add(row.entity_code);
      ids.push(row.id);
    }
  }
  return [...new Set(ids)];
}

function knowledge(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asOf(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function view(row: Row) {
  return {
    entityId: row.entity_id,
    entityCode: row.entity_code,
    entityName: row.entity_name,
    domain: row.domain_code,
    source: row.source_code,
    sourceName: row.source_name,
    externalId: row.external_id,
    validFrom: row.valid_from,
    origin: row.origin,
    note: row.note || undefined,
    servers: Array.isArray(row.servers) ? row.servers : [],
  };
}

const getExternalIds: ToolDefinition = {
  name: 'get_external_ids',
  description:
    'The ids Tapestry records hold in other systems (CRM, fund administrator, portfolio monitoring and so on), with the source code of each system and the outside servers (ext__<server>__ tools) that reach it. Call this before asking an outside system about a record, and pass that system its own id. Accepts record ids or entity codes.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      entityIds: { type: 'array', items: { type: 'string' }, description: 'Record ids or entity codes, up to 100' },
      asOfDate: { type: 'string', description: 'Point-in-time date (YYYY-MM-DD)' },
      knowledgeDate: { type: 'string', description: 'What was known at this time (ISO timestamp)' },
    },
    required: ['entityIds'],
  },
  execute: async (args, supabase) => {
    const ids = await resolveEntityIds(supabase, args.entityIds);
    if (!ids.length) return { records: [], note: 'No matching records were found.' };
    const { data, error } = await supabase.rpc('entity_external_ids_for', {
      p_entity_ids: ids,
      p_as_of: asOf(args.asOfDate),
      p_knowledge: knowledge(args.knowledgeDate),
    });
    if (error) throw error;
    const rows = ((data as Row[] | null) || []).map(view);
    const byRecord = new Map<string, { entityId: string; entityCode: string; entityName: string; ids: Array<Record<string, unknown>> }>();
    for (const row of rows) {
      const entry = byRecord.get(row.entityId) || { entityId: row.entityId, entityCode: row.entityCode, entityName: row.entityName, ids: [] as Array<Record<string, unknown>> };
      entry.ids.push({ source: row.source, sourceName: row.sourceName, externalId: row.externalId, servers: row.servers, origin: row.origin });
      byRecord.set(row.entityId, entry);
    }
    const missing = ids.filter((id) => !byRecord.has(id));
    return {
      records: [...byRecord.values()],
      ...(missing.length ? { recordsWithNoOutsideIds: missing } : {}),
    };
  },
};

const findEntityByExternalId: ToolDefinition = {
  name: 'find_entity_by_external_id',
  description:
    'Finds the Tapestry record that holds a given id in another system. source is the Tapestry source code of that system (as get_external_ids or the outside system section lists it).',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Source code of the other system, for example DEALCLOUD' },
      externalId: { type: 'string', description: 'The id in that system' },
      asOfDate: { type: 'string', description: 'Point-in-time date (YYYY-MM-DD)' },
      knowledgeDate: { type: 'string', description: 'What was known at this time (ISO timestamp)' },
    },
    required: ['source', 'externalId'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase.rpc('entity_external_id_find', {
      p_source_code: String(args.source || ''),
      p_external_id: String(args.externalId || ''),
      p_as_of: asOf(args.asOfDate),
      p_knowledge: knowledge(args.knowledgeDate),
    });
    if (error) throw error;
    const rows = ((data as Row[] | null) || []).map(view);
    return rows.length ? { matches: rows } : { matches: [], note: 'No Tapestry record holds that id. Search Tapestry by name instead.' };
  },
};

const saveExternalId: ToolDefinition = {
  name: 'save_external_id',
  description:
    'Remembers a record\'s id in another system, so later questions can ask that system by id. Call it only after the user has confirmed the match in this conversation, and set confirmedByUser to true. A different id already stored for the same record and system is retired, not deleted.',
  category: 'external',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Tapestry record id or entity code' },
      source: { type: 'string', description: 'Source code of the other system' },
      externalId: { type: 'string', description: 'The id in that system' },
      note: { type: 'string', description: 'How the match was made, for example "matched on name and LEI, confirmed by user"' },
      confirmedByUser: { type: 'boolean', description: 'True only when the user has confirmed this match' },
    },
    required: ['entityId', 'source', 'externalId', 'confirmedByUser'],
  },
  execute: async (args, supabase) => {
    if (args.confirmedByUser !== true) {
      throw new Error('Show the user the match and ask them to confirm it before saving');
    }
    const [entityId] = await resolveEntityIds(supabase, [args.entityId]);
    if (!entityId) throw new Error('Record was not found');
    const { data, error } = await supabase.rpc('entity_external_id_save', {
      p_entity_id: entityId,
      p_source_code: String(args.source || ''),
      p_external_id: String(args.externalId || ''),
      p_valid_from: null,
      p_origin: 'ASSISTANT',
      p_note: typeof args.note === 'string' ? args.note : null,
    });
    if (error) throw error;
    return { saved: view(data as Row) };
  },
};

export function registerExternalIdTools(registry: ToolRegistry): void {
  registry.registerTool(getExternalIds);
  registry.registerTool(findEntityByExternalId);
  registry.registerTool(saveExternalId);
}
