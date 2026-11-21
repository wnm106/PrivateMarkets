import type { TabPayload } from '@/lib/view-context';
import { reviewView } from '@tapestrai/graphql/src/lib/workflow-views';
import { reviewSections } from '@/lib/review-sections';
import { checklistSummary, progressText, type Checklist } from '@/lib/workflow-checklist';
import { assigneeText, statusOf, type EventView, type ReviewView, type RunDetail } from '@/lib/workflows';

/**
 * How a run is presented: what the person has to do next comes first, the
 * agent's write-up is a short lead with the rest a click away, and the design
 * and history sit on a Details tab.
 */

export type Tone = 'act' | 'wait' | 'working' | 'done' | 'failed';

export interface NextStep {
  tone: Tone;
  /** One line saying what has to happen next and who does it. */
  headline: string;
  /** A second line with the reason or the detail, when there is one. */
  detail?: string;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The first paragraph of a markdown write-up as plain text, cut at a sentence near `limit`. */
export function summaryLead(text: string | null | undefined, limit = 280): string {
  if (!text) return '';
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim().replace(/^#{1,6}\s.*(\n|$)/, '').trim())
    .filter(Boolean);
  // Prose first. A write-up that is only a list leads with its first item.
  const paragraph = blocks.find((block) => !/^([-*+]|\d+\.)\s/.test(block)) || (blocks[0] || '').split('\n')[0].replace(/^([-*+]|\d+\.)\s+/, '');
  const plain = paragraph
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > limit / 3 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
}

/** What an open review asks of the person looking at it. */
export function reviewNextStep(review: ReviewView): NextStep {
  const items = review.proposal?.items || [];
  const flagged = items.filter((item) => item.needsReview).length;
  const questions = items.reduce((sum, item) => sum + item.missing.filter((field) => field.required).length, 0);
  if (review.status !== 'OPEN') {
    const outcome = review.status === 'APPROVED' ? 'Approved' : review.status === 'REJECTED' ? 'Rejected' : 'Cancelled';
    return { tone: 'done', headline: `${outcome}${review.decidedByName ? ` by ${review.decidedByName}` : ''}.` };
  }
  if (!review.canReview) {
    return {
      tone: 'wait',
      headline: `Waiting on ${assigneeText(review.assignees)} to review ${items.length === 0 ? 'this step' : plural(items.length, 'proposed change')}.`,
      detail: `You cannot decide this one. ${review.blocker || 'Someone with the review permission needs to.'}`,
    };
  }
  if (items.length === 0) return { tone: 'act', headline: 'The agent proposed no changes. Approve to let the run continue.' };
  const parts = [flagged > 0 ? `${flagged} ${flagged === 1 ? 'needs' : 'need'} a close look` : '', questions > 0 ? `${plural(questions, 'question')} to answer` : ''].filter(Boolean);
  return {
    tone: 'act',
    headline: `Decide ${plural(items.length, 'proposed change')}.`,
    detail: parts.length > 0 ? `${parts.join(', ')}. Nothing is written until you apply your decisions.` : 'The agent is confident in all of them. Nothing is written until you apply your decisions.',
  };
}

/**
 * What the run as a whole is waiting for. Given the run's checklist, it names
 * the decision by its number, whatever kind of step it is.
 */
export function runNextStep(run: RunDetail, checklist?: Checklist | null): NextStep {
  if (checklist) {
    const { current, total } = checklist;
    const place = (number: number | null) => (number !== null && total > 1 ? `Decision ${number} of ${total}: ` : '');
    if (current) {
      const progress = progressText(current.progress);
      return { tone: 'act', headline: `${place(current.number)}${current.label}.`, detail: `${current.detail}${progress ? `, ${progress}` : ''}. The run waits here until you finish it.` };
    }
    const waiting = checklist.items.find((item) => item.state === 'waiting' && item.recordId);
    if (waiting) return { tone: 'wait', headline: `Nothing for you to do. ${place(waiting.number)}${waiting.label} is with someone else.`, detail: waiting.note };
    if (run.status === 'SUCCEEDED') {
      return { tone: 'done', headline: checklist.total === 0 ? 'Finished. It needed no decisions.' : `Finished. ${checklist.done} of ${plural(checklist.total, 'decision')} made.` };
    }
    if (run.status === 'RUNNING' || run.status === 'QUEUED') {
      const base = runNextStep(run);
      return { ...base, detail: checklist.total === 0 && checklist.possible === 0 ? 'This run needs no decisions. It reports when it is done.' : `${checklistSummary(checklist)}. This page follows the run as it moves.` };
    }
  }
  const open = run.reviews.filter((review) => review.status === 'OPEN');
  const mine = open.filter((review) => review.canReview);
  const step = run.currentNode ? run.graph?.nodes.find((node) => node.id === run.currentNode)?.label || run.currentNode : null;
  if (mine.length > 0) {
    return { tone: 'act', headline: mine.length === 1 ? `Your review is needed: ${mine[0].title}.` : `${plural(mine.length, 'review')} need your decision.`, detail: 'The run waits here until it is decided.' };
  }
  if (open.length > 0) {
    return { tone: 'wait', headline: `Nothing for you to do. Waiting on ${assigneeText(open[0].assignees)} to review.`, detail: open[0].blocker || undefined };
  }
  switch (run.status) {
    case 'QUEUED':
      return { tone: 'working', headline: 'Waiting for a worker to pick this up.', detail: 'If it stays queued, check that the job worker is running.' };
    case 'RUNNING':
      return { tone: 'working', headline: step ? `Working on ${step}.` : 'Working.', detail: 'This page follows the run as it moves.' };
    case 'WAITING':
      return { tone: 'wait', headline: step ? `Waiting at ${step}.` : 'Waiting.' };
    case 'FAILED':
      return { tone: 'failed', headline: step ? `Stopped at ${step}.` : 'The run failed.', detail: run.errorMessage || undefined };
    case 'SUCCEEDED':
      return { tone: 'done', headline: 'Finished. Nothing needs you.' };
    case 'CANCELLED':
      return { tone: 'done', headline: 'Cancelled. Changes already applied stay.' };
    default:
      return { tone: 'done', headline: statusOf(run.status).label };
  }
}

/** History, newest first. Entries recorded in the same instant keep their recorded order, reversed. */
export function newestFirst(events: readonly EventView[]): EventView[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt) || b.index - a.index)
    .map(({ event }) => event);
}

