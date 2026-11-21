import type { WorkflowGraph, WorkflowNode } from './workflow-graph';
import { stageScreen } from './workflow-screens';

/**
 * A run as a checklist: every point where a person has to decide something,
 * numbered in the order the run reaches them, each ticked off as it is done.
 *
 * Only the steps that wait on a person are on it: a review, a form, a stage.
 * The system's own steps run between them. A run can have no decision at all,
 * or several. Pure, so the page, the assistant and the tests count the same way.
 */

export type CheckKind = 'review' | 'form' | 'stage';

/**
 * done: decided. skipped: the run passed it with nothing to decide.
 * current: open and yours. waiting: open and someone else's.
 * attention: it failed. ahead: not reached yet.
 */
export type CheckState = 'done' | 'skipped' | 'current' | 'waiting' | 'attention' | 'ahead';

/** One thing to do inside a decision, as the open screen reports it. */
export interface CheckPart {
  label: string;
  done: boolean;
  note?: string;
}

/** How far a person has got inside one open decision. Reported by its screen. */
export interface CheckProgress {
  done?: number;
  total?: number;
  parts?: CheckPart[];
}

/** A review, form or stage as the checklist reads it. */
export interface CheckRecord {
  id: string;
  nodeId: string;
  kind: CheckKind;
  /** OPEN while it waits on a person. */
  status: string;
  title?: string | null;
  /** The person looking can decide it now. */
  canAct: boolean;
  blocker?: string | null;
  assignees?: Array<{ name?: string }>;
  /** How it was left: approved, confirmed, submitted… */
  outcome?: string | null;
  by?: string | null;
  /** What it holds: proposed changes for a review, questions for a form. */
  size?: number;
}

export interface ChecklistItem {
  /** Its place in the run, 1 first. Null for one that comes only on some choices. */
  number: number | null;
  nodeId: string;
  kind: CheckKind;
  label: string;
  state: CheckState;
  /** One line on where it stands: "Approved by Ada", "Waiting on Operations lead". */
  note: string;
  /** What it is: "Review proposed changes · 4 changes", "Map a file". */
  detail: string;
  recordId: string | null;
  progress?: CheckProgress;
}

export interface Checklist {
  items: ChecklistItem[];
  /** Decisions the run reaches whatever is chosen, including those already done. */
  total: number;
  /** Decided or passed. */
  done: number;
  /** Decisions that come only on some choices, not counted in total. */
  possible: number;
  /** The first open decision the person looking can act on. */
  current: ChecklistItem | null;
  /** The system's step running now, when no person is needed. */
  working: string | null;
}

export interface StepMark {
  nodeId: string;
  status: string;
  outcome: string | null;
  output?: unknown;
}

export interface ChecklistInput {
  graph: WorkflowGraph | null;
  status: string;
  currentNode: string | null;
  steps: StepMark[];
  records: CheckRecord[];
  /** What each open screen has reported, by the record's id. */
  progress?: Record<string, CheckProgress>;
}

