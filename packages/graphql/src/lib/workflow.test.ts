import { describe, expect, it } from 'vitest';
import { asGraph, evaluateCondition, isReadTool, nextNode, resolveTemplates, validateGraph, type WorkflowGraph } from './workflow-graph';
import { asDecision, checkDecision, finalArgs, inDependencyOrder, matchListValue, normalizeItems, proposalCounts, setPath, withFoundationGaps } from './workflow-proposal';
import { WORKFLOW_TEMPLATES } from './workflow-templates';

const cleanup = (): WorkflowGraph => JSON.parse(JSON.stringify(WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph));
const messages = (graph: WorkflowGraph, tools?: Set<string>) => validateGraph(graph, tools).map((problem) => problem.message);

describe('validateGraph', () => {
  it('accepts every template', () => {
    for (const template of WORKFLOW_TEMPLATES) expect(validateGraph(asGraph(template.graph))).toEqual([]);
  });

  it('rejects a loop, a dead end, and a step nothing leads to', () => {
    const loop = cleanup();
    loop.edges.push({ id: 'back', from: 'recount', to: 'scan' });
    expect(messages(loop)).toEqual(['The steps form a loop. A workflow runs each step once.']);

    const dead = cleanup();
    dead.edges = dead.edges.filter((edge) => edge.id !== 'e9');
    expect(messages(dead)).toContain('This step leads nowhere. Connect it to the next step or to End.');

    const orphan = cleanup();
    orphan.nodes.push({ id: 'x', type: 'end', label: 'Other end', position: { x: 0, y: 0 }, config: {} });
    expect(messages(orphan)).toContain('Nothing leads to this step.');
  });

  it('keeps writes behind a review', () => {
    const agentWrite = cleanup();
    (agentWrite.nodes.find((node) => node.id === 'investigate')!.config.tools as string[]).push('submit_manual_override');
    expect(messages(agentWrite).join(' ')).toMatch(/An agent reads and proposes/);

    const toolWrite = cleanup();
    toolWrite.nodes.find((node) => node.id === 'recount')!.config.tool = 'resolve_dq_exception';
    expect(messages(toolWrite).join(' ')).toMatch(/changes data\. Tick/);

    const early = cleanup();
    early.nodes.find((node) => node.id === 'apply')!.config.review = 'scan';
    expect(messages(early)).toContain('Changes can only be applied after the review step that approved them.');
  });

  it('needs a path for every outcome, and names a tool that does not exist', () => {
    const half = cleanup();
    half.edges = half.edges.filter((edge) => edge.id !== 'e7');
    expect(messages(half)).toContain('Nothing follows when the outcome is "rejected".');
    expect(messages(cleanup(), new Set(['get_dq_summary'])).join(' ')).toMatch(/There is no tool called "list_dq_exceptions"/);
  });
});

describe('paths and values', () => {
  it('follows the edge for the outcome before the edge for any outcome', () => {
    const graph = cleanup();
    expect(nextNode(graph, 'review', 'approved')?.id).toBe('apply');
    expect(nextNode(graph, 'review', 'rejected')?.id).toBe('end');
    expect(nextNode(graph, 'scan', null)?.id).toBe('any');
    expect(nextNode(graph, 'end', null)).toBeNull();
  });

  it('fills placeholders, keeps types, and drops settings with no value', () => {
    const scope = { input: { limit: 20, domainCode: '' }, steps: { scan: { totalCount: 3, exceptions: [{ id: 'a' }] } } };
    expect(resolveTemplates({ first: '{{input.limit}}', domainCode: '{{input.domainCode}}', severity: '{{input.severity}}', note: 'Found {{steps.scan.totalCount}}' }, scope)).toEqual({
      first: 20,
      note: 'Found 3',
    });
    expect(evaluateCondition({ path: 'steps.scan.exceptions', op: 'truthy' }, scope)).toBe(true);
    expect(evaluateCondition({ path: 'steps.scan.totalCount', op: 'gt', value: 5 }, scope)).toBe(false);
    expect(evaluateCondition({ path: 'steps.missing.value', op: 'empty' }, scope)).toBe(true);
  });

  it('knows which tools only read', () => {
    expect(['get_entity', 'list_dq_exceptions', 'query_data', 'search_attributes'].every(isReadTool)).toBe(true);
    expect(['create_entity', 'submit_manual_override', 'resolve_dq_exception', 'save_lesson', 'execute_import_map', 'run_load_session'].some(isReadTool)).toBe(false);
  });
});

