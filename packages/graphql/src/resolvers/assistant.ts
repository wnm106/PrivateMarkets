import type { Context } from '../context';

/**
 * What one person wants the assistant to monitor, and when they want a summary.
 * The tables are reached only through the assistant_* functions. The worker
 * delivers the notes.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

function failure(error: unknown, code: string, field: string | null = null): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  const duplicate = /already follow|duplicate key|23505/i.test(raw);
  return {
    field: duplicate ? 'subject' : field,
    message: duplicate ? 'You already follow that.' : raw || 'The request failed.',
    code: duplicate ? 'DUPLICATE' : code,
  };
}

export function mapSettings(row: Row | null) {
  return {
    enabled: row?.is_enabled === true,
    preset: row?.preset || 'WEEKDAY_MORNING',
    timezone: row?.timezone || 'UTC',
    morningHour: row?.morning_hour ?? 7,
    nextDeliveryAt: row?.next_delivery_at || null,
    followCount: Number(row?.follow_count) || 0,
  };
}

export function mapFollow(row: Row) {
  return {
    id: row.id,
    subjectType: row.subject_type || '',
    subjectId: row.subject_id || null,
    subjectCode: row.subject_code || null,
    label: row.label || '',
    delivery: row.delivery || 'DIGEST',
    includeChildren: row.include_children === true,
    createdAt: row.created_at || null,
  };
}

export const assistantResolvers = {
  Query: {
    assistantSettings: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('assistant_settings_get');
      if (error) throw error;
      return mapSettings((data || null) as Row | null);
    },

    assistantFollows: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('assistant_follows_list');
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapFollow);
    },
  },

  Mutation: {
    saveAssistantSettings: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const hour = input.morningHour ?? 7;
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return { settings: null, errors: [{ field: 'morningHour', message: 'The morning hour must be between 0 and 23.', code: 'VALIDATION' }] };
        }
        const { data, error } = await context.supabase.rpc('assistant_settings_save', {
          p_enabled: input.enabled === true,
          p_preset: String(input.preset || ''),
          p_timezone: String(input.timezone || ''),
          p_morning_hour: hour,
        });
        if (error) throw error;
        return { settings: mapSettings(data as Row), errors: [] };
      } catch (error) {
        return { settings: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    saveAssistantFollow: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const { data, error } = await context.supabase.rpc('assistant_follow_save', {
          p_subject_type: String(input.subjectType || ''),
          p_subject_id: input.subjectId || null,
          p_subject_code: input.subjectCode || null,
          p_delivery: String(input.delivery || 'DIGEST'),
        });
        if (error) throw error;
        return { follow: mapFollow(data as Row), errors: [] };
      } catch (error) {
        return { follow: null, errors: [failure(error, 'SAVE_FAILED', 'subject')] };
      }
    },

    setAssistantFollowChildren: async (_: unknown, args: { id: string; includeChildren: boolean }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('assistant_follow_children', { p_id: args.id, p_include: args.includeChildren === true });
        if (error) throw error;
        return { follow: mapFollow(data as Row), errors: [] };
      } catch (error) {
        return { follow: null, errors: [failure(error, 'SAVE_FAILED', 'includeChildren')] };
      }
    },

    deleteAssistantFollow: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('assistant_follow_delete', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'That follow was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },

    deliverAssistantBrief: async (_: unknown, __: unknown, context: Context) => {
      const { error } = await context.supabase.rpc('assistant_brief_now');
      if (error) return { success: false, errors: [failure(error, 'QUEUE_FAILED')] };
      return { success: true, errors: [] };
    },
  },
};
