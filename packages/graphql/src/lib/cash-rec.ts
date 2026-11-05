/**
 * Cash reconciliation: positional cash flows against the fund's bank transactions.
 *
 * Rules run in priority order. The first rule that fits a bank transaction wins,
 * and each cash flow is used once. Several cash flows may pair to one bank
 * transaction. The tie-out is positional cash plus position adjustments against
 * bank activity plus bank adjustments.
 */

export type CashRuleKind =
  | 'EXACT'
  | 'DATE_DELAY'
  | 'DOLLAR_VARIANCE'
  | 'DATE_VARIANCE'
  | 'MULTI_POSITION'
  | 'MULTI'
  | 'MANUAL';

export type CashStatus = 'OPEN' | 'PROPOSED' | 'APPROVED';
export type AdjustmentSide = 'POSITION' | 'BANK';

export interface CashRule {
  id: string;
  kind: CashRuleKind;
  name: string;
  priority: number;
  enabled: boolean;
  /** Business days the bank date may differ from the cash flow date. */
  dateDays: number;
  /** Absolute dollar tolerance. Exact-amount rules still match to the cent when this is smaller. */
  amountTolerance: number;
  maxItems: number;
  persisted: boolean;
}

export interface CashAccount {
  id: string;
  code: string;
  name: string;
  bankName: string;
  accountNumber: string;
}

export interface CashFlowFact {
  id: string;
  code: string;
  name: string;
  positionId: string;
  positionName: string;
  type: string;
  date: string;
  /** Signed dollars. Money leaving the fund is negative. */
  amount: number;
}

export interface BankTxnFact {
  id: string;
  code: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  counterparty: string;
  reference: string;
}

export interface LockedMatch {
  id: string;
  kind: CashRuleKind;
  bankTxnId: string;
  flowIds: string[];
}

export interface CashAdjustment {
  id: string;
  amount: number;
  side: AdjustmentSide;
  reason: string;
  status: string;
}

export interface CashRecInput {
  fundId: string;
  fundCode: string;
  fundName: string;
  /** The fund's client. New matches, rules, and adjustments are saved to it. */
  clientId: string;
  periodEnd: string;
  priorPeriodEnd: string;
  accounts: CashAccount[];
  flows: CashFlowFact[];
  transactions: BankTxnFact[];
  rules: CashRule[];
  adjustments: CashAdjustment[];
  locked: LockedMatch[];
}

export interface CashMatchRow {
  id: string;
  kind: CashRuleKind;
  ruleId: string | null;
  ruleName: string;
  bankTxnId: string;
  flowIds: string[];
  bankAmount: number;
  flowAmount: number;
  variance: number;
  confidence: number;
  status: 'PROPOSED' | 'APPROVED';
}

export interface CashFlowRow extends CashFlowFact {
  status: CashStatus;
  matchId: string | null;
  bankTxnId: string | null;
}

export interface BankTxnRow extends BankTxnFact {
  accountName: string;
  status: CashStatus;
  matchId: string | null;
  ruleKind: CashRuleKind | null;
  ruleName: string | null;
  matchedAmount: number | null;
  variance: number | null;
  flowIds: string[];
}

export interface CashRecSummary {
  openFlowCount: number;
  openFlowAmount: number;
  openTxnCount: number;
  openTxnAmount: number;
  matchCount: number;
  proposedCount: number;
  approvedCount: number;
  matchedFlowAmount: number;
  matchedBankAmount: number;
  positionTotal: number;
  bankTotal: number;
  positionAdjustments: number;
  bankAdjustments: number;
  positionTied: number;
  bankTied: number;
  residual: number;
  tied: boolean;
}

export interface CashRec extends CashRecInput {
  flows: CashFlowRow[];
  transactions: BankTxnRow[];
  matches: CashMatchRow[];
  summary: CashRecSummary;
}

const CENT = 0.01;

const CASH_OUT = new Set([
  'PURCHASE', 'FUNDING', 'DRAW', 'CAPITAL_CALL', 'EXPENSE', 'LEVERAGE', 'LEVERAGE_PAYMENT',
]);