describe('proposals', () => {
  const items = () =>
    normalizeItems([
      { action: 'CREATE', target: { kind: 'Loan', label: 'LOAN-9' }, summary: 'Create LOAN-9', tool: 'create_entity', args: { entityCode: 'LOAN-9', attributes: { CURRENCY: 'USD' } }, confidence: 'HIGH', rationale: 'r' },
      { target: { kind: 'Loan', label: 'LOAN-7' }, summary: 'Set coupon', tool: 'submit_manual_override', args: { entityId: 'e7' }, confidence: 'low', missing: [{ key: 'value', label: 'Coupon', question: 'What is it?' }] },
      { summary: 'No tool', args: {} },
    ]);

  it('drops what cannot run and marks what needs a person', () => {
    const [create, update] = items();
    expect(items()).toHaveLength(2);
    expect(create).toMatchObject({ id: 'c1', action: 'CREATE', needsReview: false });
    expect(update).toMatchObject({ id: 'c2', action: 'UPDATE', confidence: 'LOW', needsReview: true });
    expect(proposalCounts({ items: items() })).toMatchObject({ total: 2, confident: 1, needsReview: 1, creates: 1, updates: 1, questions: 1 });
  });

  it('turns a missing required attribute into a question', () => {
    const [create] = items();
    const checked = withFoundationGaps(create, [
      { code: 'CURRENCY', name: 'Currency', required: true },
      { code: 'MATURITY_DATE', name: 'Maturity date', required: true },
      { code: 'NOTES', name: 'Notes', required: false },
    ]);
    expect(checked.needsReview).toBe(true);
    expect(checked.missing.map((field) => field.key)).toEqual(['attributes.MATURITY_DATE']);
    expect(withFoundationGaps(create, [{ code: 'CURRENCY', name: 'Currency', required: true }])).toBe(create);
  });

  it('will not record an approval with a required answer missing', () => {
    const proposal = { items: items() };
    const open = checkDecision(proposal, asDecision({ items: { c1: { decision: 'APPROVE' }, c2: { decision: 'APPROVE' } } }));
    expect(open.ok).toBe(false);
    expect(open.problems).toEqual(['"Set coupon" still needs: Coupon.']);
    expect(checkDecision(proposal, asDecision({ items: { c1: { decision: 'APPROVE' } } })).problems).toEqual(['"Set coupon" has not been approved or rejected.']);

    const decision = asDecision({ items: { c1: { decision: 'REJECT' }, c2: { decision: 'APPROVE', answers: { value: '5.25' } } } });
    expect(checkDecision(proposal, decision)).toMatchObject({ ok: true, approved: ['c2'], rejected: ['c1'] });
    expect(finalArgs(proposal.items[1], decision.items.c2)).toEqual({ entityId: 'e7', value: '5.25' });
  });

  it('lets a reviewer change the value a change sets, but not what it is aimed at', () => {
    const [, update] = items();
    const edited = finalArgs(update, { decision: 'APPROVE', args: { entityId: 'someone-else', exceptionId: 'ex-9', overrideReason: 'Corrected by reviewer' }, answers: { value: '6' } });
    expect(edited).toEqual({ entityId: 'e7', overrideReason: 'Corrected by reviewer', value: '6' });
  });

  it('sets nested answers without touching the original or the prototype', () => {
    const args = { attributes: { CURRENCY: 'USD' } };
    expect(setPath(args, 'attributes.MATURITY_DATE', '2031-06-30')).toEqual({ attributes: { CURRENCY: 'USD', MATURITY_DATE: '2031-06-30' } });
    expect(args).toEqual({ attributes: { CURRENCY: 'USD' } });
    expect(setPath({}, '__proto__.polluted', true)).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('values that come from a list', () => {
  const sectors = [
    { code: 'CONSUMER_STAPLES', label: 'Consumer Staples', synonyms: [] },
    { code: 'HEALTH_CARE', label: 'Health Care', synonyms: ['Healthcare'] },
    { code: 'INFORMATION_TECHNOLOGY', label: 'Information Technology', synonyms: ['IT'] },
  ];

  it('reads a code, a label, or a synonym as the list value, and nothing looser', () => {
    expect(matchListValue(sectors, 'HEALTH_CARE')?.code).toBe('HEALTH_CARE');
    expect(matchListValue(sectors, 'health care')?.code).toBe('HEALTH_CARE');
    expect(matchListValue(sectors, 'Healthcare')?.code).toBe('HEALTH_CARE');
    expect(matchListValue(sectors, 'it')?.code).toBe('INFORMATION_TECHNOLOGY');
    // Close in meaning is a judgement for the agent, not a match.
    expect(matchListValue(sectors, 'Consumer Goods')).toBeNull();
    expect(matchListValue(sectors, '')).toBeNull();
  });

  const linked = () =>
    normalizeItems([
      { id: 'add', action: 'CREATE', target: { kind: 'List value', label: 'Consumer Discretionary' }, summary: 'Add Consumer Discretionary to the sector list', tool: 'add_attribute_list_value', args: { attributeCode: 'SECTOR', valueCode: 'CONSUMER_DISCRETIONARY', valueLabel: 'Consumer Discretionary' }, confidence: 'HIGH', rationale: 'r' },
      { id: 'set', dependsOn: ['add'], action: 'UPDATE', target: { kind: 'Issuer', label: 'Obligor 41' }, summary: 'Set sector on Obligor 41', tool: 'submit_manual_override', args: { entityId: 'e41', attributeCode: 'SECTOR', value: 'CONSUMER_DISCRETIONARY' }, confidence: 'MEDIUM', rationale: 'r' },
    ]);

  it('will not set a new list value unless the change that adds it is approved', () => {
    const items = linked();
    // A change to a shared list always gets a close look.
    expect(items[0].needsReview).toBe(true);
    expect(items[1].dependsOn).toEqual(['add']);
    const proposal = { items };

    const both = checkDecision(proposal, asDecision({ items: { add: { decision: 'APPROVE' }, set: { decision: 'APPROVE' } } }));
    expect(both).toMatchObject({ ok: true, approved: ['add', 'set'] });

    const orphan = checkDecision(proposal, asDecision({ items: { add: { decision: 'REJECT' }, set: { decision: 'APPROVE' } } }));
    expect(orphan.ok).toBe(false);
    expect(orphan.problems[0]).toMatch(/sets CONSUMER_DISCRETIONARY, which is not on the list yet\. Approve "Add Consumer Discretionary/);

    // The reviewer picked a value that is on the list, so the addition is not needed.
    const swapped = checkDecision(proposal, asDecision({ items: { add: { decision: 'REJECT' }, set: { decision: 'APPROVE', args: { value: 'CONSUMER_STAPLES' } } } }));
    expect(swapped).toMatchObject({ ok: true, approved: ['set'] });

    expect(inDependencyOrder([items[1], items[0]]).map((item) => item.id)).toEqual(['add', 'set']);
  });
});
