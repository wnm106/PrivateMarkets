/**
 * Deployment pacing: the one home for year targets, velocity and run-rate.
 * Everything is measured at the user's As Of date.
 */
import type { Commitment, Fund } from './types';
import { parseDay } from './format';

const DAY = 864e5;

export function startOf(f: Fund, asOf: Date): Date {
  return parseDay(f.start) ?? new Date(asOf.getFullYear(), 0, 1);
}

/** End of the investment period; five years after the start when none is recorded. */
export function endOf(f: Fund, asOf: Date): Date {
  const end = parseDay(f.end);
  if (end) return end;
  const s = startOf(f, asOf);
  return new Date(s.getFullYear() + 5, s.getMonth(), s.getDate() - 1);
}

/** A year's deployment target: the override for that year, else the annual target, pro-rated in the first year. */
export function yearTarget(f: Fund, year: number, asOf: Date): number {
  const st = startOf(f, asOf);
  const y0 = st.getFullYear();
  if (year < y0) return 0;
  const o = f.overrides[String(year)];
  if (o != null) return o;
  const a = f.annual || 0;
  if (year === y0) {
    const ye = new Date(year + 1, 0, 1);
    return (a * (ye.getTime() - st.getTime())) / (ye.getTime() - new Date(year, 0, 1).getTime());
  }
  return a;
}

export interface PacingRow {
  year: number;
  target: number;
  /** Time-weighted target to the As Of date, for the current year. */
  targetToDate: number | null;
  deployed: number | null;
  count: number | null;
  bySleeve: Record<string, number>;
  cumTarget: number | null;
  cumDeployed: number | null;
  future: boolean;
  current: boolean;
  override: boolean;
}

export interface Pacing {
  rows: PacingRow[];
  current: PacingRow | undefined;
  start: Date;
  cumDeployed: number;
  cumTarget: number;
  ltm: number;
  remaining: number | null;
  count: number;
  ytdVelocity: number | null;
  cumVelocity: number | null;
  yearsAtRunRate: number | null;
}

export function pacingOf(f: Fund, list: Commitment[], asOf: Date): Pacing {
  const st = startOf(f, asOf);
  const y0 = st.getFullYear();
  const asOfY = asOf.getFullYear();
  const known = list.filter((c) => (parseDay(c.date)?.getTime() ?? Infinity) <= asOf.getTime());
  const byYear: Record<number, { usd: number; n: number; by: Record<string, number> }> = {};
  for (const c of known) {
    const y = Number(c.date.slice(0, 4));
    const r = byYear[y] || (byYear[y] = { usd: 0, n: 0, by: {} });
    r.usd += c.amount;
    r.n += 1;
    r.by[c.sleeveId] = (r.by[c.sleeveId] || 0) + c.amount;
  }
  const first = Math.min(y0, ...Object.keys(byYear).map(Number));
  const rows: PacingRow[] = [];
  let cumT = 0;
  let cumD = 0;
  for (let y = first; y <= asOfY + 2; y += 1) {
    const t = yearTarget(f, y, asOf);
    const d = byYear[y] || { usd: 0, n: 0, by: {} };
    const past = y <= asOfY;
    let tToDate = t;
    if (y === asOfY) {
      const from = y === y0 ? st : new Date(y, 0, 1);
      const ye = new Date(y + 1, 0, 1);
      tToDate = from > asOf ? 0 : (t * (asOf.getTime() - from.getTime())) / (ye.getTime() - from.getTime());
    }
    if (past) {
      cumT += tToDate;
      cumD += d.usd;
    }
    rows.push({
      year: y,
      target: t,
      targetToDate: past ? tToDate : null,
      deployed: past ? d.usd : null,
      count: past ? d.n : null,
      bySleeve: d.by,
      cumTarget: past ? cumT : null,
      cumDeployed: past ? cumD : null,
      future: !past,
      current: y === asOfY,
      override: f.overrides[String(y)] != null,
    });
  }
  const current = rows.find((r) => r.current);
  const ltmFrom = asOf.getTime() - 365 * DAY;
  const ltm = known.filter((c) => (parseDay(c.date)?.getTime() ?? 0) > ltmFrom).reduce((s, c) => s + c.amount, 0);
  const remaining = f.programUsd != null ? Math.max(0, f.programUsd - cumD) : null;
  return {
    rows,
    current,
    start: st,
    cumDeployed: cumD,
    cumTarget: cumT,
    ltm,
    remaining,
    count: known.length,
    ytdVelocity: current && current.targetToDate ? (current.deployed ?? 0) / current.targetToDate : null,
    cumVelocity: cumT ? cumD / cumT : null,
    yearsAtRunRate: remaining != null && ltm ? remaining / ltm : null,
  };
}

export type VelocityTone = 'bad' | 'warn' | 'ok' | 'ahead' | '';

export function velocityTone(v: number | null): [VelocityTone, string] {
  if (v == null || !Number.isFinite(v)) return ['', 'No target'];
  if (v < 0.85) return ['bad', 'Behind'];
  if (v < 0.95) return ['warn', 'Slightly behind'];
  if (v <= 1.15) return ['ok', 'On pace'];
  return ['ahead', 'Ahead'];
}

/** Years left in the investment period at the As Of date. */
export function yearsLeft(f: Fund, asOf: Date): number {
  const en = endOf(f, asOf);
  return Math.max(0, Math.round(((en.getTime() - asOf.getTime()) / DAY / 365) * 100) / 100);
}
