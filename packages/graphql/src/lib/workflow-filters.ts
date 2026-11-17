/**
 * Which records a workflow run works on.
 *
 * A workflow says what is done. It does not say to which records: that is
 * given when a run starts, as `filters` in the run's input, in the same shape
 * for every workflow. A "Select records" step turns the filters into a list,
 * and the steps after it work on that list.
 *
 * No filters means no restriction: the run covers every record its steps
 * apply to. Filters that match nothing mean the run has nothing to do. The two
 * are kept apart all the way down, so an empty match is never read as "all".
 */

export interface RecordFilters {
  /** The type of record: FUND, POSITION, ISSUER. */
  domainCode: string | null;
  entityCodes: string[];
  entityIds: string[];
  /** Part of the record's name, in any case. */
  nameContains: string | null;
  limit: number;
}

export const DEFAULT_FILTER_LIMIT = 100;
export const MAX_FILTER_LIMIT = 500;

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function word(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Cleans what a run was started with. Codes may be given as a list or as text separated by commas. */
export function parseFilters(raw: unknown): RecordFilters {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const limit = Math.trunc(Number(row.limit));
  return {
    domainCode: word(row.domainCode)?.toUpperCase() ?? null,
    entityCodes: list(row.entityCodes),
    entityIds: list(row.entityIds),
    nameContains: word(row.nameContains),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_FILTER_LIMIT) : DEFAULT_FILTER_LIMIT,
  };
}

/** Whether the filters restrict anything. A limit alone does not. */
export function hasFilters(filters: RecordFilters): boolean {
  return Boolean(filters.domainCode || filters.nameContains || filters.entityCodes.length > 0 || filters.entityIds.length > 0);
}

/** The filters in words, for the run's history. */
export function describeFilters(filters: RecordFilters): string {
  if (!hasFilters(filters)) return 'every record';
  const parts: string[] = [];
  if (filters.domainCode) parts.push(`type ${filters.domainCode}`);
  if (filters.entityCodes.length > 0) parts.push(`code ${filters.entityCodes.join(', ')}`);
  if (filters.entityIds.length > 0) parts.push(`${filters.entityIds.length} record id${filters.entityIds.length === 1 ? '' : 's'}`);
  if (filters.nameContains) parts.push(`name containing "${filters.nameContains}"`);
  return parts.join('; ');
}

/**
 * The record ids a step was given, read from a tool's settings.
 * null: nothing was given, so there is no restriction.
 * []:   a selection was given and it is empty, so there is nothing to work on.
 */
export function selectedIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  return list(value);
}

// ---------------------------------------------------------------------------
// What a workflow asks for when a run starts
// ---------------------------------------------------------------------------

/** Something a run is asked for besides its records: a period end, a limit. */
export interface RunInputField {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number';
  help?: string;
}

/**
 * What a workflow needs to start, kept on its Start step. This is not a filter:
 * it names no record. It says what kind of record the workflow is about, so a
 * run can be offered the right records and refused the wrong ones.
 */
export interface RunSetup {
  /** The type of record the workflow works on. Null when it works on any. */
  appliesTo: string | null;
  /** True when a run with no records chosen makes no sense. */
  requiresRecords: boolean;
  inputs: RunInputField[];
}

const INPUT_TYPES = ['text', 'date', 'number'];
const RESERVED_INPUT = new Set(['filters', '__proto__', 'prototype', 'constructor']);

export function parseRunSetup(config: unknown): RunSetup {
  const row = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const inputs: RunInputField[] = [];
  for (const entry of Array.isArray(row.inputs) ? row.inputs : []) {
    const field = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const key = word(field.key);
    if (!key || !/^[A-Za-z][\w]*$/.test(key) || RESERVED_INPUT.has(key) || seen.has(key)) continue;
    seen.add(key);
    const type = INPUT_TYPES.includes(String(field.type)) ? (field.type as RunInputField['type']) : 'text';
    inputs.push({ key, label: word(field.label) || key, type, ...(word(field.help) ? { help: word(field.help) as string } : {}) });
  }
  return { appliesTo: word(row.appliesTo)?.toUpperCase() ?? null, requiresRecords: row.requiresRecords === true, inputs };
}

/** The setup of a graph: the settings of its Start step. */
export function runSetupOf(graph: { nodes: Array<{ type: string; config: Record<string, unknown> }> } | null | undefined): RunSetup {
  return parseRunSetup(graph?.nodes.find((node) => node.type === 'start')?.config);
}

/**
 * Checks what a run is started with against what the workflow is about, and
 * returns the input the run gets. Records of the wrong type are refused here,
 * before the run exists, instead of matching nothing halfway through.
 */
export function prepareRunInput(setup: RunSetup, input: unknown): { input: Record<string, unknown> } | { problem: string } {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  const filters = parseFilters(given.filters);
  const filtered = hasFilters(filters);
  if (setup.requiresRecords && !filtered) return { problem: 'Choose the records to run this workflow on. It does not run on everything.' };
  if (setup.appliesTo && filters.domainCode && filters.domainCode !== setup.appliesTo) {
    return { problem: `This workflow runs on ${setup.appliesTo} records, not ${filters.domainCode}.` };
  }
  if (!filtered) return { input: given };
  const raw = given.filters && typeof given.filters === 'object' && !Array.isArray(given.filters) ? (given.filters as Record<string, unknown>) : {};
  // Chosen records are held to the workflow's type, so a record of another type is reported as not found.
  return { input: { ...given, filters: { ...raw, ...(setup.appliesTo ? { domainCode: setup.appliesTo } : {}) } } };
}

/** The input a run starts with, from what a person chose: records, or all of them, and the other values asked for. */
export function buildRunInput(
  setup: RunSetup,
  choice: { entityIds: string[]; domainCode?: string | null; all: boolean },
  values: Record<string, string> = {},
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const domainCode = setup.appliesTo || word(choice.domainCode)?.toUpperCase() || null;
  if (!choice.all && choice.entityIds.length > 0) input.filters = { ...(domainCode ? { domainCode } : {}), entityIds: [...new Set(choice.entityIds)] };
  // Every record of a type the person picked. A workflow with a type of its own needs no filter for that.
  else if (choice.all && domainCode && !setup.appliesTo) input.filters = { domainCode };
  for (const field of setup.inputs) {
    const value = (values[field.key] ?? '').trim();
    if (!value) continue;
    input[field.key] = field.type === 'number' && Number.isFinite(Number(value)) ? Number(value) : value;
  }
  return input;
}
