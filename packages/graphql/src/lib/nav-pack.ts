/**
 * The NAV pack: the ten parts of an administrator's quarter-end pack, and the
 * checks the NAV reconciliation makes of each (docs/NAV_PACK.md).
 *
 * The reconciliation (fund-rec.ts) already checks the statements, the schedule,
 * the investment roll, cash, notices, the facility and both fees. This adds the
 * parts it had no figures for, the trial balance, the investors' capital
 * accounts, valuation support and FX, and the NAV bridge, waterfall tiers,
 * per-investor fees, receivables and payables, and the commitments schedule.
 * Then it says, part by part, what is on file and whether it ties.
 *
 * Pure: the store reads the records, the reconciliation passes its figures.
 * Every check is a RecCheck, so the break summary, the Breaks tab and
 * certification treat it like any other.
 */
import type { RecBind, RecCheck, RecItem } from './fund-rec';

/* ---------------------------------------------------------------- parts */

export type PackComponentKey =
  | 'NAV_BRIDGE' | 'TRIAL_BALANCE' | 'FINANCIAL_STATEMENTS' | 'CAPITAL_ACCOUNTS' | 'MANAGEMENT_FEE'
  | 'CARRIED_INTEREST' | 'VALUATION' | 'CAPITAL_ACTIVITY' | 'COMMITMENTS' | 'FX';

export const PACK_COMPONENTS: ReadonlyArray<{ key: PackComponentKey; label: string; owner: string; covers: string }> = [
  { key: 'NAV_BRIDGE', label: 'NAV summary and bridge', owner: 'Fund accountant', covers: 'Opening NAV, contributions, distributions, income, expenses, realized and unrealized gains, FX, closing NAV' },
  { key: 'TRIAL_BALANCE', label: 'Trial balance', owner: 'Fund administrator', covers: 'Every ledger account: assets, liabilities, capital, income and expenses' },
  { key: 'FINANCIAL_STATEMENTS', label: 'Financial statements', owner: 'Fund administrator', covers: 'Balance sheet, operations, changes in capital, cash flows and the notes' },
  { key: 'CAPITAL_ACCOUNTS', label: 'Capital account summary (PCAP)', owner: 'Investor services', covers: 'Each investor: opening, contributions, distributions, allocated profit or loss, closing, commitment, unfunded, ownership' },
  { key: 'MANAGEMENT_FEE', label: 'Management fee calculation', owner: 'Fund accountant', covers: 'Fee basis and rate, step-down, each investor\'s rate and fee, and how the fee is allocated' },
  { key: 'CARRIED_INTEREST', label: 'Carried interest and waterfall', owner: 'Fund controller', covers: 'Preferred return, GP catch-up, carry split, the waterfall tiers and the GP\'s carry' },
  { key: 'VALUATION', label: 'Valuation support', owner: 'Valuation analyst', covers: 'Third-party reports, GP memos, comparables and model outputs behind each mark' },
  { key: 'CAPITAL_ACTIVITY', label: 'Capital call and distribution summary', owner: 'Investor services', covers: 'Calls issued and received, receivables, distributions declared and paid' },
  { key: 'COMMITMENTS', label: 'Commitments and unfunded schedule', owner: 'Investor services', covers: 'Each investor\'s commitment, contributions to date, unfunded amount, and calls still to come' },
  { key: 'FX', label: 'FX translation and exposure', owner: 'Fund accountant', covers: 'Rates applied, FX gains realized and unrealized, exposure and hedging' },
];

export type PackStatus = 'Ties' | 'Breaks' | 'Open' | 'Partial' | 'Not on file' | 'Not expected';

export interface PackComponent {
  key: PackComponentKey;
  label: string;
  owner: string;
  covers: string;
  /** The fund's terms call for it, or the fund lists it. */
  expected: boolean;
  /** The fund lists it in FUND_NAV_PACK_REQUIRED: a missing or breaking part blocks certification. */
  required: boolean;
  onFile: boolean;
  status: PackStatus;
  /** What is on file, or what is missing. */
  detail: string;
  /** The checks behind the status, by id. */
  checks: string[];
  /** Open review items on this part, by id. */
  items: string[];
}

/* ---------------------------------------------------------------- input */

export type AccountClass = 'ASSET' | 'LIABILITY' | 'CAPITAL' | 'INCOME' | 'EXPENSE' | 'GAIN_LOSS';

export interface PackTbLine {
  id: string; name: string; account: string; accountName: string; accountClass: AccountClass | null;
  debit: number | null; credit: number | null; balance: number | null; navLine: string | null; periodStart: string | null;
}

export interface PackCapitalAccount {
  id: string; name: string; investorId: string | null; isGp: boolean;
  opening: number | null; contributions: number | null; distributions: number | null; pnl: number | null;
  mgmtFee: number | null; feeRatePct: number | null; carry: number | null; carryBalance: number | null; other: number | null;
  closing: number | null; commitment: number | null; contributedItd: number | null; unfunded: number | null; ownershipPct: number | null;
}

export interface PackValuation {
  id: string; name: string; positionId: string; date: string; sourceType: string | null; method: string | null;
  provider: string | null; fairValue: number | null; low: number | null; high: number | null; document: string | null;
}

export interface PackHolding { id: string; name: string; fairValue: number; cost: number | null; currency: string | null }

export interface PackFx {
  id: string; name: string; currency: string; rateApplied: number | null; exposureLocal: number | null; exposureBase: number | null;
  realized: number | null; unrealized: number | null; hedgeNotional: number | null; hedgeMtm: number | null;
}

/** A market rate at the period end: quote currency units for one unit of the base currency. */
export interface PackMarketRate { id: string; name: string; base: string; quote: string; rate: number; source: string | null }

export interface PackActivity {
  id: string; name: string; kind: 'CAPITAL_CALL' | 'DISTRIBUTION' | string; date: string; amount: number;
  status: string | null; outstanding: number | null;
}

export interface PackCommitmentRecord { id: string; name: string; investorId: string; amount: number }

export interface PackInput {
  baseCurrency: string;
  /** FUND_NAV_PACK_REQUIRED. Null when the fund lists none. */
  required: PackComponentKey[] | null;
  notesIncluded: boolean | null;
  trialBalance: PackTbLine[];
  capitalAccounts: PackCapitalAccount[];
  valuations: PackValuation[];
  holdings: PackHolding[];
  fx: PackFx[];
  marketRates: PackMarketRate[];
  activities: PackActivity[];
  commitments: PackCommitmentRecord[];
  settings: {
    valuationCoveragePct: number | null;
    thirdPartyCoveragePct: number | null;
    fxTolerancePct: number | null;
    fxHedgeTargetPct: number | null;
    totalCommitments: number | null;
    undrawnCommitments: number | null;
  };
}

/** An empty pack: what a fund with none of these records on file has. */
export function emptyPack(baseCurrency = 'USD'): PackInput {
  return {
    baseCurrency, required: null, notesIncluded: null, trialBalance: [], capitalAccounts: [], valuations: [], holdings: [],
    fx: [], marketRates: [], activities: [], commitments: [],
    settings: { valuationCoveragePct: null, thirdPartyCoveragePct: null, fxTolerancePct: null, fxHedgeTargetPct: null, totalCommitments: null, undrawnCommitments: null },
  };
}

/** What the reconciliation hands the pack: its figures, its terms, and what it has already checked. */
export interface PackContext {
  fund: { id: string; name: string; capitalModel: 'DRAWDOWN' | 'EVERGREEN'; feeRatePct: number | null; carryPct: number | null };
  periodEnd: string;
  previous: string;
  spanMonths: number;
  lagDays: number;
  /** The administrator's figure for a statement line at the period end, and at the previous date. */
  amount: (key: string) => number | null;
  prior: (key: string) => number | null;
  /** Where that figure comes from. */
  lineSources: (key: string) => RecBind[];
  /** Which primary statements have figures. */
  statementsWithFigures: string[];
  fee: {
    /** The fee terms for each part of the period. Two parts when the fee steps down in the period. */
    segments: Array<{ from: string; to: string; share: number; ratePct: number | null; basis: string; base: number | null }>;
    admin: number | null;
    sources: RecBind[];
  };
  perf: {
    basis: 'WATERFALL' | 'INCOME';
    ready: boolean;
    contributions: number; distributions: number; profit: number; hurdle: number; excess: number; carry: number; admin: number;
    carryPct: number; catchUpPct: number;
    sources: RecBind[];
  };
  checks: RecCheck[];
  items: RecItem[];
}

