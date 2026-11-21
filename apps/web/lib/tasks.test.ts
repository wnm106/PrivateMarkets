import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countLabel, newTasks, placeText, taskHref, titleWithCount, whenText, type WorkflowTask } from './tasks';

const NOW = Date.parse('2026-11-21T12:00:00Z');

function task(id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, kind: 'review', runId: 'run1', nodeId: 'reviewRec', title: 'Review', workflowName: null, about: null, detail: '', createdAt: '2026-11-21T10:00:00Z', dueAt: null, overdue: false, canAct: true, blocker: null, waitingOn: null, place: null, placeOf: null, approveAll: null, approvalsLeft: 0, ...overrides };
}

describe('tasks in the app’s frame', () => {
  it('put the count in front of the page title, once', () => {
    assert.equal(titleWithCount('Fund reconciliation', 3), '(3) Fund reconciliation');
    assert.equal(titleWithCount('(3) Fund reconciliation', 4), '(4) Fund reconciliation');
    assert.equal(titleWithCount('(4) Fund reconciliation', 0), 'Fund reconciliation');
    assert.equal(titleWithCount('Home', 140), '(99+) Home');
    assert.equal(titleWithCount('(99+) Home', 2), '(2) Home');
  });

  it('say the count to someone who cannot see the badge', () => {
    assert.equal(countLabel(null), 'Tasks: nothing waiting for you');
    assert.equal(countLabel({ total: 3, overdue: 1 }), 'Tasks: 3 waiting for you, 1 overdue');
  });

  it('tell which tasks are new since the last read', () => {
    assert.deepEqual(newTasks(new Set(['a']), [task('a'), task('b')]).map((entry) => entry.id), ['b']);
  });

  it('open a task on its decision, and name its place when the run has more than one', () => {
    assert.equal(taskHref({ runId: 'r9', nodeId: 'review rec' }), '/workflows/runs/r9?decision=review%20rec');
    assert.equal(placeText({ place: 2, placeOf: 4 }), 'Decision 2 of 4');
    assert.equal(placeText({ place: 1, placeOf: 1 }), null);
    assert.equal(placeText({ place: null, placeOf: null }), null);
  });

  it('say when a task is due, or how long it has waited', () => {
    assert.equal(whenText({ dueAt: '2026-11-21T15:00:00Z', createdAt: '' }, NOW), 'due in 3 hours');
    assert.equal(whenText({ dueAt: '2026-11-21T10:00:00Z', createdAt: '' }, NOW), '2 hours overdue');
    assert.equal(whenText({ dueAt: null, createdAt: '2026-11-19T12:00:00Z' }, NOW), 'waiting 2 days');
  });
});
