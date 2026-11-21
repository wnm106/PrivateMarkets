/**
 * The home page is a column of modules. A person's layout only stores where
 * they differ from the default for their role, so this file decides the
 * default and folds a saved layout over it. Everything here is pure.
 */

export type HomeModuleCode = 'needs-you' | 'agents' | 'brief' | 'places' | 'following' | 'data-health';

export interface HomeModuleDef {
  code: HomeModuleCode;
  title: string;
  description: string;
}

export const HOME_MODULES: readonly HomeModuleDef[] = [
  { code: 'needs-you', title: 'Needs you', description: 'Reviews, files, and runs waiting on an action.' },
  { code: 'agents', title: 'Agents at work', description: 'Workflow runs in flight, and which agent is behind each.' },
  { code: 'brief', title: 'Your brief', description: 'The latest summary from your assistant.' },
  { code: 'following', title: 'Following', description: 'The latest change on each thing you follow.' },
  { code: 'places', title: 'Your surfaces', description: 'The surfaces and pages you work in.' },
  { code: 'data-health', title: 'Data health', description: 'Records, quality, open exceptions, and sources.' },
];

export interface HomeUser {
  permissions: readonly string[];
  isTenantAdmin: boolean;
}

/** Permissions that mark someone who looks after the data itself. */
const DATA_OPS_PERMISSIONS = ['dq.manage', 'feed.manage', 'job.manage'];

export type HomeRole = 'data-ops' | 'reviewer' | 'member';

export function homeRole(user: HomeUser): HomeRole {
  if (user.isTenantAdmin || user.permissions.some((code) => DATA_OPS_PERMISSIONS.includes(code))) return 'data-ops';
  if (user.permissions.includes('workflow.review')) return 'reviewer';
  return 'member';
}

export const ROLE_LABEL: Record<HomeRole, string> = {
  'data-ops': 'Data operations',
  reviewer: 'Reviewer',
  member: 'Team member',
};

/** Modules hidden for a role until the person turns them on. */
export function defaultHiddenModules(user: HomeUser): HomeModuleCode[] {
  return homeRole(user) === 'data-ops' ? [] : ['data-health'];
}

const MODULE_CODES = new Set<string>(HOME_MODULES.map((module) => module.code));

/** The modules to render, in order. A saved list replaces the role default. */
export function visibleModules(user: HomeUser, hidden: readonly string[] | null | undefined): HomeModuleCode[] {
  const off = new Set(hidden ?? defaultHiddenModules(user));
  return HOME_MODULES.map((module) => module.code).filter((code) => !off.has(code));
}

/** The hidden list to save after turning one module on or off. */
export function toggleModule(
  user: HomeUser,
  hidden: readonly string[] | null | undefined,
  code: HomeModuleCode,
  show: boolean,
): string[] {
  const next = new Set((hidden ?? defaultHiddenModules(user)).filter((value) => MODULE_CODES.has(value)));
  if (show) next.delete(code);
  else next.add(code);
  return HOME_MODULES.map((module) => module.code).filter((value) => next.has(value));
}

/** Somewhere a person can go: a mounted surface or a built-in page. */
export interface HomePlace {
  key: string;
  title: string;
  description: string;
  href: string;
  /** Shown when the person has not chosen their own pins. */
  pinnedByDefault: boolean;
}

/** The pinned places, in order. A saved list keeps only places still available. */
export function pinnedPlaces(places: readonly HomePlace[], pinned: readonly string[] | null | undefined): HomePlace[] {
  if (!pinned) return places.filter((place) => place.pinnedByDefault);
  const byKey = new Map(places.map((place) => [place.key, place]));
  return pinned.map((key) => byKey.get(key)).filter((place): place is HomePlace => Boolean(place));
}

/** The pin list to save after pinning or unpinning one place. New pins go last. */
export function togglePin(
  places: readonly HomePlace[],
  pinned: readonly string[] | null | undefined,
  key: string,
  pin: boolean,
): string[] {
  const current = pinnedPlaces(places, pinned).map((place) => place.key);
  if (pin) return current.includes(key) ? current : [...current, key];
  return current.filter((value) => value !== key);
}

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

export type Urgency = 'critical' | 'high' | 'normal';