const ACTOR_LABEL: Record<EventView['actorType'], string> = { SYSTEM: 'System', AGENT: 'Agent', USER: 'Person' };

/** The decisions of a run, and the forms and stages behind them, once they have loaded. */
export interface RunDecisionsView {
  checklist: Checklist;
  stages: Array<{ nodeId: string; title: string; screen: string; instructions: string | null; status: string; canAct: boolean; blocker: string | null; returnedReason: string | null }>;
  forms: Array<{ nodeId: string; title: string; instructions: string | null; status: string; canAnswer: boolean; blocker: string | null; fields: unknown }>;
}

/** Both tabs of the run page, as the assistant reads them. */
export function runTabs(run: RunDetail | null, decisions?: RunDecisionsView | null): Record<string, TabPayload> {
  const nodeLabel = (id: string | null) => (id ? run?.graph?.nodes.find((node) => node.id === id)?.label || id : null);
  return {
    overview: {
      label: 'Overview',
      purpose: 'The checklist of decisions this run needs from people, in order, which one is open now, and the agent findings behind it.',
      howToRead: 'checklist lists every point where a person decides something, numbered in the order the run reaches them. state is done, skipped (passed with nothing to decide), current (open and yours), waiting (open and someone else\'s), attention (failed) or ahead. An item with no number comes only on some choices and is not in the total. parts are the things to do inside the open decision, as its screen reports them. nextStep says what has to happen and who does it. A review lists the changes the agent proposed, in sections by kind (cash pairs, cash adjustments, reconciliation decisions, other changes, notes), decided in that order; agentShows are the views the agent asked the reviewer to look at, and why. Nothing is written to a record until a reviewer approves and applies them. "Needs a close look" means the agent was unsure or is missing a value. checklist is null while the forms and screens of the run load.',
      data: run
        ? {
            workflow: run.workflowName,
            status: statusOf(run.status).label,
            nextStep: runNextStep(run, decisions?.checklist),
            checklist: decisions
              ? {
                  summary: checklistSummary(decisions.checklist),
                  total: decisions.checklist.total,
                  done: decisions.checklist.done,
                  dependingOnChoices: decisions.checklist.possible,
                  workingOn: decisions.checklist.working,
                  items: decisions.checklist.items.map((item) => ({
                    number: item.number,
                    decision: item.label,
                    kind: item.kind,
                    what: item.detail,
                    state: item.state,
                    where: item.note,
                    ...(item.progress ? { progress: progressText(item.progress), parts: item.progress.parts?.map((part) => ({ part: part.label, done: part.done, note: part.note })) } : {}),
                  })),
                }
              : null,
            openStages: decisions
              ? decisions.stages.filter((stage) => stage.status === 'OPEN').map((stage) => ({ title: stage.title, screen: stage.screen, instructions: stage.instructions, yours: stage.canAct, whyNot: stage.canAct ? null : stage.blocker, cameBack: stage.returnedReason }))
              : null,
            openForms: decisions
              ? decisions.forms.filter((form) => form.status === 'OPEN').map((form) => ({ title: form.title, instructions: form.instructions, yours: form.canAnswer, whyNot: form.canAnswer ? null : form.blocker, questions: Array.isArray(form.fields) ? (form.fields as Array<{ label?: string; required?: boolean }>).map((field) => ({ question: field.label, required: field.required === true })) : [] }))
              : null,
            openReviews: run.reviews
              .filter((review) => review.status === 'OPEN')
              .map((review) => ({
                title: review.title,
                nextStep: reviewNextStep(review),
                agentSummary: summaryLead(review.summary, 600),
                sections: reviewSections(review.proposal?.items || []).map((section) => ({ section: section.label, changes: section.items.length })),
                agentShows: (review.proposal?.views || []).map((view) => ({ view: reviewView(view.view)?.label || view.view, fund: view.args.fundId, period: view.args.periodEnd || null, why: view.why, pointsAt: view.focus.length })),
                changes: (review.proposal?.items || []).slice(0, 40).map((item) => ({
                  on: item.target.label,
                  change: item.summary,
                  confidence: item.confidence,
                  needsCloseLook: item.needsReview,
                  questions: item.missing.filter((field) => field.required).map((field) => field.question || field.key),
                })),
              })),
          }
        : null,
    },
    details: {
      label: 'Details',
      purpose: 'How the workflow is designed, how far each step got, earlier decisions and the full history of the run.',
      howToRead: 'History is newest first and is never changed. Each entry is by the system, the agent or a person.',
      data: run
        ? {
            steps: run.steps.map((step) => ({ step: nodeLabel(step.nodeId), status: statusOf(step.status).label, outcome: step.outcome, attempts: step.attempts, error: step.errorMessage })),
            pastReviews: run.reviews
              .filter((review) => review.status !== 'OPEN')
              .map((review) => ({ title: review.title, outcome: reviewNextStep(review).headline, decidedAt: review.decidedAt })),
            history: newestFirst(run.events)
              .slice(0, 80)
              .map((event) => ({ at: event.createdAt, by: event.actorType === 'USER' && event.actorName ? event.actorName : ACTOR_LABEL[event.actorType], step: nodeLabel(event.nodeId), summary: event.summary })),
            historyCount: run.events.length,
          }
        : null,
    },
  };
}
