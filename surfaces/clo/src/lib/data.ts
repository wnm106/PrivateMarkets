/**
 * Reads the CLO book through the public GraphQL schema, with the user's As Of and Knowledge dates.
 * Every test comes from the compliance engine and every other figure is worked out by the platform
 * (`cloBook`, `cloDrift`, `cloOpportunities`: packages/graphql/src/lib/clo-book.ts and
 * clo-book-store.ts). The surface only arranges what comes back.
 */
import type { SurfaceHost } from '@tapestrai/surface-sdk';

export type Metric = 'WARF' | 'WAS' | 'WAL' | 'WARR' | 'CCC' | 'OC' | 'IC' | 'DIVERSITY';

export interface Test {
  ruleCode: string; ruleName: string; category: string; metric: Metric | null; rank: number | null; group: string | null;
  direction: 'MAX' | 'MIN'; value: number | null; numerator: number | null; denominator: number | null;
  limit: number | null; softLimit: number | null; status: string; unit: string | null;
  cushion: number | null; cushionPct: number | null; limitAttribute: string | null; limitHolder: 'TRANSACTION' | 'NOTE' | null; error: string | null;
}

export interface Term { code: string; name: string; section: string; order: number; dataType: string; value: string | null; numeric: number | null }

export interface Note {
  id: string; name: string; cls: string; rank: number; deferrable: boolean; residual: boolean;
  originalPar: number | null; par: number; deferredInterest: number; interestDue: number; spreadBps: number | null;
  couponPct: number | null; ocTrigger: number | null; icTrigger: number | null;
  ratingSp: string | null; ratingMoodys: string | null; ratingFitch: string | null;
  sharePct: number | null; attachmentPct: number | null; detachmentPct: number | null;
  oc: Test | null; ic: Test | null;
}

export interface Account { id: string; name: string; type: string | null; currency: string | null; balance: number; uninvested: number }

export interface Holding {
  positionId: string; securityId: string | null; issuerId: string | null;
  name: string; issuer: string; industry: string | null; obligorGroup: string | null; country: string | null;
  par: number; price: number | null; marketValue: number | null; expectedInterest: number | null;
  loanType: string | null; lien: string | null; covLite: boolean; fixedRate: boolean; defaulted: boolean; discount: boolean;
  spreadBps: number | null; maturity: string | null; lifeYears: number | null; ratingMoodys: string | null; ratingSp: string | null;
  factor: number | null; ccc: boolean; recovery: number | null; outlook: string | null; currency: string | null; acquired: string | null;
  carryValue: number | null; sharePct: number | null;
}

export interface Kpi { metric: Metric; label: string; rank: number | null; value: number | null; limit: number | null; direction: 'MAX' | 'MIN'; status: string; cushion: number | null; cushionPct: number | null; ruleCode: string | null; ruleName: string | null }

/** One industry behind the engine's diversity score. */
export interface DiversityIndustry { industry: string; obligors: number; par: number; units: number; score: number }

export interface WaterfallStep {
  order: number; waterfall: 'INTEREST' | 'PRINCIPAL'; kind: string; label: string; noteId: string | null;
  due: number; paid: number; deferred: number; shortfall: number; availableBefore: number; availableAfter: number; basis: string;
}

export interface Waterfall {
  steps: WaterfallStep[]; interestProceeds: number; principalProceeds: number; paidToNotes: number; diverted: number;
  deferred: number; shortfall: number; residualToEquity: number; equityCashYieldPct: number | null;
  paydowns: Array<{ noteId: string; cls: string; amount: number }>;
}

