import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { guidedSteps, isGuided } from './workflow-stages';

const INTAKE = WORKFLOW_TEMPLATES.find((template) => template.code === 'FILE_INTAKE')!.graph;
const CLEANUP = WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph;

const labels = (steps: ReturnType<typeof guidedSteps>) => steps.map((step) => `${step.label}:${step.state}`);

describe('guided runs', () => {
  it('are the workflows with a stage in them', () => {
    assert.equal(isGuided(INTAKE), true);
    assert.equal(isGuided(CLEANUP), false);
    assert.equal(isGuided(null), false);
  });

  it('show the steps a person would recognise, in order, and leave out the routing', () => {
    const steps = guidedSteps(INTAKE, [], 'QUEUED', null);
    assert.deepEqual(steps.map((step) => step.label), ['Index for search', 'Understand the file', 'Map the file', 'Stage the values', 'Check the values', 'Promote to live records', 'Discard the batch']);
    assert.deepEqual(steps.filter((step) => step.human).map((step) => step.label), ['Understand the file', 'Map the file', 'Check the values']);
    assert.equal(steps.every((step) => step.state === 'waiting'), true);
  });

  it('mark the stage that is waiting on a person', () => {
    const steps = guidedSteps(INTAKE, [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'WAITING', outcome: null }], 'WAITING', 'understand');
    assert.deepEqual(labels(steps).slice(0, 3), ['Index for search:done', 'Understand the file:current', 'Map the file:waiting']);
    assert.equal(steps[1].note, 'waiting for a person');
  });

  it('drop the path a decision did not take', () => {
    const steps = guidedSteps(
      INTAKE,
      [
        { nodeId: 'start', status: 'SUCCEEDED', outcome: null },
        { nodeId: 'receive', status: 'SUCCEEDED', outcome: null },
        { nodeId: 'understand', status: 'SUCCEEDED', outcome: 'confirmed' },
        { nodeId: 'map', status: 'SUCCEEDED', outcome: 'confirmed' },
        { nodeId: 'stage', status: 'SUCCEEDED', outcome: null },
        { nodeId: 'staged', status: 'SUCCEEDED', outcome: 'true' },
        { nodeId: 'quality', status: 'SUCCEEDED', outcome: 'approved' },
        { nodeId: 'promote', status: 'RUNNING', outcome: null },
      ],
      'RUNNING',
      'promote',
    );
    assert.deepEqual(labels(steps), ['Index for search:done', 'Understand the file:done', 'Map the file:done', 'Stage the values:done', 'Check the values:done', 'Promote to live records:current']);
    assert.equal(steps[5].note, 'working');
  });

  it('end where the person stops the run', () => {
    const steps = guidedSteps(INTAKE, [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'SUCCEEDED', outcome: 'abandoned' }], 'SUCCEEDED', null);
    assert.deepEqual(labels(steps), ['Index for search:done', 'Understand the file:done']);
  });

  it('mark the step a run failed at', () => {
    const steps = guidedSteps(
      INTAKE,
      [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'SUCCEEDED', outcome: 'confirmed' }, { nodeId: 'map', status: 'SUCCEEDED', outcome: 'confirmed' }, { nodeId: 'stage', status: 'FAILED', outcome: null }],
      'FAILED',
      'stage',
    );
    assert.deepEqual(labels(steps).slice(2, 4), ['Map the file:done', 'Stage the values:attention']);
  });
});
