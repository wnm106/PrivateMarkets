/**
 * The workflow graph: what a workflow is made of, whether a graph is sound, and
 * which step follows which. Pure, so the editor, the API, and the worker all
 * read a graph the same way.
 *
 * A workflow is a directed graph with no loops. A run walks one path through it.
 * Three kinds of step:
 *   fixed   the same thing every time: call a tool, test a condition, apply approved changes
 *   agent   a model works toward a goal with read-only tools, and proposes changes
 *   human   the run waits for a person to review what was proposed, answer a form, or work through a screen
 */

import { STAGE_SCREENS, stageScreen } from './workflow-screens';

export type NodeType = 'start' | 'tool' | 'agent' | 'review' | 'apply' | 'branch' | 'parallel' | 'join' | 'http' | 'message' | 'form' | 'stage' | 'end';
export type NodeKind = 'fixed' | 'agent' | 'human';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** The outcome this edge follows. Omitted means any outcome. */
  when?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface NodeTypeDef {
  type: NodeType;
  label: string;
  kind: NodeKind;
  description: string;
  /** Outcomes a step of this type can end with. Empty means it has one way out. */
  outcomes: string[];
  defaultConfig: Record<string, unknown>;
}

export const NODE_TYPES: readonly NodeTypeDef[] = [
  { type: 'start', label: 'Start', kind: 'fixed', description: 'Where a run begins. Its output is the input the run was started with.', outcomes: [], defaultConfig: {} },
  {
    type: 'tool',
    label: 'Run a tool',
    kind: 'fixed',
    description: 'Calls one platform tool with fixed settings. The same call every run.',
    outcomes: [],
    defaultConfig: { tool: '', args: {}, allowWrite: false },
  },
  {
    type: 'agent',
    label: 'Agent',
    kind: 'agent',
    description: 'A model investigates with read-only tools and proposes changes. It cannot change data itself.',
    outcomes: [],
    defaultConfig: { instructions: '', tools: [], proposable: [], maxRounds: 24, provider: 'claude' },
  },
  {
    type: 'review',
    label: 'Human review',
    kind: 'human',
    description: 'Pauses the run until a person approves or rejects the changes an agent step proposed.',
    outcomes: ['approved', 'rejected'],
    defaultConfig: { source: '', title: 'Review proposed changes', instructions: '', skipWhenEmpty: true, people: [], roles: [], separateReviewer: true },
  },
  {
    type: 'apply',
    label: 'Apply approved changes',
    kind: 'fixed',
    description: 'Makes the changes a person approved in a review step, signed with that person\'s name.',
    outcomes: [],
    defaultConfig: { review: '' },
  },
  {
    type: 'branch',
    label: 'Condition',
    kind: 'fixed',
    description: 'Tests a value from an earlier step and takes the true or the false path.',
    outcomes: ['true', 'false'],
    defaultConfig: { path: '', op: 'truthy', value: null },
  },
  {
    type: 'parallel',
    label: 'Split',
    kind: 'fixed',
    description: 'Starts every path that leaves it. The paths go on side by side: one waiting for a person does not hold up the others.',
    outcomes: [],
    defaultConfig: {},
  },
  {
    type: 'join',
    label: 'Join',
    kind: 'fixed',
    description: 'Waits until no path that could still reach it is running, then goes on once.',
    outcomes: [],
    defaultConfig: {},
  },
  {
    type: 'form',
    label: 'Ask for information',
    kind: 'human',
    description: 'Asks a person for values on a form and waits for the answer. The form can go to someone outside the firm by a private link.',
    outcomes: ['submitted', 'declined'],
    defaultConfig: { title: 'Information needed', instructions: '', fields: [], people: [], roles: [], external: false, externalEmail: '', dueInHours: null },
  },
  {
    type: 'stage',
    label: 'Stage',
    kind: 'human',
    description: 'Puts one screen in front of a person and waits until they leave it. The screen decides the outcomes, and what must be true before the run goes on.',
    outcomes: [],
    defaultConfig: { screen: '', title: '', instructions: '', args: {}, people: [], roles: [], dueInHours: null },
  },
  {
    type: 'http',
    label: 'Call a connection',
    kind: 'fixed',
    description: 'Sends a request to one of the client\'s connections, with its stored credentials. Only connection addresses can be called.',
    outcomes: [],
    defaultConfig: { connection: '', method: 'POST', path: '', body: {}, allowSend: false },
  },
  {
    type: 'message',
    label: 'Send a message',
    kind: 'fixed',
    description: 'Sends an email or a Slack message written from the run. Use it after a review when what is sent needs approving.',
    outcomes: [],
    defaultConfig: { channel: 'email', to: [], subject: '', body: '', allowSend: false },
  },
  { type: 'end', label: 'End', kind: 'fixed', description: 'The run finishes here.', outcomes: [], defaultConfig: {} },
];

