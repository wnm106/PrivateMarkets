import type { TabPayload } from '@/lib/view-context';
import { settles } from '@tapestrai/graphql/src/lib/borrower-financials';
import { reviewView } from '@tapestrai/graphql/src/lib/workflow-views';
import { reviewSections } from '@/lib/review-sections';
import { checklistSummary, progressText, type Checklist } from '@/lib/workflow-checklist';
import { durationText, runStory, storySummary, type RunStory } from '@/lib/workflow-story';
import { stepDetail, type StepDetail } from '@/lib/workflow-step-detail';
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

/**
 * Every step on a run's path with what it did, and what the run leaves open. The ids the changes in
 * its open reviews decide are passed on, so an open item a waiting change settles is marked as such.
 */
export function runStoryOf(run: RunDetail | null, checklist?: Checklist | null): RunStory {
  const deciding = (run?.reviews || [])
    .filter((review) => review.status === 'OPEN')
    .flatMap((review) => review.proposal?.items || [])
    // A reconciliation decision names its review item. A borrower change settles the entry its tool and record name.
    .map((item) => (typeof item.args.itemId === 'string' ? item.args.itemId : settles(item.tool, item.args)))
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return runStory({ graph: run?.graph || null, status: run?.status || 'QUEUED', currentNode: run?.currentNode || null, steps: run?.steps || [], events: run?.events || [], checklist, deciding });
}

/**
 * What opening a step on the page shows, cut down for the assistant: what the step was asked, what an
 * agent read and proposed, the changes an apply step made, and the plain values of a fixed step's result.
 */
function openedStep(detail: StepDetail | null): Record<string, unknown> {
  if (!detail) return {};
  const reads = new Map<string, number>();
  for (const read of detail.reads) reads.set(read.what, (reads.get(read.what) || 0) + 1);
  const result = detail.result;
  return {
    whatItIs: detail.what,
    ...(detail.tool ? { tool: detail.tool, changesData: detail.changesData } : {}),
    ...(detail.asked.length > 0 ? { [detail.askedAsDesigned ? 'setUpWith' : 'askedWith']: Object.fromEntries(detail.asked.slice(0, 12).map((field) => [field.label, field.value])) } : {}),
    ...(detail.outcome ? { wentTheWay: detail.outcome } : {}),
    ...(detail.attempts > 1 ? { attempts: detail.attempts } : {}),
    ...(detail.error ? { error: detail.error } : {}),
    ...(detail.reads.length > 0 ? { read: [...reads.entries()].map(([what, times]) => (times > 1 ? `${what} (${times} times)` : what)), readsThatDidNotWork: detail.reads.filter((read) => !read.ok).length } : {}),
    ...(detail.proposals.length > 0 ? { proposed: detail.proposals.slice(0, 20).map((proposal) => ({ change: proposal.summary, needsCloseLook: proposal.needsReview })) } : {}),
    ...(detail.changes.length > 0 ? { changesMade: detail.changes.slice(0, 20).map((change) => ({ change: change.summary, made: change.ok, ...(change.error ? { whyNot: change.error } : {}) })) } : {}),
    ...(result && (result.fields.length > 0 || result.lists.length > 0)
      ? { returned: { ...Object.fromEntries(result.fields.slice(0, 12).map((field) => [field.label, field.value])), ...Object.fromEntries(result.lists.map((list) => [list.label, `${list.count} rows`])) } }
      : {}),
    ...(detail.usage ? { modelCalls: detail.usage.calls, ...(detail.usage.costUsd !== null ? { costUsd: detail.usage.costUsd } : {}) } : {}),
  };
}

/** The decisions of a run, and the forms and stages behind them, once they have loaded. */
export interface RunDecisionsView {
  checklist: Checklist;
  /** The run's steps as the page lists them. Built here when the caller has not built it. */
  story?: RunStory;
  stages: Array<{ nodeId: string; title: string; screen: string; instructions: string | null; status: string; canAct: boolean; blocker: string | null; returnedReason: string | null }>;
  forms: Array<{ nodeId: string; title: string; instructions: string | null; status: string; canAnswer: boolean; blocker: string | null; fields: unknown }>;
}

/** Both tabs of the run page, as the assistant reads them. */
export function runTabs(run: RunDetail | null, decisions?: RunDecisionsView | null): Record<string, TabPayload> {
  const nodeLabel = (id: string | null) => (id ? run?.graph?.nodes.find((node) => node.id === id)?.label || id : null);
  const story = decisions ? decisions.story || runStoryOf(run, decisions.checklist) : null;
  const opened = (nodeId: string) => (run && decisions ? openedStep(stepDetail({ graph: run.graph, status: run.status, currentNode: run.currentNode, steps: run.steps, events: run.events, checklist: decisions.checklist }, nodeId)) : {});
  return {
    overview: {
      label: 'Overview',
      purpose: 'What the run did step by step, the decisions it needs from people in order, which one is open now, the agent findings behind it, and what the run leaves open.',
      howToRead: 'checklist lists every point where a person decides something, numbered in the order the run reaches them. state is done, skipped (passed with nothing to decide), current (open and yours), waiting (open and someone else\'s), attention (failed) or ahead. An item with no number comes only on some choices and is not in the total. parts are the things to do inside the open decision, as its screen reports them. nextStep says what has to happen and who does it. A review lists the changes the agent proposed, in sections by kind (cash pairs, cash adjustments, reconciliation decisions, other changes, notes), decided in that order; agentShows are the views the agent asked the reviewer to look at, and why. Nothing is written to a record until a reviewer approves and applies them. "Needs a close look" means the agent was unsure or is missing a value. steps lists every step on the run\'s path in order: by is the system, the agent or a person; did is what it did in one line and facts are its key figures; a step with a decision number is a person\'s and is the same decision as on the checklist; state ahead means not run yet, and onlyOnSomeChoices means the run may not reach it. trouble is a failure a retry got past. Every step in the list opens on the page to show the rest, and each step carries it here: whatItIs says what kind of step it is; askedWith is what it ran with, and setUpWith is its design when it has not run (a value in words such as what “Select records” returned is filled in when it runs); read is what an agent read, proposed what it proposed, changesMade what an apply step made of each approved change, and returned the plain values and the size of each list a fixed step got back. stillOpen is what the run found open and does not settle itself, each with the next step and who it sits with; decidedInThisRun means a change waiting in the open review decides it, and holdsUpTheClose that it blocks finishing. checklist, steps and stillOpen are null while the forms and screens of the run load.',
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
            steps: story
              ? {
                  summary: storySummary(story),
                  items: story.steps.slice(0, 60).map((step) => ({
                    step: step.label,
                    by: step.kind === 'fixed' ? 'system' : step.kind === 'agent' ? 'agent' : 'person',
                    state: step.state,
                    ...(step.decision !== null ? { decision: step.decision } : {}),
                    ...(step.did ? { did: step.did } : {}),
                    ...(step.facts.length > 0 ? { facts: Object.fromEntries(step.facts.map((fact) => [fact.label, fact.value])) } : {}),
                    ...(durationText(step.seconds) ? { took: durationText(step.seconds) } : {}),
                    ...(step.trouble ? { trouble: step.trouble } : {}),
                    ...(step.certain ? {} : { onlyOnSomeChoices: true }),
                    ...opened(step.nodeId),
                  })),
                }
              : null,
            stillOpen: story
              ? { foundBy: story.openFrom, items: story.open.slice(0, 40).map((item) => ({ item: item.title, why: item.why, nextStep: item.action, who: item.owner, holdsUpTheClose: item.blocking, decidedInThisRun: item.decidedHere })) }
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
