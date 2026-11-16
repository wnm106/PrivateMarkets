import type { NodeKind, WorkflowGraph, WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';
import { nodeKind } from '@tapestrai/graphql/src/lib/workflow-graph';
import type { Proposal, ProposalCounts } from '@tapestrai/graphql/src/lib/workflow-proposal';

/** Types, queries, and small helpers for the workflow pages. */

export interface WorkflowProblem {
  nodeId: string | null;
  message: string;
}

export interface WorkflowSummary {
  id: string;
  clientId: string | null;
  code: string;
  name: string;
  description: string | null;
  publishedVersion: number | null;
  latestVersion: number;
  canManage: boolean;
  runCount: number;
  lastRunAt: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  version: number | null;
  graph: WorkflowGraph | null;
  problems: WorkflowProblem[];
  versions: Array<{ version: number; changeNote: string | null; createdAt: string }>;
}

export interface WorkflowTemplateOption {
  code: string;
  name: string;
  description: string;
  inputExample: Record<string, unknown>;
  graph: WorkflowGraph;
}

export interface ReviewView {
  id: string;
  runId: string;
  nodeId: string;
  workflowName: string | null;
  title: string;
  instructions: string | null;
  summary: string | null;
  proposal: Proposal | null;
  counts: ProposalCounts | null;
  itemCount: number;
  status: string;
  decision: { items?: Record<string, { decision: string; answers?: Record<string, unknown>; note?: string }>; note?: string } | null;
  decidedAt: string | null;
  createdAt: string;
  canReview: boolean;
}

export interface StepView {
  nodeId: string;
  nodeType: string;
  nodeLabel: string | null;
  status: string;
  outcome: string | null;
  attempts: number;
  output: unknown;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EventView {
  id: string;
  nodeId: string | null;
  type: string;
  actorType: 'SYSTEM' | 'AGENT' | 'USER';
  actorName: string | null;
  summary: string;
  detail: unknown;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  version: number;
  status: string;
  currentNode: string | null;
  errorMessage: string | null;
  openReviews: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  input: Record<string, unknown>;
  canRun: boolean;
  canReview: boolean;
  graph: WorkflowGraph | null;
  steps: StepView[];
  events: EventView[];
  reviews: ReviewView[];
}

export interface ToolOption {
  name: string;
  description: string;
  readOnly: boolean;
  args: Array<{ name: string; type: string; description: string; required: boolean }>;
}

const WORKFLOW_FIELDS = `id clientId code name description publishedVersion latestVersion canManage runCount lastRunAt`;
const RUN_FIELDS = `id workflowId workflowName version status currentNode errorMessage openReviews createdAt startedAt finishedAt`;
const REVIEW_FIELDS = `id runId nodeId workflowName title instructions summary proposal counts itemCount status decision decidedAt createdAt canReview`;

export const WORKFLOW_HUB_QUERY = `
  query WorkflowHub {
    workflows { ${WORKFLOW_FIELDS} }
    workflowRuns(first: 50) { ${RUN_FIELDS} }
    workflowReviews(status: "OPEN") { id runId nodeId workflowName title summary itemCount status createdAt canReview }
    workflowTemplates { code name description inputExample graph }
  }
`;
export const WORKFLOW_QUERY = `
  query Workflow($id: ID!, $version: Int) {
    workflow(id: $id, version: $version) {
      ${WORKFLOW_FIELDS} version graph problems { nodeId message } versions { version changeNote createdAt }
    }
    workflowRuns(workflowId: $id, first: 10) { ${RUN_FIELDS} }
  }
`;
export const WORKFLOW_RUN_QUERY = `
  query WorkflowRun($id: ID!) {
    workflowRun(id: $id) { ${RUN_FIELDS} input canRun canReview graph steps events reviews { ${REVIEW_FIELDS} } }
  }
`;
export const SAVE_WORKFLOW = `
  mutation SaveWorkflow($input: SaveWorkflowInput!) {
    saveWorkflow(input: $input) { workflow { id version latestVersion problems { nodeId message } } errors { field message } }
  }
`;
export const PUBLISH_WORKFLOW = `
  mutation PublishWorkflow($id: ID!, $version: Int!) {
    publishWorkflow(id: $id, version: $version) { workflow { id publishedVersion } errors { field message } }
  }
`;
export const ARCHIVE_WORKFLOW = `mutation ArchiveWorkflow($id: ID!) { archiveWorkflow(id: $id) { success errors { message } } }`;
export const START_RUN = `
  mutation StartWorkflowRun($workflowId: ID!, $input: JSON, $version: Int) {
    startWorkflowRun(workflowId: $workflowId, input: $input, version: $version) { run { id } errors { field message } }
  }
`;
export const CANCEL_RUN = `mutation CancelWorkflowRun($id: ID!) { cancelWorkflowRun(id: $id) { run { id } errors { message } } }`;
export const RETRY_RUN = `mutation RetryWorkflowRun($id: ID!) { retryWorkflowRun(id: $id) { run { id } errors { message } } }`;
export const DECIDE_REVIEW = `
  mutation DecideWorkflowReview($input: DecideWorkflowReviewInput!) {
    decideWorkflowReview(input: $input) { review { id status } errors { message } }
  }
`;

export type MutationErrors = Array<{ field?: string | null; message: string }>;

/** How each kind of step is drawn, so fixed, agent, and human steps read apart at a glance. */
export const KIND_STYLE: Record<NodeKind, { label: string; color: string; tint: string; hint: string }> = {
  fixed: { label: 'Fixed', color: '#334155', tint: '#f1f5f9', hint: 'Does the same thing every run' },
  agent: { label: 'Agent', color: '#6d28d9', tint: '#f3e8ff', hint: 'A model decides what to read and what to propose' },
  human: { label: 'Human', color: '#b45309', tint: '#fef3c7', hint: 'Waits for a person' },
};

export const RUN_STATUS: Record<string, { label: string; color: string; tint: string }> = {
  QUEUED: { label: 'Queued', color: '#475569', tint: '#f1f5f9' },
  RUNNING: { label: 'Running', color: '#0e7490', tint: '#cffafe' },
  WAITING: { label: 'Waiting for review', color: '#92400e', tint: '#fde8c0' },
  SUCCEEDED: { label: 'Finished', color: '#166534', tint: '#dcfce7' },
  FAILED: { label: 'Failed', color: '#b91c1c', tint: '#fee2e2' },
  CANCELLED: { label: 'Cancelled', color: '#475569', tint: '#f1f5f9' },
  SKIPPED: { label: 'Skipped', color: '#475569', tint: '#f1f5f9' },
};

export function statusOf(status: string) {
  return RUN_STATUS[status] || { label: status, color: '#475569', tint: '#f1f5f9' };
}

export function kindOf(node: Pick<WorkflowNode, 'type'>) {
  return KIND_STYLE[nodeKind(node.type)];
}

export function when(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function clock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A step id from its name that is not already taken: "Find open exceptions" becomes find_open_exceptions. */
export function nodeIdFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'step';
  let id = base;
  for (let index = 2; taken.has(id); index += 1) id = `${base}_${index}`;
  return id;
}

export type ParsedJson = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

export function parseObject(text: string, what: string): ParsedJson {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: `${what} must be a JSON object, for example {"limit": 20}.` };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, message: `${what} is not valid JSON.` };
  }
}

/** A value shown to a reviewer: short and plain, never raw JSON for simple things. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A tool call's settings as label/value rows, with nested objects flattened one level ("attributes.CURRENCY"). */
export function argRows(args: Record<string, unknown>): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(args)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) rows.push({ key: `${key}.${inner}`, value: showValue(innerValue) });
    } else {
      rows.push({ key, value: showValue(value) });
    }
  }
  return rows;
}
