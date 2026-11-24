import { Context } from '../context';
import { clientNameMap } from './schema-scope';
import { runGrid } from '../lib/data-query-engine';
import {
  parseSettingsRow,
  settingsError,
  shapeAliases,
  shapeFields,
  usageCounts,
  usageRequests,
  type ClientCatalogRow,
} from '../lib/client-catalog';

/**
 * What the session's client calls one entity type and which of its fields the
 * client hides. The client is the one the session is working in; the database
 * decides that (tenancy.presentation_client_id), so no request names a client.
 */
async function presentSettings(context: Context, row: ClientCatalogRow, withUsage: boolean) {
  const { supabase } = context;
  const { data, error } = await supabase.rpc('get_attributes_with_aggregation', { p_domain_code: row.domain_code });
  if (error) throw new Error(settingsError(error.message));
  const attributes: Array<Record<string, any>> = Array.isArray(data) ? data : (data ? JSON.parse(data as any) : []);

  // The count is a help, not a condition: a field list without counts still works.
  let usage: Map<string, number> | null = null;
  let recordCount: number | null = null;
  if (withUsage && attributes.length > 0) {
    try {
      const results = await Promise.all(
        usageRequests(row.domain_code, attributes.map((attribute) => String(attribute.attribute_code)))
          .map((request) => runGrid(supabase, request)),
      );
      usage = usageCounts(results.map((result) => result.rows?.[0]));
      recordCount = results.length > 0 ? Number(results[0].matched ?? 0) : null;
    } catch (usageError) {
      console.error('[clientCatalogSettings] usage count failed:', (usageError as Error).message);
    }
  }

  const names = row.client_id ? await clientNameMap(context, [row.client_id]) : new Map<string, string>();
  return {
    clientId: row.client_id,
    clientName: row.client_id ? names.get(row.client_id) ?? null : null,
    canEdit: row.can_edit,
    domainCode: row.domain_code,
    catalogName: row.catalog_name,
    displayName: row.display_name,
    recordCount,
    aliases: shapeAliases(row.aliases),
    fields: shapeFields(attributes, row.hidden_attribute_ids, usage),
  };
}

async function readSettings(context: Context, domainCode: string): Promise<ClientCatalogRow> {
  const { data, error } = await context.supabase.rpc('client_catalog_settings', { p_domain_code: domainCode });
  if (error) throw new Error(settingsError(error.message));
  return parseSettingsRow(data);
}

function failed(error: unknown, field: string) {
  return {
    success: false,
    settings: null,
    errors: [{ field, message: settingsError((error as Error)?.message), code: 'CLIENT_CATALOG_FAILED' }],
  };
}

export const clientCatalogResolvers = {
  Query: {
    clientCatalogSettings: async (_: unknown, args: { domainCode: string }, context: Context) => {
      const domainCode = String(args.domainCode || '').trim();
      if (!domainCode) throw new Error('An entity type is required.');
      return presentSettings(context, await readSettings(context, domainCode), true);
    },
  },

  Mutation: {
    setClientEntityTypeName: async (
      _: unknown,
      args: { domainCode: string; displayName?: string | null },
      context: Context,
    ) => {
      try {
        const { data, error } = await context.supabase.rpc('set_client_domain_label', {
          p_domain_code: String(args.domainCode || '').trim(),
          p_display_name: args.displayName ?? '',
        });
        if (error) throw error;
        return { success: true, errors: [], settings: await presentSettings(context, parseSettingsRow(data), false) };
      } catch (error) {
        return failed(error, 'displayName');
      }
    },

    setClientFieldsHidden: async (
      _: unknown,
      args: { domainCode: string; attributeIds: string[]; hidden: boolean },
      context: Context,
    ) => {
      try {
        const ids = [...new Set((args.attributeIds || []).map(String).filter(Boolean))];
        if (ids.length > 0) {
          const { error } = await context.supabase.rpc('set_client_attributes_hidden', {
            p_attribute_ids: ids,
            p_hidden: args.hidden === true,
          });
          if (error) throw error;
        }
        const row = await readSettings(context, String(args.domainCode || '').trim());
        return { success: true, errors: [], settings: await presentSettings(context, row, false) };
      } catch (error) {
        return failed(error, 'attributeIds');
      }
    },

    addClientEntityTypeAlias: async (
      _: unknown,
      args: { domainCode: string; label: string },
      context: Context,
    ) => {
      try {
        const { data, error } = await context.supabase.rpc('add_client_domain_alias', {
          p_domain_code: String(args.domainCode || '').trim(),
          p_label: args.label ?? '',
        });
        if (error) throw error;
        return { success: true, errors: [], settings: await presentSettings(context, parseSettingsRow(data), false) };
      } catch (error) {
        return failed(error, 'label');
      }
    },

    removeClientEntityTypeAlias: async (
      _: unknown,
      args: { domainCode: string; aliasId: string },
      context: Context,
    ) => {
      try {
        const { error } = await context.supabase.rpc('remove_client_domain_alias', { p_alias_id: args.aliasId });
        if (error) throw error;
        const row = await readSettings(context, String(args.domainCode || '').trim());
        return { success: true, errors: [], settings: await presentSettings(context, row, false) };
      } catch (error) {
        return failed(error, 'aliasId');
      }
    },
  },
};
