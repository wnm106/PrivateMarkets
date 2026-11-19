import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeProblem, composeTargets, handoffInput, suggestions, targetWorkflowId } from './home-compose';

describe('home composer', () => {
  it('offers the assistant, then workflows that can start from a typed request', () => {
    const targets = composeTargets([
      { id: 'w-2', name: 'Required values check', publishedVersion: 3, runSetup: { requiresRecords: false } },
      { id: 'w-1', name: 'Cash matching', publishedVersion: 1, runSetup: null },
      { id: 'w-3', name: 'Draft only', publishedVersion: null },
      { id: 'w-4', name: 'Needs records', publishedVersion: 2, runSetup: { requiresRecords: true } },
    ]);
    assert.deepEqual(targets.map((target) => target.key), ['assistant', 'workflow:w-1', 'workflow:w-2']);
    assert.equal(targets[1].label, 'Cash matching');
  });

  it('reads the workflow a target names', () => {
    assert.equal(targetWorkflowId('assistant'), null);
    assert.equal(targetWorkflowId('workflow:w-1'), 'w-1');
    assert.equal(targetWorkflowId('workflow:'), null);
  });

  it('checks the text and builds the run input', () => {
    assert.match(composeProblem('   ') || '', /Type/);
    assert.match(composeProblem('x'.repeat(4001)) || '', /4,000/);
    assert.equal(composeProblem('Reconcile October cash'), null);
    assert.deepEqual(handoffInput('  Reconcile October cash  '), { request: 'Reconcile October cash' });
  });

  it('suggests questions from what is waiting, three at most', () => {
    const quiet = suggestions(null);
    assert.equal(quiet.length, 3);
    const busy = suggestions({ reviews: 4, proposedChanges: 19, filesWaiting: 0, failures: 3, urgentExceptions: 2 });
    assert.equal(busy.length, 3);
    assert.match(busy[0], /waiting on my decision/);
    assert.match(busy[1], /failed/);
    assert.match(busy[2], /urgent/);
    const some = suggestions({ reviews: 1, proposedChanges: 1, filesWaiting: 0, failures: 0, urgentExceptions: 0 });
    assert.match(some[0], /waiting on my decision/);
    assert.equal(some.length, 3);
  });
});
