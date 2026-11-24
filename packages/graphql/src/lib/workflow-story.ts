import type { WorkflowGraph, WorkflowNode } from './workflow-graph';
import { nodeKind, type NodeKind } from './workflow-graph';
import { pathSteps, type Checklist, type StepMark } from './workflow-checklist';

/**
 * A run as a story: every step on its path, in order, with one plain line on
 * what the step did and the few figures that matter.
 *
 * The checklist says where a person decides. The story says what the system
 * and the agent did between those points, so a reviewer can see what a
 * decision rests on without opening a step's raw result. It is read from what
 * each step stored when it finished, so it works for runs already recorded.
 * Pure, so the page, the assistant and the tests tell the same story.
 */

export type StoryState = 'done' | 'skipped' | 'running' | 'waiting' | 'failed' | 'ahead';
export type FactTone = 'good' | 'warn' | 'bad';

export interface StoryFact {
  label: string;
  value: string;
  tone?: FactTone;
}

export interface StoryStep {
  nodeId: string;
  label: string;
  /** Who does it: the system (fixed), the agent, or a person (human). */
  kind: NodeKind;
  type: string;
  state: StoryState;
  /** One line on what happened, or what will. Empty when there is nothing to add to the label. */
  did: string;
  facts: StoryFact[];
  /** Its number on the run's checklist, for a step that waits on a person. */
  decision: number | null;
  /** How long it took, for a finished step. */
  seconds: number | null;
  /** Something that went wrong on the way: a failure before a retry. */
  trouble: string | null;
  /** The run reaches it whatever is chosen. False for a step on only some choices. */
  certain: boolean;
}

/** Something a step found that this run does not settle, and who it sits with. */
export interface OpenItem {
  id: string;
  title: string;
  why: string;
  /** What has to happen next. */
  action: string;
  owner: string;
  /** It stops the work being finished, as the step that found it says. */
  blocking: boolean;
  /** A change waiting in an open review of this run decides it. */
  decidedHere: boolean;
}

export interface RunStory {
  steps: StoryStep[];
  /** Steps the system or the agent has finished. */
  doneCount: number;
  /** What is still open after the latest step that reported open items, and the step that said so. */
  open: OpenItem[];
  openFrom: string | null;
}

