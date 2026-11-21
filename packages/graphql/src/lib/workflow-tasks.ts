import { checkDecision, unanswered, type Proposal, type ProposalItem, type ReviewDecision } from './workflow-proposal';
import { stageScreen } from './workflow-screens';

/**
 * A person's tasks: every open decision in a workflow run that they can act on
 * now. A review they can decide, a form they can answer, a screen they can
 * work. Each is one point on its run's checklist, however many changes it
 * holds.
 *
 * This is the one place tasks are counted, so the top bar, the inbox, the home
 * page and the run page give the same number. Pure; the API reads the rows.
 */

export type TaskKind = 'review' | 'form' | 'stage';

export interface WorkflowTask {
  /** The review, form or stage id. */
  id: string;
  kind: TaskKind;
  runId: string;
  nodeId: string;
  title: string;
  workflowName: string | null;
  /** What it is about, when that can be read from it: the records a review changes. */
  about: string | null;
  /** What it holds: "4 proposed changes", "3 questions", "Map a file". */
  detail: string;
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  canAct: boolean;
  /** Why the person cannot act on it, when they cannot. */
  blocker: string | null;
  waitingOn: string | null;
  /** Its number on the run's checklist, and the run's total. Null when not worked out. */
  place: number | null;
  placeOf: number | null;
  /** The decision that approves a review in place, when every change is ready. */
  approveAll: ReviewDecision | null;
  /** Approvals still needed after this person's, for a review that needs more than one. */
  approvalsLeft: number;
}

export interface TaskList {
  /** Tasks the person can act on now. */
  total: number;
  overdue: number;
  /** Due within the next day, not yet overdue. */
  dueSoon: number;
  /** Open decisions the person can see and someone else has to make. */
  waitingOnOthers: number;
  tasks: WorkflowTask[];
  waiting: WorkflowTask[];
}

const DAY = 24 * 60 * 60 * 1000;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function names(assignees: unknown): string | null {
  const list = Array.isArray(assignees) ? assignees.map((entry) => (entry && typeof entry === 'object' ? String((entry as { name?: unknown }).name || '') : '')).filter(Boolean) : [];
  return list.length > 0 ? list.join(', ') : null;
}

function overdue(dueAt: string | null, now: number): boolean {
  return Boolean(dueAt) && Date.parse(dueAt as string) < now;
}

/** Whether a change can be approved without a person adding or checking anything. */
export function isReady(item: ProposalItem): boolean {
  return !item.needsReview && unanswered(item, { decision: 'APPROVE' }).length === 0;
}

/** The decision that approves every change as proposed, or null when any change is not ready or the whole would not be accepted. */
export function approveAllDecision(proposal: Proposal): ReviewDecision | null {
  if (proposal.items.length === 0 || !proposal.items.every(isReady)) return null;
  const decision: ReviewDecision = { items: Object.fromEntries(proposal.items.map((item) => [item.id, { decision: 'APPROVE' as const }])) };
  return checkDecision(proposal, decision).ok ? decision : null;
}

