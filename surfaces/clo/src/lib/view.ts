/**
 * Groupings the tabs draw, worked out once so the screen and what the assistant is told agree.
 * Every figure here is a sum or a share of values cloBook returned; no test is re-scored here.
 */
import type { Holding, Kpi, Term, Test, Vehicle } from './data';

export interface Bucket { key: string; label: string; count: number; par: number; pct: number | null; holdings: Holding[] }

function bucket(holdings: Holding[], keyOf: (h: Holding) => string, labelOf: (key: string) => string = (k) => k, total?: number): Bucket[] {
  const base = total ?? holdings.reduce((s, h) => s + h.par, 0);
  const map = new Map<string, Holding[]>();
  for (const h of holdings) map.set(keyOf(h), [...(map.get(keyOf(h)) || []), h]);
  return [...map.entries()].map(([key, list]) => {
    const par = list.reduce((s, h) => s + h.par, 0);
    return { key, label: labelOf(key), count: list.length, par, pct: base ? (par / base) * 100 : null, holdings: list };
  }).sort((a, b) => b.par - a.par);
}

export const byIndustry = (v: Vehicle) => bucket(v.holdings, (h) => h.industry || 'No Moody’s industry');
export const byObligor = (v: Vehicle) => bucket(v.holdings.filter((h) => !h.defaulted), (h) => h.obligorGroup || h.issuer || h.positionId, undefined, v.collateral.performingPar);

const RATING_ORDER = ['Aaa', 'Aa1', 'Aa2', 'Aa3', 'A1', 'A2', 'A3', 'Baa1', 'Baa2', 'Baa3', 'Ba1', 'Ba2', 'Ba3', 'B1', 'B2', 'B3', 'Caa1', 'Caa2', 'Caa3', 'Ca', 'C'];
export function byRating(v: Vehicle): Bucket[] {
  const rows = bucket(v.holdings, (h) => h.ratingMoodys || 'Unrated');
  return rows.sort((a, b) => (RATING_ORDER.indexOf(a.key) + 100) % 100 - (RATING_ORDER.indexOf(b.key) + 100) % 100);
}
export function byMaturityYear(v: Vehicle): Bucket[] {
  return bucket(v.holdings, (h) => (h.maturity ? h.maturity.slice(0, 4) : 'No maturity')).sort((a, b) => a.key.localeCompare(b.key));
}

/** Terms grouped by their section in the register, in register order. */
export function termSections(v: Vehicle): Array<{ section: string; terms: Term[] }> {
  const map = new Map<string, Term[]>();
  for (const t of v.terms) map.set(t.section, [...(map.get(t.section) || []), t]);
  return [...map.entries()].map(([section, terms]) => ({ section, terms: terms.sort((a, b) => a.order - b.order) }));
}

export const CATEGORY_LABEL: Record<string, string> = {
  COVERAGE: 'Coverage tests', COLLATERAL_QUALITY: 'Collateral quality tests', CONCENTRATION: 'Concentration limits', ELIGIBILITY: 'Eligibility criteria', OTHER: 'Other tests',
};
export const CATEGORY_ORDER = ['COVERAGE', 'COLLATERAL_QUALITY', 'CONCENTRATION', 'ELIGIBILITY', 'OTHER'];

const STATUS_RANK: Record<string, number> = { HARD_BREACH: 0, SOFT_BREACH: 1, ERROR: 2, NO_DATA: 3, PASS: 4 };

/** Tests grouped by category. Within a category, breaches first, then the tightest cushion. A grouped test shows its failing groups and its tightest passing one. */
export function testGroups(v: Vehicle): Array<{ category: string; label: string; tests: Test[] }> {
  const groups = new Map<string, Test[]>();
  for (const t of v.tests) {
    const c = CATEGORY_ORDER.includes(t.category) ? t.category : 'OTHER';
    groups.set(c, [...(groups.get(c) || []), t]);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => {
    const all = groups.get(c)!;
    const keep: Test[] = [];
    const byRule = new Map<string, Test[]>();
    for (const t of all) byRule.set(t.ruleCode, [...(byRule.get(t.ruleCode) || []), t]);
    for (const list of byRule.values()) {
      const grouped = list.filter((t) => t.group);
      if (!grouped.length) { keep.push(...list); continue; }
      const failing = grouped.filter((t) => t.status !== 'PASS');
      const tightest = grouped.filter((t) => t.status === 'PASS').sort((a, b) => (a.cushionPct ?? 1e9) - (b.cushionPct ?? 1e9))[0];
      keep.push(...failing, ...(tightest ? [tightest] : []), ...list.filter((t) => !t.group));
    }
    keep.sort((a, b) => (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5) || (a.cushionPct ?? 1e9) - (b.cushionPct ?? 1e9));
    return { category: c, label: CATEGORY_LABEL[c], tests: keep };
  });
}

/** How many groups a grouped test scored, and how many of them fail. */
export function groupCounts(v: Vehicle, ruleCode: string): { scored: number; failing: number } {
  const list = v.tests.filter((t) => t.ruleCode === ruleCode && t.group);
  return { scored: list.length, failing: list.filter((t) => t.status === 'HARD_BREACH').length };
}

export const headline = (v: Vehicle, metric: Kpi['metric']) => v.kpis.find((k) => k.metric === metric && k.rank == null) ?? null;

/** The most junior coverage test on the deal, the one closest to diverting cash. */
export function juniorOc(v: Vehicle): Kpi | null {
  const oc = v.kpis.filter((k) => k.metric === 'OC' && k.rank != null).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  return oc[0] ?? null;
}

export const kpiKey = (k: Pick<Kpi, 'metric' | 'rank'>) => `${k.metric}${k.rank ?? ''}`;
