/**
 * What every tab tells the assistant, open or not (docs/SURFACE_TABS.md). Built from the
 * same rows the tabs draw (view.ts), with totals first and long lists capped. No ids.
 */
import type { SurfaceTabPayload } from '@tapestrai/surface-sdk';
import type { Book } from './data';
import { contextFor, dealRows, familyRows, investorRows, metricsData, positionRows, sectorRows, spread, type Ctx } from './view';
import { ADHOC_TAB, adhocRows, GROUP_BY, STANDARD_PERIODS, type AdhocSpec } from '../components/AdhocTab';
import { FUNDS_TAB } from '../components/FundsTab';
import { POSITIONS_TAB } from '../components/PositionsTab';
import { DEALS_TAB } from '../components/DealsTab';
import { INVESTORS_TAB } from '../components/InvestorsTab';

export type TabKey = 'funds' | 'positions' | 'deals' | 'investors' | 'adhoc';
export const TABS: TabKey[] = ['funds', 'positions', 'deals', 'investors', 'adhoc'];
export const TAB_INFO: Record<TabKey, { label: string; purpose: string }> = {
  funds: FUNDS_TAB, positions: POSITIONS_TAB, deals: DEALS_TAB, investors: INVESTORS_TAB, adhoc: ADHOC_TAB,
};

const TERMS = 'Rates are annualised XIRR in decimals (0.12 is 12%); multiples are times money put in. Gross is asset level, pooled from position cash flows (investor amounts, money out negative) and market values. Net is investor level, pooled from quarterly capital account statements, so it is after fees, expenses and carry. Paid in is the opening value plus money out; MOIC and TVPI are distributions plus value over paid in; DPI is distributions over paid in; RVPI is value over paid in. A period opens with each position’s market value (or each account’s closing balance) on its start day, counted as money put in. Each row pools its own records; nothing is averaged. Positions with a value but nothing put in during the period are left out and counted as excluded.';

const cap = <T,>(list: T[], n: number) => ({ shown: list.slice(0, n), more: Math.max(0, list.length - n) });

function period(ctx: Ctx) {
  return { label: ctx.window.label, from: ctx.window.startDate ?? 'inception', to: ctx.window.endDate };
}

function totals(book: Book) {
  return book.windows.map((w) => ({ period: w.label, from: w.startDate ?? 'inception', to: w.endDate, gross: metricsData(w.total.gross), net: metricsData(w.total.net) }));
}

function fundsData(ctx: Ctx) {
  const rows = familyRows(ctx);
  const list = cap(rows, 40);
  return {
    period: period(ctx),
    firmTotal: { gross: metricsData(ctx.window.total.gross), net: metricsData(ctx.window.total.net) },
    families: list.shown.map(({ family, fund, vehicles }) => ({
      family: family.label,
      vintage: fund?.vintage ?? null,
      strategy: fund?.strategy ?? null,
      reportedNetIrrPct: fund?.reportedNetIrr ?? null,
      gross: metricsData(family.gross),
      net: metricsData(family.net),
      grossToNetIrr: spread(family),
      vehicles: vehicles.length === 1 && vehicles[0].key === family.key ? [] : vehicles.map((v) => ({ vehicle: v.label, gross: metricsData(v.gross), net: metricsData(v.net), grossToNetIrr: spread(v) })),
    })),
    moreFamilies: list.more,
    positionsLeftOutOfFirmTotal: ctx.window.total.gross?.excluded ?? 0,
    positionsNotMeasured: ctx.book.unmeasuredPositions,
  };
}

function positionsData(ctx: Ctx) {
  const rows = positionRows(ctx);
  const list = cap(rows, 80);
  return {
    period: period(ctx),
    measured: rows.length,
    notMeasured: ctx.book.unmeasuredPositions,
    bySector: sectorRows(ctx).map((g) => ({ sector: g.label, gross: metricsData(g.gross) })),
    positions: list.shown.map(({ group, position: p }) => ({
      position: p.name,
      fund: ctx.fund.get(p.fundId)?.name ?? null,
      deal: p.dealId ? ctx.deal.get(p.dealId)?.name ?? null : null,
      issuer: p.issuerName,
      sector: p.sector,
      gross: metricsData(group.gross),
      leftOut: group.gross?.excluded ? 'a value but nothing put in during the period' : undefined,
    })),
    morePositions: list.more,
  };
}

function dealsData(ctx: Ctx) {
  const rows = dealRows(ctx);
  const list = cap(rows, 40);
  return {
    period: period(ctx),
    deals: list.shown.map(({ deal, sector, funds }) => ({
      deal: deal.label,
      sector,
      acrossFunds: metricsData(deal.gross),
      byFund: funds.map((f) => ({ fund: f.label, positions: f.positionIds.length, gross: metricsData(f.gross) })),
    })),
    moreDeals: list.more,
  };
}

