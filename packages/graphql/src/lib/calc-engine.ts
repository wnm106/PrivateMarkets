/**
 * Pure calc helpers. The database functions in
 * supabase/migrations/20261014123530_calculated_attributes.sql are the runtime.
 * These match that behavior so the graph rules can be tested without Postgres.
 */

export type Expr =
  | { const: number }
  | { ref: string }
  | { op: 'neg'; args: [Expr] }
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: [Expr, Expr] };

export function evalNumericExpr(expr: Expr, vars: Record<string, number | null>): number | null {
  if ('const' in expr) return expr.const;
  if ('ref' in expr) {
    const value = vars[expr.ref];
    return value === undefined ? null : value;
  }
  if (expr.op === 'neg') {
    const value = evalNumericExpr(expr.args[0], vars);
    return value === null ? null : -value;
  }
  const left = evalNumericExpr(expr.args[0], vars);
  const right = evalNumericExpr(expr.args[1], vars);
  if (left === null || right === null) return null;
  if (expr.op === 'add') return left + right;
  if (expr.op === 'sub') return left - right;
  if (expr.op === 'mul') return left * right;
  if (right === 0) return null;
  return left / right;
}

function npv(dates: string[], amounts: number[], rate: number): number | null {
  if (rate <= -1) return null;
  const origin = dates.reduce((min, date) => (date < min ? date : min));
  const originMs = Date.parse(`${origin}T00:00:00Z`);
  let total = 0;
  for (let i = 0; i < dates.length; i += 1) {
    const yearFrac = (Date.parse(`${dates[i]}T00:00:00Z`) - originMs) / 86400000 / 365;
    total += amounts[i] / Math.exp(yearFrac * Math.log(1 + rate));
  }
  return total;
}

/** Actual/365 XIRR. Returns null when the solver cannot separate positive and negative flows. */
export function xirr(dates: string[], amounts: number[]): number | null {
  if (dates.length < 2 || dates.length !== amounts.length) return null;
  if (!amounts.some((amount) => amount > 0) || !amounts.some((amount) => amount < 0)) return null;

  const origin = dates.reduce((min, date) => (date < min ? date : min));
  const originMs = Date.parse(`${origin}T00:00:00Z`);
  let rate = 0.1;
  for (let i = 0; i < 40; i += 1) {
    if (rate <= -0.999999) break;
    let value = 0;
    let deriv = 0;
    for (let j = 0; j < dates.length; j += 1) {
      const yearFrac = (Date.parse(`${dates[j]}T00:00:00Z`) - originMs) / 86400000 / 365;
      const discount = Math.exp(yearFrac * Math.log(1 + rate));
      value += amounts[j] / discount;
      deriv -= (yearFrac * amounts[j]) / (discount * (1 + rate));
    }
    if (deriv === 0) break;
    const next = rate - value / deriv;
    if (Math.abs(value) < 1e-7 && Math.abs(next - rate) < 1e-7) return Math.round(next * 1e10) / 1e10;
    if (next <= -0.999999 || next > 100) break;
    rate = next;
  }

  let lo = -0.9;
  let hi = 10;
  let npvLo = npv(dates, amounts, lo);
  const npvHi = npv(dates, amounts, hi);
  if (npvLo === null || npvHi === null || npvLo * npvHi > 0) return null;
  let mid = rate;
  for (let i = 0; i < 80; i += 1) {
    mid = (lo + hi) / 2;
    const value = npv(dates, amounts, mid);
    if (value === null) return null;
    if (Math.abs(value) < 1e-7 || hi - lo < 1e-7) return Math.round(mid * 1e10) / 1e10;
    if (npvLo * value < 0) hi = mid;
    else {
      lo = mid;
      npvLo = value;
    }
  }
  return Math.round(mid * 1e10) / 1e10;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function endOfPeriod(grain: 'MONTH_END' | 'QUARTER_END' | 'YEAR_END', year: number, month: number): string {
  if (grain === 'YEAR_END') return iso(year, 12, 31);
  if (grain === 'MONTH_END') return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const quarterEndMonth = Math.floor((month - 1) / 3) * 3 + 3;
  return new Date(Date.UTC(year, quarterEndMonth, 0)).toISOString().slice(0, 10);
}

/** Quarter, month, or year ends on or after start and on or before cap. */
export function periodEnds(
  grain: 'MONTH_END' | 'QUARTER_END' | 'YEAR_END',
  start: string,
  end: string,
  today: string,
): string[] {
  const cap = end < today ? end : today;
  if (start > cap) return [];
  const step = grain === 'MONTH_END' ? 1 : grain === 'YEAR_END' ? 12 : 3;
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const dates: string[] = [];
  for (let guard = 0; guard < 400; guard += 1) {
    const boundary = endOfPeriod(grain, year, month);
    if (boundary > cap) break;
    if (boundary >= start) dates.push(boundary);
    month += step;
    while (month > 12) {
      month -= 12;
      year += 1;
    }
  }
  return dates;
}

export interface Window {
  start: string;
  end: string;
}

/** Pending windows for one calc and entity collapse to a single span. */
export function mergeWindow(existing: Window | null, incoming: Window): Window {
  if (!existing) return incoming;
  return {
    start: existing.start < incoming.start ? existing.start : incoming.start,
    end: existing.end > incoming.end ? existing.end : incoming.end,
  };
}

export interface CalcNode {
  code: string;
  inputs: string[];
}

/** Materialized calcs ordered so each node follows the materialized inputs it reads. */
export function calcOrder(nodes: CalcNode[], materialized: Set<string>): string[] {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (code: string): number => {
    const known = depth.get(code);
    if (known !== undefined) return known;
    if (visiting.has(code)) throw new Error(`Calculated attribute cycle: ${code}`);
    visiting.add(code);
    const node = nodes.find((item) => item.code === code);
    const inputs = (node?.inputs || []).filter((input) => materialized.has(input));
    const value = inputs.length === 0 ? 0 : 1 + Math.max(...inputs.map(walk));
    visiting.delete(code);
    depth.set(code, value);
    return value;
  };

  for (const code of materialized) walk(code);
  return [...materialized].sort((a, b) => (depth.get(a) || 0) - (depth.get(b) || 0) || a.localeCompare(b));
}
