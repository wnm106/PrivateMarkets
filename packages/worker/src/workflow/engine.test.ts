import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import type { ReviewRouting } from '@tapestrai/graphql/src/lib/workflow-graph';
import { normalizeItems } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { runAgentStep, type AgentModel, type ModelTurn } from './agent';
import { RunBusyError, advanceRun, message, type Actor, type AgentRequest, type EngineDeps, type FormRow, type LoadedRun, type ReviewRow, type StageRow, type StepRow, type WorkflowStore } from './engine';
import { checkListValues } from './list-check';
import { signReason, workflowTools } from './tools';

const CLEANUP = WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph;

/** A store held in memory. It keeps steps, reviews, and events the way the database would. */
function memoryStore(graph: unknown, input: Record<string, unknown> = {}) {
  const run = { id: 'run-1', clientId: 'client-a', status: 'QUEUED', input, context: {} as Record<string, unknown>, currentNode: null as string | null, startedBy: 'owner', lockedBy: null as string | null };
  const steps = new Map<string, StepRow>();
  const reviews: ReviewRow[] = [];
  const routings: ReviewRouting[] = [];
  const spawned: Array<Record<string, unknown>> = [];
  const forms: Array<FormRow & { nodeId: string }> = [];
  const stages: Array<StageRow & { nodeId: string; spec: Record<string, unknown>; returned: string[] }> = [];
  const events: Array<{ nodeId: string | null; type: string; actor: string; actorId: string | null; summary: string }> = [];
  const store: WorkflowStore = {
    async load(_runId, owner): Promise<LoadedRun | 'busy' | 'done' | null> {
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return 'done';
      if (run.lockedBy && run.lockedBy !== owner) return 'busy';
      run.lockedBy = owner;
      return { ...run, graph, context: { ...run.context }, steps: [...steps.values()].map((step) => ({ ...step })), reviews: reviews.map((review) => ({ ...review })) };
    },
    async saveStep(_runId, owner, nodeId, patch) {
      if (run.lockedBy !== owner || run.status === 'CANCELLED') return false;
      const current = steps.get(nodeId) || { nodeId, status: 'RUNNING', outcome: null, output: null, state: null };
      steps.set(nodeId, {
        ...current,
        ...(patch.status ? { status: patch.status } : {}),
        ...('outcome' in patch ? { outcome: patch.outcome ?? null } : {}),
        ...('output' in patch ? { output: patch.output } : {}),
        ...('state' in patch ? { state: patch.state } : {}),
      });
      return true;
    },
    async saveRun(_runId, owner, patch, release) {
      if (run.lockedBy !== owner) return null;
      if (run.status !== 'CANCELLED' && patch.status) run.status = patch.status;
      if ('currentNode' in patch) run.currentNode = patch.currentNode ?? null;
      if (patch.context) Object.assign(run.context, patch.context);
      if (release) run.lockedBy = null;
      return run.status;
    },
    async event(_runId, nodeId, type, actor, actorId, summary) {
      events.push({ nodeId, type, actor, actorId, summary });
    },
    async spawn(_runId, inputs) {
      spawned.push(...inputs);
      return inputs.map((_, index) => `child-${index + 1}`);
    },
    async openForm(_runId, nodeId, spec) {
      const existing = forms.find((form) => form.nodeId === nodeId);
      if (existing) return { ...existing, created: false, token: null };
      const form = { nodeId, id: `form-${nodeId}`, status: 'OPEN', answers: null, note: null, created: true, token: spec.external ? 'a'.repeat(48) : null,
        externalEmail: spec.external ? String(spec.externalEmail) : null, title: String(spec.title), submittedBy: null };
      forms.push(form);
      return { ...form };
    },
    async openStage(_runId, nodeId, spec) {
      const existing = stages.find((stage) => stage.nodeId === nodeId);
      if (existing) return { ...existing };
      const stage = { nodeId, spec, returned: [] as string[], id: `stage-${nodeId}`, status: 'OPEN', outcome: null, result: {}, args: (spec.args || {}) as Record<string, unknown>, completedBy: null };
      stages.push(stage);
      return { ...stage };
    },
    async returnStage(stageId, reason) {
      const stage = stages.find((item) => item.id === stageId);
      if (!stage) return;
      stage.status = 'OPEN';
      stage.outcome = null;
      stage.returned.push(reason);
    },
    async openReview(_runId, nodeId, _title, _instructions, _summary, proposal, routing) {
      routings.push(routing);
      const review: ReviewRow = { id: `review-${nodeId}`, nodeId, status: 'OPEN', proposal, decision: null, decidedBy: null };
      reviews.push(review);
      return { ...review, assignees: routing.people.map((id) => `Person ${id}`), unassignable: [] };
    },
  };
  return { store, run, steps, reviews, events, routings, spawned, forms, stages };
}

const EXCEPTION = { id: 'ex-1', entityCode: 'LOAN-7', ruleCode: 'MATURITY_REQUIRED', exceptionMessage: 'Maturity date is missing' };

function proposed() {
  return normalizeItems([
    {
      action: 'UPDATE',
      target: { kind: 'Loan', label: 'LOAN-7', entityId: 'e7' },
      summary: 'Set maturity date on LOAN-7',
      tool: 'submit_manual_override',
      args: { entityId: 'e7', attributeCode: 'MATURITY_DATE', validFrom: '2026-11-16', overrideReason: 'Missing' },
      confidence: 'MEDIUM',
      rationale: 'No source carries it',
      missing: [{ key: 'value', label: 'Maturity date', question: 'What is the maturity date?', suggested: '2031-06-30' }],
    },
    {
      action: 'UPDATE',
      target: { kind: 'Data quality exception', label: 'ex-1' },
      summary: 'Resolve the exception on LOAN-7',
      tool: 'resolve_dq_exception',
      args: { exceptionId: 'ex-1', status: 'RESOLVED' },
      confidence: 'HIGH',
      rationale: 'Fixed by the override',
    },
  ]);
}