const HUMAN: Record<string, CheckKind> = { review: 'review', form: 'form', stage: 'stage' };
const FINISHED = new Set(['SUCCEEDED', 'SKIPPED']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Whether the run can go on from a step, and where. A way out that only stops the run is not another journey. */
function nextOf(graph: WorkflowGraph, node: WorkflowNode, marks: Map<string, StepMark>, ends: Set<string>): { to: string[]; fork: boolean } {
  const edges = graph.edges.filter((edge) => edge.from === node.id);
  const mark = marks.get(node.id);
  const finished = Boolean(mark && FINISHED.has(mark.status));
  if (finished && mark?.outcome && node.type !== 'parallel') {
    const taken = edges.find((edge) => edge.when === mark.outcome) || edges.find((edge) => !edge.when);
    return { to: taken ? [taken.to] : [], fork: false };
  }
  if (finished || node.type === 'parallel') return { to: unique(edges.map((edge) => edge.to)), fork: false };
  const going = unique(edges.filter((edge) => !ends.has(edge.to)).map((edge) => edge.to));
  const to = going.length > 0 ? going : unique(edges.map((edge) => edge.to));
  return { to, fork: to.length > 1 };
}

/**
 * The steps on the run's path, in the order it reaches them, each marked
 * certain when the run reaches it whatever is chosen. After an undecided
 * fork, the steps on only some of its arms are not certain; a step every arm
 * reaches is.
 */
export function pathSteps(graph: WorkflowGraph, steps: StepMark[]): Array<{ node: WorkflowNode; certain: boolean }> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const marks = new Map(steps.map((step) => [step.nodeId, step]));
  const ends = new Set(graph.nodes.filter((node) => node.type === 'end').map((node) => node.id));
  const start = graph.nodes.find((node) => node.type === 'start');
  if (!start) return [];
  const next = (id: string) => {
    const node = byId.get(id);
    return node ? nextOf(graph, node, marks, ends) : { to: [], fork: false };
  };

  // Every step the run can still reach, breadth first.
  const order: string[] = [];
  const seen = new Set([start.id]);
  for (let queue = [start.id]; queue.length > 0;) {
    const id = queue.shift() as string;
    order.push(id);
    for (const to of next(id).to) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }

  const reach = (from: string): Set<string> => {
    const found = new Set([from]);
    for (let queue = [from]; queue.length > 0;) {
      for (const to of next(queue.shift() as string).to) {
        if (found.has(to)) continue;
        found.add(to);
        queue.push(to);
      }
    }
    return found;
  };

  const certain = new Set([start.id]);
  for (let work = [start.id]; work.length > 0;) {
    const id = work.shift() as string;
    const { to, fork } = next(id);
    let sure = to;
    if (fork) {
      const arms = to.map(reach);
      sure = [...arms[0]].filter((candidate) => arms.every((arm) => arm.has(candidate)));
    }
    for (const candidate of sure) {
      if (certain.has(candidate)) continue;
      certain.add(candidate);
      work.push(candidate);
    }
  }

  return order.map((id) => byId.get(id)).filter((node): node is WorkflowNode => Boolean(node)).map((node) => ({ node, certain: certain.has(node.id) }));
}

function whoText(assignees: CheckRecord['assignees']): string {
  const names = (assignees || []).map((entry) => entry.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'anyone who can review';
}

const DONE_WORD: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  confirmed: 'Confirmed',
  abandoned: 'Stopped here',
  submitted: 'Answered',
  declined: 'Declined',
  discarded: 'Discarded',
};

function doneNote(outcome: string | null | undefined, by: string | null | undefined): string {
  const word = outcome ? DONE_WORD[outcome] || outcome.charAt(0).toUpperCase() + outcome.slice(1) : 'Done';
  return by ? `${word} by ${by}` : word;
}

function detailOf(kind: CheckKind, node: WorkflowNode, found: CheckRecord | undefined): string {
  if (kind === 'stage') return stageScreen(node.config.screen)?.label || 'A screen to work through';
  if (kind === 'form') return found?.size !== undefined ? `Answer ${plural(found.size, 'question')}` : 'Answer a form';
  if (found?.size === undefined) return 'Decide the proposed changes';
  return found.size === 0 ? 'Nothing was proposed' : `Decide ${plural(found.size, 'proposed change')}`;
}

/** Every decision of a run, numbered, with where each one stands. */
export function runChecklist(input: ChecklistInput): Checklist {
  const empty: Checklist = { items: [], total: 0, done: 0, possible: 0, current: null, working: null };
  if (!input.graph) return empty;
  const marks = new Map(input.steps.map((step) => [step.nodeId, step]));
  // A step can be opened more than once (handed back); the latest record is the one that counts.
  const records = new Map<string, CheckRecord>();
  for (const entry of input.records) {
    const known = records.get(entry.nodeId);
    if (!known || entry.status === 'OPEN' || known.status !== 'OPEN') records.set(entry.nodeId, entry);
  }
  const failed = input.status === 'FAILED';
  const path = pathSteps(input.graph, input.steps);

  let number = 0;
  const items: ChecklistItem[] = [];
  for (const { node, certain } of path) {
    const kind = HUMAN[node.type];
    if (!kind) continue;
    const mark = marks.get(node.id);
    const found = records.get(node.id);
    const reached = Boolean(mark) || Boolean(found);
    let state: CheckState = 'ahead';
    let note = certain ? 'Up next' : 'Only on some choices';
    if (mark && FINISHED.has(mark.status)) {
      if (record(mark.output).skipped === true) {
        state = 'skipped';
        note = 'Nothing was proposed, so there was nothing to decide';
      } else {
        state = 'done';
        note = doneNote(mark.outcome || found?.outcome, found?.by);
      }
    } else if (mark?.status === 'FAILED' || (failed && input.currentNode === node.id)) {
      state = 'attention';
      note = 'This step failed';
    } else if (found?.status === 'OPEN') {
      state = found.canAct ? 'current' : 'waiting';
      note = found.canAct ? 'Your move' : `Waiting on ${whoText(found.assignees)}${found.blocker ? `. ${found.blocker}` : ''}`;
    } else if (found && found.status !== 'OPEN') {
      // Left by the person; the run has not taken it up yet.
      state = 'done';
      note = doneNote(found.outcome, found.by);
    } else if (mark?.status === 'WAITING' || mark?.status === 'RUNNING') {
      state = 'waiting';
      note = 'Opening…';
    }
    const counted = certain || reached;
    if (counted) number += 1;
    items.push({
      number: counted ? number : null,
      nodeId: node.id,
      kind,
      label: found?.title || node.label,
      state,
      note,
      detail: detailOf(kind, node, found),
      recordId: found?.id || null,
      ...(found && input.progress?.[found.id] ? { progress: input.progress[found.id] } : {}),
    });
  }

  const numbered = items.filter((item) => item.number !== null);
  const running = input.status === 'RUNNING' && input.currentNode ? input.graph.nodes.find((node) => node.id === input.currentNode) : undefined;
  return {
    items,
    total: numbered.length,
    done: numbered.filter((item) => item.state === 'done' || item.state === 'skipped').length,
    possible: items.length - numbered.length,
    current: items.find((item) => item.state === 'current') || null,
    working: running && !HUMAN[running.type] ? running.label : null,
  };
}

