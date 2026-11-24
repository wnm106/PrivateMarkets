import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKFLOW_TEMPLATES } from '@tapestrai/graphql/src/lib/workflow-templates';
import { checkRecords, runChecklist } from './workflow-checklist';
import { durationText, firstSentence, runStory, storySummary, toolWords, type StoryEventInput, type StoryStepInput } from './workflow-story';

const template = (code: string) => WORKFLOW_TEMPLATES.find((entry) => entry.code === code)!.graph;
const NAV = template('NAV_RECONCILIATION');
const INTAKE = template('FILE_INTAKE');

const step = (nodeId: string, output: unknown = null, extra: Partial<StoryStepInput> = {}): StoryStepInput => ({ nodeId, status: 'SUCCEEDED', outcome: null, output, startedAt: '2026-11-22T05:00:00Z', finishedAt: '2026-11-22T05:00:04Z', ...extra });

/** A filed-report run that loaded on its own and stopped at its review, as the engine records it. */
const NAV_STEPS: StoryStepInput[] = [
  step('start'),
  step('select', { filtered: false, note: 'No filters were given.', selection: 'every record' }),
  step('read', {
    autoLoad: true,
    fileName: 'fund-10-q.pdf',
    fund: { id: 'f1', code: 'F1', name: 'Harbor Credit Fund' },
    report: { form: '10-Q', periodEnd: '2026-06-30' },
    checks: { ties: 200, total: 200, notTied: [] },
    willLoad: { positions: 390 },
    holds: [],
    problems: [],
  }),
  step('auto', { result: true }, { outcome: 'true' }),
  step('ready', { joined: ['auto'] }),
  step(
    'load',
    {
      fileName: 'fund-10-q.pdf',
      fund: { name: 'Harbor Credit Fund' },
      periodEnd: '2026-06-30',
      confirmedBy: 'nobody: nothing needed a person',
      reportChecks: { ties: 200, total: 200 },
      summary: { domains: [{ created: 0, matched: 1, failed: 0 }, { created: 0, matched: 390, failed: 0 }], attributes: { created: 0, updated: 0, unchanged: 2468 }, rejectCount: 0 },
    },
    { startedAt: '2026-11-22T05:03:09Z', finishedAt: '2026-11-22T05:06:34Z' },
  ),
  step('review', {
    headline: 'Harbor Credit Fund, Q2 2026: 0 breaks and 1 open review item. Reported NAV $1,641.8M.',
    counts: { breaks: 0, checks: 19, ties: 17, missing: 2, items: 1 },
    needsDecision: true,
    entries: [
      { id: 'bank', kind: 'missing', title: 'Closing cash vs bank statement', cause: 'No bank statement is on file.', action: 'Ask the custodian for the statement.', owner: 'Fund accountant', blocking: false },
      { id: 'perf', kind: 'item', title: 'Incentive fee on income', cause: 'Ours differs by $57,000.', action: 'Accept, adjust, or query.', owner: 'Fund accountant', blocking: true },
    ],
  }),
  step('notes', { period: 'Q2 2026', replaced: true, outcome: 'Not ready to reconcile. 0 breaks and 2 checks with a figure missing.' }),
  step('open', { result: true }, { outcome: 'true' }),
  step('explain', { summary: 'I reviewed the Q2 2026 close. I propose accepting the one open item.', counts: { total: 2, needsReview: 2, questions: 0 }, proposal: { items: [{}, {}], views: [{}] } }),
  { nodeId: 'reviewRec', status: 'WAITING', outcome: null, output: null },
];

const NAV_EVENTS: StoryEventInput[] = [
  { nodeId: 'explain', type: 'run.failed', summary: '"Explain the breaks" failed. Could not resolve authentication method. Expected one of apiKey.' },
  { nodeId: 'explain', type: 'run.retried', summary: 'Run retried from the failed step' },
  { nodeId: 'explain', type: 'agent.tool', summary: 'Read with get_nav_breaks', detail: { tool: 'get_nav_breaks' } },
  { nodeId: 'explain', type: 'agent.tool', summary: 'Read with get_nav_reconciliation', detail: { tool: 'get_nav_reconciliation' } },
  { nodeId: 'explain', type: 'agent.tool', summary: 'Read with get_nav_breaks', detail: { tool: 'get_nav_breaks' } },
];