function deps(store: WorkflowStore, overrides: Partial<EngineDeps> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown>; actor: Actor; permission: string }> = [];
  const names = new Set(['find_records', 'list_dq_exceptions', 'get_dq_summary', 'get_attribute_list_values', 'get_data_quality_checks', 'get_entity', 'list_entities', 'get_field_lineage', 'get_temporal_history', 'get_template_metadata', 'get_attribute_metadata', 'search_attributes', 'query_data', 'get_model_map', 'submit_manual_override', 'resolve_dq_exception', 'create_entity']);
  const built: EngineDeps = {
    store,
    tools: {
      names: () => names,
      async run(name, args, actor, permission) {
        calls.push({ name, args, actor, permission });
        // A run started with no filters is not restricted to particular records.
        if (name === 'find_records') return { filtered: false, selection: 'every record' };
        if (name === 'list_dq_exceptions') return { exceptions: [EXCEPTION], totalCount: 1 };
        if (name === 'get_dq_summary') return { open: 0 };
        return { success: true };
      },
    },
    agent: async () => ({ summary: 'Looked at 1 exception and proposed 2 changes.', items: proposed() }),
    foundation: async () => [],
    ...overrides,
  };
  return { deps: built, calls };
}

describe('advanceRun', () => {
  function cleanupAs(agent: string) {
    const graph = JSON.parse(JSON.stringify(CLEANUP)) as { nodes: Array<{ type: string; config: Record<string, unknown> }> };
    for (const node of graph.nodes) if (node.type === 'agent') node.config.agent = agent;
    return graph;
  }

  it('fails a step that names an agent the client does not have, or one switched off', async () => {
    const missing = memoryStore(cleanupAs('ghost'));
    const asked: string[] = [];
    const none = deps(missing.store, { agents: async (_clientId, code) => (asked.push(code), null) });
    expect(await advanceRun('run-1', 'job-1', none.deps)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('no agent with the code "GHOST"') });
    expect(asked).toEqual(['GHOST']);

    const off = memoryStore(cleanupAs('STEWARD'));
    const steward = { code: 'STEWARD', name: 'Steward', description: '', charter: '', activityCodes: [], domainCodes: [], toolNames: [], isActive: false, shared: true };
    expect(await advanceRun('run-1', 'job-1', deps(off.store, { agents: async () => steward }).deps)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('switched off') });
  });

  it('runs a step as its named agent and routes the review by the agent\u2019s activity', async () => {
    const memory = memoryStore(cleanupAs('RECONCILER'));
    const reconciler = { code: 'RECONCILER', name: 'Reconciler', description: '', charter: '', activityCodes: ['RECONCILIATION'], domainCodes: [], toolNames: [], isActive: true, shared: true };
    const given: Array<string | undefined> = [];
    const { deps: engine } = deps(memory.store, {
      agents: async () => reconciler,
      agent: async (request) => (given.push(request.agent?.code), { summary: 'Done.', items: proposed() }),
    });
    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'WAITING' });
    expect(given).toEqual(['RECONCILER']);
    expect(memory.events.some((event) => event.type === 'agent.identity' && event.summary === 'Running as Reconciler')).toBe(true);
    expect(memory.routings[0].activity).toBe('RECONCILIATION');
  });

  it('runs to the review, waits, then applies what was approved as the reviewer', async () => {
    const memory = memoryStore(CLEANUP, { limit: 5 });
    const { deps: engine, calls } = deps(memory.store);

    const first = await advanceRun('run-1', 'job-1', engine);
    expect(first).toMatchObject({ status: 'WAITING', waitingOn: 'review' });
    expect(memory.run.status).toBe('WAITING');
    expect(memory.run.lockedBy).toBeNull();
    // Records are selected first. With no filters nothing is passed, so nothing is restricted.
    expect(calls[0]).toMatchObject({ name: 'find_records', args: {}, permission: 'read' });
    // The limit is passed as a number, and settings with no value are left out.
    expect(calls[1]).toEqual({ name: 'list_dq_exceptions', args: { status: 'OPEN', first: 5 }, actor: { userId: 'owner', clientId: 'client-a' }, permission: 'read' });
    // Nothing was changed while waiting.
    expect(calls.filter((call) => call.permission === 'apply')).toEqual([]);

    // A second job with nothing decided waits again and opens no second review.
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'WAITING' });
    expect(memory.reviews).toHaveLength(1);

    const [review] = memory.reviews;
    const [override, resolve] = (review.proposal as { items: Array<{ id: string }> }).items;
    review.status = 'APPROVED';
    review.decidedBy = 'reviewer';
    review.decision = { items: { [override.id]: { decision: 'APPROVE', answers: { value: '2031-06-30' } }, [resolve.id]: { decision: 'REJECT' } } };

    const second = await advanceRun('run-1', 'job-3', engine);
    expect(second.status).toBe('SUCCEEDED');
    const writes = calls.filter((call) => call.permission === 'apply');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: 'submit_manual_override', actor: { userId: 'reviewer', clientId: 'client-a' }, args: { entityId: 'e7', value: '2031-06-30' } });
    expect(memory.steps.get('apply')?.output).toMatchObject({ applied: 1, failed: 0 });
    expect(memory.events.find((event) => event.type === 'change.applied')).toMatchObject({ actor: 'USER', actorId: 'reviewer' });
    // Across all three passes the records were selected once, and exceptions read twice: the scan, and what is left at the end.
    expect(calls.filter((call) => call.name === 'find_records')).toHaveLength(1);
    expect(calls.filter((call) => call.name === 'list_dq_exceptions')).toHaveLength(2);
  });

  it('opens the review for the people and roles the step names, keeping the starter apart', async () => {
    const graph = JSON.parse(JSON.stringify(CLEANUP)) as { nodes: Array<{ type: string; config: Record<string, unknown> }> };
    const step = graph.nodes.find((node) => node.type === 'review')!;
    Object.assign(step.config, { people: ['{{input.reviewer}}'], roles: ['ops_lead'], dueInHours: '{{input.hours}}' });
    const memory = memoryStore(graph, { reviewer: 'user-9', hours: 24 });
    const { deps: engine } = deps(memory.store);

    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'WAITING' });
    expect(memory.routings).toEqual([{ people: ['user-9'], roles: ['OPS_LEAD'], separateReviewer: true, dueInHours: 24, escalateRoles: [], approvals: 1, reassignWhenOverdue: false, routeToOwners: true, activity: null }]);
    expect(memory.events.find((event) => event.type === 'review.requested')?.summary).toBe('Waiting for Person user-9 to review 2 proposed changes');
  });

  it('takes the rejected path and changes nothing', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine, calls } = deps(memory.store);
    await advanceRun('run-1', 'job-1', engine);
    memory.reviews[0].status = 'REJECTED';
    memory.reviews[0].decidedBy = 'reviewer';
    memory.reviews[0].decision = { items: {} };
    expect((await advanceRun('run-1', 'job-2', engine)).status).toBe('SUCCEEDED');
    expect(memory.steps.has('apply')).toBe(false);
    expect(calls.filter((call) => call.permission === 'apply')).toEqual([]);
  });

  it('skips the agent when the scan finds nothing', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine } = deps(memory.store);
    engine.tools.run = async () => ({ exceptions: [], totalCount: 0 });
    expect((await advanceRun('run-1', 'job-1', engine)).status).toBe('SUCCEEDED');
    expect([...memory.steps.keys()]).toEqual(['start', 'select', 'scan', 'any', 'end']);
  });

  it('fails the run at the step that threw, and picks up there on retry', async () => {
    const memory = memoryStore(CLEANUP);
    let attempts = 0;
    const { deps: engine, calls } = deps(memory.store, {
      agent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('The model could not be reached.');
        return { summary: 'Nothing to change.', items: [] };
      },
    });
    const failed = await advanceRun('run-1', 'job-1', engine);
    expect(failed).toMatchObject({ status: 'FAILED' });
    expect(failed.error).toMatch(/Investigate and propose fixes.*could not be reached/);
    expect(memory.steps.get('investigate')?.status).toBe('FAILED');

    // What workflow_run_retry does.
    memory.run.status = 'QUEUED';
    expect((await advanceRun('run-1', 'job-2', engine)).status).toBe('SUCCEEDED');
    // The steps before the one that failed were not run again: one selection, one scan, and the count at the end.
    expect(calls.filter((call) => call.name === 'find_records')).toHaveLength(1);
    expect(calls.filter((call) => call.name === 'list_dq_exceptions')).toHaveLength(2);
    // Nothing proposed, so the review was skipped and nothing was applied.
    expect(memory.reviews).toHaveLength(0);
    expect(memory.steps.get('apply')?.output).toMatchObject({ applied: 0 });
  });

  it('does not repeat a change that was applied before a crash', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine, calls } = deps(memory.store);
    await advanceRun('run-1', 'job-1', engine);
    const review = memory.reviews[0];
    const [override, resolve] = (review.proposal as { items: Array<{ id: string }> }).items;
    review.status = 'APPROVED';
    review.decidedBy = 'reviewer';
    review.decision = { items: { [override.id]: { decision: 'APPROVE', answers: { value: '2031-06-30' } }, [resolve.id]: { decision: 'APPROVE' } } };

    // The worker dies after the first change: the second call never returns.
    const run = engine.tools.run;
    engine.tools.run = async (name, args, actor, permission) => {
      if (name === 'resolve_dq_exception') throw Object.assign(new Error('crash'), { crash: true });
      return run(name, args, actor, permission);
    };
    const saveStep = memory.store.saveStep;
    let crashed = false;
    memory.store.saveStep = async (runId, owner, nodeId, patch) => {
      const state = patch.state as { done?: Record<string, { ok: boolean }> } | undefined;
      if (!crashed && nodeId === 'apply' && state?.done?.[resolve.id] && !state.done[resolve.id].ok && state.done[override.id]?.ok) {
        crashed = true;
        await saveStep(runId, owner, nodeId, patch);
        memory.run.lockedBy = null;
        return false;
      }
      return saveStep(runId, owner, nodeId, patch);
    };
    await advanceRun('run-1', 'job-2', engine);
    expect(crashed).toBe(true);

    engine.tools.run = run;
    memory.store.saveStep = saveStep;
    expect((await advanceRun('run-1', 'job-3', engine)).status).toBe('SUCCEEDED');
    expect(calls.filter((call) => call.name === 'submit_manual_override')).toHaveLength(1);
    // The change that was in flight is reported, not silently made again.
    const output = memory.steps.get('apply')?.output as { applied: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
    expect(output).toMatchObject({ applied: 1, failed: 1 });
    expect(output.results[1].error).toMatch(/Check the record/);
  });

  it('refuses while another job holds the run, and stops when the run is cancelled', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine } = deps(memory.store);
    memory.run.lockedBy = 'job-0';
    await expect(advanceRun('run-1', 'job-1', engine)).rejects.toBeInstanceOf(RunBusyError);

    memory.run.lockedBy = null;
    engine.agent = async () => {
      memory.run.status = 'CANCELLED';
      return { summary: '', items: [] };
    };
    expect((await advanceRun('run-1', 'job-1', engine)).status).toBe('CANCELLED');
    expect(memory.steps.has('review')).toBe(false);
  });

  it('asks for what the entity type requires, even when the agent did not', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine } = deps(memory.store, {
      agent: async () => ({
        summary: 'One record to create.',
        items: normalizeItems([
          { action: 'CREATE', target: { kind: 'Loan', label: 'LOAN-9' }, summary: 'Create LOAN-9', tool: 'create_entity', args: { entityCode: 'LOAN-9', entityName: 'Loan 9', domainCode: 'SECURITY', templateCode: 'LOAN', attributes: { CURRENCY: 'USD' } }, confidence: 'HIGH', rationale: 'In the term sheet' },
        ]),
      }),
      foundation: async () => [
        { code: 'CURRENCY', name: 'Currency', required: true },
        { code: 'MATURITY_DATE', name: 'Maturity date', dataType: 'DATE', required: true },
      ],
    });
    await advanceRun('run-1', 'job-1', engine);
    const [item] = (memory.reviews[0].proposal as { items: Array<{ needsReview: boolean; missing: Array<{ key: string; origin: string }> }> }).items;
    expect(item.needsReview).toBe(true);
    expect(item.missing).toEqual([expect.objectContaining({ key: 'attributes.MATURITY_DATE', origin: 'FOUNDATION', required: true })]);
  });
});

