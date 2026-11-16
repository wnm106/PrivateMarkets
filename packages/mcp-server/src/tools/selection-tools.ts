import { describeFilters, hasFilters, parseFilters } from '@tapestrai/graphql/src/lib/workflow-filters';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * Choosing the records a workflow run works on.
 *
 * A workflow does not name its records. A run is started with filters, and
 * this turns them into the list the later steps use. With no filters it
 * returns no list at all, which the later steps read as "no restriction".
 */

type Row = { id: string; entity_code: string; entity_name: string; domain_code: string };

const findRecords: ToolDefinition = {
  name: 'find_records',
  description:
    'The records a workflow run works on, chosen by the filters the run was started with: record type, codes, ids, or part of a name. Every filter given must hold. Returns each record\'s id, code, name, and type, and lists any code or id that matched nothing. With no filter it returns filtered: false and no list, meaning the run is not restricted to particular records. Only active records are returned.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Only records of this type, for example FUND or POSITION.' },
      entityCodes: { type: 'array', items: { type: 'string' }, description: 'Only records with these codes.' },
      entityIds: { type: 'array', items: { type: 'string' }, description: 'Only records with these ids.' },
      nameContains: { type: 'string', description: 'Only records whose name contains this text, in any case.' },
      limit: { type: 'number', description: 'The most records to return. Default 100, at most 500.' },
    },
  },
  execute: async (args, supabase) => {
    const filters = parseFilters(args);
    if (!hasFilters(filters)) {
      return { filtered: false, selection: 'every record', note: 'No filters were given, so this run is not restricted to particular records.' };
    }
    let query = supabase.from('master_entities').select('id, entity_code, entity_name, domain_code', { count: 'exact' }).eq('is_active', true);
    if (filters.domainCode) query = query.eq('domain_code', filters.domainCode);
    if (filters.entityCodes.length > 0) query = query.in('entity_code', filters.entityCodes);
    if (filters.entityIds.length > 0) query = query.in('id', filters.entityIds);
    if (filters.nameContains) query = query.ilike('entity_name', `%${filters.nameContains.replace(/[%_\\]/g, '\\$&')}%`);
    const { data, error, count } = await query.order('entity_code').limit(filters.limit);
    if (error) throw new Error(error.message);

    const rows = (data || []) as Row[];
    const codes = new Set(rows.map((row) => row.entity_code));
    const ids = new Set(rows.map((row) => row.id));
    const total = count ?? rows.length;
    // A code that matched nothing is only reported when the whole match was read.
    const complete = total <= rows.length;
    const notFound = complete ? [...filters.entityCodes.filter((code) => !codes.has(code)), ...filters.entityIds.filter((id) => !ids.has(id))] : [];
    return {
      filtered: true,
      selection: describeFilters(filters),
      count: rows.length,
      totalCount: total,
      ...(complete ? {} : { notShown: total - rows.length, note: `The filters match ${total} records. This run works on the first ${rows.length}. Narrow the filters or raise the limit.` }),
      ...(notFound.length > 0 ? { notFound } : {}),
      entityIds: rows.map((row) => row.id),
      entityCodes: rows.map((row) => row.entity_code),
      records: rows.map((row) => ({ entityId: row.id, entityCode: row.entity_code, entityName: row.entity_name, domainCode: row.domain_code })),
    };
  },
};

export function registerSelectionTools(registry: ToolRegistry) {
  registry.registerTool(findRecords);
}
