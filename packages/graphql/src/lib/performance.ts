/**
 * Firm-wide performance: returns pooled across any set of positions or capital
 * accounts, over any window. The Performance surface and the assistant read it
 * through the `performanceBook` query; nothing else works these figures out.
 *
 * Gross (asset level) follows golden_master.performance_formula exactly, so a
 * pool of one deal's positions equals DEAL_IRR_ITD / DEAL_MOIC_ITD:
 *   - With a start date, each position opens with its MARKET_VALUE on that day,
 *     counted as money put in on that day. Inception to date has no opening.
 *   - Cash flows (CASHFLOW_INVESTOR_AMOUNT, signed from the investor's side:
 *     money out negative) dated after the start, through the end, are kept.
 *   - Each position closes with its MARKET_VALUE on the end date, counted as
 *     money back.
 *   - MOIC is money back over money put in. IRR is the XIRR of the pooled flows.
 *
 * Net (LP level) pools capital accounts: each quarterly statement's
 * contributions (money in) and distributions (money back) are dated at its
 * period end, and the latest statement's closing balance is the value. A
 * window opens with the closing balance of the last statement on or before
 * the start.
 *
 * Amounts are dollars. Rates and multiples are decimals (0.12 is 12 percent).
 */
import { xirr } from './calc-engine';

export interface Flow {
  date: string;
  amount: number;
}

/** One position or capital account inside a window. */
export interface Leg {
  /** Value counted as money put in on its date (a window's opening value). */
  open?: { date: string; value: number } | null;
  /** Value counted as money back on its date (the closing value). */
  close?: { date: string; value: number } | null;
  /** Signed flows already inside the window. */
  flows: Flow[];
}

export interface Metrics {
  irr: number | null;
  /** Money back over money put in. For capital accounts this is TVPI. */
  moic: number | null;
  /** Distributions over money put in. */
  dpi: number | null;
  /** Closing value over money put in. */
  rvpi: number | null;
  /** Opening value plus money out. */
  paidIn: number;
  /** Money back before the closing value. */
  distributed: number;
  opening: number;
  closing: number;
  /** Distributions plus closing value less money put in. */
  gain: number;
  legs: number;
  /**
   * Legs left out because nothing was put in during the window: a value with no opening value
   * and no money out (cash flows with no investor amount, say). Counting such a value as money
   * back would show it all as profit.
   */
  excluded: number;
}

export interface Window {
  key: string;
  label: string;
  /** Null for inception to date. */
  start: string | null;
  end: string;
}

export const EMPTY_METRICS: Metrics = { irr: null, moic: null, dpi: null, rvpi: null, paidIn: 0, distributed: 0, opening: 0, closing: 0, gain: 0, legs: 0, excluded: 0 };

const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : null);

/** Whether anything was put into the leg during the window: an opening value or money out. */
export function hasCost(leg: Leg): boolean {
  return Boolean(leg.open && leg.open.value > 0) || leg.flows.some((flow) => flow.amount < 0);
}

/**
 * Pool legs into one return. A leg that adds nothing (no opening, flows or closing) is not
 * counted. A leg with a value but nothing put in is left out and counted in `excluded`.
 */
export function pool(legs: Leg[]): Metrics {
  const dates: string[] = [];
  const amounts: number[] = [];
  let paidIn = 0;
  let distributed = 0;
  let opening = 0;
  let closing = 0;
  let counted = 0;
  let excluded = 0;
  for (const leg of legs) {
    if (!hasCost(leg)) {
      if (leg.flows.length || (leg.close && leg.close.value)) excluded += 1;
      continue;
    }
    let used = false;
    if (leg.open && leg.open.value) {
      dates.push(leg.open.date);
      amounts.push(-leg.open.value);
      paidIn += leg.open.value;
      opening += leg.open.value;
      used = true;
    }
    for (const flow of leg.flows) {
      if (!flow.amount) continue;
      dates.push(flow.date);
      amounts.push(flow.amount);
      if (flow.amount < 0) paidIn -= flow.amount;
      else distributed += flow.amount;
      used = true;
    }
    if (leg.close && leg.close.value) {
      dates.push(leg.close.date);
      amounts.push(leg.close.value);
      closing += leg.close.value;
      used = true;
    }
    if (used) counted += 1;
  }
  if (!counted) return { ...EMPTY_METRICS, excluded };
  const order = dates.map((date, index) => index).sort((a, b) => (dates[a] < dates[b] ? -1 : dates[a] > dates[b] ? 1 : a - b));
  return {
    irr: xirr(order.map((i) => dates[i]), order.map((i) => amounts[i])),
    moic: ratio(distributed + closing, paidIn),
    dpi: ratio(distributed, paidIn),
    rvpi: ratio(closing, paidIn),
    paidIn,
    distributed,
    opening,
    closing,
    gain: distributed + closing - paidIn,
    legs: counted,
    excluded,
  };
}