function investorsData(ctx: Ctx) {
  const rows = investorRows(ctx);
  const list = cap(rows, 40);
  return {
    period: period(ctx),
    netExcludedByFilter: ctx.window.netExcluded,
    investors: list.shown.map(({ investor, type, funds, commitment }) => ({
      investor: investor.label,
      type,
      commitment,
      net: metricsData(investor.net),
      byFund: funds.map(({ group, latest }) => ({
        fund: group.label,
        net: metricsData(group.net),
        lastStatement: latest ? { periodEnd: latest.periodEnd, commitment: latest.commitment, contributedToDate: latest.contributedItd, distributedToDate: latest.distributedItd, nav: latest.closing, unfunded: latest.unfunded } : null,
      })),
    })),
    moreInvestors: list.more,
  };
}

function adhocData(book: Book, spec: AdhocSpec, base: Book) {
  const names = (values: string[], from: Array<{ id: string; name: string }>) => values.map((v) => from.find((x) => x.id === v)?.name || v);
  const pick = (mode: string, list: string[]) => (mode === 'all' ? 'all' : `${mode === 'only' ? 'only' : 'all except'}: ${list.join(', ') || 'none chosen'}`);
  const view = adhocRows(book, spec.groupBy);
  const list = cap(view.rows, 60);
  return {
    selection: {
      funds: pick(spec.funds.mode, names(spec.funds.values, base.funds)),
      deals: pick(spec.deals.mode, names(spec.deals.values, base.deals)),
      sectors: pick(spec.sectors.mode, spec.sectors.values),
      groupedBy: GROUP_BY.find((g) => g.key === spec.groupBy)?.label,
      periods: [...STANDARD_PERIODS.filter((p) => spec.periods.includes(p.key)).map((p) => p.label), ...spec.custom.map((c) => c.label)],
    },
    netLeftOut: book.windows[0]?.netExcluded ?? false,
    totalByPeriod: view.total.cells.map(({ ctx, group }) => ({ period: ctx.window.label, from: ctx.window.startDate ?? 'inception', to: ctx.window.endDate, gross: metricsData(group?.gross ?? null), net: metricsData(group?.net ?? null) })),
    rows: list.shown.map((row) => ({ name: row.label, byPeriod: row.cells.map(({ ctx, group }) => ({ period: ctx.window.label, gross: metricsData(group?.gross ?? null), net: metricsData(group?.net ?? null) })) })),
    moreRows: list.more,
  };
}

export function buildTabs(input: { book: Book | null; windowKey: string; adhoc: { book: Book | null; spec: AdhocSpec; stale: boolean } }): Record<TabKey, SurfaceTabPayload> {
  const { book } = input;
  const w = book?.windows.find((x) => x.key === input.windowKey) ?? book?.windows[0];
  const ctx = book && w ? contextFor(book, w) : null;
  const common = book ? { firmTotalsByPeriod: totals(book) } : {};
  return {
    funds: { ...TAB_INFO.funds, howToRead: `${TERMS} A family is a fund and its parallel vehicles (feeders, sleeves, SMAs); its row pools every vehicle. Gross to net is gross IRR less net IRR. Reported net IRR is the fund's own FUND_NET_IRR attribute, in percent.`, data: ctx ? { ...common, ...fundsData(ctx) } : null },
    positions: { ...TAB_INFO.positions, howToRead: `${TERMS} A position is measured when it has a cash flow or sits on a deal tranche. Sector is the issuer's SECTOR, or the deal's DEAL_SECTOR when the issuer has none.`, data: ctx ? positionsData(ctx) : null },
    deals: { ...TAB_INFO.deals, howToRead: `${TERMS} A deal's row pools every measured position on its tranches, in every fund; each fund row pools that fund's positions only. Deals are gross only.`, data: ctx ? dealsData(ctx) : null },
    investors: { ...TAB_INFO.investors, howToRead: `${TERMS} Each quarterly statement's contributions and distributions are dated at its period end. Commitment, NAV and unfunded are from the last statement on or before the period end.`, data: ctx ? investorsData(ctx) : null },
    adhoc: {
      ...TAB_INFO.adhoc,
      howToRead: `${TERMS} Include and exclude filters apply to positions. Capital accounts are held by fund, not by deal or sector, so a deal or sector filter leaves net figures out.${input.adhoc.stale ? ' The person has changed the selection but not measured it yet; the figures are for the selection described.' : ''}`,
      data: book && input.adhoc.book ? adhocData(input.adhoc.book, input.adhoc.spec, book) : null,
    },
  };
}