/* ---------------------------------------------------------------- output */

export interface NavBridgeStep { key: string; label: string; amount: number | null; sources: RecBind[] }

export interface NavBridge {
  opening: number | null;
  steps: NavBridgeStep[];
  /** Opening plus every step. */
  closing: number | null;
  reported: number | null;
  difference: number | null;
  openingSources: RecBind[];
  reportedSources: RecBind[];
}

export interface WaterfallTier { key: string; label: string; total: number; gp: number; lp: number }

export interface PackReview {
  components: PackComponent[];
  checks: RecCheck[];
  bridge: NavBridge;
  trialBalance: { accounts: number; debits: number; credits: number; byClass: Record<AccountClass, number>; unclassified: number } | null;
  capitalAccounts: {
    investors: number;
    rows: Array<{
      id: string; name: string; isGp: boolean; opening: number | null; contributions: number | null; distributions: number | null;
      pnl: number | null; carry: number | null; other: number | null; closing: number | null; rolled: number | null; difference: number | null;
      commitment: number | null; unfunded: number | null; ownershipPct: number | null; feeCharged: number | null; feeRecalculated: number | null;
    }>;
    totals: { opening: number; contributions: number; distributions: number; pnl: number; carry: number; closing: number; ownershipPct: number };
  } | null;
  fees: {
    segments: PackContext['fee']['segments'];
    stepDown: boolean;
    perInvestor: number;
    charged: number | null;
    allocation: string;
  };
  waterfall: { basis: 'WATERFALL' | 'INCOME'; tiers: WaterfallTier[]; carry: number; gpCarryOnFile: number | null } | null;
  valuation: {
    total: number; supported: number; coveragePct: number | null; requiredPct: number; thirdPartyPct: number | null;
    unsupported: Array<{ id: string; name: string; fairValue: number }>;
    outside: Array<{ id: string; name: string; fairValue: number; low: number | null; high: number | null; concluded: number | null; source: string | null }>;
  } | null;
  capitalActivity: {
    calledInPeriod: number; receivedInPeriod: number; callsOutstanding: number;
    distributionsInPeriod: number; paidInPeriod: number; distributionsPayable: number;
    pending: Array<{ id: string; name: string; date: string; amount: number }>;
  } | null;
  commitments: { investors: number; committed: number; contributed: number; unfunded: number; pendingCalls: number } | null;
  fx: {
    base: string;
    currencies: Array<{
      currency: string; applied: number | null; market: number | null; differencePct: number | null;
      exposureLocal: number | null; exposureBase: number | null; realized: number | null; unrealized: number | null;
      hedgeNotional: number | null; hedgedPct: number | null; hedgeMtm: number | null;
    }>;
    heldWithoutRate: string[];
  } | null;
}

/* ---------------------------------------------------------------- helpers */

const TIE = 5000;
const ACCOUNT_TIE = 5;
const present = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const sum = (values: Array<number | null | undefined>) => values.reduce<number>((total, value) => total + (present(value) ? value : 0), 0);
const anyPresent = (values: Array<number | null | undefined>) => values.some(present);
const round2 = (value: number) => Math.round(value * 100) / 100;
const money = (value: number) => `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const listOf = (names: string[], max = 3) => `${names.slice(0, max).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`;

const FIELD: Record<string, [name: string, dataType: string, domainCode: string]> = {
  TB_BALANCE: ['Net Balance', 'CURRENCY', 'TRIAL_BALANCE_LINE'],
  TB_DEBIT: ['Debit', 'CURRENCY', 'TRIAL_BALANCE_LINE'],
  TB_CREDIT: ['Credit', 'CURRENCY', 'TRIAL_BALANCE_LINE'],
  CAPACCT_OPENING: ['Opening Capital', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_CONTRIBUTIONS: ['Contributions', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_DISTRIBUTIONS: ['Distributions', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_PNL: ['Allocated Profit or Loss', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_MGMT_FEE: ['Management Fee Charged', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_CARRY: ['Carried Interest Allocation', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_CARRY_BALANCE: ['Carried Interest Balance', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_CLOSING: ['Closing Capital', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_COMMITMENT: ['Commitment', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_CONTRIBUTED_ITD: ['Contributed to Date', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_UNFUNDED: ['Unfunded Commitment', 'CURRENCY', 'CAPITAL_ACCOUNT'],
  CAPACCT_OWNERSHIP_PCT: ['Ownership', 'PERCENTAGE', 'CAPITAL_ACCOUNT'],
  COMMITMENT_AMOUNT: ['Commitment Amount', 'CURRENCY', 'INVESTOR_COMMITMENT'],
  VALUATION_FAIR_VALUE: ['Concluded Value', 'CURRENCY', 'VALUATION_SUPPORT'],
  VALUATION_DATE: ['Valuation Date', 'DATE', 'VALUATION_SUPPORT'],
  MARKET_VALUE: ['Market Value', 'NUMBER', 'POSITION'],
  FXT_RATE_APPLIED: ['Rate Applied', 'DECIMAL', 'FX_TRANSLATION'],
  FXT_EXPOSURE_LOCAL: ['Exposure in Currency', 'DECIMAL', 'FX_TRANSLATION'],
  FXT_EXPOSURE_BASE: ['Exposure in Base Currency', 'CURRENCY', 'FX_TRANSLATION'],
  FXT_REALIZED: ['Realized FX Gain', 'CURRENCY', 'FX_TRANSLATION'],
  FXT_UNREALIZED: ['Unrealized FX Gain', 'CURRENCY', 'FX_TRANSLATION'],
  FXT_HEDGE_NOTIONAL: ['Hedged Notional', 'CURRENCY', 'FX_TRANSLATION'],
  FXT_HEDGE_MTM: ['Hedge Fair Value', 'CURRENCY', 'FX_TRANSLATION'],
  FX_MARKET_RATE: ['Market Rate', 'DECIMAL', 'FX_RATE'],
  ACTIVITY_AMOUNT: ['Amount', 'CURRENCY', 'CAPITAL_ACTIVITY'],
  ACTIVITY_OUTSTANDING: ['Outstanding', 'CURRENCY', 'CAPITAL_ACTIVITY'],
  FUND_TOTAL_COMMITMENTS: ['Total Commitments', 'CURRENCY', 'FUND'],
  FUND_UNDRAWN_COMMITMENTS: ['Undrawn Commitments', 'CURRENCY', 'FUND'],
  FUND_VALUATION_COVERAGE_PCT: ['Valuation Support Required', 'PERCENTAGE', 'FUND'],
  FUND_THIRD_PARTY_COVERAGE_PCT: ['Third-party Valuation Required', 'PERCENTAGE', 'FUND'],
  FUND_FX_RATE_TOLERANCE_PCT: ['FX Rate Tolerance', 'PERCENTAGE', 'FUND'],
  FUND_FX_HEDGE_TARGET_PCT: ['FX Hedge Target', 'PERCENTAGE', 'FUND'],
  FUND_NAV_PACK_REQUIRED: ['NAV Pack Components Required', 'REFERENCE_LIST', 'FUND'],
  STATEMENT_NOTES_INCLUDED: ['Notes Included', 'BOOLEAN', 'NAV_STATEMENT'],
};

function bind(entityId: string | null | undefined, entityName: string, code: string, asOf?: string): RecBind | null {
  const spec = FIELD[code];
  if (!entityId || !spec) return null;
  return { entityId, entityName: entityName || spec[0], domainCode: spec[2], code, name: spec[0], dataType: spec[1], ...(asOf ? { asOfDate: asOf } : {}) };
}

function binds(...items: Array<RecBind | null | undefined | RecBind[]>): RecBind[] {
  const out: RecBind[] = [];
  const seen = new Set<string>();
  const add = (item: RecBind | null | undefined) => {
    if (!item) return;
    const key = `${item.entityId}:${item.code}:${item.sourceCode || ''}:${item.asOfDate || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const item of items) {
    if (Array.isArray(item)) item.forEach(add);
    else add(item);
  }
  return out.slice(0, 60);
}

