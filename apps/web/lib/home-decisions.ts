/**
 * Decision cards: a workflow review shown on the home page with enough on it to
 * decide there. A card can be approved in place only when every change on it
 * is one the agent was confident of and none is waiting on an answer. Anything
 * else is opened and reviewed in full. Everything here is pure.
 */

import { asProposal, type Confidence, type ReviewDecision } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { approveAllDecision, isReady } from '@tapestrai/graphql/src/lib/workflow-tasks';

/** What the home page reads of one review. */
export interface DecisionReview {
  id: string;
  runId: string;
  title: string;
  workflowName: string | null;
  summary: string | null;
  proposal: unknown;
  agentName: string | null;
  canReview: boolean;
  createdAt: string;
  dueAt?: string | null;
  overdue?: boolean;
  approvalsRequired?: number;
  approvals?: Array<{ id: string; name: string; at: string }>;
}

export const DECISION_REVIEW_FIELDS = `id runId title workflowName summary proposal agentName canReview createdAt dueAt overdue approvalsRequired approvals`;

export const DECISION_REVIEW_QUERY = `query HomeDecision($id: ID!) { workflowReview(id: $id) { ${DECISION_REVIEW_FIELDS} } }`;

export interface DecisionCard {
  id: string;
  runId: string;
  href: string;
  title: string;
  /** Who proposed it: the named agent, or else the workflow. */
  from: string;
  summary: string;
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  total: number;
  /** Changes that can be approved as they stand. */
  ready: number;
  /** Changes the agent flagged, or that wait on an answer. */
  needsYou: number;
  /** The least sure the agent was of any change. Null when nothing was proposed. */
  confidence: Confidence | null;
  /** How many facts the agent cited across its changes. */
  evidence: number;
  /** The first few changes, one line each. */
  lines: string[];
  more: number;
  /** Approvals still needed after this one, when more than one person must approve. */
  approvalsLeft: number;
  /** The decision that approves every change, or null when the card must be opened. */
  approveAll: ReviewDecision | null;
}

const LINES = 3;
const RANK: Record<Confidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

// Whether a change is ready, and the decision that approves a review in place, are the task inbox's rules too.
export { approveAllDecision, isReady } from '@tapestrai/graphql/src/lib/workflow-tasks';

export function decisionCard(review: DecisionReview): DecisionCard {
  const proposal = asProposal(review.proposal);
  const items = proposal.items;
  const ready = items.filter(isReady).length;
  const confidence = items.reduce<Confidence | null>((lowest, item) => {
    const value: Confidence = item.confidence === 'HIGH' || item.confidence === 'LOW' ? item.confidence : 'MEDIUM';
    return lowest === null || RANK[value] < RANK[lowest] ? value : lowest;
  }, null);
  const needed = Math.max(1, review.approvalsRequired || 1);
  const have = (review.approvals || []).length;
  return {
    id: review.id,
    runId: review.runId,
    href: `/workflows/runs/${review.runId}`,
    title: review.title,
    from: review.agentName || review.workflowName || 'A workflow',
    // The card shows the opening of the agent's summary. Its bullet list is on the review itself.
    summary: (review.summary || '').trim().split(/\n\s*(?:[-*•]|\d+\.)\s/)[0].trim(),
    createdAt: review.createdAt,
    dueAt: review.dueAt || null,
    overdue: review.overdue === true,
    total: items.length,
    ready,
    needsYou: items.length - ready,
    confidence,
    evidence: items.reduce((sum, item) => sum + item.evidence.length, 0),
    lines: items.slice(0, LINES).map((item) => item.summary),
    more: Math.max(0, items.length - LINES),
    approvalsLeft: Math.max(0, needed - have - 1),
    approveAll: review.canReview ? approveAllDecision(proposal) : null,
  };
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The main button: approve here when everything is ready, otherwise open it. */
export function primaryAction(card: DecisionCard): { kind: 'approve' | 'open'; label: string } {
  if (card.approveAll) return { kind: 'approve', label: card.total === 1 ? 'Approve' : `Approve all ${card.total}` };
  if (card.ready > 0 && card.needsYou > 0) return { kind: 'open', label: `Review ${card.needsYou}, confirm ${card.ready}` };
  return { kind: 'open', label: card.total === 1 ? 'Review' : `Review ${card.total}` };
}

/** The small line under a card: how sure the agent was and what it rests on. */
export function trustLine(card: DecisionCard): string {
  const parts: string[] = [];
  if (card.confidence) parts.push(`${card.confidence === 'HIGH' ? 'High' : card.confidence === 'LOW' ? 'Low' : 'Medium'} confidence`);
  if (card.evidence > 0) parts.push(plural(card.evidence, 'cited fact'));
  if (card.needsYou > 0 && card.ready > 0) parts.push(`${card.needsYou} of ${card.total} need a closer look`);
  else if (card.needsYou > 0) parts.push(card.total === 1 ? 'needs a closer look' : 'all need a closer look');
  return parts.join(' · ');
}

/** What approving here will do, said once it is done. */
export function approvedNote(card: DecisionCard): string {
  if (card.approvalsLeft > 0) return `Your approval is recorded. ${plural(card.approvalsLeft, 'more approval')} needed before anything changes.`;
  return `Approved. ${card.total === 1 ? 'The change is' : `${card.total} changes are`} being made now.`;
}

/** The reviews to show as cards: those the person can decide, overdue and due-soonest first, then oldest. */
export function cardOrder<T extends { canReview: boolean; createdAt: string; dueAt?: string | null; overdue?: boolean }>(reviews: readonly T[], limit: number): T[] {
  const time = (iso: string | null | undefined) => {
    const value = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return reviews
    .filter((review) => review.canReview)
    .sort((a, b) => Number(b.overdue === true) - Number(a.overdue === true) || time(a.dueAt) - time(b.dueAt) || time(a.createdAt) - time(b.createdAt))
    .slice(0, limit);
}
