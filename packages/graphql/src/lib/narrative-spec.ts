/**
 * Narrative framework (v2) -- pure, dependency-free.
 *
 * A narrative is a sectioned, evidence-backed report attached to one or more
 * entity types. Each section declares the data it needs (queries, as-of
 * comparisons, derived measures, screens, scenarios), may use tools to fill
 * gaps, may research the web, and asks for typed output blocks. The same spec is
 * executed by the app's runner and handed to external chat clients through the
 * MCP server, so both compose from identical instructions and evidence.
 *
 * Nothing here touches the database or a model, so it is safe to import from
 * the browser, the API route, and the MCP server.
 */
import type { DataQuerySpec } from './data-query-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputBlockType =
  | 'markdown' | 'hero' | 'table' | 'scorecard' | 'kpis' | 'chart' | 'insights' | 'callouts' | 'sources';

export interface OutputBlockSpec {
  type: OutputBlockType;
  key: string;
  title?: string;
  guidance?: string;
}

export type MeasureUnit = 'number' | 'currency' | 'percent' | 'ratio' | 'multiple' | 'bps';

/** A value computed per row of a query, from the row's own columns. */
export interface NarrativeMeasure {
  query: string;
  alias: string;
  expr: string;
  label?: string;
  unit?: MeasureUnit;
}

export type ScreenSeverity = 'high' | 'medium' | 'low';

/** A deterministic test applied to every row. Flagged rows are computed, never judged by a model. */
export interface NarrativeScreen {
  key: string;
  label: string;
  query: string;
  when: string;
  severity: ScreenSeverity;
}

/** A what-if: an expression per row, aggregated. `top` limits it to the N largest rows by `rankBy`. */
export interface NarrativeScenario {
  key: string;
  label: string;
  query: string;
  expr: string;
  agg: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT';
  params?: Record<string, number>;
  rankBy?: string;
  top?: number;
}

export interface AsOfComparison {
  label: string;
  /** Shift back from the report as-of date. Omit all for the current date. */
  offset?: { years?: number; quarters?: number; months?: number; days?: number };
  /** Read the date from a run parameter instead (for example an inception date). */
  param?: string;
}

export interface NarrativeSection {
  key: string;
  title: string;
  /** The question this section answers, led with in the output. */
  purpose?: string;
  instructions: string;
  dataQueries?: DataQuerySpec[];
  /** Re-run every query at each of these dates and label the results. Defaults to the current date only. */
  comparisons?: AsOfComparison[];
  measures?: NarrativeMeasure[];
  screens?: NarrativeScreen[];
  scenarios?: NarrativeScenario[];
  blocks: OutputBlockSpec[];
  /**
   * fixed (default): produce exactly `blocks`, in order.
   * free: `blocks` is a palette. The composer designs the section: it picks the blocks, their order and
   * width for the content, following DESIGN_RULES, and may skip or add blocks.
   */
  layout?: 'fixed' | 'free';
  /** Let the composer call read-only tools (query_data, get_model_map, ...) to fill gaps. */
  agentic?: { enabled: boolean; maxRounds?: number };
  /** Search the web. Only runs when the narrative also allows external search. */
  research?: { queries: string[]; maxSources?: number };
  /** Section keys that must be composed first; their output is given as context. */
  dependsOn?: string[];
  /** Compose in groups of `size` rows of `query` (a borrower-by-borrower review), then stitch. */
  batch?: { query: string; size: number };
}

export interface NarrativeParameter {
  name: string;
  label?: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'boolean';
  options?: string[];
  default?: unknown;
}

export interface NarrativeSpec {
  narrativeName?: string;
  description?: string;
  domainCode?: string;
  /** Entity types this narrative is offered on, in addition to domainCode. */
  exposedDomains?: string[];
  persona?: string;
  audience?: string;
  /** Rules every section must follow. */
  rules?: string[];
  allowExternalSearch?: boolean;
  parameters?: NarrativeParameter[];
  sections?: NarrativeSection[];
  /** Legacy single-section form. Used only when `sections` is empty. */
  instructions?: string;
  dataQueries?: DataQuerySpec[];
  outputBlocks?: OutputBlockSpec[];
}

// ---------------------------------------------------------------------------
// Rules and prompt material shared by every runner
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: string[] = [
  'Use only figures present in the supplied evidence, measures, screens, scenarios, or cited sources. Never estimate or invent a number.',
  'When a figure is missing or a dataset reports an error, write "data not available" for it and say what is missing. Do not fill the gap.',
  'State the as-of date for every metric. Where comparison dates are supplied, show each one side by side.',
  'Lead each section with its key insight, then give the supporting data.',
  'Name weaknesses plainly and pair each with a mitigant or an action.',
  'Cite every external claim with its source and publication date. A claim with no source is left out.',
  'Computed screens, scenarios, and measures are authoritative. Quote them; do not recompute or contradict them.',
  'Never assign a status, rating, or classification (Performing, Watchlist, Tailwind, High severity) unless the evidence contains the field it comes from. Without one, write "data not available". The absence of a bad signal is not evidence of a good one.',
  'Match records by id or by following relationships, never by name. If a lookup returns several records with the same name, say so and do not use any of them as the record you wanted. A value found on a same-named record is not a value of this one.',
  'Do not invent facts about the manager or the fund: no strategy description, no activity that is "underway", no team actions, no reasons a figure is missing. Describe the strategy only from data. Propose actions as "Recommended:", never as already happening, unless the evidence shows they are.',
  'Do not pad. If the evidence does not support a block, leave it out and state the gap in the section\'s opening. No placeholder rows ("Contributor 1"), no empty charts, no all-"data not available" rows, and no filler about what the report will cover. Open with the finding.',
];

