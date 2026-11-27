/**
 * What every tab tells the assistant, open or not (docs/SURFACE_TABS.md). Each tab's data is
 * built from the same book, groupings and series the tab draws, with the user's dates applied.
 */
import type { SurfaceTabPayload } from '@tapestrai/surface-sdk';
import type { Book, Drift, Opportunities, Vehicle } from './data';
import { byIndustry, byMaturityYear, byObligor, byRating, headline, juniorOc, termSections, testGroups } from './view';
import { driftSeries, improvement } from '../components/DriftTab';
import { opportunityColumns } from '../components/OpportunitiesTab';
import { VEHICLES_TAB } from '../components/VehiclesTab';
import { INDENTURE_TAB } from '../components/IndentureTab';
import { COLLATERAL_TAB } from '../components/CollateralTab';
import { KPI_TAB } from '../components/KpiTab';
import { DRIFT_TAB } from '../components/DriftTab';
import { LIABILITIES_TAB } from '../components/LiabilitiesTab';
import { OPPORTUNITIES_TAB } from '../components/OpportunitiesTab';

export const TABS = ['vehicles', 'indenture', 'collateral', 'kpis', 'drift', 'liabilities', 'opportunities'] as const;
export type TabKey = (typeof TABS)[number];

export const TAB_INFO: Record<TabKey, { label: string; purpose: string }> = {
  vehicles: VEHICLES_TAB, indenture: INDENTURE_TAB, collateral: COLLATERAL_TAB, kpis: KPI_TAB,
  drift: DRIFT_TAB, liabilities: LIABILITIES_TAB, opportunities: OPPORTUNITIES_TAB,
};

const UNITS = 'WARF is a Moody’s rating factor (lower is better). WAS is basis points over the benchmark (higher is better). WAL is years (lower is better). WARR is percent (higher is better). Coverage tests (OC, IC) and concentrations are percent. A test for a class covers every class ranked with or above it.';
const STATUS = 'Status is the compliance engine’s: PASS, HARD_BREACH (past its limit), SOFT_BREACH (warning), NO_DATA (a value it needs is missing). Cushion is value less limit for a minimum, limit less value for a maximum; negative is a breach.';

const r1 = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const kpiRow = (k: { label: string; value: number | null; limit: number | null; cushion: number | null; status: string }) => ({ measure: k.label, value: r1(k.value), limit: r1(k.limit), cushion: r1(k.cushion), status: k.status });

function vehicleRow(v: Vehicle) {
  const junior = juniorOc(v);
  return {
    clo: v.name, phase: v.phase, manager: v.manager, collateralPar: Math.round(v.collateral.par), notesPar: Math.round(v.collateral.notesPar),
    warf: r1(headline(v, 'WARF')?.value, 0), was: r1(headline(v, 'WAS')?.value, 0), wal: r1(headline(v, 'WAL')?.value), warr: r1(headline(v, 'WARR')?.value),
    diversity: r1(v.diversity.score, 1), cccPct: r1(headline(v, 'CCC')?.value),
    juniorOc: junior ? { test: junior.label, value: r1(junior.value), trigger: r1(junior.limit), cushion: r1(junior.cushion) } : null,
    breaches: v.summary.breaches, tightest: v.summary.tightest, reinvestmentEnd: v.reinvestmentEnd, nextPayment: v.nextPayment,
  };
}

