import type { Context } from '../context';

/**
 * The caller's home page: where it differs from their role default, the
 * recent changes to what they follow, and their latest assistant brief.
 * Everything is the caller's own and is reached through the home_* functions.
 */

type Row = Record<string, any>;

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map((item) => String(item)) : null;
}

export function mapHomeLayout(row: Row | null) {
  return {
    clientId: row?.client_id || null,
    canSave: row?.can_save === true,
    hiddenModules: stringList(row?.hidden_modules),
    pinnedPlaces: stringList(row?.pinned_places),
    updatedAt: row?.updated_at || null,
  };
}

export function mapHomeActivity(row: Row) {
  return {
    id: row.id,
    kind: row.kind || '',
    subjectType: row.subject_type || '',
    subjectId: row.subject_id || null,
    subjectCode: row.subject_code || null,
    summary: row.summary || '',
    occurredAt: row.occurred_at,
    followLabel: row.follow_label || '',
    delivery: row.delivery || 'DIGEST',
  };
}

export function mapHomeFollow(row: Row) {
  return {
    id: row.id,
    subjectType: row.subject_type || '',
    subjectId: row.subject_id || null,
    subjectCode: row.subject_code || null,
    label: row.label || '',
    delivery: row.delivery || 'DIGEST',
    domainCode: row.domain_code || null,
    lastSummary: row.last_summary || null,
    lastAt: row.last_at || null,
  };
}

export function mapHomeBrief(row: Row | null) {
  return {
    available: row?.available === true,
    enabled: row?.enabled === true,
    preset: row?.preset || 'WEEKDAY_MORNING',
    nextDeliveryAt: row?.next_delivery_at || null,
    conversationId: row?.conversation_id || null,
    content: row?.content || null,
    deliveredAt: row?.delivered_at || null,
    followCount: Number(row?.follow_count) || 0,
  };
}

function cleanList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export const homeResolvers = {
  Query: {
    homeLayout: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('home_layout_get');
      if (error) throw error;
      return mapHomeLayout((data || null) as Row | null);
    },

    homeActivity: async (_: unknown, args: { days?: number | null; first?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('home_activity', {
        p_days: args.days ?? 14,
        p_limit: args.first ?? 20,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapHomeActivity);
    },

    homeFollows: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('home_follows');
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapHomeFollow);
    },

    homeBrief: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('home_brief');
      if (error) throw error;
      return mapHomeBrief((data || null) as Row | null);
    },
  },

  Mutation: {
    saveHomeLayout: async (_: unknown, args: { input: Row }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('home_layout_save', {
          p_hidden_modules: cleanList(args.input?.hiddenModules),
          p_pinned_places: cleanList(args.input?.pinnedPlaces),
        });
        if (error) throw error;
        return { layout: mapHomeLayout(data as Row), errors: [] };
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
        return { layout: null, errors: [{ field: null, message: message || 'Your home page could not be saved.', code: 'SAVE_FAILED' }] };
      }
    },
  },
};
