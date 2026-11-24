/**
 * Target math for the Strategy, Region and Structure hierarchies: the one home for it.
 * Every tab, the rail, the overview, the pipeline and what the assistant is told read these.
 *
 * A target can sit at any level. Children do not have to add up to the parent; the gap is shown.
 * A % band is a share of the program, or of the level above when the basis is Parent level.
 */
import type { Band, Commitment, Fund, Lens, Taxonomy, TaxValue } from './types';
import { LENSES } from './types';
import { MEASURES, type Measure } from './format';

export interface TreeNode {
  key: string;
  code: string;
  name: string;
  tag: string;
  depth: number;
  path: string[];
  parent: TreeNode | null;
  children: TreeNode[];
}

export const LENS_INFO: Record<Lens, { label: string; path: string; tags: string[] }> = {
  strategy: { label: 'Strategy', path: 'Category › Asset Class › Strategy › Sub-Strategy', tags: ['CAT', 'AC', 'STRAT', 'SUB'] },
  region: { label: 'Region', path: 'Region › Asset Class', tags: ['RGN', 'AC'] },
  structure: { label: 'Structure', path: 'Category › Structure Type › Detail', tags: ['CAT', 'TYPE', 'DETAIL'] },
};

export const KEY_SEP = '/';

function levelOf(list: TaxValue[], level: number, parent?: string | null): TaxValue[] {
  return list.filter((v) => v.level === level && (parent === undefined || v.parent === parent));
}

function childValues(tax: Taxonomy, lens: Lens, path: string[]): TaxValue[] {
  const d = path.length;
  if (lens === 'strategy') {
    if (d === 0) return levelOf(tax.structure, 1);
    if (d === 1) return levelOf(tax.strategy, 1);
    if (d === 2) return levelOf(tax.strategy, 2, path[1]);
    if (d === 3) return levelOf(tax.strategy, 3, path[2]);
    return [];
  }
  if (lens === 'region') {
    if (d === 0) return levelOf(tax.region, 1);
    if (d === 1) return levelOf(tax.strategy, 1);
    return [];
  }
  if (d === 0) return levelOf(tax.structure, 1);
  if (d === 1) return levelOf(tax.structure, 2, path[0]);
  if (d === 2) return levelOf(tax.structure, 3, path[1]);
  return [];
}

export interface Trees {
  roots: Record<Lens, TreeNode>;
  nodes: Record<Lens, Record<string, TreeNode>>;
}

export function buildTrees(tax: Taxonomy): Trees {
  const roots = {} as Record<Lens, TreeNode>;
  const nodes = {} as Record<Lens, Record<string, TreeNode>>;
  for (const lens of LENSES) {
    nodes[lens] = {};
    const build = (path: string[], parent: TreeNode | null, value: TaxValue | null): TreeNode => {
      const node: TreeNode = {
        key: path.join(KEY_SEP),
        code: value?.code ?? '',
        name: value?.label ?? 'Total program',
        tag: path.length ? LENS_INFO[lens].tags[path.length - 1] : 'ALL',
        depth: path.length,
        path,
        parent,
        children: [],
      };
      nodes[lens][node.key] = node;
      node.children = childValues(tax, lens, path).map((v) => build([...path, v.code], node, v));
      return node;
    };
    roots[lens] = build([], null, null);
  }
  return { roots, nodes };
}

export function walk(node: TreeNode, fn: (n: TreeNode) => void) {
  fn(node);
  node.children.forEach((c) => walk(c, fn));
}

/** The path of node names, for labels: "Primary › Private Equity › Buyout". */
export function nodeLabel(node: TreeNode): string {
  const names: string[] = [];
  for (let n: TreeNode | null = node; n && n.depth > 0; n = n.parent) names.unshift(n.name);
  return names.join(' › ') || 'Total program';
}

// ---------- targets ----------

const SUFS = ['Min', '', 'Max'] as const;
type Suf = (typeof SUFS)[number];
const field = (k: Measure, suf: Suf) => `${k}${suf}` as keyof Band;

export const hasTarget = (t: Band | null | undefined) => !!t && Object.values(t).some((v) => v != null);

export function programBand(f: Fund): Band {
  return { ...f.matrix.program, usd: f.programUsd, n: f.programN };
}

export function targetOf(f: Fund, lens: Lens, node: TreeNode): Band | undefined {
  if (node.depth === 0) return programBand(f);
  return f.matrix[lens][node.key];
}

function baseUsd(f: Fund, lens: Lens, node: TreeNode): number | null {
  return f.basis === 'PARENT_LEVEL' && node.parent && node.parent.depth > 0 ? effUsd(f, lens, node.parent) : f.programUsd;
}

export function effUsdK(f: Fund, lens: Lens, node: TreeNode, suf: Suf): number | null {
  if (node.depth === 0) return (programBand(f)[field('usd', suf)] as number | null | undefined) ?? null;
  const t = f.matrix[lens][node.key];
  if (!t) return null;
  const usd = t[field('usd', suf)];
  if (usd != null) return usd;
  const pct = t[field('pct', suf)];
  if (pct != null) {
    const b = baseUsd(f, lens, node);
    return b != null ? (b * pct) / 100 : null;
  }
  return null;
}

