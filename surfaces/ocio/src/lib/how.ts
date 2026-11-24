/**
 * How each derived figure is worked out, in words, with the records behind it. Shown when a
 * person right-clicks a figure that has no attribute of its own. The numbers come from the
 * same summaries the screen draws; nothing is recomputed here.
 */
import type { Derivation } from '../components/common';
import type { Commitment } from './types';
import type { FundSummary } from './summary';
import { fmtDate, fmtUsd, fmtX } from './format';
import { velocityTone } from './pacing';
import { RULE_STATUS } from './compliance';
import { commitmentBind, fundBind, yearTargetBind } from './binds';

const LISTED = 12;

export function commitmentRows(list: Commitment[]): Pick<Derivation, 'rows' | 'more'> {
  const sorted = [...list].sort((a, b) => b.amount - a.amount);
  return {
    rows: sorted.slice(0, LISTED).map((c) => ({ label: c.name, sub: [c.manager, c.date].filter(Boolean).join(' · '), value: fmtUsd(c.amount), bind: commitmentBind.amount(c) })),
    more: sorted.length > LISTED ? sorted.length - LISTED : undefined,
  };
}

export function committedHow(s: FundSummary): Derivation {
  const f = s.fund;
  const pct = f.programUsd ? Math.round((s.pacing.cumDeployed / f.programUsd) * 100) : null;
  return {
    title: `${f.name} committed`,
    value: pct != null ? `${pct}%` : undefined,
    formula: 'Original commitments made since the start of the investment period, added up, as a share of the program size.',
    rows: [
      { label: 'Committed to date', value: fmtUsd(s.pacing.cumDeployed) || '$0' },
      { label: 'Program size', value: fmtUsd(f.programUsd) || '—', bind: fundBind.program(f) },
    ],
  };
}

export function investmentsHow(s: FundSummary): Derivation {
  return {
    title: `${s.fund.name} investments made`,
    value: String(s.pacing.count),
    formula: `The number of original commitments booked to ${s.fund.kind === 'client' ? 'this client’s sleeves' : 'this sleeve'} as of your As Of date.`,
    ...commitmentRows(s.list),
  };
}

export function deployedHow(s: FundSummary, year: number): Derivation {
  const inYear = s.list.filter((c) => c.date.startsWith(String(year)));
  return {
    title: `${s.fund.name} ${year} deployment`,
    value: fmtUsd(inYear.reduce((sum, c) => sum + c.amount, 0)) || '$0',
    formula: `Original commitments with a commit date in ${year}, added up, as of your As Of date.`,
    ...commitmentRows(inYear),
  };
}

export function velocityHow(s: FundSummary, asOf: Date): Derivation {
  const c = s.pacing.current;
  return {
    title: `${s.fund.name} pacing velocity`,
    value: `${fmtX(s.pacing.ytdVelocity)} · ${velocityTone(s.pacing.ytdVelocity)[1]}`,
    formula: `Deployed so far this year, divided by the part of this year's target that should be deployed by ${fmtDate(asOf)}. Above 1.15x is ahead, 0.95x to 1.15x on pace, 0.85x to 0.95x slightly behind, below 0.85x behind.`,
    rows: c ? [
      { label: `Deployed in ${c.year}`, value: fmtUsd(c.deployed) || '$0' },
      { label: `${c.year} target`, value: fmtUsd(c.target) || '$0', bind: yearTargetBind(s.fund, c.year) },
      { label: `Expected by ${fmtDate(asOf)}`, value: fmtUsd(c.targetToDate) || '$0' },
    ] : [],
  };
}

export function cumVelocityHow(s: FundSummary): Derivation {
  return {
    title: `${s.fund.name} velocity since inception`,
    value: fmtX(s.pacing.cumVelocity),
    formula: 'Everything deployed since the investment period started, divided by the yearly targets added up to your As Of date. The first year is prorated from the start date.',
    rows: [
      { label: 'Deployed since inception', value: fmtUsd(s.pacing.cumDeployed) || '$0' },
      { label: 'Target to date', value: fmtUsd(s.pacing.cumTarget) || '$0' },
      { label: 'Investment period start', value: fmtDate(s.pacing.start), bind: fundBind.start(s.fund) },
    ],
  };
}

export function runRateHow(s: FundSummary): Derivation {
  const P = s.pacing;
  return {
    title: `${s.fund.name} run-rate`,
    value: `${fmtUsd(P.ltm) || '$0'}/yr`,
    formula: 'Original commitments made in the 12 months to your As Of date. What is left is the program size less everything committed; years at this pace is what is left divided by the run-rate.',
    rows: [
      { label: 'Committed in the last 12 months', value: fmtUsd(P.ltm) || '$0' },
      { label: 'Program size', value: fmtUsd(s.fund.programUsd) || '—', bind: fundBind.program(s.fund) },
      { label: 'Left to commit', value: P.remaining != null ? fmtUsd(P.remaining) || '$0' : '—' },
      { label: 'Years at this pace', value: P.yearsAtRunRate != null ? P.yearsAtRunRate.toFixed(1) : '—' },
    ],
  };
}

export function complianceHow(s: FundSummary): Derivation {
  const out = (s.rules || []).filter((r) => r.status !== 'pass' && r.status !== 'na');
  return {
    title: `${s.fund.name} compliance`,
    value: s.counts ? `${s.counts.breach} breach${s.counts.breach === 1 ? '' : 'es'}` : undefined,
    formula: `Scored by the compliance engine on every rule ${s.fund.kind === 'client' ? 'its sleeves are' : 'this sleeve is'} enrolled in, at your As Of and Knowledge dates. The surface counts the results; it does not evaluate rules.`,
    rows: out.slice(0, LISTED).map((r) => ({ label: r.ruleName, sub: s.fund.kind === 'client' ? r.sleeveName : undefined, value: RULE_STATUS[r.status].label })),
    more: out.length > LISTED ? out.length - LISTED : undefined,
  };
}

export function targetCountHow(s: FundSummary): Derivation {
  return {
    title: `${s.fund.name} targets assigned`,
    value: String(s.targetCount),
    formula: 'The number of hierarchy levels that carry a minimum, target or maximum in any measure, across Strategy, Region and Structure. Each level is its own allocation target record; open a hierarchy tab and right-click a value for its sources.',
    rows: [
      { label: 'Strategy', value: String(s.targets.strategy) },
      { label: 'Region', value: String(s.targets.region) },
      { label: 'Structure', value: String(s.targets.structure) },
    ],
  };
}
