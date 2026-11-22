import { describe, expect, it } from 'vitest';
import type { RecCheck } from './fund-rec';
import {
  buildPack, emptyPack, expectedComponents, feeSegments, rolledCapital, waterfallTiers,
  type PackCapitalAccount, type PackContext, type PackInput,
} from './nav-pack';

const M = 1_000_000;

/** A partnership's statement lines at the quarter end, in dollars. */
const LINES: Record<string, number> = {
  chBegin: 300 * M, chContrib: 30 * M, chDist: -10 * M, chCapital: 20 * M, chEnd: 333.5 * M,
  totalInc: 14 * M, totalExp: 6 * M, nii: 8 * M, realizedTotal: 4 * M, realized: 3.5 * M,
  fxRealized: 0.5 * M, fxUnrealized: -0.2 * M, netInc: 13.5 * M,
  netAssets: 333.5 * M, assets: 350 * M, liabilities: 16.5 * M,
  distPayable: 5 * M, derivAssets: 0.8 * M, cfDist: -10 * M, mgmt: 1.2234375 * M,
  'code:NAV_BS_CASH': 20 * M, 'code:NAV_BS_DISTRIBUTION_PAYABLE': 5 * M,
};

function context(overrides: Partial<PackContext> = {}, lines: Record<string, number | null> = {}): PackContext {
  const all = { ...LINES, ...lines };
  return {
    fund: { id: 'F1', name: 'Harbor Credit Partners', capitalModel: 'DRAWDOWN', feeRatePct: 1.5, carryPct: 20 },
    periodEnd: '2026-09-30',
    previous: '2026-06-30',
    spanMonths: 3,
    lagDays: 45,
    amount: (key) => all[key] ?? null,
    prior: () => null,
    lineSources: (key) => (all[key] != null ? [{ entityId: 'S1', entityName: 'Statement', domainCode: 'NAV_STATEMENT', code: key, name: key, dataType: 'CURRENCY' }] : []),
    statementsWithFigures: ['Balance sheet', 'Statement of operations', 'Changes in net assets', 'Cash flows'],
    fee: {
      segments: [{ from: '2026-06-30', to: '2026-09-30', share: 0.25, ratePct: 1.5, basis: 'COMMITMENTS', base: 333 * M }],
      admin: 1.2234375 * M,
      sources: [],
    },
    perf: {
      basis: 'WATERFALL', ready: true, contributions: 300 * M, distributions: 40 * M, profit: 73.5 * M, hurdle: 30 * M, excess: 43.5 * M,
      carry: 14.7 * M, admin: 14.7 * M, carryPct: 20, catchUpPct: 100, sources: [],
    },
    checks: [],
    items: [],
    ...overrides,
  };
}

const account = (id: string, name: string, values: Partial<PackCapitalAccount>): PackCapitalAccount => ({
  id, name, investorId: `I-${id}`, isGp: false, opening: null, contributions: null, distributions: null, pnl: null, mgmtFee: null,
  feeRatePct: null, carry: null, carryBalance: null, other: null, closing: null, commitment: null, contributedItd: null, unfunded: null,
  ownershipPct: null, ...values,
});

/** Four investors whose accounts roll, add up to the statements, and carry the GP's share. */
const ACCOUNTS: PackCapitalAccount[] = [
  account('A', 'Pension Fund A', { opening: 180 * M, contributions: 18 * M, distributions: 6 * M, pnl: 8.1 * M, carry: -0.81 * M, closing: 199.29 * M, commitment: 200 * M, contributedItd: 180 * M, unfunded: 20 * M, ownershipPct: 60, mgmtFee: 0.75 * M }),
  account('B', 'Endowment B', { opening: 90 * M, contributions: 9 * M, distributions: 3 * M, pnl: 4.05 * M, carry: -0.405 * M, closing: 99.645 * M, commitment: 100 * M, contributedItd: 90 * M, unfunded: 10 * M, ownershipPct: 30, mgmtFee: 0.375 * M }),
  account('C', 'Family Office C', { opening: 28.5 * M, contributions: 2.85 * M, distributions: 0.95 * M, pnl: 1.2825 * M, carry: -0.12825 * M, closing: 31.55425 * M, commitment: 31.5 * M, contributedItd: 28.35 * M, unfunded: 3.15 * M, ownershipPct: 9.5, mgmtFee: 0.0984375 * M, feeRatePct: 1.25 }),
  account('GP', 'General Partner', { isGp: true, opening: 1.5 * M, contributions: 0.15 * M, distributions: 0.05 * M, pnl: 0.0675 * M, carry: 1.34325 * M, closing: 3.01075 * M, commitment: 1.5 * M, contributedItd: 1.35 * M, unfunded: 0.15 * M, ownershipPct: 0.5, carryBalance: 14.7 * M }),
];