export function effPctK(f: Fund, lens: Lens, node: TreeNode, suf: Suf): number | null {
  if (node.depth === 0) return suf === '' ? 100 : null;
  const t = f.matrix[lens][node.key];
  if (!t) return null;
  const pct = t[field('pct', suf)];
  if (pct != null) return pct;
  const usd = t[field('usd', suf)];
  if (usd != null) {
    const b = baseUsd(f, lens, node);
    return b ? (usd / b) * 100 : null;
  }
  return null;
}

export const effUsd = (f: Fund, lens: Lens, node: TreeNode) => effUsdK(f, lens, node, '');
export const effPct = (f: Fund, lens: Lens, node: TreeNode) => effPctK(f, lens, node, '');

export interface BandCell {
  v: number | null;
  /** True when the value is implied by the other measure, not typed. */
  imp: boolean;
}

/** [min, target, max] for a measure, typed or implied by the other measure. */
export function band(f: Fund, lens: Lens, node: TreeNode, k: Measure): BandCell[] {
  const t = (node.depth === 0 ? programBand(f) : f.matrix[lens][node.key]) || {};
  return SUFS.map((suf) => {
    const ex = t[field(k, suf)];
    if (ex != null && !(node.depth === 0 && k === 'pct')) return { v: ex, imp: false };
    if (k === 'usd') {
      const v = effUsdK(f, lens, node, suf);
      return { v, imp: v != null };
    }
    if (k === 'pct') {
      const v = effPctK(f, lens, node, suf);
      return { v, imp: v != null && node.depth > 0 };
    }
    return { v: null, imp: false };
  });
}

export type BandClass = 'none' | 'below' | 'above' | 'at' | 'in' | 'under' | 'over';
export interface BandState {
  cls: BandClass;
  text: string;
}

export function bandStatus(a: number | null, lo: number | null, tg: number | null, hi: number | null): BandState {
  if (lo == null && tg == null && hi == null) return { cls: 'none', text: 'No target' };
  const av = a ?? 0;
  if (lo != null && av < lo - 1e-9) return { cls: 'below', text: 'Below min' };
  if (hi != null && av > hi + 1e-9) return { cls: 'above', text: 'Above max' };
  if (tg != null) {
    const r = tg ? av / tg : 1;
    if (Math.abs(r - 1) <= 0.05) return { cls: 'at', text: 'At target' };
    if (lo != null || hi != null) return { cls: 'in', text: r < 1 ? 'In range · under target' : 'In range · over target' };
    return r < 1 ? { cls: 'under', text: `${Math.round(r * 100)}% of target` } : { cls: 'over', text: 'Over target' };
  }
  return { cls: 'in', text: 'In range' };
}

export const STATUS_RANK: Record<BandClass, number> = { above: 5, below: 4, over: 3, under: 2, in: 1, at: 1, none: 0 };

// ---------- actuals ----------

/** The sleeve's own commitments, or every sleeve's for a client. */
export function commitmentsOf(f: Fund, funds: Fund[], all: Commitment[]): Commitment[] {
  if (f.kind === 'client') {
    const ids = new Set(funds.filter((s) => s.parentId === f.id).map((s) => s.id));
    return all.filter((c) => ids.has(c.sleeveId));
  }
  return all.filter((c) => c.sleeveId === f.id);
}

/** The node keys a classified investment counts toward in one lens, from the root down. */
export function tagKeys(tags: Commitment['tags'], lens: Lens): string[] {
  const seq = lens === 'strategy' ? [tags.cat, tags.ac, tags.st, tags.sub] : lens === 'region' ? [tags.rg, tags.ac] : [tags.cat, tags.ty, tags.det];
  const keys = [''];
  const p: string[] = [];
  for (const v of seq) {
    if (!v) break;
    p.push(v);
    keys.push(p.join(KEY_SEP));
  }
  return keys;
}

export type Actuals = Record<string, { usd: number; n: number }>;

export function actualMap(list: Commitment[], lens: Lens): Actuals {
  const m: Actuals = {};
  for (const c of list) {
    for (const k of tagKeys(c.tags, lens)) {
      const a = m[k] || (m[k] = { usd: 0, n: 0 });
      a.usd += c.amount;
      a.n += 1;
    }
  }
  return m;
}

export function actualOf(f: Fund, node: TreeNode, A: Actuals, k: Measure): number | null {
  const a = A[node.key];
  if (k === 'usd') return a ? a.usd : null;
  if (k === 'n') return a ? a.n : null;
  if (node.depth === 0 || !a) return a ? 100 : null;
  const base = f.basis === 'PARENT_LEVEL' ? A[node.parent?.key ?? '']?.usd || 0 : A['']?.usd || 0;
  return base ? (a.usd / base) * 100 : null;
}

