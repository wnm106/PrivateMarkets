import { Context } from '../context';
import { normalizeEntityView } from '../lib/entity-views';
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
    ...(value.displayOrder != null ? { display_order: value.displayOrder } : {}),
  };
}

function friendly(message: string): string {
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

    deleteEntityView: async (_: any, args: { id: string }, { supabase }: Context) => {
      const { data, error } = await supabase.from('entity_views').delete().eq('id', args.id).select('id');
      if (error) return { success: false, errors: [err('general', error.message)] };
      if (!data?.length) return { success: false, errors: [err('id', 'That view was not found.', 'NOT_FOUND')] };
      return { success: true, errors: [] };
    },
  },
};