/** The outcomes a step can end with. A Stage step takes them from its screen; every other step from its type. */
export function outcomesOf(node: WorkflowNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'stage') return stageScreen(node.config.screen)?.outcomes || [];
  return nodeTypeDef(node.type)?.outcomes || [];
}

/** Whether `to` can be reached from `from` by following connections. */
export function reaches(graph: WorkflowGraph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to);
  }
  return false;
}

/** The steps a Split starts: every connection leaving it. */
export function splitTargets(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  const ids = [...new Set(graph.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to))];
  return ids.map((id) => graph.nodes.find((node) => node.id === id)).filter((node): node is WorkflowNode => Boolean(node));
}

export function nodeTypeDef(type: string): NodeTypeDef | null {
  return NODE_TYPES.find((def) => def.type === type) || null;
}

export function nodeKind(type: string): NodeKind {
  return nodeTypeDef(type)?.kind || 'fixed';
}

/**
 * Tools that only read. An agent step may call these and nothing else; anything
 * not listed here changes data and has to go through a review.
 */
const READ_TOOL = /^(get_|list_|search_|find_|preview_|analyze_|compare_|validate_|parse_|query_data$)/;

export function isReadTool(name: string): boolean {
  return READ_TOOL.test(name);
}

export function asGraph(value: unknown): WorkflowGraph {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];
  return {
    nodes: nodes
      .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object')
      .map((node) => {
        const position = node.position && typeof node.position === 'object' ? (node.position as Record<string, unknown>) : {};
        return {
          id: String(node.id ?? ''),
          type: String(node.type ?? '') as NodeType,
          label: typeof node.label === 'string' ? node.label : '',
          position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
          config: node.config && typeof node.config === 'object' && !Array.isArray(node.config) ? (node.config as Record<string, unknown>) : {},
        };
      }),
    edges: edges
      .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === 'object')
      .map((edge, index) => ({
        id: String(edge.id ?? `e${index}`),
        from: String(edge.from ?? ''),
        to: String(edge.to ?? ''),
        ...(typeof edge.when === 'string' && edge.when ? { when: edge.when } : {}),
      })),
  };
}

export interface GraphProblem {
  nodeId: string | null;
  message: string;
}