/** Decide: someone has to make a call. Fix: something broke and needs a hand. */
export type NeedsYouLane = 'decide' | 'fix';

export type NeedsYouKind = 'review' | 'workflow-step' | 'file-review' | 'file-failed' | 'job-failed' | 'run-failed' | 'exception' | 'urgent-exceptions';

export interface NeedsYouItem {
  id: string;
  lane: NeedsYouLane;
  kind: NeedsYouKind;
  /** Items with the same group collapse into one row. */
  group: string;
  groupTitle: string;
  /** Proposed changes in a review. */
  changes?: number;
  urgency: Urgency;
  title: string;
  detail: string;
  href: string;
  action: string;
  at: string;
  /** A count across the client rather than one event; it has no time of its own. */
  aggregate?: boolean;
}

export interface ReviewSource {
  id: string;
  runId: string;
  title: string;
  workflowName?: string | null;
  itemCount: number;
  canReview: boolean;
  createdAt: string;
  dueAt?: string | null;
  overdue?: boolean;
}

/** A form to answer or a screen to work in a workflow run, from the person's tasks. */
export interface WorkflowStepSource {
  id: string;
  kind: 'form' | 'stage';
  runId: string;
  nodeId: string;
  title: string;
  workflowName?: string | null;
  detail: string;
  canAct: boolean;
  createdAt: string;
  dueAt?: string | null;
  overdue?: boolean;
}

export interface FileSource {
  id: string;
  feedName?: string | null;
  fileName: string;
  status: string;
  message?: string | null;
  lastSeenAt: string;
}

