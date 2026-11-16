import {
  asGraph,
  evaluateCondition,
  isReadTool,
  nextNode,
  resolveTemplates,
  validateGraph,
  type RunScope,
  type WorkflowGraph,
  type WorkflowNode,
} from '@tapestrai/graphql/src/lib/workflow-graph';
import {
  asDecision,
  asProposal,
  checkDecision,
  finalArgs,
  inDependencyOrder,
  proposalCounts,
  withFoundationGaps,
  type FoundationAttribute,
  type ProposalItem,
} from '@tapestrai/graphql/src/lib/workflow-proposal';

/**
 * Moves a workflow run forward.
 *
 * One call walks the graph from the run's current step until the run finishes,
 * fails, or reaches a step that waits for a person. Each step's result is
 * stored before the next step starts. A call that dies part-way is safe to
 * repeat: finished steps are read back, not run again, and the step that was
 * in flight continues from its last checkpoint.
 *
 * Nothing here talks to the database or to a model. The store, the tools, and
 * the agent are passed in, so the walk can be tested with all three in memory.
 */

export interface StepRow {
  nodeId: string;
  status: string;
  outcome: string | null;
  output: unknown;
  state: unknown;
}

export interface ReviewRow {
  id: string;
  nodeId: string;
  status: string;
  proposal: unknown;
  decision: unknown;
  decidedBy: string | null;
}

export interface LoadedRun {
  id: string;
  clientId: string;
  status: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  currentNode: string | null;
  startedBy: string | null;
  graph: unknown;
  steps: StepRow[];
  reviews: ReviewRow[];
}

export type StepPatch = {
  nodeType?: string;
  nodeLabel?: string;
  status?: 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  outcome?: string | null;
  input?: unknown;
  output?: unknown;
  state?: unknown;
  error?: string | null;
  countAttempt?: boolean;
};

export type RunPatch = {
  status?: 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED';
  currentNode?: string | null;
  error?: string | null;
  context?: Record<string, unknown>;
};

export type ActorType = 'SYSTEM' | 'AGENT' | 'USER';

export interface WorkflowStore {
  /** The run, held for `owner`. 'busy' while another job holds it, 'done' when it has finished, null when there is none. */
  load(runId: string, owner: string): Promise<LoadedRun | 'busy' | 'done' | null>;
  /** False when `owner` no longer holds the run, or the run was cancelled. */
  saveStep(runId: string, owner: string, nodeId: string, patch: StepPatch): Promise<boolean>;
  /** The run's status afterwards, or null when `owner` no longer holds it. */
  saveRun(runId: string, owner: string, patch: RunPatch, release?: boolean): Promise<string | null>;
  event(runId: string, nodeId: string | null, type: string, actor: ActorType, actorId: string | null, summary: string, detail?: unknown): Promise<void>;
  openReview(runId: string, nodeId: string, title: string, instructions: string, summary: string, proposal: unknown): Promise<ReviewRow>;
}

/**
 * Who is behind a tool call, and for which client. The call itself runs as the
 * client's workflow service account; this person must hold what the call needs.
 */
export interface Actor {
  userId: string | null;
  clientId: string;
}

/**
 * What a call needs of the person behind it.
 *   read   a step reading for the person who started the run
 *   write  a fixed step its author allowed to change data, for the person who started the run
 *   apply  a change a reviewer approved
 */
export type ToolNeed = 'read' | 'write' | 'apply';

export interface ToolRunner {
  names(): ReadonlySet<string>;
  run(name: string, args: Record<string, unknown>, actor: Actor, need: ToolNeed, runId?: string): Promise<unknown>;
}

export interface AgentRequest {
  node: WorkflowNode;
  scope: RunScope;
  actor: Actor;
  /** The clock, for tests. Defaults to now. */
  now?: () => Date;
  /** The checkpoint from an earlier attempt at this step, if there was one. */
  state: unknown;
  checkpoint(state: unknown): Promise<void>;
  event(type: string, summary: string, detail?: unknown): Promise<void>;
}

export interface AgentResult {
  summary: string;
  items: ProposalItem[];
}

export interface EngineDeps {
  store: WorkflowStore;
  tools: ToolRunner;
  agent(request: AgentRequest): Promise<AgentResult>;
  /** What the entity type behind a proposed creation requires. Empty when it cannot be found. */
  foundation(args: Record<string, unknown>, actor: Actor): Promise<FoundationAttribute[]>;
}

export interface AdvanceResult {
  status: 'SUCCEEDED' | 'FAILED' | 'WAITING' | 'CANCELLED' | 'DONE';
  steps: number;
  waitingOn?: string;
  error?: string;
}

