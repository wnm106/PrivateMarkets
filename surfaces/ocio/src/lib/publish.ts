/**
 * What every tab tells the assistant, open or not (docs/SURFACE_TABS.md). Built from the
 * same summaries the tabs draw, so the assistant and the screen agree. Lists are capped
 * with totals first; no ids or styling.
 */
import type { SurfaceTabPayload } from '@tapestrai/surface-sdk';
import type { Lens, OcioData } from './types';
import { LENSES } from './types';
import { LENS_INFO, actualMap, band, measureStatus, nodeLabel, walk, hasTarget, effUsd, type Trees } from './tree';
import { MEASURES, fmtPct, fmtUsd, fmtX } from './format';
import { velocityTone } from './pacing';
import { RULE_STATUS, fmtRuleValue } from './compliance';
import type { FundSummary } from './summary';
import { dealViews } from './pipeline';

export const TAB_INFO = {
  strategy: { label: 'Strategy', purpose: 'Target bands for the open client or sleeve across Category, Asset Class, Strategy and Sub-Strategy, against what is committed.' },
  region: { label: 'Region', purpose: 'Target bands across Region and Asset Class, against what is committed.' },
  structure: { label: 'Structure', purpose: 'Target bands across Category, Structure Type and Structure Detail, against what is committed.' },
  pacing: { label: 'Pacing', purpose: 'How fast the open client or sleeve is deploying against its annual deployment target, by year and since inception.' },
  commitments: { label: 'Commitments', purpose: 'The original commitments booked to the open client or sleeve, with their classification and security-master fields.' },
  compliance: { label: 'Compliance', purpose: 'The compliance engine’s results for the open client’s sleeves or the open sleeve: which rules are breached, soft-breached, near a limit or pending.' },
  overview: { label: 'Overview', purpose: 'Coverage, pacing and compliance across every client program and mandate sleeve.' },
  pipeline: { label: 'Pipeline', purpose: 'The deal pipeline, what each deal offers our sleeves, and what has been staged for review.' },
} as const;

export type TabKey = keyof typeof TAB_INFO;

const BAND_HOW = 'Each level has a min, target and max for dollars ($), number of investments (#) and percent (%). A band is met when the committed amount is between min and max; "at target" is within 5% of the target. Percent targets are a share of the program, or of the level above when the basis is Parent level. Implied values (≈) are derived from the other measure and are not judged. Children do not have to add up to the parent; childrenCoverage is the next level’s dollar targets as a share of this level’s.';

function lensData(s: FundSummary, lens: Lens, trees: Trees) {
  const f = s.fund;
  const A = actualMap(s.list, lens);
  const levels: Array<Record<string, unknown>> = [];
  let breached = 0;
  walk(trees.roots[lens], (n) => {
    if (!n.depth || !hasTarget(f.matrix[lens][n.key])) return;
    const row: Record<string, unknown> = { level: nodeLabel(n), tag: n.tag };
    let worst = 'none';
    for (const m of MEASURES) {
      const b = band(f, lens, n, m.k);
      const st = measureStatus(f, lens, n, A, m.k);
      if (b.every((x) => x.v == null) && st.a == null) continue;
      const fmt = (v: number | null) => (v == null ? null : m.k === 'usd' ? fmtUsd(v) : m.k === 'pct' ? fmtPct(v) : v);
      row[m.name.toLowerCase()] = { min: fmt(b[0].v), target: fmt(b[1].v), max: fmt(b[2].v), implied: b[1].imp || undefined, actual: fmt(st.a), status: st.st.text };
      if (st.st.cls === 'above' || st.st.cls === 'below') { worst = st.st.text; }
    }
    if (worst !== 'none') breached += 1;
    levels.push(row);
  });
  const top = trees.roots[lens].children.map((n) => effUsd(f, lens, n)).filter((v): v is number => v != null);
  const coverage = f.programUsd && top.length ? top.reduce((a, b) => a + b, 0) / f.programUsd : null;
  return {
    openRecord: `${f.name} (${f.kind === 'client' ? 'client program' : 'mandate sleeve'})`,
    hierarchy: LENS_INFO[lens].path,
    percentBasis: f.basis === 'PARENT_LEVEL' ? 'Parent level' : 'Program',
    program: fmtUsd(f.programUsd) || null,
    committed: fmtUsd(s.committed) || '$0',
    targetsAssigned: s.targets[lens],
    levelsOutsideBand: breached,
    topLevelCoverageOfProgram: coverage != null ? fmtPct(coverage * 100) : null,
    levels: levels.slice(0, 80),
  };
}