export function buildTabs(input: {
  book: Book | null; vehicle: Vehicle | null;
  drift: Drift | null; opportunities: Opportunities | null; opportunitiesOpened: boolean;
}): Record<TabKey, SurfaceTabPayload> {
  const { book, vehicle: v, drift, opportunities, opportunitiesOpened } = input;
  const ready = Boolean(book && v);
  const base = (key: TabKey, data: Record<string, unknown> | null, howToRead?: string): SurfaceTabPayload => ({ ...TAB_INFO[key], howToRead, data });
  const openClo = v ? { clo: v.name, asOf: book!.asOfDate } : {};

  return {
    vehicles: base('vehicles', !book ? null : {
      asOf: book.asOfDate,
      totals: book.totals,
      vehicles: book.vehicles.map(vehicleRow),
      inBreach: book.vehicles.filter((x) => x.summary.breaches).map((x) => ({ clo: x.name, breaches: x.tests.filter((t) => t.status === 'HARD_BREACH').slice(0, 10).map((t) => `${t.ruleName}${t.group ? ` (${t.group})` : ''}`) })),
    }, `One row per CLO. ${UNITS} Junior OC is the most junior class’s overcollateralization test, the first to divert cash when it fails. The figures are as of the As Of date.`),

    indenture: base('indenture', !ready ? null : {
      ...openClo,
      terms: termSections(v!).map((s) => ({ section: s.section, terms: s.terms.filter((t) => t.value != null && t.value !== '').map((t) => ({ term: t.name, value: t.dataType === 'JSON' ? 'set' : t.value })) })),
      testCounts: v!.summary,
      tests: testGroups(v!).map((g) => ({ category: g.label, tests: g.tests.slice(0, 30).map((t) => ({ test: t.ruleName, group: t.group, value: r1(t.value), limit: r1(t.limit), cushion: r1(t.cushion), direction: t.direction, status: t.status })) })),
    }, `${STATUS} A grouped test (industry, single obligor) lists its failing groups and its tightest passing one. Limits come from the CLO’s own indenture terms or note triggers.`),

    collateral: base('collateral', !ready ? null : {
      ...openClo,
      totals: { ...v!.collateral, diversity: r1(v!.diversity.score, 1) },
      byIndustry: byIndustry(v!).slice(0, 30).map((b) => ({ industry: b.label, holdings: b.count, par: Math.round(b.par), pct: r1(b.pct, 1) })),
      byMoodysRating: byRating(v!).map((b) => ({ rating: b.label, par: Math.round(b.par), pct: r1(b.pct, 1) })),
      byMaturityYear: byMaturityYear(v!).map((b) => ({ year: b.label, par: Math.round(b.par), pct: r1(b.pct, 1) })),
      largestObligors: byObligor(v!).slice(0, 15).map((b) => ({ obligor: b.label, par: Math.round(b.par), pctOfPerforming: r1(b.pct) })),
      holdings: v!.holdings.slice(0, 60).map((h) => ({ loan: h.name, obligor: h.issuer, industry: h.industry, par: Math.round(h.par), price: h.price, moodys: h.ratingMoodys, sp: h.ratingSp, spreadBps: h.spreadBps, maturity: h.maturity, ccc: h.ccc, defaulted: h.defaulted, covLite: h.covLite })),
      holdingsListed: Math.min(60, v!.holdings.length), holdingsTotal: v!.holdings.length,
    }, 'Par is funded par in dollars. Shares are of collateral par, except obligors, which are of performing par. The holdings list is the largest 60 by par.'),

    kpis: base('kpis', !ready ? null : {
      ...openClo,
      measures: v!.kpis.map(kpiRow),
      acrossClos: book!.vehicles.map((x) => ({ clo: x.name, measures: x.kpis.map(kpiRow) })),
    }, `${UNITS} ${STATUS} Diversity is the Moody’s diversity score worked out by the platform against the indenture minimum; every other measure is the compliance engine’s.`),

    drift: base('drift', !ready || !drift ? null : {
      ...openClo,
      dates: drift.dates,
      series: driftSeries(drift).map((s) => ({ measure: s.label, changeBetterIsPositive: r1(improvement(s)), points: s.values.map((x, i) => ({ date: drift.points[i]?.date, value: r1(x?.value ?? null), limit: r1(x?.limit ?? null), status: x?.status ?? null })) })),
      collateral: drift.points.map((p) => ({ date: p.date, collateralPar: Math.round(p.collateralPar), defaultedPar: Math.round(p.defaultedPar), ratedNotesPar: Math.round(p.ratedNotesPar), cccPct: r1(p.cccPct), residualToEquity: Math.round(p.residualToEquity) })),
    }, `Each point is the CLO scored by the compliance engine as of that date (quarter ends, then the As Of date), as known at the Knowledge date. changeBetterIsPositive is the last value less the first, turned around for a maximum. ${UNITS}`),

    liabilities: base('liabilities', !ready ? null : {
      ...openClo,
      notes: v!.notes.map((n) => ({ class: n.cls, name: n.name, rank: n.rank, par: Math.round(n.par), originalPar: n.originalPar, sharePct: r1(n.sharePct, 1), attachmentPct: r1(n.attachmentPct, 1), spreadBps: n.spreadBps, couponPct: r1(n.couponPct), interestDue: Math.round(n.interestDue), deferredInterest: n.deferredInterest, sp: n.ratingSp, moodys: n.ratingMoodys, ocTrigger: n.ocTrigger, oc: r1(n.oc?.value), ocStatus: n.oc?.status ?? null, icTrigger: n.icTrigger, ic: r1(n.ic?.value), icStatus: n.ic?.status ?? null })),
      accounts: v!.accounts.map((a) => ({ account: a.name, type: a.type, balance: Math.round(a.balance) })),
      waterfall: {
        nextPayment: v!.nextPayment, interestCollections: Math.round(v!.waterfall.interestProceeds), paidToNotes: Math.round(v!.waterfall.paidToNotes),
        divertedToCures: Math.round(v!.waterfall.diverted), deferred: Math.round(v!.waterfall.deferred), shortfall: Math.round(v!.waterfall.shortfall),
        residualToEquity: Math.round(v!.waterfall.residualToEquity), equityCashYieldPct: r1(v!.waterfall.equityCashYieldPct), paydowns: v!.waterfall.paydowns,
        steps: v!.waterfall.steps.map((s) => ({ step: s.order, waterfall: s.waterfall, label: s.label, due: Math.round(s.due), paid: Math.round(s.paid), notPaid: Math.round(s.deferred + s.shortfall) })),
      },
    }, 'Amounts are dollars for one payment period. Attachment is the share of note par ranking below the class. The waterfall is the platform’s simplified CLO 2.0 priority of payments: it does not model the reinvestment OC test, the incentive fee, expense caps or reserve accounts. Coverage results are the compliance engine’s.'),

    opportunities: base('opportunities', !ready ? null : !opportunities ? (opportunitiesOpened ? null : { ...openClo, note: 'Offered loans are scored when this tab is opened; the figures are read then.' }) : {
      ...openClo,
      offered: opportunities.candidates, scored: opportunities.scored, ticketRule: opportunities.ticketRule, baseline: opportunities.baseline,
      ranked: opportunities.opportunities.slice(0, 30).map((o, i) => ({
        rank: i + 1, loan: o.name, obligor: o.issuer, industry: o.industry, newIndustry: o.newIndustry, moodys: o.ratingMoodys, spreadBps: o.spreadBps, offerPrice: o.offerPrice, ticket: o.ticket,
        approved: o.score?.approved ?? null, cures: o.score?.cures ?? null, newBreaches: o.score?.newBreaches ?? null, compositionScore: r1(o.score?.compositionScore, 1),
        changes: opportunityColumns(v!).map((c) => { const m = c.pick(o); return m ? { measure: c.label, before: r1(m.before), after: r1(m.after) } : null; }).filter(Boolean),
      })),
    }, 'Ranked: buys the compliance engine approves first (no test pushed into breach or made worse while failing), then the most failing tests cured, then the composition score: each measure’s gain as a share of its cushion, each held to ±100, added up. A ranking is a proposal; buying goes through the allocation and pre-trade flow.'),
  };
}
