import type { Context } from '../context';

/**
 * Model-call usage. The database function keeps the rows inside the clients
 * this session can see, including a tenant admin's support-mode client.
 */

type UsageArgs = {
  days?: number | null;
  from?: string | null;
  to?: string | null;
  feature?: string | null;
  agent?: string | null;
  userId?: string | null;
  model?: string | null;
};

export const agentUsageResolvers = {
  Query: {
    agentUsage: async (_: unknown, args: UsageArgs, context: Context) => {
      const { data, error } = await context.supabase.rpc('agent_usage', {
        p_days: args.days ?? null,
        p_from: args.from || null,
        p_to: args.to || null,
        p_feature: args.feature || null,
        p_agent: args.agent || null,
        p_user_id: args.userId || null,
        p_model: args.model || null,
      });
      if (error) throw error;
      return data ?? { totals: { calls: 0 }, byFeature: [], byAgent: [], byUser: [], byModel: [], byDay: [], calls: [] };
    },

    agentCall: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('agent_call', { p_id: args.id });
      if (error) throw error;
      return data ?? null;
    },
  },
};
