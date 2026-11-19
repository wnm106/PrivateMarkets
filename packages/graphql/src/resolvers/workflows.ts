import type { Context } from '../context';
import { parseFilters, prepareRunInput, runSetupOf, type RunSetup } from '../lib/workflow-filters';
import { NODE_TYPES, asGraph, validateGraph } from '../lib/workflow-graph';
import { STAGE_SCREENS } from '../lib/workflow-screens';
import { LIST_VALUE_TOOL, asDecision, asProposal, checkDecision, proposalCounts } from '../lib/workflow-proposal';
import { WORKFLOW_TEMPLATES } from '../lib/workflow-templates';
import { callerClientId } from './jobs';

/**
 * Workflows: definitions, runs, and reviews. The tables are reached only
 * through the workflow_* database functions, which check the caller's client
 * and the workflow.manage, workflow.run, and workflow.review permissions. The
 * worker in packages/worker advances the runs.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

function failure(error: unknown, code: string, field: string | null = null): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  return { field, message: raw || 'The request failed.', code };
}

function codeFromName(name: string): string {
  return (
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 100) || 'WORKFLOW'
  );
}

export function mapWorkflow(row: Row) {
  const graph = row.graph ? asGraph(row.graph) : null;
  return {
    id: row.id,
    clientId: row.client_id || null,
    code: row.workflow_code,
    name: row.workflow_name,
    description: row.description || null,
    publishedVersion: row.published_version ?? null,
    latestVersion: row.latest_version ?? 0,
    version: row.version ?? null,
    graph,
    // Known when the graph was read. In a list it is read on request: see Workflow.runSetup.
    runSetup: graph ? runSetupOf(graph) : null,
    problems: graph ? validateGraph(graph) : [],
    versions: ((row.versions as Row[] | undefined) || []).map((version) => ({
      version: version.version,
      changeNote: version.change_note || null,
      createdBy: version.created_by || null,
      createdAt: version.created_at,
    })),
    canManage: row.can_manage === true,
    runCount: Number(row.run_count) || 0,
    lastRunAt: row.last_run_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapReview(row: Row) {
  const proposal = row.proposal ? asProposal(row.proposal) : null;
  const agent = row.proposal && typeof row.proposal === 'object' ? (row.proposal as Row).agent : null;
  return {
    agentCode: agent && typeof agent.code === 'string' ? agent.code : null,
    agentName: agent && typeof agent.name === 'string' ? agent.name : null,
    id: row.id,
    runId: row.run_id,
    clientId: row.client_id,
    nodeId: row.node_id,
    workflowName: row.workflow_name || null,
    title: row.title,
    instructions: row.instructions || null,
    summary: row.summary || null,
    proposal,
    counts: proposal ? proposalCounts(proposal) : null,
    itemCount: proposal ? proposal.items.length : Number(row.item_count) || 0,
    status: row.status,
    decision: row.decision ?? null,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at,
    canReview: row.can_review === true,
    blocker: typeof row.blocker === 'string' ? row.blocker : null,
    assignees: Array.isArray(row.assignees) ? row.assignees : [],
    assignedToMe: row.assigned_to_me === true,
    separateReviewer: row.separate_reviewer === true,
    startedBy: row.started_by || null,
    startedByName: row.started_by_name || null,
    dueAt: row.due_at || null,
    overdue: row.status === 'OPEN' && typeof row.due_at === 'string' && Date.parse(row.due_at) < Date.now(),
    approvalsRequired: typeof row.approvals_required === 'number' ? row.approvals_required : 1,
    approvals: Array.isArray(row.approval_names) ? row.approval_names : [],
  };
}

export function mapTrigger(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    workflowId: row.workflow_id,
    name: row.trigger_name,
    source: row.source,
    match: row.match && typeof row.match === 'object' ? row.match : {},
    input: row.input && typeof row.input === 'object' ? row.input : {},
    isActive: row.is_active === true,
    createdBy: row.created_by,
    createdByName: row.created_by_name || null,
    busy: row.busy === true,
    lastFiredAt: row.last_fired_at || null,
    lastCount: typeof row.last_count === 'number' ? row.last_count : null,
    lastJob: row.last_job ?? null,
    canManage: row.can_manage === true,
    createdAt: row.created_at,
  };
}

export function mapForm(row: Row) {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    workflowName: row.workflow_name || null,
    title: row.title,
    instructions: row.instructions || null,
    fields: Array.isArray(row.fields) ? row.fields : [],
    status: row.status,
    answers: row.answers ?? null,
    note: row.note || null,
    externalEmail: row.external_email || null,
    linkActive: row.link_active === true,
    assignees: Array.isArray(row.assignees) ? row.assignees : [],
    canAnswer: row.can_answer === true,
    blocker: typeof row.blocker === 'string' ? row.blocker : null,
    submittedByName: row.submitted_by_name || row.submitted_by_external || null,
    submittedAt: row.submitted_at || null,
    dueAt: row.due_at || null,
    createdAt: row.created_at,
  };
}

export function mapStage(row: Row) {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    workflowName: row.workflow_name || null,
    screen: row.screen,
    title: row.title,
    instructions: row.instructions || null,
    args: row.args && typeof row.args === 'object' ? row.args : {},
    outcomes: Array.isArray(row.outcomes) ? row.outcomes : [],
    allowedOutcomes: Array.isArray(row.allowed_outcomes) ? row.allowed_outcomes : [],
    status: row.status,
    outcome: row.outcome || null,
    result: row.result ?? null,
    returnedReason: row.returned_reason || null,
    assignees: Array.isArray(row.assignees) ? row.assignees : [],
    canAct: row.can_act === true,
    blocker: typeof row.blocker === 'string' ? row.blocker : null,
    completedByName: row.completed_by_name || null,
    completedAt: row.completed_at || null,
    dueAt: row.due_at || null,
    createdAt: row.created_at,
  };
}

export function mapNotificationSettings(row: Row) {
  return {
    emailEnabled: row.email_enabled === true,
    slackConfigured: row.slack_configured === true,
    canManage: row.can_manage === true,
    sentLast7Days: Number(row.sent_last_7_days) || 0,
    failedLast7Days: Number(row.failed_last_7_days) || 0,
    updatedAt: row.updated_at || null,
  };
}

export function mapRun(row: Row) {
  const canReview = row.can_review === true;
  return {
    id: row.id,
    clientId: row.client_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name || null,
    version: row.version,
    status: row.status,
    input: row.input || {},
    context: row.context || {},
    currentNode: row.current_node || null,
    errorMessage: row.error_message || null,
    startedBy: row.started_by || null,
    openReviews: Number(row.open_reviews) || ((row.reviews as Row[] | undefined) || []).filter((review) => review.status === 'OPEN').length,
    canRun: row.can_run === true,
    canReview,
    canManage: row.can_manage === true,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    graph: row.graph ? asGraph(row.graph) : null,
    steps: ((row.steps as Row[] | undefined) || []).map((step) => ({
      nodeId: step.node_id,
      nodeType: step.node_type,
      nodeLabel: step.node_label || null,
      status: step.status,
      outcome: step.outcome || null,
      attempts: step.attempts ?? 0,
      input: step.input ?? null,
      output: step.output ?? null,
      errorMessage: step.error_message || null,
      startedAt: step.started_at,
      finishedAt: step.finished_at || null,
    })),
    events: ((row.events as Row[] | undefined) || []).map((event) => ({
      id: String(event.id),
      nodeId: event.node_id || null,
      type: event.event_type,
      actorType: event.actor_type,
      actorId: event.actor_id || null,
      actorName: event.actor_name || null,
      summary: event.summary,
      detail: event.detail ?? null,
      createdAt: event.created_at,
    })),
    // Each review carries its own can_review: who it is for and who started the run decide it, not only the permission.
    reviews: ((row.reviews as Row[] | undefined) || []).map((review) => mapReview({ ...review, workflow_name: row.workflow_name, can_review: 'can_review' in review ? review.can_review : canReview })),
  };
}

async function readRun(context: Context, id: string) {
  const { data, error } = await context.supabase.rpc('workflow_run_get', { p_run_id: id });
  if (error) throw error;
  return data ? mapRun(data as Row) : null;
}

/** What a version of a workflow asks for when a run starts. Null when the version cannot be read. */
async function readRunSetup(context: Context, workflowId: string, version: number | null): Promise<RunSetup | null> {
  if (!version) return null;
  const { data, error } = await context.supabase.rpc('workflow_get', { p_id: workflowId, p_version: version });
  if (error) throw error;
  const graph = (data as Row | null)?.graph;
  return graph ? runSetupOf(asGraph(graph)) : null;
}

