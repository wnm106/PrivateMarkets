/**
 * Fund reconciliation: the NAV review a fund goes through each close.
 *
 * Everything here is arithmetic on facts the loader read from registered
 * entities (administrator statements, position roll-forward, bank and lender
 * evidence, capital activity, fund terms). Amounts are whole dollars. The
 * statement rows are matched by statement and label, so a different
 * administrator layout still reconciles as long as the wording is standard.
 *
 * A line is one attribute. The fund administrator and the internal book are
 * sources of that attribute, on the NAV statement and on each position.
 * A prior period is the same attribute read at that period's as-of date.
 */

import { buildPack, emptyPack, feeSegments, type PackComponentKey, type PackInput, type PackReview } from './nav-pack';

/** Two dollar figures tie when they are closer than this. */
export const TIE = 5000;
/** A mark this many points from the agent's price goes to the review queue. */
export const MARK_TOLERANCE_PTS = 1;
/** A line's move is drift only when it is at least this many dollars. */
export const DRIFT_FLOOR = 100000;
/** A performance fee this far from the estimate goes to the review queue. */
export const PERF_FEE_FLOOR = 50000;
/** A management fee this share away from the recalculation goes to the review queue. */
export const MGMT_FEE_TOLERANCE = 0.005;
/** A statement line this percent away from our own figure is a source variance, unless the statement sets its own tolerance. */
export const SOURCE_TOLERANCE_PCT = 0.5;

export type Frequency = 'MONTHLY' | 'QUARTERLY';
export type Decision = 'ACCEPT' | 'ADJUST' | 'QUERY';
export type StepState = 'Done' | 'In progress' | 'Blocked' | 'Not started';
export type CloseHealth = 'CERTIFIED' | 'BLOCKED' | 'AWAITING_PACK' | 'IN_REVIEW';

export interface RecLine {
  id: string;
  /** NAV statement that owns the line attribute. */
  entityId: string;
  /** Attribute code on the NAV statement. The fund administrator and the internal amount are sources of this attribute. */
  code: string;
  statement: string;
  role: string;
  label: string;
  indent: number;
  order: number;
  /** Fund administrator source. */
  admin: number | null;
  /** Internal source. */
  shadow: number | null;
  /** Fund administrator amount as of the prior certification. Null when that date has no earlier value. */
  prior: number | null;
  /** Amounts are dollars; a share count or a per-share amount says so. */
  unit?: 'AMOUNT' | 'SHARES' | 'PER_SHARE';
}

export type CapitalModel = 'DRAWDOWN' | 'EVERGREEN';
export type MgmtFeeBasis = 'COMMITMENTS' | 'NET_ASSETS' | 'TOTAL_ASSETS' | 'INVESTED_CAPITAL';
export type PerfFeeBasis = 'WATERFALL' | 'INCOME';

/** A check the report made of itself when it was read: a schedule subtotal, a share-class NAV. */
export interface RecSourceCheck {
  label: string;
  where: string;
  reported: number | null;
  computed: number | null;
  difference: number | null;
  result: 'Ties' | 'Break' | 'Missing';
}

export interface RecRoll {
  begin: number;
  purchases: number;
  repayments: number;
  sales: number;
  pik: number;
  amort: number;
  unrealizedChg: number;
  realized: number;
  interest: number;
  fees: number;
  beginUnrealized: number;
  beginAccrued: number;
  endAccrued: number;
  endFv: number;
  ourAccrued: number | null;
}

/** Activity buckets a cash flow can land in. Balances stay on the position as of the period. */
export type FlowBucket = 'purchases' | 'repayments' | 'sales' | 'pik' | 'amort' | 'unrealizedChg' | 'realized' | 'interest' | 'fees';

/**
 * Cash flow type to roll-forward bucket. Names are matched with spaces and
 * hyphens folded to underscores, so "Principal repayment" and PRINCIPAL_REPAYMENT agree.
 */
export const CASHFLOW_BUCKET: Record<string, FlowBucket> = {
  PURCHASE: 'purchases',
  FUNDING: 'purchases',
  DRAW: 'purchases',
  REPAYMENT: 'repayments',
  PRINCIPAL: 'repayments',
  PRINCIPAL_REPAYMENT: 'repayments',
  SALE: 'sales',
  SALE_COST: 'sales',
  PIK: 'pik',
  PIK_INTEREST: 'pik',
  AMORTIZATION: 'amort',
  ACCRETION: 'amort',
  UNREALIZED: 'unrealizedChg',
  UNREALIZED_CHANGE: 'unrealizedChg',
  REALIZED: 'realized',
  REALIZED_GAIN: 'realized',
  INTEREST: 'interest',
  CASH_INTEREST: 'interest',
  FEE: 'fees',
  FEE_INCOME: 'fees',
};

export function cashflowBucket(type: string): FlowBucket | null {
  const key = type.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return CASHFLOW_BUCKET[key] ?? null;
}

/** Sum of cash flow amounts by roll-forward bucket. Unmapped types are left out. */
export function sumCashflows(flows: Array<{ type: string; amount: number }>): Partial<Record<FlowBucket, number>> {
  const totals: Partial<Record<FlowBucket, number>> = {};
  for (const flow of flows) {
    const bucket = cashflowBucket(flow.type);
    if (!bucket || !Number.isFinite(flow.amount)) continue;
    totals[bucket] = (totals[bucket] ?? 0) + flow.amount;
  }
  return totals;
}

export interface RecPosition {
  id: string;
  code: string;
  name: string;
  group: string;
  mark: number | null;
  agentMark: number | null;
  marketValue: number | null;
  /** Source that supplied the position book (market value and opening balances). */
  bookSource?: string | null;
  priorBookSource?: string | null;
  roll: RecRoll | null;
  /** Position roll-forward entity. Ending balances the administrator reported live here. */
  rollId?: string | null;
  rollName?: string | null;
  /** Cash flows that were summed into each activity bucket, so a figure opens on those flows. */
  flowSources?: Partial<Record<FlowBucket, RecBind[]>>;
  /**
   * Opening balances that were read from this position at the prior certification.
   * Absent means that attribute had no value of its own on that date.
   */
  openingFromHistory?: { fairValue?: boolean; accrued?: boolean; unrealized?: boolean };
}

export interface RecDisposition {
  id: string | null;
  decision: Decision;
  note: string;
}

export interface RecInput {
  fund: {
    id: string;
    code: string;
    name: string;
    strategy: string;
    frequency: Frequency;
    lagDays: number;
    commitments: number | null;
    feeRatePct: number | null;
    prefPct: number | null;
    carryPct: number | null;
    catchUpPct: number | null;
    netIrr: number | null;
    hasFacility: boolean;
    /** Blank is DRAWDOWN: capital calls and distribution notices. */
    capitalModel?: CapitalModel;
    /** Blank is COMMITMENTS. */
    mgmtFeeBasis?: MgmtFeeBasis;
    /** Blank is WATERFALL. */
    perfFeeBasis?: PerfFeeBasis;
    /** From this date the step-down rate and basis apply. */
    mgmtFeeStepDownDate?: string | null;
    mgmtFeeStepDownRatePct?: number | null;
    mgmtFeeStepDownBasis?: MgmtFeeBasis | null;
  };
  periodEnd: string;
  /** Valid date of the prior period. Comparative attributes are read as of this day. */
  priorAsOf?: string | null;
  /** Knowledge cutoff of the prior certification. Current knowledge when that close is not certified. */
  priorKnowledge?: string | null;
  today: string;
  statement: { id: string; label: string; receivedDate: string | null; certified: boolean; tolerancePct: number } | null;
  lines: RecLine[];
  positions: RecPosition[];
  /**
   * The administrator's schedule of investments at the period end: positions
   * whose administrator value is dated the period end. Null when none is loaded.
   */
  adminSchedule?: { total: number; count: number; sources: RecBind[]; cost?: number | null } | null;
  /** The rest of the administrator's NAV pack on file for the period: trial balance, capital accounts, valuation support, FX, notices. */
  pack?: PackInput | null;
  /** The checks the report made of itself, kept on the statement when it was loaded. */
  sourceChecks?: { total: number; ties: number; checks: RecSourceCheck[] } | null;
  evidence: {
    bank: number | null;
    lender: number | null;
    bankEntityId?: string | null;
    bankEntityName?: string | null;
    lenderEntityId?: string | null;
    lenderEntityName?: string | null;
  };
  capital: {
    calls: Array<{ date: string; amount: number; id?: string; name?: string }>;
    callsInPeriod: number;
    distributionsInPeriod: number;
    distributions?: Array<{ id: string; name: string }>;
  };
  close: { id: string; name?: string; signoff: StepState; certifiedAt: string | null; certifiedBy: string | null; certifiedNav: number | null } | null;
  dispositions: Record<string, RecDisposition>;
  driftThresholdPct: number;
}

/* ---------------------------------------------------------------- calendar */

const DAY = 86400000;
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return iso(new Date(utc(date).getTime() + days * DAY));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / DAY);
}

function monthEnd(year: number, month: number): string {
  return iso(new Date(Date.UTC(year, month + 1, 0)));
}