export interface Vehicle {
  id: string; code: string; name: string; currency: string | null;
  transactionId: string | null; transactionName: string | null;
  phase: string | null; manager: string | null; trustee: string | null;
  reinvestmentEnd: string | null; nonCallEnd: string | null; maturity: string | null; nextPayment: string | null;
  yearsToReinvestmentEnd: number | null; benchmarkPct: number | null; periodsPerYear: number;
  terms: Term[]; notes: Note[]; accounts: Account[]; holdings: Holding[]; hypotheticalPositions: number;
  collateral: {
    par: number; performingPar: number; defaultedPar: number; marketValue: number; weightedPrice: number | null; count: number; obligors: number;
    cccPar: number; cccPct: number | null; covLitePct: number | null; secondLienPct: number | null; fixedRatePct: number | null;
    largestObligorPct: number | null; interestProceeds: number; principalCash: number; notesPar: number; ratedNotesPar: number; equityPar: number;
  };
  tests: Test[];
  kpis: Kpi[];
  diversity: { score: number | null; obligors: number; averagePar: number | null; industries: DiversityIndustry[]; unclassifiedPar: number; limit: number | null; status: string };
  waterfall: Waterfall;
  summary: { tests: number; breaches: number; warnings: number; noData: number; passing: number; tightest: { label: string; cushionPct: number } | null };
  errors: string[];
}

export interface Book {
  asOfDate: string; knowledgeDate: string; vehicles: Vehicle[];
  totals: { vehicles: number; collateralPar: number; notesPar: number; breaches: number; warnings: number };
  errors: string[];
}

export interface DriftPoint {
  date: string; kpis: Kpi[];
  collateralPar: number; performingPar: number; defaultedPar: number; marketValue: number; weightedPrice: number | null;
  cccPct: number | null; notesPar: number; ratedNotesPar: number; obligors: number; count: number;
  breaches: number; residualToEquity: number; diverted: number;
}

export interface Drift { fundId: string; asOfDate: string; knowledgeDate: string; dates: string[]; points: DriftPoint[]; errors: string[] }

export interface ProformaLine {
  ruleCode: string; ruleName: string; groupByValue: string | null; limitDirection: 'MAX' | 'MIN' | null;
  baselineValue: number | null; scenarioValue: number | null; baselineStatus: string | null; scenarioStatus: string | null;
  hardLimitValue: number | null; verdict: string; approved: boolean;
}

export interface MetricChange {
  metric: Metric; label: string; rank: number | null; direction: 'MAX' | 'MIN';
  before: number | null; after: number | null; limit: number | null; gain: number | null; gainPctOfCushion: number | null;
}

export interface Opportunity {
  securityId: string; issuerId: string | null; name: string; issuer: string; industry: string | null; newIndustry: boolean;
  ratingMoodys: string | null; ratingSp: string | null; factor: number | null; ccc: boolean; spreadBps: number | null; fixedRate: boolean;
  maturity: string | null; lifeYears: number | null; lien: string | null; covLite: boolean;
  offerPrice: number | null; offerSize: number | null; ticket: number;
  score: { approved: boolean; cures: number; newBreaches: number; worsensFailing: number; improvesFailing: number; changes: MetricChange[]; compositionScore: number } | null;
  moves: ProformaLine[];
  error: string | null;
}

export interface Opportunities {
  fundId: string; asOfDate: string; knowledgeDate: string; ticketRule: string; candidates: number; scored: number;
  baseline: { diversity: number | null; diversityLimit: number | null; averagePar: number | null };
  opportunities: Opportunity[];
  errors: string[];
}

export interface Capacity {
  capacityPar: number | null; bindingRuleCode: string | null; bindingGroup: string | null;
  lines: Array<{ ruleCode: string; ruleName: string; groupByValue: string | null; impact: string; capacityPar: number | null; binding: boolean }>;
  errors: Array<{ message: string }>;
}

