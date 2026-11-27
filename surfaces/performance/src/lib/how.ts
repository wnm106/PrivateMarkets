/**
 * How each figure is worked out, in words, with the records behind it. Shown when a person
 * right-clicks a figure with no attribute of its own. The numbers come from the groups the
 * platform pooled; nothing is recomputed here.
 */
import type { Derivation, BindTarget } from '../components/common';
import type { Group, Metrics, Statement } from './data';
import { ATTR } from './data';
import { fmtBps, fmtDay, fmtRate, fmtUsd, fmtX } from './format';
import type { Ctx } from './view';
import { latestStatement } from './view';

export type MetricKey = 'irr' | 'moic' | 'dpi' | 'rvpi' | 'paidIn' | 'distributed' | 'closing' | 'gain' | 'legs';
export type Basis = 'gross' | 'net';

const LISTED = 12;

export const METRIC_NAME: Record<Basis, Record<MetricKey, string>> = {
  gross: { irr: 'Gross IRR', moic: 'Gross MOIC', dpi: 'Gross DPI', rvpi: 'Gross RVPI', paidIn: 'Paid in', distributed: 'Distributed', closing: 'Value', gain: 'Gain', legs: 'Positions measured' },
  net: { irr: 'Net IRR', moic: 'TVPI', dpi: 'DPI', rvpi: 'RVPI', paidIn: 'Contributed', distributed: 'Distributed', closing: 'NAV', gain: 'Gain', legs: 'Capital accounts' },
};

export function fmtMetric(key: MetricKey, m: Metrics | null): string {
  if (!m || !m.legs) return '—';
  switch (key) {
    case 'irr': return fmtRate(m.irr);
    case 'moic': case 'dpi': case 'rvpi': return fmtX(m[key]);
    case 'legs': return String(m.legs);
    default: return fmtUsd(m[key]);
  }
}

function windowWords(ctx: Ctx): string {
  const w = ctx.window;
  return w.startDate ? `from ${fmtDay(w.startDate)} to ${fmtDay(w.endDate)}` : `from inception to ${fmtDay(w.endDate)}`;
}

function grossFormula(key: MetricKey, ctx: Ctx, legs: number): string {
  const w = ctx.window;
  const open = w.startDate ? ` Each position opens with its market value on ${fmtDay(w.startDate)}, counted as money put in that day.` : '';
  const base = `${legs} position${legs === 1 ? '' : 's'} pooled ${windowWords(ctx)}.${open} Cash flows are the investor amounts on each cash flow record (money out negative). Each position closes with its market value on ${fmtDay(w.endDate)}.`;
  switch (key) {
    case 'irr': return `XIRR of every pooled cash flow, the opening values and the closing values, by date. ${base}`;
    case 'moic': return `Money back (distributions plus closing value) over money put in (opening value plus money out). ${base}`;
    case 'dpi': return `Distributions over money put in. ${base}`;
    case 'rvpi': return `Closing value over money put in. ${base}`;
    case 'paidIn': return `Opening value plus every cash flow out. ${base}`;
    case 'distributed': return `Every cash flow back to the investor before the closing value. ${base}`;
    case 'closing': return `Market value of each position on ${fmtDay(w.endDate)}, added up.`;
    case 'gain': return `Distributions plus closing value, less money put in. ${base}`;
    default: return `Positions in this row with a cash flow or a deal tranche, ${windowWords(ctx)}.`;
  }
}