/** Flows inside a window: after the start (the start day carries the opening value), through the end. */
export function inWindow(flows: Flow[], window: Pick<Window, 'start' | 'end'>): Flow[] {
  return flows.filter((flow) => flow.date <= window.end && (window.start == null || flow.date > window.start));
}

/** A position as a leg: opening and closing MARKET_VALUE, and its cash flows, as the formula reads them. */
export function positionLeg(flows: Flow[], window: Pick<Window, 'start' | 'end'>, open: number | null, close: number | null): Leg {
  return {
    open: window.start != null && open ? { date: window.start, value: open } : null,
    close: close ? { date: window.end, value: close } : null,
    flows: inWindow(flows, window),
  };
}

/** One quarterly capital account statement for one investor in one fund. */
export interface Statement {
  /** The capital account record for this period. */
  recordId?: string;
  periodEnd: string;
  contributions: number;
  distributions: number;
  closing: number;
  commitment?: number | null;
  contributedItd?: number | null;
  distributedItd?: number | null;
  unfunded?: number | null;
}

/** An investor's statements in one fund as a leg for the window. */
export function accountLeg(statements: Statement[], window: Pick<Window, 'start' | 'end'>): Leg {
  const sorted = [...statements].filter((s) => s.periodEnd <= window.end).sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  const before = window.start == null ? null : [...sorted].reverse().find((s) => s.periodEnd <= window.start!) ?? null;
  const inside = sorted.filter((s) => window.start == null || s.periodEnd > window.start);
  // No statement inside the window: the account had no activity to measure in it.
  if (!inside.length) return { flows: [] };
  const last = inside[inside.length - 1];
  const flows: Flow[] = [];
  for (const s of inside) {
    if (s.contributions) flows.push({ date: s.periodEnd, amount: -Math.abs(s.contributions) });
    if (s.distributions) flows.push({ date: s.periodEnd, amount: Math.abs(s.distributions) });
  }
  return {
    open: before && before.closing ? { date: before.periodEnd, value: before.closing } : null,
    close: last.closing ? { date: last.periodEnd, value: last.closing } : null,
    flows,
  };
}

/** The last day of the prior period, as golden_master.performance_window_start reads it. */
export function windowStart(token: string, end: string): string | null {
  const [y, m, d] = end.slice(0, 10).split('-').map(Number);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  switch (token.toUpperCase()) {
    case 'YTD': return iso(new Date(Date.UTC(y, 0, 0)));
    case 'QTD': return iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 0)));
    case 'MTD': return iso(new Date(Date.UTC(y, m - 1, 0)));
    case 'LTM': return iso(new Date(Date.UTC(y - 1, m - 1, d)));
    default: return null;
  }
}

/** The standard windows ending on the end date. */
export function standardWindows(end: string): Window[] {
  return [
    { key: 'ITD', label: 'Inception to date', start: null, end },
    { key: 'LTM', label: 'Last 12 months', start: windowStart('LTM', end), end },
    { key: 'YTD', label: 'Year to date', start: windowStart('YTD', end), end },
    { key: 'QTD', label: 'Quarter to date', start: windowStart('QTD', end), end },
  ];
}

// ---------- the book ----------

export interface BookPosition {
  id: string;
  fundId: string;
  dealId: string | null;
  sector: string | null;
  flows: Flow[];
  /** MARKET_VALUE by date. */
  values: Record<string, number | null>;
}

export interface BookAccount {
  id: string;
  investorId: string;
  fundId: string;
  statements: Statement[];
}

export interface BookFilter {
  includeFundIds?: string[] | null;
  excludeFundIds?: string[] | null;
  includeDealIds?: string[] | null;
  excludeDealIds?: string[] | null;
  includeSectors?: string[] | null;
  excludeSectors?: string[] | null;
}

export type Dimension = 'TOTAL' | 'FAMILY' | 'FUND' | 'DEAL' | 'DEAL_FUND' | 'SECTOR' | 'POSITION' | 'INVESTOR' | 'INVESTOR_FUND';

export interface Group {
  dimension: Dimension;
  key: string;
  /** The record the row is about, when it is one. */
  entityId: string | null;
  parentKey: string | null;
  gross: Metrics | null;
  net: Metrics | null;
  positionIds: string[];
  accountIds: string[];
}

export const NO_SECTOR = 'Unclassified';

const listed = (values?: string[] | null) => (values && values.length ? new Set(values) : null);

/** Whether a deal or sector filter is set. Capital accounts are not held by deal or sector, so net figures are left out then. */
export function filtersPositionsOnly(filter: BookFilter | null | undefined): boolean {
  return Boolean(filter?.includeDealIds?.length || filter?.excludeDealIds?.length || filter?.includeSectors?.length || filter?.excludeSectors?.length);
}

