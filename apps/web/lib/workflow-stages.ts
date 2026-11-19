import type { WorkflowGraph, WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';

/**
 * A run shown as guided work: a ribbon of the steps a person would recognise,
 * and the one screen that is waiting on them. Pure, so it can be tested without
 * a page.
 */

export interface StageView {
  id: string;
  runId: string;
  nodeId: string;
  workflowName: string | null;
  screen: string;
  title: string;
  instructions: string | null;
  args: Record<string, unknown>;
  outcomes: string[];
  allowedOutcomes: string[];
  status: string;
  outcome: string | null;
  result: Record<string, unknown> | null;
  returnedReason: string | null;
  assignees: Array<{ id?: string; name?: string; kind?: string }>;
  canAct: boolean;
  blocker: string | null;
  completedByName: string | null;
  completedAt: string | null;
  dueAt: string | null;
}

const STAGE_FIELDS = 'id runId nodeId workflowName screen title instructions args outcomes allowedOutcomes status outcome result returnedReason assignees canAct blocker completedByName completedAt dueAt';

/** Every stage of one run, open or not. */
export const RUN_STAGES_QUERY = `
  query WorkflowRunStages($runId: ID!) {
    workflowStages(status: null, runId: $runId) { ${STAGE_FIELDS} }
  }
`;
export const COMPLETE_STAGE = `
  mutation CompleteWorkflowStage($id: ID!, $outcome: String!, $result: JSON) {
    completeWorkflowStage(id: $id, outcome: $outcome, result: $result) { stage { ${STAGE_FIELDS} } errors { message } }
  }
`;
export const STAGE_SCREENS_QUERY = `query WorkflowStageScreens { workflowStageScreens { code label description outcomes args } }`;

export interface GuidedStep {
  nodeId: string;
  label: string;
  /** A person works this step at a screen, a review or a form. */
  human: boolean;
  state: 'done' | 'current' | 'attention' | 'waiting';
  note?: string;
}

/** Steps that only route the run. They are not shown on the ribbon. */
const STRUCTURAL = new Set(['start', 'end', 'branch', 'parallel', 'join']);
const HUMAN = new Set(['stage', 'review', 'form']);

interface StepMark {
  nodeId: string;
  status: string;
  outcome: string | null;
}

/** Whether a workflow is meant to be worked through as guided stages. */
export function isGuided(graph: WorkflowGraph | null | undefined): boolean {
  return Boolean(graph?.nodes.some((node) => node.type === 'stage'));
}

/**
 * The steps still on the run's path, in the order it reaches them. A step the
 * run can no longer reach, because a decision took another path, is left out.
 */
export function guidedSteps(graph: WorkflowGraph, steps: StepMark[], runStatus: string, currentNode: string | null): GuidedStep[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const marks = new Map(steps.map((step) => [step.nodeId, step]));
  const start = graph.nodes.find((node) => node.type === 'start');
  if (!start) return [];

  const order: WorkflowNode[] = [];
  const seen = new Set<string>([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (!node) continue;
    order.push(node);
    const mark = marks.get(id);
    const finished = mark?.status === 'SUCCEEDED' || mark?.status === 'SKIPPED';
    const out = graph.edges.filter((edge) => edge.from === id);
    // Once a step has an outcome, only the path that outcome took is still ahead.
    const taken = finished && mark?.outcome && node.type !== 'parallel'
      ? [out.find((edge) => edge.when === mark.outcome) || out.find((edge) => !edge.when)].filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
      : out;
    for (const edge of taken) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }

  const failed = runStatus === 'FAILED';
  return order
    .filter((node) => !STRUCTURAL.has(node.type))
    .map((node) => {
      const mark = marks.get(node.id);
      const human = HUMAN.has(node.type);
      let state: GuidedStep['state'] = 'waiting';
      let note: string | undefined;
      if (mark?.status === 'SUCCEEDED' || mark?.status === 'SKIPPED') {
        state = 'done';
        note = mark.outcome || undefined;
      } else if (mark?.status === 'FAILED' || (failed && currentNode === node.id)) {
        state = 'attention';
        note = 'failed';
      } else if (mark?.status === 'WAITING') {
        state = 'current';
        note = 'waiting for a person';
      } else if (mark?.status === 'RUNNING' || currentNode === node.id) {
        state = 'current';
        note = human ? undefined : 'working';
      }
      return { nodeId: node.id, label: node.label, human, state, note };
    });
}