/** Attribute codes the surface binds values to. Right-click on each opens its sources. */
export const ATTR = {
  par: 'FUNDED_PAR_AMOUNT', price: 'FAIR_MARKET_PRICE', marketValue: 'MARKET_VALUE', expectedInterest: 'CLO_EXPECTED_INTEREST',
  discount: 'CLO_IS_DISCOUNT_OBLIGATION', carryValue: 'CLO_DEFAULT_CARRY_VALUE', acquired: 'CLO_ACQUISITION_DATE',
  loanType: 'CLO_LOAN_TYPE', lien: 'LIEN_PRIORITY', covLite: 'IS_COV_LITE', fixedRate: 'IS_FIXED_RATE', defaulted: 'IS_DEFAULTED',
  spread: 'SPREAD_BPS', maturity: 'MATURITY_DATE', moodys: 'CLO_MOODYS_FACILITY_RATING', sp: 'CLO_SP_FACILITY_RATING',
  factor: 'CLO_MOODYS_RATING_FACTOR', ccc: 'CLO_IS_CCC', recovery: 'CLO_MOODYS_RECOVERY_RATE', outlook: 'CLO_RATING_OUTLOOK',
  offerPrice: 'CLO_OFFER_PRICE', offerSize: 'CLO_OFFER_SIZE', marketStatus: 'CLO_MARKET_STATUS',
  industry: 'MOODYS_INDUSTRY_CODE', obligorGroup: 'OBLIGOR_GROUP_ID', country: 'COUNTRY_OF_DOMICILE',
  noteClass: 'CLO_NOTE_CLASS_CODE', noteRank: 'CLO_NOTE_SENIORITY_RANK', noteDeferrable: 'CLO_NOTE_IS_DEFERRABLE',
  noteOriginal: 'CLO_NOTE_ORIGINAL_PAR', notePar: 'CLO_NOTE_PAR_OUTSTANDING', noteDeferred: 'CLO_NOTE_DEFERRED_INTEREST',
  noteDue: 'CLO_NOTE_INTEREST_DUE', noteSpread: 'CLO_NOTE_SPREAD_BPS', noteOc: 'CLO_NOTE_OC_TRIGGER', noteIc: 'CLO_NOTE_IC_TRIGGER',
  noteSp: 'CLO_NOTE_RATING_SP', noteMoodys: 'CLO_NOTE_RATING_MOODYS', noteFitch: 'CLO_NOTE_RATING_FITCH',
  acctType: 'CLO_ACCT_TYPE', acctCurrency: 'CLO_ACCT_CURRENCY', acctBalance: 'CLO_ACCT_BALANCE', acctUninvested: 'CLO_ACCT_UNINVESTED_PROCEEDS',
  manager: 'CLO_COLLATERAL_MANAGER', trustee: 'CLO_TRUSTEE', reinvestmentEnd: 'CLO_REINVESTMENT_PERIOD_END', nonCallEnd: 'CLO_NON_CALL_END',
  maturityTxn: 'CLO_STATED_MATURITY', nextPayment: 'CLO_NEXT_PAYMENT_DATE', benchmark: 'CLO_BENCHMARK_RATE_PCT',
  seniorExpenses: 'CLO_SENIOR_EXPENSES', seniorFee: 'CLO_SENIOR_MGMT_FEE_BPS', subFee: 'CLO_SUB_MGMT_FEE_BPS',
  minDiversity: 'CLO_MIN_DIVERSITY_SCORE', targetPar: 'CLO_TARGET_INITIAL_PAR',
} as const;

const FUNDS = `query CloFunds($asOfDate: Date, $knowledgeDate: DateTime) {
  funds: entities(filter: { domainCode: "FUND", isActive: true }, pagination: { first: 2000 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { edges { node { id } } }
}`;
const BOOK = `query CloBook($fundIds: [ID!]!, $asOfDate: Date, $knowledgeDate: DateTime) { cloBook(fundIds: $fundIds, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) }`;
const DRIFT = `query CloDrift($fundId: ID!, $quarters: Int, $asOfDate: Date, $knowledgeDate: DateTime) { cloDrift(fundId: $fundId, quarters: $quarters, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) }`;
const OPPS = `query CloOpportunities($fundId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) { cloOpportunities(fundId: $fundId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) }`;
const CAPACITY = `query CloCapacity($fundId: ID!, $securityId: ID!, $asOfDate: Date!, $knowledgeDate: DateTime, $probe: JSON) {
  investmentCapacity(anchorEntityId: $fundId, securityId: $securityId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate, probeAttributes: $probe, probeParAttributes: []) {
    capacityPar bindingRuleCode bindingGroup lines { ruleCode ruleName groupByValue impact capacityPar binding } errors { message }
  }
}`;

