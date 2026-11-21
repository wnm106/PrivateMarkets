'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { markdownToHtml } from '@/lib/markdown';
import { cardOrder } from '@/lib/home-decisions';
import { DecisionCards } from '@/components/home/DecisionCards';
import {
  KIND_LABEL,
  groupNeedsYou,
  needsYouItems,
  relativeTime,
  type ExceptionSource,
  type FileSource,
  type HomePlace,
  type HomeSummary,
  type JobSource,
  type NeedsYouGroup,
  type NeedsYouItem,
  type NeedsYouLane,
  type ReviewSource,
  type WorkflowRunSource,
  type WorkflowStepSource,
} from '@/lib/home';

export interface HomeFollow {
  id: string;
  subjectType: string;
  subjectId: string | null;
  subjectCode: string | null;
  label: string;
  delivery: string;
  domainCode: string | null;
  lastSummary: string | null;
  lastAt: string | null;
}

export function followHref(follow: HomeFollow): string | null {
  if (follow.subjectType === 'ENTITY' && follow.subjectId && follow.domainCode) return `${domainHref(follow.domainCode)}/${follow.subjectId}`;
  if (follow.subjectType === 'FEED' || follow.subjectType === 'KIND') return '/admin/feeds';
  return null;
}

// ---------------------------------------------------------------------------
// Loading what is waiting
// ---------------------------------------------------------------------------

/**
 * Each source is its own request. One that fails, or that the person has no
 * permission for, drops out of the list instead of breaking it.
 */
async function loadSources(follows: HomeFollow[], includeClientWide: boolean) {
  const followedIds = follows.filter((follow) => follow.subjectType === 'ENTITY' && follow.subjectId).map((follow) => follow.subjectId as string);

  const [reviews, files, jobs, runs, followed, urgent, tasks] = await Promise.all([
    graphqlQuery<{ workflowReviews: ReviewSource[] }>(
      `query { workflowReviews(status: "OPEN") { id runId title workflowName itemCount canReview createdAt dueAt overdue } }`,
      {},
      'network-only',
    ),
    graphqlQuery<{ receivedFiles: FileSource[] }>(
      `query { receivedFiles(first: 50) { id feedName fileName status message lastSeenAt } }`,
      {},
      'network-only',
    ),
    includeClientWide
      ? graphqlQuery<{ jobRuns: JobSource[] }>(
          `query { jobRuns(status: "FAILED", first: 20) { id jobTypeLabel scheduleName status errorMessage finishedAt createdAt } }`,
          {},
          'network-only',
        )
      : Promise.resolve({ data: undefined }),
    graphqlQuery<{ workflowRuns: WorkflowRunSource[] }>(
      `query { workflowRuns(status: "FAILED", first: 20) { id workflowName status errorMessage startedBy finishedAt createdAt } }`,
      {},
      'network-only',
    ),
    followedIds.length
      ? graphqlQuery<{ dqExceptions: { edges: Array<{ node: Omit<ExceptionSource, 'entityHref'> & { domainCode: string } }> } }>(
          `query HomeFollowedExceptions($ids: [ID!]) {
            dqExceptions(filter: { status: OPEN, entityId: { in: $ids } }, pagination: { first: 20 }) {
              edges { node { id entityId entityName domainCode exceptionMessage severity detectedAt } }
            }
          }`,
          { ids: followedIds },
          'network-only',
        )
      : Promise.resolve({ data: undefined }),
    includeClientWide
      ? graphqlQuery<{ high: { totalCount: number }; critical: { totalCount: number } }>(
          `query {
            high: dqExceptions(filter: { status: OPEN, severity: HIGH }, pagination: { first: 1 }) { totalCount }
            critical: dqExceptions(filter: { status: OPEN, severity: CRITICAL }, pagination: { first: 1 }) { totalCount }
          }`,
          {},
          'network-only',
        )
      : Promise.resolve({ data: undefined }),
    // Forms and screens come from the person's tasks, the same list the top bar counts.
    graphqlQuery<{ myTasks: { tasks: Array<WorkflowStepSource & { kind: string }> } }>(
      `query { myTasks { tasks { id kind runId nodeId title workflowName detail canAct createdAt dueAt overdue } } }`,
      {},
      'network-only',
    ),
  ]);

  return {
    reviews: reviews.data?.workflowReviews,
    workflowSteps: (tasks.data?.myTasks.tasks || []).filter((task): task is WorkflowStepSource => task.kind === 'form' || task.kind === 'stage'),
    files: files.data?.receivedFiles,
    jobs: jobs.data?.jobRuns,
    workflowRuns: runs.data?.workflowRuns,
    followedExceptions: followed.data?.dqExceptions?.edges.map(({ node }) => ({
      ...node,
      entityHref: `${domainHref(node.domainCode)}/${node.entityId}`,
    })),
    urgentExceptionCount: urgent.data ? (urgent.data.high?.totalCount || 0) + (urgent.data.critical?.totalCount || 0) : 0,
  };
}