/** The balance of a ledger account: debit less credit, unless the net balance is given. */
export function tbBalance(line: Pick<PackTbLine, 'debit' | 'credit' | 'balance'>): number | null {
  if (present(line.balance)) return line.balance;
  if (!present(line.debit) && !present(line.credit)) return null;
  return (line.debit ?? 0) - (line.credit ?? 0);
}

/** An investor's capital rolled forward: opening + contributions - distributions + allocation + carry + other. */
export function rolledCapital(account: PackCapitalAccount): number | null {
  if (!present(account.opening)) return null;
  return account.opening + (account.contributions ?? 0) - Math.abs(account.distributions ?? 0) + (account.pnl ?? 0) + (account.carry ?? 0) + (account.other ?? 0);
}

/**
 * The waterfall, tier by tier, on the profit the reconciliation worked: return
 * of capital (liquidation waterfall only), the preferred return, the GP
 * catch-up, then the carry split. The GP's tiers add up to the carry the
 * reconciliation recalculated.
 */
export function waterfallTiers(perf: PackContext['perf']): WaterfallTier[] {
  const carryShare = Math.max(0, perf.carryPct) / 100;
  const catchUpShare = Math.max(0, perf.catchUpPct) / 100;
  const tiers: WaterfallTier[] = [];
  if (perf.basis === 'WATERFALL') {
    tiers.push({ key: 'capital', label: 'Return of contributed capital', total: perf.contributions, gp: 0, lp: perf.contributions });
  }
  const profit = Math.max(0, perf.profit);
  const pref = Math.min(profit, Math.max(0, perf.hurdle));
  tiers.push({ key: 'pref', label: 'Preferred return', total: pref, gp: 0, lp: pref });
  const excess = Math.max(0, profit - pref);
  // The catch-up runs until the GP holds its carry share of everything above capital: X with catchUp * X = carry * (pref + X).
  const catchUpSpan = catchUpShare > carryShare && carryShare > 0 ? (carryShare * pref) / (catchUpShare - carryShare) : 0;
  const catchUp = Math.min(excess, catchUpSpan);
  tiers.push({ key: 'catchUp', label: 'GP catch-up', total: catchUp, gp: catchUp * catchUpShare, lp: catchUp * (1 - catchUpShare) });
  const split = Math.max(0, excess - catchUp);
  tiers.push({ key: 'split', label: `Carry split (${perf.carryPct}% to the GP)`, total: split, gp: split * carryShare, lp: split * (1 - carryShare) });
  return tiers;
}

/** The rate applied to one unit of a currency in the base currency, from market rates quoted either way round. */
export function marketRateFor(currency: string, base: string, rates: PackMarketRate[]): PackMarketRate & { inBase: number } | null {
  const direct = rates.find((rate) => rate.base === currency && rate.quote === base && rate.rate > 0);
  if (direct) return { ...direct, inBase: direct.rate };
  const inverse = rates.find((rate) => rate.base === base && rate.quote === currency && rate.rate > 0);
  if (inverse) return { ...inverse, inBase: 1 / inverse.rate };
  return null;
}

/** The parts a fund's pack is expected to have, from its terms, when it lists none itself. */
export function expectedComponents(context: Pick<PackContext, 'fund'>, pack: PackInput): Set<PackComponentKey> {
  if (pack.required && pack.required.length) return new Set(pack.required);
  const expected = new Set<PackComponentKey>(['NAV_BRIDGE', 'FINANCIAL_STATEMENTS']);
  const drawdown = context.fund.capitalModel === 'DRAWDOWN';
  if (drawdown) ['TRIAL_BALANCE', 'CAPITAL_ACCOUNTS', 'CAPITAL_ACTIVITY', 'COMMITMENTS'].forEach((key) => expected.add(key as PackComponentKey));
  if (present(context.fund.feeRatePct) && context.fund.feeRatePct > 0) expected.add('MANAGEMENT_FEE');
  if (present(context.fund.carryPct) && context.fund.carryPct > 0) expected.add('CARRIED_INTEREST');
  if (pack.holdings.length) expected.add('VALUATION');
  const foreign = pack.holdings.some((holding) => holding.currency && holding.currency !== pack.baseCurrency);
  if (foreign || pack.fx.length) expected.add('FX');
  return expected;
}

/* ---------------------------------------------------------------- the pack */

