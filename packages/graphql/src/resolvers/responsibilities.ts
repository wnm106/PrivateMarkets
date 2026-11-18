import type { Context } from '../context';

/**
 * Who must act on a record or a domain. Being responsible grants no access:
 * the tables are reached only through the responsibility_* functions, which
 * apply the caller's own access, and each use (review routing, for one) checks
 * what it needs.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

export function responsibilityFailure(error: unknown, code: string): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  const field = /person|role/i.test(raw) ? 'holder' : /record|domain|client/i.test(raw) ? 'subject' : /activity/i.test(raw) ? 'activityCode' : null;
  return {
    field,
    message: raw || 'The request failed.',
    code: pgCode === '42501' ? 'FORBIDDEN' : pgCode === 'P0002' ? 'NOT_FOUND' : pgCode === '22023' ? 'VALIDATION' : code,
  };
}

export function mapResponsibility(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    subjectType: row.subject_type || '',
    entityId: row.entity_id || null,
    entityName: row.entity_name || null,
    domainCode: row.domain_code || row.entity_domain_code || null,
    includeChildren: row.include_children !== false,
    activityCode: row.activity_code || null,
    activityName: row.activity_name || null,
    userId: row.user_id || null,
    userName: row.user_name || null,
    roleCode: row.role_code || null,
    roleName: row.role_name || row.role_code || null,
    isBackup: row.is_backup === true,
    note: row.note || null,
    isMine: row.is_mine === true,
    canManage: row.can_manage === true,
    createdAt: row.created_at || null,
  };
}

function list(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

export const responsibilityResolvers = {
  Query: {
    responsibilities: async (
      _: unknown,
      args: { entityId?: string | null; domainCode?: string | null; mine?: boolean | null },
      context: Context,
    ) => {
      const { data, error } = await context.supabase.rpc('responsibilities_list', {
        p_entity_id: args.entityId || null,
        p_domain_code: args.domainCode || null,
        p_mine: args.mine === true,
      });
      if (error) throw error;
      return list(data).map(mapResponsibility);
    },

    responsibleForEntity: async (_: unknown, args: { entityId: string; activity?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('responsibility_for_entity', {
        p_entity_id: args.entityId,
        p_activity: args.activity || null,
      });
      if (error) throw error;
      return list(data).map((row) => ({
        userId: String(row.userId),
        name: String(row.name || 'Unnamed person'),
        isBackup: row.isBackup === true,
      }));
    },

    responsibilityChoices: async (_: unknown, args: { clientId?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('responsibility_choices', { p_client_id: args.clientId || null });
      if (error) throw error;
      const row = (data || {}) as Row;
      return {
        clientId: row.client_id || null,
        canManage: row.can_manage === true,
        people: list(row.people),
        roles: list(row.roles),
        activities: list(row.activities),
      };
    },
  },

  Mutation: {
    saveResponsibility: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      const subjectType = String(input.subjectType || '').toUpperCase();
      if (Boolean(input.userId) === Boolean(input.roleCode)) {
        return { responsibility: null, errors: [{ field: 'holder', message: 'Name one person or one role.', code: 'VALIDATION' }] };
      }
      if (subjectType === 'ENTITY' ? !input.entityId : subjectType === 'DOMAIN' ? !input.domainCode : true) {
        return { responsibility: null, errors: [{ field: 'subject', message: 'Choose a record or a domain.', code: 'VALIDATION' }] };
      }
      try {
        const { data, error } = await context.supabase.rpc('responsibility_save', {
          p_subject_type: subjectType,
          p_entity_id: subjectType === 'ENTITY' ? input.entityId : null,
          p_domain_code: subjectType === 'DOMAIN' ? String(input.domainCode) : null,
          p_activity: input.activityCode || null,
          p_user_id: input.userId || null,
          p_role_code: input.roleCode || null,
          p_is_backup: input.isBackup === true,
          p_include_children: input.includeChildren !== false,
          p_note: input.note || null,
          p_client_id: input.clientId || null,
        });
        if (error) throw error;
        return { responsibility: mapResponsibility(data as Row), errors: [] };
      } catch (error) {
        return { responsibility: null, errors: [responsibilityFailure(error, 'SAVE_FAILED')] };
      }
    },

    deleteResponsibility: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('responsibility_delete', { p_id: args.id });
      if (error) return { success: false, errors: [responsibilityFailure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'That responsibility was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },
  },
};
