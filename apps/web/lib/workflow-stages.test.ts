import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { guidedSteps, isGuided } from './workflow-stages';

const INTAKE = WORKFLOW_TEMPLATES.find((template) => template.code === 'FILE_INTAKE')!.graph;
const CLEANUP = WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph;

const labels = (steps: ReturnType<typeof guidedSteps>) => steps.map((step) => `${step.label}:${step.state}`);

describe('guided runs', () => {
  it('are the workflows with a stage in them', () => {
    expect(isGuided(INTAKE)).toBe(true);
    expect(isGuided(CLEANUP)).toBe(false);
    expect(isGuided(null)).toBe(false);
  });

  it('show the steps a person would recognise, in order, and leave out the routing', () => {
    const steps = guidedSteps(INTAKE, [], 'QUEUED', null);
    expect(steps.map((step) => step.label)).toEqual(['Index for search', 'Understand the file', 'Map the file', 'Stage the values', 'Check the values', 'Promote to live records', 'Discard the batch']);
    expect(steps.filter((step) => step.human).map((step) => step.label)).toEqual(['Understand the file', 'Map the file', 'Check the values']);
    expect(steps.every((step) => step.state === 'waiting')).toBe(true);
  });

  it('mark the stage that is waiting on a person', () => {
    const steps = guidedSteps(INTAKE, [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'WAITING', outcome: null }], 'WAITING', 'understand');
    expect(labels(steps).slice(0, 3)).toEqual(['Index for search:done', 'Understand the file:current', 'Map the file:waiting']);
    expect(steps[1].note).toBe('waiting for a person');
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
    expect(labels(steps)).toEqual(['Index for search:done', 'Understand the file:done', 'Map the file:done', 'Stage the values:done', 'Check the values:done', 'Promote to live records:current']);
    expect(steps[5].note).toBe('working');
  });

  it('end where the person stops the run', () => {
    const steps = guidedSteps(INTAKE, [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'SUCCEEDED', outcome: 'abandoned' }], 'SUCCEEDED', null);
    expect(labels(steps)).toEqual(['Index for search:done', 'Understand the file:done']);
  });

  it('mark the step a run failed at', () => {
    const steps = guidedSteps(
      INTAKE,
      [{ nodeId: 'start', status: 'SUCCEEDED', outcome: null }, { nodeId: 'receive', status: 'SUCCEEDED', outcome: null }, { nodeId: 'understand', status: 'SUCCEEDED', outcome: 'confirmed' }, { nodeId: 'map', status: 'SUCCEEDED', outcome: 'confirmed' }, { nodeId: 'stage', status: 'FAILED', outcome: null }],
      'FAILED',
      'stage',
    );
    expect(labels(steps).slice(2, 4)).toEqual(['Map the file:done', 'Stage the values:attention']);
  });
});