describe('runAgentStep', () => {
  function scripted(turns: Array<Partial<ModelTurn>>): AgentModel & { seen: unknown[][] } {
    const seen: unknown[][] = [];
    let index = 0;
    return {
      provider: 'test',
      model: 'test',
      seen,
      userMessage: (text) => ({ role: 'user', text }),
      resultMessage: (results) => ({ role: 'results', results: results.map((result) => ({ name: result.call.name, isError: result.isError, content: result.content })) }),
      async turn(_system, _tools, messages) {
        seen.push([...messages]);
        const turn = turns[Math.min(index, turns.length - 1)];
        index += 1;
        return { message: { role: 'assistant', index }, text: '', calls: [], stop: 'end', ...turn };
      },
    };
  }

  function request(config: Record<string, unknown>, state: unknown = null) {
    const checkpoints: unknown[] = [];
    const events: string[] = [];
    const built: AgentRequest = {
      node: { id: 'investigate', type: 'agent', label: 'Investigate', position: { x: 0, y: 0 }, config },
      scope: { input: {}, steps: {} },
      actor: { userId: 'owner', clientId: 'client-a' },
      state,
      checkpoint: async (value) => {
        checkpoints.push(JSON.parse(JSON.stringify(value)));
      },
      event: async (type) => {
        events.push(type);
      },
    };
    return { request: built, checkpoints, events };
  }

  const specs = [
    { name: 'get_entity', description: 'Read a record', inputSchema: { type: 'object', properties: {} } },
    { name: 'submit_manual_override', description: 'Set a value', inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_compliance_rule', description: 'Delete a rule', inputSchema: { type: 'object', properties: {} } },
  ];

  it('runs as a named agent: its charter, its tools, and its domains', async () => {
    const ran: string[] = [];
    const systems: string[] = [];
    const offered: string[][] = [];
    const tools = { names: () => new Set(specs.map((spec) => spec.name)), specs: () => specs, run: async (name: string) => (ran.push(name), { ok: true }) };
    const model = scripted([
      {
        stop: 'tools',
        calls: [
          { id: '1', name: 'get_entity', input: { entityId: 'e7' } },
          {
            id: '2',
            name: 'propose_changes',
            input: {
              changes: [
                { action: 'UPDATE', target: { kind: 'Fund', label: 'F1', domainCode: 'FUND' }, summary: 'Set fund value', tool: 'submit_manual_override', args: { entityId: 'f1' }, confidence: 'HIGH', rationale: 'r' },
                { action: 'UPDATE', target: { kind: 'Issuer', label: 'I1', domainCode: 'ISSUER' }, summary: 'Set issuer value', tool: 'submit_manual_override', args: { entityId: 'i1' }, confidence: 'HIGH', rationale: 'r' },
                { action: 'DELETE', target: { kind: 'Rule', label: 'R1' }, summary: 'Delete rule', tool: 'delete_compliance_rule', args: {}, confidence: 'HIGH', rationale: 'r' },
              ],
            },
          },
        ],
      },
      { stop: 'end', text: 'Proposed one change.' },
    ]);
    const turn = model.turn.bind(model);
    model.turn = async (system, toolSpecs, messages) => {
      systems.push(system);
      offered.push(toolSpecs.map((spec) => spec.name));
      return turn(system, toolSpecs, messages);
    };
    // The step ticks no tools and allows any change. The agent's own list decides.
    const { request: built } = request({ instructions: 'Work the break', agent: 'RECONCILER' });
    built.agent = {
      code: 'RECONCILER',
      name: 'Reconciler',
      description: 'Works breaks.',
      charter: 'Find the cause first.',
      activityCodes: ['RECONCILIATION'],
      domainCodes: ['FUND'],
      toolNames: ['get_entity', 'submit_manual_override'],
      isActive: true,
      shared: true,
    };
    const result = await runAgentStep(built, { tools, model: () => model });

    expect(systems[0]).toContain('You are Reconciler. Works breaks.');
    expect(systems[0]).toContain('Find the cause first.');
    expect(offered[0]).toEqual(['get_entity', 'propose_changes']);
    expect(ran).toEqual(['get_entity']);
    // The issuer change is outside its domains, and deleting a rule is not one of its tools.
    expect(result.items.map((item) => item.summary)).toEqual(['Set fund value']);
    const results = (model.seen[1][2] as { results: Array<{ name: string; content: string }> }).results;
    expect(results[1].content).toMatch(/Reconciler works on FUND only/);
    expect(results[1].content).toMatch(/delete_compliance_rule, which this step cannot propose/);
  });

  it('reads with its tools, cannot write, and only proposes what the step allows', async () => {
    const ran: string[] = [];
    const tools = { names: () => new Set(specs.map((spec) => spec.name)), specs: () => specs, run: async (name: string) => (ran.push(name), { ok: true }) };
    const model = scripted([
      {
        stop: 'tools',
        calls: [
          { id: '1', name: 'get_entity', input: { entityId: 'e7' } },
          { id: '2', name: 'submit_manual_override', input: { entityId: 'e7', value: 'x' } },
          {
            id: '3',
            name: 'propose_changes',
            input: {
              changes: [
                { action: 'UPDATE', target: { kind: 'Loan', label: 'LOAN-7' }, summary: 'Set value', tool: 'submit_manual_override', args: { entityId: 'e7' }, confidence: 'HIGH', rationale: 'r' },
                { action: 'DELETE', target: { kind: 'Rule', label: 'R1' }, summary: 'Delete rule', tool: 'delete_compliance_rule', args: {}, confidence: 'HIGH', rationale: 'r' },
              ],
            },
          },
        ],
      },
      { stop: 'end', text: 'Proposed one change.' },
    ]);
    const { request: built, checkpoints } = request({ instructions: 'Fix it', tools: ['get_entity', 'submit_manual_override'], proposable: ['submit_manual_override'] });
    const result = await runAgentStep(built, { tools, model: () => model });

    // The write tool was on the step's list, but an agent is never given it.
    expect(ran).toEqual(['get_entity']);
    expect(result.summary).toBe('Proposed one change.');
    expect(result.items.map((item) => item.tool)).toEqual(['submit_manual_override']);
    expect(checkpoints).toHaveLength(1);
    const results = (model.seen[1][2] as { results: Array<{ name: string; isError: boolean; content: string }> }).results;
    expect(results[1]).toMatchObject({ name: 'submit_manual_override', isError: true });
    expect(results[2].content).toMatch(/Recorded 1 change.*delete_compliance_rule, which this step cannot propose/);
  });

  it('continues from its checkpoint after a restart', async () => {
    const tools = { names: () => new Set<string>(), specs: () => specs, run: async () => ({}) };
    const model = scripted([{ stop: 'end', text: 'Done.' }]);
    const saved = { provider: 'test', messages: [{ role: 'user', text: 'task' }, { role: 'assistant', index: 1 }, { role: 'results', results: [] }], items: proposed(), rounds: 1 };
    const { request: built, events } = request({ instructions: 'Fix it', tools: [] }, saved);
    const result = await runAgentStep(built, { tools, model: () => model });
    expect(model.seen[0]).toHaveLength(3);
    expect(result.items).toHaveLength(2);
    expect(events).toContain('agent.resumed');
  });
});

describe('workflowTools', () => {
  /** The service client, answering the two lookups the tool runner makes. */
  function service(answers: { person?: Record<string, unknown>; account?: Record<string, unknown> }) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      async rpc(fn: string, args: Record<string, unknown>) {
        calls.push([fn, args]);
        if (fn === 'workflow_worker_person') return { data: answers.person ?? { name: 'Ada Reviewer' }, error: null };
        if (fn === 'workflow_worker_service_account') return { data: answers.account ?? { userId: 'svc-1' }, error: null };
        return { data: null, error: null };
      },
    };
    return { client: client as never, calls };
  }

  function registry(ran: Array<Record<string, unknown>>) {
    const tools = [
      { name: 'get_entity', description: 'Read', inputSchema: { type: 'object', properties: { entityId: {} } } },
      { name: 'submit_manual_override', description: 'Set', inputSchema: { type: 'object', properties: { value: {}, overrideReason: {} } } },
    ];
    return {
      listTools: () => tools,
      executeTool: async (_name: string, args: Record<string, unknown>) => (ran.push(args), { ok: true }),
    } as never;
  }

  const env = { url: 'https://project.example', anonKey: 'anon' };
  const actor = { userId: 'reviewer', clientId: 'client-a' };
  const hour = () => ({ token: 't', expiresAt: Date.now() + 3_600_000 });

  it('runs as the service account, checks the person, and signs an approved change', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const { client, calls } = service({});
    const sessions: string[] = [];
    const tools = workflowTools(client, env, registry(ran), async (userId) => (sessions.push(userId), hour()));

    await tools.run('get_entity', { entityId: 'e7' }, actor, 'read');
    await tools.run('submit_manual_override', { value: '5', overrideReason: 'Missing' }, actor, 'apply', 'run-9');
    await tools.run('submit_manual_override', { value: '6' }, actor, 'write');

    // One session for the client's account, reused across calls. Never one for the person.
    expect(sessions).toEqual(['svc-1']);
    expect(calls.filter(([fn]) => fn === 'workflow_worker_person').map(([, args]) => args.p_permissions)).toEqual([
      ['workflow.run'],
      ['workflow.review', 'entity.write'],
      ['workflow.run', 'entity.write'],
    ]);
    expect(ran).toEqual([{ entityId: 'e7' }, { value: '5', overrideReason: 'Missing Approved by Ada Reviewer in workflow run run-9.' }, { value: '6' }]);
  });

  it('refuses before anything runs when the person or the account is not allowed', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const noPerson = workflowTools(service({ person: { problem: 'The person behind this step does not hold entity.write for this client.' } }).client, env, registry(ran), async () => hour());
    await expect(noPerson.run('submit_manual_override', {}, actor, 'apply')).rejects.toThrow(/does not hold entity\.write/);

    const noAccount = workflowTools(service({ account: { problem: 'This client has no workflow service account.' } }).client, env, registry(ran), async () => hour());
    await expect(noAccount.run('get_entity', {}, actor, 'read')).rejects.toThrow(/no workflow service account/);
    expect(ran).toEqual([]);
  });

  it('starts a new session when the last one is about to expire', async () => {
    let started = 0;
    const tools = workflowTools(service({}).client, env, registry([]), async () => ((started += 1), { token: 't', expiresAt: Date.now() + 60_000 }));
    await tools.run('get_entity', {}, actor, 'read');
    await tools.run('get_entity', {}, actor, 'read');
    expect(started).toBe(2);
  });

  it('leaves a tool with no reason field as it was', () => {
    const spec = { name: 'create_entity', description: '', inputSchema: { type: 'object', properties: { entityCode: {} } } };
    expect(signReason(spec, { entityCode: 'X' }, 'Approved by Ada.')).toEqual({ entityCode: 'X' });
  });
});

