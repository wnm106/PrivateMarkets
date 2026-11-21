import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkflowGraph } from '@tapestrai/graphql/src/lib/workflow-graph';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { checkRecords, checklistSummary, pathSteps, progressText, runChecklist, type CheckRecord, type StepMark } from './workflow-checklist';

const template = (code: string) => WORKFLOW_TEMPLATES.find((entry) => entry.code === code)!.graph;
const INTAKE = template('FILE_INTAKE');
const CLEANUP = template('DATA_CLEANUP');
const REC = template('FUND_RECONCILIATION');
const BRIEF = template('DATA_QUALITY_BRIEF');

const done = (...ids: Array<string | [string, string]>): StepMark[] =>
  ids.map((id) => (Array.isArray(id) ? { nodeId: id[0], status: 'SUCCEEDED', outcome: id[1] } : { nodeId: id, status: 'SUCCEEDED', outcome: null }));

const stage = (nodeId: string, status = 'OPEN', canAct = true, extra: Partial<CheckRecord> = {}): CheckRecord => ({ id: `s-${nodeId}`, nodeId, kind: 'stage', status, canAct, ...extra });

const view = (list: ReturnType<typeof runChecklist>) => list.items.map((item) => `${item.number ?? '-'} ${item.label}:${item.state}`);

/** A fork whose two arms each hold a decision, and a form both arms reach. */
const FORK: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    { id: 'pick', type: 'stage', label: 'Choose a route', config: { screen: 'load.quality' } },
    { id: 'a', type: 'review', label: 'Review route A', config: {} },
    { id: 'b', type: 'review', label: 'Review route B', config: {} },
    { id: 'sign', type: 'form', label: 'Sign off', config: {} },
    { id: 'end', type: 'end', label: 'End', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'pick' },
    { id: 'e2', from: 'pick', to: 'a', when: 'approved' },
    { id: 'e3', from: 'pick', to: 'b', when: 'discarded' },
    { id: 'e4', from: 'a', to: 'sign' },
    { id: 'e5', from: 'b', to: 'sign' },
    { id: 'e6', from: 'sign', to: 'end' },
  ],
} as WorkflowGraph;

