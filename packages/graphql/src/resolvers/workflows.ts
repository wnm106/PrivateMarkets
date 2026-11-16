import type { Context } from '../context';
import { NODE_TYPES, asGraph, validateGraph } from '../lib/workflow-graph';
import { asDecision, asProposal, checkDecision, proposalCounts } from '../lib/workflow-proposal';
import { WORKFLOW_TEMPLATES } from '../lib/workflow-templates';
import { callerClientId } from './jobs';

/**
 * Workflows: definitions, runs, and reviews. The tables are reached only
 * through the workflow_* database functions, which check the caller's client
 * and the workflow.manage, workflow.run, and workflow.review permissions. The
 * worker in packages/worker advances the runs.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

function failure(error: unknown, code: string, field: string | null = null): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  return { field, message: raw || 'The request failed.', code };
}

function codeFromName(name: string): string {
  return (
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 100) || 'WORKFLOW'
  );
}

export function mapWorkflow(row: Row) {
  const graph = row.graph ? asGraph(row.graph) : null;
  return {
    id: row.id,
    clientId: row.client_id || null,
    code: row.workflow_code,
    name: row.workflow_name,
    description: row.description || null,
    publishedVersion: row.published_version ?? null,
    latestVersion: row.latest_version ?? 0,
    version: row.version ?? null,
    graph,
    problems: graph ? validateGraph(graph) : [],
    versions: ((row.versions as Row[] | undefined) || []).map((version) => ({
      version: version.version,
      changeNote: version.change_note || null,
      createdBy: version.created_by || null,
      createdAt: version.created_at,
    })),
    canManage: row.can_manage === true,
    runCount: Number(row.run_count) || 0,
    lastRunAt: row.last_run_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapReview(row: Row) {
  const proposal = row.proposal ? asProposal(row.proposal) : null;
  return {
    id: row.id,
    runId: row.run_id,
    clientId: row.client_id,
    nodeId: row.node_id,
    workflowName: row.workflow_name || null,
    title: row.title,
    instructions: row.instructions || null,
    summary: row.summary || null,
    proposal,
    counts: proposal ? proposalCounts(proposal) : null,
    itemCount: proposal ? proposal.items.length : Number(row.item_count) || 0,
    status: row.status,
    decision: row.decision ?? null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at,
    canReview: row.can_review === true,
  };
}

export function mapRun(row: Row) {
  const canReview = row.can_review === true;
  return {
    id: row.id,
    clientId: row.client_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name || null,
    version: row.version,
    status: row.status,
    input: row.input || {},
    context: row.context || {},
    currentNode: row.current_node || null,
    errorMessage: row.error_message || null,
    startedBy: row.started_by || null,
    openReviews: Number(row.open_reviews) || ((row.reviews as Row[] | undefined) || []).filter((review) => review.status === 'OPEN').length,
    canRun: row.can_run === true,
    canReview,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    graph: row.graph ? asGraph(row.graph) : null,
    steps: ((row.steps as Row[] | undefined) || []).map((step) => ({
      nodeId: step.node_id,
      nodeType: step.node_type,
      nodeLabel: step.node_label || null,
      status: step.status,
      outcome: step.outcome || null,
      attempts: step.attempts ?? 0,
      input: step.input ?? null,
      output: step.output ?? null,
      errorMessage: step.error_message || null,
      startedAt: step.started_at,
      finishedAt: step.finished_at || null,
    })),
    events: ((row.events as Row[] | undefined) || []).map((event) => ({
      id: String(event.id),
      nodeId: event.node_id || null,
      type: event.event_type,
      actorType: event.actor_type,
      actorId: event.actor_id || null,
      actorName: event.actor_name || null,
      summary: event.summary,
      detail: event.detail ?? null,
      createdAt: event.created_at,
    })),
    reviews: ((row.reviews as Row[] | undefined) || []).map((review) => mapReview({ ...review, workflow_name: row.workflow_name, can_review: canReview })),
  };
}

async function readRun(context: Context, id: string) {
  const { data, error } = await context.supabase.rpc('workflow_run_get', { p_run_id: id });
  if (error) throw error;
  return data ? mapRun(data as Row) : null;
}

export const workflowResolvers = {
  Query: {
    workflows: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_list', {});
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapWorkflow);
    },

    workflow: async (_: unknown, args: { id: string; version?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_get', { p_id: args.id, p_version: args.version ?? null });
      if (error) throw error;
      return data ? mapWorkflow(data as Row) : null;
    },

    workflowTemplates: () => WORKFLOW_TEMPLATES,
    workflowNodeTypes: () => NODE_TYPES,

    workflowRuns: async (_: unknown, args: { workflowId?: string | null; status?: string | null; first?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_runs_list', {
        p_workflow_id: args.workflowId || null,
        p_status: args.status || null,
        p_limit: args.first ?? 50,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapRun);
    },

    workflowRun: (_: unknown, args: { id: string }, context: Context) => readRun(context, args.id),

    workflowReviews: async (_: unknown, args: { status?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_reviews_list', { p_status: args.status === undefined ? 'OPEN' : args.status, p_limit: 100 });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapReview);
    },
  },

  Mutation: {
    /** Saves a new version. A graph with problems can be saved as a draft; it cannot be published. */
    saveWorkflow: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const name = String(input.name || '').trim();
        if (!name) return { workflow: null, errors: [{ field: 'name', message: 'Give the workflow a name.', code: 'VALIDATION' }] };
        const graph = asGraph(input.graph);
        if (graph.nodes.length === 0) return { workflow: null, errors: [{ field: 'graph', message: 'The workflow has no steps.', code: 'VALIDATION' }] };

        let clientId: string | null = null;
        if (!input.id && !input.shared) {
          clientId = await callerClientId(context);
          if (!clientId) return { workflow: null, errors: [{ field: null, message: 'Choose a client before adding a workflow.', code: 'NO_CLIENT' }] };
        }
        const { data, error } = await context.supabase.rpc('workflow_save', {
          p_id: input.id || null,
          p_client_id: clientId,
          p_code: String(input.code || '').trim() || codeFromName(name),
          p_name: name,
          p_description: input.description ?? null,
          p_graph: graph,
          p_change_note: input.changeNote ?? null,
        });
        if (error) throw error;
        return { workflow: mapWorkflow(data as Row), errors: [] };
      } catch (error) {
        return { workflow: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    publishWorkflow: async (_: unknown, args: { id: string; version: number }, context: Context) => {
      try {
        const current = await context.supabase.rpc('workflow_get', { p_id: args.id, p_version: args.version });
        if (current.error) throw current.error;
        if (!current.data || !(current.data as Row).graph) {
          return { workflow: null, errors: [{ field: 'version', message: 'That version does not exist.', code: 'NOT_FOUND' }] };
        }
        const problems = validateGraph(asGraph((current.data as Row).graph));
        if (problems.length > 0) {
          return { workflow: mapWorkflow(current.data as Row), errors: problems.map((problem) => ({ field: problem.nodeId, message: problem.message, code: 'INVALID_GRAPH' })) };
        }
        const { data, error } = await context.supabase.rpc('workflow_publish', { p_id: args.id, p_version: args.version });
        if (error) throw error;
        return { workflow: mapWorkflow(data as Row), errors: [] };
      } catch (error) {
        return { workflow: null, errors: [failure(error, 'PUBLISH_FAILED')] };
      }
    },

    archiveWorkflow: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_archive', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'ARCHIVE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'Workflow was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },

    startWorkflowRun: async (_: unknown, args: { workflowId: string; input?: unknown; version?: number | null }, context: Context) => {
      try {
        if (args.input != null && (typeof args.input !== 'object' || Array.isArray(args.input))) {
          return { run: null, errors: [{ field: 'input', message: 'The input must be a JSON object.', code: 'VALIDATION' }] };
        }
        const clientId = await callerClientId(context);
        if (!clientId) return { run: null, errors: [{ field: null, message: 'Choose a client before starting a run.', code: 'NO_CLIENT' }] };
        const { data, error } = await context.supabase.rpc('workflow_run_start', {
          p_workflow_id: args.workflowId,
          p_client_id: clientId,
          p_input: args.input || {},
          p_version: args.version ?? null,
        });
        if (error) throw error;
        return { run: await readRun(context, String(data)), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'START_FAILED')] };
      }
    },

    cancelWorkflowRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('workflow_run_cancel', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) return { run: null, errors: [{ field: 'id', message: 'Only a run that has not finished can be cancelled.', code: 'NOT_CANCELLABLE' }] };
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'CANCEL_FAILED')] };
      }
    },

    retryWorkflowRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('workflow_run_retry', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) return { run: null, errors: [{ field: 'id', message: 'Only a failed run can be retried.', code: 'NOT_RETRYABLE' }] };
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'RETRY_FAILED')] };
      }
    },

    /**
     * Records a review decision. An approval is checked against the stored
     * proposal first: every change needs a choice, and an approved change needs
     * its required questions answered.
     */
    decideWorkflowReview: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const outcome = String(input.outcome || '').toUpperCase();
        if (outcome !== 'APPROVED' && outcome !== 'REJECTED') {
          return { review: null, errors: [{ field: 'outcome', message: 'A review is approved or rejected.', code: 'VALIDATION' }] };
        }
        const current = await context.supabase.rpc('workflow_review_get', { p_review_id: input.reviewId });
        if (current.error) throw current.error;
        if (!current.data) return { review: null, errors: [{ field: 'reviewId', message: 'Review was not found.', code: 'NOT_FOUND' }] };

        const decision = asDecision(input.decision);
        let recorded = outcome;
        if (outcome === 'APPROVED') {
          const proposal = asProposal((current.data as Row).proposal);
          const check = checkDecision(proposal, decision);
          if (!check.ok) {
            return { review: mapReview(current.data as Row), errors: check.problems.map((message) => ({ field: null, message, code: 'INCOMPLETE' })) };
          }
          // Approving a review with every change rejected is a rejection.
          if (proposal.items.length > 0 && check.approved.length === 0) recorded = 'REJECTED';
        }
        const { data, error } = await context.supabase.rpc('workflow_review_decide', { p_review_id: input.reviewId, p_outcome: recorded, p_decision: decision });
        if (error) throw error;
        return { review: mapReview({ ...(data as Row), can_review: true }), errors: [] };
      } catch (error) {
        return { review: null, errors: [failure(error, 'DECIDE_FAILED')] };
      }
    },
  },
};