export interface MeasureState {
  /** The band that is judged. Implied % values are hints only. */
  b: BandCell[];
  hint: BandCell[];
  a: number | null;
  st: BandState;
}

export function measureStatus(f: Fund, lens: Lens, node: TreeNode, A: Actuals, k: Measure): MeasureState {
  const b = band(f, lens, node, k);
  const a = actualOf(f, node, A, k);
  // Actual % is a share of committed commitments, so only a typed % band is judged.
  const sb = k === 'pct' ? b.map((x) => (x.imp ? { v: null, imp: false } : x)) : b;
  return { b: sb, hint: b, a, st: bandStatus(a, sb[0].v, sb[1].v, sb[2].v) };
}

export function worstStatus(f: Fund, lens: Lens, node: TreeNode, A: Actuals): BandState {
  let w: BandState = { cls: 'none', text: 'No target' };
  for (const m of MEASURES) {
    const s = measureStatus(f, lens, node, A, m.k).st;
    if (STATUS_RANK[s.cls] > STATUS_RANK[w.cls]) w = s;
  }
  return w;
}

export const countLens = (f: Fund, lens: Lens) => Object.values(f.matrix[lens]).filter(hasTarget).length;
export const countAll = (f: Fund) => LENSES.reduce((s, l) => s + countLens(f, l), 0);

export function countBelow(f: Fund, lens: Lens, node: TreeNode): number {
  let c = 0;
  node.children.forEach((ch) => walk(ch, (n) => { if (hasTarget(f.matrix[lens][n.key])) c += 1; }));
  return c;
}

export interface ChildSum {
  sym: '$' | '#';
  ratio: number;
  tone: 'ok' | 'under' | 'over';
  text: string;
  title: string;
}

/** The next level's targets against this row: dollars as coverage, investments as n / N. */
export function childSums(f: Fund, lens: Lens, node: TreeNode): ChildSum[] {
  if (!node.children.length) return [];
  const out: ChildSum[] = [];
  const tone = (r: number): ChildSum['tone'] => (Math.abs(r - 1) < 0.005 ? 'ok' : r < 1 ? 'under' : 'over');
  const P = effUsd(f, lens, node);
  let S = 0;
  let c = 0;
  node.children.forEach((ch) => { const v = effUsd(f, lens, ch); if (v != null) { S += v; c += 1; } });
  if (P && c) out.push({ sym: '$', ratio: S / P, tone: tone(S / P), text: `$ ${Math.round((S / P) * 100)}%`, title: `${c} of ${node.children.length} children targeted` });
  const Pn = node.depth === 0 ? f.programN : f.matrix[lens][node.key]?.n;
  let Sn = 0;
  let cn = 0;
  node.children.forEach((ch) => { const t = f.matrix[lens][ch.key]; if (t?.n != null) { Sn += t.n; cn += 1; } });
  if (Pn && cn) out.push({ sym: '#', ratio: Sn / Pn, tone: tone(Sn / Pn), text: `# ${Sn}/${Pn}`, title: `Children total ${Sn} investments against ${Pn} at this level` });
  return out;
}

/** On a sleeve, the client's target for the same level. On a client, the sleeves' dollar targets added up. */
export function comparatorOf(f: Fund, funds: Fund[], lens: Lens, node: TreeNode): { usd: number | null; pct: number | null; n: number | null; sleevesSet?: number; sleeves?: number } | null {
  if (f.kind === 'client') {
    const sleeves = funds.filter((s) => s.parentId === f.id);
    let S = 0;
    let c = 0;
    sleeves.forEach((s) => { const v = effUsd(s, lens, node); if (v != null) { S += v; c += 1; } });
    return c ? { usd: S, pct: null, n: null, sleevesSet: c, sleeves: sleeves.length } : null;
  }
  const p = funds.find((x) => x.id === f.parentId);
  if (!p) return null;
  if (node.depth > 0 && !hasTarget(p.matrix[lens][node.key])) return null;
  return {
    usd: effUsd(p, lens, node),
    pct: node.depth > 0 ? effPct(p, lens, node) : null,
    n: node.depth === 0 ? p.programN : p.matrix[lens][node.key]?.n ?? null,
  };
}

/** Set one cell of a band. Null clears it; an emptied band is removed. */
export function withCell(f: Fund, lens: Lens, key: string, k: Measure, suf: Suf, v: number | null) {
  const matrix = structuredClone(f.matrix);
  if (key === '') {
    const program = { ...matrix.program, [field(k, suf)]: v };
    if (v == null) delete program[field(k, suf)];
    matrix.program = program;
    return matrix;
  }
  const t: Band = { ...(matrix[lens][key] || {}), [field(k, suf)]: v };
  if (v == null) delete t[field(k, suf)];
  if (hasTarget(t)) matrix[lens][key] = t;
  else delete matrix[lens][key];
  return matrix;
}

export { SUFS, field };
export type { Suf };
