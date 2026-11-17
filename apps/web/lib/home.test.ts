import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultHiddenModules,
  groupNeedsYou,
  headline,
  summarize,
  homeRole,
  needsYouItems,
  pinnedPlaces,
  toggleModule,
  togglePin,
  visibleModules,
  type HomePlace,
} from './home';

const member = { permissions: ['entity.read'], isTenantAdmin: false };
const dataOps = { permissions: ['entity.read', 'feed.manage'], isTenantAdmin: false };
const reviewer = { permissions: ['entity.read', 'workflow.review'], isTenantAdmin: false };
const admin = { permissions: [], isTenantAdmin: true };

describe('home role defaults', () => {
  it('treats data managers and tenant admins as data operations', () => {
    assert.equal(homeRole(dataOps), 'data-ops');
    assert.equal(homeRole(admin), 'data-ops');
    assert.equal(homeRole(reviewer), 'reviewer');
    assert.equal(homeRole(member), 'member');
  });

  it('shows data health only to data operations by default', () => {
    assert.deepEqual(defaultHiddenModules(dataOps), []);
    assert.deepEqual(defaultHiddenModules(member), ['data-health']);
    assert.ok(visibleModules(dataOps, null).includes('data-health'));
    assert.ok(!visibleModules(member, null).includes('data-health'));
  });

  it('lets a saved list replace the role default', () => {
    assert.ok(visibleModules(member, []).includes('data-health'));
    assert.deepEqual(visibleModules(dataOps, ['brief', 'data-health']), ['needs-you', 'following', 'places']);
  });

  it('starts a toggle from the role default and drops unknown codes', () => {
    assert.deepEqual(toggleModule(member, null, 'brief', false), ['brief', 'data-health']);
    assert.deepEqual(toggleModule(member, null, 'data-health', true), []);
    assert.deepEqual(toggleModule(dataOps, ['retired-module'], 'following', false), ['following']);
  });
});

const places: HomePlace[] = [
  { key: 's:deal-pipeline', title: 'Deal Pipeline', description: '', href: '/s/deal-pipeline', pinnedByDefault: true },
  { key: 'page:fund-surface', title: 'Fund surface', description: '', href: '/fund-surface', pinnedByDefault: true },
  { key: 'page:workflows', title: 'Workflows', description: '', href: '/workflows', pinnedByDefault: false },
];

describe('pinned places', () => {
  it('uses the default pins until the person chooses', () => {
    assert.deepEqual(pinnedPlaces(places, null).map((place) => place.key), ['s:deal-pipeline', 'page:fund-surface']);
  });

  it('keeps the saved order and skips places no longer available', () => {
    assert.deepEqual(
      pinnedPlaces(places, ['page:workflows', 's:gone', 's:deal-pipeline']).map((place) => place.key),
      ['page:workflows', 's:deal-pipeline'],
    );
  });

  it('adds new pins last and removes unpinned ones', () => {
    assert.deepEqual(togglePin(places, null, 'page:workflows', true), ['s:deal-pipeline', 'page:fund-surface', 'page:workflows']);
    assert.deepEqual(togglePin(places, null, 's:deal-pipeline', false), ['page:fund-surface']);
    assert.deepEqual(togglePin(places, ['s:gone'], 'page:workflows', true), ['page:workflows']);
  });
});