/** The run is held by another job. Trying again later is the right response. */
export class RunBusyError extends Error {
  constructor() {
    super('Another worker is advancing this run.');
    this.name = 'RunBusyError';
  }
}

/** Raised inside a step when it must stop without failing: the lock was lost, or the run was cancelled. */
class Halted extends Error {}

const MAX_OUTPUT_CHARS = 200_000;

/** The text of whatever was thrown. A database error is a plain object with a message, not an Error. */
export function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const raw = error as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [raw.message, raw.details, raw.hint].filter((part): part is string => typeof part === 'string' && part !== '');
    if (parts.length > 0) return parts.join(' ');
  }
  return 'The step failed';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Keeps one step's stored output to a size the run page can load. */
export function clampOutput(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return { truncated: true, note: 'The result could not be stored.' };
  }
  if (serialized.length <= MAX_OUTPUT_CHARS) return value ?? null;
  return { truncated: true, note: `The result was ${serialized.length} characters and was cut to fit.`, preview: serialized.slice(0, MAX_OUTPUT_CHARS) };
}

type StepOutcome = { wait: true; reason: string } | { wait?: false; outcome: string | null; output: unknown };

interface StepContext {
  run: LoadedRun;
  graph: WorkflowGraph;
  scope: RunScope;
  owner: string;
  deps: EngineDeps;
  step: StepRow | undefined;
}

async function runTool(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const tool = String(node.config.tool || '');
  const args = record(resolveTemplates(node.config.args || {}, ctx.scope));
  const write = !isReadTool(tool);
  if (write && node.config.allowWrite !== true) throw new Error(`"${tool}" changes data and this step is not allowed to.`);
  const actor: Actor = { userId: ctx.run.startedBy, clientId: ctx.run.clientId };
  const output = clampOutput(await ctx.deps.tools.run(tool, args, actor, write ? 'write' : 'read'));
  await ctx.deps.store.event(ctx.run.id, node.id, 'tool.called', 'SYSTEM', ctx.run.startedBy, `Ran ${tool}`, { tool, args });
  return { outcome: null, output };
}

async function runAgent(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const { store } = ctx.deps;
  const actor: Actor = { userId: ctx.run.startedBy, clientId: ctx.run.clientId };
  const result = await ctx.deps.agent({
    node,
    scope: ctx.scope,
    actor,
    state: ctx.step?.state ?? null,
    checkpoint: async (state) => {
      if (!(await store.saveStep(ctx.run.id, ctx.owner, node.id, { state }))) throw new Halted();
    },
    event: (type, summary, detail) => store.event(ctx.run.id, node.id, type, 'AGENT', null, summary, detail),
  });

  // Required fields are checked here, not left to the agent to remember.
  const items: ProposalItem[] = [];
  for (const item of result.items) {
    if (item.action === 'CREATE' && item.tool === 'create_entity') {
      items.push(withFoundationGaps(item, await ctx.deps.foundation(item.args, actor)));
    } else {
      items.push(item);
    }
  }
  const proposal = { items };
  const counts = proposalCounts(proposal);
  await store.event(
    ctx.run.id,
    node.id,
    'agent.proposed',
    'AGENT',
    null,
    counts.total === 0
      ? 'The agent finished and proposed no changes'
      : `The agent proposed ${counts.total} change${counts.total === 1 ? '' : 's'}: ${counts.confident} confident, ${counts.needsReview} needing review`,
    { counts, summary: result.summary },
  );
  return { outcome: null, output: { summary: result.summary, proposal, counts } };
}