/** Valuation and non-cash accruals. They stay on the roll-forward and off the bank rec. */
const NON_CASH = new Set([
  'PIK', 'PIK_INTEREST', 'AMORTIZATION', 'ACCRETION', 'UNREALIZED', 'UNREALIZED_CHANGE', 'REALIZED', 'REALIZED_GAIN',
]);

export const CASH_RULE_LABEL: Record<CashRuleKind, string> = {
  EXACT: 'Exact date and amount',
  DATE_DELAY: 'Exact amount, date delay',
  DOLLAR_VARIANCE: 'Dollar variance',
  DATE_VARIANCE: 'Date variance',
  MULTI_POSITION: 'Several cash flows, one position',
  MULTI: 'Several cash flows, one bank transaction',
  MANUAL: 'Manual',
};

const CONFIDENCE: Record<CashRuleKind, number> = {
  EXACT: 100,
  DATE_DELAY: 90,
  MULTI_POSITION: 85,
  DATE_VARIANCE: 80,
  MULTI: 75,
  DOLLAR_VARIANCE: 70,
  MANUAL: 100,
};

export const DEFAULT_CASH_RULES: CashRule[] = [
  { id: 'default:EXACT', kind: 'EXACT', name: CASH_RULE_LABEL.EXACT, priority: 10, enabled: true, dateDays: 0, amountTolerance: CENT, maxItems: 1, persisted: false },
  { id: 'default:DATE_DELAY', kind: 'DATE_DELAY', name: CASH_RULE_LABEL.DATE_DELAY, priority: 20, enabled: true, dateDays: 1, amountTolerance: CENT, maxItems: 1, persisted: false },
  { id: 'default:DOLLAR_VARIANCE', kind: 'DOLLAR_VARIANCE', name: CASH_RULE_LABEL.DOLLAR_VARIANCE, priority: 30, enabled: true, dateDays: 0, amountTolerance: 10000, maxItems: 1, persisted: false },
  { id: 'default:DATE_VARIANCE', kind: 'DATE_VARIANCE', name: CASH_RULE_LABEL.DATE_VARIANCE, priority: 40, enabled: true, dateDays: 3, amountTolerance: CENT, maxItems: 1, persisted: false },
  { id: 'default:MULTI_POSITION', kind: 'MULTI_POSITION', name: CASH_RULE_LABEL.MULTI_POSITION, priority: 50, enabled: true, dateDays: 1, amountTolerance: CENT, maxItems: 5, persisted: false },
  { id: 'default:MULTI', kind: 'MULTI', name: CASH_RULE_LABEL.MULTI, priority: 60, enabled: true, dateDays: 1, amountTolerance: CENT, maxItems: 5, persisted: false },
];