/** "2 of 3 decisions done", with the ones that depend on a choice. */
export function checklistSummary(list: Checklist): string {
  if (list.total === 0 && list.possible === 0) return 'This run needs no decisions.';
  const base = list.total === 0 ? 'No decision is certain yet' : `${list.done} of ${plural(list.total, 'decision')} done`;
  return list.possible > 0 ? `${base}, up to ${list.possible} more depending on your choices` : base;
}

/** What one open decision holds, by its screen's own count: "3 of 5 done". */
export function progressText(progress: CheckProgress | undefined): string | null {
  if (!progress) return null;
  if (progress.parts && progress.parts.length > 0) {
    const done = progress.parts.filter((part) => part.done).length;
    return `${done} of ${progress.parts.length} done`;
  }
  if (typeof progress.total === 'number' && progress.total > 0) return `${progress.done || 0} of ${progress.total} decided`;
  return null;
}

/** Reviews, forms and stages of a run, read the same way. */
export function checkRecords(source: {
  reviews?: Array<{ id: string; nodeId: string; status: string; title: string; canReview: boolean; blocker?: string | null; assignees?: Array<{ name?: string }>; decidedByName?: string | null; proposal?: { items: unknown[] } | null; itemCount?: number }>;
  forms?: Array<{ id: string; nodeId: string; status: string; title: string; canAnswer: boolean; blocker?: string | null; assignees?: Array<{ name?: string }>; submittedByName?: string | null; fields?: unknown }>;
  stages?: Array<{ id: string; nodeId: string; status: string; title: string; canAct: boolean; blocker?: string | null; assignees?: Array<{ name?: string }>; completedByName?: string | null; outcome?: string | null }>;
}): CheckRecord[] {
  const out: CheckRecord[] = [];
  for (const review of source.reviews || []) {
    out.push({
      id: review.id,
      nodeId: review.nodeId,
      kind: 'review',
      status: review.status,
      title: review.title,
      canAct: review.status === 'OPEN' && review.canReview,
      blocker: review.blocker,
      assignees: review.assignees,
      outcome: review.status === 'OPEN' ? null : review.status.toLowerCase(),
      by: review.decidedByName,
      size: review.proposal?.items.length ?? review.itemCount,
    });
  }
  for (const form of source.forms || []) {
    out.push({
      id: form.id,
      nodeId: form.nodeId,
      kind: 'form',
      status: form.status,
      title: form.title,
      canAct: form.status === 'OPEN' && form.canAnswer,
      blocker: form.blocker,
      assignees: form.assignees,
      outcome: form.status === 'OPEN' ? null : form.status.toLowerCase(),
      by: form.submittedByName,
      size: Array.isArray(form.fields) ? form.fields.length : undefined,
    });
  }
  for (const stage of source.stages || []) {
    out.push({
      id: stage.id,
      nodeId: stage.nodeId,
      kind: 'stage',
      status: stage.status,
      title: stage.title,
      canAct: stage.status === 'OPEN' && stage.canAct,
      blocker: stage.blocker,
      assignees: stage.assignees,
      outcome: stage.outcome,
      by: stage.completedByName,
    });
  }
  return out;
}
