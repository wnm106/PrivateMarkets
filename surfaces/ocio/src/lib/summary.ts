/** Per-fund figures shared by the rail, ribbon, overview and what the assistant is told. */
import type { Commitment, Fund, Lens, OcioData } from './types';
import { LENSES } from './types';
import { commitmentsOf, countAll, countLens, actualMap, measureStatus, walk, hasTarget, nodeLabel, type Trees, type BandClass } from './tree';
import { pacingOf, type Pacing } from './pacing';
import { countRules, type ComplianceCounts, type RuleResult } from './compliance';
import { MEASURES } from './format';

export interface FundSummary {
  fund: Fund;
  list: Commitment[];
  pacing: Pacing;
  committed: number;
  targets: Record<Lens, number>;
  targetCount: number;
  rules: Array<RuleResult & { sleeveId: string; sleeveName: string }> | null;
  counts: ComplianceCounts | null;
  bandIssues: BandIssue[];
}

export interface BandIssue {
  lens: Lens;
  key: string;
  label: string;
  measure: string;
  cls: BandClass;
  text: string;
}

/** Levels whose typed band is breached: above a max or below a min. */
export function bandIssues(f: Fund, list: Commitment[], trees: Trees): BandIssue[] {
  const out: BandIssue[] = [];
  for (const lens of LENSES) {
    const A = actualMap(list, lens);
    walk(trees.roots[lens], (n) => {
      if (!n.depth || !hasTarget(f.matrix[lens][n.key])) return;
      for (const m of MEASURES) {
        const s = measureStatus(f, lens, n, A, m.k);
        if (s.st.cls === 'above' || s.st.cls === 'below') out.push({ lens, key: n.key, label: nodeLabel(n), measure: m.sym, cls: s.st.cls, text: s.st.text });
      }
    });
  }
  return out;
}

export function summarize(f: Fund, data: OcioData, trees: Trees, asOf: Date, rules: Record<string, RuleResult[]> | null): FundSummary {
  const list = commitmentsOf(f, data.funds, data.commitments);
  const pacing = pacingOf(f, list, asOf);
  const targets = Object.fromEntries(LENSES.map((l) => [l, countLens(f, l)])) as Record<Lens, number>;
  let fundRules: FundSummary['rules'] = null;
  if (rules) {
    const sleeves = f.kind === 'client' ? data.funds.filter((s) => s.parentId === f.id) : [f];
    // A sleeve with no result was not scored. Then the fund has no compliance figure at all:
    // "no breaches" may only be said when every sleeve was scored.
    fundRules = sleeves.every((s) => rules[s.id])
      ? sleeves.flatMap((s) => rules[s.id].map((r) => ({ ...r, sleeveId: s.id, sleeveName: s.name })))
      : null;
  }
  return {
    fund: f,
    list,
    pacing,
    committed: pacing.cumDeployed,
    targets,
    targetCount: countAll(f),
    rules: fundRules,
    counts: fundRules ? countRules(fundRules) : null,
    bandIssues: bandIssues(f, list, trees),
  };
}