/** Every step that can be reached before `nodeId` on some path. */
export function upstreamOf(graph: WorkflowGraph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of graph.edges) {
      if (edge.to === current && !seen.has(edge.from)) {
        seen.add(edge.from);
        stack.push(edge.from);
      }
    }
  }
  return seen;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const edge of graph.edges) {
      if (edge.from === id && visit(edge.to)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((node) => visit(node.id));
}

/**
 * What is wrong with a graph. Empty means it can be published. toolNames, when
 * given, is the set of tools that exist, so a misspelt tool is caught here
 * rather than halfway through a run.
 */
export function validateGraph(graph: WorkflowGraph, toolNames?: ReadonlySet<string>): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (!node.id) problems.push({ nodeId: null, message: 'A step has no id.' });
    else if (byId.has(node.id)) problems.push({ nodeId: node.id, message: `Two steps share the id "${node.id}".` });
    else byId.set(node.id, node);
    if (!nodeTypeDef(node.type)) problems.push({ nodeId: node.id, message: `"${node.type}" is not a kind of step.` });
    if (!node.label.trim()) problems.push({ nodeId: node.id, message: 'Give this step a name.' });
  }

  const starts = graph.nodes.filter((node) => node.type === 'start');
  if (starts.length !== 1) problems.push({ nodeId: null, message: 'A workflow needs exactly one Start step.' });
  if (!graph.nodes.some((node) => node.type === 'end')) problems.push({ nodeId: null, message: 'A workflow needs an End step.' });

  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      problems.push({ nodeId: null, message: 'A connection points at a step that does not exist.' });
    }
  }
  if (problems.length > 0) return problems;

  if (hasCycle(graph)) {
    problems.push({ nodeId: null, message: 'The steps form a loop. A workflow runs each step once.' });
    return problems;
  }

  const start = starts[0];
  const reachable = new Set<string>([start.id]);
  const stack = [start.id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of graph.edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        stack.push(edge.to);
      }
    }
  }

  for (const node of graph.nodes) {
    const out = graph.edges.filter((edge) => edge.from === node.id);
    const def = nodeTypeDef(node.type) as NodeTypeDef;
    if (!reachable.has(node.id)) problems.push({ nodeId: node.id, message: 'Nothing leads to this step.' });
    if (node.type === 'start' && graph.edges.some((edge) => edge.to === node.id)) {
      problems.push({ nodeId: node.id, message: 'Nothing can lead back to Start.' });
    }
    if (node.type === 'end') {
      if (out.length > 0) problems.push({ nodeId: node.id, message: 'Nothing can follow End.' });
      continue;
    }
    if (out.length === 0) problems.push({ nodeId: node.id, message: 'This step leads nowhere. Connect it to the next step or to End.' });

    const outcomes = outcomesOf(node);
    if (outcomes.length > 0) {
      for (const edge of out) {
        if (edge.when && !outcomes.includes(edge.when)) {
          problems.push({ nodeId: node.id, message: `"${edge.when}" is not an outcome of this step. Use ${outcomes.join(' or ')}.` });
        }
      }
      const any = out.some((edge) => !edge.when);
      for (const outcome of outcomes) {
        const count = out.filter((edge) => edge.when === outcome).length;
        if (count > 1) problems.push({ nodeId: node.id, message: `More than one connection follows "${outcome}".` });
        if (count === 0 && !any) problems.push({ nodeId: node.id, message: `Nothing follows when the outcome is "${outcome}".` });
      }
    } else if (node.type === 'parallel') {
      if (out.length < 2) problems.push({ nodeId: node.id, message: 'A Split starts two or more paths. Connect it to each.' });
      if (out.some((edge) => edge.when)) problems.push({ nodeId: node.id, message: 'Every path from a Split is taken. Remove the outcomes on its connections.' });
    } else if (out.length > 1) {
      problems.push({ nodeId: node.id, message: 'This step has one outcome, so only one connection can leave it. Use a Condition to choose a path, or a Split to take several.' });
    }
    if (node.type === 'join' && graph.edges.filter((edge) => edge.to === node.id).length < 2) {
      problems.push({ nodeId: node.id, message: 'A Join brings two or more paths together. Connect each path into it.' });
    }
    if (node.type === 'http') {
      if (!String(node.config.connection || '').trim()) problems.push({ nodeId: node.id, message: 'Choose the connection this step calls.' });
      if (!['GET', 'POST', 'PUT', 'PATCH'].includes(String(node.config.method || 'POST').toUpperCase())) problems.push({ nodeId: node.id, message: 'The method is GET, POST, PUT, or PATCH.' });
      if (String(node.config.method || 'POST').toUpperCase() !== 'GET' && node.config.allowSend !== true) {
        problems.push({ nodeId: node.id, message: 'This step sends data outside the platform. Tick "This step sends data outside" to allow it.' });
      }
    }
    if (node.type === 'message') {
      if (!['email', 'slack'].includes(String(node.config.channel || ''))) problems.push({ nodeId: node.id, message: 'A message goes by email or to Slack.' });
      if (node.config.channel === 'email' && !(Array.isArray(node.config.to) ? node.config.to.length > 0 : String(node.config.to || '').trim())) {
        problems.push({ nodeId: node.id, message: 'Say who the email goes to.' });
      }
      if (!String(node.config.body || '').trim()) problems.push({ nodeId: node.id, message: 'Write the message.' });
      if (node.config.allowSend !== true) problems.push({ nodeId: node.id, message: 'This step sends a message outside the platform. Tick "This step sends data outside" to allow it.' });
    }
    if (node.type === 'stage') {
      const screen = stageScreen(node.config.screen);
      if (!screen) {
        problems.push({ nodeId: node.id, message: `Choose the screen this stage shows: ${STAGE_SCREENS.map((item) => item.label).join(', ')}.` });
      } else {
        const args = node.config.args && typeof node.config.args === 'object' ? (node.config.args as Record<string, unknown>) : {};
        for (const arg of screen.args) {
          if (!arg.optional && !String(args[arg.key] ?? '').trim()) problems.push({ nodeId: node.id, message: `"${screen.label}" needs ${arg.label.toLowerCase()}. ${arg.help}` });
        }
      }
    }
    if (node.type === 'form') {
      const fields = Array.isArray(node.config.fields) ? (node.config.fields as Array<Record<string, unknown>>) : [];
      if (fields.length === 0) problems.push({ nodeId: node.id, message: 'Add at least one field to the form.' });
      const keys = new Set<string>();
      for (const field of fields) {
        const key = String(field.key || '');
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) problems.push({ nodeId: node.id, message: `"${key}" is not a usable field key. Use letters, digits, and _.` });
        else if (keys.has(key)) problems.push({ nodeId: node.id, message: `Two fields share the key "${key}".` });
        keys.add(key);
        if (!['text', 'number', 'date', 'choice', 'yesno', 'longtext'].includes(String(field.type || 'text'))) problems.push({ nodeId: node.id, message: `"${key}" has a type the form does not know.` });
        if (field.type === 'choice' && !(Array.isArray(field.options) && field.options.length > 0)) problems.push({ nodeId: node.id, message: `"${key}" is a choice with nothing to choose from.` });
      }
      if (node.config.external === true && !String(node.config.externalEmail || '').trim()) {
        problems.push({ nodeId: node.id, message: 'Say who outside the firm the form goes to.' });
      }
    }

    const upstream = upstreamOf(graph, node.id);
    if (node.type === 'tool') {
      const tool = String(node.config.tool || '');
      if (!tool) problems.push({ nodeId: node.id, message: 'Choose the tool this step runs.' });
      else if (toolNames && !toolNames.has(tool)) problems.push({ nodeId: node.id, message: `There is no tool called "${tool}".` });
      else if (!isReadTool(tool) && node.config.allowWrite !== true) {
        problems.push({ nodeId: node.id, message: `"${tool}" changes data. Tick "This step may change data" to let it run without a review.` });
      }
    }
    if (node.type === 'agent') {
      if (!String(node.config.instructions || '').trim()) problems.push({ nodeId: node.id, message: 'Tell the agent what to do.' });
      const tools = Array.isArray(node.config.tools) ? node.config.tools.map(String) : [];
      for (const tool of tools) {
        if (toolNames && !toolNames.has(tool)) problems.push({ nodeId: node.id, message: `There is no tool called "${tool}".` });
        else if (!isReadTool(tool)) problems.push({ nodeId: node.id, message: `"${tool}" changes data. An agent reads and proposes; it cannot be given this tool.` });
      }
    }
    if (node.type === 'review') {
      const source = String(node.config.source || '');
      if (!source) problems.push({ nodeId: node.id, message: 'Choose the agent step whose proposal is reviewed.' });
      else if (byId.get(source)?.type !== 'agent' || !upstream.has(source)) {
        problems.push({ nodeId: node.id, message: 'The step being reviewed must be an agent step that runs before this one.' });
      }
      const due = node.config.dueInHours;
      const placeholder = typeof due === 'string' && WHOLE.test(due.trim());
      if (due !== undefined && due !== null && due !== '' && !placeholder && !(Number(due) > 0)) {
        problems.push({ nodeId: node.id, message: 'The time to review must be a number of hours above zero, or left blank.' });
      }
      const approvals = node.config.approvals;
      if (approvals !== undefined && approvals !== null && approvals !== '' && !(Number.isInteger(Number(approvals)) && Number(approvals) >= 1 && Number(approvals) <= 5)) {
        problems.push({ nodeId: node.id, message: 'Approvals needed must be a whole number from 1 to 5.' });
      }
      if (node.config.reassignWhenOverdue === true && (!Array.isArray(node.config.escalateRoles) || node.config.escalateRoles.length === 0 || !node.config.dueInHours)) {
        problems.push({ nodeId: node.id, message: 'Handing an overdue review on needs hours to review and at least one role under "Also tell when overdue".' });
      }
    }
    if (node.type === 'apply') {
      const review = String(node.config.review || '');
      if (!review) problems.push({ nodeId: node.id, message: 'Choose the review step whose approved changes are applied.' });
      else if (byId.get(review)?.type !== 'review' || !upstream.has(review)) {
        problems.push({ nodeId: node.id, message: 'Changes can only be applied after the review step that approved them.' });
      }
    }
    if (node.type === 'branch') {
      if (!String(node.config.path || '').trim()) problems.push({ nodeId: node.id, message: 'Choose the value this condition tests.' });
      if (!CONDITION_OPS.includes(String(node.config.op || '') as ConditionOp)) problems.push({ nodeId: node.id, message: 'Choose how the value is tested.' });
    }
  }
  return problems;
}

