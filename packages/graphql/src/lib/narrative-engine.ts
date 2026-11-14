/**
 * Narrative framework (v2) -- evidence gathering.
 *
 * Runs one section's declared data as the CALLER (RLS applies): every query at
 * every as-of comparison date, derived measures, deterministic screens, scenarios,
 * and a coverage report that tells the composer what is genuinely missing.
 * No model is called here. The app runner and the MCP server both use this, so a
 * section produces the same evidence whoever composes it.
 */
import {
  DEFAULT_ROW_LIMIT,
  getAttributeCatalog,
  resolveEntityId,
  runDataQueries,
  runGrid,
  specToGridRequest,
  validateDataQueries,
  type DataQuerySpec,
} from './data-query-engine';
import {
  applyMeasures,
  computeCoverage,
  evaluateScenarios,
  evaluateScreens,
  narrativeSections,
  renderTemplate,
  resolveAsOfSet,
  validateNarrativeSpec,
  type Coverage,
  type NarrativeBlock,
  type NarrativeSection,
  type NarrativeSpec,
  type ResolvedAsOf,
  type Row,
  type ScenarioResult,
  type ScreenResult,
} from './narrative-spec';

/** Hard ceiling on rows pulled for one query, however large the book. */
export const MAX_EVIDENCE_ROWS = 5000;
const PAGE = 500;

export interface DatasetEvidence {
  key: string;
  label?: string;
  asOfLabel: string;
  asOfDate: string | null;
  mode: 'rows' | 'aggregate';
  columns: string[];
  rows: Row[];
  matched: number;
  total: number;
  truncated: boolean;
  summary?: Record<string, unknown> | null;
  /** Sum of each SUM metric over every group, when the groups are complete. */
  totals?: Record<string, number>;
  error?: string;
  coverage?: Coverage;
}

/** Adds "<metric>_share" (a fraction of the total over all groups) to each group row. Needs complete groups. */
export function addShares(rows: Row[], aliases: string[]): { rows: Row[]; totals: Record<string, number> } {
  const totals: Record<string, number> = {};
  for (const alias of aliases) {
    const sum = rows.reduce((n, r) => n + (Number.isFinite(Number(r[alias])) && r[alias] !== null ? Number(r[alias]) : 0), 0);
    if (sum > 0) totals[alias] = sum;
  }
  if (!Object.keys(totals).length) return { rows, totals };
  return {
    totals,
    rows: rows.map((r) => {
      const next: Row = { ...r };
      for (const [alias, sum] of Object.entries(totals)) {
        const v = r[alias];
        next[`${alias}_share`] = v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v) / sum;
      }
      return next;
    }),
  };
}

export interface SectionEvidence {
  sectionKey: string;
  entity: Record<string, any> | null;
  asOfDate: string;
  asOf: ResolvedAsOf[];
  /** Keyed by query key for the primary date and "<key>@<label>" for the others. */
  datasets: Record<string, DatasetEvidence>;
  screens: ScreenResult[];
  scenarios: ScenarioResult[];
  measures: Array<{ query: string; alias: string; label?: string; unit?: string }>;
  /** Things the composer must say plainly: errors, empty columns, truncation, unplaced dates. */
  notes: string[];
}

