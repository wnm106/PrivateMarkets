import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor, approvalCounts, approvalsStory, decisionText, recordName, requestsForView, type OverrideRequest } from './override-approvals';

function request(overrides: Partial<OverrideRequest> = {}): OverrideRequest {
  return {
    id: 'r1',
    status: 'PENDING',
    clientId: 'c1',
    entityId: 'e1',
    entityName: 'Alpha Fund One',
    entityCode: 'A-FUND-1',
    domainCode: 'FUND',
    attributeCode: 'NAV',
    attributeName: 'NAV',
    dataType: 'CURRENCY',
    validFrom: '2026-09-30',
    value: '250',
    reason: 'Administrator restated NAV',
    requestedBy: 'u1',
    requestedByName: 'Sam Steward',
    requestedAt: '2026-11-26T10:00:00Z',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    appliedValueId: null,
    mine: false,
    blocker: null,
    canDecide: true,
    ...overrides,
  };
}

test('the person who entered a value can withdraw it but not approve it', () => {
  assert.deepEqual(actionsFor(request({ mine: true, canDecide: false })), { decide: false, withdraw: true });
  assert.deepEqual(actionsFor(request()), { decide: true, withdraw: false });
  assert.deepEqual(actionsFor(request({ status: 'APPROVED' })), { decide: false, withdraw: false });
});

test('decisions read as a sentence', () => {
  assert.equal(decisionText(request()), 'Waiting for approval');
  assert.equal(decisionText(request({ status: 'APPROVED', decidedByName: 'Ada Admin' })), 'Approved by Ada Admin');
  assert.equal(decisionText(request({ status: 'REJECTED', decidedByName: 'Ada Admin', decisionNote: 'Wrong period' })), 'Rejected by Ada Admin: Wrong period');
  assert.equal(decisionText(request({ status: 'WITHDRAWN' })), 'Withdrawn by Sam Steward');
});

test('the record is named by its name, then its code', () => {
  assert.equal(recordName(request()), 'Alpha Fund One');
  assert.equal(recordName(request({ entityName: null })), 'A-FUND-1');
});

test('the decided view leaves out waiting requests', () => {
  const rows = [request(), request({ id: 'r2', status: 'APPROVED' })];
  assert.deepEqual(requestsForView('decided', rows).map((row) => row.id), ['r2']);
  assert.equal(requestsForView('all', rows).length, 2);
});

test('counts and the assistant story agree with the rows', () => {
  const rows = [request(), request({ id: 'r2', mine: true, canDecide: false, blocker: 'You entered this value, so someone else has to approve it.' }), request({ id: 'r3', status: 'REJECTED' })];
  assert.deepEqual(approvalCounts(rows), { waiting: 2, forMe: 1, mine: 1 });
  const story = approvalsStory(rows, 2);
  assert.equal(story.requests.length, 2);
  assert.equal(story.requests[1].whyNot, 'You entered this value, so someone else has to approve it.');
  assert.equal(story.requests[0].youCanApprove, true);
});