export const BLOCK_FORMAT_DOC = `
Each block has "type", "key", "title" and type-specific fields. Any block may also carry "width":"full"|"half" (two half blocks in a row sit side by side) and "note" (one line under the block saying what to take from it).
- markdown:  { "type":"markdown", "key", "title", "text":"<markdown prose>" }
- hero:      { "type":"hero", "key", "value":"9.3%", "label":"Net IRR since inception", "text"?:"one sentence of context", "delta"?:"-0.5 pts vs a year ago", "trend"?:"up"|"down"|"flat", "good"?:"up"|"down", "tone"?:"positive"|"neutral"|"warning"|"critical" }   the one number that answers the section's question
- kpis:      { "type":"kpis", "key", "title", "items":[ { "label", "value", "detail"?, "trend"?:"up"|"down"|"flat", "good"?:"up"|"down", "spark"?:[numbers, oldest first] } ] }   a few headline figures, already formatted
- table:     { "type":"table", "key", "title", "columns":[ "Borrower", { "label":"Exposure ($M)", "kind":"number", "format":"usd_m" }, ... ], "rows":[["a",1]], "highlights"?:[ { "row":0, "tone":"warning", "note":"why this row matters" } ] }
             A column is a label string (text) or { "label", "kind", "format"?, "good"? }.
             kind: "text" | "number" | "delta" (a change; drawn with an arrow, coloured by whether it is good) | "bar" (a share or size drawn as an inline bar) | "spark" (the cell is an array of numbers, oldest first, drawn as a sparkline) | "status" (a status word drawn as a pill).
             format: "usd_m" ($M) | "percent" (percent units, 3.5 = 3.5%) | "pp" (percentage points) | "bps" | "multiple" (x) | "number".
             good: "up" (default) or "down" says which direction of a delta or trend is good: leverage going up is bad, so its good is "down".
- scorecard: same as table, one row per subject, plus "statusColumn"?:"Status" naming the column that holds Performing / Watchlist / Underperforming / Non-accrual.
- chart:     { "type":"chart", "key", "title", "chartType":"bar"|"line"|"pie"|"stacked"|"waterfall"|"heatmap", "labels":[...], "series":[ { "name", "values":[...] } ], "totals"?:[indexes], "format"?:<format above>, "orientation"?:"vertical"|"horizontal", "highlight"?:[label indexes to emphasise; the rest are drawn muted], "annotations"?:[ { "index", "text" } ] }
             waterfall: values are deltas, "totals" lists the indexes drawn as running totals. heatmap: labels are columns, each series is a row. horizontal suits names and rankings.
- insights:  { "type":"insights", "key", "title", "items":[ { "title", "detail", "severity":"info"|"positive"|"warning"|"critical" } ] }
- callouts:  { "type":"callouts", "key", "title", "items":[ { "title", "severity":"high"|"medium"|"low"|"info"|"positive", "fields":[ { "label", "value" } ] } ] }   structured findings, e.g. a risk call-out or an LP question with its answer
- sources:   { "type":"sources", "key", "title", "items":[ { "title", "url"?, "publisher"?, "date"?, "note"? } ] }   every external source used
Numbers in table, scorecard and chart cells are raw numbers, not formatted strings; the format says how to show them. Percentages are in percent units unless the column says otherwise.
`.trim();

/** How to design a section whose layout is free. Sent with every free section. */
export const DESIGN_RULES: string[] = [
  'The goal is a compelling story, not a display of information. Decide what this section\'s single most important finding is, then design the section around proving it to this reader.',
  'Open with the answer: a hero block (one number that answers the key question) or one short markdown sentence that states the finding. Then the evidence, then the detail a careful reader wants.',
  'Choose each visual from the shape of the content. Change over time: a line, with an annotation at the turning point. Ranking or names: a horizontal bar with the subject of the story highlighted. Parts of a whole: a bar (a pie only with five slices or fewer). A walk from a start figure to an end figure: a waterfall. Each subject before and after: a table with a delta column and a spark column. A few exceptions among many: a table with those rows highlighted and a note on each. A single figure: a hero or a sentence, never a chart.',
  'Use as few blocks as the story needs, usually two to five. One strong visual beats three weak ones. Do not fall back on the same pattern (cards, then prose, then alerts, then a table) in every section; a section that is one number and one sentence is a good section.',
  'Say each figure once, where it carries the story. Do not repeat a card\'s number in the prose and again in a table.',
  'Tables are read across. Keep them to 12 rows or fewer, give every numeric column a kind and a format, show changes as delta columns with the right good direction, series as spark columns and shares as bar columns, and highlight the one to three rows the prose talks about, each with a note.',
  'Charts must be legible. At most 12 categories (combine the rest into "Other"), labels of 18 characters or fewer (abbreviate), horizontal orientation when labels are names, a format so values read as $M or %, and highlight the bar or point the title is about. Never put a long series of near-equal bars in a chart; a sentence says it better.',
  'Put two half-width blocks side by side only when they are read together, such as a chart and the table or sentence that explains it.',
  'Every chart and table gets a title that states the finding with its figure, and a note when the reader needs to be told what to look at.',
];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function pad(n: number): string { return String(n).padStart(2, '0'); }

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Shifts an ISO date back by the offset, clamping the day to the target month's length. */
export function shiftDate(iso: string, offset: NonNullable<AsOfComparison['offset']>): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const months = -((offset.years ?? 0) * 12 + (offset.quarters ?? 0) * 3 + (offset.months ?? 0));
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  if (offset.days) target.setUTCDate(target.getUTCDate() - offset.days);
  return toIso(target);
}

export interface ResolvedAsOf {
  label: string;
  /** Null when the comparison cannot be placed (for example the inception date is unknown). */
  date: string | null;
  reason?: string;
}

export const DEFAULT_COMPARISONS: AsOfComparison[] = [{ label: 'Current' }];

/**
 * Every comparison re-runs all of a section's queries, so the count is bounded.
 * 13 allows a monthly series: the as-of date and each of the 12 months before it.
 * validateNarrativeSpec rejects more, so nothing is dropped silently.
 */
export const MAX_COMPARISONS = 13;

export function resolveAsOfSet(
  comparisons: AsOfComparison[] | undefined,
  asOfDate: string,
  params: Record<string, unknown> = {},
): ResolvedAsOf[] {
  const list = comparisons && comparisons.length ? comparisons : DEFAULT_COMPARISONS;
  return list.slice(0, MAX_COMPARISONS).map((c) => {
    if (c.param) {
      const raw = params[c.param];
      const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      return date ? { label: c.label, date } : { label: c.label, date: null, reason: `Parameter "${c.param}" has no date` };
    }
    if (c.offset) return { label: c.label, date: shiftDate(asOfDate, c.offset) };
    return { label: c.label, date: asOfDate.slice(0, 10) };
  });
}

// ---------------------------------------------------------------------------
// Expressions: arithmetic, comparisons, && || !, and a few functions.
// No eval. A missing (null) input makes arithmetic null and a comparison false.
// ---------------------------------------------------------------------------

export type ExprValue = number | boolean | string | null;
type Node =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'var'; name: string }
  | { t: 'un'; op: string; a: Node } | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

interface Tok { k: 'num' | 'str' | 'id' | 'op' | 'end'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/\d|\./.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      out.push({ k: 'num', v: src.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error('Unterminated string');
      out.push({ k: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
    } else {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two }); i += 2; }
      else if ('+-*/%()<>!,'.includes(c)) { out.push({ k: 'op', v: c }); i++; }
      else throw new Error(`Unexpected character "${c}"`);
    }
  }
  out.push({ k: 'end', v: '' });
  return out;
}

