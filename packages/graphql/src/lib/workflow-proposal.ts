/**
 * Proposals: the changes an agent step wants made, and a person's decision on them.
 *
 * An agent cannot change data. It lists each change it wants: what is created,
 * edited, or deleted, the exact tool call that would do it, how sure it is, and
 * anything it could not find out. A person reviews the list. Only approved
 * changes run, with the reviewer's answers filled in.
 */

export type ProposalAction = 'CREATE' | 'UPDATE' | 'DELETE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Something the reviewer is asked to supply before a change can run. */
export interface MissingField {
  /** Where the answer goes in the tool call, for example "attributes.MATURITY_DATE". */
  key: string;
  label: string;
  question: string;
  required: boolean;
  dataType?: string;
  options?: string[];
  /** The agent's best guess, offered but not applied until the reviewer accepts it. */
  suggested?: unknown;
  /** FOUNDATION when the entity type requires it; AGENT when the agent asked. */
  origin: 'FOUNDATION' | 'AGENT';
}

export interface ProposalItem {
  id: string;
  action: ProposalAction;
  target: { kind: string; label: string; entityId?: string; domainCode?: string; templateCode?: string };
  /** One line a reviewer can read without opening the detail. */
  summary: string;
  tool: string;
  args: Record<string, unknown>;
  confidence: Confidence;
  /** True when the agent wants a person to look closely, or something is missing. */
  needsReview: boolean;
  rationale: string;
  evidence: string[];
  missing: MissingField[];
}

export interface Proposal {
  items: ProposalItem[];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function actionFor(tool: string, given: unknown): ProposalAction {
  const upper = text(given).toUpperCase();
  if (upper === 'CREATE' || upper === 'UPDATE' || upper === 'DELETE') return upper;
  if (/^(create_|start_)/.test(tool)) return 'CREATE';
  if (/^delete_/.test(tool)) return 'DELETE';
  return 'UPDATE';
}

/**
 * Cleans what an agent sent into proposal items. Items without a tool are
 * dropped: a change nobody can run is not a proposal. `existing` are the items
 * already proposed in this step, so ids stay unique.
 */
export function normalizeItems(raw: unknown, existing: ProposalItem[] = []): ProposalItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const used = new Set(existing.map((item) => item.id));
  const items: ProposalItem[] = [];
  for (const entry of list) {
    const row = record(entry);
    const tool = text(row.tool);
    if (!tool) continue;
    const target = record(row.target);
    const confidenceRaw = text(row.confidence).toUpperCase();
    const confidence: Confidence = confidenceRaw === 'HIGH' || confidenceRaw === 'LOW' ? confidenceRaw : 'MEDIUM';
    const missing: MissingField[] = (Array.isArray(row.missing) ? row.missing : [])
      .map((field) => record(field))
      .filter((field) => text(field.key))
      .map((field) => ({
        key: text(field.key),
        label: text(field.label) || text(field.key),
        question: text(field.question) || `What should ${text(field.label) || text(field.key)} be?`,
        required: field.required !== false,
        ...(text(field.dataType) ? { dataType: text(field.dataType) } : {}),
        ...(Array.isArray(field.options) ? { options: field.options.map(String) } : {}),
        ...(field.suggested !== undefined && field.suggested !== null ? { suggested: field.suggested } : {}),
        origin: 'AGENT' as const,
      }));
    let id = text(row.id) || `c${existing.length + items.length + 1}`;
    while (used.has(id)) id = `${id}-${used.size}`;
    used.add(id);
    items.push({
      id,
      action: actionFor(tool, row.action),
      target: {
        kind: text(target.kind) || 'Record',
        label: text(target.label) || text(row.summary) || tool,
        ...(text(target.entityId) ? { entityId: text(target.entityId) } : {}),
        ...(text(target.domainCode) ? { domainCode: text(target.domainCode) } : {}),
        ...(text(target.templateCode) ? { templateCode: text(target.templateCode) } : {}),
      },
      summary: text(row.summary) || `${tool}`,
      tool,
      args: record(row.args),
      confidence,
      needsReview: row.needsReview === true || confidence === 'LOW' || missing.some((field) => field.required),
      rationale: text(row.rationale),
      evidence: (Array.isArray(row.evidence) ? row.evidence : []).map((line) => text(line)).filter(Boolean),
      missing,
    });
  }
  return items;
}

