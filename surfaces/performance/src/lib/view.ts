/**
 * Arranges one window of the book into the rows each tab draws. The tabs and the assistant's
 * payload both read these, so the screen and what the assistant is told cannot disagree.
 * Nothing here works out a return: every figure is a group the platform pooled.
 */
import type { Account, Book, Dimension, Fund, Group, Metrics, Position, Statement, WindowResult } from './data';

export interface Ctx {
  book: Book;
  window: WindowResult;
  group: (dimension: Dimension, key: string) => Group | undefined;
  fund: Map<string, Fund>;
  position: Map<string, Position>;
  account: Map<string, Account>;
  deal: Map<string, Book['deals'][number]>;
  investor: Map<string, Book['investors'][number]>;
}

export function contextFor(book: Book, window: WindowResult): Ctx {
  const groups = new Map(window.groups.map((g) => [`${g.dimension}|${g.key}`, g]));
  return {
    book,
    window,
    group: (dimension, key) => groups.get(`${dimension}|${key}`),
    fund: new Map(book.funds.map((f) => [f.id, f])),
    position: new Map(book.positions.map((p) => [p.id, p])),
    account: new Map(book.accounts.map((a) => [a.id, a])),
    deal: new Map(book.deals.map((d) => [d.id, d])),
    investor: new Map(book.investors.map((i) => [i.id, i])),
  };
}

const size = (g: Group) => (g.gross?.paidIn ?? 0) + (g.net?.paidIn ?? 0);
const bySize = (a: Group, b: Group) => size(b) - size(a) || a.label.localeCompare(b.label);
const of = (ctx: Ctx, dimension: Dimension) => ctx.window.groups.filter((g) => g.dimension === dimension);
const childrenOf = (ctx: Ctx, dimension: Dimension, parent: Group) => of(ctx, dimension).filter((g) => g.parentKey === `${parent.dimension}|${parent.key}`).sort(bySize);

export interface FamilyRow { family: Group; fund: Fund | undefined; vehicles: Group[] }
/** Fund families, largest first, each with its vehicles. A fund with no parent is a family of one. */
export function familyRows(ctx: Ctx): FamilyRow[] {
  return of(ctx, 'FAMILY').sort(bySize).map((family) => ({ family, fund: ctx.fund.get(family.key), vehicles: childrenOf(ctx, 'FUND', family) }));
}

export interface DealRow { deal: Group; sector: string | null; funds: Group[] }
export function dealRows(ctx: Ctx): DealRow[] {
  return of(ctx, 'DEAL').sort(bySize).map((deal) => ({ deal, sector: ctx.deal.get(deal.key)?.sector ?? null, funds: childrenOf(ctx, 'DEAL_FUND', deal) }));
}

export interface InvestorRow { investor: Group; type: string | null; funds: Array<{ group: Group; latest: Statement | null; accountId: string }>; commitment: number | null }
/** The statement on or before the window's end that carries the account's balances. */
export function latestStatement(account: Account | undefined, end: string): Statement | null {
  if (!account) return null;
  const list = account.statements.filter((s) => s.periodEnd <= end);
  return list[list.length - 1] ?? null;
}
export function investorRows(ctx: Ctx): InvestorRow[] {
  return of(ctx, 'INVESTOR').sort(bySize).map((investor) => {
    const funds = childrenOf(ctx, 'INVESTOR_FUND', investor).map((group) => {
      const accountId = group.accountIds[0];
      return { group, accountId, latest: latestStatement(ctx.account.get(accountId), ctx.window.endDate) };
    });
    const commitments = funds.map((f) => f.latest?.commitment).filter((v): v is number => v != null);
    return { investor, type: ctx.investor.get(investor.key)?.type ?? null, funds, commitment: commitments.length ? commitments.reduce((a, b) => a + b, 0) : null };
  });
}

export function positionRows(ctx: Ctx): Array<{ group: Group; position: Position }> {
  return of(ctx, 'POSITION').sort(bySize).map((group) => ({ group, position: ctx.position.get(group.key)! })).filter((row) => row.position);
}

export function sectorRows(ctx: Ctx): Group[] {
  return of(ctx, 'SECTOR').sort(bySize);
}

/** Gross IRR less net IRR, when both are measured. */
export function spread(group: Group): number | null {
  return group.gross?.irr != null && group.net?.irr != null ? group.gross.irr - group.net.irr : null;
}

/** The figures a row shows, for the assistant: rates and multiples rounded, amounts in dollars. */
export function metricsData(m: Metrics | null) {
  if (!m || !m.legs) return null;
  const r = (v: number | null, places: number) => (v == null ? null : Number(v.toFixed(places)));
  return { irr: r(m.irr, 4), multiple: r(m.moic, 3), dpi: r(m.dpi, 3), rvpi: r(m.rvpi, 3), paidIn: Math.round(m.paidIn), distributed: Math.round(m.distributed), value: Math.round(m.closing), gain: Math.round(m.gain), records: m.legs };
}
