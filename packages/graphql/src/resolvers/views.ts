import { Context } from '../context';
import { normalizeEntityView } from '../lib/entity-views';
import { normalizePopulationFilter } from '../lib/population-filters';
import { resolveEntityClientId } from './schema-scope';

const err = (field: string, message: string, code = 'DATABASE_ERROR') => ({ field, message, code });

function mapView(r: any) {
  return {
    id: r.id,
    clientId: r.client_id,
    domainCode: r.domain_code,
    viewName: r.view_name,
    description: r.description,
    columns: r.columns ?? [],
    lookups: r.lookups ?? [],
    sort: r.sort ?? [],
    filterId: r.filter_id ?? null,
    displayOrder: r.display_order ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRow(value: ReturnType<typeof normalizeEntityView>['value']) {
  return {
    domain_code: value.domainCode,
    view_name: value.viewName,
    description: value.description ?? null,
    columns: value.columns,
    lookups: value.lookups,
    sort: value.sort,
    filter_id: value.filterId ?? null,
    ...(value.displayOrder != null ? { display_order: value.displayOrder } : {}),
  };
}

function mapFilter(r: any) {
  return {
    id: r.id,
    clientId: r.client_id,
    domainCode: r.domain_code,
    filterName: r.filter_name,
    populationCode: r.population_code,
    certifiedAt: r.certified_at,
    certifiedBy: r.certified_by,
    certificationNote: r.certification_note,
    description: r.description,
    conditions: r.conditions ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function friendly(message: string): string {
  if (/uq_population_filters_code/i.test(message)) return 'Another population already uses this code.';
  if (/population_filters_certified_complete/i.test(message)) return 'A certified population needs a code and a description.';
  if (/uq_population_filters_name/i.test(message)) return 'A filter with this name already exists for this entity type.';
  if (/entity_views_filter_id_fkey/i.test(message)) return 'That filter no longer exists.';
  return /uq_entity_views_name|duplicate key/i.test(message)
    ? 'A view with this name already exists for this entity type.'
    : message;
}

/** Views are read and written as the caller, so row security keeps each client to its own. */
export const viewResolvers = {
  Query: {
    entityViews: async (_: any, args: { domainCode: string }, { supabase }: Context) => {
      const { data, error } = await supabase
        .from('entity_views')
        .select('*')
        .eq('domain_code', args.domainCode)
        .order('display_order', { ascending: true })
        .order('view_name', { ascending: true });
      if (error) throw new Error(`Failed to fetch views: ${error.message}`);
      return (data || []).map(mapView);
    },

    populationFilters: async (_: any, args: { domainCode: string }, { supabase }: Context) => {
      const { data, error } = await supabase
        .from('population_filters')
        .select('*')
        .eq('domain_code', args.domainCode)
        .order('filter_name', { ascending: true });
      if (error) throw new Error(`Failed to fetch filters: ${error.message}`);
      return (data || []).map(mapFilter);
    },

    entityView: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.from('entity_views').select('*').eq('id', args.id).maybeSingle();
      if (error) throw new Error(`Failed to fetch view: ${error.message}`);
      return data ? mapView(data) : null;
    },
  },

  Mutation: {
    saveEntityView: async (_: any, args: { id?: string | null; input: any }, context: Context) => {
      const { value, errors } = normalizeEntityView(args.input);
      if (errors.length) return { view: null, errors };
      const row = toRow(value);
      if (args.id) {
        const { data, error } = await context.supabase
          .from('entity_views')
          .update({ ...row, updated_at: new Date().toISOString() })
          .eq('id', args.id)
          .select()
          .maybeSingle();
        if (error) return { view: null, errors: [err('general', friendly(error.message))] };
        if (!data) return { view: null, errors: [err('id', 'That view was not found.', 'NOT_FOUND')] };
        return { view: mapView(data), errors: [] };
      }
      let clientId: string;
      try {
        clientId = await resolveEntityClientId(context, args.input?.clientId ?? null);
      } catch (error) {
        return { view: null, errors: [err('clientId', error instanceof Error ? error.message : 'Choose a client first.', 'VALIDATION_ERROR')] };
      }
      const { data, error } = await context.supabase
        .from('entity_views')
        .insert({ ...row, client_id: clientId, created_by: context.user?.id ?? null })
        .select()
        .single();
      if (error) return { view: null, errors: [err('general', friendly(error.message))] };
      return { view: mapView(data), errors: [] };
    },

    savePopulationFilter: async (_: any, args: { id?: string | null; input: any }, context: Context) => {
      const { value, errors } = normalizePopulationFilter(args.input);
      if (errors.length) return { filter: null, errors };
      const row = {
        domain_code: value.domainCode,
        filter_name: value.filterName,
        population_code: value.populationCode ?? null,
        description: value.description ?? null,
        conditions: value.conditions,
      };
      if (args.id) {
        const { data, error } = await context.supabase
          .from('population_filters')
          .update({ ...row, updated_at: new Date().toISOString() })
          .eq('id', args.id)
          .select()
          .maybeSingle();
        if (error) return { filter: null, errors: [err('general', friendly(error.message))] };
        if (!data) return { filter: null, errors: [err('id', 'That filter was not found.', 'NOT_FOUND')] };
        return { filter: mapFilter(data), errors: [] };
      }
      let clientId: string;
      try {
        clientId = await resolveEntityClientId(context, args.input?.clientId ?? null);
      } catch (error) {
        return { filter: null, errors: [err('clientId', error instanceof Error ? error.message : 'Choose a client first.', 'VALIDATION_ERROR')] };
      }
      const { data, error } = await context.supabase
        .from('population_filters')
        .insert({ ...row, client_id: clientId, created_by: context.user?.id ?? null })
        .select()
        .single();
      if (error) return { filter: null, errors: [err('general', friendly(error.message))] };
      return { filter: mapFilter(data), errors: [] };
    },

    deletePopulationFilter: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.from('population_filters').delete().eq('id', args.id).select('id');
      if (error) return { success: false, errors: [err('general', error.message)] };
      if (!data?.length) return { success: false, errors: [err('id', 'That filter was not found.', 'NOT_FOUND')] };
      return { success: true, errors: [] };
    },

    certifyPopulationFilter: async (_: any, args: { id: string; note?: string | null }, { supabase }: Context) => {
      // The database stamps who and when, and refuses anyone but an administrator.
      const { data, error } = await supabase
        .from('population_filters')
        .update({ certified_at: new Date().toISOString(), certification_note: args.note?.trim() || null })
        .eq('id', args.id)
        .select()
        .maybeSingle();
      if (error) return { filter: null, errors: [err('general', friendly(error.message), error.code === '42501' ? 'FORBIDDEN' : 'DATABASE_ERROR')] };
      if (!data) return { filter: null, errors: [err('id', 'That filter was not found.', 'NOT_FOUND')] };
      return { filter: mapFilter(data), errors: [] };
    },

    withdrawPopulationCertification: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase
        .from('population_filters')
        .update({ certified_at: null })
        .eq('id', args.id)
        .select()
        .maybeSingle();
      if (error) return { filter: null, errors: [err('general', friendly(error.message), error.code === '42501' ? 'FORBIDDEN' : 'DATABASE_ERROR')] };
      if (!data) return { filter: null, errors: [err('id', 'That filter was not found.', 'NOT_FOUND')] };
      return { filter: mapFilter(data), errors: [] };
    },

    deleteEntityView: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.from('entity_views').delete().eq('id', args.id).select('id');
      if (error) return { success: false, errors: [err('general', error.message)] };
      if (!data?.length) return { success: false, errors: [err('id', 'That view was not found.', 'NOT_FOUND')] };
      return { success: true, errors: [] };
    },
  },
};
