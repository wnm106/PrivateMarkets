import { nodeTypeDef, type WorkflowGraph, type WorkflowNode } from './workflow-graph';
import { runStory, toolWords, type StoryEventInput, type StoryInput, type StoryStep } from './workflow-story';

/**
 * One step of a run, opened up: what kind of step it is, what it was asked,
 * what it returned, and everything recorded while it ran.
 *
 * The step list says what each step did in a line. This is what a person gets
 * when they want to check that line: the settings the step ran with, its
 * result laid out as figures and tables, an agent's reads and proposals, the
 * changes an apply step made, and the step's own history. A step that has not
 * run says what it will be asked. Nothing here needs a decision.
 * Pure, so the page, the assistant and the tests open a step the same way.
 */

export interface DetailField {
  label: string;
  value: string;
}

export interface DetailGroup {
  label: string;
  fields: DetailField[];
}

/** A list in a step's result: how many rows it has, and the first few as a table. */
export interface DetailList {
  label: string;
  count: number;
  columns: string[];
  rows: string[][];
  /** Rows not shown. */
  more: number;
}

export interface ResultView {
  fields: DetailField[];
  groups: DetailGroup[];
  lists: DetailList[];
}

/** One thing an agent read while it worked. */
export interface DetailRead {
  tool: string;
  /** The tool as words: "position file tables". */
  what: string;
  /** What it was asked for, in short. */
  about: string;
  ok: boolean;
  at: string | null;
}

export interface DetailEvent {
  at: string | null;
  by: 'system' | 'agent' | 'person';
  name: string | null;
  summary: string;
}

export interface StepDetail extends StoryStep {
  /** What kind of step this is, in a sentence. */
  what: string;
  /** The tool a fixed step runs. Null for any other kind. */
  tool: string | null;
  /** The step may change data, or send it outside. */
  changesData: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  /** The way out the step took: "approved", "true". */
  outcome: string | null;
  /** What the step was asked: a tool's settings, a condition's test. */
  asked: DetailField[];
  /** The asked values are the step's settings as designed, with placeholders, because it has not run. */
  askedAsDesigned: boolean;
  result: ResultView | null;
  /** An agent's own write-up, in markdown. */
  summary: string | null;
  reads: DetailRead[];
  proposals: Array<{ summary: string; confidence: string; needsReview: boolean; tool: string }>;
  /** What an apply step made of each approved change. */
  changes: Array<{ summary: string; ok: boolean; error: string | null }>;
  usage: { calls: number; model: string | null; costUsd: number | null } | null;
  history: DetailEvent[];
  error: string | null;
}

/** An event as recorded, with who did it and when. */
export interface DetailEventInput extends StoryEventInput {
  actorType?: string | null;
  actorName?: string | null;
  createdAt?: string | null;
}

export interface DetailInput extends Omit<StoryInput, 'events'> {
  events?: DetailEventInput[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIELDS = 40;
const MAX_GROUPS = 10;
const MAX_LISTS = 6;
const LIST_ROWS = 8;
const LIST_COLUMNS = 6;
const VALUE_CHARS = 280;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** A key as words: "entityIds" and "entity_ids" both read "Entity ids". */
export function keyWords(key: string): string {
  const words = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= VALUE_CHARS) return flat;
  const space = flat.lastIndexOf(' ', VALUE_CHARS);
  return `${flat.slice(0, space > VALUE_CHARS / 2 ? space : VALUE_CHARS).trimEnd()}…`;
}

function numberWords(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** A value in a cell: short, plain, and never raw JSON. */
export function valueWords(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return numberWords(value);
  if (typeof value === 'string') {
    // A stored moment reads as a date and a time, to the minute.
    const moment = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]00:?00)$/.exec(value.trim());
    return moment ? `${moment[1]} ${moment[2]} UTC` : clip(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((entry) => typeof entry === 'string' && UUID.test(entry))) return `${value.length} ${value.length === 1 ? 'record' : 'records'}, by id`;
    if (value.every(isScalar)) {
      const shown = value.slice(0, 8).map(valueWords).join(', ');
      return clip(value.length > 8 ? `${shown}, and ${value.length - 8} more` : shown);
    }
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }
  const keys = Object.keys(record(value));
  return keys.length === 0 ? '—' : `${keys.length} ${keys.length === 1 ? 'value' : 'values'}`;
}

/** A record's id says nothing to a reader. It is left out of a table, and of a result's values. */
function isId(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value.trim());
}

const ID_KEY = /^(id|ids)$|(Id|Ids|_id|_ids)$/;
/** Columns that say what a row is come first, in this order. */
const LEADING = ['title', 'name', 'label', 'summary', 'headline', 'code'];