export interface SectionRunContext {
  entityId?: string | null;
  entityCode?: string | null;
  asOfDate?: string | null;
  params?: Record<string, unknown>;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Builds a spec from a narrative_templates row. */
export function narrativeSpecFromRow(r: any): NarrativeSpec & { id?: string; narrativeCode?: string; model?: string | null } {
  return {
    id: r.id,
    narrativeCode: r.narrative_code,
    narrativeName: r.narrative_name,
    description: r.description ?? undefined,
    domainCode: r.domain_code,
    exposedDomains: r.exposed_domains ?? [],
    persona: r.persona ?? undefined,
    audience: r.audience ?? undefined,
    rules: Array.isArray(r.rules) ? r.rules : [],
    allowExternalSearch: !!r.allow_external_search,
    parameters: r.parameters ?? [],
    sections: Array.isArray(r.sections) ? r.sections : [],
    instructions: r.instructions ?? '',
    dataQueries: r.data_queries ?? [],
    outputBlocks: r.output_blocks ?? [],
    model: r.model,
  };
}

/** Structural validation of a whole narrative, including every section's queries and expressions. */
export function validateNarrative(spec: NarrativeSpec): string[] {
  return validateNarrativeSpec(spec, validateDataQueries);
}

export async function fetchQueryRows(
  supabase: any,
  spec: DataQuerySpec,
  anchorId: string | null,
  params: Record<string, unknown>,
  asOf: string | null,
  catalogCache: Map<string, any[]>,
): Promise<Omit<DatasetEvidence, 'asOfLabel' | 'asOfDate' | 'key' | 'label'>> {
  const want = Math.min(Math.max(spec.limit ?? DEFAULT_ROW_LIMIT, 1), MAX_EVIDENCE_ROWS);
  const req = specToGridRequest({ ...spec, limit: Math.min(want, PAGE) }, anchorId, params, asOf, null);
  const aggregate = !!req.flat;

  if (!aggregate && !spec.select) {
    const lastHop = (spec.path || [])[(spec.path || []).length - 1];
    const domain = spec.domainCode || lastHop?.domainCode || null;
    const cacheKey = domain || '*';
    if (!catalogCache.has(cacheKey)) catalogCache.set(cacheKey, await getAttributeCatalog(supabase, domain));
    req.columns = (catalogCache.get(cacheKey) || [])
      .filter((a) => a.is_visible !== false)
      .slice(0, 25)
      .map((a) => a.attribute_code);
  }

  const rows: Row[] = [];
  let matched = 0;
  let total = 0;
  let summary: Record<string, unknown> | null = null;
  for (let offset = 0; rows.length < want; offset += PAGE) {
    const res = await runGrid(supabase, { ...req, offset, limit: Math.min(PAGE, want - rows.length) });
    const page = res.rows || [];
    matched = res.matched;
    total = res.total;
    if (offset === 0) summary = res.summary ?? null;
    rows.push(...page);
    if (!page.length || rows.length >= total) break;
  }

  const columns = aggregate
    ? [...(req.groupBy || []), ...(req.metrics?.length ? req.metrics.map((m) => m.alias) : ['count'])]
    : ['entity_code', 'entity_name', 'domain_code', ...(req.columns || [])];
  return { mode: aggregate ? 'aggregate' : 'rows', columns, rows, matched, total, truncated: total > rows.length, summary };
}

/** Gathers everything one section declares. Never throws for a single failing query. */
export async function runSectionData(
  supabase: any,
  narrative: NarrativeSpec,
  section: NarrativeSection,
  ctx: SectionRunContext,
): Promise<SectionEvidence> {
  const params = { ...(ctx.params || {}) };
  const asOfDate = (ctx.asOfDate || (params.asOfDate as string) || todayIso()).slice(0, 10);
  const asOf = resolveAsOfSet(section.comparisons, asOfDate, params);
  const notes: string[] = [];
  const catalogCache = new Map<string, any[]>();

  const anchorId = await resolveEntityId(supabase, ctx.entityId, ctx.entityCode);
  const anchorResponse = ctx.entityId || ctx.entityCode
    ? await runDataQueries(supabase, [], { entityId: anchorId, entityCode: ctx.entityCode, params, asOfDate })
    : null;
  if ((ctx.entityId || ctx.entityCode) && !anchorResponse?.anchor) notes.push('The context entity could not be found or is not accessible.');

  const datasets: Record<string, DatasetEvidence> = {};
  const queries = section.dataQueries ?? [];
  const measuresByQuery = new Map<string, NonNullable<NarrativeSection['measures']>>();
  for (const m of section.measures ?? []) {
    measuresByQuery.set(m.query, [...(measuresByQuery.get(m.query) ?? []), m]);
  }

  for (const [index, point] of asOf.entries()) {
    if (!point.date) {
      notes.push(`${point.label}: data not available (${point.reason ?? 'date could not be resolved'}).`);
      continue;
    }
    for (const q of queries) {
      const key = index === 0 ? q.key : `${q.key}@${point.label}`;
      const base = { key, label: q.label, asOfLabel: point.label, asOfDate: point.date };
      try {
        const fetched = await fetchQueryRows(supabase, q, anchorId, { ...params, asOfDate: point.date }, point.date, catalogCache);
        let rows = fetched.rows;
        const m = measuresByQuery.get(q.key);
        const columns = [...fetched.columns];
        // Shares and totals are computed here, once and exactly, so a composer quotes them instead of dividing.
        let totals: Record<string, number> | undefined;
        if (fetched.mode === 'aggregate' && !fetched.truncated) {
          const shared = addShares(rows, (q.metrics ?? []).filter((x) => x.agg === 'SUM').map((x) => x.alias));
          rows = shared.rows;
          totals = shared.totals;
          columns.push(...Object.keys(shared.totals).map((alias) => `${alias}_share`));
        }
        if (m?.length) {
          const applied = applyMeasures(rows, m);
          rows = applied.rows;
          notes.push(...applied.errors);
          columns.push(...m.map((x) => x.alias));
        }
        datasets[key] = { ...base, ...fetched, rows, columns, ...(totals && Object.keys(totals).length ? { totals } : {}), coverage: computeCoverage(rows, columns) };
      } catch (e: any) {
        datasets[key] = {
          ...base, mode: 'rows', columns: [], rows: [], matched: 0, total: 0, truncated: false,
          error: e?.message || String(e),
        };
        notes.push(`${key}: ${e?.message || e}`);
      }
    }
  }

  const primary: Record<string, Row[]> = {};
  for (const q of queries) if (datasets[q.key] && !datasets[q.key].error) primary[q.key] = datasets[q.key].rows;
  const screens = evaluateScreens(primary, section.screens ?? []);
  const scenarios = evaluateScenarios(primary, section.scenarios ?? []);
  notes.push(...screens.errors, ...scenarios.errors);

  for (const d of Object.values(datasets)) {
    if (d.truncated) notes.push(`${d.key}: only ${d.rows.length} of ${d.total} rows were retrieved. Do not add the rows up; use summary or aggregate figures.`);
    if (d.coverage?.empty.length) notes.push(`${d.key}: no value on any row for ${d.coverage.empty.join(', ')}. Report these as data not available.`);
  }
  for (const s of screens.results) {
    if (s.notEvaluable) notes.push(`Screen "${s.label}" could not be tested on ${s.notEvaluable} of ${s.notEvaluable + s.evaluated} rows because an input was missing.`);
  }

  return {
    sectionKey: section.key,
    entity: anchorResponse?.anchor ?? null,
    asOfDate,
    asOf,
    datasets,
    screens: screens.results,
    scenarios: scenarios.results,
    measures: (section.measures ?? []).map((m) => ({ query: m.query, alias: m.alias, label: m.label, unit: m.unit })),
    notes: Array.from(new Set(notes)),
  };
}

/** The evidence a model sees: rows capped, coverage reduced to the facts that matter. */
export function compactEvidence(evidence: SectionEvidence, maxRows = 120, only?: { query: string; rows: Row[] }): Record<string, unknown> {
  const datasets: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(evidence.datasets)) {
    const rows = only && key === only.query ? only.rows : d.rows.slice(0, maxRows);
    datasets[key] = {
      label: d.label,
      asOf: `${d.asOfLabel}${d.asOfDate ? ` (${d.asOfDate})` : ''}`,
      columns: d.columns,
      matchedEntities: d.matched,
      totalRows: d.total,
      rowsShown: rows.length,
      truncated: d.truncated || d.rows.length > rows.length,
      summaryOverAllMatched: d.summary ?? undefined,
      totalsOverAllGroups: d.totals,
      emptyColumns: d.coverage?.empty?.length ? d.coverage.empty : undefined,
      error: d.error,
      rows,
    };
  }
  return {
    entity: evidence.entity,
    asOfDate: evidence.asOfDate,
    comparisons: evidence.asOf,
    datasets,
    screens: evidence.screens,
    scenarios: evidence.scenarios,
    derivedMeasures: evidence.measures,
    mustDisclose: evidence.notes,
  };
}