describe('message', () => {
  it('reads a database error, which is an object and not an Error', () => {
    expect(message({ message: 'Could not find a relationship', details: 'Searched public', hint: null })).toBe('Could not find a relationship Searched public');
    expect(message(new Error('boom'))).toBe('boom');
    expect(message({})).toBe('The step failed');
  });
});

describe('checkListValues', () => {
  const sectors = [
    { code: 'CONSUMER_STAPLES', label: 'Consumer Staples', synonyms: [] },
    { code: 'HEALTH_CARE', label: 'Health Care', synonyms: ['Healthcare'] },
  ];
  const lists = async (code: string) => (code === 'SECTOR' ? sectors : null);
  const change = (extra: Record<string, unknown>) =>
    normalizeItems([{ action: 'UPDATE', target: { kind: 'Issuer', label: 'Obligor 41' }, summary: 'Set sector', tool: 'submit_manual_override', confidence: 'MEDIUM', rationale: 'r', args: { entityId: 'e41', attributeCode: 'SECTOR' }, ...extra }])[0];

  it('stores a label or synonym as the code, in the value and in a suggestion', async () => {
    const value = await checkListValues(change({ args: { entityId: 'e41', attributeCode: 'SECTOR', value: 'Healthcare' } }), [], lists);
    expect('item' in value && value.item.args.value).toBe('HEALTH_CARE');
    expect('item' in value && value.notes[0]).toMatch(/stored as its list code HEALTH_CARE/);

    const suggestion = await checkListValues(change({ missing: [{ key: 'value', label: 'Sector', question: 'Which?', suggested: 'consumer staples' }] }), [], lists);
    expect('item' in suggestion && suggestion.item.missing[0].suggested).toBe('CONSUMER_STAPLES');
  });

  it('sends back a value that is not on the list, with the list', async () => {
    const result = await checkListValues(change({ missing: [{ key: 'value', label: 'Sector', question: 'Which?', suggested: 'Consumer Goods' }] }), [], lists);
    expect('refusal' in result && result.refusal).toMatch(/"Consumer Goods" is not a value SECTOR accepts\. It accepts: CONSUMER_STAPLES \(Consumer Staples\), HEALTH_CARE \(Health Care\)/);
    // An attribute with no list takes anything.
    const free = await checkListValues(change({ args: { entityId: 'e41', attributeCode: 'LEI', value: 'anything' } }), [], lists);
    expect('item' in free).toBe(true);
  });

  it('lets a new value stand when a linked change adds it, and refuses to add one that exists', async () => {
    const [add, set] = normalizeItems([
      { id: 'add', action: 'CREATE', target: { kind: 'List value', label: 'Energy' }, summary: 'Add Energy', tool: 'add_attribute_list_value', args: { attributeCode: 'SECTOR', valueCode: 'ENERGY', valueLabel: 'Energy' }, confidence: 'HIGH', rationale: 'r' },
      { id: 'set', dependsOn: ['add'], action: 'UPDATE', target: { kind: 'Issuer', label: 'Obligor 41' }, summary: 'Set sector', tool: 'submit_manual_override', args: { entityId: 'e41', attributeCode: 'SECTOR', value: 'ENERGY' }, confidence: 'MEDIUM', rationale: 'r' },
    ]);
    expect('item' in (await checkListValues(add, [add, set], lists))).toBe(true);
    expect('item' in (await checkListValues(set, [add, set], lists))).toBe(true);
    // Without the link, the same value is off the list.
    expect('refusal' in (await checkListValues({ ...set, dependsOn: [] }, [add, set], lists))).toBe(true);

    const duplicate = normalizeItems([{ action: 'CREATE', target: { kind: 'List value', label: 'Healthcare' }, summary: 'Add Healthcare', tool: 'add_attribute_list_value', args: { attributeCode: 'SECTOR', valueCode: 'HEALTHCARE', valueLabel: 'Healthcare' }, confidence: 'HIGH', rationale: 'r' }])[0];
    const refused = await checkListValues(duplicate, [duplicate], lists);
    expect('refusal' in refused && refused.refusal).toMatch(/already has this value, as HEALTH_CARE/);
  });
});