async function runReview(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const { store } = ctx.deps;
  const source = record(ctx.scope.steps[String(node.config.source || '')]);
  const proposal = asProposal(source.proposal);
  let review = ctx.run.reviews.find((row) => row.nodeId === node.id);

  if (!review) {
    if (proposal.items.length === 0 && node.config.skipWhenEmpty !== false) {
      await store.event(ctx.run.id, node.id, 'review.skipped', 'SYSTEM', null, 'Nothing was proposed, so there was nothing to review');
      return { outcome: 'approved', output: { outcome: 'approved', skipped: true, approved: [], rejected: [] } };
    }
    review = await store.openReview(
      ctx.run.id,
      node.id,
      String(node.config.title || node.label || 'Review'),
      String(node.config.instructions || ''),
      typeof source.summary === 'string' ? source.summary : '',
      proposal,
    );
    if (review.status === 'OPEN') {
      const counts = proposalCounts(proposal);
      await store.event(ctx.run.id, node.id, 'review.requested', 'SYSTEM', null, `Waiting for a person to review ${counts.total} proposed change${counts.total === 1 ? '' : 's'}`, {
        reviewId: review.id,
        counts,
      });
    }
  }

  if (review.status === 'OPEN') return { wait: true, reason: node.id };
  if (review.status === 'CANCELLED') throw new Error('The review was cancelled.');

  // The decision is read against the proposal that was stored, by item id. An
  // item the reviewer was never shown cannot be approved.
  const stored = asProposal(review.proposal);
  const decision = asDecision(review.decision);
  const check = checkDecision(stored, decision);
  const approvedIds = new Set(review.status === 'APPROVED' ? check.approved : []);
  const approved = stored.items
    .filter((item) => approvedIds.has(item.id))
    .map((item) => ({ ...item, args: finalArgs(item, decision.items[item.id]), missing: [] }));
  const outcome = approved.length > 0 || (review.status === 'APPROVED' && stored.items.length === 0) ? 'approved' : 'rejected';
  return {
    outcome,
    output: {
      outcome,
      reviewId: review.id,
      decidedBy: review.decidedBy,
      approved,
      rejected: stored.items.filter((item) => !approvedIds.has(item.id)).map((item) => item.id),
      note: decision.note || null,
    },
  };
}

