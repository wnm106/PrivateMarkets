import { agentCodeOf, agentReviewActivity, type AgentDef } from '@tapestrai/graphql/src/lib/workflow-agents';
import {
  asGraph,
  evaluateCondition,
  isReadTool,
  nextNode,
  reaches,
  resolveTemplates,
  reviewRouting,
  splitTargets,
  validateGraph,
  type ReviewRouting,
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
import { exitCheckFor, stageScreen } from '@tapestrai/graphql/src/lib/workflow-screens';

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
  /** Who the review was given to, by name. Only set when it is opened. */
  assignees?: string[];
  /** People the step named who could not be given it, and why. Only set when it is opened. */
  unassignable?: Array<{ person: string; reason: string }>;
  dueAt?: string | null;
  /** STEP when the step named who reviews, RESPONSIBILITY when it went to the people responsible for the records. */
  assignmentSource?: string | null;
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
  openReview(runId: string, nodeId: string, title: string, instructions: string, summary: string, proposal: unknown, routing: ReviewRouting): Promise<ReviewRow>;
  /** Starts one child run per input. Returns their ids. Calling it again returns the same children. */
  spawn(runId: string, inputs: Array<Record<string, unknown>>): Promise<string[]>;
  /** Opens the step's form, or returns the one already open. A new external form carries its link token, once. */
  openForm(runId: string, nodeId: string, spec: Record<string, unknown>): Promise<FormRow>;
  /** Opens the step's stage, or returns the one already there. */
  openStage(runId: string, nodeId: string, spec: Record<string, unknown>): Promise<StageRow>;
  /** Hands a finished stage back to the person, with the reason. */
  returnStage(stageId: string, reason: string): Promise<void>;
}

export interface StageRow {
  id: string;
  status: string;
  outcome: string | null;
  result: Record<string, unknown>;
  args: Record<string, unknown>;
  completedBy: string | null;
}

export interface FormRow {
  id: string;
  status: string;
  answers: Record<string, unknown> | null;
  note: string | null;
  created: boolean;
  token: string | null;
  externalEmail: string | null;
  title: string;
  submittedBy: string | null;
}

/** A request to one of the client's connections. */
export interface HttpCall {
  clientId: string;
  connection: string;
  method: string;
  path: string;
  body: unknown;
}

/**
 * What sends data outside the platform. Each throws with a reason when it
 * cannot send. Left out, the steps that need it fail and say so.
 */
export interface Outbound {
  http(call: HttpCall): Promise<{ status: number; body: unknown }>;
  email(to: string[], subject: string, text: string): Promise<void>;
  slack(clientId: string, text: string): Promise<void>;
  /** The full address of a form's private link. */
  formLink(token: string): string;
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
  /** The named agent the step runs as, when it names one. */
  agent?: AgentDef | null;
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
  outbound?: Outbound;
  /** The named agent with this code for a client: its own, or else the shared one. Null when there is none. */
  agents?(clientId: string, code: string): Promise<AgentDef | null>;
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

type StepOutcome = { wait: true; reason: string } | { wait?: false; outcome: string | null; output: unknown; finish?: boolean };

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

  // A step that names an agent runs as it, or not at all.
  const agentCode = agentCodeOf(node.config);
  let agent: AgentDef | null = null;
  if (agentCode) {
    if (!ctx.deps.agents) throw new Error(`This step runs as the agent "${agentCode}", and this worker cannot look agents up.`);
    agent = await ctx.deps.agents(ctx.run.clientId, agentCode);
    if (!agent) throw new Error(`There is no agent with the code "${agentCode}" for this client. Choose another on the step, or create it under Admin, Agents.`);
    if (!agent.isActive) throw new Error(`The agent ${agent.name} is switched off. Switch it on under Admin, Agents, or choose another on the step.`);
    if (!ctx.step?.state) {
      await store.event(ctx.run.id, node.id, 'agent.identity', 'AGENT', null, `Running as ${agent.name}`, {
        agentCode: agent.code,
        activityCodes: agent.activityCodes,
        domainCodes: agent.domainCodes,
        shared: agent.shared,
      });
    }
  }