export function buildPack(context: PackContext, pack: PackInput): PackReview {
  const { periodEnd, previous } = context;
  const A = context.amount;
  const S = context.lineSources;
  const checks: RecCheck[] = [];
  const owners = new Map<string, PackComponentKey>();
  const add = (
    component: PackComponentKey, id: string, label: string, compared: string,
    a: number | null, b: number | null, aSources: RecBind[], bSources: RecBind[], tie = TIE,
  ) => {
    const result: RecCheck['result'] = !present(a) || !present(b) ? 'Missing' : Math.abs(a - b) < tie ? 'Ties' : 'Break';
    checks.push({ id, group: 'pack', component, label, compared, a, b, difference: present(a) && present(b) ? a - b : null, result, aSources, bSources });
    owners.set(id, component);
  };
  /** A check that passes when a meets b (a share, a count), rather than equals it. */
  const atLeast = (
    component: PackComponentKey, id: string, label: string, compared: string,
    a: number | null, b: number | null, aSources: RecBind[], bSources: RecBind[],
  ) => {
    const result: RecCheck['result'] = !present(a) || !present(b) ? 'Missing' : a + 1e-9 >= b ? 'Ties' : 'Break';
    checks.push({ id, group: 'pack', component, label, compared, a, b, difference: present(a) && present(b) ? a - b : null, result, aSources, bSources });
    owners.set(id, component);
  };
  const expected = expectedComponents(context, pack);

  /* 1. NAV bridge -------------------------------------------------------- */
  const opening = A('chBegin') ?? context.prior('netAssets');
  const openingSources = present(A('chBegin')) ? S('chBegin') : S('netAssets');
  const reported = A('chEnd') ?? A('netAssets');
  const reportedSources = present(A('chEnd')) ? S('chEnd') : S('netAssets');
  const fxRealized = A('fxRealized');
  const fxUnrealized = A('fxUnrealized');
  const fx = anyPresent([fxRealized, fxUnrealized]) ? (fxRealized ?? 0) + (fxUnrealized ?? 0) : null;
  const income = A('totalInc');
  const expenses = A('totalExp');
  const nii = A('nii');
  const contributions = A('chContrib');
  const distributions = present(A('chDist')) ? -Math.abs(A('chDist')!) : null;
  // Every capital movement the statement prints: share transactions beside distributions, or capital transactions as a whole.
  const capitalTotal = present(A('chShares')) ? A('chShares')! + (distributions ?? 0) : A('chCapital');
  const otherCapital = present(capitalTotal) ? capitalTotal - (contributions ?? 0) - (distributions ?? 0) : null;
  // Gains are what operations add beyond net investment income, as the statement itself splits them. Realized is the
  // statement's realized subtotal when it prints one (it holds currency and derivatives too); unrealized is the rest.
  const operations = A('netInc') ?? A('chOps');
  const gains = present(operations) && present(nii) ? operations - nii : present(A('realized')) || present(A('unrealized')) ? (A('realized') ?? 0) + (A('unrealized') ?? 0) : null;
  const realizedTotal = A('realizedTotal') ?? A('realized');
  const realized = present(realizedTotal) ? realizedTotal - (fxRealized ?? 0) : null;
  const unrealized = present(gains) ? gains - (realizedTotal ?? 0) - (fxUnrealized ?? 0) : null;
  const steps: NavBridgeStep[] = [
    { key: 'contributions', label: 'Contributions', amount: contributions, sources: S('chContrib') },
    { key: 'distributions', label: 'Distributions', amount: distributions, sources: S('chDist') },
  ];
  if (present(otherCapital) && Math.abs(otherCapital) >= 1) {
    steps.push({ key: 'otherCapital', label: 'Other capital movements (repurchases, reinvestment, transfers)', amount: otherCapital, sources: binds(S('chShares'), S('chCapital'), S('chContrib'), S('chDist')) });
  }
  // Income less expenses is used when it is net investment income; a statement that prints items between them (a fee waiver, taxes) bridges on net investment income.
  if (present(income) && present(expenses) && (!present(nii) || Math.abs(income - Math.abs(expenses) - nii) < TIE)) {
    steps.push({ key: 'income', label: 'Investment income', amount: income, sources: S('totalInc') });
    steps.push({ key: 'expenses', label: 'Fund expenses', amount: -Math.abs(expenses), sources: S('totalExp') });
  } else {
    steps.push({ key: 'nii', label: 'Net investment income', amount: nii, sources: S('nii') });
  }
  steps.push({ key: 'realized', label: fx != null ? 'Realized gains, before FX' : 'Realized gains and losses', amount: realized, sources: binds(S('realizedTotal'), S('realized'), S('fxRealized')) });
  steps.push({ key: 'unrealized', label: fx != null ? 'Unrealized gains, before FX' : 'Unrealized gains and losses', amount: unrealized, sources: binds(S('netInc'), S('nii'), S('unrealized'), S('fxUnrealized')) });
  if (fx != null) steps.push({ key: 'fx', label: 'FX impact', amount: fx, sources: binds(S('fxRealized'), S('fxUnrealized')) });
  const bridgeClosing = present(opening) && steps.some((step) => present(step.amount))
    ? opening + sum(steps.map((step) => step.amount))
    : null;
  const bridge: NavBridge = {
    opening, steps, closing: bridgeClosing, reported,
    difference: present(bridgeClosing) && present(reported) ? bridgeClosing - reported : null,
    openingSources, reportedSources,
  };
  add('NAV_BRIDGE', 'bridge', 'NAV bridge: opening + capital + income − expenses + gains + FX = closing', 'NAV summary',
    bridgeClosing, reported, binds(openingSources, ...steps.map((step) => step.sources)), reportedSources);

  /* 2. Trial balance ------------------------------------------------------ */
  const tbLines = pack.trialBalance.map((line) => ({ ...line, net: tbBalance(line) }));
  let trialBalance: PackReview['trialBalance'] = null;
  if (tbLines.length) {
    const byClass: Record<AccountClass, number> = { ASSET: 0, LIABILITY: 0, CAPITAL: 0, INCOME: 0, EXPENSE: 0, GAIN_LOSS: 0 };
    let unclassified = 0;
    for (const line of tbLines) {
      if (line.accountClass && line.accountClass in byClass) byClass[line.accountClass] += line.net ?? 0;
      else unclassified += 1;
    }
    const debits = sum(tbLines.map((line) => (present(line.debit) ? line.debit : present(line.net) && line.net > 0 ? line.net : 0)));
    const credits = sum(tbLines.map((line) => (present(line.credit) ? line.credit : present(line.net) && line.net < 0 ? -line.net : 0)));
    trialBalance = { accounts: tbLines.length, debits, credits, byClass, unclassified };
    const tbSources = (cls?: AccountClass) => binds(...tbLines.filter((line) => !cls || line.accountClass === cls).map((line) => bind(line.id, line.name, present(line.balance) ? 'TB_BALANCE' : 'TB_DEBIT', periodEnd)));
    add('TRIAL_BALANCE', 'tbBalances', 'Trial balance: debits equal credits', 'Trial balance', debits, credits, tbSources(), tbSources(), ACCOUNT_TIE * 2);
    add('TRIAL_BALANCE', 'tbAssets', 'Trial balance asset accounts vs total assets', 'Trial balance, balance sheet', byClass.ASSET, A('assets'), tbSources('ASSET'), S('assets'));
    add('TRIAL_BALANCE', 'tbLiabilities', 'Trial balance liability accounts vs total liabilities', 'Trial balance, balance sheet', -byClass.LIABILITY, A('liabilities'), tbSources('LIABILITY'), S('liabilities'));
    // Capital in the ledger is opening capital and this year's movements; with income, expenses and gains it is net assets.
    add('TRIAL_BALANCE', 'tbCapital', 'Trial balance capital, income, expenses and gains vs net assets', 'Trial balance, balance sheet',
      -(byClass.CAPITAL + byClass.INCOME + byClass.EXPENSE + byClass.GAIN_LOSS), A('netAssets'),
      binds(tbSources('CAPITAL'), tbSources('INCOME'), tbSources('EXPENSE'), tbSources('GAIN_LOSS')), S('netAssets'));
    // Income and expense accounts run from the start of the fiscal year. They compare with the statement only when it covers the same span.
    const starts = [...new Set(tbLines.map((line) => line.periodStart).filter((value): value is string => Boolean(value)))];
    const sameSpan = starts.length === 1 && starts[0] > previous && starts[0] <= addDay(previous);
    if (sameSpan) {
      add('TRIAL_BALANCE', 'tbIncome', 'Trial balance income accounts vs total investment income', 'Trial balance, operations', -byClass.INCOME, A('totalInc'), tbSources('INCOME'), S('totalInc'));
      add('TRIAL_BALANCE', 'tbExpenses', 'Trial balance expense accounts vs total expenses', 'Trial balance, operations', byClass.EXPENSE, A('totalExp'), tbSources('EXPENSE'), S('totalExp'));
    }
    // Accounts mapped to a statement line add up to it, line by line.
    const mapped = new Map<string, typeof tbLines>();
    for (const line of tbLines) if (line.navLine) mapped.set(line.navLine, [...(mapped.get(line.navLine) || []), line]);
    if (mapped.size) {
      const off: string[] = [];
      let compared = 0;
      for (const [code, members] of mapped) {
        const statementFigure = A(`code:${code}`);
        if (!present(statementFigure)) continue;
        compared += 1;
        const total = sum(members.map((member) => member.net));
        // Credit balances (liabilities, capital, income) print as positive amounts.
        const signed = Math.abs(total + statementFigure) < Math.abs(total - statementFigure) ? -total : total;
        if (Math.abs(signed - statementFigure) >= TIE) off.push(code);
      }
      if (compared) {
        add('TRIAL_BALANCE', 'tbLines', off.length ? `Trial balance accounts mapped to statement lines: ${plural(off.length, 'line')} off (${listOf(off)})` : `Trial balance accounts mapped to statement lines: ${plural(compared, 'line')} agree`,
          'Trial balance, statements', compared - off.length, compared, tbSources(), tbSources(), 0.5);
      }
    }
  }

  /* 3. Financial statements: the reconciliation checks them; the pack adds the notes. */
  const statementsOnFile = context.statementsWithFigures;
  const notesOnFile = pack.notesIncluded === true;

  /* 4. Capital accounts --------------------------------------------------- */
  const accounts = pack.capitalAccounts;
  let capitalAccounts: PackReview['capitalAccounts'] = null;
  const segments = context.fee.segments;
  const totalCapitalOpening = sum(accounts.map((account) => account.opening));
  const totalCapitalClosing = sum(accounts.map((account) => account.closing));
  const totalCommitment = sum(accounts.map((account) => account.commitment));
  /** An investor's fee: its rate on its share of each part of the period's fee base. */
  const investorFee = (account: PackCapitalAccount): number | null => {
    if (account.isGp && !present(account.feeRatePct)) return null;
    let fee = 0;
    for (const segment of segments) {
      const rate = account.feeRatePct ?? segment.ratePct;
      if (!present(rate)) return null;
      let base: number | null;
      if (segment.basis === 'COMMITMENTS') base = account.commitment;
      else {
        const capital = present(account.opening) && present(account.closing) ? (account.opening + account.closing) / 2 : account.closing;
        const fundCapital = totalCapitalOpening && totalCapitalClosing ? (totalCapitalOpening + totalCapitalClosing) / 2 : totalCapitalClosing;
        base = present(capital) && fundCapital && present(segment.base) ? segment.base * (capital / fundCapital) : null;
      }
      if (!present(base)) return null;
      fee += base * (rate / 100) * segment.share;
    }
    return fee;
  };
  if (accounts.length) {
    const rows = accounts.map((account) => {
      const rolled = rolledCapital(account);
      const feeRecalculated = investorFee(account);
      return {
        id: account.id, name: account.name, isGp: account.isGp, opening: account.opening, contributions: account.contributions,
        distributions: account.distributions, pnl: account.pnl, carry: account.carry, other: account.other, closing: account.closing,
        rolled, difference: present(rolled) && present(account.closing) ? rolled - account.closing : null,
        commitment: account.commitment, unfunded: account.unfunded, ownershipPct: account.ownershipPct,
        feeCharged: account.mgmtFee, feeRecalculated,
      };
    });
    const totals = {
      opening: totalCapitalOpening, contributions: sum(accounts.map((account) => account.contributions)),
      distributions: sum(accounts.map((account) => Math.abs(account.distributions ?? 0))), pnl: sum(accounts.map((account) => account.pnl)),
      carry: sum(accounts.map((account) => account.carry)), closing: totalCapitalClosing, ownershipPct: sum(accounts.map((account) => account.ownershipPct)),
    };
    capitalAccounts = { investors: accounts.length, rows, totals };
    const field = (code: string, list = accounts) => binds(...list.map((account) => bind(account.id, account.name, code, periodEnd)));
    const notRolling = rows.filter((row) => present(row.difference) && Math.abs(row.difference) >= Math.max(ACCOUNT_TIE, Math.abs(row.closing ?? 0) * 1e-5));
    const rollable = rows.filter((row) => present(row.difference));
    if (rollable.length) {
      add('CAPITAL_ACCOUNTS', 'pcapRoll', notRolling.length
        ? `Capital accounts roll forward: ${plural(notRolling.length, 'investor')} do not (${listOf(notRolling.map((row) => row.name))})`
        : `Capital accounts roll forward: all ${plural(rollable.length, 'investor')}`,
      'Capital account summary', rollable.length - notRolling.length, rollable.length,
      field('CAPACCT_CLOSING', accounts.filter((account) => notRolling.some((row) => row.id === account.id))), field('CAPACCT_OPENING'), 0.5);
    }
    add('CAPITAL_ACCOUNTS', 'pcapNav', 'Investors\' closing capital vs net assets', 'Capital accounts, balance sheet', totalCapitalClosing, A('netAssets'), field('CAPACCT_CLOSING'), S('netAssets'));
    add('CAPITAL_ACCOUNTS', 'pcapOpening', 'Investors\' opening capital vs opening net assets', 'Capital accounts, changes in capital', totalCapitalOpening, opening, field('CAPACCT_OPENING'), openingSources);
    if (anyPresent(accounts.map((account) => account.contributions))) {
      add('CAPITAL_ACCOUNTS', 'pcapContrib', 'Investors\' contributions vs contributions in the period', 'Capital accounts, changes in capital', totals.contributions, contributions, field('CAPACCT_CONTRIBUTIONS'), S('chContrib'));
    }
    if (anyPresent(accounts.map((account) => account.distributions))) {
      add('CAPITAL_ACCOUNTS', 'pcapDist', 'Investors\' distributions vs distributions in the period', 'Capital accounts, changes in capital', totals.distributions, present(distributions) ? Math.abs(distributions) : null, field('CAPACCT_DISTRIBUTIONS'), S('chDist'));
    }
    if (anyPresent(accounts.map((account) => account.pnl))) {
      add('CAPITAL_ACCOUNTS', 'pcapPnl', 'Profit and loss allocated, with carry, vs net increase from operations', 'Capital accounts, operations',
        totals.pnl + totals.carry, A('netInc') ?? A('chOps'), binds(field('CAPACCT_PNL'), field('CAPACCT_CARRY')), binds(S('netInc'), S('chOps')));
    }
    if (anyPresent(accounts.map((account) => account.ownershipPct))) {
      add('CAPITAL_ACCOUNTS', 'pcapOwnership', 'Ownership percentages add up to 100%', 'Capital account summary', round2(totals.ownershipPct), 100, field('CAPACCT_OWNERSHIP_PCT'), [], 0.05);
    }
  }

  /* 5. Management fee ----------------------------------------------------- */
  const charged = accounts.length && anyPresent(accounts.map((account) => account.mgmtFee)) ? sum(accounts.map((account) => account.mgmtFee)) : null;
  const feeRows = capitalAccounts?.rows.filter((row) => present(row.feeCharged) && present(row.feeRecalculated)) ?? [];
  const feeOff = feeRows.filter((row) => Math.abs(row.feeCharged! - row.feeRecalculated!) > Math.max(1000, Math.abs(row.feeRecalculated!) * 0.005));
  if (feeRows.length) {
    add('MANAGEMENT_FEE', 'lpFees', feeOff.length
      ? `Each investor's fee recalculated at its rate: ${plural(feeOff.length, 'investor')} off (${listOf(feeOff.map((row) => row.name))})`
      : `Each investor's fee recalculated at its rate: all ${plural(feeRows.length, 'investor')} agree`,
    'Management fee calculation', feeRows.length - feeOff.length, feeRows.length,
    binds(...accounts.filter((account) => feeOff.some((row) => row.id === account.id)).map((account) => bind(account.id, account.name, 'CAPACCT_MGMT_FEE', periodEnd))),
    context.fee.sources, 0.5);
  }
  if (present(charged)) {
    add('MANAGEMENT_FEE', 'feeAllocation', 'Fees charged to investors vs the fund\'s management fee', 'Capital accounts, operations', charged, context.fee.admin,
      binds(...accounts.map((account) => bind(account.id, account.name, 'CAPACCT_MGMT_FEE', periodEnd))), context.fee.sources);
  }
  const stepDown = segments.length > 1 || segments.some((segment, index) => index > 0 && segment.ratePct !== segments[0].ratePct);
  const basisWord: Record<string, string> = { COMMITMENTS: 'commitments', NET_ASSETS: 'net assets', TOTAL_ASSETS: 'total assets', INVESTED_CAPITAL: 'invested capital' };
  const fees: PackReview['fees'] = {
    segments, stepDown, perInvestor: feeRows.length, charged,
    allocation: segments.length
      ? segments.map((segment) => segment.basis === 'COMMITMENTS' ? 'each investor\'s commitment' : `each investor's share of ${basisWord[segment.basis] || segment.basis.toLowerCase()}`).filter((value, index, all) => all.indexOf(value) === index).join(', then ')
      : 'not set',
  };

  /* 6. Carried interest and waterfall ------------------------------------- */
  let waterfall: PackReview['waterfall'] = null;
  if (context.perf.ready) {
    const tiers = waterfallTiers(context.perf);
    const gpAccounts = accounts.filter((account) => account.isGp);
    const gpCarryOnFile = gpAccounts.length && anyPresent(gpAccounts.map((account) => account.carryBalance)) ? sum(gpAccounts.map((account) => account.carryBalance)) : null;
    waterfall = { basis: context.perf.basis, tiers, carry: sum(tiers.map((tier) => tier.gp)), gpCarryOnFile };
    if (present(gpCarryOnFile)) {
      add('CARRIED_INTEREST', 'gpCarry', 'GP carry in its capital account vs carry recalculated on the waterfall', 'Capital accounts, waterfall',
        gpCarryOnFile, waterfall.carry, binds(...gpAccounts.map((account) => bind(account.id, account.name, 'CAPACCT_CARRY_BALANCE', periodEnd))), context.perf.sources);
    }
    const gpCarryMoved = gpAccounts.some((account) => present(account.carry) && account.carry !== 0);
    if (gpCarryMoved) {
      add('CARRIED_INTEREST', 'carryOffsets', 'Carry taken from limited partners equals carry given to the GP', 'Capital account summary',
        sum(accounts.map((account) => account.carry)), 0, binds(...accounts.map((account) => bind(account.id, account.name, 'CAPACCT_CARRY', periodEnd))), [], ACCOUNT_TIE * 2);
    }
  }

  /* 7. Valuation support -------------------------------------------------- */
  let valuation: PackReview['valuation'] = null;
  if (pack.holdings.length) {
    const windowEnd = addDays(periodEnd, Math.max(0, context.lagDays));
    const inPeriod = pack.valuations.filter((item) => item.date > previous && item.date <= windowEnd);
    const latest = new Map<string, PackValuation>();
    for (const item of inPeriod) {
      const held = latest.get(item.positionId);
      if (!held || item.date > held.date) latest.set(item.positionId, item);
    }
    const total = sum(pack.holdings.map((holding) => holding.fairValue));
    const supported = pack.holdings.filter((holding) => latest.has(holding.id));
    const supportedValue = sum(supported.map((holding) => holding.fairValue));
    const thirdParty = sum(pack.holdings.filter((holding) => inPeriod.some((item) => item.positionId === holding.id && item.sourceType === 'THIRD_PARTY')).map((holding) => holding.fairValue));
    const requiredPct = pack.settings.valuationCoveragePct ?? 100;
    const outside = supported.flatMap((holding) => {
      const support = latest.get(holding.id)!;
      const low = present(support.low) ? support.low : null;
      const high = present(support.high) ? support.high : null;
      const off = present(low) && present(high)
        ? holding.fairValue < low - 1 || holding.fairValue > high + 1
        : present(support.fairValue) && Math.abs(holding.fairValue - support.fairValue) > Math.max(TIE, Math.abs(support.fairValue) * 0.01);
      return off ? [{ id: holding.id, name: holding.name, fairValue: holding.fairValue, low, high, concluded: support.fairValue, source: support.sourceType }] : [];
    });
    const unsupported = pack.holdings.filter((holding) => !latest.has(holding.id)).sort((left, right) => right.fairValue - left.fairValue)
      .map((holding) => ({ id: holding.id, name: holding.name, fairValue: holding.fairValue }));
    valuation = {
      total, supported: supportedValue, coveragePct: total ? (supportedValue / total) * 100 : null, requiredPct,
      thirdPartyPct: total ? (thirdParty / total) * 100 : null, unsupported, outside,
    };
    if (pack.valuations.length) {
      const holdingBinds = (list: Array<{ id: string; name: string }>) => binds(...list.map((holding) => bind(holding.id, holding.name, 'MARKET_VALUE', periodEnd)));
      atLeast('VALUATION', 'valuationCoverage', `Investments with valuation support dated in the period (${round2(valuation.coveragePct ?? 0)}% of fair value, ${requiredPct}% required)`,
        'Valuation support, schedule', round2(valuation.coveragePct ?? 0), requiredPct,
        binds(...inPeriod.map((item) => bind(item.id, item.name, 'VALUATION_DATE'))), binds(bind(context.fund.id, context.fund.name, 'FUND_VALUATION_COVERAGE_PCT'), holdingBinds(unsupported.slice(0, 20))));
      const checkedMarks = supported.length;
      add('VALUATION', 'valuationMarks', outside.length
        ? `Marks within the valuation support: ${plural(outside.length, 'position')} outside (${listOf(outside.map((item) => item.name))})`
        : `Marks within the valuation support: all ${plural(checkedMarks, 'position')}`,
      'Valuation support, schedule', checkedMarks - outside.length, checkedMarks,
      holdingBinds(outside), binds(...outside.map((item) => bind(latest.get(item.id)!.id, latest.get(item.id)!.name, 'VALUATION_FAIR_VALUE'))), 0.5);
      if (present(pack.settings.thirdPartyCoveragePct)) {
        atLeast('VALUATION', 'thirdParty', `Investments with a third-party valuation (${round2(valuation.thirdPartyPct ?? 0)}% of fair value, ${pack.settings.thirdPartyCoveragePct}% required)`,
          'Valuation support', round2(valuation.thirdPartyPct ?? 0), pack.settings.thirdPartyCoveragePct,
          binds(...inPeriod.filter((item) => item.sourceType === 'THIRD_PARTY').map((item) => bind(item.id, item.name, 'VALUATION_DATE'))), binds(bind(context.fund.id, context.fund.name, 'FUND_THIRD_PARTY_COVERAGE_PCT')));
      }
    }
  }

  /* 8. Capital calls and distributions ------------------------------------ */
  let capitalActivity: PackReview['capitalActivity'] = null;
  if (pack.activities.length) {
    const calls = pack.activities.filter((item) => item.kind === 'CAPITAL_CALL');
    const paid = pack.activities.filter((item) => item.kind === 'DISTRIBUTION');
    const inPeriod = (item: PackActivity) => item.date > previous && item.date <= periodEnd;
    const outstanding = (item: PackActivity) => (present(item.outstanding) ? item.outstanding : item.status === 'ISSUED' || item.status === 'DECLARED' || item.status === 'SCHEDULED' ? item.amount : 0);
    const settled = (item: PackActivity) => item.amount - outstanding(item);
    const callsByEnd = calls.filter((item) => item.date <= periodEnd);
    const distributionsByEnd = paid.filter((item) => item.date <= periodEnd);
    const pending = calls.filter((item) => item.date > periodEnd && item.status !== 'FUNDED').map((item) => ({ id: item.id, name: item.name, date: item.date, amount: item.amount }));
    capitalActivity = {
      calledInPeriod: sum(calls.filter(inPeriod).map((item) => item.amount)),
      receivedInPeriod: sum(calls.filter(inPeriod).map(settled)),
      callsOutstanding: sum(callsByEnd.map(outstanding)),
      distributionsInPeriod: sum(paid.filter(inPeriod).map((item) => item.amount)),
      paidInPeriod: sum(paid.filter(inPeriod).map(settled)),
      distributionsPayable: sum(distributionsByEnd.map(outstanding)),
      pending,
    };
    const activityBinds = (list: PackActivity[], code = 'ACTIVITY_AMOUNT') => binds(...list.map((item) => bind(item.id, item.name, code)));
    if (calls.length) {
      add('CAPITAL_ACTIVITY', 'callsReceived', 'Calls received in the period vs contributions in the period', 'Call notices, changes in capital',
        capitalActivity.receivedInPeriod, contributions, binds(activityBinds(calls.filter(inPeriod)), activityBinds(calls.filter(inPeriod), 'ACTIVITY_OUTSTANDING')), S('chContrib'));
      const receivable = A('subsRec');
      if (present(receivable) || capitalActivity.callsOutstanding > 0) {
        add('CAPITAL_ACTIVITY', 'callReceivable', 'Calls not yet received vs contributions receivable on the balance sheet', 'Call notices, balance sheet',
          capitalActivity.callsOutstanding, receivable ?? 0, activityBinds(callsByEnd, 'ACTIVITY_OUTSTANDING'), S('subsRec'));
      }
    }
    if (paid.length) {
      const payable = A('distPayable');
      if (present(payable) || capitalActivity.distributionsPayable > 0) {
        add('CAPITAL_ACTIVITY', 'distPayable', 'Distributions declared and not yet paid vs distributions payable', 'Distribution notices, balance sheet',
          capitalActivity.distributionsPayable, payable ?? 0, activityBinds(distributionsByEnd, 'ACTIVITY_OUTSTANDING'), S('distPayable'));
      }
      if (present(A('cfDist'))) {
        add('CAPITAL_ACTIVITY', 'distPaid', 'Distributions paid in the period vs distributions paid in cash flows', 'Distribution notices, cash flows',
          capitalActivity.paidInPeriod, Math.abs(A('cfDist')!), activityBinds(paid.filter(inPeriod)), S('cfDist'));
      }
    }
  }

  /* 9. Commitments and unfunded ------------------------------------------- */
  let commitments: PackReview['commitments'] = null;
  const lpAccounts = accounts.filter((account) => !account.isGp || present(account.commitment));
  if (lpAccounts.some((account) => present(account.commitment)) || pack.commitments.length) {
    const committed = lpAccounts.some((account) => present(account.commitment)) ? totalCommitment : sum(pack.commitments.map((item) => item.amount));
    const contributed = sum(lpAccounts.map((account) => account.contributedItd));
    const unfunded = sum(lpAccounts.map((account) => account.unfunded));
    const pendingCalls = sum((capitalActivity?.pending ?? []).map((item) => item.amount));
    commitments = { investors: lpAccounts.length || pack.commitments.length, committed, contributed, unfunded, pendingCalls };
    const field = (code: string) => binds(...lpAccounts.map((account) => bind(account.id, account.name, code, periodEnd)));
    const fundField = (code: string) => binds(bind(context.fund.id, context.fund.name, code));
    add('COMMITMENTS', 'lpCommitments', 'Investors\' commitments vs the fund\'s total commitments', 'Commitments schedule, fund terms',
      committed, pack.settings.totalCommitments, lpAccounts.length ? field('CAPACCT_COMMITMENT') : binds(...pack.commitments.map((item) => bind(item.id, item.name, 'COMMITMENT_AMOUNT'))), fundField('FUND_TOTAL_COMMITMENTS'));
    if (anyPresent(lpAccounts.map((account) => account.unfunded))) {
      add('COMMITMENTS', 'lpUnfunded', 'Investors\' unfunded commitments vs the fund\'s undrawn commitments', 'Commitments schedule, fund',
        unfunded, pack.settings.undrawnCommitments, field('CAPACCT_UNFUNDED'), fundField('FUND_UNDRAWN_COMMITMENTS'));
      const rollable = lpAccounts.filter((account) => present(account.commitment) && present(account.contributedItd) && present(account.unfunded));
      const off = rollable.filter((account) => Math.abs(account.commitment! - account.contributedItd! - account.unfunded!) >= Math.max(ACCOUNT_TIE, account.commitment! * 1e-5));
      if (rollable.length) {
        add('COMMITMENTS', 'unfundedRoll', off.length
          ? `Commitment less contributions to date equals unfunded: ${plural(off.length, 'investor')} do not (${listOf(off.map((account) => account.name))}). Recallable distributions explain some`
          : `Commitment less contributions to date equals unfunded: all ${plural(rollable.length, 'investor')}`,
        'Commitments schedule', rollable.length - off.length, rollable.length, binds(...off.map((account) => bind(account.id, account.name, 'CAPACCT_UNFUNDED', periodEnd))), [], 0.5);
      }
      if (pendingCalls > 0) {
        atLeast('COMMITMENTS', 'pendingCalls', 'Unfunded commitments cover the calls still to come', 'Commitments schedule, call notices',
          unfunded, pendingCalls, field('CAPACCT_UNFUNDED'), binds(...(capitalActivity?.pending ?? []).map((item) => bind(item.id, item.name, 'ACTIVITY_AMOUNT'))));
      }
    }
    if (lpAccounts.length && pack.commitments.length) {
      const byInvestor = new Map(pack.commitments.map((item) => [item.investorId, item]));
      const compared = lpAccounts.filter((account) => account.investorId && byInvestor.has(account.investorId) && present(account.commitment));
      const off = compared.filter((account) => Math.abs(account.commitment! - byInvestor.get(account.investorId!)!.amount) >= ACCOUNT_TIE);
      if (compared.length) {
        add('COMMITMENTS', 'commitmentRecords', off.length
          ? `Commitments in the capital accounts vs commitment records: ${plural(off.length, 'investor')} differ (${listOf(off.map((account) => account.name))})`
          : `Commitments in the capital accounts vs commitment records: all ${plural(compared.length, 'investor')} agree`,
        'Capital accounts, commitments', compared.length - off.length, compared.length,
        binds(...off.map((account) => bind(account.id, account.name, 'CAPACCT_COMMITMENT', periodEnd))),
        binds(...off.map((account) => { const record = byInvestor.get(account.investorId!)!; return bind(record.id, record.name, 'COMMITMENT_AMOUNT'); })), 0.5);
      }
    }
  }

  /* 10. FX ----------------------------------------------------------------- */
  let fxReview: PackReview['fx'] = null;
  const held = [...new Set(pack.holdings.map((holding) => holding.currency).filter((currency): currency is string => Boolean(currency) && currency !== pack.baseCurrency))];
  if (pack.fx.length || held.length) {
    const tolerance = pack.settings.fxTolerancePct ?? 0.25;
    const currencies = pack.fx.map((item) => {
      const market = marketRateFor(item.currency, pack.baseCurrency, pack.marketRates);
      const differencePct = present(item.rateApplied) && market ? ((item.rateApplied - market.inBase) / market.inBase) * 100 : null;
      const exposureBase = item.exposureBase ?? (present(item.exposureLocal) && present(item.rateApplied) ? item.exposureLocal * item.rateApplied : null);
      return {
        currency: item.currency, applied: item.rateApplied, market: market?.inBase ?? null, differencePct,
        exposureLocal: item.exposureLocal, exposureBase, realized: item.realized, unrealized: item.unrealized,
        hedgeNotional: item.hedgeNotional, hedgedPct: present(item.hedgeNotional) && exposureBase ? (Math.abs(item.hedgeNotional) / Math.abs(exposureBase)) * 100 : null,
        hedgeMtm: item.hedgeMtm, source: item, marketRow: market,
      };
    });
    const heldWithoutRate = held.filter((currency) => !pack.fx.some((item) => item.currency === currency));
    fxReview = { base: pack.baseCurrency, currencies: currencies.map(({ source: _source, marketRow: _marketRow, ...rest }) => rest), heldWithoutRate };
    const fxBinds = (code: string, list = currencies) => binds(...list.map((item) => bind(item.source.id, item.source.name, code, periodEnd)));
    // With no translation on file at all the part is missing, not breaking; once some is, every currency held needs a rate.
    if (held.length && pack.fx.length) {
      add('FX', 'fxCoverage', heldWithoutRate.length
        ? `A rate applied for every currency held: ${listOf(heldWithoutRate)} missing`
        : `A rate applied for every currency held (${listOf(held, 6)})`,
      'FX translation, schedule', held.length - heldWithoutRate.length, held.length, fxBinds('FXT_RATE_APPLIED'), [], 0.5);
    }
    const priced = currencies.filter((item) => present(item.differencePct));
    if (priced.length) {
      const off = priced.filter((item) => Math.abs(item.differencePct!) > tolerance);
      add('FX', 'fxRates', off.length
        ? `Applied FX rates vs market rates at ${periodEnd}: ${listOf(off.map((item) => `${item.currency} ${round2(item.differencePct!)}%`))} outside ${tolerance}%`
        : `Applied FX rates vs market rates at ${periodEnd}: all ${plural(priced.length, 'currency')} within ${tolerance}%`,
      'FX translation, market rates', priced.length - off.length, priced.length,
      fxBinds('FXT_RATE_APPLIED', off), binds(...off.map((item) => (item.marketRow ? bind(item.marketRow.id, item.marketRow.name, 'FX_MARKET_RATE', periodEnd) : null))), 0.5);
    }
    const translated = currencies.filter((item) => present(item.source.exposureLocal) && present(item.source.exposureBase) && present(item.applied));
    if (translated.length) {
      const off = translated.filter((item) => Math.abs(item.source.exposureLocal! * item.applied! - item.source.exposureBase!) > Math.max(ACCOUNT_TIE * 200, Math.abs(item.source.exposureBase!) * 0.001));
      add('FX', 'fxTranslation', off.length
        ? `Exposure translated at the applied rate: ${listOf(off.map((item) => item.currency))} do not`
        : `Exposure translated at the applied rate: all ${plural(translated.length, 'currency')}`,
      'FX translation', translated.length - off.length, translated.length, fxBinds('FXT_EXPOSURE_BASE', off), fxBinds('FXT_RATE_APPLIED', off), 0.5);
    }
    if (anyPresent(currencies.map((item) => item.realized)) || anyPresent(currencies.map((item) => item.unrealized))) {
      const gains = sum(currencies.map((item) => item.realized)) + sum(currencies.map((item) => item.unrealized));
      add('FX', 'fxGains', 'FX gains by currency vs FX gains in operations', 'FX translation, operations',
        gains, fx, binds(fxBinds('FXT_REALIZED'), fxBinds('FXT_UNREALIZED')), binds(S('fxRealized'), S('fxUnrealized')));
    }
    if (anyPresent(currencies.map((item) => item.hedgeMtm)) && (present(A('derivAssets')) || present(A('derivLiabilities')))) {
      add('FX', 'fxHedgeMtm', 'Hedge fair values vs derivative assets less liabilities', 'FX translation, balance sheet',
        sum(currencies.map((item) => item.hedgeMtm)), (A('derivAssets') ?? 0) - Math.abs(A('derivLiabilities') ?? 0), fxBinds('FXT_HEDGE_MTM'), binds(S('derivAssets'), S('derivLiabilities')));
    }
    if (present(pack.settings.fxHedgeTargetPct)) {
      const exposure = sum(currencies.map((item) => (present(item.exposureBase) ? Math.abs(item.exposureBase) : null)));
      const hedged = sum(currencies.map((item) => (present(item.hedgeNotional) ? Math.abs(item.hedgeNotional) : null)));
      const hedgedPct = exposure ? (hedged / exposure) * 100 : null;
      add('FX', 'fxHedge', `Hedged share of foreign currency exposure vs the ${pack.settings.fxHedgeTargetPct}% target`, 'FX translation, fund terms',
        present(hedgedPct) ? round2(hedgedPct) : null, pack.settings.fxHedgeTargetPct, fxBinds('FXT_HEDGE_NOTIONAL'), binds(bind(context.fund.id, context.fund.name, 'FUND_FX_HEDGE_TARGET_PCT')), 10);
    }
  }

  /* the parts, one by one ------------------------------------------------- */
  const reconciliationChecks: Record<PackComponentKey, string[]> = {
    NAV_BRIDGE: ['opening', 'rollNav', 'changesFoot'],
    TRIAL_BALANCE: [],
    FINANCIAL_STATEMENTS: ['balance', 'assetsFoot', 'liabilitiesFoot', 'equityFoot', 'opsCash', 'cashCf', 'schedule', 'sleeves', 'invRoll', 'positions', 'bank', 'facility'],
    CAPITAL_ACCOUNTS: [],
    MANAGEMENT_FEE: [],
    CARRIED_INTEREST: [],
    VALUATION: [],
    CAPITAL_ACTIVITY: ['contribNotice', 'distNotice'],
    COMMITMENTS: [],
    FX: [],
  };
  const itemsOf: Record<PackComponentKey, (item: RecItem) => boolean> = {
    NAV_BRIDGE: () => false,
    TRIAL_BALANCE: () => false,
    FINANCIAL_STATEMENTS: (item) => item.id === 'int',
    CAPITAL_ACCOUNTS: () => false,
    MANAGEMENT_FEE: (item) => item.id === 'fee',
    CARRIED_INTEREST: (item) => item.id === 'perf',
    VALUATION: (item) => item.id.startsWith('pos:') || item.id.startsWith('mark'),
    CAPITAL_ACTIVITY: () => false,
    COMMITMENTS: () => false,
    FX: () => false,
  };
  const onFile: Record<PackComponentKey, { on: boolean; detail: string }> = {
    NAV_BRIDGE: present(bridgeClosing)
      ? { on: true, detail: `Opening ${money(opening!)}, closing ${present(reported) ? money(reported) : 'not reported'}, in ${steps.filter((step) => present(step.amount)).length} steps` }
      : { on: false, detail: 'No opening NAV or no changes in net assets on file for the period' },
    TRIAL_BALANCE: trialBalance
      ? { on: true, detail: `${plural(trialBalance.accounts, 'account')}${trialBalance.unclassified ? `, ${trialBalance.unclassified} without a class` : ''}` }
      : { on: false, detail: `No trial balance lines dated ${periodEnd}` },
    FINANCIAL_STATEMENTS: statementsOnFile.length
      ? { on: true, detail: `${statementsOnFile.join(', ')}${notesOnFile ? ', with the notes' : '. The notes to the financial statements are not on file'}` }
      : { on: false, detail: 'No statement figures on file for the period' },
    CAPITAL_ACCOUNTS: capitalAccounts
      ? { on: true, detail: `${plural(capitalAccounts.investors, 'investor')}, closing capital ${money(capitalAccounts.totals.closing)}` }
      : { on: false, detail: `No capital accounts dated ${periodEnd}` },
    MANAGEMENT_FEE: present(context.fee.admin)
      ? { on: true, detail: `${money(context.fee.admin)} in the statements${fees.perInvestor ? `, ${plural(fees.perInvestor, 'investor')} recalculated` : ''}${stepDown ? ', with a step-down in the period' : ''}` }
      : { on: false, detail: 'No management fee in the statements' },
    CARRIED_INTEREST: waterfall
      ? { on: true, detail: `${money(waterfall.carry)} on the waterfall${present(waterfall.gpCarryOnFile) ? `, ${money(waterfall.gpCarryOnFile)} in the GP's account` : ''}` }
      : { on: false, detail: 'Carry terms or the figures the waterfall needs are not on file' },
    VALUATION: valuation && pack.valuations.length
      ? { on: true, detail: `${round2(valuation.coveragePct ?? 0)}% of ${money(valuation.total)} supported${valuation.unsupported.length ? `, ${plural(valuation.unsupported.length, 'position')} without support` : ''}` }
      : { on: false, detail: pack.holdings.length ? `No valuation support dated in the period for ${plural(pack.holdings.length, 'position')}` : 'No schedule of investments for the period' },
    CAPITAL_ACTIVITY: capitalActivity
      ? { on: true, detail: `${money(capitalActivity.calledInPeriod)} called, ${money(capitalActivity.distributionsInPeriod)} distributed in the period` }
      : { on: false, detail: 'No capital call or distribution notices on file' },
    COMMITMENTS: commitments
      ? { on: true, detail: `${money(commitments.committed)} committed, ${money(commitments.unfunded)} unfunded` }
      : { on: false, detail: 'No investor commitments on file' },
    FX: fxReview && pack.fx.length
      ? { on: true, detail: `${plural(pack.fx.length, 'currency')} translated into ${pack.baseCurrency}` }
      : { on: false, detail: held.length ? `No FX translation for ${listOf(held)}` : 'No foreign currency holdings' },
  };
  const allChecks = [...context.checks, ...checks];
  const required = new Set(pack.required ?? []);
  const components: PackComponent[] = PACK_COMPONENTS.map((part) => {
    const ids = [...reconciliationChecks[part.key], ...checks.filter((check) => owners.get(check.id) === part.key).map((check) => check.id)];
    const mine = allChecks.filter((check) => ids.includes(check.id));
    const openItems = context.items.filter((item) => itemsOf[part.key](item) && !item.decision).map((item) => item.id);
    const file = onFile[part.key];
    const isExpected = expected.has(part.key);
    const needsNotes = part.key === 'FINANCIAL_STATEMENTS' && file.on && !notesOnFile;
    let status: PackStatus;
    if (!file.on) status = isExpected ? 'Not on file' : 'Not expected';
    else if (mine.some((check) => check.result === 'Break')) status = 'Breaks';
    else if (openItems.length) status = 'Open';
    else if (needsNotes || mine.some((check) => check.result === 'Missing')) status = 'Partial';
    else status = 'Ties';
    return {
      key: part.key, label: part.label, owner: part.owner, covers: part.covers,
      expected: isExpected, required: required.has(part.key), onFile: file.on, status, detail: file.detail,
      checks: mine.map((check) => check.id), items: openItems,
    };
  });

  return { components, checks, bridge, trialBalance, capitalAccounts, fees, waterfall, valuation, capitalActivity, commitments, fx: fxReview };
}

/* ---------------------------------------------------------------- dates */

const DAY = 86400000;
function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}
function addDay(date: string): string {
  return addDays(date, 1);
}