export interface NeedsYouState {
  items: NeedsYouItem[];
  urgentExceptionCount: number;
  /** The open reviews, for the decision cards. */
  reviews: ReviewSource[];
}

/** Waits for the follows (they decide which exceptions count), then loads everything once. */
export function useNeedsYou(userId: string | null, follows: HomeFollow[] | null, clientWide: boolean): NeedsYouState | null {
  const [state, setState] = useState<NeedsYouState | null>(null);
  useEffect(() => {
    if (follows === null) return;
    let cancelled = false;
    loadSources(follows, clientWide).then((sources) => {
      if (cancelled) return;
      setState({ items: needsYouItems({ now: new Date(), userId, ...sources }), urgentExceptionCount: sources.urgentExceptionCount, reviews: sources.reviews || [] });
    });
    return () => {
      cancelled = true;
    };
  }, [follows, userId, clientWide]);
  return state;
}

// ---------------------------------------------------------------------------
// At a glance: the counts beside the briefing
// ---------------------------------------------------------------------------

interface Tile {
  key: string;
  label: string;
  value: number;
  sub: string;
  href: string;
  tone: 'decide' | 'fix' | 'critical';
}

export function FocusTiles({ summary, showExceptions }: { summary: HomeSummary | null; showExceptions: boolean }) {
  const tiles: Tile[] = [
    {
      key: 'reviews',
      label: 'To review',
      value: (summary?.reviews ?? 0) + (summary?.steps ?? 0),
      sub: [summary?.proposedChanges ? `${summary.proposedChanges} proposed changes` : '', summary?.steps ? `${summary.steps} ${summary.steps === 1 ? 'form or screen' : 'forms and screens'}` : ''].filter(Boolean).join(', ') || 'Agent proposals',
      href: '#needs-you',
      tone: 'decide',
    },
    { key: 'files', label: 'Files waiting', value: summary?.filesWaiting ?? 0, sub: 'Need a mapping or a check', href: '#needs-you', tone: 'decide' },
    { key: 'failures', label: 'Failed', value: summary?.failures ?? 0, sub: 'Runs, jobs and files', href: '#needs-you', tone: 'fix' },
  ];
  if (showExceptions) {
    tiles.push({ key: 'exceptions', label: 'Urgent exceptions', value: summary?.urgentExceptions ?? 0, sub: 'High and critical, open', href: '/quality', tone: 'critical' });
  }
  return (
    <div className="hx-glance" aria-label="At a glance">
      {tiles.map((tile) => {
        const active = (summary ? tile.value : 0) > 0;
        return (
          <a key={tile.key} href={tile.href} className={`hx-glance-tile tone-${tile.tone}${active ? ' is-active' : ''}`}>
            <span className="hx-glance-label">{tile.label}</span>
            <span className="hx-glance-value">{summary ? tile.value : '—'}</span>
            <span className="hx-glance-sub">
              {active ? tile.sub : summary ? (
                <>
                  <span className="hx-glance-ok" aria-hidden>✓</span> All clear
                </>
              ) : (
                ' '
              )}
            </span>
          </a>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs you: one queue, most urgent first, filtered by Decide or Fix
// ---------------------------------------------------------------------------

type QueueFilter = 'all' | NeedsYouLane;

function groupMeta(group: NeedsYouGroup) {
  const parts: string[] = [];
  if (group.kind === 'review') {
    parts.push(`${group.count} review${group.count === 1 ? '' : 's'}`);
    if (group.changes) parts.push(`${group.changes} proposed change${group.changes === 1 ? '' : 's'}`);
  } else if (group.count > 1) {
    parts.push(`${group.count} times`);
  }
  if (!group.aggregate) {
    parts.push(group.count > 1 ? `latest ${relativeTime(group.newestAt)}` : relativeTime(group.newestAt));
  }
  return parts.join(' · ');
}

function tagTone(group: NeedsYouGroup) {
  if (group.urgency === 'critical') return 'tone-critical';
  return group.lane === 'decide' ? 'tone-decide' : 'tone-fix';
}

function GroupRow({ group }: { group: NeedsYouGroup }) {
  const [open, setOpen] = useState(false);
  const latest = group.items[0];
  const detail = group.kind === 'review' ? latest.title : latest.detail;
  return (
    <li className={`hx-row lane-${group.lane} urgency-${group.urgency}`}>
      <div className="hx-row-main">
        <div className="hx-row-text">
          <div className="hx-row-meta">
            <span className={`hx-tag ${tagTone(group)}`}>{KIND_LABEL[group.kind]}</span>
            <span>{groupMeta(group)}</span>
          </div>
          <div className="hx-row-title">{group.title}</div>
          {detail && <div className="hx-row-detail" title={detail}>{detail}</div>}
          {group.count > 1 && (
            <button type="button" className="home-link-button hx-row-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              {open ? 'Hide' : `Show all ${group.count}`}
            </button>
          )}
        </div>
        <Link href={group.href} className={`btn btn-sm${group.lane === 'decide' || group.urgency === 'critical' ? ' btn-primary' : ''}`}>{group.action}</Link>
      </div>
      {open && (
        <ul className="hx-row-items">
          {group.items.map((item) => (
            <li key={item.id}>
              <Link href={item.href}>{item.kind === 'review' ? item.detail : item.detail || item.title}</Link>
              <time className="home-muted">{relativeTime(item.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const QUEUE_LIMIT = 6;

/** How many reviews are shown as cards. The rest stay in the list. */
const CARD_LIMIT = 3;

export function NeedsYouQueue({
  items,
  reviews,
  hiddenReviews = 0,
  onShowEverything,
}: {
  items: NeedsYouItem[] | null;
  reviews?: ReviewSource[];
  hiddenReviews?: number;
  onShowEverything?: () => void;
}) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const cardIds = useMemo(() => cardOrder(reviews || [], CARD_LIMIT).map((review) => review.id), [reviews]);
  // A review shown as a card is not listed again below. One whose card could not load stays listed.
  const [carded, setCarded] = useState<string[]>([]);
  const groups = useMemo(() => {
    if (!items) return [];
    const hidden = new Set(carded.map((id) => `review-${id}`));
    return groupNeedsYou(items.filter((item) => !hidden.has(item.id)));
  }, [items, carded]);

  if (!items) return <div className="home-empty">Checking what is waiting on you…</div>;

  const count = (lane: NeedsYouLane) =>
    groups.filter((group) => group.lane === lane).reduce((sum, group) => sum + group.count, 0) + (lane === 'decide' ? carded.length : 0);
  const filters: Array<{ key: QueueFilter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: count('decide') + count('fix') },
    { key: 'decide', label: 'Decide', count: count('decide') },
    { key: 'fix', label: 'Fix', count: count('fix') },
  ];
  const visible = filter === 'all' ? groups : groups.filter((group) => group.lane === filter);
  const shown = showAll ? visible : visible.slice(0, QUEUE_LIMIT);
  const empty = filters[0].count === 0;

  return (
    <div className="hx-queue">
      {!empty && (
        <div className="hx-filter" role="group" aria-label="Show">
          {filters.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`hx-filter-option${filter === entry.key ? ' is-on' : ''}`}
              aria-pressed={filter === entry.key}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label} <span className="hx-filter-count">{entry.count}</span>
            </button>
          ))}
        </div>
      )}

      <div hidden={filter === 'fix'}>
        <DecisionCards reviewIds={cardIds} onShown={setCarded} />
      </div>

      {empty ? (
        <div className="hx-clear">
          <span className="hx-clear-mark" aria-hidden>✓</span>
          <div>
            <strong>You’re all caught up.</strong>
            <p>Nothing is waiting on your decision and nothing is broken. Your agents will bring anything new back here.</p>
          </div>
        </div>
      ) : visible.length === 0 && (filter === 'fix' || carded.length === 0) ? (
        <p className="hx-quiet hx-queue-empty">{filter === 'fix' ? 'Nothing is broken.' : 'No other decisions waiting.'}</p>
      ) : (
        <ul className="hx-rows">
          {shown.map((group) => <GroupRow key={group.key} group={group} />)}
        </ul>
      )}

      {visible.length > QUEUE_LIMIT && (
        <button type="button" className="home-link-button hx-queue-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show ${visible.length - QUEUE_LIMIT} more`}
        </button>
      )}

      {hiddenReviews > 0 && onShowEverything && (
        <div className="hx-queue-note">
          {hiddenReviews} review{hiddenReviews === 1 ? ' is' : 's are'} on records outside yours.{' '}
          <button type="button" className="home-link-button" onClick={onShowEverything}>Show everything</button>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Your brief
// ---------------------------------------------------------------------------

export interface Brief {
  available: boolean;
  enabled: boolean;
  preset: string;
  nextDeliveryAt: string | null;
  conversationId: string | null;
  content: string | null;
  deliveredAt: string | null;
  followCount: number;
}

export function useBrief(): { brief: Brief | null; problem: string | null } {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ homeBrief: Brief }>(
      `query { homeBrief { available enabled preset nextDeliveryAt conversationId content deliveredAt followCount } }`,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.data?.homeBrief) setBrief(result.data.homeBrief);
      else setProblem(result.error?.message || 'Your brief could not be loaded.');
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { brief, problem };
}

const BRIEF_PREVIEW_CHARS = 900;

export function BriefView({ brief }: { brief: Brief }) {
  const [expanded, setExpanded] = useState(false);
  const content = brief.content || '';
  const long = content.length > BRIEF_PREVIEW_CHARS;
  // The renderer knows three heading levels. Deeper ones are shown as the third.
  const html = useMemo(() => (content ? markdownToHtml(content.replace(/^#{4,}\s/gm, '### ')) : ''), [content]);

  if (!brief.available) return <div className="home-empty">Choose one client to see your brief.</div>;

  if (!brief.enabled && !content) {
    return (
      <div className="home-cta">
        <p>Your assistant can watch the records and feeds you care about and send you a summary each morning.</p>
        <Link href="/assistant" className="btn btn-sm btn-primary">Set up your brief</Link>
      </div>
    );
  }

  return (
    <div className="home-brief">
      <div className="home-brief-meta">
        {brief.deliveredAt ? <>Delivered {relativeTime(brief.deliveredAt)}</> : 'No brief yet'}
        {brief.enabled && brief.nextDeliveryAt && <> · next {relativeTime(brief.nextDeliveryAt)}</>}
        {!brief.enabled && <> · paused</>}
        {' · '}
        {brief.followCount} followed
      </div>
      {content ? (
        <>
          <div className={`home-brief-body${long && !expanded ? ' is-clipped' : ''}`}>
            <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
          {long && (
            <button type="button" className="home-link-button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Show less' : 'Read the whole brief'}
            </button>
          )}
        </>
      ) : (
        <div className="home-empty">Nothing you follow has changed since you turned the assistant on.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup: shown in place of an empty brief and an empty follow list
// ---------------------------------------------------------------------------

export function SetupCard({ hasFollows, briefOn, hasPins }: { hasFollows: boolean; briefOn: boolean; hasPins: boolean }) {
  const steps = [
    { done: hasFollows, title: 'Follow what you care about', body: 'Pick records, feeds, or kinds of alerts. Their changes show up here.', href: '/assistant', action: 'Choose' },
    { done: briefOn, title: 'Turn on your morning brief', body: 'A short summary of what changed, written for you each weekday.', href: '/assistant', action: 'Turn on' },
    { done: hasPins, title: 'Pin your surfaces', body: 'Keep the pages you work in one click away.', href: '#customize', action: 'Pin' },
  ];
  const done = steps.filter((step) => step.done).length;
  return (
    <div className="home-setup">
      <div className="home-setup-head">
        <div>
          <h2>Make this page yours</h2>
          <p className="home-muted">{done} of {steps.length} done. Each step makes this page more about your work.</p>
        </div>
        <div className="home-setup-bar" aria-hidden><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      </div>
      <ol className="home-setup-steps">
        {steps.map((step) => (
          <li key={step.title} className={step.done ? 'is-done' : ''}>
            <span className="home-setup-check" aria-hidden>{step.done ? '✓' : ''}</span>
            <div>
              <strong>{step.title}</strong>
              <span className="home-muted">{step.body}</span>
            </div>
            {!step.done && <a href={step.href} className="btn btn-sm">{step.action}</a>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your surfaces
// ---------------------------------------------------------------------------

export function PlacesModule({ places, onUnpin, customizing }: { places: HomePlace[]; onUnpin: (key: string) => void; customizing: boolean }) {
  if (places.length === 0) {
    return <div className="home-empty">Nothing pinned. Use Customize to pin the surfaces you work in.</div>;
  }
  return (
    <div className="hx-places">
      {places.map((place) => (
        <div key={place.key} className="hx-place">
          <Link href={place.href} className="hx-place-link">
            <span className="hx-place-title">
              {place.title}
              <span className="hx-place-arrow" aria-hidden>→</span>
            </span>
            {place.description && <span className="hx-place-desc">{place.description}</span>}
          </Link>
          {customizing && (
            <button type="button" className="home-place-unpin" onClick={() => onUnpin(place.key)} aria-label={`Unpin ${place.title}`} title="Unpin">
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = { ENTITY: 'Record', FEED: 'Feed', KIND: 'Alert' };

export function FollowingModule({ follows, problem }: { follows: HomeFollow[] | null; problem: string | null }) {
  if (problem) return <div className="home-empty">{problem}</div>;
  if (!follows) return <div className="home-empty">Loading what you follow…</div>;
  if (follows.length === 0) {
    return (
      <div className="home-cta">
        <p>Follow records, feeds, or kinds of alerts to see their latest changes here.</p>
        <Link href="/assistant" className="btn btn-sm">Choose what to follow</Link>
      </div>
    );
  }
  return (
    <ul className="home-follows">
      {follows.slice(0, 10).map((follow) => {
        const href = followHref(follow);
        return (
          <li key={follow.id}>
            <span className="home-follow-type">{TYPE_LABEL[follow.subjectType] || follow.subjectType}</span>
            <div className="home-follow-body">
              {href ? <Link href={href}>{follow.label}</Link> : <span className="home-entity">{follow.label}</span>}
              <div className="home-muted home-follow-last">{follow.lastSummary || 'No changes in the last while'}</div>
            </div>
            <time className="home-muted">{relativeTime(follow.lastAt)}</time>
          </li>
        );
      })}
    </ul>
  );
}