/** A cell of a list: a plain value, or a small group of them ("kind: number" reads "number"). */
function cellWords(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = Object.values(record(value)).filter((entry) => isScalar(entry) && entry !== null && entry !== '' && !isId(entry));
    if (inner.length > 0 && inner.length <= 3) return inner.map(valueWords).join(', ');
  }
  return valueWords(value);
}

function isCell(value: unknown): boolean {
  if (isScalar(value)) return value !== null && value !== '';
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(record(value)).some((entry) => isScalar(entry) && entry !== null && entry !== '');
}

/** A list of records as a table: the columns most rows fill, and the first `limit` rows. */
export function listOf(label: string, rows: unknown[], limit: number = LIST_ROWS): DetailList {
  const objects = rows.map(record);
  // The columns most rows fill with a plain value, in the order they first appear.
  const seen = new Map<string, number>();
  for (const row of objects.slice(0, 50)) {
    for (const [key, value] of Object.entries(row)) {
      if (isCell(value)) seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const filled = [...seen.entries()].filter(([, count]) => count >= Math.min(objects.length, 50) / 3).map(([key]) => key);
  const named = filled.filter((key) => !ID_KEY.test(key));
  // Stored results come back with their keys in alphabetical order, so the order they arrive in means nothing.
  const lead = (key: string) => (LEADING.indexOf(key) === -1 ? LEADING.length : LEADING.indexOf(key));
  const columns = (named.length > 0 ? named : filled).map((key, index) => ({ key, index })).sort((a, b) => lead(a.key) - lead(b.key) || a.index - b.index).map(({ key }) => key).slice(0, LIST_COLUMNS);
  return {
    label,
    count: rows.length,
    columns: columns.map(keyWords),
    rows: objects.slice(0, limit).map((row) => columns.map((key) => cellWords(row[key]))),
    more: Math.max(0, rows.length - limit),
  };
}

/** How a file's columns are filed: where each goes and how it is read, and the columns left out. */
export interface MappingView {
  rows: Array<{ column: string; goesTo: string; readAs: string; code: string | null }>;
  leftOut: string[];
}

const READ_AS: Record<string, string> = { trim: 'Text', number: 'Number', date: 'Date', percent: 'Percent', list: 'A value from a list' };

/**
 * A file load's column mappings as a person reads them. Null when the value is
 * not a list of column mappings, so a caller can fall back to a plain table.
 */
export function mappingView(value: unknown): MappingView | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const mappings = value.map(record);
  if (!mappings.every((mapping) => text(mapping.sourceColumn) && text(mapping.role))) return null;
  const view: MappingView = { rows: [], leftOut: [] };
  for (const mapping of mappings) {
    const column = text(mapping.sourceColumn);
    const role = text(mapping.role);
    const kind = text(mapping.domainCode) ? keyWords(text(mapping.domainCode)).toLowerCase() : 'record';
    if (role === 'ignore') {
      view.leftOut.push(column);
      continue;
    }
    const attribute = text(mapping.attributeCode);
    const goesTo =
      role === 'attribute' && attribute
        ? keyWords(attribute)
        : role === 'identity'
          ? `Identifies the ${kind}`
          : role === 'name'
            ? `Names the ${kind}`
            : role === 'alias'
              ? `Another name for the ${kind}`
              : role === 'parent'
                ? `Links the ${kind} to its ${text(mapping.parentDomainCode) ? keyWords(text(mapping.parentDomainCode)).toLowerCase() : 'parent'}`
                : role === 'as_of'
                  ? 'The date the values are as of'
                  : role === 'source'
                    ? 'The source of the values'
                    : role === 'filter'
                      ? `Keeps only rows where it is ${valueWords(mapping.filterEquals)}`
                      : keyWords(role);
    const transform = text(record(mapping.transform).kind);
    view.rows.push({ column, goesTo, readAs: READ_AS[transform] || (transform ? keyWords(transform) : '—'), code: role === 'attribute' && attribute ? attribute : null });
  }
  return view;
}

/**
 * A step's result as a person can read it: its plain values, each group of
 * values under its name, and each list as a count and its first rows. One
 * level of groups is laid out; anything deeper is counted, not drawn.
 */
export function resultView(output: unknown): ResultView | null {
  if (output === null || output === undefined) return null;
  if (Array.isArray(output)) return { fields: [], groups: [], lists: output.length > 0 && output.some((row) => !isScalar(row)) ? [listOf('Rows', output)] : [], };
  if (typeof output !== 'object') return { fields: [{ label: 'Result', value: valueWords(output) }], groups: [], lists: [] };
  const fields: DetailField[] = [];
  const groups: DetailGroup[] = [];
  const lists: DetailList[] = [];
  for (const [key, value] of Object.entries(record(output))) {
    const label = keyWords(key);
    if (Array.isArray(value) && value.length > 0 && value.some((row) => row && typeof row === 'object')) {
      if (lists.length < MAX_LISTS) lists.push(listOf(label, value));
      else fields.push({ label, value: valueWords(value) });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = Object.entries(record(value)).filter(([, innerValue]) => !isId(innerValue)).map(([innerKey, innerValue]) => ({ label: keyWords(innerKey), value: valueWords(innerValue) }));
      if (inner.length > 0 && groups.length < MAX_GROUPS) groups.push({ label, fields: inner.slice(0, MAX_FIELDS) });
      else fields.push({ label, value: valueWords(value) });
    } else if (!isId(value)) {
      fields.push({ label, value: valueWords(value) });
    }
  }
  if (fields.length === 0 && groups.length === 0 && lists.length === 0) return null;
  return { fields: fields.slice(0, MAX_FIELDS), groups, lists };
}

/** A placeholder in a step's settings, as words: "{{steps.select.entityIds}}" is what Select records returned. */
function placeholderWords(value: string, graph: WorkflowGraph): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.');
    if (parts[0] === 'steps' && parts.length >= 2) {
      const label = graph.nodes.find((node) => node.id === parts[1])?.label || parts[1];
      const rest = parts.slice(2).map(keyWords).join(' › ').toLowerCase();
      return rest ? `what “${label}” returned as ${rest}` : `what “${label}” returned`;
    }
    if (parts[0] === 'input') return `the run’s ${parts.slice(1).map(keyWords).join(' › ').toLowerCase() || 'input'}`;
    return path;
  });
}