const FUNCTIONS = new Set(['abs', 'min', 'max', 'round', 'coalesce', 'if', 'isnull']);

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (v !== undefined && t.v !== v) throw new Error(`Expected "${v}"`);
    p++;
    return t;
  };
  const level = (ops: string[], next: () => Node): Node => {
    let left = next();
    while (peek().k === 'op' && ops.includes(peek().v)) {
      const op = eat().v;
      left = { t: 'bin', op, a: left, b: next() };
    }
    return left;
  };
  const primary = (): Node => {
    const t = peek();
    if (t.k === 'num') { eat(); const v = Number(t.v); if (!Number.isFinite(v)) throw new Error(`Bad number "${t.v}"`); return { t: 'num', v }; }
    if (t.k === 'str') { eat(); return { t: 'str', v: t.v }; }
    if (t.k === 'id') {
      eat();
      if (peek().v === '(' && peek().k === 'op') {
        const fn = t.v.toLowerCase();
        if (!FUNCTIONS.has(fn)) throw new Error(`Unknown function "${t.v}"`);
        eat('(');
        const args: Node[] = [];
        if (peek().v !== ')') { args.push(orExpr()); while (peek().v === ',') { eat(','); args.push(orExpr()); } }
        eat(')');
        return { t: 'call', fn, args };
      }
      return { t: 'var', name: t.v };
    }
    if (t.v === '(') { eat('('); const n = orExpr(); eat(')'); return n; }
    if (t.v === '-' || t.v === '!') { eat(); return { t: 'un', op: t.v, a: primary() }; }
    throw new Error(t.k === 'end' ? 'Unexpected end of expression' : `Unexpected "${t.v}"`);
  };
  const mul = (): Node => level(['*', '/', '%'], primary);
  const add = (): Node => level(['+', '-'], mul);
  const cmp = (): Node => level(['<', '<=', '>', '>=', '==', '!='], add);
  const andExpr = (): Node => level(['&&'], cmp);
  const orExpr = (): Node => level(['||'], andExpr);
  const root = orExpr();
  if (peek().k !== 'end') throw new Error(`Unexpected "${peek().v}"`);
  return root;
}

function asNumber(v: ExprValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function evalNode(n: Node, vars: Record<string, unknown>): ExprValue {
  switch (n.t) {
    case 'num': case 'str': return n.v;
    case 'var': {
      const v = vars[n.name];
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      const asNum = asNumber(v as ExprValue);
      return asNum !== null && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? asNum : String(v);
    }
    case 'un': {
      const a = evalNode(n.a, vars);
      if (n.op === '!') return a === null ? null : !a;
      const x = asNumber(a);
      return x === null ? null : -x;
    }
    case 'call': {
      const args = n.args.map((a) => evalNode(a, vars));
      switch (n.fn) {
        case 'isnull': return args[0] === null;
        case 'coalesce': return args.find((a) => a !== null) ?? null;
        case 'if': return args[0] ? (args[1] ?? null) : (args[2] ?? null);
        case 'abs': { const x = asNumber(args[0]); return x === null ? null : Math.abs(x); }
        case 'round': { const x = asNumber(args[0]); const d = asNumber(args[1] ?? 0) ?? 0; return x === null ? null : Math.round(x * 10 ** d) / 10 ** d; }
        default: {
          const nums = args.map(asNumber);
          if (nums.some((x) => x === null)) return null;
          return n.fn === 'min' ? Math.min(...(nums as number[])) : Math.max(...(nums as number[]));
        }
      }
    }
    case 'bin': {
      if (n.op === '&&') { const a = evalNode(n.a, vars); return a ? Boolean(evalNode(n.b, vars)) : false; }
      if (n.op === '||') { const a = evalNode(n.a, vars); return a ? true : Boolean(evalNode(n.b, vars)); }
      const a = evalNode(n.a, vars);
      const b = evalNode(n.b, vars);
      if (['<', '<=', '>', '>=', '==', '!='].includes(n.op)) {
        if (a === null || b === null) return false;
        const x = asNumber(a); const y = asNumber(b);
        const [l, r] = x !== null && y !== null ? [x, y] : [String(a), String(b)];
        switch (n.op) {
          case '<': return l < r; case '<=': return l <= r; case '>': return l > r; case '>=': return l >= r;
          case '==': return l === r; default: return l !== r;
        }
      }
      const x = asNumber(a); const y = asNumber(b);
      if (x === null || y === null) return null;
      switch (n.op) {
        case '+': return x + y; case '-': return x - y; case '*': return x * y;
        case '/': return y === 0 ? null : x / y;
        default: return y === 0 ? null : x % y;
      }
    }
  }
}

export interface CompiledExpression {
  run: (vars: Record<string, unknown>) => ExprValue;
  variables: string[];
}

/** Compiles once. Throws a readable Error on a syntax problem. */
export function compileExpression(src: string): CompiledExpression {
  const root = parse(String(src ?? ''));
  const variables = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === 'var') variables.add(n.name);
    else if (n.t === 'un') walk(n.a);
    else if (n.t === 'bin') { walk(n.a); walk(n.b); }
    else if (n.t === 'call') n.args.forEach(walk);
  };
  walk(root);
  return { run: (vars) => evalNode(root, vars), variables: [...variables] };
}

// ---------------------------------------------------------------------------
// Rows: measures, screens, scenarios, coverage
// ---------------------------------------------------------------------------

export type Row = Record<string, any>;

export function applyMeasures(rows: Row[], measures: NarrativeMeasure[]): { rows: Row[]; errors: string[] } {
  const errors: string[] = [];
  const compiled = measures.flatMap((m) => {
    try { return [{ m, c: compileExpression(m.expr) }]; }
    catch (e: any) { errors.push(`measure ${m.alias}: ${e.message}`); return []; }
  });
  if (!compiled.length) return { rows, errors };
  const out = rows.map((row) => {
    const next: Row = { ...row };
    for (const { m, c } of compiled) {
      const v = c.run(next);
      next[m.alias] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }
    return next;
  });
  return { rows: out, errors };
}

const IDENTITY = ['entity_name', 'entity_code'];

export interface ScreenResult {
  key: string;
  label: string;
  severity: ScreenSeverity;
  query: string;
  when: string;
  evaluated: number;
  /** Rows the test could not run on because an input was missing. */
  notEvaluable: number;
  flaggedCount: number;
  flagged: Row[];
}

export function evaluateScreens(
  rowsByQuery: Record<string, Row[]>,
  screens: NarrativeScreen[],
  maxFlagged = 50,
): { results: ScreenResult[]; errors: string[] } {
  const errors: string[] = [];
  const results: ScreenResult[] = [];
  for (const s of screens) {
    const rows = rowsByQuery[s.query];
    if (!rows) { errors.push(`screen ${s.key}: no data set "${s.query}"`); continue; }
    let c: CompiledExpression;
    try { c = compileExpression(s.when); } catch (e: any) { errors.push(`screen ${s.key}: ${e.message}`); continue; }
    const flagged: Row[] = [];
    let notEvaluable = 0;
    let count = 0;
    for (const row of rows) {
      const missing = c.variables.some((v) => row[v] === undefined || row[v] === null || row[v] === '');
      if (missing) notEvaluable++;
      if (c.run(row) === true) {
        count++;
        if (flagged.length < maxFlagged) {
          const picked: Row = {};
          // A grouped row names its subject in a lookup column ("iss.entity_name"), not entity_name.
          const grouped = Object.keys(row).filter((k) => /\.entity_(name|code)$/.test(k));
          for (const k of [...IDENTITY, ...grouped, ...c.variables]) if (row[k] !== undefined) picked[k] = row[k];
          flagged.push(picked);
        }
      }
    }
    results.push({
      key: s.key, label: s.label, severity: s.severity, query: s.query, when: s.when,
      evaluated: rows.length - notEvaluable, notEvaluable, flaggedCount: count, flagged,
    });
  }
  return { results, errors };
}

