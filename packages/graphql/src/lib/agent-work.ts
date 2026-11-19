/**
 * Agents at work: what the workflow runs in flight are doing, and which named
 * agent is doing it. Read from the runs themselves (the graph, the steps, and
 * the audit log), so nothing extra is recorded for this. Everything here is pure.
 */

import { asGraph, type WorkflowNode } from './workflow-graph';
import { agentCodeOf } from './workflow-agents';

type Row = Record<string, any>;

/** working: a step is running. queued: not picked up yet. waiting: on a person. */
export type AgentWorkState = 'working' | 'queued' | 'waiting';

export interface AgentWork {
  runId: string;
  workflowName: string;
  state: AgentWorkState;
  /** The named agent behind the current work, when the step runs as one. */
  agentCode: string | null;
  /** The agent's name, or the agent step's label when it runs as no named agent. Null when no agent step is involved. */
  agentName: string | null;
  /** The step the run is on. */
  stepLabel: string;
  /** One line saying what is happening. */
  detail: string;
  /** 0 to 100: steps finished, plus how far through its rounds a running agent is. */
  percent: number;
  stepsDone: number;
  stepsTotal: number;
  startedAt: string | null;
}

export interface AgentStatus {
  code: string;
  name: string;
  description: string | null;
  /** working when any run of it is running or queued, waiting when its proposals are with a person, otherwise idle. */
  state: AgentWorkState | 'idle';
  runs: number;
}

/** A run that has finished, with what it produced. */
export interface FinishedWork {
  runId: string;
  workflowName: string;
  /** done, or failed. */
  outcome: 'done' | 'failed';
  /** What the person asked for, when the run was handed a typed request. */
  request: string | null;
  /** The agent that wrote the result: its name, or its step's label. */
  agentName: string | null;
  /** The agent's own account of what it found and did, as it wrote it. For a failed run, why it failed. */
  result: string;
  /** One line on what came of it: changes proposed and how the review went. Null when nothing was proposed. */
  changes: string | null;
  finishedAt: string | null;
}

export interface AgentsAtWork {
  agents: AgentStatus[];
  work: AgentWork[];
  /** Runs that finished recently, newest first. */
  finished: FinishedWork[];
  /** Runs with a step running or queued. */
  running: number;
  /** Runs waiting on a person. */
  waiting: number;
}

const ACTIVE = new Set(['RUNNING', 'QUEUED', 'WAITING']);
const DEFAULT_ROUNDS = 24;
const MAX_ROUNDS = 60;

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as Row[]) : [];
}

/** The agent step behind where a run is: the step itself, the step a review is of, or the last agent step that ran. */
function agentNodeFor(current: WorkflowNode | undefined, nodes: WorkflowNode[], steps: Row[]): WorkflowNode | undefined {
  if (current?.type === 'agent') return current;
  if (current?.type === 'review') {
    const source = nodes.find((node) => node.id === String(current.config.source || ''));
    if (source?.type === 'agent') return source;
  }
  const ran = steps.filter((step) => step.node_type === 'agent').map((step) => String(step.node_id));
  const last = ran[ran.length - 1];
  return last ? nodes.find((node) => node.id === last) : undefined;
}