function askedFields(args: Record<string, unknown>, graph: WorkflowGraph, designed: boolean): DetailField[] {
  const fields: DetailField[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(record(value))) {
        if (innerValue === null || innerValue === undefined || innerValue === '') continue;
        const words = valueWords(innerValue);
        fields.push({ label: `${keyWords(key)} › ${keyWords(innerKey).toLowerCase()}`, value: designed ? placeholderWords(words, graph) : words });
      }
      continue;
    }
    const words = valueWords(value);
    fields.push({ label: keyWords(key), value: designed ? placeholderWords(words, graph) : words });
  }
  return fields.slice(0, MAX_FIELDS);
}

const OPERATOR: Record<string, string> = { truthy: 'has something in it', empty: 'is empty', eq: 'equals', ne: 'does not equal', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };

/** A condition's test as a sentence: whether what "Financials on file" returned as borrowers has something in it. */
function conditionWords(config: Record<string, unknown>, graph: WorkflowGraph): string {
  const subject = placeholderWords(`{{${text(config.path)}}}`, graph);
  const op = text(config.op) || 'truthy';
  const compared = op === 'truthy' || op === 'empty' ? '' : ` ${valueWords(config.value)}`;
  return `Whether ${subject} ${OPERATOR[op] || op}${compared}`;
}

function whatOf(node: WorkflowNode, changesData: boolean): string {
  const base = nodeTypeDef(node.type)?.description || 'A step of the workflow.';
  if (node.type === 'tool') return changesData ? `${base} This one may change data.` : `${base} This one only reads.`;
  return base;
}

function byOf(actor: string | null | undefined): DetailEvent['by'] {
  return actor === 'AGENT' ? 'agent' : actor === 'USER' ? 'person' : 'system';
}

/** What an agent asked a tool for, in a few words. */
function aboutRead(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0))
    .slice(0, 4)
    .map(([key, value]) => (typeof value === 'string' && UUID.test(value) ? `${keyWords(key).toLowerCase().replace(/ id$/, '')} by id` : `${keyWords(key).toLowerCase()} ${valueWords(value)}`))
    .join(', ');
}