export function buildTabs(args: {
  open: FundSummary | null;
  summaries: FundSummary[];
  data: OcioData | null;
  trees: Trees | null;
  asOf: Date;
  complianceLoaded: boolean;
}): Record<TabKey, SurfaceTabPayload> {
  const { open, summaries, data, trees, asOf, complianceLoaded } = args;
  const ready = !!(open && data && trees);
  const tabs = {} as Record<TabKey, SurfaceTabPayload>;
  for (const lens of LENSES) {
    tabs[lens] = { ...TAB_INFO[lens], howToRead: BAND_HOW, data: ready ? lensData(open!, lens, trees!) : null };
  }
  const P = open?.pacing;
  tabs.pacing = {
    ...TAB_INFO.pacing,
    howToRead: 'Velocity is deployment so far this year over the time-weighted annual target: above 1.15x is ahead, 0.95x to 1.15x on pace, 0.85x to 0.95x slightly behind, below 0.85x behind. The first year’s target is prorated from the start date; a year with its own target overrides the annual target. Measured at the user’s As Of date.',
    data: !ready || !P ? null : {
      openRecord: open!.fund.name,
      asOf: asOf.toISOString().slice(0, 10),
      annualTarget: fmtUsd(open!.fund.annual) || null,
      currentYear: P.current ? { year: P.current.year, target: fmtUsd(P.current.target), deployed: fmtUsd(P.current.deployed) || '$0', expectedToDate: fmtUsd(P.current.targetToDate) || '$0', velocity: fmtX(P.ytdVelocity), status: velocityTone(P.ytdVelocity)[1] } : null,
      sinceInception: { deployed: fmtUsd(P.cumDeployed) || '$0', target: fmtUsd(P.cumTarget) || '$0', velocity: fmtX(P.cumVelocity), status: velocityTone(P.cumVelocity)[1] },
      runRateLast12Months: fmtUsd(P.ltm) || '$0',
      programRemaining: fmtUsd(P.remaining),
      yearsLeftAtRunRate: P.yearsAtRunRate != null ? Math.round(P.yearsAtRunRate * 10) / 10 : null,
      investmentsMade: P.count,
      years: P.rows.map((r) => ({ year: r.year, target: fmtUsd(r.target) || '$0', deployed: r.deployed != null ? fmtUsd(r.deployed) || '$0' : null, investments: r.count, overridden: r.override || undefined, future: r.future || undefined })),
    },
  };
  tabs.commitments = {
    ...TAB_INFO.commitments,
    howToRead: 'Amounts are original commitments in dollars. Category, asset class, strategy, region and structure are the target hierarchy levels the commitment counts toward.',
    data: !ready ? null : (() => {
      const labels = data!.taxonomy.labels;
      const name = (id: string) => data!.funds.find((f) => f.id === id)?.name;
      const byYear: Record<string, number> = {};
      open!.list.forEach((c) => { const y = c.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + c.amount; });
      return {
        openRecord: open!.fund.name,
        count: open!.list.length,
        totalCommitted: fmtUsd(open!.committed) || '$0',
        committedByYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, v]) => [y, fmtUsd(v)])),
        commitments: open!.list.slice(0, 80).map((c) => ({
          name: c.name, sleeve: open!.fund.kind === 'client' ? name(c.sleeveId) : undefined, date: c.date, amount: fmtUsd(c.amount), manager: c.manager,
          category: c.tags.cat ? labels[c.tags.cat] : null, assetClass: c.tags.ac ? labels[c.tags.ac] : null, strategy: c.tags.st ? labels[c.tags.st] : null,
          region: c.tags.rg ? labels[c.tags.rg] : null, structure: c.tags.ty ? labels[c.tags.ty] : null, investmentType: c.investmentType, sector: c.sector,
        })),
      };
    })(),
  };
  tabs.compliance = {
    ...TAB_INFO.compliance,
    howToRead: 'Breach is past a hard limit; soft breach is past a guideline; watch is within 10% of a limit but passing; pending is an open attestation or review, not a breach. Results come from the compliance engine at the user’s As Of and Knowledge dates. Target-band issues are separate: they come from the targets, not the rule book.',
    data: !ready || !complianceLoaded || !open!.rules ? null : {
      openRecord: open!.fund.name,
      counts: open!.counts,
      rules: open!.rules.slice(0, 80).map((r) => ({
        rule: r.ruleName, sleeve: open!.fund.kind === 'client' ? r.sleeveName : undefined, status: RULE_STATUS[r.status].label, severity: r.severity ?? undefined,
        limit: r.limit != null ? `${r.direction === 'MIN' ? 'at least' : 'at most'} ${fmtRuleValue(r.unit, r.limit)}` : null,
        result: fmtRuleValue(r.unit, r.value), worst: r.worst,
      })),
      targetBandIssues: open!.bandIssues.slice(0, 40).map((b) => ({ hierarchy: LENS_INFO[b.lens].label, level: b.label, measure: b.measure, status: b.text })),
    },
  };
  tabs.overview = {
    ...TAB_INFO.overview,
    howToRead: 'Clients are listed with their sleeves under them. A client’s figures cover all of its sleeves. Velocity reads as on the Pacing tab.',
    data: !data ? null : {
      programs: summaries.slice(0, 60).map((s) => ({
        name: s.fund.name, kind: s.fund.kind === 'client' ? 'client' : 'sleeve', program: fmtUsd(s.fund.programUsd) || null, investments: `${s.pacing.count} of ${s.fund.programN ?? '—'}`,
        annualTarget: fmtUsd(s.fund.annual) || null, deployedThisYear: fmtUsd(s.pacing.current?.deployed) || '$0', velocity: fmtX(s.pacing.ytdVelocity), sinceInception: fmtX(s.pacing.cumVelocity),
        compliance: s.counts ? { breaches: s.counts.breach, softBreaches: s.counts.soft, watch: s.counts.watch, pending: s.counts.pending } : 'loading', targets: s.targetCount,
      })),
    },
  };
  tabs.pipeline = {
    ...TAB_INFO.pipeline,
    howToRead: 'Our hold is the part of each deal offered to our sleeves. Staged is what has been written as draft funding plans for review; nothing is booked until a person approves it. Sharing ratios and compliance capacity are worked out when a deal is opened in the allocation grid.',
    data: !data ? null : (() => {
      const views = dealViews(data, asOf);
      const labels = data.taxonomy.labels;
      return {
        deals: views.length,
        totalHold: fmtUsd(views.reduce((s, v) => s + v.hold, 0)),
        staged: fmtUsd(views.reduce((s, v) => s + v.staged, 0)) || '$0',
        list: views.slice(0, 60).map((v) => ({
          deal: v.deal.name, stage: v.stageLabel, close: v.deal.close, dealSize: fmtUsd(v.deal.size), ourHold: fmtUsd(v.hold), staged: v.staged ? fmtUsd(v.staged) : null,
          category: v.deal.tags.cat ? labels[v.deal.tags.cat] : null, strategy: v.deal.tags.st ? labels[v.deal.tags.st] : null, region: v.deal.tags.rg ? labels[v.deal.tags.rg] : null, manager: v.deal.manager,
        })),
      };
    })(),
  };
  return tabs;
}
