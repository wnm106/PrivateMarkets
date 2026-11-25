import type { Context } from '../context';

/**
 * The append-only access and configuration audit log. The database function
 * decides who may read which client's entries; see
 * supabase/migrations/20261125100000_configuration_audit.sql.
 */

export type AuditLogArgs = {
  kind?: string | null;
  from?: string | null;
  to?: string | null;
  table?: string | null;
  actorUserId?: string | null;
  rowId?: string | null;
  search?: string | null;
  limit?: number | null;
  beforeId?: string | null;
};

/** The function's arguments. Blank filters are left out; beforeId must be a whole number. */
export function auditLogParams(args: AuditLogArgs) {
  const blank = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  const beforeId = blank(args.beforeId);
  if (beforeId !== null && !/^\d+$/.test(beforeId)) {
    throw new Error('beforeId is the id of an audit entry');
  }
  const kind = blank(args.kind)?.toLowerCase() ?? null;
  if (kind !== null && kind !== 'access' && kind !== 'configuration') {
    throw new Error('kind is access or configuration');
  }
  return {
    p_kind: kind,
    p_from: blank(args.from),
    p_to: blank(args.to),
    p_table: blank(args.table),
    p_actor_user_id: blank(args.actorUserId),
    p_row_id: blank(args.rowId),
    p_search: blank(args.search),
    p_limit: args.limit ?? 100,
    p_before_id: beforeId,
  };
}

export const auditLogResolvers = {
  Query: {
    auditLog: async (_: unknown, args: AuditLogArgs, context: Context) => {
      const { data, error } = await context.supabase.rpc('audit_log_entries', auditLogParams(args));
      if (error) throw error;
      return data ?? { entries: [], hasMore: false };
    },
  },
};