/** "Harbor Credit Fund", "Harbor and Brightwater", "Harbor and 3 more". */
function aboutOf(proposal: Proposal | null): string | null {
  const labels = [...new Set((proposal?.items || []).map((item) => item.target.label).filter(Boolean))];
  if (labels.length === 0) return null;
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels[0]} and ${labels.length - 1} more`;
}

export interface ReviewRow {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  workflowName: string | null;
  proposal: Proposal | null;
  itemCount: number;
  canReview: boolean;
  blocker: string | null;
  assignees: unknown;
  createdAt: string;
  dueAt: string | null;
  approvalsRequired?: number;
  approvals?: unknown[];
}

export function reviewTask(review: ReviewRow, now = Date.now()): WorkflowTask {
  const count = review.proposal ? review.proposal.items.length : review.itemCount;
  const needed = Math.max(1, review.approvalsRequired || 1);
  const have = Array.isArray(review.approvals) ? review.approvals.length : 0;
  return {
    id: review.id,
    kind: 'review',
    runId: review.runId,
    nodeId: review.nodeId,
    title: review.title,
    workflowName: review.workflowName,
    about: aboutOf(review.proposal),
    detail: count === 0 ? 'Nothing proposed: approve to go on' : plural(count, 'proposed change'),
    createdAt: review.createdAt,
    dueAt: review.dueAt,
    overdue: overdue(review.dueAt, now),
    canAct: review.canReview,
    blocker: review.blocker,
    waitingOn: review.canReview ? null : names(review.assignees) || 'anyone who can review',
    place: null,
    placeOf: null,
    approveAll: review.canReview && review.proposal ? approveAllDecision(review.proposal) : null,
    approvalsLeft: Math.max(0, needed - have - 1),
  };
}

export interface FormRow {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  workflowName: string | null;
  fields: unknown[];
  externalEmail: string | null;
  canAnswer: boolean;
  blocker: string | null;
  assignees: unknown;
  createdAt: string;
  dueAt: string | null;
}

export function formTask(form: FormRow, now = Date.now()): WorkflowTask {
  const required = form.fields.filter((field) => field && typeof field === 'object' && (field as { required?: unknown }).required === true).length;
  return {
    id: form.id,
    kind: 'form',
    runId: form.runId,
    nodeId: form.nodeId,
    title: form.title,
    workflowName: form.workflowName,
    about: form.externalEmail ? `Sent to ${form.externalEmail}` : null,
    detail: `${plural(form.fields.length, 'question')}${required > 0 && required < form.fields.length ? `, ${required} required` : ''}`,
    createdAt: form.createdAt,
    dueAt: form.dueAt,
    overdue: overdue(form.dueAt, now),
    canAct: form.canAnswer,
    blocker: form.blocker,
    waitingOn: form.canAnswer ? null : form.externalEmail || names(form.assignees) || 'anyone who can review',
    place: null,
    placeOf: null,
    approveAll: null,
    approvalsLeft: 0,
  };
}

export interface StageRow {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  workflowName: string | null;
  screen: string;
  returnedReason: string | null;
  canAct: boolean;
  blocker: string | null;
  assignees: unknown;
  createdAt: string;
  dueAt: string | null;
}

export function stageTask(stage: StageRow, now = Date.now()): WorkflowTask {
  const screen = stageScreen(stage.screen)?.label || 'A screen to work through';
  return {
    id: stage.id,
    kind: 'stage',
    runId: stage.runId,
    nodeId: stage.nodeId,
    title: stage.title,
    workflowName: stage.workflowName,
    about: null,
    detail: stage.returnedReason ? `${screen}: came back to you` : screen,
    createdAt: stage.createdAt,
    dueAt: stage.dueAt,
    overdue: overdue(stage.dueAt, now),
    canAct: stage.canAct,
    blocker: stage.blocker,
    waitingOn: stage.canAct ? null : names(stage.assignees) || 'anyone who can review',
    place: null,
    placeOf: null,
    approveAll: null,
    approvalsLeft: 0,
  };
}

/** Overdue first, then the soonest due, then the longest waiting. */
export function taskOrder(tasks: readonly WorkflowTask[]): WorkflowTask[] {
  const due = (task: WorkflowTask) => (task.dueAt ? Date.parse(task.dueAt) : Infinity);
  return [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || due(a) - due(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** A person's tasks, counted and ordered. Lists are capped; the counts are not. */
export function taskList(all: readonly WorkflowTask[], now = Date.now(), limit = 50): TaskList {
  const mine = taskOrder(all.filter((task) => task.canAct));
  const others = taskOrder(all.filter((task) => !task.canAct));
  return {
    total: mine.length,
    overdue: mine.filter((task) => task.overdue).length,
    dueSoon: mine.filter((task) => !task.overdue && task.dueAt !== null && Date.parse(task.dueAt) - now <= DAY).length,
    waitingOnOthers: others.length,
    tasks: mine.slice(0, limit),
    waiting: others.slice(0, 20),
  };
}