export function cashTypeKey(type: string): string {
  return type.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Signed settlement amount, or null when the cash flow is not money that hits the bank.
 * A positive book amount on a funding or purchase is cash out.
 */
export function settlementAmount(type: string, amount: number): number | null {
  const key = cashTypeKey(type);
  if (!key || NON_CASH.has(key) || !Number.isFinite(amount)) return null;
  if (amount < 0) return amount;
  return CASH_OUT.has(key) ? -amount : amount;
}

function utc(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

export function addCalendarDays(date: string, days: number): string {
  const next = utc(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** The calendar date that is `days` business days from `date`. Weekends are skipped. */
export function shiftBusinessDays(date: string, days: number): string {
  const dir = days >= 0 ? 1 : -1;
  let cursor = date.slice(0, 10);
  let moved = 0;
  const target = Math.abs(days);
  while (moved < target) {
    cursor = addCalendarDays(cursor, dir);
    const dow = utc(cursor).getUTCDay();
    if (dow !== 0 && dow !== 6) moved += 1;
  }
  return cursor;
}

/** True when `flowDate` lands on a business-day offset from `bankDate` between minDays and days. */
export function inBusinessWindow(bankDate: string, flowDate: string, days: number, minDays = 0): boolean {
  const flow = flowDate.slice(0, 10);
  const bank = bankDate.slice(0, 10);
  const span = Math.max(0, days);
  for (let step = Math.max(0, minDays); step <= span; step += 1) {
    if (step === 0) {
      if (flow === bank) return true;
      continue;
    }
    if (shiftBusinessDays(bank, step) === flow || shiftBusinessDays(bank, -step) === flow) return true;
  }
  return false;
}

export function bankLagDays(rules: readonly CashRule[]): number {
  const days = rules.filter((rule) => rule.enabled).reduce((max, rule) => Math.max(max, rule.dateDays), 0);
  return Math.max(5, days);
}

/** A bank date in the period, or within the rule lag after period end. */
export function bankDateInPeriod(date: string, prior: string, periodEnd: string, lagBusinessDays: number): boolean {
  const day = date.slice(0, 10);
  if (!day || day <= prior) return false;
  if (day <= periodEnd) return true;
  return inBusinessWindow(periodEnd, day, lagBusinessDays, 1);
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function byCode<T extends { code: string; id: string }>(left: T, right: T): number {
  return left.code.localeCompare(right.code) || left.id.localeCompare(right.id);
}

function amountGap(left: number, right: number): number {
  return Math.abs(left - right);
}

function toleranceFor(rule: CashRule): number {
  return Math.max(rule.amountTolerance, CENT);
}

function subsetSum(items: CashFlowFact[], target: number, maxItems: number, tolerance: number): CashFlowFact[] | null {
  const sorted = [...items].sort(byCode);
  const limit = Math.min(Math.max(maxItems, 0), sorted.length);
  for (let size = 2; size <= limit; size += 1) {
    const found = combine(sorted, size, target, tolerance);
    if (found) return found;
  }
  return null;
}

function combine(items: CashFlowFact[], size: number, target: number, tolerance: number): CashFlowFact[] | null {
  const n = items.length;
  if (n < size) return null;
  const idx = Array.from({ length: size }, (_, i) => i);
  const check = () => {
    const picked = idx.map((i) => items[i]);
    const sum = picked.reduce((total, item) => total + item.amount, 0);
    return amountGap(sum, target) <= tolerance + 1e-9 ? picked : null;
  };
  let hit = check();
  if (hit) return hit;
  const advance = (pos: number): boolean => {
    if (pos < 0) return false;
    idx[pos] += 1;
    if (idx[pos] > n - size + pos) return advance(pos - 1);
    for (let i = pos + 1; i < size; i += 1) idx[i] = idx[i - 1] + 1;
    return true;
  };
  while (advance(size - 1)) {
    hit = check();
    if (hit) return hit;
  }
  return null;
}

function matchSamePosition(flows: CashFlowFact[], target: number, maxItems: number, tolerance: number): CashFlowFact[] | null {
  const groups = new Map<string, CashFlowFact[]>();
  for (const flow of flows) {
    const list = groups.get(flow.positionId) ?? [];
    list.push(flow);
    groups.set(flow.positionId, list);
  }
  for (const positionId of [...groups.keys()].sort()) {
    const found = subsetSum(groups.get(positionId) ?? [], target, maxItems, tolerance);
    if (found) return found;
  }
  return null;
}

function pair(rule: CashRule, txn: BankTxnFact, open: CashFlowFact[]): CashFlowFact[] | null {
  const dated = open.filter((flow) => {
    if (rule.kind === 'EXACT') return flow.date.slice(0, 10) === txn.date.slice(0, 10);
    if (rule.kind === 'DATE_DELAY') return inBusinessWindow(txn.date, flow.date, rule.dateDays, 1);
    return inBusinessWindow(txn.date, flow.date, rule.dateDays, 0);
  });
  if (rule.kind === 'MULTI_POSITION') return matchSamePosition(dated, txn.amount, rule.maxItems, toleranceFor(rule));
  if (rule.kind === 'MULTI') return subsetSum(dated, txn.amount, rule.maxItems, toleranceFor(rule));

  const tol = rule.kind === 'DOLLAR_VARIANCE' ? rule.amountTolerance : toleranceFor(rule);
  const candidates = dated.filter((flow) => amountGap(flow.amount, txn.amount) <= tol + 1e-9);
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    if (rule.kind === 'DOLLAR_VARIANCE') {
      const gap = amountGap(left.amount, txn.amount) - amountGap(right.amount, txn.amount);
      if (Math.abs(gap) > 1e-9) return gap;
    }
    return byCode(left, right);
  });
  return [candidates[0]];
}

function activeRules(rules: readonly CashRule[]): CashRule[] {
  return [...rules].filter((rule) => rule.enabled && rule.kind !== 'MANUAL').sort((left, right) => left.priority - right.priority || left.kind.localeCompare(right.kind));
}

export function proposeCashMatches(
  flows: readonly CashFlowFact[],
  transactions: readonly BankTxnFact[],
  rules: readonly CashRule[],
  usedFlowIds: ReadonlySet<string>,
  usedTxnIds: ReadonlySet<string>,
): Array<{ rule: CashRule; txn: BankTxnFact; flows: CashFlowFact[] }> {
  const open = new Set(flows.filter((flow) => !usedFlowIds.has(flow.id)).map((flow) => flow.id));
  const ordered = [...transactions].filter((txn) => !usedTxnIds.has(txn.id)).sort((left, right) => left.date.localeCompare(right.date) || byCode(left, right));
  const plan = activeRules(rules);
  const proposals: Array<{ rule: CashRule; txn: BankTxnFact; flows: CashFlowFact[] }> = [];
  for (const txn of ordered) {
    const available = flows.filter((flow) => open.has(flow.id));
    for (const rule of plan) {
      const picked = pair(rule, txn, available);
      if (!picked?.length) continue;
      for (const flow of picked) open.delete(flow.id);
      proposals.push({ rule, txn, flows: picked });
      break;
    }
  }
  return proposals;
}

export function cashTieOut(
  flows: readonly { amount: number }[],
  transactions: readonly { amount: number }[],
  adjustments: readonly Pick<CashAdjustment, 'amount' | 'side'>[],
): Pick<CashRecSummary, 'positionTotal' | 'bankTotal' | 'positionAdjustments' | 'bankAdjustments' | 'positionTied' | 'bankTied' | 'residual' | 'tied'> {
  const positionTotal = cents(flows.reduce((total, flow) => total + flow.amount, 0));
  const bankTotal = cents(transactions.reduce((total, txn) => total + txn.amount, 0));
  const positionAdjustments = cents(adjustments.filter((item) => item.side === 'POSITION').reduce((total, item) => total + item.amount, 0));
  const bankAdjustments = cents(adjustments.filter((item) => item.side === 'BANK').reduce((total, item) => total + item.amount, 0));
  const positionTied = cents(positionTotal + positionAdjustments);
  const bankTied = cents(bankTotal + bankAdjustments);
  const residual = cents(positionTied - bankTied);
  return {
    positionTotal, bankTotal, positionAdjustments, bankAdjustments, positionTied, bankTied, residual,
    tied: Math.abs(residual) < CENT,
  };
}

/** The adjustment that brings the two books together. Null when they already tie. */
export function clearingAdjustment(residual: number): { amount: number; side: AdjustmentSide } | null {
  const gap = cents(residual);
  if (Math.abs(gap) < CENT) return null;
  if (gap > 0) return { amount: gap, side: 'BANK' };
  return { amount: cents(-gap), side: 'POSITION' };
}

function ruleName(rules: readonly CashRule[], kind: CashRuleKind, ruleId: string | null): string {
  return rules.find((rule) => rule.id === ruleId)?.name || CASH_RULE_LABEL[kind];
}

export function buildCashRec(input: CashRecInput): CashRec {
  const rules = input.rules.length ? [...input.rules].sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name)) : DEFAULT_CASH_RULES.map((rule) => ({ ...rule }));
  const accounts = [...input.accounts].sort(byCode);
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  const flowById = new Map(input.flows.map((flow) => [flow.id, flow]));
  const txnById = new Map(input.transactions.map((txn) => [txn.id, txn]));

  const matches: CashMatchRow[] = [];
  const usedFlows = new Set<string>();
  const usedTxns = new Set<string>();
  for (const locked of input.locked) {
    const txn = txnById.get(locked.bankTxnId);
    if (!txn || usedTxns.has(txn.id)) continue;
    const flows = locked.flowIds.flatMap((id) => {
      const flow = flowById.get(id);
      return flow && !usedFlows.has(flow.id) ? [flow] : [];
    });
    if (!flows.length) continue;
    for (const flow of flows) usedFlows.add(flow.id);
    usedTxns.add(txn.id);
    const flowAmount = cents(flows.reduce((total, flow) => total + flow.amount, 0));
    matches.push({
      id: locked.id,
      kind: locked.kind,
      ruleId: null,
      ruleName: ruleName(rules, locked.kind, null),
      bankTxnId: txn.id,
      flowIds: flows.map((flow) => flow.id),
      bankAmount: txn.amount,
      flowAmount,
      variance: cents(txn.amount - flowAmount),
      confidence: CONFIDENCE[locked.kind],
      status: 'APPROVED',
    });
  }

  for (const proposal of proposeCashMatches(input.flows, input.transactions, rules, usedFlows, usedTxns)) {
    const flowAmount = cents(proposal.flows.reduce((total, flow) => total + flow.amount, 0));
    matches.push({
      id: `proposal:${proposal.txn.id}`,
      kind: proposal.rule.kind,
      ruleId: proposal.rule.id,
      ruleName: proposal.rule.name,
      bankTxnId: proposal.txn.id,
      flowIds: proposal.flows.map((flow) => flow.id),
      bankAmount: proposal.txn.amount,
      flowAmount,
      variance: cents(proposal.txn.amount - flowAmount),
      confidence: CONFIDENCE[proposal.rule.kind],
      status: 'PROPOSED',
    });
  }

  const matchByTxn = new Map(matches.map((match) => [match.bankTxnId, match]));
  const matchByFlow = new Map<string, CashMatchRow>();
  for (const match of matches) for (const flowId of match.flowIds) matchByFlow.set(flowId, match);

  const flows: CashFlowRow[] = [...input.flows].sort((left, right) => left.date.localeCompare(right.date) || left.positionName.localeCompare(right.positionName) || byCode(left, right)).map((flow) => {
    const match = matchByFlow.get(flow.id);
    return { ...flow, status: match?.status ?? 'OPEN', matchId: match?.id ?? null, bankTxnId: match?.bankTxnId ?? null };
  });
  const transactions: BankTxnRow[] = [...input.transactions].sort((left, right) => left.date.localeCompare(right.date) || byCode(left, right)).map((txn) => {
    const match = matchByTxn.get(txn.id);
    return {
      ...txn,
      accountName: accountName.get(txn.accountId) || '',
      status: match?.status ?? 'OPEN',
      matchId: match?.id ?? null,
      ruleKind: match?.kind ?? null,
      ruleName: match?.ruleName ?? null,
      matchedAmount: match ? match.flowAmount : null,
      variance: match ? match.variance : null,
      flowIds: match?.flowIds ?? [],
    };
  });

  const openFlows = flows.filter((flow) => flow.status === 'OPEN');
  const openTxns = transactions.filter((txn) => txn.status === 'OPEN');
  const tie = cashTieOut(flows, transactions, input.adjustments);
  const summary: CashRecSummary = {
    openFlowCount: openFlows.length,
    openFlowAmount: cents(openFlows.reduce((total, flow) => total + flow.amount, 0)),
    openTxnCount: openTxns.length,
    openTxnAmount: cents(openTxns.reduce((total, txn) => total + txn.amount, 0)),
    matchCount: matches.length,
    proposedCount: matches.filter((match) => match.status === 'PROPOSED').length,
    approvedCount: matches.filter((match) => match.status === 'APPROVED').length,
    matchedFlowAmount: cents(matches.reduce((total, match) => total + match.flowAmount, 0)),
    matchedBankAmount: cents(matches.reduce((total, match) => total + match.bankAmount, 0)),
    ...tie,
  };

  return { ...input, accounts, rules, flows, transactions, matches, summary };
}
