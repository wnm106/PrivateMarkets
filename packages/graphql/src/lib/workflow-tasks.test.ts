import { describe, expect, it } from 'vitest';
import type { Proposal } from './workflow-proposal';
import { formTask, reviewTask, stageTask, taskList, type ReviewRow } from './workflow-tasks';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hours = (count: number) => new Date(NOW + count * 3_600_000).toISOString();

function proposal(...items: Array<{ id: string; label: string; needsReview?: boolean }>): Proposal {
  return {
    items: items.map((item) => ({ id: item.id, action: 'UPDATE', target: { kind: 'Fund', label: item.label }, summary: item.id, tool: 'submit_manual_override', args: {}, confidence: 'HIGH', needsReview: item.needsReview === true, rationale: '', evidence: [], missing: [] })),
  };
}

function review(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return { id: 'r1', runId: 'run1', nodeId: 'review', title: 'Review the reconciliation', workflowName: 'Fund reconciliation', proposal: proposal({ id: 'a', label: 'Harbor' }), itemCount: 1, canReview: true, blocker: null, assignees: [], createdAt: hours(-5), dueAt: null, ...overrides };
}

describe('a person’s tasks', () => {
  it('reads a review as one task, however many changes it holds, and says what it is about', () => {
    const task = reviewTask(review({ proposal: proposal({ id: 'a', label: 'Harbor' }, { id: 'b', label: 'Brightwater' }, { id: 'c', label: 'CLO I', needsReview: true }) }), NOW);
    expect(task).toMatchObject({ kind: 'review', detail: '3 proposed changes', about: 'Harbor and 2 more', canAct: true, approveAll: null });
  });

  it('offers to approve in place only a review whose every change is ready', () => {
    const ready = reviewTask(review({ proposal: proposal({ id: 'a', label: 'Harbor' }, { id: 'b', label: 'Harbor' }) }), NOW);
    expect(ready.approveAll).toEqual({ items: { a: { decision: 'APPROVE' }, b: { decision: 'APPROVE' } } });
    expect(ready.about).toBe('Harbor');
    expect(reviewTask(review({ canReview: false }), NOW).approveAll).toBeNull();
    expect(reviewTask(review({ approvalsRequired: 3, approvals: [{ id: 'x' }] }), NOW).approvalsLeft).toBe(1);
  });

  it('reads forms and screens the same way, with who they wait on', () => {
    const form = formTask({ id: 'f1', runId: 'run2', nodeId: 'ask', title: 'Confirm the period', workflowName: 'Intake', fields: [{ required: true }, {}, {}], externalEmail: null, canAnswer: false, blocker: 'This form is for Operations lead.', assignees: [{ name: 'Operations lead' }], createdAt: hours(-1), dueAt: hours(-0.5) }, NOW);
    expect(form).toMatchObject({ kind: 'form', detail: '3 questions, 1 required', canAct: false, waitingOn: 'Operations lead', overdue: true });
    const stage = stageTask({ id: 's1', runId: 'run3', nodeId: 'map', title: 'Map the file', workflowName: 'File intake', screen: 'load.map', returnedReason: 'Choose the date these values are as of.', canAct: true, blocker: null, assignees: [], createdAt: hours(-2), dueAt: null }, NOW);
    expect(stage).toMatchObject({ kind: 'stage', detail: 'Map a file: came back to you', canAct: true, waitingOn: null });
  });

  it('counts what is yours, overdue first, then the soonest due, then the longest waiting', () => {
    const list = taskList(
      [
        reviewTask(review({ id: 'later', dueAt: hours(30), createdAt: hours(-1) }), NOW),
        reviewTask(review({ id: 'old', createdAt: hours(-48) }), NOW),
        reviewTask(review({ id: 'late', dueAt: hours(-2) }), NOW),
        reviewTask(review({ id: 'soon', dueAt: hours(3) }), NOW),
        reviewTask(review({ id: 'theirs', canReview: false }), NOW),
      ],
      NOW,
    );
    expect(list.tasks.map((task) => task.id)).toEqual(['late', 'soon', 'later', 'old']);
    expect(list).toMatchObject({ total: 4, overdue: 1, dueSoon: 1, waitingOnOthers: 1 });
    expect(list.waiting.map((task) => task.id)).toEqual(['theirs']);
  });
});