  const result = await ctx.deps.agent({
    node,
    scope: ctx.scope,
    actor,
    agent,
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
  return {
    outcome: null,
    output: { summary: result.summary, proposal, counts, ...(agent ? { agent: { code: agent.code, name: agent.name, activityCodes: agent.activityCodes } } : {}) },
  };
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
    // A review that names no activity is routed by the activity of the agent whose proposal it is.
    const routing = reviewRouting(node.config, ctx.scope);
    const by = record(source.agent);
    if (!routing.activity) {
      routing.activity = agentReviewActivity({ activityCodes: Array.isArray(by.activityCodes) ? by.activityCodes.map(String) : [] });
    }
    // The stored proposal says which named agent it came from, so the reviewer is told.
    const stored = typeof by.code === 'string' && by.code ? { ...proposal, agent: { code: by.code, name: typeof by.name === 'string' && by.name ? by.name : by.code } } : proposal;
    review = await store.openReview(
      ctx.run.id,
      node.id,
      String(node.config.title || node.label || 'Review'),
      String(node.config.instructions || ''),
      typeof source.summary === 'string' ? source.summary : '',
      stored,
      routing,
    );
    if (review.status === 'OPEN') {
      const counts = proposalCounts(proposal);
      const names = review.assignees || [];
      const who = names.length > 0 ? names.join(', ') : 'a person';
      const owners = review.assignmentSource === 'RESPONSIBILITY' && names.length > 0;
      const why = owners ? `, who ${names.length === 1 ? 'is' : 'are'} responsible for these records,` : '';
      await store.event(ctx.run.id, node.id, 'review.requested', 'SYSTEM', null, `Waiting for ${who}${why} to review ${counts.total} proposed change${counts.total === 1 ? '' : 's'}`, {
        reviewId: review.id,
        counts,
        assignees: names,
        dueAt: review.dueAt ?? null,
        ...(owners ? { assignmentSource: 'RESPONSIBILITY' } : {}),
      });
      if (review.unassignable && review.unassignable.length > 0) {
        await store.event(
          ctx.run.id,
          node.id,
          'review.unassignable',
          'SYSTEM',
          null,
          `${review.unassignable.length} of the people this review names could not be given it`,
          { unassignable: review.unassignable },
        );
      }
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

/** The most records one run can be split into. */
export const MAX_CHILD_RUNS = 500;

/**
 * A Start step set to run once per record: the chosen records become child
 * runs, one each, and this run ends. A child (it has parentRunId) runs as usual.
 */
async function runStart(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  if (node.config.runPerRecord !== true || ctx.run.input.parentRunId) return { outcome: null, output: ctx.run.input };
  const filters = record(ctx.run.input.filters);
  if (Object.keys(filters).length === 0) throw new Error('This workflow runs once per record, so a run needs records chosen.');
  const actor: Actor = { userId: ctx.run.startedBy, clientId: ctx.run.clientId };
  const found = record(await ctx.deps.tools.run('find_records', { ...filters, limit: MAX_CHILD_RUNS }, actor, 'read'));
  const ids = (Array.isArray(found.entityIds) ? found.entityIds : []).map(String);
  if (ids.length === 0) return { outcome: null, output: { children: [], note: 'The filters chose no records, so no runs were started.' }, finish: true };
  const { filters: _drop, ...rest } = ctx.run.input;
  const children = await ctx.deps.store.spawn(
    ctx.run.id,
    ids.map((entityId) => ({ ...rest, filters: { entityIds: [entityId] } })),
  );
  await ctx.deps.store.event(ctx.run.id, node.id, 'run.split', 'SYSTEM', null, `Started ${children.length} run${children.length === 1 ? '' : 's'}, one for each record`, {
    children,
    ...(typeof found.note === 'string' ? { note: found.note } : {}),
  });
  return { outcome: null, output: { children, records: ids.length }, finish: true };
}

function fieldsOf(node: WorkflowNode): Array<Record<string, unknown>> {
  return (Array.isArray(node.config.fields) ? node.config.fields : []).filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object');
}

async function runForm(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const { store } = ctx.deps;
  const config = record(resolveTemplates(node.config, ctx.scope));
  const form = await store.openForm(ctx.run.id, node.id, {
    title: config.title || node.label,
    instructions: config.instructions || '',
    fields: fieldsOf(node),
    people: Array.isArray(config.people) ? config.people : [],
    roles: Array.isArray(config.roles) ? config.roles : [],
    external: node.config.external === true,
    externalEmail: config.externalEmail || '',
    dueInHours: config.dueInHours ?? null,
  });
  if (form.created && form.token && form.externalEmail) {
    const outbound = ctx.deps.outbound;
    const link = outbound ? outbound.formLink(form.token) : null;
    let sent = false;
    if (outbound && link) {
      try {
        await outbound.email([form.externalEmail], form.title, [
          'Hello,',
          '',
          `You have been asked to fill in "${form.title}".`,
          ...(typeof config.instructions === 'string' && config.instructions ? ['', config.instructions] : []),
          '',
          `Open the form: ${link}`,
          '',
          'The link works once and expires in 14 days.',
        ].join('\n'));
        sent = true;
      } catch (error) {
        await store.event(ctx.run.id, node.id, 'form.not_sent', 'SYSTEM', null, `The link could not be emailed to ${form.externalEmail}. ${message(error)}`);
      }
    }
    // Kept in the run's history so someone in the firm can pass it on when it was not emailed.
    await store.event(ctx.run.id, node.id, 'form.link', 'SYSTEM', null, sent ? `Emailed the form's link to ${form.externalEmail}` : `Send this link to ${form.externalEmail}`, {
      link: link || `/portal/${form.token}`,
      emailed: sent,
    });
  }
  if (form.status === 'OPEN') return { wait: true, reason: node.id };
  if (form.status === 'CANCELLED') throw new Error('The form was cancelled.');
  const outcome = form.status === 'SUBMITTED' ? 'submitted' : 'declined';
  return { outcome, output: { outcome, answers: form.answers || {}, note: form.note, formId: form.id, answeredBy: form.submittedBy || form.externalEmail } };
}

/**
 * A stage waits on a person at one screen. When they leave it, the screen may
 * say what has to be true first. That is asked here, of a read-only tool, and
 * not taken from the page: a stage left in a state that does not hold up is
 * handed back with the reason, and the run waits on it again.
 */
async function runStage(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const { store } = ctx.deps;
  const config = record(resolveTemplates(node.config, ctx.scope));
  const screen = stageScreen(config.screen);
  if (!screen) throw new Error(`"${String(config.screen || '')}" is not a screen a stage can show.`);
  const stage = await store.openStage(ctx.run.id, node.id, {
    screen: screen.code,
    title: config.title || node.label,
    instructions: config.instructions || '',
    args: record(config.args),
    outcomes: screen.outcomes,
    permissions: screen.permissions,
    people: Array.isArray(config.people) ? config.people : [],
    roles: Array.isArray(config.roles) ? config.roles : [],
    dueInHours: config.dueInHours ?? null,
  });
  if (stage.status === 'OPEN') return { wait: true, reason: node.id };
  if (stage.status === 'CANCELLED') throw new Error('The stage was cancelled.');

  const exit = exitCheckFor(screen, stage.outcome);
  if (exit) {
    const actor: Actor = { userId: ctx.run.startedBy, clientId: ctx.run.clientId };
    const found = await ctx.deps.tools.run(exit.tool, exit.args(stage.args, stage.result), actor, 'read');
    const problem = exit.problem(found, stage.result);
    if (problem) {
      await store.returnStage(stage.id, problem);
      return { wait: true, reason: node.id };
    }
  }
  return { outcome: stage.outcome, output: { outcome: stage.outcome, result: stage.result, stageId: stage.id, completedBy: stage.completedBy } };
}

async function runHttp(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const outbound = ctx.deps.outbound;
  if (!outbound) throw new Error('This worker cannot call connections.');
  const method = String(node.config.method || 'POST').toUpperCase();
  if (method !== 'GET' && node.config.allowSend !== true) throw new Error('This step sends data outside the platform and is not allowed to.');
  const path = String(resolveTemplates(node.config.path || '', ctx.scope) ?? '');
  const body = method === 'GET' ? undefined : resolveTemplates(node.config.body ?? {}, ctx.scope);
  const connection = String(node.config.connection || '');
  const result = await outbound.http({ clientId: ctx.run.clientId, connection, method, path, body });
  await ctx.deps.store.event(ctx.run.id, node.id, 'http.called', 'SYSTEM', ctx.run.startedBy, `${method} ${connection}${path}: ${result.status}`, { connection, method, path, status: result.status });
  return { outcome: null, output: clampOutput(result) };
}

/** Email addresses from a setting: a list, a comma-separated string, or a placeholder for either. */
export function emailList(value: unknown): string[] {
  const flat = (Array.isArray(value) ? value : [value]).flat(2);
  const out: string[] = [];
  for (const item of flat) {
    for (const part of String(item ?? '').split(/[\s,;]+/)) {
      const address = part.trim().toLowerCase();
      if (address && !out.includes(address)) out.push(address);
    }
  }
  return out;
}

async function runMessage(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  const outbound = ctx.deps.outbound;
  if (!outbound) throw new Error('This worker cannot send messages.');
  if (node.config.allowSend !== true) throw new Error('This step sends a message outside the platform and is not allowed to.');
  const text = String(resolveTemplates(node.config.body || '', ctx.scope) ?? '');
  if (!text.trim()) throw new Error('The message is empty once the run\'s values are filled in.');
  if (node.config.channel === 'slack') {
    await outbound.slack(ctx.run.clientId, text);
    await ctx.deps.store.event(ctx.run.id, node.id, 'message.sent', 'SYSTEM', ctx.run.startedBy, 'Posted to Slack', { channel: 'slack' });
    return { outcome: null, output: { channel: 'slack', sent: true } };
  }
  const to = emailList(resolveTemplates(node.config.to, ctx.scope));
  const bad = to.filter((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address));
  if (to.length === 0) throw new Error('There is nobody to email once the run\'s values are filled in.');
  if (bad.length > 0) throw new Error(`Not an email address: ${bad.join(', ')}.`);
  if (to.length > 50) throw new Error('A message step emails at most 50 people.');
  const subject = String(resolveTemplates(node.config.subject || node.label, ctx.scope) ?? node.label).slice(0, 200);
  await outbound.email(to, subject, text);
  await ctx.deps.store.event(ctx.run.id, node.id, 'message.sent', 'SYSTEM', ctx.run.startedBy, `Emailed ${to.join(', ')}`, { channel: 'email', to, subject });
  return { outcome: null, output: { channel: 'email', to, subject, sent: true } };
}

async function runNode(node: WorkflowNode, ctx: StepContext): Promise<StepOutcome> {
  switch (node.type) {
    case 'start':
      return runStart(node, ctx);
    case 'parallel':
      return { outcome: null, output: { paths: splitTargets(ctx.graph, node.id).map((target) => target.id) } };
    case 'join':
      return { outcome: null, output: { joined: ctx.graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from) } };
    case 'form':
      return runForm(node, ctx);
    case 'stage':
      return runStage(node, ctx);
    case 'http':
      return runHttp(node, ctx);
    case 'message':
      return runMessage(node, ctx);
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

/** Where a run's paths stand, kept in its context between passes. */
const PATHS = '_paths';
interface Paths {
  /** Steps to run next, including ones waiting for a person. */
  active: string[];
  /** Joins some path has reached, waiting for the paths that can still reach them. */
  parked: string[];
  /** A path has reached End. */
  ended: boolean;
}

function readPaths(value: unknown): Paths | null {
  const raw = record(value);
  if (!Array.isArray(raw.active)) return null;
  return {
    active: raw.active.map(String),
    parked: Array.isArray(raw.parked) ? raw.parked.map(String) : [],
    ended: raw.ended === true,
  };
}

/**
 * Walks the run. With no Split in the graph this is one path, step by step.
 * A Split starts every path leaving it; each goes on by itself, and one that
 * waits for a person does not hold up the others. A Join goes on once no path
 * still running can reach it. The run waits when every path left is waiting,
 * and finishes when no path is left and one reached End.
 */
export async function advanceRun(runId: string, owner: string, deps: EngineDeps): Promise<AdvanceResult> {
  const { store } = deps;
  const loaded = await store.load(runId, owner);
  if (loaded === null) throw new Error(`Workflow run ${runId} was not found.`);
  if (loaded === 'done') return { status: 'DONE', steps: 0 };
  if (loaded === 'busy') throw new RunBusyError();

  const run = loaded;
  const graph = asGraph(run.graph);
  const { [PATHS]: savedPaths, ...stepOutputs } = run.context;
  const scope: RunScope = { input: run.input, steps: { ...stepOutputs } };
  const steps = new Map(run.steps.map((step) => [step.nodeId, step]));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let ran = 0;

  const fail = async (nodeId: string | null, error: string): Promise<AdvanceResult> => {
    await store.event(runId, nodeId, 'run.failed', 'SYSTEM', null, error);
    await store.saveRun(runId, owner, { status: 'FAILED', error }, true);
    return { status: 'FAILED', steps: ran, error };
  };

  const problems = validateGraph(graph, deps.tools.names());
  if (problems.length > 0) return fail(problems[0].nodeId, `This version of the workflow cannot run. ${problems[0].message}`);

  const startNode = graph.nodes.find((candidate) => candidate.type === 'start');
  if (!startNode) return fail(null, 'The workflow has no Start step.');
  const resumed = readPaths(savedPaths);
  const first = (run.currentNode && byId.get(run.currentNode)) || startNode;
  const paths: Paths = resumed && resumed.active.length + resumed.parked.length > 0 ? resumed : { active: [first.id], parked: [], ended: false };
  const waiting: string[] = [];
  let lastNode: string | null = paths.active[0] ?? null;

  if ((await store.saveRun(runId, owner, { status: 'RUNNING', currentNode: paths.active[0] ?? first.id })) !== 'RUNNING') {
    await store.saveRun(runId, owner, {}, true);
    return { status: 'CANCELLED', steps: ran };
  }

  const savePaths = () => store.saveRun(runId, owner, { context: { [PATHS]: { active: [...waiting, ...paths.active], parked: paths.parked, ended: paths.ended } } });
  // A Join goes on once no step still to run, or waiting, can reach it.
  const releaseJoins = () => {
    for (const joinId of [...paths.parked]) {
      const heads = [...paths.active, ...waiting];
      if (!heads.some((head) => head !== joinId && reaches(graph, head, joinId))) {
        paths.parked = paths.parked.filter((id) => id !== joinId);
        paths.active.push(joinId);
      }
    }
  };
  const enqueue = (target: WorkflowNode) => {
    if (target.type === 'join') {
      if (!paths.parked.includes(target.id) && !paths.active.includes(target.id) && steps.get(target.id)?.status !== 'SUCCEEDED') paths.parked.push(target.id);
    } else if (!paths.active.includes(target.id) && !waiting.includes(target.id)) {
      paths.active.push(target.id);
    }
  };

  for (;;) {
    if (paths.active.length === 0) {
      releaseJoins();
      if (paths.active.length === 0) {
        if (waiting.length > 0) {
          await store.saveRun(runId, owner, { status: 'WAITING', currentNode: waiting[0], context: { [PATHS]: { active: waiting, parked: paths.parked, ended: paths.ended } } }, true);
          return { status: 'WAITING', steps: ran, waitingOn: waiting.join(',') };
        }
        if (paths.ended) {
          await store.event(runId, null, 'run.finished', 'SYSTEM', null, 'Run finished');
          await store.saveRun(runId, owner, { status: 'SUCCEEDED', context: { [PATHS]: { active: [], parked: [], ended: true } } }, true);
          return { status: 'SUCCEEDED', steps: ran };
        }
        return fail(lastNode, 'Every path stopped before reaching End.');
      }
    }

    const node = byId.get(paths.active.shift() as string);
    if (!node) return fail(null, 'A path points at a step that is not in this version.');
    lastNode = node.id;
    if ((await store.saveRun(runId, owner, { currentNode: node.id })) !== 'RUNNING') {
      await store.saveRun(runId, owner, {}, true);
      return { status: 'CANCELLED', steps: ran };
    }

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
        waiting.push(node.id);
        releaseJoins();
        await savePaths();
        continue;
      }

      outcome = result.outcome;
      scope.steps[node.id] = result.output;
      steps.set(node.id, { nodeId: node.id, status: 'SUCCEEDED', outcome, output: result.output, state: null });
      ran += 1;
      const held = await store.saveStep(runId, owner, node.id, { status: 'SUCCEEDED', outcome, output: result.output, state: null });
      if (!held) return { status: 'CANCELLED', steps: ran };
      await store.saveRun(runId, owner, { context: { [node.id]: result.output } });
      if (node.type !== 'start' && node.type !== 'end') {
        await store.event(runId, node.id, 'step.finished', 'SYSTEM', null, outcome ? `Finished "${node.label}": ${outcome}` : `Finished "${node.label}"`);
      }

      if (result.finish) {
        // The run's work was handed on (it was split by record). Nothing after this runs.
        await store.event(runId, node.id, 'run.finished', 'SYSTEM', null, 'Run finished');
        await store.saveRun(runId, owner, { status: 'SUCCEEDED', context: { [PATHS]: { active: [], parked: [], ended: true } } }, true);
        return { status: 'SUCCEEDED', steps: ran };
      }
    }

    if (node.type === 'end') {
      paths.ended = true;
    } else if (node.type === 'parallel') {
      for (const target of splitTargets(graph, node.id)) enqueue(target);
    } else {
      const next = nextNode(graph, node.id, outcome);
      if (!next) return fail(node.id, `Nothing follows "${node.label}"${outcome ? ` when the outcome is "${outcome}"` : ''}.`);
      enqueue(next);
    }
    releaseJoins();
    await savePaths();
  }
}