/** Sections a template exposes, with their run order, for runners and the MCP blueprint. */
export function narrativePlan(spec: NarrativeSpec): { sections: NarrativeSection[]; order: string[] } {
  const sections = narrativeSections(spec);
  const keys = new Set(sections.map((s) => s.key));
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (s: NarrativeSection, trail: string[]) => {
    if (done.has(s.key) || trail.includes(s.key)) return;
    for (const dep of s.dependsOn ?? []) {
      const found = keys.has(dep) ? sections.find((x) => x.key === dep) : undefined;
      if (found) visit(found, [...trail, s.key]);
    }
    done.add(s.key);
    order.push(s.key);
  };
  sections.forEach((s) => visit(s, []));
  return { sections, order };
}

// ---------------------------------------------------------------------------
// Research prompts
// ---------------------------------------------------------------------------

const NAME_COLUMNS = ['iss.entity_name', 'issuer', 'borrower', 'company', 'entity_name'];

/** Values a section's research queries may use: {{entity_name}}, {{asOfDate}}, {{names}}, {{industries}}. */
export function researchVariables(evidence: SectionEvidence, batchRows?: Row[]): Record<string, string> {
  const vars: Record<string, string> = {
    entity_name: String(evidence.entity?.entityName ?? ''),
    entity_code: String(evidence.entity?.entityCode ?? ''),
    asOfDate: evidence.asOfDate,
    names: '',
    industries: '',
  };
  if (batchRows?.length) {
    vars.names = batchRows
      .map((r) => NAME_COLUMNS.map((c) => r[c]).find((v) => typeof v === 'string' && v.trim()))
      .filter(Boolean)
      .join('; ');
  }
  const aggregate = Object.values(evidence.datasets).find(
    (d) => d.mode === 'aggregate' && !d.error && /industry/i.test(d.columns[0] ?? ''),
  ) ?? Object.values(evidence.datasets).find((d) => d.mode === 'aggregate' && !d.error);
  if (aggregate) {
    const col = aggregate.columns[0];
    vars.industries = Array.from(new Set(aggregate.rows.map((r) => r[col]).filter((v) => typeof v === 'string' && v.trim())))
      .slice(0, 8)
      .join('; ');
  }
  return vars;
}