function pack(overrides: Partial<PackInput> = {}): PackInput {
  return {
    ...emptyPack('USD'),
    notesIncluded: true,
    trialBalance: [
      { id: 'T1', name: 'Cash', account: '1000', accountName: 'Cash', accountClass: 'ASSET', debit: 20 * M, credit: null, balance: null, navLine: 'NAV_BS_CASH', periodStart: '2026-07-01' },
      { id: 'T2', name: 'Investments', account: '1100', accountName: 'Investments at fair value', accountClass: 'ASSET', debit: 330 * M, credit: null, balance: null, navLine: null, periodStart: '2026-07-01' },
      { id: 'T3', name: 'Payables', account: '2000', accountName: 'Accrued expenses', accountClass: 'LIABILITY', debit: null, credit: 11.5 * M, balance: null, navLine: null, periodStart: '2026-07-01' },
      { id: 'T4', name: 'Distributions payable', account: '2100', accountName: 'Distributions payable', accountClass: 'LIABILITY', debit: null, credit: 5 * M, balance: null, navLine: 'NAV_BS_DISTRIBUTION_PAYABLE', periodStart: '2026-07-01' },
      { id: 'T5', name: 'Partners capital', account: '3000', accountName: 'Partners\' capital', accountClass: 'CAPITAL', debit: null, credit: 320 * M, balance: null, navLine: null, periodStart: '2026-07-01' },
      { id: 'T6', name: 'Interest income', account: '4000', accountName: 'Interest income', accountClass: 'INCOME', debit: null, credit: 14 * M, balance: null, navLine: null, periodStart: '2026-07-01' },
      { id: 'T7', name: 'Expenses', account: '5000', accountName: 'Fund expenses', accountClass: 'EXPENSE', debit: 6 * M, credit: null, balance: null, navLine: null, periodStart: '2026-07-01' },
      { id: 'T8', name: 'Gains', account: '6000', accountName: 'Realized and unrealized gains', accountClass: 'GAIN_LOSS', debit: null, credit: 5.5 * M, balance: null, navLine: null, periodStart: '2026-07-01' },
    ],
    capitalAccounts: ACCOUNTS,
    holdings: [
      { id: 'H1', name: 'Atlas Software term loan', fairValue: 100 * M, cost: 98 * M, currency: 'USD' },
      { id: 'H2', name: 'Beacon Health unitranche', fairValue: 80 * M, cost: 80 * M, currency: 'USD' },
      { id: 'H3', name: 'Cobalt GmbH senior loan', fairValue: 50 * M, cost: 51 * M, currency: 'EUR' },
      { id: 'H4', name: 'Delta Logistics equity', fairValue: 20 * M, cost: 15 * M, currency: 'USD' },
    ],
    valuations: [
      { id: 'V1', name: 'Atlas Q3 valuation report', positionId: 'H1', date: '2026-09-30', sourceType: 'THIRD_PARTY', method: 'YIELD_ANALYSIS', provider: 'Valuation agent', fairValue: 100 * M, low: 95 * M, high: 105 * M, document: 'atlas-q3.pdf' },
      { id: 'V2', name: 'Beacon memo', positionId: 'H2', date: '2026-09-30', sourceType: 'GP_MEMO', method: 'MARKET_MULTIPLE', provider: null, fairValue: 80 * M, low: null, high: null, document: null },
      { id: 'V3', name: 'Cobalt model', positionId: 'H3', date: '2026-10-15', sourceType: 'MODEL', method: 'DCF', provider: null, fairValue: 50.2 * M, low: null, high: null, document: null },
      { id: 'V4', name: 'Delta comps', positionId: 'H4', date: '2026-09-30', sourceType: 'COMPARABLES', method: 'MARKET_MULTIPLE', provider: null, fairValue: null, low: 18 * M, high: 22 * M, document: null },
      { id: 'V0', name: 'Atlas Q2 report', positionId: 'H1', date: '2026-06-30', sourceType: 'THIRD_PARTY', method: 'YIELD_ANALYSIS', provider: null, fairValue: 90 * M, low: null, high: null, document: null },
    ],
    fx: [{ id: 'X1', name: 'EUR', currency: 'EUR', rateApplied: 1.08, exposureLocal: 46.3 * M, exposureBase: 50.004 * M, realized: 0.5 * M, unrealized: -0.2 * M, hedgeNotional: 40 * M, hedgeMtm: 0.8 * M }],
    marketRates: [{ id: 'R1', name: 'EUR/USD', base: 'EUR', quote: 'USD', rate: 1.0805, source: 'BLOOMBERG' }],
    activities: [
      { id: 'C1', name: 'Call 7', kind: 'CAPITAL_CALL', date: '2026-08-15', amount: 30 * M, status: 'FUNDED', outstanding: 0 },
      { id: 'C2', name: 'Call 8', kind: 'CAPITAL_CALL', date: '2026-10-20', amount: 15 * M, status: 'ISSUED', outstanding: 15 * M },
      { id: 'D1', name: 'Distribution 4', kind: 'DISTRIBUTION', date: '2026-09-01', amount: 10 * M, status: 'PAID', outstanding: 0 },
      { id: 'D2', name: 'Distribution 5', kind: 'DISTRIBUTION', date: '2026-09-30', amount: 5 * M, status: 'DECLARED', outstanding: 5 * M },
    ],
    settings: {
      valuationCoveragePct: null, thirdPartyCoveragePct: 30, fxTolerancePct: null, fxHedgeTargetPct: 80,
      totalCommitments: 333 * M, undrawnCommitments: 33.3 * M,
    },
    ...overrides,
  };
}