/** The step that follows `nodeId` for an outcome. An edge for that outcome wins over an edge for any outcome. */
export function nextNode(graph: WorkflowGraph, nodeId: string, outcome: string | null): WorkflowNode | null {
  const out = graph.edges.filter((edge) => edge.from === nodeId);
  const edge = (outcome ? out.find((candidate) => candidate.when === outcome) : undefined) || out.find((candidate) => !candidate.when);
  return edge ? graph.nodes.find((node) => node.id === edge.to) || null : null;
}

// ---------------------------------------------------------------------------
// Values from earlier steps
// ---------------------------------------------------------------------------

/** What a step can read: the run's input and the output of every step finished so far. */
export interface RunScope {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

/** Reads "input.limit" or "steps.scan.totalCount" from the scope. Undefined when any part is missing. */
export function readPath(scope: RunScope, path: string): unknown {
  let current: unknown = scope;
  for (const part of path.trim().split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const WHOLE = /^\{\{\s*([\w.-]+)\s*\}\}$/;
const INLINE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Fills {{path}} placeholders in a step's settings. A string that is only a
 * placeholder becomes the value itself, so a number stays a number. A missing
 * value becomes null (or an empty string inside longer text).
 */
export function resolveTemplates(value: unknown, scope: RunScope): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE);
    if (whole) {
      const found = readPath(scope, whole[1]);
      return found === undefined ? null : found;
    }
    return value.replace(INLINE, (_, path: string) => {
      const found = readPath(scope, path);
      if (found === undefined || found === null) return '';
      return typeof found === 'object' ? JSON.stringify(found) : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveTemplates(item, scope);
      // A setting that resolved to nothing is left out, so the tool uses its own default.
      if (resolved !== null && resolved !== '') result[key] = resolved;
    }
    return result;
  }
  return value;
}

export const CONDITION_OPS = ['truthy', 'empty', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === false || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function evaluateCondition(config: Record<string, unknown>, scope: RunScope): boolean {
  const left = readPath(scope, String(config.path || ''));
  const right = resolveTemplates(config.value, scope);
  switch (String(config.op || 'truthy')) {
    case 'truthy':
      return !isEmpty(left);
    case 'empty':
      return isEmpty(left);
    case 'eq':
      return String(left ?? '') === String(right ?? '');
    case 'ne':
      return String(left ?? '') !== String(right ?? '');
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Who a review is for
// ---------------------------------------------------------------------------

/** What a review step says about who decides it. The database holds the reviewer to it. */
export interface ReviewRouting {
  /** User ids. A setting may be a placeholder, such as {{input.reviewer}}. */
  people: string[];
  /** Role codes, held in the run's client. */
  roles: string[];
  /** The person who started the run may not decide it. On unless the step turns it off. */
  separateReviewer: boolean;
  /** Hours the reviewer has. Null for no due date. */
  dueInHours: number | null;
  /** Role codes also told when the review is overdue. */
  escalateRoles: string[];
  /** How many different people must approve. 1 to 5. */
  approvals: number;
  /** Hand an overdue review to the escalation roles, as well as telling them. */
  reassignWhenOverdue: boolean;
  /**
   * When the step names no people and no roles, give the review to the people
   * responsible for the records it changes. On unless the step turns it off.
   */
  routeToOwners: boolean;
  /** The activity whose owners are asked, such as RECONCILIATION. Null asks whoever is responsible, whatever for. */
  activity: string | null;
}

function textList(value: unknown): string[] {
  const flat = (Array.isArray(value) ? value : [value]).flat(2);
  const out: string[] = [];
  for (const item of flat) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    for (const part of String(item).split(',')) {
      const trimmed = part.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

/** Reads a review step's routing, filling placeholders from the run when a scope is given. */
export function reviewRouting(config: Record<string, unknown>, scope?: RunScope): ReviewRouting {
  const fill = (value: unknown) => (scope ? resolveTemplates(value, scope) : value);
  const hours = Number(fill(config.dueInHours));
  return {
    people: textList(fill(config.people)),
    roles: textList(fill(config.roles)).map((code) => code.toUpperCase()),
    separateReviewer: config.separateReviewer !== false,
    dueInHours: Number.isFinite(hours) && hours > 0 ? hours : null,
    escalateRoles: textList(fill(config.escalateRoles)).map((code) => code.toUpperCase()),
    approvals: Math.min(5, Math.max(1, Math.floor(Number(fill(config.approvals)) || 1))),
    reassignWhenOverdue: config.reassignWhenOverdue === true,
    routeToOwners: config.routeToOwners !== false,
    activity: textList(fill(config.activity))[0]?.toUpperCase() || null,
  };
}
