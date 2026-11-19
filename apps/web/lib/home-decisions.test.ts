import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvedNote, cardOrder, decisionCard, primaryAction, trustLine, type DecisionReview } from './home-decisions';

function change(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    action: 'UPDATE',
    target: { kind: 'Loan', label: id },
    summary: `Change ${id}`,
    tool: 'submit_manual_override',
    args: { entityId: id },
    confidence: 'HIGH',
    needsReview: false,
    rationale: 'r',
    evidence: ['Amendment No. 3, page 4'],
    missing: [],
    ...patch,
  };
}

function review(items: unknown[], patch: Partial<DecisionReview> = {}): DecisionReview {
  return {
    id: 'rev-1',
    runId: 'run-1',
    title: 'Calder Health spread',
    workflowName: 'Source conflicts',
    summary: ' The amendment is newer. ',
    proposal: { items },
    agentName: 'Reader',
    canReview: true,
    createdAt: '2026-11-18T10:00:00Z',
    ...patch,
  };
}

describe('home decisions', () => {
  it('approves in place when every change is ready', () => {
    const card = decisionCard(review([change('a'), change('b')]));
    assert.equal(card.from, 'Reader');
    assert.equal(card.summary, 'The amendment is newer.');
    assert.equal(card.ready, 2);
    assert.equal(card.needsYou, 0);
    assert.equal(card.confidence, 'HIGH');
    assert.deepEqual(card.approveAll, { items: { a: { decision: 'APPROVE' }, b: { decision: 'APPROVE' } } });
    assert.deepEqual(primaryAction(card), { kind: 'approve', label: 'Approve all 2' });
    assert.equal(trustLine(card), 'High confidence · 2 cited facts');
    assert.equal(approvedNote(card), 'Approved. 2 changes are being made now.');
    assert.equal(card.href, '/workflows/runs/run-1');
  });

  it('opens the review when a change is flagged or waits on an answer', () => {
    const flagged = decisionCard(review([change('a'), change('b', { needsReview: true, confidence: 'LOW' })]));
    assert.equal(flagged.approveAll, null);
    assert.equal(flagged.confidence, 'LOW');
    assert.deepEqual(primaryAction(flagged), { kind: 'open', label: 'Review 1, confirm 1' });
    assert.match(trustLine(flagged), /1 of 2 need a closer look/);

    const question = decisionCard(
      review([change('a', { missing: [{ key: 'value', label: 'Maturity', question: 'When?', required: true, origin: 'AGENT' }] })]),
    );
    assert.equal(question.approveAll, null);
    assert.deepEqual(primaryAction(question), { kind: 'open', label: 'Review' });
  });

  it('never approves in place for someone who cannot decide it, or with nothing proposed', () => {
    assert.equal(decisionCard(review([change('a')], { canReview: false })).approveAll, null);
    const empty = decisionCard(review([]));
    assert.equal(empty.approveAll, null);
    assert.equal(empty.confidence, null);
  });

  it('says when more approvals are needed, and names the workflow when no agent is', () => {
    const card = decisionCard(review([change('a')], { agentName: null, approvalsRequired: 3, approvals: [{ id: 'u', name: 'Ana', at: '' }] }));
    assert.equal(card.from, 'Source conflicts');
    assert.equal(card.approvalsLeft, 1);
    assert.equal(approvedNote(card), 'Your approval is recorded. 1 more approval needed before anything changes.');
    assert.deepEqual(primaryAction(card), { kind: 'approve', label: 'Approve' });
  });

  it('lists the first three changes and counts the rest', () => {
    const card = decisionCard(review([change('a'), change('b'), change('c'), change('d'), change('e')]));
    assert.deepEqual(card.lines, ['Change a', 'Change b', 'Change c']);
    assert.equal(card.more, 2);
  });

  it('orders cards: overdue, then due soonest, then oldest', () => {
    const rows = [
      { id: 'new', canReview: true, createdAt: '2026-11-18T10:00:00Z' },
      { id: 'old', canReview: true, createdAt: '2026-11-16T10:00:00Z' },
      { id: 'due', canReview: true, createdAt: '2026-11-18T11:00:00Z', dueAt: '2026-11-19T00:00:00Z' },
      { id: 'late', canReview: true, createdAt: '2026-11-18T12:00:00Z', dueAt: '2026-11-17T00:00:00Z', overdue: true },
      { id: 'theirs', canReview: false, createdAt: '2026-11-15T10:00:00Z' },
    ];
    assert.deepEqual(cardOrder(rows, 3).map((row) => row.id), ['late', 'due', 'old']);
  });
});