const results = (review: ReturnType<typeof buildPack>) => Object.fromEntries(review.checks.map((check) => [check.id, check.result]));
const statusOf = (review: ReturnType<typeof buildPack>) => Object.fromEntries(review.components.map((part) => [part.key, part.status]));

describe('a complete pack that ties', () => {
  const review = buildPack(context(), pack());

  it('checks every part, and every check ties', () => {
    expect(results(review)).toEqual({
      bridge: 'Ties',
      tbBalances: 'Ties', tbAssets: 'Ties', tbLiabilities: 'Ties', tbCapital: 'Ties', tbIncome: 'Ties', tbExpenses: 'Ties', tbLines: 'Ties',
      pcapRoll: 'Ties', pcapNav: 'Ties', pcapOpening: 'Ties', pcapContrib: 'Ties', pcapDist: 'Ties', pcapPnl: 'Ties', pcapOwnership: 'Ties',
      lpFees: 'Ties', feeAllocation: 'Ties',
      gpCarry: 'Ties', carryOffsets: 'Ties',
      valuationCoverage: 'Ties', valuationMarks: 'Ties', thirdParty: 'Ties',
      callsReceived: 'Ties', distPayable: 'Ties', distPaid: 'Ties',
      lpCommitments: 'Ties', lpUnfunded: 'Ties', unfundedRoll: 'Ties', pendingCalls: 'Ties',
      fxCoverage: 'Ties', fxRates: 'Ties', fxTranslation: 'Ties', fxGains: 'Ties', fxHedgeMtm: 'Ties', fxHedge: 'Ties',
    });
    expect(review.checks.every((check) => check.group === 'pack' && check.component)).toBe(true);
  });

  it('shows all ten parts on file and tying', () => {
    expect(review.components.map((part) => part.key)).toEqual([
      'NAV_BRIDGE', 'TRIAL_BALANCE', 'FINANCIAL_STATEMENTS', 'CAPITAL_ACCOUNTS', 'MANAGEMENT_FEE',
      'CARRIED_INTEREST', 'VALUATION', 'CAPITAL_ACTIVITY', 'COMMITMENTS', 'FX',
    ]);
    expect(review.components.every((part) => part.onFile && part.expected && part.status === 'Ties')).toBe(true);
  });

  it('bridges opening to closing NAV with FX on its own line', () => {
    expect(review.bridge.steps.map((step) => [step.key, step.amount && Math.round(step.amount)])).toEqual([
      ['contributions', 30 * M], ['distributions', -10 * M], ['income', 14 * M], ['expenses', -6 * M],
      ['realized', 3.5 * M], ['unrealized', 1.7 * M], ['fx', 0.3 * M],
    ]);
    expect(Math.round(review.bridge.closing!)).toBe(333.5 * M);
    expect(Math.round(review.bridge.difference!)).toBe(0);
  });

  it('lays out the waterfall tier by tier, adding up to the carry', () => {
    expect(review.waterfall?.tiers.map((tier) => [tier.key, Math.round(tier.total), Math.round(tier.gp)])).toEqual([
      ['capital', 300 * M, 0], ['pref', 30 * M, 0], ['catchUp', 7.5 * M, 7.5 * M], ['split', 36 * M, 7.2 * M],
    ]);
    expect(Math.round(review.waterfall!.carry)).toBe(14.7 * M);
  });

  it('summarizes valuation coverage, calls and distributions, commitments and FX', () => {
    expect(review.valuation).toMatchObject({ coveragePct: 100, thirdPartyPct: 40, unsupported: [], outside: [] });
    expect(review.capitalActivity).toMatchObject({ calledInPeriod: 30 * M, receivedInPeriod: 30 * M, distributionsPayable: 5 * M, pending: [expect.objectContaining({ id: 'C2' })] });
    expect(review.commitments).toMatchObject({ investors: 4, committed: 333 * M, unfunded: 33_300_000, pendingCalls: 15 * M });
    expect(review.fx?.currencies[0]).toMatchObject({ currency: 'EUR', applied: 1.08, market: 1.0805 });
    expect(review.fees.allocation).toBe('each investor\'s commitment');
  });
});

