import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkflowGraph } from '@tapestrai/graphql/src/lib/workflow-graph';
import { keyWords, mappingView, resultView, stepDetail, valueWords, type DetailEventInput } from './workflow-step-detail';
import type { StoryStepInput } from './workflow-story';

const GRAPH: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    { id: 'onFile', type: 'tool', label: 'Financials on file', config: { tool: 'get_borrower_financials', args: { borrowerId: '{{input.borrowerId}}', periodEnd: '{{input.periodEnd}}', quarters: 8 } } },
    { id: 'any', type: 'branch', label: 'Anything on file?', config: { path: 'steps.onFile.counts.quarters', op: 'gt', value: 0 } },
    { id: 'package', type: 'agent', label: 'Read the package', config: { tools: ['get_position_file_text', 'find_records'], proposable: ['load_position_file_table', 'report-only'] } },
    { id: 'reviewLoad', type: 'review', label: 'Approve the load', config: { source: 'package' } },
    { id: 'load', type: 'apply', label: 'Load the figures', config: { review: 'reviewLoad' } },
    { id: 'recalculate', type: 'tool', label: 'Recalculate covenants', config: { tool: 'recalculate_borrower_covenants', args: { borrowerId: '{{steps.onFile.borrower.id}}' }, allowWrite: true } },
    { id: 'end', type: 'end', label: 'End', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'onFile' },
    { id: 'e2', from: 'onFile', to: 'any' },
    { id: 'e3', from: 'any', to: 'package', outcome: 'true' },
    { id: 'e4', from: 'any', to: 'end', outcome: 'false' },
    { id: 'e5', from: 'package', to: 'reviewLoad' },
    { id: 'e6', from: 'reviewLoad', to: 'load', outcome: 'approved' },
    { id: 'e7', from: 'reviewLoad', to: 'end', outcome: 'rejected' },
    { id: 'e8', from: 'load', to: 'recalculate' },
    { id: 'e9', from: 'recalculate', to: 'end' },
  ],
} as WorkflowGraph;

const BORROWER = '11111111-2222-3333-4444-555555555555';

const done = (nodeId: string, output: unknown, extra: Partial<StoryStepInput> = {}): StoryStepInput => ({ nodeId, status: 'SUCCEEDED', outcome: null, output, attempts: 1, startedAt: '2026-11-23T10:00:00Z', finishedAt: '2026-11-23T10:00:03Z', ...extra });

const STEPS: StoryStepInput[] = [
  done('start', {}),
  done('onFile', {
    borrower: { id: BORROWER, name: 'Halyard Systems' },
    periodEnd: '2026-09-30',
    onFile: true,
    counts: { quarters: 8, covenants: 3 },
    quarters: Array.from({ length: 8 }, (_, index) => ({ label: `Q${(index % 4) + 1}`, periodEnd: `2025-0${(index % 4) + 1}-30`, revenue: 1000000 + index * 1500.5, audited: index < 4, notes: { by: 'x' } })),
    headline: 'Halyard Systems has 8 quarters on file.',
  }),
  done('any', { result: true }, { outcome: 'true' }),
  done('package', {
    summary: 'I read both files.\n\nThe statements cover Q3 2026.',
    counts: { total: 2, needsReview: 1 },
    proposal: {
      items: [
        { id: 'a', tool: 'load_position_file_table', summary: 'Load 28 statement lines for Q3 2026', confidence: 'HIGH', needsReview: false },
        { id: 'b', tool: 'record_borrower_covenant_value', summary: 'Record the certificate leverage of 4.1x', confidence: 'MEDIUM', needsReview: true },
      ],
    },
  }),
  { nodeId: 'reviewLoad', status: 'WAITING', outcome: null, output: null },
];

const EVENTS: DetailEventInput[] = [
  { nodeId: 'onFile', type: 'step.started', summary: 'Started "Financials on file"', actorType: 'SYSTEM', createdAt: '2026-11-23T10:00:00Z' },
  { nodeId: 'onFile', type: 'tool.called', summary: 'Ran get_borrower_financials', actorType: 'SYSTEM', createdAt: '2026-11-23T10:00:02Z', detail: { tool: 'get_borrower_financials', args: { borrowerId: BORROWER, periodEnd: '2026-09-30', quarters: 8 } } },
  { nodeId: 'onFile', type: 'step.finished', summary: 'Finished "Financials on file"', actorType: 'SYSTEM', createdAt: '2026-11-23T10:00:03Z' },
  { nodeId: 'package', type: 'agent.usage', summary: 'model: 10 in, 5 out', actorType: 'AGENT', detail: { model: 'model-a', costUsd: 0.021 } },
  { nodeId: 'package', type: 'agent.tool', summary: 'Read with get_position_file_text', actorType: 'AGENT', createdAt: '2026-11-23T10:01:00Z', detail: { tool: 'get_position_file_text', args: { instanceId: BORROWER, page: 2 }, ok: true } },
  { nodeId: 'package', type: 'agent.tool', summary: 'Tried find_records', actorType: 'AGENT', detail: { tool: 'find_records', args: { search: 'Halyard' }, ok: false, error: 'No such domain' } },
  { nodeId: 'package', type: 'agent.usage', summary: 'model: 20 in, 9 out', actorType: 'AGENT', detail: { model: 'model-a', costUsd: 0.034 } },
  { nodeId: 'package', type: 'agent.proposed', summary: 'The agent proposed 2 changes: 1 confident, 1 needing review', actorType: 'AGENT' },
];

