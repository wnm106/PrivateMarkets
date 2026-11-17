import type { WorkflowGraph, WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';

/**
 * Comparing two versions of a workflow, and moving a workflow between
 * environments as a file.
 */

export interface StepChange {
  id: string;
  label: string;
  /** Settings that differ, by name. */
  settings: string[];
  renamed: boolean;
}

export interface GraphDiff {
  added: WorkflowNode[];
  removed: WorkflowNode[];
  changed: StepChange[];
  connectionsAdded: string[];
  connectionsRemoved: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function edgeName(graph: WorkflowGraph, edge: { from: string; to: string; when?: string }): string {
  const label = (id: string) => graph.nodes.find((node) => node.id === id)?.label || id;
  return `${label(edge.from)} → ${label(edge.to)}${edge.when ? ` (${edge.when})` : ''}`;
}

/** What changed from `before` to `after`. Steps are matched by id; where they sit on the canvas is not a change. */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): GraphDiff {
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const now = new Map(after.nodes.map((node) => [node.id, node]));
  const changed: StepChange[] = [];
  for (const node of after.nodes) {
    const previous = old.get(node.id);
    if (!previous) continue;
    const keys = [...new Set([...Object.keys(previous.config), ...Object.keys(node.config)])].sort();
    const settings = keys.filter((key) => !same(previous.config[key], node.config[key]));
    if (previous.type !== node.type) settings.unshift('type');
    const renamed = previous.label !== node.label;
    if (settings.length > 0 || renamed) changed.push({ id: node.id, label: node.label, settings, renamed });
  }
  const key = (edge: { from: string; to: string; when?: string }) => `${edge.from}>${edge.to}>${edge.when || ''}`;
  const oldEdges = new Set(before.edges.map(key));
  const newEdges = new Set(after.edges.map(key));
  return {
    added: after.nodes.filter((node) => !old.has(node.id)),
    removed: before.nodes.filter((node) => !now.has(node.id)),
    changed,
    connectionsAdded: after.edges.filter((edge) => !oldEdges.has(key(edge))).map((edge) => edgeName(after, edge)),
    connectionsRemoved: before.edges.filter((edge) => !newEdges.has(key(edge))).map((edge) => edgeName(before, edge)),
  };
}

export function diffIsEmpty(diff: GraphDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length + diff.connectionsAdded.length + diff.connectionsRemoved.length === 0;
}

export const EXPORT_FORMAT = 'tapestrai.workflow';

export interface WorkflowExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: 1;
  code: string;
  name: string;
  description: string | null;
  exportedFromVersion: number | null;
  exportedAt: string;
  graph: WorkflowGraph;
}

/**
 * A workflow as a file, to import in another environment. Who a review is
 * assigned to names people by id, which differ between environments, so
 * named people are left out; roles are kept, since role codes are shared.
 */
export function exportWorkflow(input: { code: string; name: string; description: string | null; version: number | null; graph: WorkflowGraph }, now = new Date()): WorkflowExport {
  return {
    format: EXPORT_FORMAT,
    formatVersion: 1,
    code: input.code,
    name: input.name,
    description: input.description,
    exportedFromVersion: input.version,
    exportedAt: now.toISOString(),
    graph: {
      nodes: input.graph.nodes.map((node) => (Array.isArray(node.config.people) && node.config.people.length > 0 ? { ...node, config: { ...node.config, people: [] } } : node)),
      edges: input.graph.edges,
    },
  };
}

/** Reads an exported file, or says why it is not one. */
export function readExport(text: string): { ok: true; value: WorkflowExport } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The file is not JSON.' };
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (raw.format !== EXPORT_FORMAT) return { ok: false, message: 'The file is not an exported workflow.' };
  if (raw.formatVersion !== 1) return { ok: false, message: `The file is format version ${String(raw.formatVersion)}, which this version does not read.` };
  const graph = raw.graph && typeof raw.graph === 'object' ? (raw.graph as WorkflowGraph) : null;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { ok: false, message: 'The file has no steps.' };
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { ok: false, message: 'The file has no workflow name.' };
  return {
    ok: true,
    value: {
      format: EXPORT_FORMAT,
      formatVersion: 1,
      code: typeof raw.code === 'string' ? raw.code : '',
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : null,
      exportedFromVersion: typeof raw.exportedFromVersion === 'number' ? raw.exportedFromVersion : null,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      graph,
    },
  };
}

/** A code that is not taken: the code, or the code with _2, _3, ... */
export function freeCode(code: string, taken: ReadonlySet<string>): string {
  const base = (code || 'IMPORTED_WORKFLOW').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'IMPORTED_WORKFLOW';
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${base}_${index}`;
  return candidate;
}

/** 95 seconds to "1m 35s", 7200 to "2h", 200000 to "2d 7h". */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86400)}d${Math.round((s % 86400) / 3600) ? ` ${Math.round((s % 86400) / 3600)}h` : ''}`;
}