function netFormula(key: MetricKey, ctx: Ctx, legs: number): string {
  const w = ctx.window;
  const open = w.startDate ? ` Each account opens with its closing balance on the last statement on or before ${fmtDay(w.startDate)}.` : '';
  const base = `${legs} capital account${legs === 1 ? '' : 's'} pooled ${windowWords(ctx)}. Each quarterly statement's contributions and distributions are dated at its period end; the NAV is the closing balance on the last statement on or before ${fmtDay(w.endDate)}.${open}`;
  switch (key) {
    case 'irr': return `XIRR of the pooled contributions (money in), distributions and closing NAV (money back), by date. ${base}`;
    case 'moic': return `Total value to paid in: distributions plus NAV, over contributions. ${base}`;
    case 'dpi': return `Distributions over contributions. ${base}`;
    case 'rvpi': return `NAV over contributions. ${base}`;
    case 'paidIn': return `Contributions on the statements in the window, plus any opening balance. ${base}`;
    case 'distributed': return `Distributions on the statements in the window. ${base}`;
    case 'closing': return `Closing balance on each account's last statement, added up. ${base}`;
    case 'gain': return `Distributions plus NAV, less contributions. ${base}`;
    default: return `Capital accounts in this row, ${windowWords(ctx)}.`;
  }
}

const onPosition = (id: string, name: string, code: string, label: string): BindTarget => ({ entityId: id, entityName: name, domainCode: 'POSITION', code, name: label });
const onFlow = (id: string, name: string): BindTarget => ({ entityId: id, entityName: name, domainCode: 'CASH_FLOW', code: ATTR.flowAmount, name: 'Investor amount' });
export const onStatement = (s: Statement, code: string, label: string): BindTarget | undefined => (s.recordId ? { entityId: s.recordId, entityName: s.recordName, domainCode: 'CAPITAL_ACCOUNT', code, name: label } : undefined);

function markOn(ctx: Ctx, positionId: string, date: string | null): number | null {
  if (!date) return null;
  return ctx.position.get(positionId)?.marks.find((m) => m.date === date)?.value ?? null;
}

/** The records behind a gross figure. One position lists its own cash flows and marks; a pool lists its positions. */
function grossRows(ctx: Ctx, group: Group): Pick<Derivation, 'rows' | 'more'> {
  const w = ctx.window;
  if (group.positionIds.length === 1) {
    const p = ctx.position.get(group.positionIds[0]);
    if (!p) return {};
    const rows: NonNullable<Derivation['rows']> = [];
    const open = markOn(ctx, p.id, w.startDate);
    if (w.startDate && open) rows.push({ label: 'Opening market value', sub: fmtDay(w.startDate), value: fmtUsd(open), bind: onPosition(p.id, p.name, ATTR.marketValue, 'Market value') });
    const flows = p.flows.filter((f) => f.date <= w.endDate && (!w.startDate || f.date > w.startDate));
    for (const f of flows.slice(0, LISTED)) rows.push({ label: f.type || 'Cash flow', sub: fmtDay(f.date), value: fmtUsd(f.amount), bind: onFlow(f.id, `${p.name} · ${f.type || 'cash flow'}`) });
    const close = markOn(ctx, p.id, w.endDate);
    rows.push({ label: 'Closing market value', sub: fmtDay(w.endDate), value: close != null ? fmtUsd(close) : 'none recorded', bind: close != null ? onPosition(p.id, p.name, ATTR.marketValue, 'Market value') : undefined });
    return { rows, more: flows.length > LISTED ? flows.length - LISTED : undefined };
  }
  const legs = group.positionIds
    .map((id) => ({ id, p: ctx.position.get(id), m: ctx.group('POSITION', id)?.gross ?? null }))
    .filter((x) => x.p && x.m)
    .sort((a, b) => (b.m!.paidIn - a.m!.paidIn));
  // Each row is the position's own closing value, bound to its MARKET_VALUE; what went in and came back is beside it.
  return {
    rows: legs.slice(0, LISTED).map(({ p, m }) => {
      const fund = ctx.fund.get(p!.fundId)?.name;
      const close = markOn(ctx, p!.id, w.endDate);
      return {
        label: p!.name,
        sub: [fund, `${fmtUsd(m!.paidIn)} in · ${fmtUsd(m!.distributed)} distributed`].filter(Boolean).join(' · '),
        value: close != null ? fmtUsd(close) : 'no value',
        bind: close != null ? onPosition(p!.id, p!.name, ATTR.marketValue, 'Market value') : undefined,
      };
    }),
    more: legs.length > LISTED ? legs.length - LISTED : undefined,
  };
}