export interface ScenarioResult {
  key: string;
  label: string;
  query: string;
  agg: NarrativeScenario['agg'];
  value: number | null;
  rowsUsed: number;
  rowsSkipped: number;
  params: Record<string, number>;
  names?: string[];
}

export function evaluateScenarios(
  rowsByQuery: Record<string, Row[]>,
  scenarios: NarrativeScenario[],
): { results: ScenarioResult[]; errors: string[] } {
  const errors: string[] = [];
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    let rows = rowsByQuery[s.query];
    if (!rows) { errors.push(`scenario ${s.key}: no data set "${s.query}"`); continue; }
    let c: CompiledExpression;
    try { c = compileExpression(s.expr); } catch (e: any) { errors.push(`scenario ${s.key}: ${e.message}`); continue; }
    let names: string[] | undefined;
    if (s.top && s.rankBy) {
      const rank = s.rankBy;
      rows = [...rows]
        .filter((r) => asNumber(r[rank]) !== null)
        .sort((a, b) => (asNumber(b[rank]) as number) - (asNumber(a[rank]) as number))
        .slice(0, s.top);
      // A grouped row has no entity_name; its label is the grouped column (e.g. "iss.entity_name").
      const label = (r: Row) => r.entity_name ?? r.entity_code
        ?? Object.entries(r).find(([k, v]) => k !== rank && typeof v === 'string' && v.trim() !== '')?.[1] ?? '';
      names = rows.map((r) => String(label(r)));
    }
    const params = s.params ?? {};
    const values: number[] = [];
    let skipped = 0;
    for (const row of rows) {
      const v = asNumber(c.run({ ...row, ...params }));
      if (v === null) skipped++; else values.push(v);
    }
    let value: number | null = null;
    if (values.length) {
      if (s.agg === 'SUM') value = values.reduce((a, b) => a + b, 0);
      else if (s.agg === 'AVG') value = values.reduce((a, b) => a + b, 0) / values.length;
      else if (s.agg === 'MIN') value = Math.min(...values);
      else if (s.agg === 'MAX') value = Math.max(...values);
      else value = values.length;
    }
    results.push({ key: s.key, label: s.label, query: s.query, agg: s.agg, value, rowsUsed: values.length, rowsSkipped: skipped, params, ...(names ? { names } : {}) });
  }
  return { results, errors };
}

export interface Coverage {
  rows: number;
  columns: Record<string, { populated: number; pct: number }>;
  /** Columns with no value on any row. */
  empty: string[];
}

export function computeCoverage(rows: Row[], columns: string[]): Coverage {
  const out: Coverage['columns'] = {};
  for (const col of columns) {
    const populated = rows.filter((r) => r[col] !== undefined && r[col] !== null && r[col] !== '').length;
    out[col] = { populated, pct: rows.length ? Math.round((populated / rows.length) * 1000) / 10 : 0 };
  }
  return { rows: rows.length, columns: out, empty: rows.length ? columns.filter((c) => out[c].populated === 0) : [] };
}