export function keepPosition(p: BookPosition, filter: BookFilter | null | undefined): boolean {
  if (!filter) return true;
  const inF = listed(filter.includeFundIds);
  const outF = listed(filter.excludeFundIds);
  const inD = listed(filter.includeDealIds);
  const outD = listed(filter.excludeDealIds);
  const inS = listed(filter.includeSectors);
  const outS = listed(filter.excludeSectors);
  const sector = p.sector || NO_SECTOR;
  if (inF && !inF.has(p.fundId)) return false;
  if (outF?.has(p.fundId)) return false;
  if (inD && !(p.dealId && inD.has(p.dealId))) return false;
  if (outD && p.dealId && outD.has(p.dealId)) return false;
  if (inS && !inS.has(sector)) return false;
  if (outS?.has(sector)) return false;
  return true;
}

export function keepAccount(a: BookAccount, filter: BookFilter | null | undefined): boolean {
  if (filtersPositionsOnly(filter)) return false;
  const inF = listed(filter?.includeFundIds);
  const outF = listed(filter?.excludeFundIds);
  if (inF && !inF.has(a.fundId)) return false;
  if (outF?.has(a.fundId)) return false;
  return true;
}

function legOf(p: BookPosition, window: Window): Leg {
  return positionLeg(p.flows, window, window.start ? p.values[window.start] ?? null : null, p.values[window.end] ?? null);
}

/**
 * Every grouping of the book for one window: the total, fund families and their
 * vehicles, deals and each deal's funds, sectors, positions, investors and each
 * investor's funds. Each group pools its own legs; nothing is averaged.
 */
export function groupBook(input: {
  positions: BookPosition[];
  accounts: BookAccount[];
  /** Vehicle id to family id. A fund with no parent is its own family. */
  familyOf: (fundId: string) => string;
  window: Window;
  filter?: BookFilter | null;
}): { total: Group; groups: Group[] } {
  const { window, familyOf } = input;
  const positions = input.positions.filter((p) => keepPosition(p, input.filter));
  const accounts = input.accounts.filter((a) => keepAccount(a, input.filter));
  const legs = new Map(positions.map((p) => [p.id, legOf(p, window)]));
  const accountLegs = new Map(accounts.map((a) => [a.id, accountLeg(a.statements, window)]));

  const buckets = new Map<string, { dimension: Dimension; key: string; entityId: string | null; parentKey: string | null; positionIds: string[]; accountIds: string[] }>();
  const add = (dimension: Dimension, key: string, entityId: string | null, parentKey: string | null, position?: string, account?: string) => {
    const id = `${dimension}|${key}`;
    let bucket = buckets.get(id);
    if (!bucket) { bucket = { dimension, key, entityId, parentKey, positionIds: [], accountIds: [] }; buckets.set(id, bucket); }
    if (position) bucket.positionIds.push(position);
    if (account) bucket.accountIds.push(account);
  };

  for (const p of positions) {
    const family = familyOf(p.fundId);
    add('FAMILY', family, family, null, p.id);
    add('FUND', p.fundId, p.fundId, `FAMILY|${family}`, p.id);
    if (p.dealId) {
      add('DEAL', p.dealId, p.dealId, null, p.id);
      add('DEAL_FUND', `${p.dealId}|${p.fundId}`, p.fundId, `DEAL|${p.dealId}`, p.id);
    }
    add('SECTOR', p.sector || NO_SECTOR, null, null, p.id);
    add('POSITION', p.id, p.id, `FUND|${p.fundId}`, p.id);
  }
  for (const a of accounts) {
    const family = familyOf(a.fundId);
    add('FAMILY', family, family, null, undefined, a.id);
    add('FUND', a.fundId, a.fundId, `FAMILY|${family}`, undefined, a.id);
    add('INVESTOR', a.investorId, a.investorId, null, undefined, a.id);
    add('INVESTOR_FUND', `${a.investorId}|${a.fundId}`, a.fundId, `INVESTOR|${a.investorId}`, undefined, a.id);
  }

  const grossOf = (ids: string[]) => (ids.length ? pool(ids.map((id) => legs.get(id)!)) : null);
  const netOf = (ids: string[]) => (ids.length ? pool(ids.map((id) => accountLegs.get(id)!)) : null);
  const groups: Group[] = [...buckets.values()].map((b) => ({ ...b, gross: grossOf(b.positionIds), net: netOf(b.accountIds) }));
  const total: Group = {
    dimension: 'TOTAL',
    key: 'TOTAL',
    entityId: null,
    parentKey: null,
    gross: grossOf(positions.map((p) => p.id)),
    net: netOf(accounts.map((a) => a.id)),
    positionIds: positions.map((p) => p.id),
    accountIds: accounts.map((a) => a.id),
  };
  return { total, groups };
}