describe('linked changes when applying', () => {
  it('adds the list value first, and does not set it when the addition fails', async () => {
    const memory = memoryStore(CLEANUP);
    const order: string[] = [];
    const { deps: engine } = deps(memory.store, {
      agent: async () => ({
        summary: 'Two linked changes.',
        items: normalizeItems([
          { id: 'set', dependsOn: ['add'], action: 'UPDATE', target: { kind: 'Issuer', label: 'Obligor 41' }, summary: 'Set sector', tool: 'submit_manual_override', args: { entityId: 'e41', attributeCode: 'SECTOR', value: 'ENERGY' }, confidence: 'MEDIUM', rationale: 'r' },
          { id: 'add', action: 'CREATE', target: { kind: 'List value', label: 'Energy' }, summary: 'Add Energy', tool: 'add_attribute_list_value', args: { attributeCode: 'SECTOR', valueCode: 'ENERGY', valueLabel: 'Energy' }, confidence: 'HIGH', rationale: 'r' },
        ]),
      }),
    });
    (engine.tools.names() as Set<string>).add('add_attribute_list_value');
    engine.tools.run = async (name) => {
      order.push(name);
      if (name === 'list_dq_exceptions') return { exceptions: [EXCEPTION], totalCount: 1 };
      if (name === 'add_attribute_list_value') throw new Error('Adding a value to a shared list needs a tenant admin to approve it.');
      return { success: true };
    };
    await advanceRun('run-1', 'job-1', engine);
    const review = memory.reviews[0];
    review.status = 'APPROVED';
    review.decidedBy = 'reviewer';
    review.decision = { items: { set: { decision: 'APPROVE' }, add: { decision: 'APPROVE' } } };
    await advanceRun('run-1', 'job-2', engine);

    // The addition was tried first, though it was proposed second. The dependent change was never attempted.
    expect(order.filter((name) => name !== 'find_records' && name !== 'list_dq_exceptions')).toEqual(['add_attribute_list_value']);
    const output = memory.steps.get('apply')?.output as { applied: number; failed: number; results: Array<{ id: string; error?: string }> };
    expect(output).toMatchObject({ applied: 0, failed: 2 });
    expect(output.results.find((row) => row.id === 'set')?.error).toMatch(/Not attempted, because "Add Energy" could not be applied first/);
  });
});