/** One attribute an entity type expects. */
export interface FoundationAttribute {
  code: string;
  name: string;
  dataType?: string;
  required: boolean;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/**
 * Checks a proposed creation against what its entity type requires. Each
 * required attribute the agent did not supply becomes a question for the
 * reviewer, and the item is marked for review. Asking is not left to the
 * agent: a required field it overlooked is still caught here.
 */
export function withFoundationGaps(item: ProposalItem, attributes: FoundationAttribute[]): ProposalItem {
  if (item.action !== 'CREATE') return item;
  const supplied = record(item.args.attributes);
  const asked = new Set(item.missing.map((field) => field.key));
  const gaps: MissingField[] = [];
  for (const attribute of attributes) {
    if (!attribute.required) continue;
    const key = `attributes.${attribute.code}`;
    if (present(supplied[attribute.code])) continue;
    if (asked.has(key)) continue;
    gaps.push({
      key,
      label: attribute.name || attribute.code,
      question: `${attribute.name || attribute.code} is required for this type of record. What should it be?`,
      required: true,
      ...(attribute.dataType ? { dataType: attribute.dataType } : {}),
      origin: 'FOUNDATION',
    });
  }
  // A question the agent asked about a required attribute is required, whatever the agent said.
  const requiredKeys = new Set(attributes.filter((attribute) => attribute.required).map((attribute) => `attributes.${attribute.code}`));
  const missing = [
    ...item.missing.map((field) => (requiredKeys.has(field.key) && !present(supplied[field.key.slice('attributes.'.length)]) ? { ...field, required: true } : field)),
    ...gaps,
  ];
  if (gaps.length === 0 && missing.every((field, index) => field === item.missing[index])) return item;
  return { ...item, missing, needsReview: true };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface ItemDecision {
  decision: 'APPROVE' | 'REJECT';
  /** Answers to the item's missing fields, by key. */
  answers?: Record<string, unknown>;
  /** The reviewer's replacement for the tool call's settings, when they edited them. */
  args?: Record<string, unknown>;
  note?: string;
}

export interface ReviewDecision {
  items: Record<string, ItemDecision>;
  note?: string;
}

export function asDecision(value: unknown): ReviewDecision {
  const raw = record(value);
  const items: Record<string, ItemDecision> = {};
  for (const [id, entry] of Object.entries(record(raw.items))) {
    const row = record(entry);
    items[id] = {
      decision: row.decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
      ...(row.answers && typeof row.answers === 'object' ? { answers: record(row.answers) } : {}),
      ...(row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? { args: record(row.args) } : {}),
      ...(text(row.note) ? { note: text(row.note) } : {}),
    };
  }
  return { items, ...(text(raw.note) ? { note: text(raw.note) } : {}) };
}

const UNSAFE_KEY = new Set(['__proto__', 'prototype', 'constructor']);

/** Sets a value at a dotted path, creating objects on the way. Returns a copy. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => UNSAFE_KEY.has(part))) return target;
  const copy: Record<string, unknown> = { ...target };
  let cursor = copy;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = record(cursor[parts[index]]);
    cursor[parts[index]] = { ...next };
    cursor = cursor[parts[index]] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return copy;
}

/** The required questions on an item that the decision leaves unanswered. */
export function unanswered(item: ProposalItem, decision: ItemDecision | undefined): MissingField[] {
  const answers = decision?.answers || {};
  return item.missing.filter((field) => field.required && !present(answers[field.key]));
}

/** The tool call for an approved item: the reviewer's edits, then their answers. */
export function finalArgs(item: ProposalItem, decision: ItemDecision): Record<string, unknown> {
  let args = decision.args ? { ...decision.args } : { ...item.args };
  for (const field of item.missing) {
    const answer = decision.answers?.[field.key];
    if (present(answer)) args = setPath(args, field.key, answer);
  }
  return args;
}

export interface DecisionCheck {
  ok: boolean;
  problems: string[];
  approved: string[];
  rejected: string[];
}

/**
 * Whether a decision can be recorded. Every item needs a choice, and an
 * approved item needs its required questions answered. An approval cannot swap
 * in a different tool: the reviewer approves the change that was proposed.
 */
export function checkDecision(proposal: Proposal, decision: ReviewDecision): DecisionCheck {
  const problems: string[] = [];
  const approved: string[] = [];
  const rejected: string[] = [];
  for (const item of proposal.items) {
    const choice = decision.items[item.id];
    if (!choice) {
      problems.push(`"${item.summary}" has not been approved or rejected.`);
      continue;
    }
    if (choice.decision === 'REJECT') {
      rejected.push(item.id);
      continue;
    }
    const open = unanswered(item, choice);
    if (open.length > 0) {
      problems.push(`"${item.summary}" still needs: ${open.map((field) => field.label).join(', ')}.`);
      continue;
    }
    approved.push(item.id);
  }
  return { ok: problems.length === 0, problems, approved, rejected };
}

export interface ProposalCounts {
  total: number;
  confident: number;
  needsReview: number;
  creates: number;
  updates: number;
  deletes: number;
  questions: number;
}

export function proposalCounts(proposal: Proposal): ProposalCounts {
  const items = proposal.items;
  return {
    total: items.length,
    confident: items.filter((item) => !item.needsReview).length,
    needsReview: items.filter((item) => item.needsReview).length,
    creates: items.filter((item) => item.action === 'CREATE').length,
    updates: items.filter((item) => item.action === 'UPDATE').length,
    deletes: items.filter((item) => item.action === 'DELETE').length,
    questions: items.reduce((sum, item) => sum + item.missing.filter((field) => field.required).length, 0),
  };
}

export function asProposal(value: unknown): Proposal {
  const raw = record(value);
  const items = (Array.isArray(raw.items) ? raw.items : []).filter((item) => item && typeof item === 'object') as ProposalItem[];
  return {
    items: items.map((item) => ({
      ...item,
      args: record(item.args),
      target: { kind: 'Record', label: '', ...record(item.target) } as ProposalItem['target'],
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      missing: Array.isArray(item.missing) ? item.missing : [],
    })),
  };
}
