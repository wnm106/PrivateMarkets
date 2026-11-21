import { prepareRunInput, runSetupOf, type RunSetup } from '@tapestrai/graphql/src/lib/workflow-filters';
import { asGraph } from '@tapestrai/graphql/src/lib/workflow-graph';
import { sessionClientIds } from '../feeds/session-client';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * Starting a workflow from the chat. The guided skill finds the workflow, learns what a
 * run asks for, and calls start_workflow_run only once the person has confirmed. The
 * database functions check the caller's client and the workflow.run permission.
 */

type Row = Record<string, any>;


async function setupOf(supabase: any, workflowId: string, version: number | null): Promise<RunSetup | null> {
  if (!version) return null;
  const { data, error } = await supabase.rpc('workflow_get', { p_id: workflowId, p_version: version });
  if (error) throw error;
  const graph = (data as Row | null)?.graph;
  return graph ? runSetupOf(asGraph(graph)) : null;
}

const listWorkflows: ToolDefinition = {
  name: 'list_workflows',
  description: 'The workflows that can be started. For each: id, code, name, what it does, whether it is published, the type of record it works on (appliesTo), whether a run must name records (requiresRecords), and the other values a run asks for (inputs, each with a key, label and type of text, date or number). Only a published workflow can be started.',
  category: 'workflow',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => {
    const { data, error } = await supabase.rpc('workflow_list', {});
    if (error) throw error;
    const rows = ((data as Row[] | null) || []).slice(0, 40);
    const workflows = await Promise.all(rows.map(async (row) => {
      const published = row.published_version ?? null;
      const setup = published ? await setupOf(supabase, row.id, published) : null;
      return {
        id: row.id, code: row.workflow_code, name: row.workflow_name, description: row.description || null,
        published: Boolean(published), version: published,
        appliesTo: setup?.appliesTo ?? null, requiresRecords: setup?.requiresRecords ?? false, inputs: setup?.inputs ?? [],
      };
    }));
    return { workflows };
  },
};

const startWorkflowRun: ToolDefinition = {
  name: 'start_workflow_run',
  description: 'Start a run of a published workflow. workflowId comes from list_workflows. Only call it after the person has confirmed the workflow, the records and every value. For records, input.filters is { "domainCode": "FUND", "entityIds": ["<id>", ...] } with ids from list_entities or find_sample_entities, and a workflow with requiresRecords needs entityIds. Every other value goes in input under its key from list_workflows. Returns the run id and its status.',
  category: 'workflow',
  inputSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string' },
      input: { type: 'object', description: 'filters plus the workflow\'s own input values' },
    },
    required: ['workflowId'],
  },
  execute: async (args, supabase) => {
    if (args.input != null && (typeof args.input !== 'object' || Array.isArray(args.input))) throw new Error('input must be an object');
    // A run belongs to one client. Someone in several is refused, not started in whichever came first.
    const clientIds = await sessionClientIds(supabase);
    if (clientIds.length === 0) throw new Error('Choose a client before starting a run.');
    if (clientIds.length > 1) throw new Error('Your account belongs to more than one client, so the client this run is for cannot be told. Nothing was started.');
    const clientId = clientIds[0];
    const { data: current, error: currentError } = await supabase.rpc('workflow_get', { p_id: args.workflowId, p_version: null });
    if (currentError) throw currentError;
    if (!current) throw new Error('That workflow was not found.');
    const version = (current as Row).published_version ?? null;
    if (!version) throw new Error('That workflow is not published, so it cannot be started.');
    const setup = await setupOf(supabase, args.workflowId, version);
    const prepared = prepareRunInput(setup ?? { appliesTo: null, requiresRecords: false, inputs: [] }, args.input || {});
    if ('problem' in prepared) throw new Error(prepared.problem);
    const { data: runId, error } = await supabase.rpc('workflow_run_start', {
      p_workflow_id: args.workflowId, p_client_id: clientId, p_input: prepared.input, p_version: null,
    });
    if (error) throw error;
    const { data: run } = await supabase.rpc('workflow_run_get', { p_run_id: String(runId) });
    return { started: true, runId: String(runId), status: (run as Row | null)?.status ?? 'QUEUED', workflow: (current as Row).workflow_name, version };
  },
};

export function registerWorkflowTools(registry: ToolRegistry): void {
  registry.registerTool(listWorkflows);
  registry.registerTool(startWorkflowRun);
}