function navStory() {
  const records = checkRecords({ reviews: [{ id: 'r1', nodeId: 'reviewRec', status: 'OPEN', title: 'Decide what breaks or is open', canReview: true, proposal: { items: [{}, {}] } }] });
  const checklist = runChecklist({ graph: NAV, status: 'WAITING', currentNode: 'reviewRec', steps: NAV_STEPS, records });
  return runStory({ graph: NAV, status: 'WAITING', currentNode: 'reviewRec', steps: NAV_STEPS, events: NAV_EVENTS, checklist, deciding: ['perf'] });
}

describe('a run as a story of its steps', () => {
  it('lists the steps on the path in order and leaves out the ones that only route', () => {
    const story = navStory();
    assert.deepEqual(
      story.steps.map((entry) => `${entry.label}:${entry.state}`),
      [
        'Select records:done',
        'Read the report:done',
        'Can it load on its own?:done',
        'Load the report:done',
        'Review the NAV:done',
        'Write the notes:done',
        'Anything to decide?:done',
        'Explain the breaks:done',
        'Decide what breaks or is open:waiting',
        'Record the decisions:ahead',
        'Where the NAV stands now:ahead',
      ],
    );
    assert.equal(story.doneCount, 8);
    assert.equal(storySummary(story), '8 of 10 steps done by the system and the agent, 2 still to run');
  });

  it('says what each step did, with its figures', () => {
    const by = Object.fromEntries(navStory().steps.map((entry) => [entry.nodeId, entry]));
    assert.equal(by.read.did, 'Read fund-10-q.pdf and found the fund it is for.');
    assert.deepEqual(by.read.facts.find((fact) => fact.label === "The report's own checks"), { label: "The report's own checks", value: '200 of 200 tie', tone: 'good' });
    assert.equal(by.auto.did, 'Yes.');
    assert.equal(by.load.did, 'Loaded fund-10-q.pdf onto Harbor Credit Fund at 2026-06-30. Nothing needed a person first.');
    assert.equal(by.load.facts.find((fact) => fact.label === 'Values')?.value, 'Nothing changed: all 2,468 were already on file');
    assert.equal(by.load.facts.find((fact) => fact.label === 'Records')?.value, '391 matched, 0 new');
    assert.equal(by.load.seconds, 205);
    assert.equal(by.review.did, 'Harbor Credit Fund, Q2 2026: 0 breaks and 1 open review item.');
    assert.equal(by.review.facts.find((fact) => fact.label === 'Cannot be checked')?.tone, 'warn');
    assert.match(by.notes.did, /replacing the notes kept before/);
  });

  it('tells the agent step from what it read and proposed, and keeps a failure a retry got past', () => {
    const agent = navStory().steps.find((entry) => entry.nodeId === 'explain')!;
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.did, 'I reviewed the Q2 2026 close.');
    assert.equal(agent.facts.find((fact) => fact.label === 'Read')?.value, 'nav breaks, nav reconciliation (3 reads)');
    assert.equal(agent.facts.find((fact) => fact.label === 'Proposed')?.value, '2 changes, 2 for a close look');
    assert.match(agent.trouble || '', /^Failed once before it finished, and was retried\. Could not resolve authentication method\./);
  });

  it('gives a decision its number and standing from the checklist', () => {
    const decision = navStory().steps.find((entry) => entry.nodeId === 'reviewRec')!;
    assert.equal(decision.kind, 'human');
    assert.equal(decision.decision, 1);
    assert.equal(decision.did, 'Your move');
    assert.equal(decision.seconds, null);
  });

  it('lists what the run leaves open, and marks what a waiting change decides', () => {
    const story = navStory();
    assert.equal(story.openFrom, 'Review the NAV');
    assert.deepEqual(
      story.open.map((item) => `${item.title}|${item.owner}|${item.blocking}|${item.decidedHere}`),
      ['Closing cash vs bank statement|Fund accountant|false|false', 'Incentive fee on income|Fund accountant|true|true'],
    );
  });

  it('shows a step that failed with its reason, and the steps after it as still ahead', () => {
    const steps: StoryStepInput[] = [...NAV_STEPS.slice(0, 9), { nodeId: 'explain', status: 'FAILED', outcome: null, output: null, errorMessage: 'The model could not be reached. Try again.' }];
    const story = runStory({ graph: NAV, status: 'FAILED', currentNode: 'explain', steps, events: NAV_EVENTS.slice(0, 1) });
    const failed = story.steps.find((entry) => entry.nodeId === 'explain')!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.did, 'The model could not be reached.');
    assert.equal(failed.trouble, null);
    assert.equal(story.steps.find((entry) => entry.nodeId === 'record')?.state, 'ahead');
    assert.match(storySummary(story), /1 failed/);
  });

  it('tells a guided file run: staged with its checks, then discarded', () => {
    const batch = { fileName: 'borrower-financials.csv', status: 'STAGED', records: { created: 0, matched: 3 }, values: { added: 14, changed: 4, unchanged: 0 }, quality: { summary: { blocking: 1 }, failures: [{}], missing: [{}, {}] } };
    const steps: StoryStepInput[] = [
      step('start'),
      step('receive', { indexed: true, note: 'The table read from the file is indexed for search.' }),
      step('understand', { outcome: 'confirmed' }, { outcome: 'confirmed' }),
      step('map', { outcome: 'confirmed' }, { outcome: 'confirmed' }),
      step('stage', { kind: 'staged', batch }),
      step('staged', { result: true }, { outcome: 'true' }),
      step('quality', { outcome: 'discarded' }, { outcome: 'discarded' }),
      step('discard', { ...batch, status: 'DISCARDED' }),
      step('end'),
    ];
    const by = Object.fromEntries(runStory({ graph: INTAKE, status: 'SUCCEEDED', currentNode: 'end', steps }).steps.map((entry) => [entry.nodeId, entry]));
    assert.equal(by.receive.did, 'The table read from the file is indexed for search.');
    assert.equal(by.stage.did, 'borrower-financials.csv is staged. Nothing is live yet.');
    assert.deepEqual(by.stage.facts, [
      { label: 'Records', value: '3 matched, 0 new' },
      { label: 'Values', value: '14 added, 4 changed, 0 unchanged' },
      { label: 'Checks', value: '1 check fails, 1 critical, 2 required values missing', tone: 'bad' },
    ]);
    assert.equal(by.discard.did, 'borrower-financials.csv was discarded. Nothing was made live.');
    // The promote step is on the other way out of the decision, so it is not on this run's path.
    assert.equal(by.promote, undefined);
  });

  it('reads a tool it has no words for by the sentence or the rows it returned', () => {
    const graph = { nodes: [{ id: 'start', type: 'start', label: 'Start', config: {} }, { id: 'a', type: 'tool', label: 'List issuers', config: { tool: 'list_entities' } }, { id: 'b', type: 'tool', label: 'Other', config: { tool: 'something_new' } }, { id: 'end', type: 'end', label: 'End', config: {} }], edges: [{ id: 'e1', from: 'start', to: 'a' }, { id: 'e2', from: 'a', to: 'b' }, { id: 'e3', from: 'b', to: 'end' }] } as never;
    const story = runStory({ graph, status: 'SUCCEEDED', currentNode: 'end', steps: [step('start'), step('a', { entities: [{}, {}, {}], totalCount: 309 }), step('b', { headline: 'All good. More words.' }), step('end')] });
    assert.deepEqual(story.steps.map((entry) => entry.did), ['Returned 3 entities of 309.', 'All good.']);
  });

  it('tells the borrower steps from their figures, and marks the open items a waiting change settles', () => {
    const graph = template('BORROWER_FINANCIALS');
    const financials = {
      count: 1,
      headline: 'Halyard Systems, Q3 2026: statement on file. 3 covenants tested: 1 close to it, 2 inside. 1 certificate value differs from our calculation.',
      borrowers: [{ statementOnFile: true, counts: { covenants: 3, breaches: 0, watch: 1, certificateDiffers: 1, certificateMissing: 0, notable: 2 } }],
      entries: [
        { id: 'cov:c1', title: 'Maximum net leverage is close to its limit', cause: '2.97x against a maximum of 3.25x.', action: 'Ask the borrower for its forecast.', owner: 'Credit analyst', blocking: false },
        { id: 'cert:c1', title: 'Maximum net leverage: the certificate differs', cause: '2.76x against 2.97x.', action: 'Ask for the bridge.', owner: 'Credit analyst', blocking: false },
        { id: 'review:b1', title: 'Q3 2026 has not been reviewed', cause: 'No notes.', action: 'Write the review.', owner: 'Credit analyst', blocking: false },
      ],
    };
    // The statements come in through the standard import: a person hands the run its file, and the loader's own steps follow.
    const steps: StoryStepInput[] = [
      step('start'),
      step('file', { outcome: 'received', result: { importInstanceId: 'f1', fileName: 'halyard-q3-2026-statements.csv', loadedBefore: false } }, { outcome: 'received' }),
      step('index', { indexed: true }),
      step('identify', { identified: true, filtered: true, entityIds: ['b1'], records: [{ id: 'b1', name: 'Halyard Systems', how: 'its name is exactly this value' }] }),
      step('identified', { result: true }, { outcome: 'true' }),
      step('select', { identified: true, filtered: true, entityIds: ['b1'], records: [{ id: 'b1', name: 'Halyard Systems', how: 'its name is exactly this value' }] }),
      step('before', financials),
      step('any', { result: true }, { outcome: 'true' }),
      { nodeId: 'understand', status: 'WAITING', outcome: null, output: null },
    ];
    const records = checkRecords({
      stages: [
        { id: 's1', nodeId: 'file', status: 'COMPLETED', title: 'Hand this run its file', canAct: false, completedByName: 'Ada', outcome: 'received' },
        { id: 's2', nodeId: 'understand', status: 'OPEN', title: 'Confirm what this file is', canAct: true },
      ],
    });
    const checklist = runChecklist({ graph, status: 'WAITING', currentNode: 'understand', steps, records });
    const story = runStory({ graph, status: 'WAITING', currentNode: 'understand', steps, checklist, deciding: ['review:b1'] });
    const by = Object.fromEntries(story.steps.map((entry) => [entry.nodeId, entry]));
    assert.equal(by.select.did, 'Halyard Systems is the record this file is about: its name is exactly this value.');
    assert.equal(by.before.did, 'Halyard Systems, Q3 2026: statement on file.');
    assert.deepEqual(by.before.facts.map((fact) => `${fact.label}: ${fact.value}`), ['Statement for the quarter: On file', 'Covenants past the limit: 0 of 3', 'Close to the limit: 1', 'Certificate against our calculation: 1 differ', 'Lines moving sharply: 2']);
    // The decision that received the file names it, and the import's own steps are each on the list.
    assert.equal(by.file.decision, 1);
    assert.equal(by.file.state, 'done');
    assert.deepEqual(by.file.facts, [{ label: 'File', value: 'halyard-q3-2026-statements.csv' }]);
    assert.equal(by.index.did, 'The file is indexed for search.');
    assert.equal(by.understand.state, 'waiting');
    // The steps are listed in the order the run reaches them: the whole import, then the review that follows it.
    assert.deepEqual(story.steps.map((entry) => entry.nodeId).slice(4), ['select', 'before', 'any', 'understand', 'map', 'stage', 'staged', 'quality', 'promote', 'discard', 'recalculate', 'after', 'analyze', 'review', 'record', 'final']);
    assert.deepEqual(checklist.items.filter((item) => item.number !== null).map((item) => item.label), ['Hand this run its file', 'Confirm what this file is', 'Map the file', 'Check the values', 'Review the quarter']);
    // Discarding the staged batch only stops the run, so it does not put the review in doubt.
    assert.equal(by.discard.certain, false);
    assert.equal(by.review.certain, true);
    assert.deepEqual(story.open.map((item) => [item.id, item.decidedHere]), [['cov:c1', false], ['cert:c1', false], ['review:b1', true]]);
  });

  it('words durations and tool names', () => {
    assert.equal(durationText(4), '4 s');
    assert.equal(durationText(205), '3 min 25 s');
    assert.equal(durationText(7800), '2 h 10 min');
    assert.equal(durationText(null), null);
    assert.equal(toolWords('get_nav_breaks'), 'nav breaks');
  });

  it('does not end a sentence at an initial or an abbreviation', () => {
    assert.equal(firstSentence('T. Rowe Price OHA Fund, Q2 2026: 0 breaks and 1 open item. Reported NAV $1,641.8M.'), 'T. Rowe Price OHA Fund, Q2 2026: 0 breaks and 1 open item.');
    assert.equal(firstSentence('Acme Inc. filed late. It was accepted.'), 'Acme Inc. filed late.');
    assert.equal(firstSentence('Up 3.4% from $1,588.2M. Done.'), 'Up 3.4% from $1,588.2M.');
    assert.equal(firstSentence('No full stop here'), 'No full stop here');
  });
});