export function splitBatches<T>(rows: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

export function renderTemplate(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ---------------------------------------------------------------------------
// Spec handling
// ---------------------------------------------------------------------------

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The sections to run. A legacy template (no sections) becomes one section. */
export function narrativeSections(spec: NarrativeSpec): NarrativeSection[] {
  if (Array.isArray(spec.sections) && spec.sections.length) return spec.sections;
  return [{
    key: 'report',
    title: spec.narrativeName || 'Report',
    instructions: spec.instructions || 'Review the data and report on the most important findings.',
    dataQueries: spec.dataQueries ?? [],
    blocks: spec.outputBlocks?.length ? spec.outputBlocks : [{ type: 'markdown', key: 'summary', title: 'Summary' }],
  }];
}

/** Order to execute sections: dependencies first, otherwise the listed order. Throws on a cycle or unknown key. */
export function sectionRunOrder(sections: NarrativeSection[]): string[] {
  const keys = new Set(sections.map((s) => s.key));
  const done = new Set<string>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (s: NarrativeSection) => {
    if (done.has(s.key)) return;
    if (visiting.has(s.key)) throw new Error(`Sections depend on each other in a loop at "${s.key}"`);
    visiting.add(s.key);
    for (const dep of s.dependsOn ?? []) {
      if (!keys.has(dep)) throw new Error(`Section "${s.key}" depends on unknown section "${dep}"`);
      visit(sections.find((x) => x.key === dep) as NarrativeSection);
    }
    visiting.delete(s.key);
    done.add(s.key);
    order.push(s.key);
  };
  sections.forEach(visit);
  return order;
}

const BLOCK_TYPES: OutputBlockType[] = ['markdown', 'hero', 'table', 'scorecard', 'kpis', 'chart', 'insights', 'callouts', 'sources'];

export function validateNarrativeSpec(spec: NarrativeSpec, validateQueries?: (q: unknown) => string[]): string[] {
  const errors: string[] = [];
  const sections = narrativeSections(spec);
  const seen = new Set<string>();
  for (const s of sections) {
    const w = `section "${s.key}"`;
    if (!s.key || !KEY.test(s.key)) errors.push(`${w}: key must be an identifier`);
    else if (seen.has(s.key)) errors.push(`${w}: duplicate key`);
    seen.add(s.key);
    if (!s.title) errors.push(`${w}: title required`);
    if (!s.instructions) errors.push(`${w}: instructions required`);
    if (!Array.isArray(s.blocks) || !s.blocks.length) errors.push(`${w}: at least one output block required`);
    const blockKeys = new Set<string>();
    for (const b of s.blocks ?? []) {
      if (!BLOCK_TYPES.includes(b.type)) errors.push(`${w}: unknown block type "${b.type}"`);
      if (!b.key || blockKeys.has(b.key)) errors.push(`${w}: block keys must be unique and present`);
      blockKeys.add(b.key);
    }
    const queryErrors = validateQueries ? validateQueries(s.dataQueries ?? []) : [];
    errors.push(...queryErrors.map((e) => `${w}: ${e}`));
    const queryKeys = new Set((s.dataQueries ?? []).map((q) => q.key));
    const needQuery = (what: string, q: string) => { if (!queryKeys.has(q)) errors.push(`${w}: ${what} refers to unknown query "${q}"`); };
    for (const m of s.measures ?? []) {
      needQuery(`measure ${m.alias}`, m.query);
      try { compileExpression(m.expr); } catch (e: any) { errors.push(`${w}: measure ${m.alias}: ${e.message}`); }
    }
    for (const sc of s.screens ?? []) {
      needQuery(`screen ${sc.key}`, sc.query);
      try { compileExpression(sc.when); } catch (e: any) { errors.push(`${w}: screen ${sc.key}: ${e.message}`); }
    }
    for (const sc of s.scenarios ?? []) {
      needQuery(`scenario ${sc.key}`, sc.query);
      try { compileExpression(sc.expr); } catch (e: any) { errors.push(`${w}: scenario ${sc.key}: ${e.message}`); }
    }
    if (s.batch) {
      needQuery('batch', s.batch.query);
      if (!(s.batch.size >= 1)) errors.push(`${w}: batch size must be at least 1`);
    }
    if (s.research && !Array.isArray(s.research.queries)) errors.push(`${w}: research.queries must be an array`);
    if (s.layout !== undefined && s.layout !== 'fixed' && s.layout !== 'free') errors.push(`${w}: layout must be "fixed" or "free"`);
    if ((s.comparisons?.length ?? 0) > MAX_COMPARISONS) {
      errors.push(`${w}: at most ${MAX_COMPARISONS} comparison dates (has ${s.comparisons!.length}); the rest would be ignored`);
    }
  }
  try { sectionRunOrder(sections); } catch (e: any) { errors.push(e.message); }
  return errors;
}

// ---------------------------------------------------------------------------
// Block normalization (model output -> safe, typed blocks)
// ---------------------------------------------------------------------------

export const MAX_TABLE_ROWS = 200;

/** How a number is written: $M, percent units, percentage points, basis points, a multiple, or plain. */
export type ValueFormat = 'usd_m' | 'percent' | 'pp' | 'bps' | 'multiple' | 'number';
export type ColumnKind = 'text' | 'number' | 'delta' | 'bar' | 'spark' | 'status';
export type Trend = 'up' | 'down' | 'flat';
/** Which direction is good for a delta or trend: leverage rising is bad, so its good is "down". */
export type GoodDirection = 'up' | 'down';
export type Tone = 'positive' | 'neutral' | 'warning' | 'critical' | 'info';

export interface ColumnSpec { label: string; kind: ColumnKind; format?: ValueFormat; good?: GoodDirection }
export interface RowHighlight { row: number; tone: Tone; note?: string }

/** Fields every block may carry: its width in a two-up row, and a one-line takeaway. */
interface BlockBase { key: string; title?: string; width?: 'full' | 'half'; note?: string }

export type NarrativeBlock =
  | (BlockBase & { type: 'markdown'; text: string })
  | (BlockBase & { type: 'hero'; value: string; label: string; text?: string; delta?: string; trend?: Trend; good?: GoodDirection; tone?: Tone })
  | (BlockBase & { type: 'table'; columns: string[]; columnSpecs?: ColumnSpec[]; rows: any[][]; highlights?: RowHighlight[] })
  | (BlockBase & { type: 'scorecard'; columns: string[]; columnSpecs?: ColumnSpec[]; rows: any[][]; highlights?: RowHighlight[]; statusColumn?: string })
  | (BlockBase & { type: 'kpis'; items: Array<{ label: string; value: string; detail?: string; trend?: Trend; good?: GoodDirection; spark?: number[] }> })
  | (BlockBase & {
      type: 'chart'; chartType: 'bar' | 'line' | 'pie' | 'stacked' | 'waterfall' | 'heatmap'; labels: string[];
      series: Array<{ name: string; values: number[] }>; totals?: number[]; format?: ValueFormat;
      orientation?: 'vertical' | 'horizontal'; highlight?: number[]; annotations?: Array<{ index: number; text: string }>;
    })
  | (BlockBase & { type: 'insights'; items: Array<{ title: string; detail: string; severity: 'info' | 'positive' | 'warning' | 'critical' }> })
  | (BlockBase & { type: 'callouts'; items: Array<{ title: string; severity: 'high' | 'medium' | 'low' | 'info' | 'positive'; fields: Array<{ label: string; value: string }> }> })
  | (BlockBase & { type: 'sources'; items: Array<{ title: string; url?: string; publisher?: string; date?: string; note?: string }> });

const str = (v: unknown, max = 4000): string => (v === null || v === undefined ? '' : String(v).slice(0, max));
const cell = (c: unknown) => (c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : (c as string | number | boolean));
const FORMATS: ValueFormat[] = ['usd_m', 'percent', 'pp', 'bps', 'multiple', 'number'];
const KINDS: ColumnKind[] = ['text', 'number', 'delta', 'bar', 'spark', 'status'];
const TONES: Tone[] = ['positive', 'neutral', 'warning', 'critical', 'info'];
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
const numList = (v: unknown, max = 60): number[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, max).map(Number).filter((n) => Number.isFinite(n));
  return out.length >= 2 ? out : undefined;
};
const safeUrl = (u: unknown): string | undefined => {
  const s = str(u, 500).trim();
  return /^https?:\/\//i.test(s) ? s : undefined;
};

/** A block with nothing to show is dropped rather than rendered as an empty frame. */
function hasContent(b: NarrativeBlock): boolean {
  switch (b.type) {
    case 'markdown': return b.text.trim().length > 0;
    case 'hero': return b.value.trim().length > 0 && !GAP.test(b.value);
    case 'table': case 'scorecard': return b.columns.length > 0 && b.rows.length > 0;
    case 'chart': return b.labels.length > 0 && b.series.some((s) => s.values.length > 0);
    default: return b.items.length > 0;
  }
}

const GAP = /^\s*data not available/i;

/**
 * A table row with nothing but gaps after its label says only "we have no data for X".
 * Those rows are removed and listed once in a line under the table.
 */
function collapseGapRows(blocks: NarrativeBlock[]): NarrativeBlock[] {
  const out: NarrativeBlock[] = [];
  for (const b of blocks) {
    if (b.type !== 'table' && b.type !== 'scorecard') { out.push(b); continue; }
    const kept: any[][] = [];
    const gone: string[] = [];
    const newIndex = new Map<number, number>();
    b.rows.forEach((row, i) => {
      const rest = row.slice(1);
      const allGap = rest.length > 0 && rest.every((c) => c === '' || GAP.test(String(c)));
      if (allGap) gone.push(String(row[0] ?? '').trim());
      else { newIndex.set(i, kept.length); kept.push(row); }
    });
    // A highlight points at a row by position, so it follows the row or goes with it.
    const highlights = b.highlights?.flatMap((h) => (newIndex.has(h.row) ? [{ ...h, row: newIndex.get(h.row)! }] : []));
    out.push({ ...b, rows: kept, ...(b.highlights ? { highlights } : {}) });
    if (gone.length) {
      out.push({ type: 'markdown', key: `${b.key}_gaps`, text: `**Data not available:** ${gone.filter(Boolean).join('; ')}.` });
    }
  }
  return out;
}

/**
 * Removes any column (after the label) that holds nothing but gaps for every row, and says so once.
 * Run on a finished block set. A batched section must run it after its batches are merged,
 * because each batch only sees its own rows.
 */
export function collapseGapColumns(blocks: NarrativeBlock[]): NarrativeBlock[] {
  const out: NarrativeBlock[] = [];
  for (const b of blocks) {
    if ((b.type !== 'table' && b.type !== 'scorecard') || b.rows.length === 0 || b.columns.length < 3) { out.push(b); continue; }
    const drop = new Set<number>();
    for (let i = 1; i < b.columns.length; i++) {
      if (b.rows.every((r) => r[i] === undefined || r[i] === null || r[i] === '' || GAP.test(String(r[i])))) drop.add(i);
    }
    if (!drop.size) { out.push(b); continue; }
    const keep = b.columns.map((_, i) => i).filter((i) => !drop.has(i));
    const dropped = [...drop].map((i) => b.columns[i]);
    const note: NarrativeBlock = { type: 'markdown', key: `${b.key}_gapcols`, text: `**Not available for any row:** ${dropped.join('; ')}.` };
    if (keep.length < 2) { out.push(note); continue; }
    const columns = keep.map((i) => b.columns[i]);
    const rows = b.rows.map((r) => keep.map((i) => r[i]));
    const columnSpecs = b.columnSpecs ? keep.map((i) => b.columnSpecs![i]) : undefined;
    const statusColumn = b.type === 'scorecard' && b.statusColumn && columns.includes(b.statusColumn) ? b.statusColumn : undefined;
    const trimmed = { ...b, columns, rows, ...(columnSpecs ? { columnSpecs } : {}) };
    out.push(b.type === 'scorecard' ? { ...trimmed, ...(statusColumn ? { statusColumn } : { statusColumn: undefined }) } as NarrativeBlock : trimmed as NarrativeBlock);
    out.push(note);
  }
  return out;
}

export function normalizeBlocks(raw: unknown): NarrativeBlock[] {
  return collapseGapRows(normalizeAllBlocks(raw).filter(hasContent)).filter(hasContent);
}

function normalizeAllBlocks(raw: unknown): NarrativeBlock[] {
  const list: any[] = Array.isArray((raw as any)?.blocks) ? (raw as any).blocks : Array.isArray(raw) ? (raw as any[]) : [];
  const out: NarrativeBlock[] = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const base = {
      key: str(b.key, 80) || `block_${out.length + 1}`,
      ...(b.title ? { title: str(b.title, 200) } : {}),
      ...(b.width === 'half' ? { width: 'half' as const } : {}),
      ...(b.note ? { note: str(b.note, 300) } : {}),
    };
    switch (b.type) {
      case 'markdown':
        out.push({ type: 'markdown', ...base, text: str(b.text, 30000) });
        break;
      case 'hero': {
        const trend = pick<Trend>(b.trend, ['up', 'down', 'flat']);
        const good = pick<GoodDirection>(b.good, ['up', 'down']);
        const tone = pick<Tone>(b.tone, TONES);
        out.push({
          type: 'hero', ...base, value: str(b.value, 40), label: str(b.label, 120),
          ...(b.text ? { text: str(b.text, 600) } : {}), ...(b.delta ? { delta: str(b.delta, 80) } : {}),
          ...(trend ? { trend } : {}), ...(good ? { good } : {}), ...(tone ? { tone } : {}),
        });
        break;
      }
      case 'table':
      case 'scorecard': {
        const rawColumns: unknown[] = Array.isArray(b.columns) ? b.columns : [];
        const columnSpecs: ColumnSpec[] = rawColumns.map((c: any) => {
          if (c && typeof c === 'object') {
            const kind = pick(c.kind, KINDS) ?? 'text';
            const format = pick(c.format, FORMATS);
            const good = pick<GoodDirection>(c.good, ['up', 'down']);
            return { label: str(c.label, 80), kind, ...(format ? { format } : {}), ...(good ? { good } : {}) };
          }
          return { label: str(c, 80), kind: 'text' as const };
        });
        const columns = columnSpecs.map((c) => c.label);
        const typed = columnSpecs.some((c) => c.kind !== 'text');
        const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_TABLE_ROWS)
          .map((r: unknown) => (Array.isArray(r)
            // A spark cell keeps its series; any other object cell becomes text.
            ? r.map((c, i) => (columnSpecs[i]?.kind === 'spark' ? (numList(c) ?? '') : cell(c)))
            : [str(r)]));
        const highlights: RowHighlight[] = (Array.isArray(b.highlights) ? b.highlights : []).flatMap((h: any) => {
          const row = Number(h?.row);
          if (!Number.isInteger(row) || row < 0 || row >= rows.length) return [];
          return [{ row, tone: pick(h?.tone, TONES) ?? 'info', ...(h?.note ? { note: str(h.note, 240) } : {}) }];
        }).slice(0, 12);
        const extras = { ...(typed ? { columnSpecs } : {}), ...(highlights.length ? { highlights } : {}) };
        if (b.type === 'scorecard') {
          const statusColumn = columns.includes(str(b.statusColumn)) ? str(b.statusColumn) : undefined;
          out.push({ type: 'scorecard', ...base, columns, rows, ...extras, ...(statusColumn ? { statusColumn } : {}) });
        } else out.push({ type: 'table', ...base, columns, rows, ...extras });
        break;
      }
      case 'kpis': {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 12).flatMap((i: any) => {
          const label = str(i?.label, 60); const value = str(i?.value, 60);
          if (!label || !value) return [];
          const trend = pick<Trend>(i?.trend, ['up', 'down', 'flat']);
          const good = pick<GoodDirection>(i?.good, ['up', 'down']);
          const spark = numList(i?.spark);
          return [{
            label, value, ...(i?.detail ? { detail: str(i.detail, 160) } : {}), ...(trend ? { trend } : {}),
            ...(good ? { good } : {}), ...(spark ? { spark } : {}),
          }];
        });
        out.push({ type: 'kpis', ...base, items });
        break;
      }
      case 'chart': {
        const chartType = ['bar', 'line', 'pie', 'stacked', 'waterfall', 'heatmap'].includes(b.chartType) ? b.chartType : 'bar';
        const labels = (Array.isArray(b.labels) ? b.labels : []).map((l: unknown) => str(l, 60));
        const series = (Array.isArray(b.series) ? b.series : []).map((s: any) => ({
          name: str(s?.name, 80),
          values: (Array.isArray(s?.values) ? s.values : []).map((v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)),
        }));
        const totals = Array.isArray(b.totals) ? b.totals.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) : undefined;
        const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < labels.length;
        const highlight = Array.isArray(b.highlight) ? b.highlight.map(Number).filter(inRange).slice(0, 12) : [];
        const annotations = (Array.isArray(b.annotations) ? b.annotations : []).flatMap((a: any) => {
          const index = Number(a?.index);
          return inRange(index) && a?.text ? [{ index, text: str(a.text, 60) }] : [];
        }).slice(0, 4);
        const format = pick(b.format, FORMATS);
        const orientation = pick<'vertical' | 'horizontal'>(b.orientation, ['vertical', 'horizontal']);
        out.push({
          type: 'chart', ...base, chartType, labels, series, ...(totals && totals.length ? { totals } : {}),
          ...(format ? { format } : {}), ...(orientation ? { orientation } : {}),
          ...(highlight.length ? { highlight } : {}), ...(annotations.length ? { annotations } : {}),
        });
        break;
      }
      case 'insights': {
        const items = (Array.isArray(b.items) ? b.items : []).map((i: any) => ({
          title: str(i?.title, 200), detail: str(i?.detail, 2000),
          severity: ['info', 'positive', 'warning', 'critical'].includes(i?.severity) ? i.severity : 'info',
        }));
        out.push({ type: 'insights', ...base, items });
        break;
      }
      case 'callouts': {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60).map((i: any) => ({
          title: str(i?.title, 200),
          severity: ['high', 'medium', 'low', 'info', 'positive'].includes(i?.severity) ? i.severity : 'info',
          fields: (Array.isArray(i?.fields) ? i.fields : []).slice(0, 12).map((f: any) => ({ label: str(f?.label, 80), value: str(f?.value, 2000) })),
        }));
        out.push({ type: 'callouts', ...base, items });
        break;
      }
      case 'sources': {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60).map((i: any) => ({
          title: str(i?.title, 240),
          ...(safeUrl(i?.url) ? { url: safeUrl(i?.url) } : {}),
          ...(i?.publisher ? { publisher: str(i.publisher, 120) } : {}),
          ...(i?.date ? { date: str(i.date, 40) } : {}),
          ...(i?.note ? { note: str(i.note, 400) } : {}),
        }));
        out.push({ type: 'sources', ...base, items });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification: every figure in the prose should be traceable to evidence