const open = (nodeId: string, steps = STEPS, events = EVENTS) => stepDetail({ graph: GRAPH, status: 'WAITING', currentNode: 'reviewLoad', steps, events }, nodeId)!;

describe('a step of a run, opened up', () => {
  it('shows a fixed step what it was asked with, as it ran, and what came back', () => {
    const detail = open('onFile');
    assert.equal(detail.state, 'done');
    assert.equal(detail.tool, 'get_borrower_financials');
    assert.equal(detail.changesData, false);
    assert.match(detail.what, /only reads/);
    assert.equal(detail.askedAsDesigned, false);
    assert.deepEqual(detail.asked, [
      { label: 'Borrower id', value: BORROWER },
      { label: 'Period end', value: '2026-09-30' },
      { label: 'Quarters', value: '8' },
    ]);
    assert.equal(detail.seconds, 3);
    assert.equal(detail.history.length, 3);
    assert.equal(detail.history[1].by, 'system');
  });

  it('lays a result out as values, groups and tables, never as raw JSON', () => {
    const result = open('onFile').result!;
    assert.deepEqual(result.fields.find((field) => field.label === 'On file'), { label: 'On file', value: 'Yes' });
    assert.deepEqual(result.groups.find((group) => group.label === 'Counts')?.fields, [
      { label: 'Quarters', value: '8' },
      { label: 'Covenants', value: '3' },
    ]);
    const quarters = result.lists.find((list) => list.label === 'Quarters')!;
    assert.equal(quarters.count, 8);
    assert.equal(quarters.rows.length, 8);
    assert.equal(quarters.more, 0);
    assert.deepEqual(quarters.columns, ['Label', 'Period end', 'Revenue', 'Audited', 'Notes']);
    assert.deepEqual(quarters.rows[1], ['Q2', '2025-02-30', '1,001,500.5', 'Yes', 'x']);
    for (const list of result.lists) for (const row of list.rows) for (const cell of row) assert.ok(!cell.includes('{'), cell);
  });

  it('leaves record ids out, and leads a table with what names its rows', () => {
    assert.deepEqual(open('onFile').result!.groups.find((group) => group.label === 'Borrower')?.fields, [{ label: 'Name', value: 'Halyard Systems' }]);
    // A stored result comes back with its keys in alphabetical order.
    const view = resultView({ entries: [{ action: 'Ask for the bridge', id: 'cert:1', ownerId: BORROWER, title: 'Net leverage differs', who: { id: BORROWER, name: 'Credit analyst' } }] })!;
    assert.deepEqual(view.lists[0].columns, ['Title', 'Action', 'Who']);
    assert.deepEqual(view.lists[0].rows[0], ['Net leverage differs', 'Ask for the bridge', 'Credit analyst']);
  });

  it('counts the rows a long list does not show', () => {
    const view = resultView({ rows: Array.from({ length: 30 }, (_, index) => ({ line: `Line ${index}`, amount: index })) })!;
    assert.equal(view.lists[0].rows.length, 8);
    assert.equal(view.lists[0].more, 22);
  });

  it('puts a condition into words', () => {
    const detail = open('any');
    assert.equal(detail.asked[0].value, 'Whether what “Financials on file” returned as counts › quarters is more than 0');
    assert.equal(detail.outcome, 'true');
    assert.equal(detail.result, null);
  });

  it('shows what an agent read, what it proposed and what it cost', () => {
    const detail = open('package');
    assert.equal(detail.kind, 'agent');
    assert.deepEqual(detail.asked[1], { label: 'May propose', value: 'load position file table' });
    assert.equal(detail.reads.length, 2);
    assert.equal(detail.reads[0].about, 'instance by id, page 2');
    assert.equal(detail.reads[1].ok, false);
    assert.equal(detail.proposals.length, 2);
    assert.equal(detail.proposals[1].needsReview, true);
    assert.match(detail.summary || '', /^I read both files/);
    assert.deepEqual(detail.usage, { calls: 2, model: 'model-a', costUsd: 0.06 });
    // The model calls are counted, not listed in the step's history.
    assert.ok(detail.history.every((event) => !event.summary.startsWith('model:')));
  });

  it('says what a step that has not run will be asked, with placeholders in words', () => {
    const detail = open('recalculate');
    assert.equal(detail.state, 'ahead');
    assert.equal(detail.askedAsDesigned, true);
    assert.equal(detail.changesData, true);
    assert.match(detail.what, /may change data/);
    assert.deepEqual(detail.asked, [{ label: 'Borrower id', value: 'what “Financials on file” returned as borrower › id' }]);
    assert.equal(detail.result, null);
    assert.equal(detail.attempts, 0);
  });

  it('lists what an apply step made of each approved change', () => {
    const steps = [
      ...STEPS.slice(0, 4),
      done('reviewLoad', { decision: 'approved' }, { outcome: 'approved' }),
      done('load', { applied: 1, failed: 1, results: [{ id: 'a', summary: 'Load 28 statement lines', ok: true }, { id: 'b', summary: 'Record the certificate leverage', ok: false, error: 'No covenant of that name' }] }),
    ];
    const detail = stepDetail({ graph: GRAPH, status: 'RUNNING', currentNode: 'recalculate', steps, events: EVENTS }, 'load')!;
    assert.deepEqual(detail.asked, [{ label: 'Makes the changes approved in', value: '“Approve the load”' }]);
    assert.deepEqual(detail.changes, [
      { summary: 'Load 28 statement lines', ok: true, error: null },
      { summary: 'Record the certificate leverage', ok: false, error: 'No covenant of that name' },
    ]);
  });

  it('carries a failed step its error and attempts', () => {
    const steps: StoryStepInput[] = [...STEPS.slice(0, 1), { nodeId: 'onFile', status: 'FAILED', outcome: null, output: null, attempts: 3, errorMessage: 'The borrower has no statements.', startedAt: '2026-11-23T10:00:00Z', finishedAt: null }];
    const detail = stepDetail({ graph: GRAPH, status: 'FAILED', currentNode: 'onFile', steps, events: [] }, 'onFile')!;
    assert.equal(detail.state, 'failed');
    assert.equal(detail.attempts, 3);
    assert.equal(detail.error, 'The borrower has no statements.');
    // It never recorded a call, so what it was asked is the design.
    assert.equal(detail.askedAsDesigned, true);
  });

  it('says what a decision the run has not reached will ask', () => {
    const steps = STEPS.slice(0, 4);
    const detail = stepDetail({ graph: GRAPH, status: 'RUNNING', currentNode: 'package', steps, events: [] }, 'reviewLoad')!;
    assert.equal(detail.kind, 'human');
    assert.deepEqual(detail.asked.slice(0, 2), [
      { label: 'Decides the changes proposed by', value: '“Read the package”' },
      { label: 'Goes to', value: 'Anyone who may review' },
    ]);
  });

  it('is null for a step the run does not have', () => {
    assert.equal(stepDetail({ graph: GRAPH, status: 'WAITING', currentNode: null, steps: STEPS }, 'nowhere'), null);
  });
});