describe('a run as a checklist', () => {
  it('numbers each decision in the order the run reaches it, and leaves out the system steps', () => {
    const list = runChecklist({ graph: INTAKE, status: 'QUEUED', currentNode: null, steps: [], records: [] });
    assert.deepEqual(view(list), ['1 Understand the file:ahead', '2 Map the file:ahead', '3 Check the values:ahead']);
    assert.equal(list.total, 3);
    assert.equal(list.possible, 0);
    assert.equal(checklistSummary(list), '0 of 3 decisions done');
    assert.equal(list.items[1].detail, 'Map a file');
  });

  it('ticks off what is decided and points at the one that is yours', () => {
    const list = runChecklist({
      graph: INTAKE,
      status: 'WAITING',
      currentNode: 'map',
      steps: [...done('start', 'receive', ['understand', 'confirmed']), { nodeId: 'map', status: 'WAITING', outcome: null }],
      records: [stage('understand', 'COMPLETED', false, { outcome: 'confirmed', by: 'Ada' }), stage('map')],
    });
    assert.deepEqual(view(list), ['1 Understand the file:done', '2 Map the file:current', '3 Check the values:ahead']);
    assert.equal(list.items[0].note, 'Confirmed by Ada');
    assert.equal(list.current?.number, 2);
    assert.equal(checklistSummary(list), '1 of 3 decisions done');
  });

  it('says whose move it is when it is not yours', () => {
    const list = runChecklist({
      graph: INTAKE,
      status: 'WAITING',
      currentNode: 'understand',
      steps: [...done('start', 'receive'), { nodeId: 'understand', status: 'WAITING', outcome: null }],
      records: [stage('understand', 'OPEN', false, { assignees: [{ name: 'Operations lead' }], blocker: 'This is assigned to Operations lead.' })],
    });
    assert.equal(list.items[0].state, 'waiting');
    assert.equal(list.items[0].note, 'Waiting on Operations lead. This is assigned to Operations lead.');
    assert.equal(list.current, null);
  });

  it('ends where the person stops the run', () => {
    const list = runChecklist({ graph: INTAKE, status: 'SUCCEEDED', currentNode: null, steps: done('start', 'receive', ['understand', 'abandoned'], 'end'), records: [] });
    assert.deepEqual(view(list), ['1 Understand the file:done']);
    assert.equal(list.items[0].note, 'Stopped here');
  });

  it('counts a review that will open whatever the scan finds, and drops it when there is nothing to fix', () => {
    assert.deepEqual(view(runChecklist({ graph: CLEANUP, status: 'QUEUED', currentNode: null, steps: [], records: [] })), ['1 Review proposed fixes:ahead']);
    const clean = runChecklist({ graph: CLEANUP, status: 'SUCCEEDED', currentNode: null, steps: done('start', 'select', 'scan', ['any', 'false'], 'end'), records: [] });
    assert.equal(clean.total, 0);
    assert.equal(checklistSummary(clean), 'This run needs no decisions.');
  });

  it('marks a review the run passed because nothing was proposed', () => {
    const list = runChecklist({
      graph: CLEANUP,
      status: 'RUNNING',
      currentNode: 'apply',
      steps: [...done('start', 'select', 'scan', ['any', 'true'], 'investigate'), { nodeId: 'review', status: 'SUCCEEDED', outcome: 'approved', output: { skipped: true } }],
      records: [],
    });
    assert.equal(list.items[0].state, 'skipped');
    assert.equal(list.done, 1);
    assert.equal(list.working, CLEANUP.nodes.find((node) => node.id === 'apply')!.label);
  });

  it('counts both reviews of a reconciliation', () => {
    const list = runChecklist({ graph: REC, status: 'QUEUED', currentNode: null, steps: [], records: [] });
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((item) => item.nodeId), ['reviewLoad', 'reviewRec']);
  });

  it('has nothing on it for a workflow that only reports', () => {
    const list = runChecklist({ graph: BRIEF, status: 'QUEUED', currentNode: null, steps: [], records: [] });
    assert.equal(list.items.length, 0);
    assert.equal(checklistSummary(list), 'This run needs no decisions.');
  });

  it('keeps the decisions on only some choices apart until the choice is made', () => {
    const before = runChecklist({ graph: FORK, status: 'WAITING', currentNode: 'pick', steps: [...done('start'), { nodeId: 'pick', status: 'WAITING', outcome: null }], records: [stage('pick')] });
    assert.deepEqual(view(before), ['1 Choose a route:current', '- Review route A:ahead', '- Review route B:ahead', '2 Sign off:ahead']);
    assert.equal(before.total, 2);
    assert.equal(before.possible, 2);
    assert.equal(checklistSummary(before), '0 of 2 decisions done, up to 2 more depending on your choices');

    const after = runChecklist({ graph: FORK, status: 'WAITING', currentNode: 'b', steps: done('start', ['pick', 'discarded']), records: [stage('pick', 'COMPLETED', false, { outcome: 'discarded' })] });
    assert.deepEqual(view(after), ['1 Choose a route:done', '2 Review route B:ahead', '3 Sign off:ahead']);
    assert.equal(after.possible, 0);
  });

  it('does not show both ways out of an undecided step as the road ahead', () => {
    const steps = pathSteps(INTAKE, [...done('start', 'receive', ['understand', 'confirmed'], ['map', 'confirmed'], 'stage', ['staged', 'true']), { nodeId: 'quality', status: 'WAITING', outcome: null }]);
    const sure = steps.filter((step) => step.certain).map((step) => step.node.id);
    assert.equal(sure.includes('promote'), false);
    assert.equal(sure.includes('discard'), false);
    assert.equal(sure.includes('quality'), true);
  });

  it('carries what the open screen reports', () => {
    const list = runChecklist({
      graph: INTAKE,
      status: 'WAITING',
      currentNode: 'understand',
      steps: [...done('start', 'receive'), { nodeId: 'understand', status: 'WAITING', outcome: null }],
      records: [stage('understand')],
      progress: { 's-understand': { parts: [{ label: 'File it as', done: true }, { label: 'Link the record', done: false }] } },
    });
    assert.equal(progressText(list.current?.progress), '1 of 2 done');
    assert.equal(progressText({ done: 2, total: 5 }), '2 of 5 decided');
    assert.equal(progressText(undefined), null);
  });

  it('reads reviews, forms and stages the same way', () => {
    const records = checkRecords({
      reviews: [{ id: 'r1', nodeId: 'review', status: 'APPROVED', title: 'Review', canReview: true, decidedByName: 'Ada', proposal: { items: [1, 2, 3] } }],
      forms: [{ id: 'f1', nodeId: 'ask', status: 'OPEN', title: 'Ask', canAnswer: true, fields: [{}, {}] }],
      stages: [{ id: 's1', nodeId: 'map', status: 'OPEN', title: 'Map', canAct: false }],
    });
    assert.deepEqual(records.map((entry) => [entry.kind, entry.canAct, entry.outcome ?? null, entry.size ?? null]), [['review', false, 'approved', 3], ['form', true, null, 2], ['stage', false, null, null]]);
  });
});