// ---------------------------------------------------------------------------

const MULT: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

interface Figure { value: number; display: string; suffix: string; decimals: number; percent: boolean }

function figuresIn(text: string): Figure[] {
  const cleaned = text
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\b(Q[1-4])\s?\d{2,4}\b/gi, ' ')
    // "November 13, 2026" and "13 November 2026": the day is a date, not a figure.
    // Day-first before month-first: "13 November 2026" must not be read as "November 20" plus a stray "26".
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{4})?/gi, ' ')
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi, ' ');
  const out: Figure[] = [];
  const re = /(?<![\w.])(-?)\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|bps|x|[KMB]\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const raw = `${m[2].replace(/,/g, '')}${m[3] ?? ''}`;
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (m[1] === '-') value = -value;
    const suffix = m[4] ?? '';
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    const isYear = !suffix && decimals === 0 && Number.isInteger(value) && value >= 1900 && value <= 2100;
    const isSmall = !suffix && decimals === 0 && Math.abs(value) < 10;
    if (isYear || isSmall) continue;
    out.push({ value, display: m[0].trim(), suffix, decimals, percent: suffix === '%' });
  }
  return out;
}

function collectNumbers(value: unknown, into: number[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'number') { if (Number.isFinite(value)) into.push(value); return; }
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) into.push(Number(t));
    else for (const f of figuresIn(t)) into.push(f.suffix && MULT[f.suffix] ? f.value * MULT[f.suffix] : f.value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectNumbers(v, into, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value as object)) collectNumbers(v, into, depth + 1);
}