export interface JobSource {
  id: string;
  jobTypeLabel: string;
  scheduleName?: string | null;
  status: string;
  errorMessage?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

export interface WorkflowRunSource {
  id: string;
  workflowName?: string | null;
  status: string;
  errorMessage?: string | null;
  startedBy?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

export interface ExceptionSource {
  id: string;
  entityId: string;
  entityName: string;
  entityHref: string;
  exceptionMessage: string;
  severity: string;
  detectedAt: string;
}

export interface NeedsYouSources {
  now: Date;
  userId: string | null;
  reviews?: readonly ReviewSource[];
  /** Forms and screens waiting on the person. Reviews come in under reviews. */
  workflowSteps?: readonly WorkflowStepSource[];
  files?: readonly FileSource[];
  jobs?: readonly JobSource[];
  workflowRuns?: readonly WorkflowRunSource[];
  /** Open exceptions on records the person follows. */
  followedExceptions?: readonly ExceptionSource[];
  /** Open high and critical exceptions across the client; shown as one line. */
  urgentExceptionCount?: number;
}

const DAY = 24 * 60 * 60 * 1000;

function within(iso: string | null | undefined, now: Date, days: number) {
  const time = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(time) && now.getTime() - time <= days * DAY;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const URGENCY_RANK: Record<Urgency, number> = { critical: 0, high: 1, normal: 2 };

/** One list of what is waiting on this person, most urgent and newest first. */
export function needsYouItems(sources: NeedsYouSources): NeedsYouItem[] {
  const { now } = sources;
  const items: NeedsYouItem[] = [];

  for (const review of sources.reviews || []) {
    if (!review.canReview) continue;
    items.push({
      id: `review-${review.id}`,
      lane: 'decide',
      kind: 'review',
      group: `review:${review.workflowName || review.title}`,
      groupTitle: review.workflowName || review.title,
      changes: review.itemCount,
      urgency: review.overdue ? 'critical' : 'high',
      title: review.title,
      detail: [review.workflowName, plural(review.itemCount, 'proposed change'), review.dueAt ? `${review.overdue ? 'was due' : 'due'} ${review.dueAt.slice(0, 16).replace('T', ' ')} UTC` : null]
        .filter(Boolean)
        .join(' · '),
      href: `/workflows/runs/${review.runId}`,
      action: 'Review',
      at: review.createdAt,
    });
  }

  for (const step of sources.workflowSteps || []) {
    if (!step.canAct) continue;
    const word = step.kind === 'form' ? 'Answer' : 'Open';
    items.push({
      id: `${step.kind}-${step.id}`,
      lane: 'decide',
      kind: 'workflow-step',
      group: `${step.kind}:${step.id}`,
      groupTitle: step.title,
      urgency: step.overdue ? 'critical' : 'high',
      title: step.title,
      detail: [step.workflowName, step.detail, step.dueAt ? `${step.overdue ? 'was due' : 'due'} ${step.dueAt.slice(0, 16).replace('T', ' ')} UTC` : null].filter(Boolean).join(' · '),
      href: `/workflows/runs/${step.runId}?decision=${encodeURIComponent(step.nodeId)}`,
      action: word,
      at: step.createdAt,
    });
  }

  for (const file of sources.files || []) {
    if (!within(file.lastSeenAt, now, 7)) continue;
    if (file.status === 'NEEDS_REVIEW') {
      items.push({
        id: `file-${file.id}`,
        lane: 'decide',
        kind: 'file-review',
        group: `file-review:${file.feedName || ''}`,
        groupTitle: file.feedName ? `Files from ${file.feedName} waiting for review` : 'Files waiting for review',
        urgency: 'normal',
        title: `${file.fileName} is waiting for review`,
        detail: [file.feedName, file.message].filter(Boolean).join(' · '),
        href: '/imports',
        action: 'Open',
        at: file.lastSeenAt,
      });
    } else if (file.status === 'FAILED') {
      items.push({
        id: `file-${file.id}`,
        lane: 'fix',
        kind: 'file-failed',
        group: `file-failed:${file.feedName || ''}`,
        groupTitle: file.feedName ? `Files from ${file.feedName} failed to load` : 'Files failed to load',
        urgency: 'high',
        title: `${file.fileName} failed to load`,
        detail: [file.feedName, file.message].filter(Boolean).join(' · '),
        href: '/admin/feeds',
        action: 'Open',
        at: file.lastSeenAt,
      });
    }
  }

  for (const job of sources.jobs || []) {
    const at = job.finishedAt || job.createdAt;
    if (job.status !== 'FAILED' || !within(at, now, 3)) continue;
    items.push({
      id: `job-${job.id}`,
      lane: 'fix',
      kind: 'job-failed',
      group: `job:${job.scheduleName || job.jobTypeLabel}`,
      groupTitle: `${job.scheduleName || job.jobTypeLabel} failed`,
      urgency: 'normal',
      title: `${job.scheduleName || job.jobTypeLabel} failed`,
      detail: job.errorMessage || job.jobTypeLabel,
      href: '/admin/jobs',
      action: 'Retry',
      at,
    });
  }

  for (const run of sources.workflowRuns || []) {
    const at = run.finishedAt || run.createdAt;
    if (run.status !== 'FAILED' || !within(at, now, 7)) continue;
    if (!sources.userId || run.startedBy !== sources.userId) continue;
    items.push({
      id: `run-${run.id}`,
      lane: 'fix',
      kind: 'run-failed',
      group: `run:${run.workflowName || ''}`,
      groupTitle: `${run.workflowName || 'A workflow'} failed`,
      urgency: 'high',
      title: `${run.workflowName || 'A workflow'} failed`,
      detail: run.errorMessage || 'Your run stopped before it finished.',
      href: `/workflows/runs/${run.id}`,
      action: 'Open',
      at,
    });
  }

  for (const exception of sources.followedExceptions || []) {
    const urgency: Urgency = exception.severity === 'CRITICAL' ? 'critical' : exception.severity === 'HIGH' ? 'high' : 'normal';
    items.push({
      id: `dq-${exception.id}`,
      lane: 'fix',
      kind: 'exception',
      group: `dq:${exception.entityId}`,
      groupTitle: `Exceptions on ${exception.entityName}`,
      urgency,
      title: exception.exceptionMessage,
      detail: `${exception.entityName} · a record you follow`,
      href: exception.entityHref,
      action: 'View',
      at: exception.detectedAt,
    });
  }

  if (sources.urgentExceptionCount && sources.urgentExceptionCount > 0) {
    items.push({
      id: 'dq-urgent',
      lane: 'fix',
      kind: 'urgent-exceptions',
      group: 'dq-urgent',
      groupTitle: `${plural(sources.urgentExceptionCount, 'high-priority exception')} open`,
      urgency: 'critical',
      title: `${plural(sources.urgentExceptionCount, 'high-priority exception')} open`,
      detail: 'Across this client’s records',
      href: '/quality',
      action: 'Triage',
      at: now.toISOString(),
      aggregate: true,
    });
  }

  return items.sort((a, b) => {
    const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (rank !== 0) return rank;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
}

/** Several items of the same kind from the same place, shown as one row. */
export interface NeedsYouGroup {
  key: string;
  lane: NeedsYouLane;
  kind: NeedsYouKind;
  urgency: Urgency;
  title: string;
  count: number;
  changes: number;
  newestAt: string;
  oldestAt: string;
  aggregate: boolean;
  /** Newest first. */
  items: NeedsYouItem[];
  /** Where the row's button goes: the oldest review (work a queue from the front), otherwise the newest item. */
  href: string;
  action: string;
}

function time(iso: string) {
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function groupNeedsYou(items: readonly NeedsYouItem[]): NeedsYouGroup[] {
  const groups = new Map<string, NeedsYouItem[]>();
  for (const item of items) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  const result: NeedsYouGroup[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => time(b.at) - time(a.at));
    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    const urgency = sorted.reduce<Urgency>((best, item) => (URGENCY_RANK[item.urgency] < URGENCY_RANK[best] ? item.urgency : best), 'normal');
    const target = newest.kind === 'review' ? oldest : newest;
    result.push({
      key,
      lane: newest.lane,
      kind: newest.kind,
      urgency,
      title: sorted.length === 1 && newest.kind !== 'review' ? newest.title : newest.groupTitle,
      count: sorted.length,
      changes: sorted.reduce((sum, item) => sum + (item.changes || 0), 0),
      newestAt: newest.at,
      oldestAt: oldest.at,
      aggregate: sorted.some((item) => item.aggregate),
      items: sorted,
      href: target.href,
      action: newest.kind === 'review' && sorted.length > 1 ? 'Start with oldest' : target.action,
    });
  }
  return result.sort((a, b) => {
    const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (rank !== 0) return rank;
    return time(b.newestAt) - time(a.newestAt);
  });
}

export interface HomeSummary {
  reviews: number;
  proposedChanges: number;
  /** Forms to answer and screens to work in workflow runs. */
  steps?: number;
  filesWaiting: number;
  failures: number;
  urgentExceptions: number;
}

export function summarize(items: readonly NeedsYouItem[], urgentExceptionCount = 0): HomeSummary {
  const summary: HomeSummary = { reviews: 0, proposedChanges: 0, filesWaiting: 0, failures: 0, urgentExceptions: urgentExceptionCount };
  for (const item of items) {
    if (item.kind === 'review') {
      summary.reviews += 1;
      summary.proposedChanges += item.changes || 0;
    } else if (item.kind === 'workflow-step') summary.steps = (summary.steps || 0) + 1;
    else if (item.kind === 'file-review') summary.filesWaiting += 1;
    else if (item.kind === 'file-failed' || item.kind === 'job-failed' || item.kind === 'run-failed') summary.failures += 1;
  }
  return summary;
}

function joinPhrases(parts: string[]) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** One sentence that says what is waiting, most important first. */
export function headline(summary: HomeSummary): string {
  const waiting: string[] = [];
  if (summary.reviews) {
    waiting.push(
      summary.proposedChanges
        ? `${plural(summary.reviews, 'review')} (${plural(summary.proposedChanges, 'proposed change')})`
        : plural(summary.reviews, 'review'),
    );
  }
  if (summary.steps) waiting.push(`${summary.steps} ${summary.steps === 1 ? 'form or screen' : 'forms and screens'} in workflow runs`);
  if (summary.filesWaiting) waiting.push(plural(summary.filesWaiting, 'file'));
  const broken: string[] = [];
  if (summary.urgentExceptions) broken.push(plural(summary.urgentExceptions, 'high-priority exception'));
  if (summary.failures) broken.push(`${plural(summary.failures, 'failed run')}`);

  if (!waiting.length && !broken.length) return 'You’re all caught up. Nothing is waiting on you.';
  const sentences: string[] = [];
  if (waiting.length) sentences.push(`${joinPhrases(waiting)} ${waiting.length === 1 && (summary.reviews + (summary.steps || 0) + summary.filesWaiting) === 1 ? 'is' : 'are'} waiting for your decision.`);
  if (broken.length) sentences.push(`${joinPhrases(broken)} need${broken.length === 1 && (summary.urgentExceptions + summary.failures) === 1 ? 's' : ''} attention.`);
  return sentences.join(' ');
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now.getTime() - then) / 60000);
  if (minutes < 0) {
    const ahead = -minutes;
    if (ahead < 60) return `in ${ahead}m`;
    if (ahead < 24 * 60) return `in ${Math.round(ahead / 60)}h`;
    return new Date(iso).toLocaleDateString();
  }
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function greeting(now: Date, name: string | null | undefined) {
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = (name || '').trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

// ---------------------------------------------------------------------------
// The briefing at the top of the page
// ---------------------------------------------------------------------------

/** The opening line after the greeting: how much is waiting and where to start. */
export function heroLead(groups: readonly NeedsYouGroup[]): { lead: string; start: string | null } {
  if (groups.length === 0) return { lead: 'Nothing is waiting on you.', start: null };
  const count = groups.length;
  const words = ['', 'One thing needs', 'Two things need', 'Three things need', 'Four things need', 'Five things need', 'Six things need'];
  const lead = count < words.length ? `${words[count]} you` : `${count} things need you`;
  return { lead, start: groups[0].title };
}

/** What the agents report, enough of it to say what they did. */
export interface AgentsSummary {
  running: number;
  waiting: number;
  finished: ReadonlyArray<{ outcome: 'done' | 'failed' }>;
}

/** One or two sentences on what the agents did and are doing. */
export function agentLine(board: AgentsSummary | null): string {
  if (!board) return 'Checking what your agents are doing…';
  const done = board.finished.filter((item) => item.outcome === 'done').length;
  const failed = board.finished.length - done;
  const sentences: string[] = [];
  if (board.finished.length > 0) {
    sentences.push(`In the last day your agents finished ${plural(done, 'run')}${failed ? ` and ${failed} stopped with an error` : ''}.`);
  }
  // `running` counts runs moving or queued; `waiting` counts runs paused on a person.
  const now: string[] = [];
  if (board.running > 0) now.push(`${plural(board.running, 'run')} ${board.running === 1 ? 'is' : 'are'} in progress`);
  if (board.waiting > 0) now.push(`${plural(board.waiting, 'run')} ${board.waiting === 1 ? 'is' : 'are'} paused for a review`);
  if (now.length) sentences.push(`${now.join(' and ')}.`.replace(/^./, (first) => first.toUpperCase()));
  if (!sentences.length) return 'Your agents are idle. Hand them a task below and they will bring back what they find.';
  return sentences.join(' ');
}

/** The short tag on a row in the queue. */
export const KIND_LABEL: Record<NeedsYouKind, string> = {
  review: 'Review',
  'workflow-step': 'Workflow',
  'file-review': 'File',
  'file-failed': 'File failed',
  'job-failed': 'Job failed',
  'run-failed': 'Run failed',
  exception: 'Exception',
  'urgent-exceptions': 'Exceptions',
};

/** What the home page tells the assistant it is showing. */
export function homePageData(input: {
  headline: string;
  scope: 'mine' | 'all' | null;
  groups: readonly NeedsYouGroup[] | null;
  hiddenReviews: number;
  agents: string;
}): Record<string, unknown> {
  return {
    page: 'Home',
    purpose: 'The briefing a person sees first: what is waiting on them, what their agents did, and where to go next.',
    howToRead: 'Decide items are proposals or files waiting on a call. Fix items are things that broke. Rows are ordered most urgent first, then newest.',
    headline: input.headline,
    scope: input.scope === 'mine' ? 'Narrowed to the records this person follows or is responsible for' : 'Everything this person can see',
    waiting: input.groups
      ? {
          decide: input.groups.filter((group) => group.lane === 'decide').reduce((sum, group) => sum + group.count, 0),
          fix: input.groups.filter((group) => group.lane === 'fix').reduce((sum, group) => sum + group.count, 0),
          hiddenReviews: input.hiddenReviews,
          items: input.groups.slice(0, 40).map((group) => ({
            lane: group.lane,
            kind: KIND_LABEL[group.kind],
            urgency: group.urgency,
            title: group.title,
            count: group.count,
            detail: group.items[0]?.detail || null,
            action: group.action,
          })),
        }
      : null,
    agents: input.agents,
  };
}