export const workflowResolvers = {
  Workflow: {
    // A list carries no graphs. For a list this reads the published version, which is the one a new run uses.
    runSetup: async (parent: { id: string; runSetup: RunSetup | null; publishedVersion: number | null }, _: unknown, context: Context) =>
      parent.runSetup ?? readRunSetup(context, parent.id, parent.publishedVersion),
  },
  Query: {
    workflows: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_list', {});
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapWorkflow);
    },

    workflow: async (_: unknown, args: { id: string; version?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_get', { p_id: args.id, p_version: args.version ?? null });
      if (error) throw error;
      return data ? mapWorkflow(data as Row) : null;
    },

    workflowTemplates: () => WORKFLOW_TEMPLATES,

    // Records to choose from when starting a run: the first few of a type, or those matching what was typed.
    workflowRecordChoices: async (_: unknown, args: { domainCode?: string | null; search?: string | null; first?: number | null }, context: Context) => {
      const filters = parseFilters({ domainCode: args.domainCode, limit: args.first ?? 25 });
      const search = (args.search || '').trim().replace(/[%_\\,()]/g, ' ').trim();
      let query = context.supabase.from('master_entities').select('id, entity_code, entity_name, domain_code').eq('is_active', true);
      if (filters.domainCode) query = query.eq('domain_code', filters.domainCode);
      if (search) query = query.or(`entity_name.ilike.%${search}%,entity_code.ilike.%${search}%`);
      const { data, error } = await query.order('entity_name').limit(Math.min(filters.limit, 50));
      if (error) throw error;
      return ((data as Row[] | null) || []).map((row) => ({ id: row.id, entityCode: row.entity_code, entityName: row.entity_name, domainCode: row.domain_code }));
    },
    workflowNodeTypes: () => NODE_TYPES,

    workflowRuns: async (_: unknown, args: { workflowId?: string | null; status?: string | null; first?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_runs_list', {
        p_workflow_id: args.workflowId || null,
        p_status: args.status || null,
        p_limit: args.first ?? 50,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapRun);
    },

    workflowRun: (_: unknown, args: { id: string }, context: Context) => readRun(context, args.id),

    workflowReviews: async (_: unknown, args: { status?: string | null; mine?: boolean | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_reviews_list', {
        p_status: args.status === undefined ? 'OPEN' : args.status,
        p_limit: 100,
        p_mine: args.mine === true,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapReview);
    },

    workflowTriggers: async (_: unknown, args: { workflowId: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_triggers_list', { p_workflow_id: args.workflowId });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapTrigger);
    },

    workflowForms: async (_: unknown, args: { status?: string | null; runId?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_forms_list', {
        p_status: args.status === undefined ? 'OPEN' : args.status,
        p_run_id: args.runId || null,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapForm);
    },

    workflowStages: async (_: unknown, args: { status?: string | null; runId?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_stages_list', {
        p_status: args.status === undefined ? 'OPEN' : args.status,
        p_run_id: args.runId || null,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapStage);
    },

    workflowStageScreens: () => STAGE_SCREENS.map((screen) => ({ code: screen.code, label: screen.label, description: screen.description, outcomes: screen.outcomes, args: screen.args })),

    workflowRunChildren: async (_: unknown, args: { runId: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_run_children', { p_run_id: args.runId });
      if (error) throw error;
      return ((data as Row[] | null) || []).map((row) => ({
        id: row.id,
        status: row.status,
        input: row.input ?? {},
        createdAt: row.created_at,
        finishedAt: row.finished_at || null,
        openReviews: Number(row.open_reviews) || 0,
      }));
    },

    workflowPortalForm: async (_: unknown, args: { token: string }, context: Context) => {
      // Only a well-formed token is looked up; anything else is simply not found.
      if (!/^[0-9a-f]{48}$/.test(String(args.token || ''))) return null;
      const { data, error } = await context.supabase.rpc('workflow_portal_get', { p_token: args.token });
      if (error) throw error;
      return data ?? null;
    },

    workflowReview: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_review_get', { p_review_id: args.id });
      if (error) throw error;
      return data ? mapReview(data as Row) : null;
    },

    workflowAnalytics: async (_: unknown, args: { days?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_analytics', { p_days: args.days ?? 30 });
      if (error) throw error;
      return data ?? { days: args.days ?? 30, workflows: [] };
    },

    notificationSettings: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('notification_settings_get');
      if (error) throw error;
      return mapNotificationSettings((data as Row) || {});
    },

    workflowReviewerChoices: async (_: unknown, args: { clientId?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_reviewer_choices', { p_client_id: args.clientId || null });
      if (error) throw error;
      const row = (data as Row | null) || {};
      return { people: Array.isArray(row.people) ? row.people : [], roles: Array.isArray(row.roles) ? row.roles : [] };
    },
  },

  Mutation: {
    /** Saves a new version. A graph with problems can be saved as a draft; it cannot be published. */
    saveWorkflow: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const name = String(input.name || '').trim();
        if (!name) return { workflow: null, errors: [{ field: 'name', message: 'Give the workflow a name.', code: 'VALIDATION' }] };
        const graph = asGraph(input.graph);
        if (graph.nodes.length === 0) return { workflow: null, errors: [{ field: 'graph', message: 'The workflow has no steps.', code: 'VALIDATION' }] };

        let clientId: string | null = null;
        if (!input.id && !input.shared) {
          clientId = await callerClientId(context);
          if (!clientId) return { workflow: null, errors: [{ field: null, message: 'Choose a client before adding a workflow.', code: 'NO_CLIENT' }] };
        }
        const { data, error } = await context.supabase.rpc('workflow_save', {
          p_id: input.id || null,
          p_client_id: clientId,
          p_code: String(input.code || '').trim() || codeFromName(name),
          p_name: name,
          p_description: input.description ?? null,
          p_graph: graph,
          p_change_note: input.changeNote ?? null,
        });
        if (error) throw error;
        return { workflow: mapWorkflow(data as Row), errors: [] };
      } catch (error) {
        return { workflow: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    publishWorkflow: async (_: unknown, args: { id: string; version: number }, context: Context) => {
      try {
        const current = await context.supabase.rpc('workflow_get', { p_id: args.id, p_version: args.version });
        if (current.error) throw current.error;
        if (!current.data || !(current.data as Row).graph) {
          return { workflow: null, errors: [{ field: 'version', message: 'That version does not exist.', code: 'NOT_FOUND' }] };
        }
        const problems = validateGraph(asGraph((current.data as Row).graph));
        if (problems.length > 0) {
          return { workflow: mapWorkflow(current.data as Row), errors: problems.map((problem) => ({ field: problem.nodeId, message: problem.message, code: 'INVALID_GRAPH' })) };
        }
        const { data, error } = await context.supabase.rpc('workflow_publish', { p_id: args.id, p_version: args.version });
        if (error) throw error;
        return { workflow: mapWorkflow(data as Row), errors: [] };
      } catch (error) {
        return { workflow: null, errors: [failure(error, 'PUBLISH_FAILED')] };
      }
    },

    archiveWorkflow: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('workflow_archive', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'ARCHIVE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'Workflow was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },

    startWorkflowRun: async (_: unknown, args: { workflowId: string; input?: unknown; version?: number | null }, context: Context) => {
      try {
        if (args.input != null && (typeof args.input !== 'object' || Array.isArray(args.input))) {
          return { run: null, errors: [{ field: 'input', message: 'The input must be a JSON object.', code: 'VALIDATION' }] };
        }
        const clientId = await callerClientId(context);
        if (!clientId) return { run: null, errors: [{ field: null, message: 'Choose a client before starting a run.', code: 'NO_CLIENT' }] };
        // The records are checked against what the workflow is about before the run exists.
        let version = args.version ?? null;
        if (!version) {
          const { data: current, error: currentError } = await context.supabase.rpc('workflow_get', { p_id: args.workflowId, p_version: null });
          if (currentError) throw currentError;
          version = (current as Row | null)?.published_version ?? null;
        }
        const setup = await readRunSetup(context, args.workflowId, version);
        const prepared = prepareRunInput(setup ?? { appliesTo: null, requiresRecords: false, inputs: [] }, args.input || {});
        if ('problem' in prepared) return { run: null, errors: [{ field: 'input', message: prepared.problem, code: 'VALIDATION' }] };
        const { data, error } = await context.supabase.rpc('workflow_run_start', {
          p_workflow_id: args.workflowId,
          p_client_id: clientId,
          p_input: prepared.input,
          p_version: args.version ?? null,
        });
        if (error) throw error;
        return { run: await readRun(context, String(data)), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'START_FAILED')] };
      }
    },

    cancelWorkflowRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('workflow_run_cancel', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) return { run: null, errors: [{ field: 'id', message: 'Only a run that has not finished can be cancelled.', code: 'NOT_CANCELLABLE' }] };
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'CANCEL_FAILED')] };
      }
    },

    retryWorkflowRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('workflow_run_retry', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) return { run: null, errors: [{ field: 'id', message: 'Only a failed run can be retried.', code: 'NOT_RETRYABLE' }] };
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'RETRY_FAILED')] };
      }
    },

    /**
     * Records a review decision. An approval is checked against the stored
     * proposal first: every change needs a choice, and an approved change needs
     * its required questions answered.
     */
    decideWorkflowReview: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const outcome = String(input.outcome || '').toUpperCase();
        if (outcome !== 'APPROVED' && outcome !== 'REJECTED') {
          return { review: null, errors: [{ field: 'outcome', message: 'A review is approved or rejected.', code: 'VALIDATION' }] };
        }
        const current = await context.supabase.rpc('workflow_review_get', { p_review_id: input.reviewId });
        if (current.error) throw current.error;
        if (!current.data) return { review: null, errors: [{ field: 'reviewId', message: 'Review was not found.', code: 'NOT_FOUND' }] };
        // The database refuses too. Saying so first keeps the message the same whatever was decided.
        const blocker = (current.data as Row).blocker;
        if (typeof blocker === 'string' && blocker) {
          return { review: mapReview(current.data as Row), errors: [{ field: null, message: blocker, code: 'FORBIDDEN' }] };
        }

        const decision = asDecision(input.decision);
        let recorded = outcome;
        if (outcome === 'APPROVED') {
          const proposal = asProposal((current.data as Row).proposal);
          const check = checkDecision(proposal, decision);
          if (!check.ok) {
            return { review: mapReview(current.data as Row), errors: check.problems.map((message) => ({ field: null, message, code: 'INCOMPLETE' })) };
          }
          // A list is shared by every client. Only a tenant admin may approve a change to one.
          const approved = new Set(check.approved);
          if (proposal.items.some((item) => approved.has(item.id) && item.tool === LIST_VALUE_TOOL)) {
            const admin = await context.supabase.schema('tenancy').rpc('is_tenant_admin');
            if (admin.error || admin.data !== true) {
              return {
                review: mapReview(current.data as Row),
                errors: [{ field: null, message: 'Adding a value to a list needs a tenant admin, because lists are shared by every client. Reject that change, or ask a tenant admin to review.', code: 'FORBIDDEN' }],
              };
            }
          }
          // Approving a review with every change rejected is a rejection.
          if (proposal.items.length > 0 && check.approved.length === 0) recorded = 'REJECTED';
        }
        const { data, error } = await context.supabase.rpc('workflow_review_decide', { p_review_id: input.reviewId, p_outcome: recorded, p_decision: decision });
        if (error) throw error;
        return { review: mapReview(data as Row), errors: [] };
      } catch (error) {
        return { review: null, errors: [failure(error, 'DECIDE_FAILED')] };
      }
    },

    saveWorkflowTrigger: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      try {
        const { data, error } = await context.supabase.rpc('workflow_trigger_save', {
          p_id: input.id || null,
          p_workflow_id: input.workflowId,
          p_name: String(input.name || ''),
          p_source: String(input.source || ''),
          p_match: object(input.match),
          p_input: object(input.input),
          p_is_active: input.isActive !== false,
        });
        if (error) throw error;
        return { trigger: mapTrigger(data as Row), errors: [] };
      } catch (error) {
        return { trigger: null, errors: [failure(error, 'TRIGGER_SAVE_FAILED')] };
      }
    },

    completeWorkflowStage: async (_: unknown, args: { id: string; outcome: string; result?: unknown }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('workflow_stage_complete', {
          p_stage_id: args.id,
          p_outcome: String(args.outcome || ''),
          p_result: args.result && typeof args.result === 'object' && !Array.isArray(args.result) ? args.result : {},
        });
        if (error) throw error;
        return { stage: mapStage(data as Row), errors: [] };
      } catch (error) {
        return { stage: null, errors: [failure(error, 'STAGE_COMPLETE_FAILED')] };
      }
    },

    submitWorkflowForm: async (_: unknown, args: { id: string; outcome: string; answers?: unknown; note?: string | null }, context: Context) => {
      try {
        const outcome = String(args.outcome || '').toUpperCase();
        const { data, error } = await context.supabase.rpc('workflow_form_submit', {
          p_form_id: args.id,
          p_outcome: outcome,
          p_answers: args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers) ? args.answers : {},
          p_note: args.note ?? null,
        });
        if (error) throw error;
        return { form: mapForm(data as Row), errors: [] };
      } catch (error) {
        return { form: null, errors: [failure(error, 'FORM_SUBMIT_FAILED')] };
      }
    },

    submitWorkflowPortalForm: async (_: unknown, args: { token: string; outcome: string; answers?: unknown; note?: string | null }, context: Context) => {
      if (!/^[0-9a-f]{48}$/.test(String(args.token || ''))) return { success: false, errors: [{ field: 'token', message: 'This link is not valid.', code: 'NOT_FOUND' }] };
      const { error } = await context.supabase.rpc('workflow_portal_submit', {
        p_token: args.token,
        p_outcome: String(args.outcome || '').toUpperCase(),
        p_answers: args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers) ? args.answers : {},
        p_note: args.note ?? null,
      });
      if (error) return { success: false, errors: [failure(error, 'FORM_SUBMIT_FAILED')] };
      return { success: true, errors: [] };
    },

    saveNotificationSettings: async (_: unknown, args: { emailEnabled: boolean; slackWebhookUrl?: string | null }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('notification_settings_save', {
          p_email_enabled: args.emailEnabled === true,
          p_slack_webhook_url: args.slackWebhookUrl === undefined ? null : args.slackWebhookUrl ?? null,
        });
        if (error) throw error;
        return { settings: mapNotificationSettings((data as Row) || {}), errors: [] };
      } catch (error) {
        return { settings: null, errors: [failure(error, 'NOTIFICATION_SAVE_FAILED')] };
      }
    },

    deleteWorkflowTrigger: async (_: unknown, args: { id: string }, context: Context) => {
      const { error } = await context.supabase.rpc('workflow_trigger_delete', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'TRIGGER_DELETE_FAILED')] };
      return { success: true, errors: [] };
    },

    reassignWorkflowReview: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []);
      try {
        const { data, error } = await context.supabase.rpc('workflow_review_reassign', {
          p_review_id: input.reviewId,
          p_users: list(input.people),
          p_roles: list(input.roles),
          p_note: typeof input.note === 'string' ? input.note : null,
        });
        if (error) throw error;
        return { review: mapReview(data as Row), errors: [] };
      } catch (error) {
        return { review: null, errors: [failure(error, 'REASSIGN_FAILED')] };
      }
    },
  },
};
