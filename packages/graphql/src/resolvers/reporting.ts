import { populationRows } from '../lib/condition-rows';
import { Context } from '../context';
import {
  runDataQueries, validateDataQueries, runGrid, bindFilters, resolveEntityId, GridRequest,
} from '../lib/data-query-engine';
import { validateNarrative } from '../lib/narrative-engine';
import { knowledgeInstant } from '../lib/temporal-attributes';

const err = (field: string, message: string, code = 'DATABASE_ERROR') => ({ field, message, code });

function mapDashboard(r: any) {
  return {
    id: r.id,
    dashboardCode: r.dashboard_code,
    dashboardName: r.dashboard_name,
    description: r.description,
    domainCode: r.domain_code,
    htmlTemplate: r.html_template ?? '',
    dataQueries: r.data_queries ?? [],
    parameters: r.parameters ?? [],
    isActive: r.is_active,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapNarrative(r: any) {
  return {
    id: r.id,
    narrativeCode: r.narrative_code,
    narrativeName: r.narrative_name,
    description: r.description,
    domainCode: r.domain_code,
    instructions: r.instructions ?? '',
    dataQueries: r.data_queries ?? [],
    parameters: r.parameters ?? [],
    outputBlocks: r.output_blocks ?? [],
    sections: r.sections ?? [],
    persona: r.persona,
    audience: r.audience,
    rules: r.rules ?? [],
    exposedDomains: r.exposed_domains ?? [],
    allowExternalSearch: !!r.allow_external_search,
    model: r.model,
    isActive: r.is_active,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapRun(r: any) {
  return {
    id: r.id,
    narrativeId: r.narrative_id,
    entityId: r.entity_id,
    parameters: r.parameters ?? {},
    blocks: r.blocks ?? [],
    status: r.status,
    errorMessage: r.error_message,
    model: r.model,
    createdAt: r.created_at,
    createdBy: r.created_by,
    asOfDate: r.as_of_date,
    sources: r.sources ?? [],
    verification: r.verification ?? {},
    plan: r.plan ?? [],
    origin: r.origin ?? 'APP',
    createdByLabel: r.created_by_label ?? null,
    publishedAt: r.published_at ?? null,
    publishedBy: r.published_by ?? null,
    publishedByLabel: r.published_by_label ?? null,
    publishedLabel: r.published_label ?? null,
  };
}

function mapRunSection(r: any) {
  return {
    id: r.id,
    runId: r.run_id,
    sectionKey: r.section_key,
    ord: r.ord,
    title: r.title,
    status: r.status,
    blocks: r.blocks ?? [],
    research: r.research ?? {},
    verification: r.verification ?? {},
    notes: r.notes ?? [],
    errorMessage: r.error_message,
    model: r.model,
    updatedAt: r.updated_at,
  };
}

/** Maps a camelCase input object to a snake_case row, only for keys that were provided. */
function toRow(input: Record<string, any>, map: Record<string, string>) {
  const row: Record<string, any> = {};
  for (const [k, col] of Object.entries(map)) {
    if (input[k] !== undefined) row[col] = input[k];
  }
  return row;
}

const DASHBOARD_COLUMNS = {
  dashboardCode: 'dashboard_code',
  dashboardName: 'dashboard_name',
  description: 'description',
  domainCode: 'domain_code',
  htmlTemplate: 'html_template',
  dataQueries: 'data_queries',
  parameters: 'parameters',
  isActive: 'is_active',
  metadata: 'metadata',
};

const NARRATIVE_COLUMNS = {
  narrativeCode: 'narrative_code',
  narrativeName: 'narrative_name',
  description: 'description',
  domainCode: 'domain_code',
  instructions: 'instructions',
  dataQueries: 'data_queries',
  parameters: 'parameters',
  outputBlocks: 'output_blocks',
  sections: 'sections',
  persona: 'persona',
  audience: 'audience',
  rules: 'rules',
  exposedDomains: 'exposed_domains',
  allowExternalSearch: 'allow_external_search',
  model: 'model',
  isActive: 'is_active',
  metadata: 'metadata',
};

function validationErrors(input: any): Array<ReturnType<typeof err>> {
  const errors: Array<ReturnType<typeof err>> = [];
  if (input.dataQueries !== undefined) {
    errors.push(...validateDataQueries(input.dataQueries).map((m) => err('dataQueries', m, 'VALIDATION_ERROR')));
  }
  if (Array.isArray(input.sections) && input.sections.length) {
    errors.push(...validateNarrative({ ...input, sections: input.sections }).map((m) => err('sections', m, 'VALIDATION_ERROR')));
  }
  return errors;
}

export const reportingResolvers = {
  NarrativeRun: {
    sections: async (run: { id: string }, _args: unknown, { supabase }: Context) => {
      const { data, error } = await supabase
        .from('narrative_run_sections')
        .select('*')
        .eq('run_id', run.id)
        .order('ord', { ascending: true });
      if (error) throw new Error(`Failed to fetch run sections: ${error.message}`);
      return (data || []).map(mapRunSection);
    },
  },

  Query: {
    dashboards: async (_: any, args: { domainCode?: string; isActive?: boolean }, { supabase }: Context) => {
      let q = supabase.from('dashboard_templates').select('*').order('dashboard_name');
      if (args.domainCode) q = q.eq('domain_code', args.domainCode);
      if (args.isActive !== undefined) q = q.eq('is_active', args.isActive);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch dashboards: ${error.message}`);
      return (data || []).map(mapDashboard);
    },

    dashboard: async (_: any, args: { id?: string; dashboardCode?: string }, { supabase }: Context) => {
      let q = supabase.from('dashboard_templates').select('*').limit(1);
      if (args.id) q = q.eq('id', args.id);
      else if (args.dashboardCode) q = q.eq('dashboard_code', args.dashboardCode);
      else return null;
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`Failed to fetch dashboard: ${error.message}`);
      return data ? mapDashboard(data) : null;
    },

    narratives: async (_: any, args: { domainCode?: string; isActive?: boolean }, { supabase }: Context) => {
      let q = supabase.from('narrative_templates').select('*').order('narrative_name');
      if (args.domainCode) {
        // Offered on its own entity type and on every type it is exposed to.
        const code = args.domainCode.replace(/[^A-Za-z0-9_]/g, '');
        q = q.or(`domain_code.eq.${code},exposed_domains.cs.{${code}}`);
      }
      if (args.isActive !== undefined) q = q.eq('is_active', args.isActive);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch narratives: ${error.message}`);
      return (data || []).map(mapNarrative);
    },

    narrative: async (_: any, args: { id?: string; narrativeCode?: string }, { supabase }: Context) => {
      let q = supabase.from('narrative_templates').select('*').limit(1);
      if (args.id) q = q.eq('id', args.id);
      else if (args.narrativeCode) q = q.eq('narrative_code', args.narrativeCode);
      else return null;
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`Failed to fetch narrative: ${error.message}`);
      return data ? mapNarrative(data) : null;
    },

    narrativeRuns: async (_: any, args: { narrativeId: string; entityId?: string; first?: number; statuses?: string[] }, { supabase }: Context) => {
      // Runs that stopped reporting progress are closed so they are never offered as the latest report.
      // Best effort: a failure here must not hide the runs.
      await Promise.resolve(supabase.rpc('close_stale_narrative_runs', { p_minutes: 30 })).catch(() => undefined);
      let q = supabase
        .from('narrative_runs')
        .select('*')
        .eq('narrative_id', args.narrativeId)
        .order('created_at', { ascending: false })
        .limit(Math.min(args.first ?? 10, 50));
      if (args.entityId) q = q.eq('entity_id', args.entityId);
      if (args.statuses?.length) q = q.in('status', args.statuses);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch narrative runs: ${error.message}`);
      return (data || []).map(mapRun);
    },

    narrativeRun: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.from('narrative_runs').select('*').eq('id', args.id).maybeSingle();
      if (error) throw new Error(`Failed to fetch narrative run: ${error.message}`);
      return data ? mapRun(data) : null;
    },

    runDataQueries: async (
      _: any,
      args: {
        queries: any; entityId?: string; entityCode?: string; params?: Record<string, any>;
        asOfDate?: string; knowledgeDate?: string;
      },
      { supabase }: Context
    ) => {
      const validation = validateDataQueries(args.queries);
      if (validation.length > 0) {
        return { anchor: null, results: {}, warnings: [], validationErrors: validation };
      }
      const response = await runDataQueries(supabase, args.queries, {
        entityId: args.entityId,
        entityCode: args.entityCode,
        params: args.params || {},
        asOfDate: args.asOfDate,
        knowledgeDate: args.knowledgeDate,
      });
      return { ...response, validationErrors: [] };
    },

    gridQuery: async (_: any, args: { input: any }, { supabase }: Context) => {
      const i = args.input || {};
      if (i.start !== 'CONTEXT' && i.start !== 'DOMAIN') throw new Error('start must be CONTEXT or DOMAIN');
      let contextEntityId: string | null = null;
      if (i.start === 'CONTEXT') {
        contextEntityId = await resolveEntityId(supabase, i.entityId, i.entityCode);
        if (!contextEntityId) throw new Error('The context entity could not be found or is not accessible.');
      }
      const params = { ...(i.params || {}) };
      const asOf = i.asOfDate || params.asOfDate || null;
      const req: GridRequest = {
        start: i.start,
        domainCode: i.domainCode || null,
        contextEntityId,
        path: Array.isArray(i.path) ? i.path : [],
        includeAnchor: !!i.includeAnchor,
        lookups: Array.isArray(i.lookups) ? i.lookups : [],
        asOfDate: asOf ? String(asOf).slice(0, 10) : null,
        knowledgeDate: i.knowledgeDate ? knowledgeInstant(i.knowledgeDate) : null,
        // filters may carry "param" bindings (dashboard filter inputs) or literal values
        filters: bindFilters(Array.isArray(i.filters) ? i.filters : [], params),
        populationConditions: Array.isArray(i.populationConditions) ? populationRows(i.populationConditions) : [],
        columns: i.columns || [],
        sort: Array.isArray(i.sort) ? i.sort : [],
        groupBy: i.groupBy || [],
        groupKeys: Array.isArray(i.groupKeys) ? i.groupKeys : [],
        metrics: Array.isArray(i.metrics) ? i.metrics : [],
        flat: !!i.flat,
        offset: Math.max(0, i.offset ?? 0),
        limit: i.limit ?? 50,
        export: !!i.export,
      };
      return runGrid(supabase, req);
    },
  },

  Mutation: {
    createDashboard: async (_: any, args: { input: any }, { supabase, user }: Context) => {
      const errors = validationErrors(args.input);
      if (errors.length) return { dashboard: null, errors };
      const row = toRow(args.input, DASHBOARD_COLUMNS);
      if (user?.id) row.created_by = user.id;
      const { data, error } = await supabase.from('dashboard_templates').insert(row).select().single();
      if (error) return { dashboard: null, errors: [err('general', error.message)] };
      return { dashboard: mapDashboard(data), errors: [] };
    },

    updateDashboard: async (_: any, args: { id: string; input: any }, { supabase }: Context) => {
      const errors = validationErrors(args.input);
      if (errors.length) return { dashboard: null, errors };
      const row = { ...toRow(args.input, DASHBOARD_COLUMNS), updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from('dashboard_templates').update(row).eq('id', args.id).select().single();
      if (error) return { dashboard: null, errors: [err('general', error.message)] };
      return { dashboard: mapDashboard(data), errors: [] };
    },

    deleteDashboard: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { error } = await supabase.from('dashboard_templates').delete().eq('id', args.id);
      if (error) return { success: false, errors: [err('general', error.message)] };
      return { success: true, errors: [] };
    },

    createNarrative: async (_: any, args: { input: any }, { supabase, user }: Context) => {
      const errors = validationErrors(args.input);
      if (errors.length) return { narrative: null, errors };
      const row = toRow(args.input, NARRATIVE_COLUMNS);
      if (user?.id) row.created_by = user.id;
      const { data, error } = await supabase.from('narrative_templates').insert(row).select().single();
      if (error) return { narrative: null, errors: [err('general', error.message)] };
      return { narrative: mapNarrative(data), errors: [] };
    },

    updateNarrative: async (_: any, args: { id: string; input: any }, { supabase }: Context) => {
      const errors = validationErrors(args.input);
      if (errors.length) return { narrative: null, errors };
      const row = { ...toRow(args.input, NARRATIVE_COLUMNS), updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from('narrative_templates').update(row).eq('id', args.id).select().single();
      if (error) return { narrative: null, errors: [err('general', error.message)] };
      return { narrative: mapNarrative(data), errors: [] };
    },

    publishNarrativeRun: async (_: any, args: { id: string; label?: string }, { supabase }: Context) => {
      const { data, error } = await supabase.rpc('publish_narrative_run', { p_run_id: args.id, p_label: args.label ?? null });
      if (error) throw new Error(error.message);
      return mapRun(data);
    },

    unpublishNarrativeRun: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.rpc('unpublish_narrative_run', { p_run_id: args.id });
      if (error) throw new Error(error.message);
      return mapRun(data);
    },

    deleteNarrative: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { error } = await supabase.from('narrative_templates').delete().eq('id', args.id);
      if (error) return { success: false, errors: [err('general', error.message)] };
      return { success: true, errors: [] };
    },
  },
};