interface ApplyResult {
  id: string;
  summary: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function runApply(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const { store, tools } = ctx.deps;
  const review = record(ctx.scope.steps[String(node.config.review || '')]);
  const approved = (Array.isArray(review.approved) ? review.approved : []) as ProposalItem[];
  const decidedBy = typeof review.decidedBy === 'string' ? review.decidedBy : null;
  // Made by the service account, for the person who approved them. That person must be allowed to make the change.
  const actor: Actor = { userId: decidedBy, clientId: ctx.run.clientId };

  // A change that already ran is not run again when the step restarts.
  const done: Record<string, ApplyResult> = { ...(record(record(ctx.step?.state).done) as Record<string, ApplyResult>) };
  // A change another depends on is made first. If it fails, the one that needed it is not attempted.
  for (const item of inDependencyOrder(approved)) {
    if (done[item.id]) continue;
    const failed = (item.dependsOn || []).map((id) => done[id]).find((needed) => needed && !needed.ok);
    if (failed) {
      done[item.id] = { id: item.id, summary: item.summary, tool: item.tool, ok: false, error: `Not attempted, because "${failed.summary}" could not be applied first.` };
    } else if (!tools.names().has(item.tool)) {
      done[item.id] = { id: item.id, summary: item.summary, tool: item.tool, ok: false, error: `There is no tool called "${item.tool}".` };
    } else {
      // Marked before the call: after a crash mid-call the change is reported as
      // unconfirmed rather than silently made a second time.
      const pending = { ...done, [item.id]: { id: item.id, summary: item.summary, tool: item.tool, ok: false, error: 'The worker stopped while this change was being made. Check the record before applying it again.' } };
      if (!(await store.saveStep(ctx.run.id, ctx.owner, node.id, { state: { done: pending } }))) throw new Halted();
      try {
        const result = clampOutput(await tools.run(item.tool, item.args, actor, 'apply', ctx.run.id));
        done[item.id] = { id: item.id, summary: item.summary, tool: item.tool, ok: true, result };
      } catch (error) {
        done[item.id] = { id: item.id, summary: item.summary, tool: item.tool, ok: false, error: message(error) };
      }
    }
    const outcome = done[item.id];
    await store.event(
      ctx.run.id,
      node.id,
      outcome.ok ? 'change.applied' : 'change.failed',
      'USER',
      decidedBy,
      outcome.ok ? `Applied: ${item.summary}` : `Could not apply: ${item.summary}. ${outcome.error}`,
      { itemId: item.id, action: item.action, target: item.target, tool: item.tool, args: item.args, ok: outcome.ok, error: outcome.error },
    );
    if (!(await store.saveStep(ctx.run.id, ctx.owner, node.id, { state: { done } }))) throw new Halted();
  }

  const results = approved.map((item) => done[item.id]).filter(Boolean);
  return {
    outcome: null,
    output: { applied: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results },
  };
}

async function runNode(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  switch (node.type) {
    case 'start':
      return { outcome: null, output: ctx.run.input };
    case 'end':
      return { outcome: null, output: null };
    case 'branch': {
      const result = evaluateCondition(node.config, ctx.scope);
      return { outcome: result ? 'true' : 'false', output: { result } };
    }
    case 'tool':
      return runTool(node, ctx);
    case 'agent':
      return runAgent(node, ctx);
    case 'review':
      return runReview(node, ctx);
    case 'apply':
      return runApply(node, ctx);
    default:
      throw new Error(`"${String(node.type)}" is not a kind of step.`);
  }
}

export async function advanceRun(runId: string, owner: string, deps: EngineDeps): Promise<AdvanceResult> {
  const { store } = deps;
  const loaded = await store.load(runId, owner);
  if (loaded === null) throw new Error(`Workflow run ${runId} was not found.`);
  if (loaded === 'done') return { status: 'DONE', steps: 0 };
  if (loaded === 'busy') throw new RunBusyError();

  const run = loaded;
  const graph = asGraph(run.graph);
  const scope: RunScope = { input: run.input, steps: { ...run.context } };
  const steps = new Map(run.steps.map((step) => [step.nodeId, step]));
  let ran = 0;

  const fail = async (nodeId: string | null, error: string): Promise<AdvanceResult> => {
    await store.event(runId, nodeId, 'run.failed', 'SYSTEM', null, error);
    await store.saveRun(runId, owner, { status: 'FAILED', error }, true);
    return { status: 'FAILED', steps: ran, error };
  };

  const problems = validateGraph(graph, deps.tools.names());
  if (problems.length > 0) return fail(problems[0].nodeId, `This version of the workflow cannot run. ${problems[0].message}`);

  let node = (run.currentNode && graph.nodes.find((candidate) => candidate.id === run.currentNode)) || graph.nodes.find((candidate) => candidate.type === 'start');
  if (!node) return fail(null, 'The workflow has no Start step.');
  if ((await store.saveRun(runId, owner, { status: 'RUNNING', currentNode: node.id })) !== 'RUNNING') {
    await store.saveRun(runId, owner, {}, true);
    return { status: 'CANCELLED', steps: ran };
  }

  for (;;) {
    const step = steps.get(node.id);
    let outcome: string | null;

    if (step && (step.status === 'SUCCEEDED' || step.status === 'SKIPPED')) {
      // Finished on an earlier pass. Its stored output is already in the scope.
      outcome = step.outcome;
    } else {
      if (!step || step.status === 'FAILED') {
        const held = await store.saveStep(runId, owner, node.id, { nodeType: node.type, nodeLabel: node.label, status: 'RUNNING', error: null, countAttempt: true });
        if (!held) return { status: 'CANCELLED', steps: ran };
        if (node.type !== 'start' && node.type !== 'end') await store.event(runId, node.id, 'step.started', 'SYSTEM', null, `Started "${node.label}"`);
      }

      let result: StepOutcome;
      try {
        result = await runNode(node, { run, graph, scope, owner, deps, step });
      } catch (error) {
        if (error instanceof Halted) return { status: 'CANCELLED', steps: ran };
        const text = message(error);
        await store.saveStep(runId, owner, node.id, { status: 'FAILED', error: text });
        return fail(node.id, `"${node.label}" failed. ${text}`);
      }

      if (result.wait) {
        await store.saveStep(runId, owner, node.id, { status: 'WAITING' });
        await store.saveRun(runId, owner, { status: 'WAITING', currentNode: node.id }, true);
        return { status: 'WAITING', steps: ran, waitingOn: result.reason };
      }

      outcome = result.outcome;
      scope.steps[node.id] = result.output;
      ran += 1;
      const held = await store.saveStep(runId, owner, node.id, { status: 'SUCCEEDED', outcome, output: result.output, state: null });
      if (!held) return { status: 'CANCELLED', steps: ran };
      await store.saveRun(runId, owner, { context: { [node.id]: result.output } });
      if (node.type !== 'start' && node.type !== 'end') {
        await store.event(runId, node.id, 'step.finished', 'SYSTEM', null, outcome ? `Finished "${node.label}": ${outcome}` : `Finished "${node.label}"`);
      }
    }

    if (node.type === 'end') {
      await store.event(runId, node.id, 'run.finished', 'SYSTEM', null, 'Run finished');
      await store.saveRun(runId, owner, { status: 'SUCCEEDED', currentNode: node.id }, true);
      return { status: 'SUCCEEDED', steps: ran };
    }

    const next = nextNode(graph, node.id, outcome);
    if (!next) return fail(node.id, `Nothing follows "${node.label}"${outcome ? ` when the outcome is "${outcome}"` : ''}.`);
    if ((await store.saveRun(runId, owner, { currentNode: next.id })) !== 'RUNNING') {
      await store.saveRun(runId, owner, {}, true);
      return { status: 'CANCELLED', steps: ran };
    }
    node = next;
  }
}
