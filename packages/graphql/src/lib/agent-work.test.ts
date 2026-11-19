import { describe, expect, it } from 'vitest';
import { agentWork, agentsAtWork } from './agent-work';

const node = (id: string, type: string, label: string, config: Record<string, unknown> = {}) => ({ id, type, label, position: { x: 0, y: 0 }, config });

const GRAPH = {
  nodes: [
    node('start', 'start', 'Start'),
    node('scan', 'tool', 'Find breaks', { tool: 'get_cash_reconciliation' }),
    node('work', 'agent', 'Work the breaks', { agent: 'reconciler', maxRounds: 10, instructions: 'x' }),
    node('review', 'review', 'Review', { source: 'work' }),
    node('apply', 'apply', 'Apply', { review: 'review' }),
    node('end', 'end', 'End'),
  ],
  edges: [],
};

function run(patch: Record<string, unknown>) {
  return { id: 'run-1', workflow_name: 'Cash matching', status: 'RUNNING', current_node: 'work', graph: GRAPH, steps: [], events: [], reviews: [], started_at: '2026-11-18T10:00:00Z', ...patch };
}

const done = (nodeId: string, nodeType: string) => ({ node_id: nodeId, node_type: nodeType, status: 'SUCCEEDED' });
const event = (type: string, nodeId: string, summary = '') => ({ event_type: type, node_id: nodeId, summary });

describe('agent work', () => {
  it('leaves out a run that has finished', () => {
    expect(agentWork(run({ status: 'SUCCEEDED' }))).toBeNull();
    expect(agentWork(run({ status: 'FAILED' }))).toBeNull();
  });

  it('says how far a running agent is, by its name', () => {
    const work = agentWork(
      run({
        steps: [done('start', 'start'), done('scan', 'tool'), { node_id: 'work', node_type: 'agent', status: 'RUNNING' }],
        events: [
          event('agent.identity', 'work', 'Running as Reconciler'),
          event('agent.usage', 'work'),
          event('agent.tool', 'work'),
          event('agent.tool', 'work'),
          event('agent.usage', 'work'),
          event('agent.usage', 'work'),
          event('agent.usage', 'scan'),
        ],
      }),
    );
    expect(work).toMatchObject({
      state: 'working',
      agentCode: 'RECONCILER',
      agentName: 'Reconciler',
      stepLabel: 'Work the breaks',
      detail: 'Round 3 of up to 10 · 2 reads',
      stepsDone: 1,
      stepsTotal: 4,
    });
    // One of four steps done, and three of ten rounds into the second.
    expect(work?.percent).toBe(33);
  });

  it('never shows a running agent as nearly done, and falls back to its code or label', () => {
    const many = Array.from({ length: 30 }, () => event('agent.usage', 'work'));
    const late = agentWork(run({ steps: [done('scan', 'tool')], events: many }));
    expect(late?.detail).toBe('Round 10 of up to 10 · 0 reads');
    expect(late?.percent).toBe(48);
    expect(late?.agentName).toBe('RECONCILER');

    const graph = { ...GRAPH, nodes: GRAPH.nodes.map((entry) => (entry.id === 'work' ? { ...entry, config: { instructions: 'x' } } : entry)) };
    const unnamed = agentWork(run({ graph }));
    expect(unnamed).toMatchObject({ agentCode: null, agentName: 'Work the breaks', detail: 'Starting' });
  });

  it('credits a review to the agent whose proposal it is', () => {
    const work = agentWork(
      run({
        status: 'WAITING',
        current_node: 'review',
        steps: [done('scan', 'tool'), done('work', 'agent')],
        events: [event('agent.identity', 'work', 'Running as Reconciler')],
        reviews: [{ status: 'OPEN', proposal: { items: [{}, {}, {}] } }, { status: 'APPROVED', proposal: { items: [{}] } }],
      }),
    );
    expect(work).toMatchObject({ state: 'waiting', agentName: 'Reconciler', stepLabel: 'Review', detail: 'Waiting on a review of 3 proposed changes', percent: 50 });
  });

  it('describes a queued run and a run with no agent step', () => {
    expect(agentWork(run({ status: 'QUEUED', current_node: null }))).toMatchObject({ state: 'queued', stepLabel: 'Not started', detail: 'Waiting for a worker to pick it up', agentName: null, percent: 0 });
    expect(agentWork(run({ current_node: 'scan' }))).toMatchObject({ state: 'working', agentName: null, stepLabel: 'Find breaks', detail: 'Running' });
    expect(agentWork(run({ graph: null, current_node: 'x' }))).toMatchObject({ stepsTotal: 1, percent: 0 });
  });

  it('gives each agent its standing and counts the runs', () => {
    const board = agentsAtWork(
      [
        run({ id: 'waiting', status: 'WAITING', current_node: 'review', steps: [done('work', 'agent')], started_at: '2026-11-18T09:00:00Z' }),
        run({ id: 'running' }),
        run({ id: 'finished', status: 'SUCCEEDED' }),
        run({ id: 'queued', status: 'QUEUED', current_node: null }),
      ],
      [
        { code: 'ANALYST', name: 'Analyst' },
        { code: 'RECONCILER', name: 'Reconciler', description: 'Works breaks.' },
        { code: 'OFF', name: 'Switched off', isActive: false },
      ],
    );
    expect(board.work.map((item) => item.runId)).toEqual(['running', 'queued', 'waiting']);
    expect(board.running).toBe(2);
    expect(board.waiting).toBe(1);
    expect(board.agents).toEqual([
      { code: 'RECONCILER', name: 'Reconciler', description: 'Works breaks.', state: 'working', runs: 2 },
      { code: 'ANALYST', name: 'Analyst', description: null, state: 'idle', runs: 0 },
    ]);
  });
});