/** Latest period end that is on or before the date, for the fund's close frequency. */
export function periodEndOnOrBefore(frequency: Frequency, date: string): string {
  const d = utc(date);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  for (let guard = 0; guard < 15; guard += 1) {
    const end = monthEnd(year, month);
    const fits = frequency === 'MONTHLY' || month % 3 === 2;
    if (end <= date && fits) return end;
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return date;
}

export function priorPeriodEnd(frequency: Frequency, periodEnd: string): string {
  return periodEndOnOrBefore(frequency, addDays(periodEnd.slice(0, 8) + '01', -1));
}

export interface ValidityWindow {
  validFrom?: string | null;
  validTo?: string | null;
}

function validityDay(value: string | null | undefined): string {
  return String(value || '').slice(0, 10);
}

/**
 * The amount on file at the prior certification. The same open-ended row that
 * also covers the current date is this period's value, not a prior one.
 */
export function comparativeAmount(
  prior: (ValidityWindow & { value: number | null }) | null | undefined,
  current: ValidityWindow | null | undefined,
): number | null {
  if (!prior || prior.value == null || !Number.isFinite(prior.value)) return null;
  const sameWindow = current
    && validityDay(prior.validFrom) === validityDay(current.validFrom)
    && validityDay(prior.validTo) === validityDay(current.validTo);
  return sameWindow ? null : prior.value;
}

export function periodLabel(frequency: Frequency, periodEnd: string): string {
  const d = utc(periodEnd);
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  if (frequency === 'QUARTERLY') return `Q${Math.floor(month / 3) + 1} ${year}`;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Whole months from one period end to the next: March 31 to June 30 is 3. */
export function monthSpan(from: string, to: string): number {
  const start = utc(from);
  const end = utc(to);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

export function periodsPerYear(frequency: Frequency): number {
  return frequency === 'MONTHLY' ? 12 : 4;
}

/**
 * Share of the lag at which each close step is due. 37 days is the quarterly baseline.
 * `rule` says what makes the step done, in the words the page and the assistant show.
 */
const STEPS = [
  { key: 'pack', name: 'Admin pack received and logged', owner: 'Fund accountant', frac: 27 / 37, rule: 'Done when the administrator\'s NAV statement for the period is on file. Every later step waits on it.' },
  { key: 'statements', name: 'Statements tie to each other', owner: 'Fund accountant', frac: 29 / 37, rule: 'Done when every check of the statements against each other, the position book and the NAV pack ties. A check that breaks blocks the step and certification; a check with a figure missing leaves it in progress.' },
  { key: 'evidence', name: 'Cash and capital tied to outside evidence', owner: 'Fund accountant', frac: 29 / 37, rule: 'Done when closing cash ties to the bank statement, contributions and distributions tie to their notices, and the credit facility ties to the lender statement. A break blocks; missing evidence leaves it in progress.' },
  { key: 'roll', name: 'Position roll-forward and P&L attribution', owner: 'Portfolio accountant', frac: 30 / 37, rule: 'Done when the roll-forward reaches the reported ending value and each of its totals ties to its statement line. Any line that breaks blocks the step and certification.' },
  { key: 'val', name: 'Marks and accruals reviewed', owner: 'Valuation analyst', frac: 33 / 37, rule: 'Done when every mark and accrual item in the review queue is accepted or adjusted. An item queried with the administrator blocks it.' },
  { key: 'fees', name: 'Management and performance fees reviewed', owner: 'Fund accountant', frac: 34 / 37, rule: 'Done when every fee item in the review queue is accepted or adjusted. An item queried with the administrator blocks it.' },
  { key: 'drift', name: 'Prior period drift explained', owner: 'Senior reviewer', frac: 34 / 37, rule: 'Done when every unexplained move over the drift threshold is accepted or adjusted in the review queue. An item queried with the administrator blocks it.' },
  { key: 'queries', name: 'Admin queries resolved', owner: 'Fund accountant', frac: 35 / 37, rule: 'Done when no review item is out with the administrator. Each open query blocks certification until it is accepted or adjusted.' },
  { key: 'signoff', name: 'Reviewer sign-off', owner: 'Senior reviewer', frac: 36 / 37, rule: 'Set by the reviewer on this page. It records the review; certification does not wait on it.' },
  { key: 'certify', name: 'NAV certified', owner: 'Fund CFO', frac: 1, rule: 'Done when the NAV is certified with Certify NAV at the top of the page. Certifying is offered once no check breaks, the roll-forward ties and every review item is accepted or adjusted.' },
] as const;

export type StepKey = (typeof STEPS)[number]['key'];

export function targetDate(periodEnd: string, lagDays: number): string {
  return addDays(periodEnd, lagDays);
}

export function stepDue(periodEnd: string, lagDays: number, key: StepKey): string {
  const step = STEPS.find((item) => item.key === key)!;
  return addDays(periodEnd, Math.round(lagDays * step.frac));
}

/* ------------------------------------------------------------------ lines */

type Matcher = { statement: string; label: RegExp; role?: RegExp };

const MATCH = {
  inv: { statement: 'BS_ASSET', label: /^total investments/i },
  cash: { statement: 'BS_ASSET', label: /^cash/i },
  rec: { statement: 'BS_ASSET', label: /interest receivable/i },
  assets: { statement: 'BS_ASSET', label: /^total assets/i },
  fac: { statement: 'BS_LIABILITY', label: /credit facility|subscription (line|facility)/i },
  accFee: { statement: 'BS_LIABILITY', label: /accrued management fee/i },
  accPerf: { statement: 'BS_LIABILITY', label: /accrued (performance|incentive|carried)/i },
  liabilities: { statement: 'BS_LIABILITY', label: /^total liabilities/i },
  contrib: { statement: 'BS_NET', label: /contributions/i },
  cumDist: { statement: 'BS_NET', label: /distributions/i },
  accum: { statement: 'BS_NET', label: /accumulated/i },
  netAssets: { statement: 'BS_NET', label: /^net assets/i, role: /^TOTAL$/i },
  cashInt: { statement: 'OPS', label: /cash interest/i },
  pik: { statement: 'OPS', label: /pik/i },
  feeInc: { statement: 'OPS', label: /fee and other income/i },
  totalInc: { statement: 'OPS', label: /^total investment income/i },
  mgmt: { statement: 'OPS', label: /management fee/i },
  perf: { statement: 'OPS', label: /performance fee|incentive/i },
  totalExp: { statement: 'OPS', label: /^total expenses/i },
  nii: { statement: 'OPS', label: /^net investment income/i },
  realized: { statement: 'OPS', label: /^net realized gain/i },
  unrealized: { statement: 'OPS', label: /^net change in unrealized/i },
  netInc: { statement: 'OPS', label: /^net increase in net assets from operations/i },
  chBegin: { statement: 'CHANGES', label: /beginning of period/i },
  chEnd: { statement: 'CHANGES', label: /end of period/i },
  chOps: { statement: 'CHANGES', label: /^net increase from operations/i },
  chCapital: { statement: 'CHANGES', label: /^net increase from capital transactions/i },
  chContrib: { statement: 'CHANGES', label: /contributions/i },
  chDist: { statement: 'CHANGES', label: /^distributions/i },
  cfNetOps: { statement: 'CASH', label: /^net increase in net assets from operations/i },
  cfPurchases: { statement: 'CASH', label: /purchases of investments/i },
  cfProceeds: { statement: 'CASH', label: /proceeds from sales/i },
  cfRec: { statement: 'CASH', label: /interest receivable/i },
  cfFacility: { statement: 'CASH', label: /credit facility|subscription (line|facility)/i },
  cfNetCash: { statement: 'CASH', label: /^net increase in cash/i },
  cfBegin: { statement: 'CASH', label: /^beginning of period/i },
  cfEnd: { statement: 'CASH', label: /^end of period/i },
  cfPik: { statement: 'CASH', label: /pik/i },
  cfRealized: { statement: 'CASH', label: /realized gain/i },
  cfUnrealized: { statement: 'CASH', label: /unrealized/i },
  cfContrib: { statement: 'CASH', label: /contributions/i },
  cfDist: { statement: 'CASH', label: /distributions/i },
  cfFx: { statement: 'CASH', label: /^effect of exchange rate/i },
  cfAccretion: { statement: 'CASH', label: /accretion/i },
  chTotal: { statement: 'CHANGES', label: /^total increase in net assets/i },
  chShares: { statement: 'CHANGES', label: /^net increase from share transactions/i },
  servicing: { statement: 'OPS', label: /servicing fees/i },
  subsRec: { statement: 'BS_ASSET', label: /(subscriptions|contributions|capital call)s? receivable/i },
  distPayable: { statement: 'BS_LIABILITY', label: /distributions? payable/i },
  derivAssets: { statement: 'BS_ASSET', label: /derivative assets|forward (currency )?contracts?.*asset|unrealized appreciation on (forward|derivative)/i },
  derivLiabilities: { statement: 'BS_LIABILITY', label: /derivative liabilities|forward (currency )?contracts?.*liabilit|unrealized depreciation on (forward|derivative)/i },
  realizedTotal: { statement: 'OPS', label: /^net realized gain/i, role: /^(SUBTOTAL|TOTAL)$/i },
  fxRealized: { statement: 'OPS', label: /realized (gain|loss|gain \(loss\)) on (foreign )?currenc|realized.*foreign exchange/i },
  fxUnrealized: { statement: 'OPS', label: /unrealized.*(on (foreign )?currenc|foreign exchange)/i },
} satisfies Record<string, Matcher>;

type MatchKey = keyof typeof MATCH;

/**
 * The chart line a figure is read from. When several lines fit (a statement
 * that breaks realized gains into investments and currency, and totals them),
 * the first that has a figure is used, so the investments line comes before the
 * total and a report without the breakdown falls back to its total.
 */
function lineFor(lines: RecLine[], key: MatchKey): RecLine | undefined {
  const rule: Matcher = MATCH[key];
  const fits = lines.filter((line) => (
    line.statement === rule.statement
    && rule.label.test(line.label)
    && (!rule.role || rule.role.test(line.role))
    && line.role !== 'HEADER'
    && line.role !== 'NOTE'
  ));
  return fits.find((line) => line.admin != null) ?? fits[0];
}

/** The same row on another statement version: same statement, same normalized label. */
export function lineKey(statement: string, label: string): string {
  return `${statement}|${label.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

const sum = (values: Array<number | null | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const money = (value: number) => (value / 1e6).toFixed(1);
const money3 = (value: number) => (value / 1e6).toFixed(3);
const signed = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value / 1e6).toFixed(1)}`;
const present = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

/* ----------------------------------------------------------------- output */

/** One stored attribute a displayed figure was read from. Right-click opens this. */
export interface RecBind {
  entityId: string;
  entityName: string;
  domainCode: string;
  code: string;
  name: string;
  dataType: string;
  /** Valid date this figure was read at. The assistant sources panel opens on that date. */
  asOfDate?: string;
  /** Knowledge cutoff this figure was read at. */
  knowledgeDate?: string;
  /** Source registry code this figure was read from, when a figure has more than one source. */
  sourceCode?: string;
}

export interface RecCheck {
  id: string;
  group: 'statements' | 'evidence' | 'pack';
  /** The part of the NAV pack a pack check is about. */
  component?: PackComponentKey;
  /** Where a check came from when it is not the reconciliation's own: the report's check of itself. */
  origin?: 'report';
  label: string;
  compared: string;
  a: number | null;
  b: number | null;
  difference: number | null;
  result: 'Ties' | 'Break' | 'Missing';
  aSources: RecBind[];
  bSources: RecBind[];
}

export interface RecItem {
  id: string;
  tab: 'fees' | 'val' | 'drift';
  title: string;
  admin: number;
  ours: number;
  effect: number;
  why: string;
  unit: 'USD' | 'POINTS';
  drift: boolean;
  decision: Decision | null;
  note: string;
  dispositionId: string | null;
  adminSources: RecBind[];
  oursSources: RecBind[];
  effectSources: RecBind[];
  decisionSources: RecBind[];
  noteSources: RecBind[];
}

export interface RecStep {
  key: StepKey;
  name: string;
  owner: string;
  due: string;
  state: StepState;
  detail: string;
  /** What makes the step done, and whether it holds certification. */
  rule: string;
  overdue: boolean;
  /** The tab of the reconciliation page where the step is worked. */
  tab: string | null;
  manual: boolean;
  sources: RecBind[];
  dueSources: RecBind[];
}

export interface RecDriftRow {
  id: string;
  label: string;
  prior: number;
  current: number;
  change: number;
  changePct: number | null;
  explained: string | null;
  flagged: boolean;
  ratio: boolean;
  currentSources: RecBind[];
  priorSources: RecBind[];
}

export interface RecStatementLine {
  id: string;
  label: string;
  role: string;
  indent: number;
  unit?: 'AMOUNT' | 'SHARES' | 'PER_SHARE';
  /** Fund administrator source at this period's as-of. */
  current: number | null;
  /** Internal source at this period's as-of. */
  internal: number | null;
  /** Fund administrator minus internal, when both sources are on file. */
  variance: number | null;
  varianceFlagged: boolean;
  /** Fund administrator source at the prior period's as-of. */
  prior: number | null;
  change: number | null;
  changePct: number | null;
  flagged: boolean;
  currentSources: RecBind[];
  internalSources: RecBind[];
  priorSources: RecBind[];
}

export interface RecReadiness {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
  sources: RecBind[];
}

export interface RecSources {
  navReported: RecBind[];
  navProposed: RecBind[];
  navPrior: RecBind[];
  navChange: RecBind[];
  netIrr: RecBind[];
  target: RecBind[];
  certified: RecBind[];
  health: RecBind[];
  signoff: RecBind[];
  period: RecBind[];
  progress: RecBind[];
}

export interface RecReview {
  fundId: string;
  fundName: string;
  strategy: string;
  frequency: Frequency;
  periodEnd: string;
  /** As-of date of the previous period. Prior figures are the same attributes read on this day. */
  priorPeriodEnd: string;
  periodLabel: string;
  /** Months from the prior period end, or the statement's comparative date, to the period end. */
  spanMonths: number;
  targetDate: string;
  daysToTarget: number;
  health: CloseHealth;
  healthNote: string;
  atRisk: boolean;
  navReported: number | null;
  navProposed: number | null;
  navPrior: number | null;
  navChangePct: number | null;
  netIrr: number | null;
  certified: boolean;
  certifiedAt: string | null;
  canCertify: boolean;
  certifyBlock: string | null;
  checks: RecCheck[];
  breaks: number;
  missing: number;
  steps: RecStep[];
  stepsDone: number;
  items: RecItem[];
  itemsDecided: number;
  queries: number;
  adjustments: number;
  readiness: RecReadiness[];
  readyForRec: boolean;
  statements: Array<{ kind: string; title: string; lines: RecStatementLine[] }>;
  drift: RecDriftRow[];
  roll: RecRollResult;
  marks: Array<{
    id: string; name: string; admin: number; agent: number; difference: number; effect: number; flagged: boolean;
    adminSources: RecBind[]; agentSources: RecBind[]; effectSources: RecBind[];
  }>;
  accruals: Array<{
    id: string; name: string; admin: number; ours: number; difference: number;
    adminSources: RecBind[]; oursSources: RecBind[];
  }>;
  /** The NAV pack, part by part. */
  pack: PackReview;
  mgmtFee: {
    basis: MgmtFeeBasis;
    /** The fee terms for each part of the period: two parts when the fee steps down in it. */
    segments: Array<{ from: string; to: string; share: number; ratePct: number | null; basis: string; base: number | null }>;
    rate: number | null; base: number | null; share: number; recalculated: number | null; admin: number | null;
    difference: number | null; differencePct: number | null; impliedBase: number | null;
    sources: { rate: RecBind[]; base: RecBind[]; recalculated: RecBind[]; admin: RecBind[]; difference: RecBind[]; impliedBase: RecBind[] };
  };
  perfFee: {
    /** WATERFALL: profit is NAV plus distributions less contributions. INCOME: profit is pre-incentive net investment income, and nav is the opening NAV the hurdle is on. */
    basis: PerfFeeBasis;
    contributions: number; distributions: number; nav: number; profit: number; hurdle: number; excess: number; carry: number; admin: number;
    prefPct: number; carryPct: number; catchUpPct: number; netIrr: number | null; ready: boolean;
    sources: {
      contributions: RecBind[]; distributions: RecBind[]; nav: RecBind[]; profit: RecBind[]; hurdle: RecBind[];
      excess: RecBind[]; carry: RecBind[]; admin: RecBind[]; pref: RecBind[]; carryRate: RecBind[]; catchUp: RecBind[]; netIrr: RecBind[];
    };
  };
  closeEntityId: string | null;
  statementId: string | null;
  signoff: StepState;
  sources: RecSources;
}

export interface RecRollResult {
  columns: Array<{ key: string; label: string; group: string }>;
  rows: Array<{ id: string; name: string; group: string; values: number[]; header: boolean; sources: RecBind[][] }>;
  total: number[];
  totalSources: RecBind[][];
  statement: Array<number | null>;
  statementSources: RecBind[][];
  ties: Array<{ line: string; rollforward: number; statement: number | null; result: 'Ties' | 'Break' | 'Missing'; rollSources: RecBind[]; statementSources: RecBind[] }>;
  tied: boolean;
  present: boolean;
}

/* ------------------------------------------------------- attribute binds */

const ATTR: Record<string, [name: string, dataType: string, domainCode: string]> = {
  FUND_CLOSE_FREQUENCY: ['Close Frequency', 'REFERENCE_LIST', 'FUND'],
  FUND_CLOSE_LAG_DAYS: ['Certification Lag (days)', 'INTEGER', 'FUND'],
  FUND_MGMT_FEE_RATE_PCT: ['Management Fee Rate', 'PERCENTAGE', 'FUND'],
  FUND_PREF_RETURN_PCT: ['Preferred Return', 'PERCENTAGE', 'FUND'],
  FUND_CARRY_PCT: ['Carried Interest', 'PERCENTAGE', 'FUND'],
  FUND_CATCH_UP_PCT: ['Catch-up', 'PERCENTAGE', 'FUND'],
  FUND_MGMT_FEE_STEPDOWN_DATE: ['Management Fee Step-down Date', 'DATE', 'FUND'],
  FUND_MGMT_FEE_STEPDOWN_RATE_PCT: ['Management Fee Rate After Step-down', 'PERCENTAGE', 'FUND'],
  FUND_MGMT_FEE_STEPDOWN_BASIS: ['Management Fee Basis After Step-down', 'REFERENCE_LIST', 'FUND'],
  FUND_NAV_PACK_REQUIRED: ['NAV Pack Components Required', 'REFERENCE_LIST', 'FUND'],
  FUND_TOTAL_COMMITMENTS: ['Total Commitments', 'CURRENCY', 'FUND'],
  FUND_NET_IRR: ['Net IRR', 'PERCENTAGE', 'FUND'],
  STATEMENT_RECEIVED_DATE: ['Received', 'DATE', 'NAV_STATEMENT'],
  STATEMENT_PERIOD_END: ['Period End', 'DATE', 'NAV_STATEMENT'],
  STATEMENT_CERTIFIED: ['Certified', 'BOOLEAN', 'NAV_STATEMENT'],
  CLOSE_PERIOD_END: ['Period End', 'DATE', 'FUND_CLOSE'],
  CLOSE_SIGNOFF: ['Reviewer Sign-off', 'REFERENCE_LIST', 'FUND_CLOSE'],
  CLOSE_CERTIFIED_AT: ['Certified On', 'DATE', 'FUND_CLOSE'],
  CLOSE_CERTIFIED_NAV: ['Certified NAV', 'CURRENCY', 'FUND_CLOSE'],
  DISPOSITION_DECISION: ['Decision', 'REFERENCE_LIST', 'REC_DISPOSITION'],
  DISPOSITION_NOTE: ['Note', 'STRING', 'REC_DISPOSITION'],
  DISPOSITION_EFFECT: ['NAV Effect', 'CURRENCY', 'REC_DISPOSITION'],
  EVIDENCE_AMOUNT: ['Balance', 'CURRENCY', 'REC_EVIDENCE'],
  ACTIVITY_AMOUNT: ['Amount', 'CURRENCY', 'CAPITAL_ACTIVITY'],
  POSITION_MARK: ['Administrator Mark', 'NUMBER', 'POSITION'],
  POSITION_AGENT_MARK: ['Agent Mark', 'NUMBER', 'POSITION'],
  MARKET_VALUE: ['Market Value', 'NUMBER', 'POSITION'],
  ACCRUED_CASH_INTEREST_AMOUNT: ['Accrued Cash Interest Amount', 'CURRENCY', 'POSITION'],
  UNREALIZED_GAIN_LOSS: ['Unrealized Gain / Loss', 'CURRENCY', 'POSITION'],
  ROLL_PURCHASES: ['Purchases', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_REPAYMENTS: ['Principal Repayments', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_SALES: ['Sales at Cost', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_PIK: ['PIK Capitalized', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_AMORTIZATION: ['Net Amortization', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_UNREALIZED_CHANGE: ['Change in Unrealized', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_REALIZED_GAIN: ['Realized Gain', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_END_FV: ['Ending Fair Value', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_INTEREST_EARNED: ['Interest Earned', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_FEE_INCOME: ['Fee and Other Income', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_END_ACCRUED: ['Ending Accrued Interest', 'CURRENCY', 'POSITION_ROLL'],
  ROLL_OUR_ACCRUED: ['Our Accrued Interest', 'CURRENCY', 'POSITION_ROLL'],
};

const ROLL_CODE: Partial<Record<keyof RecRoll, string>> = {
  purchases: 'ROLL_PURCHASES',
  repayments: 'ROLL_REPAYMENTS',
  sales: 'ROLL_SALES',
  pik: 'ROLL_PIK',
  amort: 'ROLL_AMORTIZATION',
  unrealizedChg: 'ROLL_UNREALIZED_CHANGE',
  realized: 'ROLL_REALIZED_GAIN',
  interest: 'ROLL_INTEREST_EARNED',
  fees: 'ROLL_FEE_INCOME',
  endAccrued: 'ROLL_END_ACCRUED',
  endFv: 'ROLL_END_FV',
  ourAccrued: 'ROLL_OUR_ACCRUED',
};

const OPENING_CODE = {
  begin: 'MARKET_VALUE',
  beginAccrued: 'ACCRUED_CASH_INTEREST_AMOUNT',
  beginUnrealized: 'UNREALIZED_GAIN_LOSS',
} as const;

/** Columns of the position walk, in the same order as `rollValues`. */
const ROLL_FIELDS: Array<Array<keyof RecRoll>> = [
  ['begin', 'beginAccrued'],
  ['purchases'],
  ['repayments', 'sales', 'realized'],
  ['beginAccrued', 'interest', 'endAccrued', 'fees'],
  ['interest'],
  ['fees'],
  ['pik'],
  ['amort'],
  ['realized'],
  ['unrealizedChg'],
  ['interest', 'pik', 'amort', 'fees', 'realized', 'unrealizedChg'],
  ['begin', 'beginAccrued', 'purchases', 'repayments', 'sales', 'realized', 'interest', 'fees', 'pik', 'amort', 'unrealizedChg', 'endAccrued'],
  ['endFv', 'endAccrued'],
  ['begin', 'beginAccrued', 'purchases', 'repayments', 'sales', 'realized', 'interest', 'fees', 'pik', 'amort', 'unrealizedChg', 'endAccrued', 'endFv'],
];

function attrBind(entityId: string | null | undefined, entityName: string, code: string): RecBind | null {
  if (!entityId) return null;
  const spec = ATTR[code];
  if (!spec) return null;
  return { entityId, entityName: entityName || spec[0], domainCode: spec[2], code, name: spec[0], dataType: spec[1] };
}

function binds(...items: Array<RecBind | null | undefined | RecBind[]>): RecBind[] {
  const out: RecBind[] = [];
  const seen = new Set<string>();
  const add = (bind: RecBind | null | undefined) => {
    if (!bind) return;
    const key = `${bind.entityId}:${bind.code}:${bind.sourceCode || ''}:${bind.asOfDate || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(bind);
  };
  for (const item of items) {
    if (Array.isArray(item)) item.forEach(add);
    else add(item);
  }
  return out;
}

function stackSources(rows: RecBind[][][]): RecBind[][] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length: width }, (_, index) => binds(...rows.map((row) => row[index] || [])));
}

function statementBind(line: RecLine | undefined, sourceCode: string): RecBind | null {
  if (!line?.entityId || !line.code) return null;
  return {
    entityId: line.entityId,
    entityName: line.label,
    domainCode: 'NAV_STATEMENT',
    code: line.code,
    name: line.label,
    dataType: 'CURRENCY',
    sourceCode,
  };
}

function adminBind(line: RecLine | undefined): RecBind | null {
  return statementBind(line, 'FUND_ADMIN');
}

function internalBind(line: RecLine | undefined): RecBind | null {
  return statementBind(line, 'INTERNAL');
}

function dated(bind: RecBind | null, asOf: string | null | undefined, knowledge: string | null | undefined): RecBind | null {
  if (!bind) return null;
  if (!asOf && !knowledge) return bind;
  return { ...bind, asOfDate: asOf || undefined, knowledgeDate: knowledge || undefined };
}

function priorBind(line: RecLine | undefined, asOf: string | null | undefined, knowledge: string | null | undefined): RecBind | null {
  if (!line?.code || line.prior == null) return null;
  return dated(adminBind(line), asOf, knowledge);
}

function rollBind(position: RecPosition, code: string): RecBind | null {
  if (!position.rollId) return null;
  return attrBind(position.rollId, position.rollName || position.name, code);
}

function openingBind(
  position: RecPosition,
  field: keyof typeof OPENING_CODE,
  asOf: string | null | undefined,
  knowledge: string | null | undefined,
): RecBind | null {
  const history = position.openingFromHistory;
  const recorded = field === 'begin' ? history?.fairValue : field === 'beginAccrued' ? history?.accrued : history?.unrealized;
  if (!recorded) return null;
  const bind = dated(attrBind(position.id, position.name, OPENING_CODE[field]), asOf, knowledge);
  return bind && position.priorBookSource ? { ...bind, sourceCode: position.priorBookSource } : bind;
}

function rollAmountBind(
  position: RecPosition,
  field: keyof RecRoll,
  asOf: string | null | undefined,
  knowledge: string | null | undefined,
): RecBind | RecBind[] | null {
  if (field === 'begin' || field === 'beginAccrued' || field === 'beginUnrealized') return openingBind(position, field, asOf, knowledge);
  const flows = position.flowSources?.[field as FlowBucket];
  if (flows?.length) return flows;
  const code = ROLL_CODE[field];
  return code ? rollBind(position, code) : null;
}

function rollColumnSources(position: RecPosition, asOf: string | null | undefined, knowledge: string | null | undefined): RecBind[][] {
  return ROLL_FIELDS.map((fields) => binds(...fields.map((field) => rollAmountBind(position, field, asOf, knowledge))));
}

/* ----------------------------------------------------------------- engine */

function rollColumns(): RecRollResult['columns'] {
  return [
    { key: 'open', label: 'Beginning value', group: 'Opening' },
    { key: 'purchases', label: 'Purchases', group: 'Cash flows' },
    { key: 'proceeds', label: 'Repayments and sales', group: 'Cash flows' },
    { key: 'received', label: 'Interest and fees received', group: 'Cash flows' },
    { key: 'interest', label: 'Interest', group: 'P&L' },
    { key: 'fees', label: 'Fees and other', group: 'P&L' },
    { key: 'pik', label: 'PIK', group: 'P&L' },
    { key: 'amort', label: 'Amortization', group: 'P&L' },
    { key: 'realized', label: 'Realized', group: 'P&L' },
    { key: 'unrealized', label: 'Unrealized', group: 'P&L' },
    { key: 'pl', label: 'Total P&L', group: 'P&L' },
    { key: 'work', label: 'Ending value', group: 'Ending' },
    { key: 'reported', label: 'Reported ending', group: 'Ending' },
    { key: 'diff', label: 'Difference', group: 'Ending' },
  ];
}

function rollValues(roll: RecRoll): number[] {
  const open = roll.begin + roll.beginAccrued;
  const proceeds = -(roll.repayments + roll.sales + roll.realized);
  const received = -(roll.beginAccrued + roll.interest - roll.endAccrued + roll.fees);
  const pl = roll.interest + roll.pik + roll.amort + roll.fees + roll.realized + roll.unrealizedChg;
  const work = open + roll.purchases + proceeds + received + pl;
  const reported = roll.endFv + roll.endAccrued;
  return [open, roll.purchases, proceeds, received, roll.interest, roll.fees, roll.pik, roll.amort, roll.realized, roll.unrealizedChg, pl, work, reported, reported - work];
}

function buildRoll(
  positions: RecPosition[],
  lines: RecLine[],
  periodAsOf: string,
  priorAsOf: string | null | undefined,
  priorKnowledge: string | null | undefined,
): RecRollResult {
  const columns = rollColumns();
  const withRoll = positions.filter((item) => item.roll);
  const emptySources = columns.map(() => [] as RecBind[]);
  if (!withRoll.length) {
    return {
      columns, rows: [], total: [], totalSources: emptySources, statement: [], statementSources: emptySources,
      ties: [], tied: false, present: false,
    };
  }
  const groups = [...new Set(withRoll.map((item) => item.group))];
  const rows: RecRollResult['rows'] = [];
  const total = new Array<number>(columns.length).fill(0);
  const bodySources: RecBind[][][] = [];
  for (const group of groups) {
    const members = withRoll.filter((item) => item.group === group);
    const sub = new Array<number>(columns.length).fill(0);
    const body = members.map((item) => {
      const values = rollValues(item.roll!);
      const sources = rollColumnSources(item, priorAsOf, priorKnowledge);
      values.forEach((value, index) => { sub[index] += value; });
      bodySources.push(sources);
      return { id: item.id, name: item.name, group, values, header: false, sources };
    });
    sub.forEach((value, index) => { total[index] += value; });
    rows.push({ id: `group:${group}`, name: group, group, values: sub, header: true, sources: stackSources(body.map((row) => row.sources)) }, ...body);
  }
  const r = (key: MatchKey) => lineFor(lines, key)?.admin ?? null;
  const prior = (key: MatchKey) => lineFor(lines, key)?.prior ?? null;
  const lineBind = (key: MatchKey) => dated(adminBind(lineFor(lines, key)), periodAsOf, null);
  const priorLine = (key: MatchKey) => priorBind(lineFor(lines, key), priorAsOf, priorKnowledge);
  const inv = r('inv');
  const priorInv = prior('inv');
  const recNow = r('rec');
  const recPrior = prior('rec');
  const interest = r('cashInt');
  const fees = r('feeInc');
  const purchases = r('cfPurchases');
  const proceeds = r('cfProceeds');
  const recChange = r('cfRec');
  const pik = r('pik');
  const realized = r('realized');
  const unrealized = r('unrealized');
  const open = present(priorInv) && present(recPrior) ? priorInv + recPrior : null;
  const received = present(interest) && present(fees) && present(recChange) ? -(interest + fees + recChange) : null;
  const pl = present(interest) && present(fees) && present(pik) && present(realized) && present(unrealized)
    ? interest + fees + pik + realized + unrealized : null;
  const ending = present(inv) && present(recNow) ? inv + recNow : null;
  const statement: Array<number | null> = [
    open,
    present(purchases) ? -purchases : null,
    present(proceeds) ? -proceeds : null,
    received,
    interest,
    fees,
    pik,
    0,
    realized,
    unrealized,
    pl,
    ending,
    ending,
    null,
  ];
  const statementSources: RecBind[][] = [
    binds(priorLine('inv'), priorLine('rec')),
    binds(lineBind('cfPurchases')),
    binds(lineBind('cfProceeds')),
    binds(lineBind('cashInt'), lineBind('feeInc'), lineBind('cfRec')),
    binds(lineBind('cashInt')),
    binds(lineBind('feeInc')),
    binds(lineBind('pik')),
    [],
    binds(lineBind('realized')),
    binds(lineBind('unrealized')),
    binds(lineBind('cashInt'), lineBind('feeInc'), lineBind('pik'), lineBind('realized'), lineBind('unrealized')),
    binds(lineBind('inv'), lineBind('rec')),
    binds(lineBind('inv'), lineBind('rec')),
    [],
  ];
  const sumKey = (key: keyof RecRoll) => sum(withRoll.map((item) => item.roll![key] as number));
  const rollField = (code: string) => binds(...withRoll.map((item) => rollBind(item, code)));
  const activity = (field: FlowBucket, code: string) => {
    const flows = withRoll.flatMap((item) => item.flowSources?.[field] ?? []);
    return flows.length ? binds(flows) : rollField(code);
  };
  const openingField = (field: keyof typeof OPENING_CODE) => binds(...withRoll.map((item) => openingBind(item, field, priorAsOf, priorKnowledge)));
  const tieRows: Array<[string, number, number | null, RecBind[], RecBind[]]> = [
    ['Beginning fair value', sumKey('begin'), priorInv, openingField('begin'), binds(priorLine('inv'))],
    ['Purchases', sumKey('purchases'), present(purchases) ? -purchases : null, activity('purchases', 'ROLL_PURCHASES'), binds(lineBind('cfPurchases'))],
    ['Proceeds from sales and repayments', sumKey('repayments') + sumKey('sales') + sumKey('realized'), proceeds, binds(activity('repayments', 'ROLL_REPAYMENTS'), activity('sales', 'ROLL_SALES'), activity('realized', 'ROLL_REALIZED_GAIN')), binds(lineBind('cfProceeds'))],
    ['Realized gain', sumKey('realized'), realized, activity('realized', 'ROLL_REALIZED_GAIN'), binds(lineBind('realized'))],
    ['PIK capitalized', sumKey('pik'), pik, activity('pik', 'ROLL_PIK'), binds(lineBind('pik'))],
    ['Net change in unrealized', sumKey('unrealizedChg'), unrealized, activity('unrealizedChg', 'ROLL_UNREALIZED_CHANGE'), binds(lineBind('unrealized'))],
    ['Ending fair value', sumKey('endFv'), inv, rollField('ROLL_END_FV'), binds(lineBind('inv'))],
    ['Interest receivable, beginning', sumKey('beginAccrued'), recPrior, openingField('beginAccrued'), binds(priorLine('rec'))],
    ['Interest receivable, ending', sumKey('endAccrued'), recNow, rollField('ROLL_END_ACCRUED'), binds(lineBind('rec'))],
    ['Interest earned (cash pay)', sumKey('interest'), interest, activity('interest', 'ROLL_INTEREST_EARNED'), binds(lineBind('cashInt'))],
    ['Fees and other income', sumKey('fees'), fees, activity('fees', 'ROLL_FEE_INCOME'), binds(lineBind('feeInc'))],
    ['Total investment P&L', total[10], pl, binds(activity('interest', 'ROLL_INTEREST_EARNED'), activity('fees', 'ROLL_FEE_INCOME'), activity('pik', 'ROLL_PIK'), activity('amort', 'ROLL_AMORTIZATION'), activity('realized', 'ROLL_REALIZED_GAIN'), activity('unrealizedChg', 'ROLL_UNREALIZED_CHANGE')), binds(lineBind('cashInt'), lineBind('feeInc'), lineBind('pik'), lineBind('realized'), lineBind('unrealized'))],
  ];
  const ties = tieRows.map(([line, rollforward, stmt, rollSources, statementLineSources]) => ({
    line,
    rollforward,
    statement: stmt,
    result: !present(stmt) ? 'Missing' as const : Math.abs(rollforward - stmt) < TIE ? 'Ties' as const : 'Break' as const,
    rollSources,
    statementSources: statementLineSources,
  }));
  const walk = Math.abs(total[13]) < TIE;
  const tied = walk && ties.every((tie) => tie.result !== 'Break');
  return { columns, rows, total, totalSources: stackSources(bodySources), statement, statementSources, ties, tied, present: true };
}

/** A balance sheet line's move from the prior date, or null when either figure is missing. */
const moved = (line: RecLine | undefined) => (line && line.admin != null && line.prior != null ? line.admin - line.prior : null);

/** Working capital the cash flow statement accounts for, line by line: trade settlements and accrued liabilities. */
const UNSETTLED = /^receivable for investments sold$|^payable for investments purchased$/i;
const ACCRUED = /^(accrued management fee|accrued incentive fee|interest and debt fees payable|distribution and servicing fees payable|accrued expenses and interest|other liabilities)$/i;

function explainDrift(lines: RecLine[], roll: RecRollResult, checksByKey: Record<string, RecCheck>): Array<[RegExp, RegExp | null, (line: RecLine) => string | null]> {
  const a = (key: MatchKey) => lineFor(lines, key)?.admin ?? 0;
  const tie = (id: string) => checksByKey[id]?.result === 'Ties';
  const rollPresent = roll.present;
  const rollTotal = (index: number) => roll.total[index] ?? 0;
  const cash = (label: RegExp) => lines.find((line) => line.statement === 'CASH' && label.test(line.label) && line.admin != null)?.admin ?? null;
  // The cash flow statement's change in a group of working capital lines is the sum of their moves, with assets the other way round.
  const workingCapital = (group: RegExp, flow: RegExp): string | null => {
    const members = lines.filter((line) => line.statement.startsWith('BS_') && group.test(line.label) && line.admin != null && line.prior != null);
    const reported = cash(flow);
    if (!members.length || reported == null) return null;
    const computed = sum(members.map((line) => (line.statement === 'BS_ASSET' ? -1 : 1) * (moved(line) ?? 0)));
    return Math.abs(computed - reported) < TIE ? `Ties to the cash flow statement's change, ${signed(reported)}` : null;
  };
  return [
    [/^BS_/, UNSETTLED, () => workingCapital(UNSETTLED, /^change in unsettled trades$/i)],
    [/^BS_LIABILITY$/, /^accrued incentive fee$|^interest and debt fees payable$|^distribution and servicing fees payable$|^accrued expenses and interest$|^other liabilities$/i, () => workingCapital(ACCRUED, /^increase in accrued liabilities$/i)],
    [/^BS_ASSET$/, /^deferred financing costs$/i, () => (cash(/^other non-cash items$/i) != null ? 'Amortized through the non-cash items of the cash flow statement' : null)],
    [/^BS_(ASSET|LIABILITY)$/, /^derivative (assets|liabilities)$/i, () => (cash(/^unrealized on currency and derivatives$/i) != null || cash(/^settlement of derivatives$/i) != null ? 'Revalued and settled through the cash flow statement' : null)],
    [/^BS_ASSET$/, /^subscriptions receivable$/i, () => (cash(/^capital contributions$/i) != null ? 'Collected in the share issuance proceeds of the cash flow statement' : null)],
    [/^BS_ASSET$/, /^total investments/i, () => `Purchases ${money(-a('cfPurchases'))}, sales at cost (${money(a('cfProceeds') - a('realized'))}), PIK ${money(a('pik'))}, unrealized (${money(-a('unrealized'))})`],
    [/^BS_ASSET$/, /^cash/i, () => `Ties to cash flows, ${signed(a('cfNetCash'))}`],
    [/^BS_ASSET$/, /interest receivable/i, () => `Cash flows, ${a('cfRec') <= 0 ? 'increase' : 'decrease'} of ${money(Math.abs(a('cfRec')))}`],
    [/^BS_LIABILITY$/, /credit facility|subscription/i, () => (a('cfFacility') ? `${a('cfFacility') < 0 ? 'Repayment' : 'Draw'} of ${money(Math.abs(a('cfFacility')))}` : null)],
    [/^BS_LIABILITY$/, /accrued management fee/i, () => 'One period of fee, see Fees'],
    [/^BS_NET$/, /^net assets/i, () => `Contributions ${money(a('chContrib'))}, distributions (${money(Math.abs(a('chDist')))}), operations ${money(a('chOps'))}`],
    [/^BS_NET$/, /contributions/i, () => (tie('contribNotice') ? `Period capital call of ${money(a('chContrib'))}` : null)],
    [/^BS_NET$/, /distributions/i, () => (tie('distNotice') ? `Period distributions of ${money(Math.abs(a('chDist')))}` : null)],
    [/^BS_NET$/, /accumulated/i, () => `Period net increase from operations, ${money(a('netInc'))}`],
    [/^OPS$/, /^net realized gain/i, () => (rollPresent && Math.abs(rollTotal(8) - a('realized')) < TIE ? 'Gains on repayments, ties to roll-forward' : null)],
    [/^OPS$/, /unrealized/i, () => (rollPresent && Math.abs(rollTotal(9) - a('unrealized')) < TIE ? 'Ties to roll-forward' : null)],
    [/^CASH$/, /net increase in net assets from operations/i, () => (tie('opsCash') ? 'Ties to operations' : null)],
    [/^CASH$/, /realized gain/i, () => 'Ties to operations'],
    [/^CASH$/, /unrealized/i, () => 'Ties to operations'],
    [/^CASH$/, /purchases/i, () => (rollPresent ? 'Deployment, ties to roll-forward' : null)],
    [/^CASH$/, /proceeds/i, () => (rollPresent ? 'Repayments, ties to roll-forward' : null)],
    [/^CASH$/, /interest receivable/i, () => 'Ties to balance sheet'],
    [/^CASH$/, /capital contributions/i, () => (tie('contribNotice') ? 'Capital call notices' : null)],
    [/^CASH$/, /distributions/i, () => (tie('distNotice') ? 'Distribution notices' : null)],
    [/^CASH$/, /credit facility/i, () => (tie('facility') ? 'Lender statement' : null)],
    [/^CASH$/, /^(end|beginning) of period$/i, () => 'Prior period closing cash'],
    [/^CASH$/, /^net increase in cash/i, () => 'Operating plus financing'],
    [/^OPS$/, /management fee/i, () => 'See Fees'],
    [/^OPS$/, /cash interest/i, (line) => {
      const priorInvested = lineFor(lines, 'inv')?.prior;
      const invested = a('inv');
      if (!present(priorInvested) || !priorInvested || !line.prior) return null;
      const move = (invested / priorInvested - 1) * 100;
      const own = (line.admin! / line.prior - 1) * 100;
      return Math.abs(own - move) <= 5 ? `Tracks investments, ${own < 0 ? '−' : '+'}${Math.abs(own).toFixed(1)}%` : null;
    }],
  ];
}

/**
 * The chart lines a statement shows: those with a figure from either source or
 * at the prior date, and the headings over them. The chart holds the lines of
 * every kind of fund, so a partnership's pack and a BDC's 10-Q each show only
 * their own.
 */
export function visibleLines(group: RecLine[]): RecLine[] {
  const valued = (line: RecLine) => line.admin != null || line.shadow != null || line.prior != null;
  return group.filter((line, index) => {
    if (line.role !== 'HEADER' && line.role !== 'NOTE') return valued(line);
    for (const next of group.slice(index + 1)) {
      if (next.role === 'HEADER') return false;
      if (next.role !== 'NOTE' && valued(next)) return true;
    }
    return false;
  });
}

export function buildReview(input: RecInput): RecReview {
  const { fund, periodEnd, today, lines } = input;
  const A = (key: MatchKey) => lineFor(lines, key)?.admin ?? null;
  const P = (key: MatchKey) => lineFor(lines, key)?.prior ?? null;
  const hasStatement = input.statement != null && lines.length > 0;
  const closeName = input.close?.name || `${periodLabel(fund.frequency, periodEnd)} close`;
  const fundOf = (code: string) => attrBind(fund.id, fund.name, code);
  const statementOf = (code: string) => (input.statement ? attrBind(input.statement.id, input.statement.label, code) : null);
  const closeOf = (code: string) => (input.close ? attrBind(input.close.id, closeName, code) : null);
  const lineOf = (key: MatchKey) => dated(adminBind(lineFor(lines, key)), periodEnd, null);
  const priorOf = (key: MatchKey) => priorBind(lineFor(lines, key), input.priorAsOf, input.priorKnowledge);
  // The prior date is the statement's comparative date when it has one: a 10-Q compares with the last fiscal year end.
  const previous = input.priorAsOf || priorPeriodEnd(fund.frequency, periodEnd);
  const spanMonths = Math.max(1, monthSpan(previous, periodEnd));
  const capitalModel: CapitalModel = fund.capitalModel === 'EVERGREEN' ? 'EVERGREEN' : 'DRAWDOWN';
  const drawdown = capitalModel === 'DRAWDOWN';
  const callOf = (call: { id?: string; name?: string }) => (call.id ? attrBind(call.id, call.name || 'Capital call', 'ACTIVITY_AMOUNT') : null);
  const periodCallSources = input.capital.calls.filter((call) => call.date > previous && call.date <= periodEnd).map(callOf);
  const callSources = input.capital.calls.filter((call) => call.date <= periodEnd).map(callOf);
  const distributionSources = (input.capital.distributions || []).map((row) => attrBind(row.id, row.name, 'ACTIVITY_AMOUNT'));
  const bankSource = attrBind(input.evidence.bankEntityId, input.evidence.bankEntityName || 'Bank statement', 'EVIDENCE_AMOUNT');
  const lenderSource = attrBind(input.evidence.lenderEntityId, input.evidence.lenderEntityName || 'Lender statement', 'EVIDENCE_AMOUNT');

  /* statement integrity ------------------------------------------------- */
  const checks: RecCheck[] = [];
  const addCheck = (
    id: string, group: RecCheck['group'], label: string, compared: string,
    a: number | null, b: number | null, aSources: RecBind[], bSources: RecBind[], tie = TIE,
  ) => {
    const result: RecCheck['result'] = !present(a) || !present(b) ? 'Missing' : Math.abs(a - b) < tie ? 'Ties' : 'Break';
    checks.push({ id, group, label, compared, a, b, difference: present(a) && present(b) ? a - b : null, result, aSources, bSources });
  };
  const assets = A('assets');
  const liabilities = A('liabilities');
  const navReported = A('netAssets');
  const priorNav = P('netAssets') ?? (lineFor(lines, 'chBegin')?.admin ?? null);
  const priorCertified = P('netAssets');
  const sleeves = lines.filter((line) => line.statement === 'BS_ASSET' && line.role === 'DETAIL' && line.admin != null);
  const priorInv = P('inv');
  const sales = present(A('cfProceeds')) && present(A('realized')) ? A('cfProceeds')! - A('realized')! : null;

  addCheck('balance', 'statements', 'Assets less liabilities equals net assets', 'Balance sheet',
    present(assets) && present(liabilities) ? assets - liabilities : null, navReported,
    binds(lineOf('assets'), lineOf('liabilities')), binds(lineOf('netAssets')));
  // Each part of the balance sheet adds up to its own total. Only lines with a figure count.
  const footing: Array<[string, string, string, MatchKey]> = [
    ['assetsFoot', 'Asset lines add up to total assets', 'BS_ASSET', 'assets'],
    ['liabilitiesFoot', 'Liability lines add up to total liabilities', 'BS_LIABILITY', 'liabilities'],
    ['equityFoot', 'Capital lines add up to net assets', 'BS_NET', 'netAssets'],
  ];
  for (const [id, label, statement, totalKey] of footing) {
    const total = lineFor(lines, totalKey);
    const parts = lines.filter((line) => line.statement === statement && line !== total && line.admin != null && (line.role === 'LINE' || line.role === 'SUBTOTAL'));
    if (!total || total.admin == null || !parts.length) continue;
    addCheck(id, 'statements', label, 'Balance sheet', sum(parts.map((line) => line.admin)), total.admin,
      binds(...parts.map((line) => dated(adminBind(line), periodEnd, null))), binds(lineOf(totalKey)));
  }
  addCheck('opening', 'statements', `Opening net assets equal NAV at ${previous}`, 'Prior certification',
    A('chBegin'), priorCertified, binds(lineOf('chBegin')), binds(priorOf('netAssets')));
  // A statement that prints its total change rolls on it; one that prints only operations and capital rolls on those.
  if (present(A('chTotal'))) {
    addCheck('rollNav', 'statements', 'Roll-forward: opening + total change = closing', 'Changes in net assets',
      present(A('chBegin')) ? A('chBegin')! + A('chTotal')! : null, A('chEnd'),
      binds(lineOf('chBegin'), lineOf('chTotal')), binds(lineOf('chEnd')));
    // Distributions sit beside share transactions in a BDC's statement, and inside capital transactions in a partnership's.
    const capitalParts = present(A('chShares'))
      ? { value: present(A('chDist')) ? A('chDist')! + A('chShares')! : null, sources: binds(lineOf('chDist'), lineOf('chShares')) }
      : { value: A('chCapital'), sources: binds(lineOf('chCapital')) };
    addCheck('changesFoot', 'statements', 'Total change: operations + distributions and capital', 'Changes in net assets',
      present(A('chOps')) && present(capitalParts.value) ? A('chOps')! + capitalParts.value! : null, A('chTotal'),
      binds(lineOf('chOps'), capitalParts.sources), binds(lineOf('chTotal')));
  } else {
    addCheck('rollNav', 'statements', 'Roll-forward: opening + operations + capital = closing', 'Changes in net assets',
      present(A('chBegin')) && present(A('chOps')) && present(A('chCapital')) ? A('chBegin')! + A('chOps')! + A('chCapital')! : null, A('chEnd'),
      binds(lineOf('chBegin'), lineOf('chOps'), lineOf('chCapital')), binds(lineOf('chEnd')));
  }
  addCheck('opsCash', 'statements', 'Net increase from operations, operations vs cash flows', 'Operations, cash flows',
    A('netInc'), A('cfNetOps'), binds(lineOf('netInc')), binds(lineOf('cfNetOps')));
  if (sleeves.length) {
    addCheck('sleeves', 'statements', 'Strategy sleeves sum to total investments', 'Schedule of investments',
      sum(sleeves.map((line) => line.admin)), A('inv'),
      binds(...sleeves.map((line) => dated(adminBind(line), periodEnd, null))), binds(lineOf('inv')));
  }
  if (input.adminSchedule && input.adminSchedule.count > 0) {
    addCheck('schedule', 'statements', `Schedule of investments (${input.adminSchedule.count} positions) vs investments on the balance sheet`, 'Schedule of investments',
      input.adminSchedule.total, A('inv'), input.adminSchedule.sources, binds(lineOf('inv')),
      Math.max(TIE, input.adminSchedule.count * 500));
  }
  const positionBook = input.positions.filter((item) => item.marketValue != null);
  const positionTotal = positionBook.length ? sum(positionBook.map((item) => item.marketValue)) : null;
  const investmentTie = Math.max(TIE, Math.abs(A('inv') ?? 0) * ((input.statement?.tolerancePct ?? SOURCE_TOLERANCE_PCT) / 100));
  addCheck('positions', 'statements', 'Investments vs our position book', 'Positions',
    A('inv'), positionTotal,
    binds(lineOf('inv')),
    binds(...positionBook.map((item) => {
      const bind = dated(attrBind(item.id, item.name, 'MARKET_VALUE'), periodEnd, null);
      return bind && item.bookSource ? { ...bind, sourceCode: item.bookSource } : bind;
    })),
    investmentTie);
  // Capitalized PIK is the cash flow statement's add-back when it prints one; accretion of discount moves cost too.
  const pikIn = present(A('cfPik')) ? -A('cfPik')! : A('pik');
  const accretion = present(A('cfAccretion')) ? -A('cfAccretion')! : 0;
  addCheck('invRoll', 'statements', present(A('cfAccretion'))
    ? 'Investments: prior + purchases − cost of sales + PIK + accretion + unrealized'
    : 'Investments: prior + purchases − cost of sales + PIK + unrealized', 'Cash flows, operations',
  present(priorInv) && present(A('cfPurchases')) && present(sales) && present(pikIn) && present(A('unrealized'))
    ? priorInv + -A('cfPurchases')! - sales + pikIn + accretion + A('unrealized')! : null,
  A('inv'),
  binds(priorOf('inv'), lineOf('cfPurchases'), lineOf('cfProceeds'), lineOf('realized'), present(A('cfPik')) ? lineOf('cfPik') : lineOf('pik'), lineOf('cfAccretion'), lineOf('unrealized')),
  binds(lineOf('inv')));
  addCheck('cashCf', 'evidence', 'Closing cash, cash flows vs balance sheet', 'Cash flows, balance sheet',
    present(A('cfBegin')) && present(A('cfNetCash')) ? A('cfBegin')! + A('cfNetCash')! + (A('cfFx') ?? 0) : null, A('cash'),
    binds(lineOf('cfBegin'), lineOf('cfNetCash'), lineOf('cfFx')), binds(lineOf('cash')));
  addCheck('bank', 'evidence', 'Closing cash vs bank statement', 'Bank statement', A('cash'), input.evidence.bank,
    binds(lineOf('cash')), binds(bankSource));
  if (drawdown) {
    addCheck('contribNotice', 'evidence', 'Contributions in period vs capital call notices', 'Call notices',
      A('chContrib'), input.capital.callsInPeriod, binds(lineOf('chContrib')), binds(...periodCallSources));
    addCheck('distNotice', 'evidence', 'Distributions in period vs distribution notices', 'Distribution notices',
      present(A('chDist')) ? Math.abs(A('chDist')!) : null, input.capital.distributionsInPeriod,
      binds(lineOf('chDist')), binds(...distributionSources));
  }
  const priorFacility = P('fac');
  addCheck('facility', 'evidence', 'Credit facility: prior less repayment vs lender statement', 'Lender statement',
    present(priorFacility) && present(A('cfFacility')) ? priorFacility + A('cfFacility')! : null, input.evidence.lender,
    binds(priorOf('fac'), lineOf('cfFacility')), binds(lenderSource));
  // The report's own checks: the ones that fail, and the headline totals, each with both figures.
  const sourceBinds = binds(statementOf('STATEMENT_SOURCE_CHECKS'));
  (input.sourceChecks?.checks || []).forEach((item, index) => {
    checks.push({
      id: `report:${index}`, group: 'statements', origin: 'report', label: item.label, compared: item.where,
      a: item.reported, b: item.computed, difference: item.difference, result: item.result,
      aSources: sourceBinds, bSources: sourceBinds,
    });
  });
  const checksByKey = Object.fromEntries(checks.map((check) => [check.id, check]));
  const evidenceChecks = checks.filter((check) => !(check.id === 'facility' && !fund.hasFacility));
  const scoped = checks.filter((check) => evidenceChecks.includes(check));
  let breaks = scoped.filter((check) => check.result === 'Break').length;
  let missing = scoped.filter((check) => check.result === 'Missing').length;

  /* roll-forward ------------------------------------------------------- */
  const roll = buildRoll(input.positions, lines, periodEnd, input.priorAsOf, input.priorKnowledge);

  /* items --------------------------------------------------------------- */
  const decide = (id: string) => input.dispositions[id] ?? null;
  const items: RecItem[] = [];
  const addItem = (item: Omit<RecItem, 'decision' | 'note' | 'dispositionId' | 'decisionSources' | 'noteSources'>) => {
    const disposition = decide(item.id);
    const decisionSources = disposition?.id ? binds(attrBind(disposition.id, item.title, 'DISPOSITION_DECISION')) : [];
    const noteSources = disposition?.id ? binds(attrBind(disposition.id, item.title, 'DISPOSITION_NOTE')) : [];
    const effectSources = disposition?.id ? binds(item.effectSources, attrBind(disposition.id, item.title, 'DISPOSITION_EFFECT')) : item.effectSources;
    items.push({
      ...item,
      effectSources,
      decisionSources,
      noteSources,
      decision: disposition?.decision ?? null,
      note: disposition?.note ?? '',
      dispositionId: disposition?.id ?? null,
    });
  };

  // management fee: the rate on its base for the months the statement covers.
  const share = spanMonths / 12;
  const basisOf = (value: string | null | undefined): MgmtFeeBasis =>
    value === 'NET_ASSETS' || value === 'TOTAL_ASSETS' || value === 'INVESTED_CAPITAL' ? value : 'COMMITMENTS';
  const mgmtFeeBasis: MgmtFeeBasis = basisOf(fund.mgmtFeeBasis);
  const average = (now: number | null, then: number | null) => (present(now) && present(then) ? (now + then) / 2 : now);
  const investedCapital = input.adminSchedule?.cost ?? (input.pack?.holdings.length && input.pack.holdings.some((holding) => present(holding.cost))
    ? sum(input.pack.holdings.map((holding) => holding.cost)) : null);
  const baseFor = (basis: MgmtFeeBasis) => basis === 'NET_ASSETS'
    ? average(navReported, priorNav)
    : basis === 'TOTAL_ASSETS' ? average(assets, P('assets')) : basis === 'INVESTED_CAPITAL' ? investedCapital : fund.commitments;
  const basisLabelOf = (basis: MgmtFeeBasis) => basis === 'NET_ASSETS' ? 'average net assets' : basis === 'TOTAL_ASSETS' ? 'average total assets' : basis === 'INVESTED_CAPITAL' ? 'invested capital' : 'commitments';
  // The fee steps down, usually at the end of the investment period, to a new rate and often a new basis.
  const feeTerms = feeSegments({
    ratePct: fund.feeRatePct, basis: mgmtFeeBasis, stepDownDate: fund.mgmtFeeStepDownDate ?? null,
    stepDownRatePct: fund.mgmtFeeStepDownRatePct ?? null, stepDownBasis: fund.mgmtFeeStepDownBasis ?? null,
  }, previous, periodEnd, spanMonths).map((segment) => ({ ...segment, base: baseFor(basisOf(segment.basis)) }));
  const lastTerms = feeTerms[feeTerms.length - 1];
  const feeBase = feeTerms.length === 1 ? feeTerms[0].base : lastTerms.base;
  const basisLabel = feeTerms.length === 1 ? basisLabelOf(mgmtFeeBasis) : feeTerms.map((segment) => basisLabelOf(basisOf(segment.basis))).join(', then ');
  const feeRate = feeTerms.length === 1 ? feeTerms[0].ratePct : lastTerms.ratePct;
  const mgmtAdmin = A('mgmt') ?? A('accFee');
  const recalculated = feeTerms.every((segment) => present(segment.base) && present(segment.ratePct))
    ? sum(feeTerms.map((segment) => segment.base! * (segment.ratePct! / 100) * segment.share))
    : null;
  const mgmtDiff = present(mgmtAdmin) && present(recalculated) ? mgmtAdmin - recalculated : null;
  const mgmtPct = present(mgmtDiff) && recalculated ? mgmtDiff / recalculated : null;
  const impliedBase = present(mgmtAdmin) && present(feeRate) && feeRate ? mgmtAdmin / share / (feeRate / 100) : null;
  const stepDownNote = feeTerms.length > 1 ? ` The fee steps down on ${addDays(lastTerms.from, 1)} to ${lastTerms.ratePct}% on ${basisLabelOf(basisOf(lastTerms.basis))}; the period is charged at each rate for its days.` : '';
  const rateSource = fundOf('FUND_MGMT_FEE_RATE_PCT');
  const baseSourceOf = (basis: MgmtFeeBasis) => basis === 'NET_ASSETS'
    ? binds(lineOf('netAssets'), priorOf('netAssets'), fundOf('FUND_MGMT_FEE_BASIS'))
    : basis === 'TOTAL_ASSETS' ? binds(lineOf('assets'), priorOf('assets'), fundOf('FUND_MGMT_FEE_BASIS'))
      : basis === 'INVESTED_CAPITAL' ? binds(input.adminSchedule?.sources ?? [], fundOf('FUND_MGMT_FEE_BASIS')) : binds(fundOf('FUND_TOTAL_COMMITMENTS'));
  const baseSource = binds(...feeTerms.map((segment) => baseSourceOf(basisOf(segment.basis))),
    feeTerms.length > 1 ? binds(fundOf('FUND_MGMT_FEE_STEPDOWN_DATE'), fundOf('FUND_MGMT_FEE_STEPDOWN_RATE_PCT'), fundOf('FUND_MGMT_FEE_STEPDOWN_BASIS')) : []);
  const frequencySource = fundOf('FUND_CLOSE_FREQUENCY');
  const mgmtLine = lineFor(lines, 'mgmt') ?? lineFor(lines, 'accFee');
  const mgmtAdminSource = adminBind(mgmtLine);
  const feeOurs = binds(rateSource, baseSource, frequencySource);
  const feeEffect = binds(mgmtAdminSource, rateSource, baseSource);
  if (present(mgmtPct) && Math.abs(mgmtPct) > MGMT_FEE_TOLERANCE) {
    addItem({
      id: 'fee', tab: 'fees', title: 'Management fee accrual', admin: mgmtAdmin!, ours: recalculated!, effect: mgmtAdmin! - recalculated!, unit: 'USD', drift: false,
      why: (feeTerms.length === 1 && mgmtFeeBasis === 'COMMITMENTS'
        ? `Admin implies a fee base of $${money(impliedBase!)}M against $${money(feeBase!)}M commitments. Check for a subsequent close or day-count difference.`
        : `The fee implies a base of $${money(impliedBase!)}M against $${money(feeBase!)}M ${basisLabel} over ${spanMonths} months. The fee is charged on each month's opening balance, so a large flow in the period moves it; ask for the monthly fee calculation.`) + stepDownNote,
      adminSources: binds(mgmtAdminSource), oursSources: feeOurs, effectSources: feeEffect,
    });
  }

  // performance fee: carried interest on a liquidation waterfall, or an incentive fee on income over a hurdle.
  const perfFeeBasis: PerfFeeBasis = fund.perfFeeBasis === 'INCOME' ? 'INCOME' : 'WATERFALL';
  const income = perfFeeBasis === 'INCOME';
  const calls = input.capital.calls.filter((call) => call.date <= periodEnd);
  const contributions = present(A('contrib')) ? A('contrib')! : sum(calls.map((call) => call.amount));
  const distributions = present(A('cumDist')) ? Math.abs(A('cumDist')!) : 0;
  const prefPct = fund.prefPct ?? 0;
  const carryPct = fund.carryPct ?? 0;
  const catchUpPct = fund.catchUpPct ?? 100;
  const perfLineAdmin = A('perf');
  // Pre-incentive net investment income is before the incentive fee and before the class distribution and servicing fees, which those classes bear alone.
  const preIncentive = income && present(A('nii')) ? A('nii')! + (perfLineAdmin ?? 0) + (A('servicing') ?? 0) : null;
  const openingNav = priorNav;
  const hurdle = income
    ? (present(openingNav) ? openingNav * (prefPct / 100) * (spanMonths / 12) : 0)
    : sum(calls.map((call) => call.amount * (prefPct / 100) * (daysBetween(call.date, periodEnd) / 365)));
  const profit = income ? (preIncentive ?? 0) : (navReported ?? 0) + distributions - contributions;
  const excess = Math.max(0, profit - hurdle);
  const carry = Math.max(0, Math.min(excess * (catchUpPct / 100), (carryPct / 100) * profit));
  const perfAdmin = income ? (perfLineAdmin ?? A('accPerf') ?? 0) : (A('accPerf') ?? perfLineAdmin ?? 0);
  const perfReady = present(fund.carryPct) && present(fund.prefPct) && hasStatement && (!income || present(preIncentive));
  const contribSources = present(A('contrib')) ? binds(lineOf('contrib')) : binds(...callSources);
  const distributionLineSources = binds(lineOf('cumDist'));
  const navSources = income ? binds(priorOf('netAssets'), lineOf('chBegin')) : binds(lineOf('netAssets'));
  const prefSource = fundOf('FUND_PREF_RETURN_PCT');
  const carryRateSource = fundOf('FUND_CARRY_PCT');
  const catchUpSource = fundOf('FUND_CATCH_UP_PCT');
  const irrSource = fundOf('FUND_NET_IRR');
  const profitSources = income ? binds(lineOf('nii'), lineOf('perf'), lineOf('servicing')) : binds(navSources, distributionLineSources, contribSources);
  const hurdleSources = income ? binds(navSources, prefSource) : binds(...callSources, prefSource);
  const excessSources = binds(profitSources, hurdleSources);
  const carrySources = binds(excessSources, carryRateSource, catchUpSource, fundOf('FUND_PERF_FEE_BASIS'));
  const perfAdminSource = adminBind(income ? (lineFor(lines, 'perf') ?? lineFor(lines, 'accPerf')) : (lineFor(lines, 'accPerf') ?? lineFor(lines, 'perf')));
  if (perfReady && Math.abs(carry - perfAdmin) > PERF_FEE_FLOOR) {
    addItem({
      id: 'perf', tab: 'fees', title: income ? 'Incentive fee on income' : 'Performance fee accrual', admin: perfAdmin, ours: carry, effect: perfAdmin - carry, unit: 'USD', drift: false,
      why: income
        ? `${carryPct}% of pre-incentive net investment income of $${money(profit)}M, over a hurdle of $${money(hurdle)}M (${prefPct}% a year on opening net assets for ${spanMonths} months) with a ${catchUpPct}% catch-up, gives $${money3(carry)}M against $${money3(perfAdmin)}M in the statements. The fee is worked quarter by quarter on each quarter's opening net assets; ask for the quarterly incentive fee calculation.`
        : perfAdmin === 0
          ? `No incentive accrual in the pack while the hypothetical waterfall implies ${money(carry)}M${fund.netIrr != null ? ` and net IRR is ${fund.netIrr}%` : ''}. Request the hypothetical liquidation waterfall.`
          : 'Administrator accrual differs from the hypothetical liquidation waterfall. Request the waterfall.',
      adminSources: binds(perfAdminSource), oursSources: carrySources, effectSources: binds(perfAdminSource, carrySources),
    });
  }

  // interest receivable
  const accruals = input.positions.filter((item) => item.roll && present(item.roll.ourAccrued))
    .map((item) => ({
      id: item.id,
      name: item.name,
      admin: item.roll!.endAccrued,
      ours: item.roll!.ourAccrued as number,
      difference: item.roll!.endAccrued - (item.roll!.ourAccrued as number),
      adminSources: binds(rollBind(item, 'ROLL_END_ACCRUED')),
      oursSources: binds(rollBind(item, 'ROLL_OUR_ACCRUED')),
    }));
  if (accruals.length) {
    const adminRec = A('rec') ?? sum(accruals.map((row) => row.admin));
    const oursRec = sum(input.positions.filter((item) => item.roll).map((item) => (present(item.roll!.ourAccrued) ? item.roll!.ourAccrued : item.roll!.endAccrued)));
    const adminRecSources = A('rec') != null
      ? binds(lineOf('rec'))
      : binds(...accruals.map((row) => row.adminSources));
    const oursRecSources = binds(...input.positions.filter((item) => item.roll).map((item) => (
      present(item.roll!.ourAccrued) ? rollBind(item, 'ROLL_OUR_ACCRUED') : rollBind(item, 'ROLL_END_ACCRUED')
    )));
    if (Math.abs(adminRec - oursRec) >= TIE) {
      addItem({
        id: 'int', tab: 'val', title: 'Interest receivable', admin: adminRec, ours: oursRec, effect: oursRec - adminRec, unit: 'USD', drift: false,
        why: 'Admin is ' + (adminRec < oursRec ? 'below' : 'above') + ' our loan-level accrual. Request the accrual schedule by position.',
        adminSources: adminRecSources, oursSources: oursRecSources, effectSources: binds(adminRecSources, oursRecSources),
      });
    }
  }

  // marks
  const marks = input.positions.filter((item) => present(item.mark) && present(item.agentMark)).map((item) => {
    const fv = item.roll?.endFv ?? item.marketValue ?? 0;
    const difference = item.mark! - item.agentMark!;
    const effect = item.mark ? fv * (item.agentMark! - item.mark!) / item.mark! : 0;
    const adminSources = binds(attrBind(item.id, item.name, 'POSITION_MARK'));
    const agentSources = binds(attrBind(item.id, item.name, 'POSITION_AGENT_MARK'));
    const valueSource = item.roll ? rollBind(item, 'ROLL_END_FV') : attrBind(item.id, item.name, 'MARKET_VALUE');
    return {
      id: item.id, name: item.name, admin: item.mark!, agent: item.agentMark!, difference, effect,
      flagged: Math.abs(difference) > MARK_TOLERANCE_PTS,
      adminSources, agentSources, effectSources: binds(adminSources, agentSources, valueSource),
    };
  });
  for (const mark of marks.filter((row) => row.flagged)) {
    addItem({
      id: `pos:${mark.id}`, tab: 'val', title: `${mark.name} mark`, admin: mark.admin, ours: mark.agent, effect: mark.effect, unit: 'POINTS', drift: false,
      why: `Admin mark differs from the valuation agent by ${Math.abs(mark.difference).toFixed(1)} points. Effect shown if the agent price is used.`,
      adminSources: mark.adminSources, oursSources: mark.agentSources, effectSources: mark.effectSources,
    });
  }

  // drift
  const explainRules = explainDrift(lines, roll, checksByKey);
  const statementKinds: Array<[string, string, (line: RecLine) => boolean]> = [
    ['BS', 'Statement of assets and liabilities', (line) => line.statement.startsWith('BS_')],
    ['OPS', 'Statement of operations', (line) => line.statement === 'OPS'],
    ['CHANGES', 'Statement of changes in net assets', (line) => line.statement === 'CHANGES'],
    ['CASH', 'Statement of cash flows', (line) => line.statement === 'CASH'],
  ];
  const drift: RecDriftRow[] = [];
  const driftFlag = (change: number, prior: number, explained: string | null, ratio: boolean) => {
    if (explained) return false;
    if (!prior) return false;
    return Math.abs(change / Math.abs(prior)) * 100 > input.driftThresholdPct && (ratio || Math.abs(change) >= DRIFT_FLOOR);
  };
  const statements = statementKinds.map(([kind, title, belongs]) => ({
    kind,
    title,
    lines: visibleLines(lines.filter(belongs).sort((left, right) => left.order - right.order)).map((line) => {
      const current = line.admin;
      const prior = line.prior;
      const comparable = current != null && prior != null && line.role !== 'HEADER' && line.role !== 'NOTE' && kind !== 'CHANGES';
      let explained: string | null = null;
      if (comparable) {
        const rule = explainRules.find(([statement, label]) => statement.test(line.statement) && (!label || label.test(line.label)));
        explained = rule ? rule[2](line) : null;
        if (!explained && line.statement === 'BS_ASSET' && line.role === 'DETAIL' && roll.present) explained = 'Position roll-forward';
        if (!explained && (line.role === 'SUBTOTAL' || line.role === 'TOTAL')) explained = 'Sum of components';
      }
      const change = comparable ? current! - prior! : null;
      const flagged = comparable ? driftFlag(change!, prior!, explained, false) : false;
      const internal = line.shadow;
      const variance = current != null && internal != null ? current - internal : null;
      const base = internal != null && Math.abs(internal) > 1 ? Math.abs(internal) : (current != null ? Math.abs(current) : 0);
      const varianceFlagged = variance != null && base > 1 && Math.abs(variance / base) * 100 > (input.statement?.tolerancePct ?? SOURCE_TOLERANCE_PCT);
      const currentSources = binds(dated(adminBind(line), periodEnd, null));
      const internalSources = internal != null ? binds(dated(internalBind(line), periodEnd, null)) : [];
      const priorSources = binds(priorBind(line, input.priorAsOf, input.priorKnowledge));
      if (comparable) {
        drift.push({
          id: `drift:${lineKey(line.statement, line.label)}`,
          label: `${title.replace('Statement of ', '').replace(/^./, (c) => c.toUpperCase())}: ${line.label}`,
          prior: prior!, current: current!, change: change!,
          changePct: prior ? (change! / Math.abs(prior)) * 100 : null,
          explained, flagged, ratio: false, currentSources, priorSources,
        });
      }
      return {
        id: line.id, label: line.label, role: line.role, indent: line.indent, unit: line.unit ?? 'AMOUNT',
        current, internal, variance, varianceFlagged, prior: line.prior, change,
        changePct: change != null && prior ? (change / Math.abs(prior)) * 100 : null,
        flagged, currentSources, internalSources, priorSources,
      };
    }),
  })).filter((statement) => statement.lines.length > 0);

  // ratio rows
  const ratio = (
    id: string, label: string, prior: number | null, current: number | null,
    currentSources: RecBind[], priorSources: RecBind[], explained: string | null = null,
  ) => {
    if (!present(prior) || !present(current)) return;
    const change = current - prior;
    drift.push({
      id: `drift:ratio:${id}`, label, prior, current, change,
      changePct: prior ? (change / Math.abs(prior)) * 100 : null,
      explained, flagged: driftFlag(change, prior, explained, true), ratio: true, currentSources, priorSources,
    });
  };
  const safe = (n: number | null, d: number | null, scale = 1) => (present(n) && present(d) && d ? (n / d) * scale : null);
  ratio('leverage', 'Debt to net assets (x)', safe(P('fac'), P('netAssets')), safe(A('fac'), A('netAssets')),
    binds(lineOf('fac'), lineOf('netAssets')), binds(priorOf('fac'), priorOf('netAssets')),
    checksByKey.facility?.result === 'Ties' ? 'Facility paydown and new capital' : null);
  const perYear = 12 / spanMonths;
  ratio('yield', 'Cash yield on investments, annualized (%)', safe(P('cashInt'), P('inv'), 100 * perYear), safe(A('cashInt'), A('inv'), 100 * perYear),
    binds(lineOf('cashInt'), lineOf('inv')), binds(priorOf('cashInt'), priorOf('inv')));
  ratio('expense', 'Expense ratio, annualized (%)', safe(P('totalExp'), P('netAssets'), 100 * perYear), safe(A('totalExp'), A('netAssets'), 100 * perYear),
    binds(lineOf('totalExp'), lineOf('netAssets')), binds(priorOf('totalExp'), priorOf('netAssets')));
  if (mgmtFeeBasis === 'COMMITMENTS') {
    ratio('feeRate', 'Management fee on commitments, annualized (%)', safe(P('mgmt') ?? P('accFee'), fund.commitments, 100 * perYear), safe(mgmtAdmin, fund.commitments, 100 * perYear),
      binds(mgmtAdminSource, baseSource), binds(priorBind(mgmtLine, input.priorAsOf, input.priorKnowledge), baseSource));
  }
  for (const row of drift.filter((item) => item.flagged)) {
    addItem({
      id: row.id, tab: 'drift', title: `${row.label.replace(/^[^:]+: /, '')} drift`, admin: row.current, ours: row.prior, effect: 0, unit: 'USD', drift: true,
      why: `${row.changePct == null ? '' : `${row.changePct < 0 ? '−' : '+'}${Math.abs(row.changePct).toFixed(2)}% `}vs prior period with no driver in the pack. Ask the admin for the movement.`,
      adminSources: row.currentSources, oursSources: row.priorSources, effectSources: binds(row.currentSources, row.priorSources),
    });
  }

  const decided = items.filter((item) => item.decision === 'ACCEPT' || item.decision === 'ADJUST');
  const queries = items.filter((item) => item.decision === 'QUERY').length;
  const adjustment = sum(items.filter((item) => item.decision === 'ADJUST').map((item) => item.effect));
  const navProposed = present(navReported) ? navReported + adjustment : null;

  /* the NAV pack, part by part ------------------------------------------ */
  const statementTitles: Record<string, string> = { BS_ASSET: 'Balance sheet', OPS: 'Statement of operations', CHANGES: 'Changes in net assets', CASH: 'Cash flows' };
  const pack = buildPack({
    fund: { id: fund.id, name: fund.name, capitalModel, feeRatePct: fund.feeRatePct, carryPct: fund.carryPct },
    periodEnd, previous, spanMonths, lagDays: fund.lagDays,
    amount: (key) => key.startsWith('code:') ? (lines.find((line) => line.code === key.slice(5))?.admin ?? null) : (key in MATCH ? A(key as MatchKey) : null),
    prior: (key) => (key in MATCH ? P(key as MatchKey) : null),
    lineSources: (key) => key.startsWith('code:')
      ? binds(dated(adminBind(lines.find((line) => line.code === key.slice(5))), periodEnd, null))
      : key in MATCH ? binds(lineOf(key as MatchKey)) : [],
    statementsWithFigures: Object.entries(statementTitles)
      .filter(([statement]) => lines.some((line) => (line.statement === statement || (statement === 'BS_ASSET' && line.statement.startsWith('BS_'))) && line.admin != null))
      .map(([, title]) => title),
    fee: { segments: feeTerms, admin: mgmtAdmin, sources: binds(mgmtAdminSource, feeOurs) },
    perf: {
      basis: perfFeeBasis, ready: perfReady, contributions, distributions, profit, hurdle, excess, carry, admin: perfAdmin,
      carryPct, catchUpPct, sources: binds(carrySources),
    },
    checks: scoped,
    items,
  }, input.pack ?? emptyPack());
  scoped.push(...pack.checks);
  breaks = scoped.filter((check) => check.result === 'Break').length;
  missing = scoped.filter((check) => check.result === 'Missing').length;
  const packExpected = pack.components.filter((part) => part.expected);
  const packMissing = packExpected.filter((part) => !part.onFile);
  const packRequired = pack.components.filter((part) => part.required);

  /* close steps --------------------------------------------------------- */
  const tabState = (tab: RecItem['tab']): [StepState, string] => {
    const group = items.filter((item) => item.tab === tab);
    const done = group.filter((item) => item.decision === 'ACCEPT' || item.decision === 'ADJUST').length;
    const asked = group.filter((item) => item.decision === 'QUERY').length;
    if (!hasStatement) return ['Not started', 'Waiting on admin pack'];
    if (done === group.length) return ['Done', 'No open items'];
    if (asked) return ['Blocked', `${asked} awaiting admin`];
    return [done ? 'In progress' : 'Not started', `${done} of ${group.length} decided`];
  };
  const checkState = (group: RecCheck['group']): [StepState, string] => {
    // A NAV pack check that can be made counts with the statements: a break in one holds certification too.
    const set = scoped.filter((check) => check.group === group || (group === 'statements' && check.group === 'pack' && check.result !== 'Missing'));
    if (!hasStatement) return ['Not started', 'Waiting on admin pack'];
    const bad = set.filter((check) => check.result === 'Break').length;
    const gone = set.filter((check) => check.result === 'Missing').length;
    if (bad) return ['Blocked', `${bad} of ${set.length} checks break`];
    if (gone) return ['In progress', `${gone} of ${set.length} need evidence`];
    return ['Done', `${set.length} of ${set.length} tie`];
  };
  const packDone = hasStatement;
  const certified = Boolean(input.statement?.certified) || Boolean(input.close?.certifiedAt);
  const signoff = input.close?.signoff ?? 'Not started';
  const rollBreaks = roll.ties.filter((tie) => tie.result === 'Break').length + (roll.present && Math.abs(roll.total[13] ?? 0) >= TIE ? 1 : 0);
  const rollState: [StepState, string] = !hasStatement ? ['Not started', 'Waiting on admin pack']
    : !roll.present ? ['Not started', 'No position roll-forward loaded']
      : rollBreaks ? ['Blocked', `${rollBreaks} of ${roll.ties.length + 1} lines break`]
        : ['Done', `${roll.ties.length + 1} of ${roll.ties.length + 1} tie`];
  const statementsState = checkState('statements');
  const evidenceState = checkState('evidence');
  const marksState = tabState('val');
  const feesState = tabState('fees');
  const driftState = tabState('drift');
  const stepState: Record<StepKey, [StepState, string]> = {
    pack: packDone ? ['Done', input.statement?.receivedDate ? `Received ${input.statement.receivedDate}` : 'Received'] : ['Not started', 'Waiting on admin pack'],
    statements: statementsState,
    evidence: evidenceState,
    roll: rollState,
    val: marksState,
    fees: feesState,
    drift: driftState,
    queries: queries ? ['Blocked', `${queries} open with admin`] : ['Done', 'None open'],
    signoff: [signoff, ''],
    certify: certified ? ['Done', input.close?.certifiedAt ?? 'Certified'] : ['Not started', 'Waiting on prior steps'],
  };
  const tabFor: Partial<Record<StepKey, string>> = { pack: 'inputs', statements: 'integrity', evidence: 'integrity', roll: 'roll', val: 'val', fees: 'fees', drift: 'drift', queries: 'breaks' };
  const checkSources = (group: RecCheck['group']) => binds(...scoped.filter((check) => check.group === group).flatMap((check) => [check.aSources, check.bSources]));
  const itemSources = (tab: RecItem['tab']) => binds(...items.filter((item) => item.tab === tab).flatMap((item) => [item.adminSources, item.oursSources, item.effectSources]));
  const dueSources = binds(fundOf('FUND_CLOSE_LAG_DAYS'), statementOf('STATEMENT_PERIOD_END'), closeOf('CLOSE_PERIOD_END'));
  const stepSources: Record<StepKey, RecBind[]> = {
    pack: binds(statementOf('STATEMENT_RECEIVED_DATE')),
    statements: checkSources('statements'),
    evidence: checkSources('evidence'),
    roll: binds(...roll.ties.flatMap((tie) => [tie.rollSources, tie.statementSources]), ...roll.totalSources),
    val: itemSources('val'),
    fees: itemSources('fees'),
    drift: itemSources('drift'),
    queries: binds(...items.filter((item) => item.decision === 'QUERY').flatMap((item) => [item.decisionSources, item.adminSources])),
    signoff: binds(closeOf('CLOSE_SIGNOFF')),
    certify: binds(closeOf('CLOSE_CERTIFIED_AT'), closeOf('CLOSE_CERTIFIED_NAV'), statementOf('STATEMENT_CERTIFIED')),
  };
  const steps: RecStep[] = STEPS.map((step) => {
    const due = stepDue(periodEnd, fund.lagDays, step.key);
    const [state, detail] = stepState[step.key];
    return {
      key: step.key, name: step.name, owner: step.owner, due, state, detail, rule: step.rule,
      overdue: state !== 'Done' && due < today, tab: tabFor[step.key] ?? null, manual: step.key === 'signoff',
      sources: stepSources[step.key], dueSources,
    };
  });
  const stepsDone = steps.filter((step) => step.state === 'Done').length;

  /* readiness: every input the rec needs is on file -------------------- */
  const positionsWithMarks = input.positions.filter((item) => present(item.mark) && present(item.agentMark)).length;
  const readiness: RecReadiness[] = [
    { key: 'statement', label: 'Administrator NAV statement', ok: hasStatement, required: true, detail: hasStatement ? `${lines.length} statement lines` : 'No NAV statement for this period', sources: binds(statementOf('STATEMENT_PERIOD_END'), statementOf('STATEMENT_RECEIVED_DATE')) },
    { key: 'prior', label: 'Prior certification', ok: lines.some((line) => line.prior != null), required: true, detail: lines.some((line) => line.prior != null) ? `${lines.filter((line) => line.prior != null).length} values on file at the prior period end` : 'No earlier value for these statements', sources: binds(...lines.filter((line) => line.prior != null).map((line) => priorBind(line, input.priorAsOf, input.priorKnowledge))) },
    { key: 'marks', label: 'Administrator and agent marks', ok: input.positions.length > 0 && positionsWithMarks === input.positions.length, required: true, detail: input.positions.length ? `${positionsWithMarks} of ${input.positions.length} positions` : 'No positions in our own book for the period', sources: binds(...input.positions.flatMap((item) => [attrBind(item.id, item.name, 'POSITION_MARK'), attrBind(item.id, item.name, 'POSITION_AGENT_MARK')])) },
    { key: 'roll', label: 'Position roll-forward', ok: roll.present, required: true, detail: roll.present ? `${input.positions.filter((item) => item.roll).length} positions` : 'No roll-forward loaded', sources: binds(...input.positions.filter((item) => item.roll).map((item) => rollBind(item, 'ROLL_END_FV'))) },
    { key: 'bank', label: 'Bank cash statement', ok: present(input.evidence.bank), required: true, detail: present(input.evidence.bank) ? 'On file' : 'Not on file', sources: binds(bankSource) },
    { key: 'lender', label: 'Lender statement', ok: present(input.evidence.lender), required: fund.hasFacility, detail: !fund.hasFacility ? 'No credit facility' : present(input.evidence.lender) ? 'On file' : 'Not on file', sources: binds(lenderSource) },
    drawdown
      ? { key: 'notices', label: 'Capital call and distribution notices', ok: input.capital.callsInPeriod > 0 || input.capital.distributionsInPeriod > 0 || (present(A('chContrib')) && A('chContrib') === 0 && A('chDist') === 0), required: true, detail: `${money(input.capital.callsInPeriod)}M called, ${money(input.capital.distributionsInPeriod)}M distributed in period`, sources: binds(...periodCallSources, ...distributionSources) }
      : { key: 'notices', label: 'Capital call and distribution notices', ok: true, required: false, detail: 'Evergreen fund: shares are subscribed and repurchased, so there are no notices to tie', sources: binds(fundOf('FUND_CAPITAL_MODEL')) },
    (() => {
      const needsBase = mgmtFeeBasis === 'COMMITMENTS';
      const ok = present(fund.feeRatePct) && (!needsBase || present(fund.commitments)) && present(fund.carryPct) && present(fund.prefPct);
      const detail = !ok
        ? 'Fee or waterfall terms missing on the fund'
        : income ? `Fee rate on ${basisLabel}, incentive fee rate, hurdle and catch-up` : `Fee rate, ${basisLabel}, preferred return, carry`;
      return { key: 'terms', label: income ? 'Fee and incentive fee terms' : 'Fee and waterfall terms', ok, required: true, detail, sources: binds(rateSource, baseSource, prefSource, carryRateSource, catchUpSource) };
    })(),
    {
      key: 'pack', label: 'NAV pack',
      ok: packRequired.length ? packRequired.every((part) => part.onFile) : packMissing.length === 0,
      required: packRequired.length > 0,
      detail: packMissing.length
        ? `${packExpected.length - packMissing.length} of ${packExpected.length} expected parts on file. Missing: ${packMissing.map((part) => part.label).join(', ')}`
        : `All ${packExpected.length} expected parts on file`,
      sources: binds(fundOf('FUND_NAV_PACK_REQUIRED')),
    },
    ...(input.sourceChecks
      ? [{
        key: 'report', label: 'The report adds up', ok: input.sourceChecks.ties === input.sourceChecks.total, required: false,
        detail: `${input.sourceChecks.ties} of ${input.sourceChecks.total} of the report's own subtotals, totals and share-class checks tie`,
        sources: binds(statementOf('STATEMENT_SOURCE_CHECKS')),
      }]
      : []),
  ];
  const readyForRec = readiness.every((item) => !item.required || item.ok);

  /* certification gate -------------------------------------------------- */
  const openItems = items.length - decided.length - queries;
  const certifyBlock = certified ? null
    : !hasStatement ? 'No administrator pack for this period'
      : breaks ? `${breaks} statement check${breaks === 1 ? '' : 's'} break`
        : rollBreaks ? 'Position roll-forward does not tie'
          : queries ? `${queries} query${queries === 1 ? '' : 's'} open with the admin`
            : openItems ? `${openItems} item${openItems === 1 ? '' : 's'} still open`
              : null;
  const canCertify = !certified && certifyBlock == null;

  /* health -------------------------------------------------------------- */
  const target = targetDate(periodEnd, fund.lagDays);
  const daysToTarget = daysBetween(today, target);
  const overdue = steps.filter((step) => step.overdue).length;
  let health: CloseHealth;
  let healthNote: string;
  if (certified) { health = 'CERTIFIED'; healthNote = `Certified ${input.close?.certifiedAt ?? ''}`.trim(); }
  else if (!hasStatement) { health = 'AWAITING_PACK'; healthNote = today > stepDue(periodEnd, fund.lagDays, 'pack') ? 'Admin pack is late' : 'Waiting on the admin pack'; }
  else if (breaks || rollBreaks || queries) {
    health = 'BLOCKED';
    healthNote = [breaks ? `${breaks} break${breaks === 1 ? '' : 's'}` : '', rollBreaks ? 'roll-forward off' : '', queries ? `${queries} with admin` : ''].filter(Boolean).join(', ');
  } else { health = 'IN_REVIEW'; healthNote = openItems ? `${openItems} item${openItems === 1 ? '' : 's'} to decide` : 'Ready to certify'; }
  const atRisk = health !== 'CERTIFIED' && (overdue > 0 || daysToTarget < 0);
  const navReportedSources = binds(lineOf('netAssets'));
  const navPriorSources = P('netAssets') != null ? binds(priorOf('netAssets')) : binds(lineOf('chBegin'));
  const adjustmentSources = binds(...items.filter((item) => item.decision === 'ADJUST').map((item) => item.effectSources));
  const certifiedSources = binds(closeOf('CLOSE_CERTIFIED_AT'), closeOf('CLOSE_CERTIFIED_NAV'), statementOf('STATEMENT_CERTIFIED'));
  const sources: RecSources = {
    navReported: navReportedSources,
    navProposed: binds(navReportedSources, adjustmentSources, certified ? closeOf('CLOSE_CERTIFIED_NAV') : null),
    navPrior: navPriorSources,
    navChange: binds(navReportedSources, navPriorSources),
    netIrr: binds(irrSource),
    target: dueSources,
    certified: certifiedSources,
    health: certifiedSources.length ? certifiedSources : binds(statementOf('STATEMENT_RECEIVED_DATE'), frequencySource),
    signoff: binds(closeOf('CLOSE_SIGNOFF')),
    period: binds(statementOf('STATEMENT_PERIOD_END'), closeOf('CLOSE_PERIOD_END')),
    progress: binds(closeOf('CLOSE_SIGNOFF'), certifiedSources),
  };

  return {
    fundId: fund.id,
    fundName: fund.name,
    strategy: fund.strategy,
    frequency: fund.frequency,
    periodEnd,
    priorPeriodEnd: previous,
    periodLabel: periodLabel(fund.frequency, periodEnd),
    spanMonths,
    targetDate: target,
    daysToTarget,
    health,
    healthNote,
    atRisk,
    navReported,
    navProposed,
    navPrior: priorNav,
    navChangePct: present(navReported) && priorNav ? (navReported / priorNav - 1) * 100 : null,
    netIrr: fund.netIrr,
    certified,
    certifiedAt: input.close?.certifiedAt ?? null,
    canCertify,
    certifyBlock,
    checks: scoped,
    breaks,
    missing,
    steps,
    stepsDone,
    items,
    itemsDecided: decided.length,
    queries,
    adjustments: items.filter((item) => item.decision === 'ADJUST').length,
    readiness,
    readyForRec,
    statements,
    drift,
    roll,
    marks,
    accruals,
    pack,
    mgmtFee: {
      basis: mgmtFeeBasis,
      segments: feeTerms,
      rate: feeRate, base: feeBase, share, recalculated, admin: mgmtAdmin, difference: mgmtDiff,
      differencePct: present(mgmtPct) ? mgmtPct * 100 : null, impliedBase,
      sources: { rate: binds(rateSource), base: baseSource, recalculated: feeOurs, admin: binds(mgmtAdminSource), difference: feeEffect, impliedBase: binds(mgmtAdminSource, rateSource) },
    },
    perfFee: {
      basis: perfFeeBasis,
      contributions, distributions, nav: (income ? openingNav : navReported) ?? 0, profit, hurdle, excess, carry, admin: perfAdmin,
      prefPct, carryPct, catchUpPct, netIrr: fund.netIrr, ready: perfReady,
      sources: {
        contributions: contribSources, distributions: distributionLineSources, nav: navSources, profit: profitSources,
        hurdle: hurdleSources, excess: excessSources, carry: carrySources, admin: binds(perfAdminSource),
        pref: binds(prefSource), carryRate: binds(carryRateSource), catchUp: binds(catchUpSource), netIrr: binds(irrSource),
      },
    },
    closeEntityId: input.close?.id ?? null,
    statementId: input.statement?.id ?? null,
    signoff,
    sources,
  };
}

