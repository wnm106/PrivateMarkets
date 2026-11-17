'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { markdownToHtml } from '@/lib/markdown';
import {
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

  const [reviews, files, jobs, runs, followed, urgent] = await Promise.all([
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
  ]);

  return {
    reviews: reviews.data?.workflowReviews,
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
}

/** Waits for the follows (they decide which exceptions count), then loads everything once. */
export function useNeedsYou(userId: string | null, follows: HomeFollow[] | null, clientWide: boolean): NeedsYouState | null {
  const [state, setState] = useState<NeedsYouState | null>(null);
  useEffect(() => {
    if (follows === null) return;
    let cancelled = false;
    loadSources(follows, clientWide).then((sources) => {
      if (cancelled) return;
      setState({ items: needsYouItems({ now: new Date(), userId, ...sources }), urgentExceptionCount: sources.urgentExceptionCount });
    });
    return () => {
      cancelled = true;
    };
  }, [follows, userId, clientWide]);
  return state;
}

// ---------------------------------------------------------------------------
// Focus tiles: the counts at the top of the page
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
      value: summary?.reviews ?? 0,
      sub: summary?.proposedChanges ? `${summary.proposedChanges} proposed changes` : 'Workflow proposals',
      href: '#home-decide',
      tone: 'decide',
    },
    { key: 'files', label: 'Files waiting', value: summary?.filesWaiting ?? 0, sub: 'Need a mapping or a check', href: '#home-decide', tone: 'decide' },
    { key: 'failures', label: 'Failed', value: summary?.failures ?? 0, sub: 'Runs, jobs, and files', href: '#home-fix', tone: 'fix' },
  ];
  if (showExceptions) {
    tiles.push({ key: 'exceptions', label: 'Urgent exceptions', value: summary?.urgentExceptions ?? 0, sub: 'High and critical, open', href: '/quality', tone: 'critical' });
  }
  return (
    <div className="home-focus" style={{ '--tiles': tiles.length } as React.CSSProperties}>
      {tiles.map((tile) => {
        const active = (summary ? tile.value : 0) > 0;
        return (
          <a key={tile.key} href={tile.href} className={`home-focus-tile tone-${tile.tone}${active ? ' is-active' : ''}`}>
            <span className="home-focus-label">{tile.label}</span>
            <span className="home-focus-value">{summary ? tile.value : '—'}</span>
            <span className="home-focus-sub">{active ? tile.sub : summary ? 'All clear' : ' '}</span>
          </a>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs you: two lanes of grouped rows
// ---------------------------------------------------------------------------

const LANES: Array<{ lane: NeedsYouLane; title: string; hint: string; empty: string }> = [
  { lane: 'decide', title: 'Decide', hint: 'Proposals and files waiting on your call', empty: 'No decisions waiting.' },
  { lane: 'fix', title: 'Fix', hint: 'Things that broke and need a hand', empty: 'Nothing is broken.' },
];

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

function GroupRow({ group }: { group: NeedsYouGroup }) {
  const [open, setOpen] = useState(false);
  const latest = group.items[0];
  const detail = group.kind === 'review' ? latest.title : latest.detail;
  return (
    <li className={`home-group urgency-${group.urgency}`}>
      <div className="home-group-main">
        <div className="home-group-text">
          <div className="home-group-title">{group.title}</div>
          <div className="home-group-meta">{groupMeta(group)}</div>
          {detail && <div className="home-group-detail" title={detail}>{detail}</div>}
        </div>
        <Link href={group.href} className={`btn btn-sm${group.lane === 'decide' ? ' btn-primary' : ''}`}>{group.action}</Link>
      </div>
      {group.count > 1 && (
        <>
          <button type="button" className="home-link-button home-group-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide' : `Show all ${group.count}`}
          </button>
          {open && (
            <ul className="home-group-items">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link href={item.href}>{item.kind === 'review' ? item.detail : item.detail || item.title}</Link>
                  <time className="home-muted">{relativeTime(item.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

const LANE_LIMIT = 4;

function Lane({ lane, title, hint, empty, groups }: { lane: NeedsYouLane; title: string; hint: string; empty: string; groups: NeedsYouGroup[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? groups : groups.slice(0, LANE_LIMIT);
  return (
    <div className={`home-lane lane-${lane}`} id={`home-${lane}`}>
      <div className="home-lane-head">
        <h3>
          {title}
          {groups.length > 0 && <span className="home-lane-count">{groups.reduce((sum, group) => sum + group.count, 0)}</span>}
        </h3>
        <span className="home-muted">{hint}</span>
      </div>
      {groups.length === 0 ? (
        <div className="home-lane-empty">
          <span className="home-clear-mark" aria-hidden>✓</span>
          {empty}
        </div>
      ) : (
        <ul className="home-groups">
          {shown.map((group) => <GroupRow key={group.key} group={group} />)}
        </ul>
      )}
      {groups.length > LANE_LIMIT && (
        <button type="button" className="home-link-button" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show ${groups.length - LANE_LIMIT} more`}
        </button>
      )}
    </div>
  );
}

export function NeedsYouBoard({ items }: { items: NeedsYouItem[] | null }) {
  const groups = useMemo(() => (items ? groupNeedsYou(items) : []), [items]);
  if (!items) return <div className="home-empty">Checking what is waiting on you…</div>;
  return (
    <div className="home-lanes">
      {LANES.map((lane) => (
        <Lane key={lane.lane} {...lane} groups={groups.filter((group) => group.lane === lane.lane)} />
      ))}
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
    <div className="home-places">
      {places.map((place) => (
        <div key={place.key} className="home-place">
          <Link href={place.href} className="home-place-link">
            <span className="home-place-mark" aria-hidden>{place.title.charAt(0)}</span>
            <span className="home-place-text">
              <span className="home-place-title">{place.title}</span>
              {place.description && <span className="home-place-desc">{place.description}</span>}
            </span>
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
