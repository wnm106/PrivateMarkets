import type { Context } from '../context';
import { loadFundSurface, type FundSurface } from '../lib/fund-surface';

function empty(fundId: string, message: string): FundSurface & { errors: Array<{ field: string; message: string; code: string }> } {
  const blank = {
    fundId,
    fundCode: '',
    fundName: 'Fund',
    strategyCode: '',
    strategyLabel: '',
    vintage: '',
    reportingDate: '',
    commitmentsClosed: '',
    investmentPeriodEnd: '',
    monthsRemaining: null,
    nav: 0,
    commitments: 0,
    called: 0,
    distributed: 0,
    unfunded: 0,
    netPaidIn: 0,
    grossIrr: null,
    feeDrag: null,
    expenseDrag: null,
    carryDrag: null,
    netIrr: null,
    tvpi: null,
    dpi: null,
    rvpi: null,
    cash: 0,
    unfundedBorrower: 0,
    liquidityMin: 0,
    targetCalledPct: 0,
    facilityAvailability: 0,
    availableLiquidity: 0,
    liquidityCoverage: null,
    investmentsFairValue: 0,
    activePositions: 0,
    sectorCount: 0,
    floatingRatePct: null,
    weightedLeverage: null,
    weightedMark: null,
    marksBelow: 0,
    reviewOpen: 0,
    reviewFlagged: 0,
    certified: false,
    tolerancePct: 0.5,
    statementId: null,
    periodLabel: '',
    facility: null,
    navChart: { labels: [], values: [] },
    pacingChart: { labels: [], plan: [], actual: [], projected: [] },
    activityChart: { labels: [], calls: [], distributions: [] },
    rollforward: [],
    composition: [],
    plans: [],
    activities: [],
    statements: [],
    marks: [],
    positions: [],
    forecastLabels: [],
    forecastRows: [],
    investors: [],
    investorTypes: [],
    exposure: { strategy: [], sector: [], issuer: [] },
    pacing: { calledPct: null, planPct: null, planLabel: '', behindPts: null, behindAmount: null, requiredCall: null, trailingCall: null },
    nextCall: null,
    largestInvestor: null,
    pastDue: null,
    investorCount: 0,
  };
  return { ...blank, errors: [{ field: 'fundId', message, code: 'FUND_SURFACE' }] };
}

export const fundSurfaceResolvers = {
  Query: {
    fundSurface: async (
      _: unknown,
      args: { fundId: string; asOfDate?: string | null; knowledgeDate?: string | null },
      context: Context,
    ) => {
      try {
        return { ...(await loadFundSurface(context.supabase, args.fundId, args.asOfDate, args.knowledgeDate)), errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load the fund surface';
        return empty(args.fundId, message);
      }
    },
  },
};