/** What one run in flight is doing. Null for a run that has finished. */
export function agentWork(run: Row): AgentWork | null {
  const status = String(run.status || '');
  if (!ACTIVE.has(status)) return null;
  const graph = asGraph(run.graph);
  const nodes = graph.nodes;
  const steps = rows(run.steps);
  const events = rows(run.events);
  const current = nodes.find((node) => node.id === run.current_node);
  const agentNode = agentNodeFor(current, nodes, steps);

  // Start and End are not work.
  const work = nodes.filter((node) => node.type !== 'start' && node.type !== 'end');
  const workIds = new Set(work.map((node) => node.id));
  const stepsDone = steps.filter((step) => workIds.has(String(step.node_id)) && (step.status === 'SUCCEEDED' || step.status === 'SKIPPED')).length;
  const stepsTotal = Math.max(work.length, 1);

  const agentCode = agentNode ? agentCodeOf(agentNode.config) || null : null;
  // The audit log says "Running as <name>" when a step ran as a named agent.
  const identity = agentNode ? events.filter((event) => event.event_type === 'agent.identity' && event.node_id === agentNode.id).pop() : undefined;
  const named = typeof identity?.summary === 'string' && identity.summary.startsWith('Running as ') ? identity.summary.slice('Running as '.length) : null;
  const agentName = agentNode ? named || agentCode || agentNode.label || 'Agent' : null;

  const state: AgentWorkState = status === 'WAITING' ? 'waiting' : status === 'QUEUED' ? 'queued' : 'working';
  let detail = '';
  let partial = 0;

  if (state === 'queued') {
    detail = 'Waiting for a worker to pick it up';
  } else if (state === 'waiting') {
    const open = rows(run.reviews).filter((review) => review.status === 'OPEN');
    const changes = open.reduce((sum, review) => sum + (Array.isArray(review.proposal?.items) ? review.proposal.items.length : 0), 0);
    detail = open.length > 0
      ? changes > 0
        ? `Waiting on a review of ${plural(changes, 'proposed change')}`
        : 'Waiting on a review'
      : current?.type === 'form'
        ? 'Waiting for someone to fill in a form'
        : 'Waiting on a person';
  } else if (current?.type === 'agent') {
    const max = Math.min(MAX_ROUNDS, Math.max(1, Math.trunc(Number(current.config.maxRounds)) || DEFAULT_ROUNDS));
    // One usage event is written per model turn.
    const rounds = events.filter((event) => event.event_type === 'agent.usage' && event.node_id === current.id).length;
    const reads = events.filter((event) => event.event_type === 'agent.tool' && event.node_id === current.id).length;
    detail = rounds === 0 ? 'Starting' : `Round ${Math.min(rounds, max)} of up to ${max} · ${plural(reads, 'read')}`;
    // An agent may finish well before its last round, so a running step never counts as nearly done.
    partial = Math.min(rounds / max, 0.9);
  } else {
    detail = 'Running';
  }

  return {
    runId: String(run.id),
    workflowName: String(run.workflow_name || 'A workflow'),
    state,
    agentCode,
    agentName,
    stepLabel: current?.label || (state === 'queued' ? 'Not started' : 'Working'),
    detail,
    percent: Math.max(0, Math.min(100, Math.round(((Math.min(stepsDone, stepsTotal) + partial) / stepsTotal) * 100))),
    stepsDone: Math.min(stepsDone, stepsTotal),
    stepsTotal,
    startedAt: run.started_at || run.created_at || null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The records a run is about: those it was started on, and those its open reviews propose to change. */
export function runEntityIds(run: Row): string[] {
  const ids: string[] = [];
  const chosen = run.input?.filters?.entityIds;
  if (Array.isArray(chosen)) ids.push(...chosen.map(String));
  for (const review of rows(run.reviews)) {
    if (review.status !== 'OPEN') continue;
    for (const item of rows(review.proposal?.items)) {
      const id = item.target?.entityId ?? item.args?.entityId;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return [...new Set(ids.filter((id) => UUID.test(id)))];
}

/**
 * Whether a run is one person's business: they started it, one of its open
 * reviews is theirs, or it is about a record in their universe.
 */
export function runIsMine(run: Row, userId: string | null, universe: ReadonlySet<string>, reviewIds: ReadonlySet<string>): boolean {
  if (userId && run.started_by === userId) return true;
  if (rows(run.reviews).some((review) => review.status === 'OPEN' && reviewIds.has(String(review.id)))) return true;
  return runEntityIds(run).some((id) => universe.has(id));
}

/** What a finished run produced. Null for a run still in flight, or one that was cancelled. */
export function finishedWork(run: Row): FinishedWork | null {
  const status = String(run.status || '');
  if (status !== 'SUCCEEDED' && status !== 'FAILED') return null;
  const steps = rows(run.steps);
  const events = rows(run.events);
  // The last agent step that wrote a summary is the run's answer.
  const answered = steps.filter((step) => step.node_type === 'agent' && typeof step.output?.summary === 'string' && step.output.summary.trim());
  const last = answered[answered.length - 1];
  const identity = last ? events.filter((event) => event.event_type === 'agent.identity' && event.node_id === last.node_id).pop() : undefined;
  const named = typeof identity?.summary === 'string' && identity.summary.startsWith('Running as ') ? identity.summary.slice('Running as '.length) : null;

  const proposed = answered.reduce((sum, step) => sum + (Array.isArray(step.output?.proposal?.items) ? step.output.proposal.items.length : 0), 0);
  const reviews = rows(run.reviews);
  const approved = reviews.filter((review) => review.status === 'APPROVED').length;
  const rejected = reviews.filter((review) => review.status === 'REJECTED').length;
  let changes: string | null = null;
  if (proposed > 0) {
    const verdict = approved > 0 && rejected === 0 ? 'approved' : rejected > 0 && approved === 0 ? 'rejected' : approved > 0 ? 'partly approved' : 'not reviewed';
    changes = `${plural(proposed, 'change')} proposed, ${verdict}`;
  }

  const request = typeof run.input?.request === 'string' && run.input.request.trim() ? run.input.request.trim() : null;
  const failed = status === 'FAILED';
  return {
    runId: String(run.id),
    workflowName: String(run.workflow_name || 'A workflow'),
    outcome: failed ? 'failed' : 'done',
    request,
    agentName: last ? named || String(last.node_label || 'Agent') : null,
    result: failed
      ? String(run.error_message || 'The run failed before it finished.')
      : last
        ? String(last.output.summary).trim()
        : 'Finished. This workflow has no agent step, so there is no written result.',
    changes,
    finishedAt: run.finished_at || null,
  };
}

const STATE_ORDER: Record<AgentWorkState, number> = { working: 0, queued: 1, waiting: 2 };

/**
 * The runs in flight and the standing of each named agent. `agents` is the
 * roster a client sees: its own, and the shared ones it has not replaced.
 */
export function agentsAtWork(
  runs: readonly Row[],
  agents: ReadonlyArray<{ code: string; name: string; description?: string | null; isActive?: boolean }>,
  finishedRuns: readonly Row[] = [],
): AgentsAtWork {
  const finished = finishedRuns
    .map(finishedWork)
    .filter((item): item is FinishedWork => item !== null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));

  const work = runs
    .map(agentWork)
    .filter((item): item is AgentWork => item !== null)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));

  const roster: AgentStatus[] = agents
    .filter((agent) => agent.isActive !== false)
    .map((agent) => {
      const mine = work.filter((item) => item.agentCode === agent.code);
      const state: AgentStatus['state'] = mine.some((item) => item.state === 'working')
        ? 'working'
        : mine.some((item) => item.state === 'queued')
          ? 'queued'
          : mine.length > 0
            ? 'waiting'
            : 'idle';
      return { code: agent.code, name: agent.name, description: agent.description || null, state, runs: mine.length };
    })
    .sort((a, b) => Number(a.state === 'idle') - Number(b.state === 'idle') || a.name.localeCompare(b.name));

  return {
    agents: roster,
    work,
    finished,
    running: work.filter((item) => item.state !== 'waiting').length,
    waiting: work.filter((item) => item.state === 'waiting').length,
  };
}