/** The records behind a net figure: one account's statements, or each account's latest balance. */
function netRows(ctx: Ctx, group: Group, key: MetricKey): Pick<Derivation, 'rows' | 'more'> {
  const w = ctx.window;
  if (group.accountIds.length === 1) {
    const a = ctx.account.get(group.accountIds[0]);
    if (!a) return {};
    const inside = a.statements.filter((s) => s.periodEnd <= w.endDate && (!w.startDate || s.periodEnd > w.startDate));
    const rows: NonNullable<Derivation['rows']> = [];
    for (const s of inside.slice(-LISTED)) {
      if (key === 'closing') continue;
      rows.push({ label: s.recordName, sub: 'Contributions', value: fmtUsd(s.contributions), bind: onStatement(s, ATTR.contributions, 'Contributions') });
      if (s.distributions) rows.push({ label: s.recordName, sub: 'Distributions', value: fmtUsd(s.distributions), bind: onStatement(s, ATTR.distributions, 'Distributions') });
    }
    const last = latestStatement(a, w.endDate);
    if (last) rows.push({ label: last.recordName, sub: 'Closing balance (NAV)', value: fmtUsd(last.closing), bind: onStatement(last, ATTR.closing, 'Closing balance') });
    return { rows, more: inside.length > LISTED ? inside.length - LISTED : undefined };
  }
  const accounts = group.accountIds
    .map((id) => ({ a: ctx.account.get(id), m: ctx.group('INVESTOR_FUND', id)?.net ?? null }))
    .filter((x) => x.a && x.m)
    .sort((x, y) => y.m!.paidIn - x.m!.paidIn);
  // Each row is the account's closing balance on its last statement, bound to CAPACCT_CLOSING.
  return {
    rows: accounts.slice(0, LISTED).map(({ a, m }) => {
      const last = latestStatement(a, w.endDate);
      const label = `${ctx.investor.get(a!.investorId)?.name || 'Investor'} · ${ctx.fund.get(a!.fundId)?.name || 'Fund'}`;
      return {
        label,
        sub: `${fmtUsd(m!.paidIn)} contributed · ${fmtUsd(m!.distributed)} distributed${last ? ` · NAV at ${fmtDay(last.periodEnd)}` : ''}`,
        value: last ? fmtUsd(last.closing) : 'no statement',
        bind: last ? onStatement(last, ATTR.closing, 'Closing balance') : undefined,
      };
    }),
    more: accounts.length > LISTED ? accounts.length - LISTED : undefined,
  };
}

export function metricHow(ctx: Ctx, group: Group, basis: Basis, key: MetricKey): Derivation {
  const m = basis === 'gross' ? group.gross : group.net;
  const legs = m?.legs ?? 0;
  return {
    title: `${group.label} · ${METRIC_NAME[basis][key]}`,
    value: fmtMetric(key, m),
    formula: basis === 'gross' ? grossFormula(key, ctx, legs) : netFormula(key, ctx, legs),
    ...(basis === 'gross' ? grossRows(ctx, group) : netRows(ctx, group, key)),
  };
}

export function spreadHow(ctx: Ctx, group: Group, value: number | null): Derivation {
  return {
    title: `${group.label} · Gross to net`,
    value: fmtBps(value),
    formula: `Gross IRR (positions) less net IRR (capital accounts), ${windowWords(ctx)}. It is the drag of fees, expenses, carry and cash held between the assets and the investors.`,
    rows: [
      { label: 'Gross IRR', value: fmtRate(group.gross?.irr) },
      { label: 'Net IRR', value: fmtRate(group.net?.irr) },
    ],
  };
}

export function countHow(title: string, formula: string, value: string, rows?: Derivation['rows']): Derivation {
  return { title, value, formula, rows };
}