function textOf(block: NarrativeBlock): string[] {
  const note = block.note ? [block.note] : [];
  return [...note, ...bodyTextOf(block)];
}

function bodyTextOf(block: NarrativeBlock): string[] {
  switch (block.type) {
    case 'markdown': return [block.text];
    case 'hero': return [block.value, block.delta ?? '', block.text ?? ''];
    case 'table': case 'scorecard':
      // A spark cell is an array: each of its points is a figure of its own.
      return [
        ...block.rows.flat(2).map((c) => (typeof c === 'number' ? String(c) : String(c ?? ''))),
        ...(block.highlights ?? []).map((h) => h.note ?? ''),
      ];
    case 'kpis': return block.items.flatMap((i) => [i.value, i.detail ?? '', ...(i.spark ?? []).map(String)]);
    case 'insights': return block.items.map((i) => `${i.title} ${i.detail}`);
    case 'callouts': return block.items.flatMap((i) => [i.title, ...i.fields.map((f) => f.value)]);
    case 'chart': return block.series.flatMap((s) => s.values.map(String));
    default: return [];
  }
}

export interface Verification {
  checked: number;
  matched: number;
  unmatched: Array<{ block: string; figure: string }>;
}

/**
 * Advisory check. A figure is traced when it equals (within display rounding) a number in the
 * evidence or in the instructions/parameters that were given to the composer. Derived arithmetic
 * the model did itself will not trace, which is the point: it is flagged for a human.
 */
export function verifyBlocks(blocks: NarrativeBlock[], evidence: unknown[], allowedText: string[] = []): Verification {
  const pool: number[] = [];
  evidence.forEach((e) => collectNumbers(e, pool));
  allowedText.forEach((t) => collectNumbers(t, pool));
  const known = new Set(pool.map((n) => n));
  const near = (v: number, rel: number, abs: number) => {
    for (const e of known) if (Math.abs(e - v) <= Math.max(abs, Math.abs(e) * rel)) return true;
    return false;
  };
  let checked = 0; let matched = 0;
  const unmatched: Verification['unmatched'] = [];
  for (const block of blocks) {
    if (block.type === 'sources') continue;
    for (const piece of textOf(block)) {
      for (const f of figuresIn(piece)) {
        checked++;
        const mult = f.suffix && MULT[f.suffix] ? MULT[f.suffix] : 1;
        const v = f.value * mult;
        const step = 0.5 * 10 ** -f.decimals * mult;
        const ok = near(v, mult > 1 ? 0.006 : 1e-6, step)
          || (f.percent && (near(f.value / 100, 1e-6, step / 100 + 1e-9) || near(f.value, 1e-6, step)))
          || (f.suffix === 'bps' && near(f.value / 10000, 1e-6, 1e-9))
          || (f.suffix === 'x' && near(f.value, 1e-6, step));
        if (ok) matched++;
        else if (unmatched.length < 40) unmatched.push({ block: block.key, figure: f.display });
      }
    }
  }
  return { checked, matched, unmatched };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function mdCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Array.isArray(v)) return v.length ? `${mdCell(v[0])} → ${mdCell(v[v.length - 1])}` : '';
  return String(v).replace(/\|/g, '/').replace(/\n/g, ' ');
}