export interface StoryStepInput extends StepMark {
  attempts?: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface StoryEventInput {
  nodeId: string | null;
  type: string;
  summary: string;
  detail?: unknown;
}

export interface StoryInput {
  graph: WorkflowGraph | null;
  status: string;
  currentNode: string | null;
  steps: StoryStepInput[];
  events?: StoryEventInput[];
  /** The run's checklist, for the number and standing of each decision. */
  checklist?: Checklist | null;
  /** Ids the changes in the run's open reviews decide (a review item's id). */
  deciding?: readonly string[];
}

/** Steps that only route the run. They are left out of the story. */
const PLUMBING = new Set(['start', 'end', 'join', 'parallel']);
const FINISHED = new Set(['SUCCEEDED', 'SKIPPED']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(total: number, one: string, many = `${one}s`): string {
  return `${num(total)} ${total === 1 ? one : many}`;
}

const ABBREVIATION = /(^|[\s(])(?:[A-Za-z]|vs|no|inc|ltd|co|corp|llc|lp|plc|mr|ms|dr|st|approx|est|e\.g|i\.e)$/i;

/** Where the first sentence of a line ends, or -1. A full stop after an initial ("T. Rowe") or an abbreviation is not an end. */
export function sentenceEnd(flat: string): number {
  for (const match of flat.matchAll(/[.!?](?=\s|$)/g)) {
    const at = match.index ?? 0;
    if (match[0] === '.' && ABBREVIATION.test(flat.slice(0, at))) continue;
    return at;
  }
  return -1;
}

/** The first sentence of a line, so a long note does not fill a row. */
export function firstSentence(value: string, limit = 220): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const stop = sentenceEnd(flat);
  const sentence = stop >= 0 && stop < limit ? flat.slice(0, stop + 1) : flat;
  return sentence.length <= limit ? sentence : `${sentence.slice(0, sentence.lastIndexOf(' ', limit)).trimEnd()}…`;
}

/** A tool's name as words: get_nav_breaks becomes "nav breaks". */
export function toolWords(tool: string): string {
  return tool.replace(/^(get|list|search|find|preview|analyze|compare|validate|parse)_/, '').replace(/_/g, ' ');
}

interface Told {
  did: string;
  facts: StoryFact[];
}

/** What a load wrote, from the counts a loader returns. */
function loadFacts(summary: Record<string, unknown>): StoryFact[] {
  const facts: StoryFact[] = [];
  const domains = list(summary.domains).map(record);
  const created = domains.reduce((sum, domain) => sum + (count(domain.created) || 0), 0);
  const matched = domains.reduce((sum, domain) => sum + (count(domain.matched) || 0), 0);
  const failed = domains.reduce((sum, domain) => sum + (count(domain.failed) || 0), 0);
  if (domains.length > 0) facts.push({ label: 'Records', value: `${num(matched)} matched, ${num(created)} new` });
  const attributes = record(summary.attributes);
  const added = count(attributes.created);
  const changed = count(attributes.updated);
  const same = count(attributes.unchanged);
  if (added !== null || changed !== null) {
    const nothingNew = (added || 0) === 0 && (changed || 0) === 0 && (same || 0) > 0;
    facts.push({
      label: 'Values',
      value: nothingNew ? `Nothing changed: all ${num(same || 0)} were already on file` : `${num(added || 0)} added, ${num(changed || 0)} changed, ${num(same || 0)} unchanged`,
    });
  }
  const rejects = (count(summary.rejectCount) || 0) + failed;
  facts.push(rejects > 0 ? { label: 'Refused', value: plural(rejects, 'row'), tone: 'bad' } : { label: 'Refused', value: 'None', tone: 'good' });
  return facts;
}

/** A staged batch: what it would write and how its checks came out. */
function batchTold(batch: Record<string, unknown>): Told {
  const records = record(batch.records);
  const values = record(batch.values);
  const quality = record(record(batch.quality).summary);
  const facts: StoryFact[] = [];
  if (count(records.created) !== null || count(records.matched) !== null) facts.push({ label: 'Records', value: `${num(count(records.matched) || 0)} matched, ${num(count(records.created) || 0)} new` });
  if (count(values.added) !== null) facts.push({ label: 'Values', value: `${num(count(values.added) || 0)} added, ${num(count(values.changed) || 0)} changed, ${num(count(values.unchanged) || 0)} unchanged` });
  const blocking = count(quality.blocking);
  const failures = list(record(batch.quality).failures).length;
  const missing = list(record(batch.quality).missing).length;
  if (record(batch.quality).summary !== undefined || failures > 0 || missing > 0) {
    facts.push({
      label: 'Checks',
      value: failures === 0 && missing === 0 ? 'All pass' : `${plural(failures, 'check')} fail${failures === 1 ? 's' : ''}${blocking ? `, ${num(blocking)} critical` : ''}${missing > 0 ? `, ${plural(missing, 'required value')} missing` : ''}`,
      tone: blocking ? 'bad' : failures > 0 || missing > 0 ? 'warn' : 'good',
    });
  }
  const name = text(batch.fileName) || 'The file';
  const status = text(batch.status);
  if (status === 'PROMOTED') return { did: `${name} is live.`, facts: [...facts, ...loadFacts(record(batch.result)).filter((fact) => fact.label === 'Refused')] };
  if (status === 'DISCARDED') return { did: `${name} was discarded. Nothing was made live.`, facts: [] };
  if (status === 'FAILED') return { did: `${name} stopped part way${text(batch.errorMessage) ? `: ${firstSentence(text(batch.errorMessage))}` : '.'}`, facts };
  return { did: `${name} is staged. Nothing is live yet.`, facts };
}

/**
 * What one tool's result says, in a line and a few figures. A tool without an
 * entry here is read by the general rules in `toldGenerally`, so a new tool
 * still tells its part.
 */
const TOOL_TOLD: Record<string, (out: Record<string, unknown>) => Told | null> = {
  find_records(out) {
    const ids = list(out.entityIds);
    if (out.filtered === false) return { did: 'No records were chosen, so the run is not limited to particular records.', facts: [] };
    return { did: ids.length === 0 ? 'The filters chose no records.' : `Chose ${plural(ids.length, 'record')}.`, facts: [] };
  },
  find_file_record(out) {
    const records = list(out.records).map((item) => record(item));
    if (out.identified === true && records.length > 0) {
      const names = records.map((item) => text(item.name)).filter(Boolean);
      const how = records.length === 1 ? text(records[0].how) : '';
      return { did: `${names.join(', ')} ${records.length === 1 ? 'is' : 'are'} the ${records.length === 1 ? 'record' : 'records'} this file is about${how ? `: ${how}` : ''}.`, facts: [] };
    }
    return { did: text(out.note) || 'No record was found in the file.', facts: [] };
  },
  get_nav_report(out) {
    const report = record(out.report);
    const checks = record(out.checks);
    const fund = record(out.fund);
    const holds = [...list(out.holds), ...list(out.problems)];
    const facts: StoryFact[] = [];
    const form = [text(report.form), text(report.periodEnd) ? `to ${text(report.periodEnd)}` : ''].filter(Boolean).join(' ');
    if (form) facts.push({ label: 'Report', value: form });
    if (text(fund.name)) facts.push({ label: 'Fund', value: text(fund.name) });
    const ties = count(checks.ties);
    const total = count(checks.total);
    if (ties !== null && total !== null) facts.push({ label: "The report's own checks", value: `${num(ties)} of ${num(total)} tie`, tone: ties === total ? 'good' : 'warn' });
    const positions = count(record(out.willLoad).positions);
    if (positions !== null) facts.push({ label: 'Will load', value: plural(positions, 'position') });
    facts.push(holds.length > 0 ? { label: 'Held for a person', value: plural(holds.length, 'reason'), tone: 'warn' } : { label: 'Held for a person', value: 'No', tone: 'good' });
    const name = text(out.fileName) || 'the report';
    return { did: text(fund.name) ? `Read ${name} and found the fund it is for.` : `Read ${name}. The fund it is for was not found.`, facts };
  },
  load_nav_report(out) {
    const fund = record(out.fund);
    const checks = record(out.reportChecks);
    const facts = loadFacts(record(out.summary));
    const ties = count(checks.ties);
    const total = count(checks.total);
    if (ties !== null && total !== null && ties !== total) facts.push({ label: "The report's own checks", value: `${num(ties)} of ${num(total)} tie`, tone: 'warn' });
    // A loaded file is kept as a document, so its notes and footnotes can be searched.
    const document = record(out.document);
    if (document.indexed === true) facts.push({ label: 'Kept for search', value: 'Every page, with its notes and footnotes', tone: 'good' });
    else if (text(document.note)) facts.push({ label: 'Kept for search', value: `No. ${firstSentence(text(document.note), 140)}`, tone: 'warn' });
    const by = text(out.confirmedBy);
    return { did: `Loaded ${text(out.fileName) || 'the report'}${text(fund.name) ? ` onto ${text(fund.name)}` : ''}${text(out.periodEnd) ? ` at ${text(out.periodEnd)}` : ''}.${by.startsWith('nobody') ? ' Nothing needed a person first.' : ''}`, facts };
  },
  get_nav_breaks(out) {
    const counts = record(out.counts);
    const facts: StoryFact[] = [];
    const ties = count(counts.ties);
    const checks = count(counts.checks);
    const breaks = count(counts.breaks);
    const missing = count(counts.missing);
    const items = count(counts.items);
    if (ties !== null && checks !== null) facts.push({ label: 'Checks that tie', value: `${num(ties)} of ${num(checks)}`, tone: ties === checks ? 'good' : undefined });
    if (breaks !== null) facts.push({ label: 'Breaks', value: num(breaks), tone: breaks > 0 ? 'bad' : 'good' });
    if (missing !== null) facts.push({ label: 'Cannot be checked', value: missing === 0 ? 'None' : `${num(missing)}, a figure is not on file`, tone: missing > 0 ? 'warn' : 'good' });
    if (items !== null) facts.push({ label: 'Items to decide', value: num(items), tone: items > 0 ? 'warn' : 'good' });
    return { did: text(out.headline) ? firstSentence(text(out.headline)) : 'Ran the NAV checks.', facts };
  },
  save_nav_notes(out) {
    return { did: `Kept the summary as the close's notes${text(out.period) ? ` for ${text(out.period)}` : ''}${out.replaced === true ? ', replacing the notes kept before' : ''}.`, facts: text(out.outcome) ? [{ label: 'Where the close stands', value: firstSentence(text(out.outcome)) }] : [] };
  },
  get_borrower_financials(out) {
    const borrowers = list(out.borrowers).map(record);
    const sum = (key: string) => borrowers.reduce((total, borrower) => total + (count(record(borrower.counts)[key]) || 0), 0);
    const facts: StoryFact[] = [];
    if (borrowers.length > 0) {
      const missing = borrowers.filter((borrower) => borrower.statementOnFile === false).length;
      const tested = sum('covenants');
      const differs = sum('certificateDiffers');
      const absent = sum('certificateMissing');
      facts.push(missing > 0 ? { label: 'Statement for the quarter', value: `Not on file for ${missing === borrowers.length && borrowers.length === 1 ? 'the borrower' : plural(missing, 'borrower')}`, tone: 'bad' } : { label: 'Statement for the quarter', value: 'On file', tone: 'good' });
      if (tested > 0) {
        facts.push({ label: 'Covenants past the limit', value: `${num(sum('breaches'))} of ${num(tested)}`, tone: sum('breaches') > 0 ? 'bad' : 'good' });
        facts.push({ label: 'Close to the limit', value: num(sum('watch')), tone: sum('watch') > 0 ? 'warn' : 'good' });
        facts.push(differs > 0 ? { label: 'Certificate against our calculation', value: `${num(differs)} differ`, tone: 'warn' } : absent > 0 ? { label: 'Certificate against our calculation', value: `${num(absent)} not on file`, tone: 'warn' } : { label: 'Certificate against our calculation', value: 'Agrees', tone: 'good' });
      }
      facts.push({ label: 'Lines moving sharply', value: num(sum('notable')), tone: sum('notable') > 0 ? 'warn' : undefined });
    }
    return { did: text(out.headline) ? firstSentence(text(out.headline), 260) : 'Read the financials on file.', facts };
  },
  list_fund_closes(out) {
    const funds = list(out.funds);
    return { did: funds.length === 0 ? 'No fund in the selection has a close to work on.' : `Read where ${plural(funds.length, 'close')} ${funds.length === 1 ? 'stands' : 'stand'}.`, facts: [] };
  },
  list_position_file_imports(out) {
    const files = [...list(out.imports), ...list(out.instances), ...list(out.files)].map(record);
    if (files.length === 0) return null;
    const waiting = files.filter((file) => ['READY', 'FAILED'].includes(text(file.status).toUpperCase())).length;
    return { did: `Listed ${plural(files.length, 'stored file')}: ${waiting === 0 ? 'none waiting to be loaded' : `${num(waiting)} not yet loaded`}.`, facts: [] };
  },
  list_dq_exceptions(out) {
    const found = list(out.exceptions).length;
    const total = count(out.totalCount);
    return { did: found === 0 ? 'No open data quality exception was found.' : `Found ${plural(found, 'open data quality exception')}${total !== null && total > found ? ` of ${num(total)}` : ''}.`, facts: [] };
  },
  index_position_file_import(out) {
    return { did: text(out.note) || (out.indexed === true ? 'The file is indexed for search.' : 'The file could not be indexed for search. The run went on.'), facts: [] };
  },
  stage_position_file_import(out) {
    if (text(out.kind) !== 'staged') return { did: text(out.note) || text(out.message) || 'Nothing could be staged from the file.', facts: [] };
    return batchTold(record(out.batch));
  },
  promote_load_batch(out) {
    const told = batchTold(out);
    const written = loadFacts(record(out.result));
    const drift = list(out.drift).map(text).filter(Boolean);
    return { did: told.did, facts: [...written, ...(drift.length > 0 ? [{ label: 'Differs from what was staged', value: drift.join('; '), tone: 'warn' as const }] : [])] };
  },
  discard_load_batch: (out) => batchTold(out),
};

/** A step result read without knowing its tool: the sentence it carries, or what it returned. */
function toldGenerally(out: Record<string, unknown>): Told {
  for (const key of ['headline', 'note', 'message']) {
    if (text(out[key])) return { did: firstSentence(text(out[key])), facts: [] };
  }
  for (const key of ['outcome', 'summary']) {
    // A sentence, not a code such as "approved".
    if (/\s/.test(text(out[key]))) return { did: firstSentence(text(out[key])), facts: [] };
  }
  const lists = Object.entries(out).filter(([, value]) => Array.isArray(value)) as Array<[string, unknown[]]>;
  if (lists.length > 0) {
    const [name, rows] = lists.sort((a, b) => b[1].length - a[1].length)[0];
    const total = count(out.totalCount);
    return { did: `Returned ${num(rows.length)} ${name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}${total !== null && total > rows.length ? ` of ${num(total)}` : ''}.`, facts: [] };
  }
  return { did: '', facts: [] };
}

function toldByTool(node: WorkflowNode, output: unknown): Told {
  const out = record(output);
  if (out.truncated === true) return { did: 'Finished. Its result was too large to keep in full.', facts: [] };
  const tool = text(node.config.tool);
  return TOOL_TOLD[tool]?.(out) || toldGenerally(out);
}

function toldByAgent(nodeId: string, output: unknown, events: StoryEventInput[]): Told {
  const out = record(output);
  const counts = record(out.counts);
  const reads = events.filter((event) => event.nodeId === nodeId && event.type === 'agent.tool').map((event) => text(record(event.detail).tool)).filter(Boolean);
  const kinds = [...new Set(reads)];
  const total = count(counts.total);
  const facts: StoryFact[] = [];
  if (reads.length > 0) facts.push({ label: 'Read', value: `${kinds.map(toolWords).join(', ')}${reads.length > kinds.length ? ` (${plural(reads.length, 'read')})` : ''}` });
  if (total !== null) {
    const unsure = count(counts.needsReview) || 0;
    const questions = count(counts.questions) || 0;
    facts.push({
      label: 'Proposed',
      value: total === 0 ? 'No change' : `${plural(total, 'change')}${unsure > 0 ? `, ${num(unsure)} for a close look` : ', confident in all'}${questions > 0 ? `, ${plural(questions, 'question')} for you` : ''}`,
      tone: total > 0 && unsure > 0 ? 'warn' : undefined,
    });
  }
  const views = list(record(out.proposal).views).length;
  if (views > 0) facts.push({ label: 'Put in front of the reviewer', value: plural(views, 'view') });
  return { did: text(out.summary) ? firstSentence(text(out.summary).replace(/^#{1,6}\s.*$/m, '').trim(), 260) : total === 0 ? 'Proposed no change.' : '', facts };
}

function toldByApply(output: unknown): Told {
  const out = record(output);
  const applied = count(out.applied) || 0;
  const failed = count(out.failed) || 0;
  const firstFailure = list(out.results).map(record).find((row) => row.ok === false);
  const facts: StoryFact[] = [];
  if (failed > 0 && firstFailure) facts.push({ label: text(firstFailure.summary) || 'A change', value: firstSentence(text(firstFailure.error) || 'It could not be made.'), tone: 'bad' });
  return { did: applied + failed === 0 ? 'Nothing was approved, so nothing was changed.' : `Made ${plural(applied, 'approved change')}${failed > 0 ? `. ${num(failed)} could not be made` : ''}.`, facts };
}

function told(node: WorkflowNode, output: unknown, events: StoryEventInput[]): Told {
  switch (node.type) {
    case 'tool':
      return toldByTool(node, output);
    case 'agent':
      return toldByAgent(node.id, output, events);
    case 'apply':
      return toldByApply(output);
    case 'branch':
      return { did: record(output).result === true ? 'Yes.' : 'No.', facts: [] };
    case 'http': {
      const status = count(record(output).status);
      return { did: status !== null ? `The connection answered ${status}.` : 'Called the connection.', facts: [] };
    }
    case 'message': {
      const out = record(output);
      const to = list(out.to).map(text).filter(Boolean);
      return { did: text(out.channel) === 'slack' ? 'Posted to Slack.' : to.length > 0 ? `Emailed ${to.join(', ')}.` : 'Sent the message.', facts: [] };
    }
    default:
      return { did: '', facts: [] };
  }
}

function seconds(step: StoryStepInput | undefined): number | null {
  if (!step?.startedAt || !step.finishedAt) return null;
  const span = (Date.parse(step.finishedAt) - Date.parse(step.startedAt)) / 1000;
  return Number.isFinite(span) && span >= 0 ? Math.round(span) : null;
}

/** "4 s", "3 min 25 s", "2 h 10 min". */
export function durationText(total: number | null): string | null {
  if (total === null) return null;
  if (total < 60) return `${Math.max(1, total)} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ''}`;
  return `${Math.floor(total / 3600)} h${Math.floor((total % 3600) / 60) ? ` ${Math.floor((total % 3600) / 60)} min` : ''}`;
}

/** The open items a step's result lists: rows that say what is open and what to do about it. */
function openItems(output: unknown, deciding: ReadonlySet<string>): OpenItem[] {
  const out: OpenItem[] = [];
  for (const entry of list(record(output).entries).map(record)) {
    const title = text(entry.title);
    const action = text(entry.action);
    if (!title || !action) continue;
    const id = text(entry.id) || title;
    out.push({ id, title, why: text(entry.cause), action, owner: text(entry.owner), blocking: entry.blocking === true, decidedHere: deciding.has(id) });
  }
  return out;
}

/** Every step of a run in order, with what each did, and what is still open after it. */
export function runStory(input: StoryInput): RunStory {
  const empty: RunStory = { steps: [], doneCount: 0, open: [], openFrom: null };
  if (!input.graph) return empty;
  const marks = new Map(input.steps.map((step) => [step.nodeId, step]));
  const events = input.events || [];
  const decisions = new Map((input.checklist?.items || []).map((item) => [item.nodeId, item]));
  const deciding = new Set(input.deciding || []);
  const failures = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== 'run.failed' || !event.nodeId) continue;
    failures.set(event.nodeId, [...(failures.get(event.nodeId) || []), event.summary]);
  }

  const steps: StoryStep[] = [];
  let open: OpenItem[] = [];
  let openFrom: string | null = null;
  for (const { node, certain } of pathSteps(input.graph, input.steps)) {
    if (PLUMBING.has(node.type)) continue;
    const mark = marks.get(node.id);
    const kind = nodeKind(node.type);
    const decision = decisions.get(node.id);
    const finished = Boolean(mark && FINISHED.has(mark.status));
    const failedBefore = failures.get(node.id) || [];

    let state: StoryState = 'ahead';
    let did = '';
    let facts: StoryFact[] = [];
    if (decision) {
      // A step that waits on a person stands where the checklist says it does.
      state = decision.state === 'done' ? 'done' : decision.state === 'skipped' ? 'skipped' : decision.state === 'attention' ? 'failed' : decision.state === 'ahead' ? 'ahead' : 'waiting';
      did = decision.state === 'ahead' ? '' : decision.note;
      // A person who handed the run a file: the file is what every later step works on, so it is named.
      const left = record(record(mark?.output).result);
      if (decision.state === 'done' && text(left.fileName)) {
        facts = [{ label: 'File', value: text(left.fileName) }, ...(left.loadedBefore === true ? [{ label: 'Loaded before', value: 'Yes, so this run states its values again', tone: 'warn' as const }] : [])];
      }
    } else if (finished && mark) {
      state = 'done';
      ({ did, facts } = told(node, mark.output, events));
      const found = openItems(mark.output, deciding);
      if (found.length > 0) {
        open = found;
        openFrom = node.label;
      }
    } else if (mark?.status === 'FAILED' || (input.status === 'FAILED' && input.currentNode === node.id)) {
      state = 'failed';
      did = firstSentence(text(mark?.errorMessage) || failedBefore[failedBefore.length - 1] || 'This step failed.', 300);
    } else if (mark?.status === 'RUNNING' || (input.status === 'RUNNING' && input.currentNode === node.id)) {
      state = 'running';
      did = 'Working on it now.';
    } else if (mark?.status === 'WAITING') {
      state = 'waiting';
    }

    // A failure that a retry got past is worth one line; one that still stands is the step's own line.
    const past = state === 'failed' ? [] : failedBefore;
    steps.push({
      nodeId: node.id,
      // A decision is named as the checklist names it: by its screen's title.
      label: decision?.label || node.label,
      kind,
      type: node.type,
      state,
      did,
      facts,
      decision: decision?.number ?? null,
      // A step that failed and was retried spans the wait for the retry, so its time says nothing about the work.
      seconds: finished && kind !== 'human' && failedBefore.length === 0 ? seconds(mark) : null,
      trouble: past.length > 0 ? `Failed ${past.length === 1 ? 'once' : `${past.length} times`} before it finished, and was retried. ${firstSentence(past[past.length - 1].replace(/^"[^"]*" failed\.\s*/, ''), 160)}` : null,
      certain,
    });
  }

  return { steps, doneCount: steps.filter((step) => step.kind !== 'human' && step.state === 'done').length, open, openFrom };
}

/** "9 steps done on their own", for the line above the list. */
export function storySummary(story: RunStory): string {
  const own = story.steps.filter((step) => step.kind !== 'human');
  if (own.length === 0) return '';
  const failed = own.filter((step) => step.state === 'failed').length;
  const ahead = own.filter((step) => step.state === 'ahead').length;
  const parts = [`${story.doneCount} of ${plural(own.length, 'step')} done by the system and the agent`];
  if (failed > 0) parts.push(`${num(failed)} failed`);
  if (ahead > 0) parts.push(`${num(ahead)} still to run`);
  return parts.join(', ');
}