/** Research queries with their placeholders filled. A query whose placeholder has no value is dropped. */
export function researchQueries(section: NarrativeSection, evidence: SectionEvidence, batchRows?: Row[]): string[] {
  const vars = researchVariables(evidence, batchRows);
  return (section.research?.queries ?? []).flatMap((template) => {
    const names = Array.from(template.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)).map((m) => m[1]);
    if (names.some((n) => !vars[n])) return [];
    return [renderTemplate(template, vars)];
  });
}

// ---------------------------------------------------------------------------
// Assembling a run from its sections
// ---------------------------------------------------------------------------

export interface RunSectionRow {
  section_key: string;
  ord?: number;
  title?: string | null;
  status: string;
  blocks?: unknown;
  verification?: { checked?: number; matched?: number; unmatched?: Array<{ block: string; figure: string }> } | null;
}

export interface AssembledRun {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  blocks: NarrativeBlock[];
  sources: unknown[];
  verification: { checked: number; matched: number; notTraced: Array<{ section: string; block: string; figure: string }> };
  missing: string[];
  completed: number;
}

/** One report from its saved sections, in display order: a heading, then each section's blocks keyed "<section>.<block>". */
export function assembleRun(rows: RunSectionRow[]): AssembledRun {
  const list = [...rows].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  const done = list.filter((r) => r.status === 'COMPLETED');
  const missing = list.filter((r) => r.status !== 'COMPLETED').map((r) => r.section_key);
  const blocks: NarrativeBlock[] = [];
  const sources: unknown[] = [];
  let checked = 0;
  let matched = 0;
  const notTraced: AssembledRun['verification']['notTraced'] = [];
  for (const r of done) {
    blocks.push({ type: 'markdown', key: `${r.section_key}__heading`, text: `## ${r.title ?? r.section_key}` });
    for (const b of (Array.isArray(r.blocks) ? r.blocks : []) as NarrativeBlock[]) {
      blocks.push({ ...b, key: `${r.section_key}.${b.key}` } as NarrativeBlock);
      if (b.type === 'sources') sources.push(...b.items);
    }
    checked += r.verification?.checked ?? 0;
    matched += r.verification?.matched ?? 0;
    for (const u of r.verification?.unmatched ?? []) notTraced.push({ section: r.section_key, ...u });
  }
  return {
    status: !missing.length ? 'COMPLETED' : done.length ? 'PARTIAL' : 'FAILED',
    blocks,
    sources,
    verification: { checked, matched, notTraced: notTraced.slice(0, 80) },
    missing,
    completed: done.length,
  };
}