function graphOf(nodes: Array<[string, string, Record<string, unknown>?]>, edges: Array<[string, string, string?]>) {
  return {
    nodes: nodes.map(([id, type, config], index) => ({ id, type, label: id, position: { x: index * 100, y: 0 }, config: config || {} })),
    edges: edges.map(([from, to, when], index) => ({ id: `e${index}`, from, to, ...(when ? { when } : {}) })),
  };
}

function fakeOutbound() {
  const sent: Array<{ kind: string; to?: string[]; subject?: string; text: string }> = [];
  return {
    sent,
    outbound: {
      async http(call: { path: string }) {
        sent.push({ kind: 'http', text: call.path });
        return { status: 200, body: { ok: true } };
      },
      async email(to: string[], subject: string, text: string) {
        sent.push({ kind: 'email', to, subject, text });
      },
      async slack(_clientId: string, text: string) {
        sent.push({ kind: 'slack', text });
      },
      formLink: (token: string) => `https://app.example.com/portal/${token}`,
    },
  };
}

describe('paths, splits, forms, and messages', () => {
  it('goes on down one path while the other waits for a review, and joins once both are done', async () => {
    const graph = graphOf(
      [
        ['start', 'start'],
        ['split', 'parallel'],
        ['scan', 'tool', { tool: 'list_dq_exceptions', args: {} }],
        ['investigate', 'agent', { instructions: 'Look', tools: ['get_entity'] }],
        ['review', 'review', { source: 'investigate' }],
        ['join', 'join'],
        ['end', 'end'],
      ],
      [['start', 'split'], ['split', 'scan'], ['split', 'investigate'], ['investigate', 'review'], ['scan', 'join'], ['review', 'join'], ['join', 'end']],
    );
    const memory = memoryStore(graph);
    const { deps: engine, calls } = deps(memory.store);

    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'WAITING', waitingOn: 'review' });
    // The other path ran while the review waited, and the join did not.
    expect(calls.some((call) => call.name === 'list_dq_exceptions')).toBe(true);
    expect(memory.steps.get('scan')?.status).toBe('SUCCEEDED');
    expect(memory.steps.get('join')).toBeUndefined();

    const [review] = memory.reviews;
    review.status = 'REJECTED';
    review.decidedBy = 'reviewer';
    review.decision = { items: {} };
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(memory.steps.get('join')?.status).toBe('SUCCEEDED');
  });

  it('splits a run into one run per chosen record and ends it', async () => {
    const graph = graphOf([['start', 'start', { runPerRecord: true }], ['scan', 'tool', { tool: 'list_dq_exceptions', args: {} }], ['end', 'end']], [['start', 'scan'], ['scan', 'end']]);
    const memory = memoryStore(graph, { filters: { entityCodes: ['A', 'B'] }, periodEnd: '2026-09-30' });
    const { deps: engine, calls } = deps(memory.store, {
      tools: {
        names: () => new Set(['find_records', 'list_dq_exceptions']),
        async run(name, args, actor, permission) {
          calls.push({ name, args, actor, permission });
          return name === 'find_records' ? { filtered: true, entityIds: ['e-a', 'e-b'] } : {};
        },
      },
    });
    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(memory.spawned).toEqual([
      { periodEnd: '2026-09-30', filters: { entityIds: ['e-a'] } },
      { periodEnd: '2026-09-30', filters: { entityIds: ['e-b'] } },
    ]);
    // The rest of the parent run does not run; each child does it.
    expect(calls.filter((call) => call.name === 'list_dq_exceptions')).toHaveLength(0);
    expect(memory.events.find((event) => event.type === 'run.split')?.summary).toBe('Started 2 runs, one for each record');
  });

  it('runs a child as usual, and refuses to split a run with no records chosen', async () => {
    const graph = graphOf([['start', 'start', { runPerRecord: true }], ['end', 'end']], [['start', 'end']]);
    const child = memoryStore(graph, { parentRunId: 'run-0', filters: { entityIds: ['e-a'] } });
    expect(await advanceRun('run-1', 'job-1', deps(child.store).deps)).toMatchObject({ status: 'SUCCEEDED' });
    expect(child.spawned).toEqual([]);
    const none = memoryStore(graph, {});
    expect(await advanceRun('run-1', 'job-1', deps(none.store).deps)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('needs records chosen') });
  });

  it('emails an outside form its private link, waits, and goes on with the answers', async () => {
    const graph = graphOf(
      [
        ['start', 'start'],
        ['ask', 'form', { title: 'NAV confirmation', external: true, externalEmail: '{{input.admin}}', fields: [{ key: 'nav', label: 'NAV', type: 'number', required: true }] }],
        ['end', 'end'],
      ],
      [['start', 'ask'], ['ask', 'end']],
    );
    const memory = memoryStore(graph, { admin: 'ops@admin.example' });
    const { outbound, sent } = fakeOutbound();
    const { deps: engine } = deps(memory.store, { outbound });

    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'WAITING', waitingOn: 'ask' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'email', to: ['ops@admin.example'], subject: 'NAV confirmation' });
    expect(sent[0].text).toContain(`https://app.example.com/portal/${'a'.repeat(48)}`);

    // Waiting again sends nothing more.
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'WAITING' });
    expect(sent).toHaveLength(1);

    Object.assign(memory.forms[0], { status: 'SUBMITTED', answers: { nav: 125000000 } });
    expect(await advanceRun('run-1', 'job-3', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(memory.steps.get('ask')?.output).toMatchObject({ outcome: 'submitted', answers: { nav: 125000000 } });
  });

  it('sends a message written from the run, and only when the author allowed it', async () => {
    const graph = (allowSend: boolean) =>
      graphOf(
        [
          ['start', 'start'],
          ['tell', 'message', { channel: 'email', to: '{{input.to}}', subject: 'Close for {{input.fund}}', body: 'The close for {{input.fund}} is done.', allowSend }],
          ['end', 'end'],
        ],
        [['start', 'tell'], ['tell', 'end']],
      );
    const memory = memoryStore(graph(true), { to: 'a@example.com, b@example.com', fund: 'HSCF2' });
    const { outbound, sent } = fakeOutbound();
    expect(await advanceRun('run-1', 'job-1', deps(memory.store, { outbound }).deps)).toMatchObject({ status: 'SUCCEEDED' });
    expect(sent).toEqual([{ kind: 'email', to: ['a@example.com', 'b@example.com'], subject: 'Close for HSCF2', text: 'The close for HSCF2 is done.' }]);

    const refused = memoryStore(graph(false), { to: 'a@example.com', fund: 'X' });
    expect(await advanceRun('run-1', 'job-1', deps(refused.store, { outbound }).deps)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('sends') });
  });
});