describe('a pack with breaks', () => {
  it('names the investors whose capital does not roll, and the totals that do not tie', () => {
    const off = ACCOUNTS.map((item) => (item.id === 'B' ? { ...item, closing: 99.9 * M } : item));
    const review = buildPack(context(), pack({ capitalAccounts: off }));
    const roll = review.checks.find((check) => check.id === 'pcapRoll')!;
    expect(roll).toMatchObject({ result: 'Break', a: 3, b: 4 });
    expect(roll.label).toMatch(/1 investor do not \(Endowment B\)/);
    expect(results(review).pcapNav).toBe('Break');
    expect(statusOf(review).CAPITAL_ACCOUNTS).toBe('Breaks');
  });

  it('breaks a trial balance that does not balance or does not agree with the statements', () => {
    const tb = pack().trialBalance.map((line) => (line.id === 'T1' ? { ...line, debit: 21 * M } : line));
    const review = buildPack(context(), pack({ trialBalance: tb }));
    expect(results(review)).toMatchObject({ tbBalances: 'Break', tbAssets: 'Break', tbLines: 'Break' });
    expect(review.checks.find((check) => check.id === 'tbLines')!.label).toMatch(/NAV_BS_CASH/);
  });

  it('skips income and expense ties when the ledger runs from another date than the statement', () => {
    const tb = pack().trialBalance.map((line) => ({ ...line, periodStart: '2026-01-01' }));
    const review = buildPack(context(), pack({ trialBalance: tb }));
    expect(results(review).tbIncome).toBeUndefined();
    expect(results(review).tbCapital).toBe('Ties');
  });

  it('flags investors charged a fee off their rate, and a fee total that does not reach the statements', () => {
    const off = ACCOUNTS.map((item) => (item.id === 'C' ? { ...item, mgmtFee: 0.118125 * M } : item));
    const review = buildPack(context(), pack({ capitalAccounts: off }));
    expect(review.checks.find((check) => check.id === 'lpFees')).toMatchObject({ result: 'Break' });
    expect(review.checks.find((check) => check.id === 'lpFees')!.label).toMatch(/Family Office C/);
    expect(results(review).feeAllocation).toBe('Break');
  });

  it('counts positions without support in the period and marks outside their valuation range', () => {
    const valuations = pack().valuations.filter((item) => item.id !== 'V2')
      .map((item) => (item.id === 'V4' ? { ...item, low: 10 * M, high: 15 * M } : item));
    const review = buildPack(context(), pack({ valuations }));
    expect(review.valuation).toMatchObject({ coveragePct: 68, unsupported: [expect.objectContaining({ id: 'H2' })] });
    expect(review.valuation!.outside.map((item) => item.id)).toEqual(['H4']);
    expect(results(review)).toMatchObject({ valuationCoverage: 'Break', valuationMarks: 'Break' });
  });

  it('only counts support dated after the prior period end and up to the certification lag', () => {
    const valuations = pack().valuations.map((item) => (item.id === 'V3' ? { ...item, date: '2026-12-31' } : item));
    const review = buildPack(context(), pack({ valuations }));
    expect(review.valuation!.unsupported.map((item) => item.id)).toEqual(['H3']);
  });

  it('breaks a rate applied away from the market and a currency held with no rate', () => {
    const holdings = [...pack().holdings, { id: 'H5', name: 'Elm plc', fairValue: 5 * M, cost: 5 * M, currency: 'GBP' }];
    const review = buildPack(context(), pack({ holdings, fx: [{ ...pack().fx[0], rateApplied: 1.1, exposureBase: 50.93 * M }] }));
    expect(results(review)).toMatchObject({ fxCoverage: 'Break', fxRates: 'Break', fxTranslation: 'Ties' });
    expect(review.checks.find((check) => check.id === 'fxCoverage')!.label).toMatch(/GBP missing/);
    expect(review.checks.find((check) => check.id === 'fxRates')!.label).toMatch(/EUR 1\.8%/);
    expect(review.fx?.heldWithoutRate).toEqual(['GBP']);
  });

  it('reads a market rate quoted the other way round', () => {
    const review = buildPack(context(), pack({ marketRates: [{ id: 'R2', name: 'USD/EUR', base: 'USD', quote: 'EUR', rate: 1 / 1.0805, source: null }] }));
    expect(results(review).fxRates).toBe('Ties');
  });

  it('breaks calls not yet received against a balance sheet with no receivable', () => {
    const activities = [...pack().activities, { id: 'C3', name: 'Call 7b', kind: 'CAPITAL_CALL', date: '2026-09-25', amount: 4 * M, status: 'ISSUED', outstanding: 4 * M }];
    const review = buildPack(context(), pack({ activities }));
    expect(review.checks.find((check) => check.id === 'callReceivable')).toMatchObject({ result: 'Break', a: 4 * M, b: 0 });
  });

  it('flags an investor whose commitment less contributions is not its unfunded amount', () => {
    const off = ACCOUNTS.map((item) => (item.id === 'A' ? { ...item, unfunded: 25 * M } : item));
    const review = buildPack(context(), pack({ capitalAccounts: off }));
    expect(results(review)).toMatchObject({ unfundedRoll: 'Break', lpUnfunded: 'Break' });
  });
});

