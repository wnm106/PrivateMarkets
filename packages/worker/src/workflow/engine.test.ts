import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { normalizeItems } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { runAgentStep, type AgentModel, type ModelTurn } from './agent';
import { RunBusyError, advanceRun, type Actor, type AgentRequest, type EngineDeps, type LoadedRun, type ReviewRow, type StepRow, type WorkflowStore } from './engine';
import { userToken } from './tools';

const CLEANUP = WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph;

/** A store held in memory. It keeps steps, reviews, and events the way the database would. */
function memoryStore(graph: unknown, input: Record<string, unknown> = {}) {
  const run = { id: 'run-1', clientId: 'client-a', status: 'QUEUED', input, context: {} as Record<string, unknown>, currentNode: null as string | null, startedBy: 'owner', lockedBy: null as string | null };
  const steps = new Map<string, StepRow>();
  const reviews: ReviewRow[] = [];
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
    async openReview(_runId, nodeId, _title, _instructions, _summary, proposal) {
      const review: ReviewRow = { id: `review-${nodeId}`, nodeId, status: 'OPEN', proposal, decision: null, decidedBy: null };
      reviews.push(review);
      return { ...review };
    },
  };
  return { store, run, steps, reviews, events };
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
  const names = new Set(['list_dq_exceptions', 'get_dq_summary', 'get_entity', 'list_entities', 'get_field_lineage', 'get_temporal_history', 'get_template_metadata', 'get_attribute_metadata', 'search_attributes', 'query_data', 'get_model_map', 'submit_manual_override', 'resolve_dq_exception', 'create_entity']);
  const built: EngineDeps = {
    store,
    tools: {
      names: () => names,
      async run(name, args, actor, permission) {
        calls.push({ name, args, actor, permission });
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
  it('runs to the review, waits, then applies what was approved as the reviewer', async () => {
    const memory = memoryStore(CLEANUP, { limit: 5 });
    const { deps: engine, calls } = deps(memory.store);

    const first = await advanceRun('run-1', 'job-1', engine);
    expect(first).toMatchObject({ status: 'WAITING', waitingOn: 'review' });
    expect(memory.run.status).toBe('WAITING');
    expect(memory.run.lockedBy).toBeNull();
    // The limit is passed as a number, and settings with no value are left out.
    expect(calls[0]).toMatchObject({ name: 'list_dq_exceptions', args: { status: 'OPEN', first: 5 }, actor: { userId: 'owner' }, permission: 'entity.read' });
    // Nothing was changed while waiting.
    expect(calls.filter((call) => call.permission === 'entity.write')).toEqual([]);

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
    const writes = calls.filter((call) => call.permission === 'entity.write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: 'submit_manual_override', actor: { userId: 'reviewer', clientId: 'client-a' }, args: { entityId: 'e7', value: '2031-06-30' } });
    expect(memory.steps.get('apply')?.output).toMatchObject({ applied: 1, failed: 0 });
    expect(memory.events.find((event) => event.type === 'change.applied')).toMatchObject({ actor: 'USER', actorId: 'reviewer' });
    // The scan ran once across all three passes.
    expect(calls.filter((call) => call.name === 'list_dq_exceptions')).toHaveLength(1);
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
    expect(calls.filter((call) => call.permission === 'entity.write')).toEqual([]);
  });

  it('skips the agent when the scan finds nothing', async () => {
    const memory = memoryStore(CLEANUP);
    const { deps: engine } = deps(memory.store);
    engine.tools.run = async () => ({ exceptions: [], totalCount: 0 });
    expect((await advanceRun('run-1', 'job-1', engine)).status).toBe('SUCCEEDED');
    expect([...memory.steps.keys()]).toEqual(['start', 'scan', 'any', 'end']);
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
    expect(calls.filter((call) => call.name === 'list_dq_exceptions')).toHaveLength(1);
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

describe('userToken', () => {
  it('signs a short-lived token for one person', () => {
    const token = userToken('user-1', 'secret', Date.parse('2026-11-16T00:00:00Z'));
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ sub: 'user-1', role: 'authenticated', aud: 'authenticated' });
    expect(claims.exp - claims.iat).toBe(900);
    expect(userToken('user-1', 'other', Date.parse('2026-11-16T00:00:00Z'))).not.toBe(token);
  });
});
