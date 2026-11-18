import { describe, expect, it } from 'vitest';
import { asGraph, evaluateCondition, isReadTool, nextNode, resolveTemplates, reviewRouting, validateGraph, type WorkflowGraph } from './workflow-graph';
import { asDecision, checkDecision, finalArgs, inDependencyOrder, matchListValue, normalizeItems, proposalCounts, setPath, withFoundationGaps } from './workflow-proposal';
import { DEMO_WORKFLOWS, WORKFLOW_TEMPLATES } from './workflow-templates';

const cleanup = (): WorkflowGraph => JSON.parse(JSON.stringify(WORKFLOW_TEMPLATES.find((template) => template.code === 'DATA_CLEANUP')!.graph));
const messages = (graph: WorkflowGraph, tools?: Set<string>) => validateGraph(graph, tools).map((problem) => problem.message);

describe('validateGraph', () => {
  it('accepts every template', () => {
    for (const template of WORKFLOW_TEMPLATES) expect(validateGraph(asGraph(template.graph))).toEqual([]);
  });

  it('keeps the demo briefs to a report', () => {
    expect(DEMO_WORKFLOWS.map((template) => template.code)).toEqual([
      'DEMO_MORNING_QUALITY',
      'DEMO_HSCF2_CONCENTRATION',
      'DEMO_BRIGHTWATER_CLOSE',
      'DEMO_HARBOR_NAV',
      'DEMO_CLO_COVERAGE',
      'DEMO_HSCF2_CASH',
    ]);
    for (const template of DEMO_WORKFLOWS) {
      const agents = template.graph.nodes.filter((node) => node.type === 'agent');
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) {
        expect(agent.config.proposable).toEqual(['report-only']);
        expect(agent.config.provider).toBe('gemini');
      }
      expect(template.graph.nodes.some((node) => node.type === 'apply')).toBe(false);
    }
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
    expect(nextNode(graph, 'start', null)?.id).toBe('select');
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

describe('reviewRouting', () => {
  it('fills placeholders, splits lists, and keeps the starter apart unless the step says otherwise', () => {
    const scope = { input: { reviewer: 'u-2, u-3', hours: '48' }, steps: {} };
    expect(
      reviewRouting({ people: ['u-1', '{{input.reviewer}}', 'u-1'], roles: ['ops_lead', ''], dueInHours: '{{input.hours}}', escalateRoles: ['head_of_ops'] }, scope),
    ).toEqual({
      people: ['u-1', 'u-2', 'u-3'],
      roles: ['OPS_LEAD'],
      separateReviewer: true,
      dueInHours: 48,
      escalateRoles: ['HEAD_OF_OPS'],
      approvals: 1,
      reassignWhenOverdue: false,
      routeToOwners: true,
      activity: null,
    });
    expect(reviewRouting({ separateReviewer: false, dueInHours: 0, approvals: '2', reassignWhenOverdue: true, routeToOwners: false, activity: 'reconciliation' })).toEqual({
      people: [],
      roles: [],
      separateReviewer: false,
      dueInHours: null,
      escalateRoles: [],
      approvals: 2,
      reassignWhenOverdue: true,
      routeToOwners: false,
      activity: 'RECONCILIATION',
    });
    expect(reviewRouting({ approvals: 9 }).approvals).toBe(5);
  });

  it('refuses a time to review that is not a positive number of hours', () => {
    const graph = cleanup();
    const review = graph.nodes.find((node) => node.type === 'review')!;
    const problemsWith = (dueInHours: unknown) => {
      review.config = { ...review.config, dueInHours };
      return validateGraph(graph).filter((problem) => problem.nodeId === review.id).map((problem) => problem.message);
    };
    expect(problemsWith(-2)).toEqual(['The time to review must be a number of hours above zero, or left blank.']);
    expect(problemsWith('soon')).toHaveLength(1);
    expect(problemsWith(24)).toEqual([]);
    expect(problemsWith('{{input.hours}}')).toEqual([]);
    expect(problemsWith(null)).toEqual([]);
  });

  it('holds approvals to 1 through 5, and overdue hand-over to a due date and a role', () => {
    const graph = cleanup();
    const review = graph.nodes.find((node) => node.type === 'review')!;
    const problemsWith = (patch: Record<string, unknown>) => {
      review.config = { ...review.config, dueInHours: null, escalateRoles: [], reassignWhenOverdue: false, approvals: 1, ...patch };
      return validateGraph(graph).filter((problem) => problem.nodeId === review.id).map((problem) => problem.message);
    };
    expect(problemsWith({ approvals: 2 })).toEqual([]);
    expect(problemsWith({ approvals: 6 })).toEqual(['Approvals needed must be a whole number from 1 to 5.']);
    expect(problemsWith({ approvals: 1.5 })).toHaveLength(1);
    expect(problemsWith({ reassignWhenOverdue: true })).toHaveLength(1);
    expect(problemsWith({ reassignWhenOverdue: true, dueInHours: 24, escalateRoles: ['HEAD_OF_OPS'] })).toEqual([]);
  });
});

describe('splits, joins, forms, and outbound steps', () => {
  const build = (nodes: Array<[string, string, Record<string, unknown>?]>, edges: Array<[string, string, string?]>): WorkflowGraph => ({
    nodes: nodes.map(([id, type, config]) => ({ id, type: type as never, label: id, position: { x: 0, y: 0 }, config: config || {} })),
    edges: edges.map(([from, to, when], index) => ({ id: `e${index}`, from, to, ...(when ? { when } : {}) })),
  });

  it('lets a Split start several paths and a Join bring them back', () => {
    const graph = build(
      [['start', 'start'], ['split', 'parallel'], ['a', 'end'], ['b', 'end']],
      [['start', 'split'], ['split', 'a'], ['split', 'b']],
    );
    expect(messages(graph)).toEqual([]);
    expect(messages(build([['start', 'start'], ['split', 'parallel'], ['end', 'end']], [['start', 'split'], ['split', 'end']]))).toContain('A Split starts two or more paths. Connect it to each.');
    expect(messages(build([['start', 'start'], ['join', 'join'], ['end', 'end']], [['start', 'join'], ['join', 'end']]))).toContain('A Join brings two or more paths together. Connect each path into it.');
    expect(messages(build([['start', 'start'], ['t', 'tool', { tool: 'get_entity' }], ['a', 'end'], ['b', 'end']], [['start', 't'], ['t', 'a'], ['t', 'b']]))[0]).toMatch(/or a Split to take several/);
  });

  it('holds outbound steps to an explicit allow, and forms to usable fields', () => {
    const one = (type: string, config: Record<string, unknown>) => messages(build([['start', 'start'], ['x', type, config], ['end', 'end']], [['start', 'x'], ['x', 'end']]));
    expect(one('http', { connection: 'ADMIN', method: 'POST' })).toEqual(['This step sends data outside the platform. Tick "This step sends data outside" to allow it.']);
    expect(one('http', { connection: 'ADMIN', method: 'GET' })).toEqual([]);
    expect(one('message', { channel: 'email', to: '', body: 'x', allowSend: true })).toEqual(['Say who the email goes to.']);
    expect(one('message', { channel: 'slack', body: 'Done', allowSend: true })).toEqual([]);
    expect(one('form', { fields: [] })).toEqual(['Add at least one field to the form.']);
    expect(one('form', { fields: [{ key: 'nav', type: 'number' }, { key: 'nav' }, { key: 'pick', type: 'choice' }] })).toEqual([
      'Two fields share the key "nav".',
      '"pick" is a choice with nothing to choose from.',
    ]);
    expect(one('form', { fields: [{ key: 'nav' }], external: true })).toEqual(['Say who outside the firm the form goes to.']);
  });
});