describe('stages', () => {
  const graph = graphOf(
    [
      ['start', 'start'],
      ['quality', 'stage', { screen: 'load.quality', title: 'Check the values', args: { batchId: '{{input.batchId}}' } }],
      ['promote', 'tool', { tool: 'promote_load_batch', args: { batchId: '{{input.batchId}}', overrideReason: '{{steps.quality.result.overrideReason}}' }, allowWrite: true }],
      ['discard', 'tool', { tool: 'discard_load_batch', args: { batchId: '{{input.batchId}}' }, allowWrite: true }],
      ['end', 'end'],
    ],
    [['start', 'quality'], ['quality', 'promote', 'approved'], ['quality', 'discard', 'discarded'], ['promote', 'end'], ['discard', 'end']],
  );

  function stageDeps(store: WorkflowStore, batch: () => Record<string, unknown>) {
    const calls: Array<{ name: string; args: Record<string, unknown>; permission: string }> = [];
    const built = deps(store, {
      tools: {
        names: () => new Set(['get_load_batch', 'promote_load_batch', 'discard_load_batch']),
        async run(name, args, _actor, permission) {
          calls.push({ name, args, permission });
          return name === 'get_load_batch' ? batch() : { ok: true };
        },
      },
    });
    return { engine: built.deps, calls };
  }

  it('opens the screen with what the run gives it, and waits', async () => {
    const memory = memoryStore(graph, { batchId: 'batch-1' });
    const { engine, calls } = stageDeps(memory.store, () => ({ status: 'STAGED' }));
    expect(await advanceRun('run-1', 'job-1', engine)).toMatchObject({ status: 'WAITING', waitingOn: 'quality' });
    expect(memory.stages[0].spec).toMatchObject({
      screen: 'load.quality',
      title: 'Check the values',
      args: { batchId: 'batch-1' },
      outcomes: ['approved', 'discarded'],
      permissions: { approved: 'load.promote' },
    });
    // Nothing is read or written while the person is at the screen.
    expect(calls).toEqual([]);
  });

  it('goes down the path of the outcome the person chose', async () => {
    const memory = memoryStore(graph, { batchId: 'batch-1' });
    const { engine, calls } = stageDeps(memory.store, () => ({ status: 'STAGED', quality: { summary: { blocking: 0 } } }));
    await advanceRun('run-1', 'job-1', engine);
    Object.assign(memory.stages[0], { status: 'DONE', outcome: 'approved', result: {}, completedBy: 'reviewer' });
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls.map((call) => `${call.name}:${call.permission}`)).toEqual(['get_load_batch:read', 'promote_load_batch:write']);
    expect(memory.steps.get('quality')?.output).toMatchObject({ outcome: 'approved', completedBy: 'reviewer' });
    expect(memory.steps.get('discard')).toBeUndefined();
  });

  it('hands the stage back when what it was left with does not hold up', async () => {
    const memory = memoryStore(graph, { batchId: 'batch-1' });
    const { engine, calls } = stageDeps(memory.store, () => ({ status: 'STAGED', quality: { summary: { blocking: 2 } } }));
    await advanceRun('run-1', 'job-1', engine);
    Object.assign(memory.stages[0], { status: 'DONE', outcome: 'approved', result: {} });
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'WAITING', waitingOn: 'quality' });
    expect(memory.stages[0].returned).toEqual([expect.stringContaining('2 critical checks fail')]);
    expect(calls.some((call) => call.name === 'promote_load_batch')).toBe(false);

    // With a reason, the same batch is accepted, and the reason reaches the step that promotes.
    Object.assign(memory.stages[0], { status: 'DONE', outcome: 'approved', result: { overrideReason: 'Confirmed with the administrator' } });
    expect(await advanceRun('run-1', 'job-3', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls.find((call) => call.name === 'promote_load_batch')?.args).toMatchObject({ batchId: 'batch-1', overrideReason: 'Confirmed with the administrator' });
  });

  it('does not check an outcome the screen accepts as it is', async () => {
    const memory = memoryStore(graph, { batchId: 'batch-1' });
    const { engine, calls } = stageDeps(memory.store, () => ({ status: 'STAGED', quality: { summary: { blocking: 2 } } }));
    await advanceRun('run-1', 'job-1', engine);
    Object.assign(memory.stages[0], { status: 'DONE', outcome: 'discarded', result: {} });
    expect(await advanceRun('run-1', 'job-2', engine)).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls.map((call) => call.name)).toEqual(['discard_load_batch']);
  });

  it('refuses a stage whose screen does not exist', async () => {
    const bad = graphOf([['start', 'start'], ['x', 'stage', { screen: 'no.such', args: {} }], ['end', 'end']], [['start', 'x'], ['x', 'end']]);
    const memory = memoryStore(bad);
    expect(await advanceRun('run-1', 'job-1', deps(memory.store).deps)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('Choose the screen') });
  });
});