export function blocksToMarkdown(blocks: NarrativeBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.title) lines.push(`#### ${b.title}`, '');
    switch (b.type) {
      case 'markdown': lines.push(b.text, ''); break;
      case 'hero': lines.push(`**${b.value}** ${b.label}${b.delta ? ` (${b.delta})` : ''}`, ...(b.text ? [b.text] : []), ''); break;
      case 'kpis': lines.push(...b.items.map((i) => `- **${i.label}:** ${i.value}${i.detail ? ` (${i.detail})` : ''}`), ''); break;
      case 'table': case 'scorecard':
        if (b.columns.length) {
          lines.push(`| ${b.columns.join(' | ')} |`, `| ${b.columns.map(() => '---').join(' | ')} |`);
          for (const r of b.rows) lines.push(`| ${b.columns.map((_, i) => mdCell(r[i])).join(' | ')} |`);
          lines.push('');
        }
        break;
      case 'chart':
        lines.push(`_Chart (${b.chartType}):_`, ...b.labels.map((l, i) => `- ${l}: ${b.series.map((s) => `${s.name ? `${s.name} ` : ''}${mdCell(s.values[i])}`).join(', ')}`), '');
        break;
      case 'insights': lines.push(...b.items.map((i) => `- **${i.title}** (${i.severity}): ${i.detail}`), ''); break;
      case 'callouts':
        for (const i of b.items) lines.push(`- **${i.title}** [${i.severity}]`, ...i.fields.map((f) => `  - ${f.label}: ${f.value}`));
        lines.push('');
        break;
      case 'sources':
        lines.push(...b.items.map((i) => `- ${i.title}${i.publisher ? `, ${i.publisher}` : ''}${i.date ? ` (${i.date})` : ''}${i.url ? ` <${i.url}>` : ''}`), '');
        break;
    }
    if ((b.type === 'table' || b.type === 'scorecard') && b.highlights?.length) {
      for (const h of b.highlights) if (h.note) lines.push(`- _${mdCell(b.rows[h.row]?.[0])}:_ ${h.note}`);
      lines.push('');
    }
    if (b.note) lines.push(`_${b.note}_`, '');
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Prompt assembly (used by the app runner; mirrored for external clients by the MCP guide)
// ---------------------------------------------------------------------------

export function narrativeSystemPrompt(spec: NarrativeSpec): string {
  const rules = [...DEFAULT_RULES, ...(spec.rules ?? [])];
  const anyFree = narrativeSections(spec).some((s) => s.layout === 'free');
  return [
    spec.persona || 'You are a careful private-markets analyst writing structured reports from master data.',
    spec.audience ? `The reader is: ${spec.audience}.` : '',
    `## Rules\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    anyFree ? `## Design (sections whose layout is yours to design)\n${DESIGN_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '',
    `## Output\nRespond with ONLY a JSON object { "blocks": [ ... ] }. The section brief says whether its blocks are fixed or yours to design.\n${BLOCK_FORMAT_DOC}`,
  ].filter(Boolean).join('\n\n');
}

/** Most blocks a free-layout section may produce. */
export const MAX_FREE_BLOCKS = 7;

export interface SectionPromptInput {
  section: NarrativeSection;
  params: Record<string, unknown>;
  asOfDate: string;
  evidence: unknown;
  prior?: Array<{ key: string; title: string; markdown: string }>;
  research?: { notes: string; sources: Array<{ title: string; url?: string }> } | null;
  batchLabel?: string;
  /** Subjects that must each appear in every table or scorecard and in the prose. */
  mustCover?: string[];
  /** Problems a reviewer found in an earlier version of this section. Each must be fixed. */
  reviewNotes?: string;
}

export function sectionUserPrompt(input: SectionPromptInput): string {
  const { section } = input;
  const listed = section.blocks
    .map((b, i) => `${i + 1}. type=${b.type} key=${b.key} title="${b.title || ''}"${b.guidance ? ` guidance: ${b.guidance}` : ''}`)
    .join('\n');
  // A batch is stitched by block key, so a batched section keeps the blocks it declares.
  const free = section.layout === 'free' && !input.batchLabel;
  const blocksBrief = free
    ? `# Design this section\nThe layout is yours. Choose the blocks, their order and their width that tell this section's story best for this content, following the Design rules: up to ${MAX_FREE_BLOCKS} blocks, usually two to five. The palette below lists blocks that suit this section, with guidance on what each should show. Use, adapt, reorder or skip them, and use any other block type when it tells the story better. Keep a palette block's key when you use it; give a new block a new short key.\n## Palette\n${listed}`
    : `# Requested output blocks\nProduce exactly these blocks, in order, with their keys.\n${listed}`;
  return [
    `# Section: ${section.title}${input.batchLabel ? ` (${input.batchLabel})` : ''}`,
    section.purpose ? `Key question: ${section.purpose}` : '',
    `# Instructions\n${section.instructions}`,
    blocksBrief,
    input.mustCover?.length
      ? `# Coverage\nEvery one of these must have its own row in each table or scorecard and its own view. Do not skip or merge any: ${input.mustCover.join('; ')}`
      : '',
    input.reviewNotes
      ? `# A reviewer found these problems in an earlier version of this section\nFix every one. Do not repeat the wording that was flagged; where the evidence does not support a statement, say "data not available" or leave it out.\n${input.reviewNotes}`
      : '',
    `# Report as-of date\n${input.asOfDate}`,
    `# Inputs\n${JSON.stringify(input.params)}`,
    input.prior?.length
      ? `# Sections already written (context; do not repeat them)\n${input.prior.map((p) => `## ${p.title}\n${p.markdown}`).join('\n\n')}`
      : '',
    input.research
      ? `# External research (dated notes from web search; cite these and nothing else from outside)\n${input.research.notes}\nSources:\n${input.research.sources.map((s) => `- ${s.title}${s.url ? ` <${s.url}>` : ''}`).join('\n')}`
      : '',
    `# Evidence\n${JSON.stringify(input.evidence)}`,
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Batches: stitch the blocks composed for each group of rows into one set
// ---------------------------------------------------------------------------

export function mergeBatchBlocks(batches: NarrativeBlock[][]): NarrativeBlock[] {
  const out: NarrativeBlock[] = [];
  const index = new Map<string, number>();
  for (const batch of batches) {
    for (const block of batch) {
      const at = index.get(block.key);
      if (at === undefined) { index.set(block.key, out.length); out.push(structuredCloneBlock(block)); continue; }
      const into = out[at];
      if (into.type !== block.type) continue;
      if (into.type === 'markdown' && block.type === 'markdown') into.text = `${into.text}\n\n${block.text}`.trim();
      else if ((into.type === 'table' || into.type === 'scorecard') && (block.type === 'table' || block.type === 'scorecard')) into.rows.push(...block.rows);
      else if ((into.type === 'kpis' || into.type === 'insights' || into.type === 'callouts' || into.type === 'sources') && 'items' in block) {
        (into.items as unknown[]).push(...(block.items as unknown[]));
      }
    }
  }
  return out;
}

function structuredCloneBlock<T>(b: T): T {
  return JSON.parse(JSON.stringify(b)) as T;
}
