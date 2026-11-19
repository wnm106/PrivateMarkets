import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { registerDQRuleTools } from './dq-rule-tools';
import { registerWorkflowTools } from './workflow-tools';

type Call = { table?: string; rpc?: string; args?: any; insert?: any };

/** A stand-in database client that records what was written and answers from a script. */
function fake(script: { rpc?: Record<string, any>; tables?: Record<string, any> }) {
  const calls: Call[] = [];
  const client: any = {
    schema: () => client,
    rpc: async (name: string, args: any) => {
      calls.push({ rpc: name, args });
      const answer = script.rpc?.[name];
      return typeof answer === 'function' ? answer(args) : { data: answer ?? null, error: null };
    },
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: script.tables?.[table] ?? null, error: null }),
        single: async () => ({ data: script.tables?.[`${table}:inserted`] ?? script.tables?.[table] ?? null, error: null }),
        insert: (row: any) => { calls.push({ table, insert: row }); return builder; },
        then: (resolve: any) => resolve({ data: script.tables?.[table] ?? [], error: null }),
      };
      return builder;
    },
  };
  return { client, calls };
}

function registry() {
  const r = new ToolRegistry({} as any);
  registerDQRuleTools(r);
  registerWorkflowTools(r);
  return r;
}

describe('create_dq_rule', () => {
  it('refuses a rule type or severity the table does not accept, before writing anything', async () => {
    const { client, calls } = fake({});
    const base = { ruleCode: 'NEG_PRICE', ruleName: 'Negative price', domainCode: 'POSITION', ruleExpression: 'price < 0' };
    await expect(registry().executeTool('create_dq_rule', { ...base, ruleType: 'MAGIC', severity: 'HIGH' }, client)).rejects.toThrow(/ruleType/);
    await expect(registry().executeTool('create_dq_rule', { ...base, ruleType: 'VALIDITY', severity: 'URGENT' }, client)).rejects.toThrow(/severity/);
    expect(calls.filter((call) => call.insert)).toHaveLength(0);
  });

  it('stores the rule with the expression as given', async () => {
    const inserted = { id: 'r1', rule_code: 'NEG_PRICE', rule_name: 'Negative price', domain_code: 'POSITION', rule_type: 'VALIDITY', rule_severity: 'HIGH', rule_expression: 'price < 0', is_active: true };
    const { client, calls } = fake({ tables: { dq_rules: inserted } });
    const result = await registry().executeTool('create_dq_rule', { ruleCode: 'NEG_PRICE', ruleName: 'Negative price', domainCode: 'POSITION', ruleType: 'VALIDITY', severity: 'HIGH', ruleExpression: ' price < 0 ' }, client);
    expect(calls.find((call) => call.insert)?.insert).toMatchObject({ rule_code: 'NEG_PRICE', rule_expression: 'price < 0', rule_type: 'VALIDITY', rule_severity: 'HIGH' });
    expect((result as any).rule.failsWhen).toBe('price < 0');
  });
});

describe('preview_dq_rule', () => {
  it('reports an invalid expression instead of throwing', async () => {
    const { client } = fake({
      tables: { master_entities: [{ id: 'e1', entity_code: 'P1', entity_name: 'Position 1' }] },
      rpc: { failure_predicate_matches: () => ({ data: null, error: { message: 'column "prce" does not exist' } }) },
    });
    const result: any = await registry().executeTool('preview_dq_rule', { domainCode: 'POSITION', ruleExpression: 'prce < 0' }, client);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('warns when every sampled record fails, which usually means the expression is the wrong way round', async () => {
    const { client } = fake({
      tables: { master_entities: [{ id: 'e1', entity_code: 'P1', entity_name: 'One' }, { id: 'e2', entity_code: 'P2', entity_name: 'Two' }] },
      rpc: { failure_predicate_matches: true },
    });
    const result: any = await registry().executeTool('preview_dq_rule', { domainCode: 'POSITION', ruleExpression: 'price >= 0' }, client);
    expect(result).toMatchObject({ valid: true, sampled: 2, wouldFail: 2 });
    expect(result.note).toMatch(/wrong way round/);
  });
});

describe('start_workflow_run', () => {
  const published = { id: 'w1', workflow_name: 'Quarterly close', published_version: 3, graph: { nodes: [] } };

  it('will not start a workflow that is not published', async () => {
    const { client, calls } = fake({
      rpc: { current_client_ids: ['c1'], workflow_get: { ...published, published_version: null } },
    });
    await expect(registry().executeTool('start_workflow_run', { workflowId: 'w1' }, client)).rejects.toThrow(/not published/);
    expect(calls.some((call) => call.rpc === 'workflow_run_start')).toBe(false);
  });

  it('will not start without a client', async () => {
    const { client } = fake({ rpc: { current_client_ids: [] } });
    await expect(registry().executeTool('start_workflow_run', { workflowId: 'w1' }, client)).rejects.toThrow(/client/i);
  });

  it('starts a published workflow once and returns the run', async () => {
    const { client, calls } = fake({
      rpc: { current_client_ids: ['c1'], workflow_get: published, workflow_run_start: 'run-9', workflow_run_get: { status: 'QUEUED' } },
    });
    const result: any = await registry().executeTool('start_workflow_run', { workflowId: 'w1', input: {} }, client);
    expect(result).toMatchObject({ started: true, runId: 'run-9', status: 'QUEUED', version: 3 });
    expect(calls.filter((call) => call.rpc === 'workflow_run_start')).toHaveLength(1);
    expect(calls.find((call) => call.rpc === 'workflow_run_start')?.args).toMatchObject({ p_workflow_id: 'w1', p_client_id: 'c1' });
  });
});