/**
 * The management fee terms for each part of a period: one part, or two when
 * the fee steps down inside it. Each part's share of a year is the period's
 * share split by days, so a period with no step-down keeps the months the
 * reconciliation uses.
 */
export function feeSegments(
  terms: { ratePct: number | null; basis: string; stepDownDate: string | null; stepDownRatePct: number | null; stepDownBasis: string | null },
  previous: string,
  periodEnd: string,
  spanMonths: number,
): Array<{ from: string; to: string; share: number; ratePct: number | null; basis: string }> {
  const share = spanMonths / 12;
  const after = { ratePct: terms.stepDownRatePct ?? terms.ratePct, basis: terms.stepDownBasis || terms.basis };
  const step = terms.stepDownDate;
  if (!step || step > periodEnd) return [{ from: previous, to: periodEnd, share, ratePct: terms.ratePct, basis: terms.basis }];
  if (step <= addDay(previous)) return [{ from: previous, to: periodEnd, share, ratePct: after.ratePct, basis: after.basis }];
  const days = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY);
  const total = days(previous, periodEnd);
  const before = days(previous, addDays(step, -1));
  return [
    { from: previous, to: addDays(step, -1), share: share * (before / total), ratePct: terms.ratePct, basis: terms.basis },
    { from: addDays(step, -1), to: periodEnd, share: share * ((total - before) / total), ratePct: after.ratePct, basis: after.basis },
  ];
}