describe('what a fund\'s pack is expected to hold', () => {
  it('expects the investor parts of a drawdown fund, and reports them missing', () => {
    const review = buildPack(context(), emptyPack());
    expect(statusOf(review)).toMatchObject({
      TRIAL_BALANCE: 'Not on file', CAPITAL_ACCOUNTS: 'Not on file', CAPITAL_ACTIVITY: 'Not on file', COMMITMENTS: 'Not on file',
      VALUATION: 'Not expected', FX: 'Not expected', NAV_BRIDGE: 'Ties',
    });
    expect(review.components.every((part) => !part.required)).toBe(true);
  });

  it('does not expect investor accounts or notices of an evergreen fund', () => {
    const evergreen = context({ fund: { ...context().fund, capitalModel: 'EVERGREEN' } });
    expect([...expectedComponents(evergreen, emptyPack())].sort()).toEqual(['CARRIED_INTEREST', 'FINANCIAL_STATEMENTS', 'MANAGEMENT_FEE', 'NAV_BRIDGE']);
    expect(statusOf(buildPack(evergreen, emptyPack())).CAPITAL_ACCOUNTS).toBe('Not expected');
  });

  it('holds a fund to the parts it lists, and marks them required', () => {
    const review = buildPack(context(), { ...emptyPack(), required: ['TRIAL_BALANCE', 'VALUATION'] });
    expect(review.components.filter((part) => part.expected).map((part) => part.key)).toEqual(['TRIAL_BALANCE', 'VALUATION']);
    expect(review.components.filter((part) => part.required).map((part) => part.key)).toEqual(['TRIAL_BALANCE', 'VALUATION']);
  });

  it('marks the statements partial when the notes are not in the pack', () => {
    expect(statusOf(buildPack(context(), pack({ notesIncluded: false }))).FINANCIAL_STATEMENTS).toBe('Partial');
  });

  it('says which checks lack a figure when a part on file is partial', () => {
    const checks: RecCheck[] = [{ id: 'bank', group: 'evidence', label: 'Closing cash vs bank statement', compared: 'Bank statement', a: 1, b: null, difference: null, result: 'Missing', aSources: [], bSources: [] }];
    const part = buildPack(context({ checks }), pack()).components.find((item) => item.key === 'FINANCIAL_STATEMENTS')!;
    expect(part).toMatchObject({ status: 'Partial' });
    expect(part.detail).toMatch(/with the notes\. Without a figure: Closing cash vs bank statement$/);
  });

  it('marks a part open while one of its review items is undecided', () => {
    const items = [{ id: 'fee', tab: 'fees', title: 'Management fee accrual', decision: null } as never];
    expect(statusOf(buildPack(context({ items }), pack())).MANAGEMENT_FEE).toBe('Open');
  });
});