describe('needs you', () => {
  const now = new Date('2026-11-16T12:00:00Z');

  it('ranks by urgency, then newest first', () => {
    const items = needsYouItems({
      now,
      userId: 'me',
      reviews: [
        { id: 'r1', runId: 'run1', title: 'Approve ratings', workflowName: 'Ratings refresh', itemCount: 3, canReview: true, createdAt: '2026-11-16T10:00:00Z' },
        { id: 'r2', runId: 'run2', title: 'Not mine to review', itemCount: 1, canReview: false, createdAt: '2026-11-16T11:00:00Z' },
      ],
      files: [
        { id: 'f1', fileName: 'positions.csv', feedName: 'Custodian', status: 'NEEDS_REVIEW', lastSeenAt: '2026-11-16T11:30:00Z' },
        { id: 'f2', fileName: 'old.csv', status: 'FAILED', lastSeenAt: '2026-11-01T00:00:00Z' },
        { id: 'f3', fileName: 'loaded.csv', status: 'LOADED', lastSeenAt: '2026-11-16T11:00:00Z' },
      ],
      urgentExceptionCount: 2,
    });
    assert.deepEqual(items.map((item) => item.id), ['dq-urgent', 'review-r1', 'file-f1']);
    assert.equal(items[1].detail, 'Ratings refresh · 3 proposed changes');
    assert.equal(items[1].href, '/workflows/runs/run1');
    assert.equal(items[0].title, '2 high-priority exceptions open');
    assert.equal(items[0].aggregate, true);
  });

  it('puts an overdue review first, with when it was due', () => {
    const items = needsYouItems({
      now,
      userId: 'me',
      reviews: [
        { id: 'r1', runId: 'run1', title: 'On time', itemCount: 1, canReview: true, createdAt: '2026-11-16T11:00:00Z', dueAt: '2026-11-17T09:00:00Z', overdue: false },
        { id: 'r2', runId: 'run2', title: 'Late', itemCount: 2, canReview: true, createdAt: '2026-11-15T09:00:00Z', dueAt: '2026-11-16T09:00:00Z', overdue: true },
      ],
    });
    assert.deepEqual(items.map((item) => item.id), ['review-r2', 'review-r1']);
    assert.equal(items[0].urgency, 'critical');
    assert.equal(items[0].detail, '2 proposed changes · was due 2026-11-16 09:00 UTC');
    assert.equal(items[1].detail, '1 proposed change · due 2026-11-17 09:00 UTC');
  });

  it('shows only failed workflow runs the person started', () => {
    const items = needsYouItems({
      now,
      userId: 'me',
      workflowRuns: [
        { id: 'w1', workflowName: 'Mine', status: 'FAILED', startedBy: 'me', finishedAt: '2026-11-15T12:00:00Z', createdAt: '2026-11-15T11:00:00Z' },
        { id: 'w2', workflowName: 'Theirs', status: 'FAILED', startedBy: 'someone', finishedAt: '2026-11-15T12:00:00Z', createdAt: '2026-11-15T11:00:00Z' },
        { id: 'w3', workflowName: 'Done', status: 'SUCCEEDED', startedBy: 'me', createdAt: '2026-11-15T11:00:00Z' },
      ],
    });
    assert.deepEqual(items.map((item) => item.id), ['run-w1']);
  });

  it('marks critical exceptions on followed records as critical', () => {
    const items = needsYouItems({
      now,
      userId: null,
      jobs: [{ id: 'j1', jobTypeLabel: 'Data quality scan', status: 'FAILED', finishedAt: '2026-11-16T09:00:00Z', createdAt: '2026-11-16T09:00:00Z' }],
      followedExceptions: [
        { id: 'e1', entityId: 'x', entityName: 'Acme Fund', entityHref: '/funds/x', exceptionMessage: 'NAV missing', severity: 'CRITICAL', detectedAt: '2026-11-15T00:00:00Z' },
      ],
    });
    assert.deepEqual(items.map((item) => [item.id, item.urgency]), [['dq-e1', 'critical'], ['job-j1', 'normal']]);
  });
});

describe('grouped needs you and the headline', () => {
  const now = new Date('2026-11-16T15:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
  const items = needsYouItems({
    now,
    userId: 'me',
    reviews: [3, 17, 44, 48].map((minutes, index) => ({
      id: `r${index}`,
      runId: `run${index}`,
      title: 'Review proposed values (test run)',
      workflowName: 'Test: issuer required values',
      itemCount: index === 3 ? 4 : 5,
      canReview: true,
      createdAt: at(minutes),
    })),
    workflowRuns: [{ id: 'w1', workflowName: 'Test: issuer required values', status: 'FAILED', errorMessage: 'The Anthropic key was rejected.', startedBy: 'me', finishedAt: at(300), createdAt: at(301) }],
    jobs: [
      { id: 'j1', jobTypeLabel: 'Check a connection', status: 'FAILED', errorMessage: '127.0.0.1 is not a public address.', finishedAt: at(1440), createdAt: at(1440) },
      { id: 'j2', jobTypeLabel: 'Poll a feed', status: 'FAILED', errorMessage: 'Test issuer feed: 1 waiting for review', finishedAt: at(1450), createdAt: at(1450) },
      { id: 'j3', jobTypeLabel: 'Poll a feed', status: 'FAILED', errorMessage: 'Test statement feed: 1 waiting for review', finishedAt: at(1460), createdAt: at(1460) },
    ],
  });

  it('collapses reviews from one workflow and sends the button to the oldest', () => {
    const groups = groupNeedsYou(items);
    const reviews = groups.find((group) => group.kind === 'review')!;
    assert.equal(reviews.count, 4);
    assert.equal(reviews.changes, 19);
    assert.equal(reviews.title, 'Test: issuer required values');
    assert.equal(reviews.href, '/workflows/runs/run3');
    assert.equal(reviews.action, 'Start with oldest');
  });

  it('collapses repeated job failures and keeps one-off rows as they are', () => {
    const groups = groupNeedsYou(items);
    const polls = groups.find((group) => group.key === 'job:Poll a feed')!;
    assert.equal(polls.count, 2);
    assert.equal(polls.title, 'Poll a feed failed');
    assert.equal(groups.length, 4);
    assert.deepEqual(groups.map((group) => group.lane), ['decide', 'fix', 'fix', 'fix']);
  });

  it('says what is waiting in one sentence', () => {
    const summary = summarize(items);
    assert.deepEqual(summary, { reviews: 4, proposedChanges: 19, filesWaiting: 0, failures: 4, urgentExceptions: 0 });
    assert.equal(headline(summary), '4 reviews (19 proposed changes) are waiting for your decision. 4 failed runs need attention.');
    assert.equal(headline({ reviews: 1, proposedChanges: 0, filesWaiting: 0, failures: 1, urgentExceptions: 0 }), '1 review is waiting for your decision. 1 failed run needs attention.');
    assert.equal(headline({ reviews: 0, proposedChanges: 0, filesWaiting: 0, failures: 0, urgentExceptions: 0 }), 'You’re all caught up. Nothing is waiting on you.');
  });
});