/**
 * The Knowledge date as the API reads it. A bare day means what was known by the end of that day;
 * today (or later) means now. A datetime passes through.
 */
export function knowledgeArg(knowledgeDate: string | null | undefined): string | null {
  const t = (knowledgeDate || '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const today = new Date().toISOString().slice(0, 10);
    return t >= today ? null : `${t}T23:59:59.999Z`;
  }
  return t;
}

const dates = (host: SurfaceHost) => ({ asOfDate: host.asOfDate || null, knowledgeDate: knowledgeArg(host.knowledgeDate) });

export async function loadBook(host: SurfaceHost): Promise<{ book: Book | null; error: string | null }> {
  const funds = await host.query<{ funds: { edges: Array<{ node: { id: string } }> } }>(FUNDS, dates(host), 'network-only');
  if (funds.error) return { book: null, error: funds.error.message };
  const fundIds = (funds.data?.funds.edges || []).map((e) => e.node.id);
  const r = await host.query<{ cloBook: Book }>(BOOK, { fundIds, ...dates(host) }, 'network-only');
  if (r.error) return { book: null, error: r.error.message };
  return r.data?.cloBook ? { book: r.data.cloBook, error: null } : { book: null, error: 'Nothing came back.' };
}

export async function loadDrift(host: SurfaceHost, fundId: string): Promise<{ drift: Drift | null; error: string | null }> {
  const r = await host.query<{ cloDrift: Drift }>(DRIFT, { fundId, quarters: 8, ...dates(host) }, 'network-only');
  if (r.error) return { drift: null, error: r.error.message };
  return r.data?.cloDrift ? { drift: r.data.cloDrift, error: null } : { drift: null, error: 'Nothing came back.' };
}

export async function loadOpportunities(host: SurfaceHost, fundId: string): Promise<{ opportunities: Opportunities | null; error: string | null }> {
  const r = await host.query<{ cloOpportunities: Opportunities }>(OPPS, { fundId, ...dates(host) }, 'network-only');
  if (r.error) return { opportunities: null, error: r.error.message };
  return r.data?.cloOpportunities ? { opportunities: r.data.cloOpportunities, error: null } : { opportunities: null, error: 'Nothing came back.' };
}

/**
 * The largest par of one offered loan the CLO can buy without pushing a test through its limit
 * (the platform's capacity solver). The probed buy carries the offer price; it carries no expected
 * interest, so the interest coverage tests read it as earning nothing, which is the cautious side.
 */
export async function loadCapacity(host: SurfaceHost, fundId: string, asOfDate: string, o: Opportunity): Promise<{ capacity: Capacity | null; error: string | null }> {
  const probe = { FAIR_MARKET_PRICE: o.offerPrice ?? 100, CLO_IS_DISCOUNT_OBLIGATION: 'false' };
  const r = await host.query<{ investmentCapacity: Capacity }>(CAPACITY, { fundId, securityId: o.securityId, asOfDate, knowledgeDate: knowledgeArg(host.knowledgeDate), probe }, 'network-only');
  if (r.error) return { capacity: null, error: r.error.message };
  const c = r.data?.investmentCapacity ?? null;
  if (c?.errors?.length) return { capacity: null, error: c.errors.map((e) => e.message).join('; ') };
  return { capacity: c, error: c ? null : 'Nothing came back.' };
}
