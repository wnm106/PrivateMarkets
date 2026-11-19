import { resolveStoredAlias } from '../lib/semantic-aliases';
import type { Context } from '../context';

interface AliasRow {
  id: string;
  alias_label: string;
  alias_code: string;
  alias_kind: string;
}

function mapAlias(row: AliasRow) {
  return {
    id: row.id,
    aliasLabel: row.alias_label,
    aliasCode: row.alias_code,
    aliasKind: row.alias_kind,
  };
}

async function allowedCodes(supabase: Context['supabase'], domainCode: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('entity_name_aliases')
    .select('alias_code')
    .eq('domain_code', domainCode)
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map((row: { alias_code: string }) => row.alias_code);
}

export const entityAliasResolvers = {
  Query: {
    entityAliases: async (_: unknown, args: { entityId: string }, context: Context) => {
      const { data, error } = await context.supabase
        .from('entity_aliases')
        .select('id, alias_label, alias_code, alias_kind')
        .eq('entity_id', args.entityId)
        .eq('is_active', true)
        .order('alias_label');
      if (error) throw error;
      return ((data || []) as AliasRow[]).map(mapAlias);
    },

    entityNameAliases: async (_: unknown, args: { domainCode: string }, context: Context) => {
      const code = args.domainCode.trim().toUpperCase();
      const { data, error } = await context.supabase
        .from('entity_name_aliases')
        .select('alias_label, alias_code')
        .eq('domain_code', code)
        .eq('is_active', true)
        .order('alias_label');
      if (error) throw error;
      return (data || []).map((row: { alias_label: string; alias_code: string }) => ({
        aliasLabel: row.alias_label,
        aliasCode: row.alias_code,
      }));
    },
  },

  Mutation: {
    saveEntityAlias: async (
      _: unknown,
      args: { input: { id?: string | null; entityId: string; aliasLabel: string; aliasCode?: string | null } },
      context: Context,
    ) => {
      const { input } = args;
      const entity = await context.supabase
        .from('master_entities')
        .select('id, domain_code')
        .eq('id', input.entityId)
        .maybeSingle();
      if (entity.error) throw entity.error;
      if (!entity.data) {
        return { alias: null, errors: [{ field: 'entityId', message: 'That record was not found', code: 'NOT_FOUND' }] };
      }

      const allowed = await allowedCodes(context.supabase, entity.data.domain_code);
      const resolved = resolveStoredAlias(input.aliasLabel, input.aliasCode, allowed);
      if ('error' in resolved) {
        return { alias: null, errors: [{ field: 'aliasLabel', message: resolved.error, code: 'VALIDATION' }] };
      }

      const row = {
        entity_id: input.entityId,
        alias_label: resolved.aliasLabel,
        alias_code: resolved.aliasCode,
        alias_kind: resolved.aliasKind,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
      const saved = input.id
        ? await context.supabase.from('entity_aliases').update(row).eq('id', input.id).eq('entity_id', input.entityId).select('id, alias_label, alias_code, alias_kind').single()
        : await context.supabase.from('entity_aliases').upsert(row, { onConflict: 'entity_id,alias_code' }).select('id, alias_label, alias_code, alias_kind').single();
      if (saved.error) throw saved.error;
      return { alias: mapAlias(saved.data as AliasRow), errors: [] };
    },

    deleteEntityAlias: async (_: unknown, args: { id: string }, context: Context) => {
      const { error } = await context.supabase.from('entity_aliases').delete().eq('id', args.id);
      if (error) return { success: false, errors: [{ field: 'id', message: error.message, code: 'DELETE_FAILED' }] };
      return { success: true, errors: [] };
    },
  },
};
