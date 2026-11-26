import type { Context } from '../context';
import { refreshCalculations } from '../lib/source-write';

/**
 * Four eyes on manual values. The database decides everything: who may see,
 * approve or withdraw a request, and that nobody approves their own
 * (supabase/migrations/20261126120000_four_eyes_approvals.sql).
 */

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

/** The status filter the list function takes: one status, or null for every status. */
export function overrideStatusFilter(status: string | null | undefined): string | null {
  const value = String(status ?? 'PENDING').trim().toUpperCase();
  if (value === '' || value === 'ALL') return null;
  if (!(STATUSES as readonly string[]).includes(value)) throw new Error('status is PENDING, APPROVED, REJECTED, WITHDRAWN or ALL');
  return value;
}

type RecordName = { entityCode: string | null; entityName: string | null; domainCode: string | null };

/** Each record's code, name and type, read the way record lists read them (public.entity_master, under row security). */
async function recordNames(context: Context, ids: string[]): Promise<Map<string, RecordName>> {
  const names = new Map<string, RecordName>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 80) {
    const { data, error } = await context.supabase
      .from('entity_master')
      .select('entity_id, entity_code, entity_name, domain_code')
      .in('entity_id', unique.slice(offset, offset + 80));
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      names.set(row.entity_id, { entityCode: row.entity_code ?? null, entityName: row.entity_name ?? null, domainCode: row.domain_code ?? null });
    }
  }
  return names;
}

/** The requests with their record's code, name and type. */
export function withRecordNames<T extends { entityId: string }>(rows: T[], names: Map<string, RecordName>): Array<T & RecordName> {
  return rows.map((row) => ({ ...row, ...(names.get(row.entityId) ?? { entityCode: null, entityName: null, domainCode: null }) }));
}

function gm(context: Context) {
  return context.supabase.schema('golden_master');
}

export const overrideApprovalResolvers = {
  Query: {
    overrideRequests: async (_: unknown, args: { status?: string | null }, context: Context) => {
      const { data, error } = await gm(context).rpc('override_requests_list', { p_status: overrideStatusFilter(args.status), p_limit: 200 });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<Record<string, unknown> & { entityId: string }>;
      return withRecordNames(rows, await recordNames(context, rows.map((row) => row.entityId)));
    },
    myNetworkAddress: (_: unknown, __: unknown, context: Context) => context.clientIp ?? null,
    hiddenAttributeCodes: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('hidden_attribute_codes');
      if (error) {
        // Not migrated yet: nothing is classified.
        if (error.code === 'PGRST202') return [];
        throw new Error(error.message);
      }
      return Array.isArray(data) ? data : [];
    },
    clientFourEyes: async (_: unknown, args: { clientId: string }, context: Context) => {
      const { data, error } = await context.supabase.schema('tenancy').from('clients').select('four_eyes_required').eq('id', args.clientId).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.four_eyes_required === true;
    },
  },
  Mutation: {
    decideOverrideRequest: async (_: unknown, args: { id: string; approve: boolean; note?: string | null }, context: Context) => {
      const { data, error } = await gm(context).rpc('decide_override_request', { p_request_id: args.id, p_approve: args.approve, p_note: args.note ?? null });
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'DECIDE_FAILED' }] };
      const entityId = (data as { entityId?: string } | null)?.entityId;
      if (args.approve && entityId) await refreshCalculations(context.supabase, entityId);
      return { success: true, errors: [] };
    },
    withdrawOverrideRequest: async (_: unknown, args: { id: string }, context: Context) => {
      const { error } = await gm(context).rpc('withdraw_override_request', { p_request_id: args.id });
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'WITHDRAW_FAILED' }] };
      return { success: true, errors: [] };
    },
    setClientAttributeAccessLevel: async (_: unknown, args: { clientId: string; attributeCode: string; level?: string | null }, context: Context) => {
      const { error } = await context.supabase.rpc('set_client_attribute_access_level', {
        p_client_id: args.clientId,
        p_attribute_code: args.attributeCode,
        p_level: args.level ?? null,
      });
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'ACCESS_LEVEL_FAILED' }] };
      return { success: true, errors: [] };
    },
    setClientFourEyes: async (_: unknown, args: { clientId: string; required: boolean }, context: Context) => {
      const { error } = await context.supabase.schema('tenancy').rpc('set_client_four_eyes', { p_client_id: args.clientId, p_required: args.required });
      if (error) return { success: false, errors: [{ field: 'general', message: error.message, code: 'FOUR_EYES_FAILED' }] };
      return { success: true, errors: [] };
    },
  },
};