/** One step of a run, opened up. Null when the run has no such step. */
export function stepDetail(input: DetailInput, nodeId: string): StepDetail | null {
  const graph = input.graph;
  const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
  if (!graph || !node) return null;
  const events = input.events || [];
  const story = runStory({ ...input, events });
  const mark = input.steps.find((step) => step.nodeId === nodeId);
  const mine = events.filter((event) => event.nodeId === nodeId);
  // A step off the run's path (the other way out of a decision already made) is still a step of the design.
  const told: StoryStep = story.steps.find((step) => step.nodeId === nodeId) || { nodeId, label: node.label, kind: nodeTypeDef(node.type)?.kind || 'fixed', type: node.type, state: 'ahead', did: '', facts: [], decision: null, seconds: null, trouble: null, certain: false };
  const output = record(mark?.output);
  const ran = Boolean(mark);
  const tool = node.type === 'tool' ? text(node.config.tool) || null : null;
  const changesData = node.config.allowWrite === true || node.config.allowSend === true || node.type === 'apply';

  let asked: DetailField[] = [];
  let askedAsDesigned = false;
  if (node.type === 'tool') {
    const called = [...mine].reverse().find((event) => event.type === 'tool.called');
    const ranWith = record(record(called?.detail).args);
    askedAsDesigned = !called;
    asked = askedFields(called ? ranWith : record(node.config.args), graph, askedAsDesigned);
  } else if (node.type === 'branch') {
    asked = [{ label: 'Tested', value: conditionWords(node.config, graph) }];
  } else if (node.type === 'agent') {
    const tools = (Array.isArray(node.config.tools) ? node.config.tools : []).map(String);
    const proposable = (Array.isArray(node.config.proposable) ? node.config.proposable : []).map(String).filter((name) => name !== 'report-only');
    asked = [
      { label: 'May read with', value: tools.length > 0 ? tools.map(toolWords).join(', ') : 'No tool' },
      { label: 'May propose', value: proposable.length > 0 ? proposable.map((name) => name.replace(/_/g, ' ')).join(', ') : 'Nothing: it only reports' },
    ];
  } else if (node.type === 'apply') {
    const review = graph.nodes.find((candidate) => candidate.id === text(node.config.review));
    asked = [{ label: 'Makes the changes approved in', value: review ? `“${review.label}”` : 'the review before it' }];
  } else if (node.type === 'review') {
    const source = graph.nodes.find((candidate) => candidate.id === text(node.config.source));
    const who = [...(Array.isArray(node.config.people) ? node.config.people : []), ...(Array.isArray(node.config.roles) ? node.config.roles : [])].map(String).filter(Boolean);
    asked = [
      { label: 'Decides the changes proposed by', value: source ? `“${source.label}”` : 'the agent step before it' },
      { label: 'Goes to', value: who.length > 0 ? who.join(', ') : 'Anyone who may review' },
      { label: 'With nothing proposed', value: node.config.skipWhenEmpty === false ? 'It still waits for a person' : 'It is passed without a person' },
    ];
    if (text(node.config.instructions)) asked.push({ label: 'The reviewer is told', value: clip(text(node.config.instructions)) });
  } else if (node.type === 'form') {
    const fields = (Array.isArray(node.config.fields) ? node.config.fields : []).map(record);
    asked = [{ label: 'Asks for', value: fields.length > 0 ? fields.map((field) => text(field.label) || text(field.key)).filter(Boolean).join(', ') : 'Nothing yet' }];
    if (text(node.config.instructions)) asked.push({ label: 'The person is told', value: clip(text(node.config.instructions)) });
  }

  const isAgent = node.type === 'agent';
  const usageEvents = mine.filter((event) => event.type === 'agent.usage').map((event) => record(event.detail));
  const cost = usageEvents.reduce((sum, usage) => sum + (Number(usage.costUsd) || 0), 0);

  return {
    ...told,
    what: whatOf(node, changesData),
    tool,
    changesData,
    startedAt: mark?.startedAt || null,
    finishedAt: mark?.finishedAt || null,
    attempts: Number(mark?.attempts) || (ran ? 1 : 0),
    outcome: mark?.outcome || null,
    asked,
    askedAsDesigned,
    // An agent's result is its write-up and proposals, and an apply step's is its changes: each has its own place below.
    result: ran && !isAgent && node.type !== 'apply' && node.type !== 'branch' ? resultView(mark?.output) : null,
    summary: isAgent ? text(output.summary) || null : null,
    reads: mine
      .filter((event) => event.type === 'agent.tool')
      .map((event) => {
        const detail = record(event.detail);
        const name = text(detail.tool);
        return { tool: name, what: toolWords(name), about: aboutRead(record(detail.args)), ok: detail.ok !== false, at: event.createdAt || null };
      })
      .filter((read) => read.tool),
    proposals: isAgent
      ? (Array.isArray(record(output.proposal).items) ? (record(output.proposal).items as unknown[]) : []).map(record).map((item) => ({ summary: text(item.summary) || text(item.tool), confidence: text(item.confidence) || 'MEDIUM', needsReview: item.needsReview === true, tool: text(item.tool) }))
      : [],
    changes: node.type === 'apply' ? (Array.isArray(output.results) ? (output.results as unknown[]) : []).map(record).map((row) => ({ summary: text(row.summary) || text(row.tool) || 'A change', ok: row.ok === true, error: text(row.error) || null })) : [],
    usage: usageEvents.length > 0 ? { calls: usageEvents.length, model: text(usageEvents[usageEvents.length - 1].model) || null, costUsd: cost > 0 ? Math.round(cost * 100) / 100 : null } : null,
    history: mine.filter((event) => event.type !== 'agent.usage').map((event) => ({ at: event.createdAt || null, by: byOf(event.actorType), name: text(event.actorName) || null, summary: event.summary })),
    error: text(mark?.errorMessage) || null,
  };
}
