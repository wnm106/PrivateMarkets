import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventView, ReviewView, RunDetail } from './workflows';
import { newestFirst, reviewNextStep, runNextStep, runTabs, summaryLead } from './workflow-run-view';

const SUMMARY = `I checked three issuers and found one missing required value. I've proposed one change, but it needs a value from you before it can run.

- **Sample Obligor 56 (CLOS-ISS-56):** Sector is required and empty.
- **Sample Obligor 41:** all filled in.`;

function item(id: string, needsReview: boolean, required = 0) {
  return {
    id,
    action: 'UPDATE' as const,
    target: { kind: 'Issuer', label: `Issuer ${id}` },
    summary: `Set Sector on Issuer ${id}`,
    tool: 'submit_manual_override',
    args: {},
    confidence: needsReview ? ('LOW' as const) : ('HIGH' as const),
    needsReview,
    rationale: '',
    evidence: [],
    missing: Array.from({ length: required }, (_, index) => ({ key: `k${index}`, label: 'Sector', question: 'What is the sector?', required: true, origin: 'FOUNDATION' as const })),
  };
}

function review(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    id: 'r1',
    runId: 'run1',
    nodeId: 'review',
    workflowName: 'Required values check',
    title: 'Review proposed values',
    instructions: null,
    summary: SUMMARY,
    proposal: { items: [item('c1', true, 1), item('c2', false)] } as never,
    counts: null,
    itemCount: 2,
    status: 'OPEN',
    decision: null,
    decidedAt: null,
    createdAt: '2026-11-20T12:00:00Z',
    canReview: true,
    ...overrides,
  };
}

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 'run1',
    workflowId: 'w1',
    workflowName: 'Required values check',
    version: 1,
    status: 'WAITING',
    currentNode: 'review',
    errorMessage: null,
    openReviews: 1,
    createdAt: '2026-11-20T12:00:00Z',
    startedAt: '2026-11-20T12:00:00Z',
    finishedAt: null,
    input: {},
    canRun: true,
    canReview: true,
    graph: { nodes: [{ id: 'review', type: 'human_review', label: 'Review proposed values', config: {} }], edges: [] } as never,
    steps: [],
    events: [],
    reviews: [review()],
    ...overrides,
  } as RunDetail;
}

const event = (id: string, at: string): EventView => ({ id, nodeId: null, type: 'note', actorType: 'SYSTEM', actorName: null, summary: id, detail: null, createdAt: at });

describe('the run page', () => {
  it('leads the summary with its first paragraph as plain text', () => {
    assert.equal(summaryLead(SUMMARY), "I checked three issuers and found one missing required value. I've proposed one change, but it needs a value from you before it can run.");
    assert.equal(summaryLead('## Findings\n\n- **A:** one\n- B'), 'A: one');
    assert.equal(summaryLead(null), '');
  });

  it('cuts a long lead at a sentence', () => {
    const long = `${'First sentence here. '.repeat(20)}`;
    const lead = summaryLead(long, 100);
    assert.ok(lead.length <= 100);
    assert.ok(lead.endsWith('.'));
  });

  it('tells a reviewer what to decide, and someone who cannot who it is waiting on', () => {
    const mine = reviewNextStep(review());
    assert.equal(mine.tone, 'act');
    assert.equal(mine.headline, 'Decide 2 proposed changes.');
    assert.match(mine.detail || '', /1 needs a close look, 1 question to answer/);

    const theirs = reviewNextStep(review({ canReview: false, blocker: 'You started this run, so someone else has to review it.' }));
    assert.equal(theirs.tone, 'wait');
    assert.equal(theirs.headline, 'Waiting on anyone who can review to review 2 proposed changes.');
    assert.match(theirs.detail || '', /someone else has to review it/);
  });

  it('says what the run is waiting for', () => {
    assert.equal(runNextStep(run()).headline, 'Your review is needed: Review proposed values.');
    assert.equal(runNextStep(run({ reviews: [review({ canReview: false })] })).tone, 'wait');
    assert.equal(runNextStep(run({ status: 'FAILED', reviews: [], errorMessage: 'boom' })).detail, 'boom');
    assert.equal(runNextStep(run({ status: 'SUCCEEDED', reviews: [] })).tone, 'done');
  });

  it('lists history newest first, keeping same-instant entries in reverse order', () => {
    const events = [event('a', '2026-11-20T12:00:00Z'), event('b', '2026-11-20T12:00:05Z'), event('c', '2026-11-20T12:00:05Z')];
    assert.deepEqual(newestFirst(events).map((entry) => entry.id), ['c', 'b', 'a']);
  });

  it('publishes both tabs, and null data before the run loads', () => {
    const loading = runTabs(null);
    assert.deepEqual(Object.keys(loading), ['overview', 'details']);
    assert.equal(loading.overview.data, null);
    assert.equal(loading.details.data, null);

    const tabs = runTabs(run({ events: [event('a', '2026-11-20T12:00:00Z'), event('b', '2026-11-20T12:01:00Z')] }));
    const overview = tabs.overview.data as { nextStep: { headline: string }; openReviews: Array<{ changes: unknown[] }> };
    assert.equal(overview.nextStep.headline, 'Your review is needed: Review proposed values.');
    assert.equal(overview.openReviews[0].changes.length, 2);
    const details = tabs.details.data as { history: Array<{ summary: string }> };
    assert.deepEqual(details.history.map((entry) => entry.summary), ['b', 'a']);
  });
});
