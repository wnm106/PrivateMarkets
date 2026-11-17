import type { SupabaseClient } from '@supabase/supabase-js';
import type { LoadedRun, ReviewRow, StepRow, WorkflowStore } from './engine';

/**
 * The workflow store on Supabase. Every call is one of the workflow_worker_*
 * functions in supabase/migrations/20261116120000_workflows.sql (and
 * 20261117010000_workflow_review_routing.sql for opening a review), which only the
 * service role may execute.
 */

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toReview(row: Row): ReviewRow {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    status: String(row.status),
    proposal: row.proposal ?? null,
    decision: row.decision ?? null,
    decidedBy: text(row.decided_by),
    assignees: Array.isArray(row.assignees) ? (row.assignees as Row[]).map((entry) => String(entry.name ?? '')).filter(Boolean) : undefined,
    unassignable: Array.isArray(row.unassignable)
      ? (row.unassignable as Row[]).map((entry) => ({ person: String(entry.person ?? ''), reason: String(entry.reason ?? '') }))
      : undefined,
    dueAt: text(row.due_at),
  };
}

export function toStep(row: Row): StepRow {
  return { nodeId: String(row.node_id), status: String(row.status), outcome: text(row.outcome), output: row.output ?? null, state: row.state ?? null };
}

export function toLoadedRun(row: Row): LoadedRun {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    status: String(row.status),
    input: object(row.input),
    context: object(row.context),
    currentNode: text(row.current_node),
    startedBy: text(row.started_by),
    graph: row.graph ?? null,
    steps: (Array.isArray(row.steps) ? (row.steps as Row[]) : []).map(toStep),
    reviews: (Array.isArray(row.reviews) ? (row.reviews as Row[]) : []).map(toReview),
  };
}

export function supabaseWorkflowStore(supabase: SupabaseClient, leaseSeconds = 900): WorkflowStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  return {
    async load(runId, owner) {
      const row = await call<Row | null>('workflow_worker_load', { p_run_id: runId, p_owner: owner, p_lease_seconds: leaseSeconds });
      if (!row) return null;
      if (row.busy === true) return 'busy';
      if (row.done === true) return 'done';
      return toLoadedRun(row);
    },
    async saveStep(runId, owner, nodeId, patch) {
      return (await call<boolean | null>('workflow_worker_step', { p_run_id: runId, p_owner: owner, p_node_id: nodeId, p_patch: patch, p_lease_seconds: leaseSeconds })) === true;
    },
    async saveRun(runId, owner, patch, release = false) {
      return (await call<string | null>('workflow_worker_run', { p_run_id: runId, p_owner: owner, p_patch: patch, p_release: release })) || null;
    },
    async event(runId, nodeId, type, actor, actorId, summary, detail) {
      await call<null>('workflow_worker_event', {
        p_run_id: runId,
        p_node_id: nodeId,
        p_event_type: type,
        p_actor_type: actor,
        p_actor_id: actorId,
        p_summary: summary,
        p_detail: detail ?? null,
      });
    },
    async openReview(runId, nodeId, title, instructions, summary, proposal, routing) {
      const row = await call<Row | null>('workflow_worker_review', {
        p_run_id: runId,
        p_node_id: nodeId,
        p_title: title,
        p_instructions: instructions,
        p_summary: summary,
        p_proposal: proposal,
        p_routing: routing,
      });
      if (!row) throw new Error('The review could not be opened.');
      return toReview(row);
    },
  };
}
