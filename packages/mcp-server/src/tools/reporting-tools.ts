import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';
import {
  runDataQueries,
  validateDataQueries,
  summarizeResultsForLLM,
  DATA_QUERY_SPEC_DOC,
} from '@tapestrai/graphql/src/lib/data-query-engine';

const getDataQuerySpecDoc: ToolDefinition = {
  name: 'get_data_query_spec',
  description:
    'Returns the full documentation of the declarative data-query format used by dashboards and narratives (start, path traversal, filters bound to user inputs, group-by, metrics). Read this before authoring or fixing data queries.',
  category: 'reporting',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ spec: DATA_QUERY_SPEC_DOC }),
};

const previewDataQueries: ToolDefinition = {
  name: 'preview_data_queries',
  description:
    'Validate and execute draft data queries so you can SEE the real data they return before proposing them to the user. Provide an entityId or entityCode as the context entity (required for any query with start=CONTEXT). Returns per-query columns, a sample of rows, and any errors. Always preview queries you author; fix errors and empty results before presenting the draft.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: {
      queries: { type: 'string', description: 'JSON string: an array of data query specs' },
      entityId: { type: 'string', description: 'Context entity id (the entity being viewed)' },
      entityCode: { type: 'string', description: 'Context entity code (alternative to entityId)' },
      params: { type: 'string', description: 'Optional JSON string: values for user filter inputs, keyed by parameter name' },
      maxRows: { type: 'number', description: 'Max sample rows per query (default 10)' },
    },
    required: ['queries'],
  },
  execute: async (args, supabase) => {
    let queries: any;
    let params: any = {};
    try {
      queries = typeof args.queries === 'string' ? JSON.parse(args.queries) : args.queries;
      if (args.params) params = typeof args.params === 'string' ? JSON.parse(args.params) : args.params;
    } catch (e: any) {
      return { valid: false, validationErrors: [`Could not parse JSON: ${e.message}`] };
    }
    const problems = validateDataQueries(queries);
    if (problems.length > 0) return { valid: false, validationErrors: problems };
    const response = await runDataQueries(supabase, queries, {
      entityId: args.entityId,
      entityCode: args.entityCode,
      params,
    });
    return { valid: true, ...summarizeResultsForLLM(response, Math.min(args.maxRows || 10, 50)) };
  },
};

const findSampleEntities: ToolDefinition = {
  name: 'find_sample_entities',
  description:
    'Find example entities of a domain that have the most relationships, so draft queries can be previewed against meaningful data. Returns entity ids/codes/names and relationship counts.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Entity type (e.g. FUND)' },
      limit: { type: 'number', description: 'How many to return (default 5)' },
    },
    required: ['domainCode'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('entity_master')
      .select('entity_id, entity_code, entity_name, parent_relationships, child_relationships')
      .eq('domain_code', args.domainCode)
      .limit(200);
    if (error) throw error;
    const ranked = (data || [])
      .map((r: any) => ({
        entityId: r.entity_id,
        entityCode: r.entity_code,
        entityName: r.entity_name,
        parentCount: (r.parent_relationships || []).length,
        childCount: (r.child_relationships || []).length,
      }))
      .sort((a: any, b: any) => b.parentCount + b.childCount - (a.parentCount + a.childCount))
      .slice(0, args.limit || 5);
    return { entities: ranked };
  },
};

const listReportTemplates: ToolDefinition = {
  name: 'list_report_templates',
  description: 'List existing dashboards and narratives (code, name, entity type) so you can reuse or extend them instead of duplicating.',
  category: 'reporting',
  inputSchema: {
    type: 'object',
    properties: { domainCode: { type: 'string', description: 'Filter by entity type' } },
  },
  execute: async (args, supabase) => {
    let d = supabase.from('dashboard_templates').select('dashboard_code, dashboard_name, domain_code, description');
    let n = supabase.from('narrative_templates').select('narrative_code, narrative_name, domain_code, description');
    if (args.domainCode) {
      d = d.eq('domain_code', args.domainCode);
      n = n.eq('domain_code', args.domainCode);
    }
    const [dr, nr] = await Promise.all([d, n]);
    if (dr.error) throw dr.error;
    if (nr.error) throw nr.error;
    return { dashboards: dr.data || [], narratives: nr.data || [] };
  },
};

export function registerReportingTools(registry: ToolRegistry): void {
  registry.registerTool(getDataQuerySpecDoc);
  registry.registerTool(previewDataQueries);
  registry.registerTool(findSampleEntities);
  registry.registerTool(listReportTemplates);
}