describe('values as words', () => {
  it('reads keys and values plainly', () => {
    assert.equal(keyWords('entityIds'), 'Entity ids');
    assert.equal(keyWords('STATEMENT_REVENUE'), 'Statement revenue');
    assert.equal(valueWords(null), '—');
    assert.equal(valueWords(false), 'No');
    assert.equal(valueWords('2026-11-23T17:04:51.123456+00:00'), '2026-11-23 17:04 UTC');
    assert.equal(valueWords('2026-11-23'), '2026-11-23');
    assert.equal(valueWords([BORROWER, BORROWER]), '2 records, by id');
    assert.equal(valueWords(['a', 'b']), 'a, b');
    assert.equal(valueWords([{ a: 1 }]), '1 item');
    assert.equal(valueWords({ a: 1, b: 2 }), '2 values');
  });

  it('reads a file load as where each column goes', () => {
    const view = mappingView([
      { sourceColumn: 'Statement', role: 'identity', domainCode: 'STATEMENT_PERIOD', transform: { kind: 'trim' } },
      { sourceColumn: 'Revenue', role: 'attribute', domainCode: 'STATEMENT_PERIOD', attributeCode: 'STATEMENT_REVENUE', transform: { kind: 'number' } },
      { sourceColumn: 'Period end', role: 'attribute', domainCode: 'STATEMENT_PERIOD', attributeCode: 'STATEMENT_END', transform: { kind: 'date' } },
      { sourceColumn: 'Prepared by', role: 'ignore', domainCode: null, transform: { kind: 'trim' } },
    ])!;
    assert.deepEqual(view.rows, [
      { column: 'Statement', goesTo: 'Identifies the statement period', readAs: 'Text', code: null },
      { column: 'Revenue', goesTo: 'Statement revenue', readAs: 'Number', code: 'STATEMENT_REVENUE' },
      { column: 'Period end', goesTo: 'Statement end', readAs: 'Date', code: 'STATEMENT_END' },
    ]);
    assert.deepEqual(view.leftOut, ['Prepared by']);
    assert.equal(mappingView([{ name: 'not a mapping' }]), null);
    assert.equal(mappingView('x'), null);
  });
});
