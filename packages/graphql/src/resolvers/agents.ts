import type { Context } from '../context';
import { agentsAtWork } from '../lib/agent-work';

/**
 * Named agents: the standing definitions a workflow agent step can run as.
 * The table is reached only through the agent_* functions. The worker reads
 * the one a step names when the step runs.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
}

export function agentFailure(error: unknown, code: string): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  const field = /code/i.test(raw) ? 'code' : /name/i.test(raw) ? 'name' : /activity/i.test(raw) ? 'activityCodes' : /domain/i.test(raw) ? 'domainCodes' : null;
  return {
    field,
    message: raw || 'The request failed.',
    code: pgCode === '42501' ? 'FORBIDDEN' : pgCode === 'P0002' ? 'NOT_FOUND' : pgCode === '23505' ? 'DUPLICATE' : pgCode === '22023' ? 'VALIDATION' : code,
  };
}

/** How many runs of each status are read for the home page. Older ones are still on the Workflows page. */
const ACTIVE_RUNS_PER_STATUS = 6;

export function mapAgent(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    code: row.agent_code || '',
    name: row.agent_name || row.agent_code || '',
    description: row.description || null,
    charter: row.charter || '',
    activityCodes: strings(row.activity_codes),
    activityNames: strings(row.activity_names),
    domainCodes: strings(row.domain_codes),
    toolNames: strings(row.tool_names),
    isActive: row.is_active !== false,
    isShared: row.is_shared === true || !row.client_id,
    canManage: row.can_manage === true,
    updatedAt: row.updated_at || null,
  };
}

export const agentResolvers = {
  Query: {
    agents: async (_: unknown, args: { clientId?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('agents_list', { p_client_id: args.clientId || null });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapAgent);
    },

    /**
     * The workflow runs in flight and the standing of each agent. Read from
     * the runs themselves. A source that cannot be read drops out instead of
     * failing the whole answer: someone who cannot see runs still sees the roster.
     */
    agentsAtWork: async (_: unknown, __: unknown, context: Context) => {
      const lists = await Promise.all(
        ['RUNNING', 'QUEUED', 'WAITING'].map((status) => context.supabase.rpc('workflow_runs_list', { p_workflow_id: null, p_status: status, p_limit: ACTIVE_RUNS_PER_STATUS })),
      );
      const ids = lists.flatMap((result) => (result.error ? [] : ((result.data as Row[] | null) || []).map((row) => String(row.id))));
      const [runs, roster] = await Promise.all([
        Promise.all(ids.map((id) => context.supabase.rpc('workflow_run_get', { p_run_id: id }))),
        context.supabase.rpc('agents_list', { p_client_id: null }),
      ]);
      // A client's own agent takes the place of the shared one with the same code.
      const byCode = new Map<string, ReturnType<typeof mapAgent>>();
      for (const agent of roster.error ? [] : ((roster.data as Row[] | null) || []).map(mapAgent)) {
        const seen = byCode.get(agent.code);
        if (!seen || (seen.isShared && !agent.isShared)) byCode.set(agent.code, agent);
      }
      return agentsAtWork(
        runs.flatMap((result) => (result.error || !result.data ? [] : [result.data as Row])),
        [...byCode.values()],
      );
    },
  },

  Mutation: {
    saveAgent: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      const code = String(input.code || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) {
        return { agent: null, errors: [{ field: 'code', message: 'The code starts with a letter and uses letters, digits, and underscores.', code: 'VALIDATION' }] };
      }
      if (!String(input.name || '').trim()) {
        return { agent: null, errors: [{ field: 'name', message: 'Give the agent a name.', code: 'VALIDATION' }] };
      }
      try {
        const { data, error } = await context.supabase.rpc('agent_save', {
          p_id: input.id || null,
          p_client_id: input.clientId || null,
          p_code: code,
          p_name: String(input.name).trim(),
          p_description: input.description || null,
          p_charter: String(input.charter || ''),
          p_activities: strings(input.activityCodes),
          p_domains: strings(input.domainCodes),
          p_tools: strings(input.toolNames),
          p_is_active: input.isActive !== false,
        });
        if (error) throw error;
        return { agent: mapAgent(data as Row), errors: [] };
      } catch (error) {
        return { agent: null, errors: [agentFailure(error, 'SAVE_FAILED')] };
      }
    },

    deleteAgent: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('agent_delete', { p_id: args.id });
      if (error) return { success: false, errors: [agentFailure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'That agent was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },
  },
};