describe('building blocks', () => {
  it('rolls an investor\'s capital forward', () => {
    expect(rolledCapital(ACCOUNTS[0])).toBeCloseTo(199.29 * M, 0);
    expect(rolledCapital({ ...ACCOUNTS[0], opening: null })).toBeNull();
  });

  it('splits the carry the same way for any catch-up', () => {
    const perf = context().perf;
    for (const catchUpPct of [100, 80, 50]) {
      const tiers = waterfallTiers({ ...perf, catchUpPct });
      const gp = tiers.reduce((total, tier) => total + tier.gp, 0);
      // The closed form the reconciliation uses: min(excess x catch-up, carry x profit).
      expect(gp).toBeCloseTo(Math.min(perf.excess * (catchUpPct / 100), 0.2 * perf.profit), 0);
    }
  });

  it('charges a fee that steps down in the period at each rate for its days', () => {
    const terms = { ratePct: 2, basis: 'COMMITMENTS', stepDownDate: '2026-08-01', stepDownRatePct: 1.5, stepDownBasis: 'INVESTED_CAPITAL' };
    const parts = feeSegments(terms, '2026-06-30', '2026-09-30', 3);
    expect(parts.map((part) => [part.ratePct, part.basis])).toEqual([[2, 'COMMITMENTS'], [1.5, 'INVESTED_CAPITAL']]);
    expect(parts[0].share + parts[1].share).toBeCloseTo(0.25, 10);
    expect(parts[0].share).toBeCloseTo(0.25 * (31 / 92), 10);
    expect(feeSegments({ ...terms, stepDownDate: '2026-07-01' }, '2026-06-30', '2026-09-30', 3)).toEqual([
      { from: '2026-06-30', to: '2026-09-30', share: 0.25, ratePct: 1.5, basis: 'INVESTED_CAPITAL' },
    ]);
    expect(feeSegments({ ...terms, stepDownDate: null }, '2026-06-30', '2026-09-30', 3)).toHaveLength(1);
  });
});
