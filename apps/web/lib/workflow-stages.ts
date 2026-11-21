/**
 * The stages of a run: the screens a Stage step puts in front of a person.
 * How they sit among a run's other decisions is in workflow-checklist.ts.
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
