import { describe, expect, it } from 'vitest';
import {
  buildReview,
  cashflowBucket,
  monthSpan,
  visibleLines,
  periodEndOnOrBefore,
  comparativeAmount,
  priorPeriodEnd,
  stepDue,
  sumCashflows,
  targetDate,
  type RecInput,
  type RecLine,
  type RecPosition,
} from './fund-rec';
import { summarizeBreaks } from './nav-breaks';

const M = 1e6;
let order = 0;
const line = (statement: string, role: string, label: string, admin: number | null, prior: number | null = null): RecLine => {
  order += 1;
  return {
    id: `L${order}`, entityId: 'S1', code: `NAV_${statement}_${order}`, statement, role, label, indent: 0, order,
    admin: admin == null ? null : admin * M, shadow: null, prior: prior == null ? null : prior * M,
  };
};

function statementLines(): RecLine[] {
  order = 0;
  return [
    line('BS_ASSET', 'DETAIL', 'Senior secured', 147.8, 150.5),
    line('BS_ASSET', 'DETAIL', 'Unitranche', 149.4, 159.1),
    line('BS_ASSET', 'DETAIL', 'Mezzanine', 55.8, 57.3),
    line('BS_ASSET', 'DETAIL', 'Asset-based', 76.5, 54.4),
    line('BS_ASSET', 'SUBTOTAL', 'Total investments at fair value', 429.5, 421.3),
    line('BS_ASSET', 'LINE', 'Cash and equivalents', 21.4, 11.7),
    line('BS_ASSET', 'LINE', 'Interest receivable', 6.1, 5.7),
    line('BS_ASSET', 'TOTAL', 'Total assets', 457, 438.7),
    line('BS_LIABILITY', 'LINE', 'Credit facility', 110, 122.1),
    line('BS_LIABILITY', 'LINE', 'Accrued management fee', 1.9, 1.88),
    line('BS_LIABILITY', 'LINE', 'Accrued expenses and interest', 1.3, 1.12),
    line('BS_LIABILITY', 'SUBTOTAL', 'Total liabilities', 113.2, 125.1),
    line('BS_NET', 'LINE', 'Capital contributions', 360, 330),
    line('BS_NET', 'LINE', 'Cumulative distributions', -52, -42.5),
    line('BS_NET', 'LINE', 'Accumulated net investment income and gains', 35.8, 26.1),
    line('BS_NET', 'TOTAL', 'Net assets', 343.8, 313.6),
    line('OPS', 'LINE', 'Cash interest income', 12.4, 11.9),
    line('OPS', 'LINE', 'PIK interest income', 0.6, 0.55),
    line('OPS', 'LINE', 'Fee and other income', 0.8, 0.75),
    line('OPS', 'SUBTOTAL', 'Total investment income', 13.8, 13.2),
    line('OPS', 'LINE', 'Management fee', 1.9, 1.88),
    line('OPS', 'SUBTOTAL', 'Total expenses', 6.4, 6.2),
    line('OPS', 'TOTAL', 'Net investment income', 7.4, 7),
    line('OPS', 'LINE', 'Net realized gain on investments', 3.9, 2.1),
    line('OPS', 'LINE', 'Net change in unrealized appreciation (depreciation)', -1.6, 0.8),
    line('OPS', 'SUBTOTAL', 'Net realized and unrealized gain', 2.3, 2.9),
    line('OPS', 'TOTAL', 'Net increase in net assets from operations', 9.7, 9.9),
    line('CHANGES', 'SUBTOTAL', 'Net increase from operations', 9.7),
    line('CHANGES', 'LINE', 'Capital contributions', 30),
    line('CHANGES', 'LINE', 'Distributions to investors', -9.5),
    line('CHANGES', 'SUBTOTAL', 'Net increase from capital transactions', 20.5),
    line('CHANGES', 'LINE', 'Beginning of period', 313.6),
    line('CHANGES', 'TOTAL', 'End of period', 343.8),
    line('CASH', 'LINE', 'Net increase in net assets from operations', 9.7, 9.9),
    line('CASH', 'LINE', 'Net realized gain on investments', -3.9, -2.1),
    line('CASH', 'LINE', 'Net change in unrealized (appreciation) depreciation', 1.6, -0.8),
    line('CASH', 'LINE', 'PIK interest income', -0.6, -0.55),
    line('CASH', 'LINE', 'Purchases of investments', -44.2, -38),
    line('CASH', 'LINE', 'Proceeds from sales and repayments', 38.9, 28.4),
    line('CASH', 'LINE', 'Increase in interest receivable', -0.4, -0.3),
    line('CASH', 'LINE', 'Repayment of credit facility', -12.1, -10.9),
    line('CASH', 'LINE', 'Net increase in cash', 9.7, 2.3),
    line('CASH', 'LINE', 'Beginning of period', 11.7, 9.4),
    line('CASH', 'TOTAL', 'End of period', 21.4, 11.7),
  ];
}

// name, group, begin, purchases, repayments, sales, pik, amort, unrealizedChg, realized, interest, fees, beginUnrealized, beginAccrued, endAccrued, endFv, ourAccrued
const ROLL: Array<[string, string, ...number[]]> = [
  ['Northwind Logistics', 'Senior secured', 50, 0, 15, 0, 0, 0, 0.1, 2.1, 1.7, 0, 1.5, 0.6, 0.55, 35.1, 0.55],
  ['Quillon Health', 'Senior secured', 45, 0, 0, 0, 0, 0, 0, 0, 1.4, 0, 0.3, 0.5, 0.55, 45, 0.55],
  ['Cobalt Software', 'Senior secured', 55.5, 12, 0, 0, 0, 0.15, 0.05, 0, 1.6, 0.1, 0.45, 0.55, 0.6, 67.7, 0.9],
  ['Sable Energy Services', 'Unitranche', 40, 0, 8, 0, 0, 0, 0.3, 0.8, 1.2, 0, 0.9, 0.45, 0.4, 32.3, 0.4],
  ['Meridian Specialty Finance', 'Unitranche', 38, 0, 0, 0, 0, 0, -0.1, 0, 1.3, 0, 0.3, 0.5, 0.55, 37.9, 0.55],
  ['Pinecrest Education', 'Unitranche', 27, 10.2, 0, 0, 0, -0.1, 0.1, 0, 1, 0.3, 0.15, 0.35, 0.4, 37.2, 0.4],
  ['Atlas Industrial Rentals', 'Unitranche', 54.1, 0, 0, 12, 0, -0.2, 0.1, 1, 1.2, 0, 1.25, 0.5, 0.35, 42, 0.35],
  ['Harbor Foods', 'Mezzanine', 30, 0, 0, 0, 0.3, 0, -1.2, 0, 1.2, 0, -0.1, 0.8, 0.95, 29.1, 0.95],
  ['Bluewater Marine', 'Mezzanine', 27.3, 0, 0, 0, 0.3, 0, -0.9, 0, 0.8, 0, 0.05, 0.7, 0.85, 26.7, 0.85],
  ['Ridgeline Dental', 'Asset-based', 30.5, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0.2, 0.25, 0.3, 30.5, 0.3],
  ['Vantage Payments', 'Asset-based', 20, 14, 0, 0, 0, 0.15, -0.05, 0, 0.3, 0.2, 0.1, 0.3, 0.35, 34.1, 0.35],
  ['Kestrel Aerospace', 'Asset-based', 3.9, 8, 0, 0, 0, 0, 0, 0, 0.1, 0.2, 0, 0.2, 0.25, 11.9, 0.25],
];

function positions(): RecPosition[] {
  return ROLL.map(([name, group, ...v], index) => ({
    id: `P${index}`, code: `POS-${index}`, name, group,
    mark: name === 'Harbor Foods' ? 95.5 : name === 'Bluewater Marine' ? 96 : 101,
    agentMark: name === 'Harbor Foods' ? 96.8 : name === 'Bluewater Marine' ? 94.5 : 101,
    marketValue: v[13] * M,
    roll: {
      begin: v[0] * M, purchases: v[1] * M, repayments: v[2] * M, sales: v[3] * M, pik: v[4] * M, amort: v[5] * M,
      unrealizedChg: v[6] * M, realized: v[7] * M, interest: v[8] * M, fees: v[9] * M, beginUnrealized: v[10] * M,
      beginAccrued: v[11] * M, endAccrued: v[12] * M, endFv: v[13] * M, ourAccrued: v[14] * M,
    },
  }));
}

function input(overrides: Partial<RecInput> = {}): RecInput {
  return {
    fund: {
      id: 'F1', code: 'HSCF2-FUND', name: 'Halyard Senior Credit Fund II', strategy: 'Direct lending',
      frequency: 'QUARTERLY', lagDays: 37, commitments: 600 * M, feeRatePct: 1.25, prefPct: 6, carryPct: 10, catchUpPct: 100,
      netIrr: 8.7, hasFacility: true,
    },
    periodEnd: '2026-09-30',
    today: '2026-11-03',
    statement: { id: 'S1', label: 'September 30, 2026', receivedDate: '2026-10-27', certified: false, tolerancePct: 0.5 },
    lines: statementLines(),
    positions: positions(),
    evidence: { bank: 21.4 * M, lender: 110 * M },
    capital: {
      calls: [
        { date: '2024-11-15', amount: 100 * M }, { date: '2025-02-14', amount: 60 * M }, { date: '2025-05-15', amount: 45 * M },
        { date: '2025-08-15', amount: 35 * M }, { date: '2025-11-14', amount: 30 * M }, { date: '2026-02-13', amount: 25 * M },
        { date: '2026-05-15', amount: 35 * M }, { date: '2026-08-14', amount: 30 * M },
      ],
      callsInPeriod: 30 * M,
      distributionsInPeriod: 9.5 * M,
    },
    close: null,
    dispositions: {},
    driftThresholdPct: 10,
    ...overrides,
  };
}

describe('close calendar', () => {
  it('finds the period a fund is closing from today', () => {
    expect(periodEndOnOrBefore('QUARTERLY', '2026-11-03')).toBe('2026-09-30');
    expect(periodEndOnOrBefore('MONTHLY', '2026-11-03')).toBe('2026-10-31');
    expect(periodEndOnOrBefore('QUARTERLY', '2026-12-31')).toBe('2026-12-31');
    expect(periodEndOnOrBefore('QUARTERLY', '2027-01-15')).toBe('2026-12-31');
  });

  it('walks back one period', () => {
    expect(comparativeAmount(
      { value: 330, validFrom: '2020-01-01', validTo: '2026-06-30' },
      { validFrom: '2020-01-01', validTo: '9999-12-31' },
    )).toBe(330);
    expect(comparativeAmount(
      { value: 360, validFrom: '2020-01-01', validTo: '9999-12-31' },
      { validFrom: '2020-01-01', validTo: '9999-12-31' },
    )).toBeNull();
    expect(comparativeAmount(null, { validFrom: '2020-01-01', validTo: '9999-12-31' })).toBeNull();
    expect(priorPeriodEnd('QUARTERLY', '2026-09-30')).toBe('2026-06-30');
    expect(priorPeriodEnd('MONTHLY', '2026-03-31')).toBe('2026-02-28');
    expect(priorPeriodEnd('QUARTERLY', '2026-03-31')).toBe('2025-12-31');
  });

  it('adds each cash flow type into its roll-forward bucket', () => {
    expect(cashflowBucket('Principal repayment')).toBe('repayments');
    expect(cashflowBucket('pik-interest')).toBe('pik');
    expect(sumCashflows([
      { type: 'PURCHASE', amount: 12e6 },
      { type: 'FUNDING', amount: 1e6 },
      { type: 'REPAYMENT', amount: 4e6 },
      { type: 'SALE', amount: 2e6 },
      { type: 'INTEREST', amount: 0.6e6 },
      { type: 'FEE', amount: 0.1e6 },
      { type: 'PIK', amount: 0.3e6 },
      { type: 'AMORTIZATION', amount: -0.1e6 },
      { type: 'REALIZED_GAIN', amount: 0.8e6 },
      { type: 'UNREALIZED', amount: -1.2e6 },
      { type: 'DIVIDEND', amount: 5e6 },
    ])).toEqual({
      purchases: 13e6,
      repayments: 4e6,
      sales: 2e6,
      interest: 0.6e6,
      fees: 0.1e6,
      pik: 0.3e6,
      amort: -0.1e6,
      realized: 0.8e6,
      unrealizedChg: -1.2e6,
    });
  });

  it('dates the steps off the certification lag', () => {
    expect(targetDate('2026-09-30', 37)).toBe('2026-11-06');
    expect(stepDue('2026-09-30', 37, 'pack')).toBe('2026-10-27');
    expect(stepDue('2026-09-30', 37, 'val')).toBe('2026-11-02');
    expect(stepDue('2026-10-31', 12, 'certify')).toBe('2026-11-12');
  });
});

describe('statement integrity', () => {
  it('ties every statement and every piece of outside evidence for the sample pack', () => {
    const review = buildReview(input());
    expect(review.checks.map((check) => `${check.id}:${check.result}`)).toEqual([
      'balance:Ties', 'assetsFoot:Ties', 'liabilitiesFoot:Ties', 'equityFoot:Ties', 'opening:Ties', 'rollNav:Ties', 'opsCash:Ties',
      'sleeves:Ties', 'positions:Ties', 'invRoll:Ties', 'cashCf:Ties', 'bank:Ties', 'contribNotice:Ties', 'distNotice:Ties', 'facility:Ties',
    ]);
    expect(review.breaks).toBe(0);
  });

  it('breaks when the bank balance is off and marks missing evidence apart from a break', () => {
    const off = buildReview(input({ evidence: { bank: 21.0 * M, lender: null } }));
    expect(off.checks.find((check) => check.id === 'bank')).toMatchObject({ result: 'Break' });
    expect(off.checks.find((check) => check.id === 'facility')).toMatchObject({ result: 'Missing' });
    expect(off.breaks).toBe(1);
    expect(off.missing).toBe(1);
    expect(off.health).toBe('BLOCKED');
    expect(off.canCertify).toBe(false);
    expect(off.certifyBlock).toMatch(/break/);
  });

  it('does not ask for a lender statement when the fund has no facility', () => {
    const review = buildReview(input({ fund: { ...input().fund, hasFacility: false }, evidence: { bank: 21.4 * M, lender: null } }));
    expect(review.checks.find((check) => check.id === 'facility')).toBeUndefined();
    expect(review.missing).toBe(0);
  });
});

describe('position roll-forward', () => {
  it('walks opening value to ending value and ties to the statements', () => {
    const { roll } = buildReview(input());
    expect(roll.present).toBe(true);
    expect(roll.total[0] / M).toBeCloseTo(427, 6);
    expect(roll.total[10] / M).toBeCloseTo(16.1, 6);
    expect(roll.total[11] / M).toBeCloseTo(435.6, 6);
    expect(roll.total[13]).toBeCloseTo(0, 3);
    expect(roll.ties.filter((tie) => tie.result === 'Break')).toEqual([]);
    expect(roll.tied).toBe(true);
  });

  it('flags a break when a position reports an ending value the walk cannot reach', () => {
    const moved = positions();
    moved[0].roll!.endFv += 2 * M;
    const review = buildReview(input({ positions: moved }));
    expect(review.roll.tied).toBe(false);
    expect(review.steps.find((step) => step.key === 'roll')?.state).toBe('Blocked');
  });
});

describe('review items', () => {
  it('raises the fee, carry, accrual, two marks, and unexplained drift', () => {
    const review = buildReview(input());
    const ids = review.items.map((item) => item.id);
    expect(ids).toContain('fee');
    expect(ids).toContain('perf');
    expect(ids).toContain('int');
    expect(ids.filter((id) => id.startsWith('pos:')).length).toBe(2);
    expect(review.items.find((item) => item.id.startsWith('drift:BS_LIABILITY|accrued expenses'))).toBeDefined();
    expect(review.mgmtFee.recalculated! / M).toBeCloseTo(1.875, 6);
    expect(review.mgmtFee.impliedBase! / M).toBeCloseTo(608, 0);
  });

  it('does not flag drift that a driver in the pack explains', () => {
    const review = buildReview(input());
    const driftIds = review.drift.filter((row) => row.flagged).map((row) => row.label);
    expect(driftIds.some((label) => /Net realized gain/.test(label))).toBe(false);
    expect(driftIds.some((label) => /Asset-based/.test(label))).toBe(false);
    expect(driftIds.some((label) => /Credit facility/.test(label))).toBe(false);
  });

  it('signs the NAV effect so a decision moves the proposed NAV the right way', () => {
    const base = buildReview(input());
    expect(base.items.find((item) => item.id === 'int')!.effect / M).toBeCloseTo(0.3, 6);
    expect(base.items.find((item) => item.id === 'fee')!.effect / M).toBeCloseTo(0.025, 6);
    const adjusted = buildReview(input({ dispositions: { int: { id: 'D1', decision: 'ADJUST', note: 'use ours' } } }));
    expect((adjusted.navProposed! - adjusted.navReported!) / M).toBeCloseTo(0.3, 6);
    expect(adjusted.adjustments).toBe(1);
  });

  it('opens certification only when every item is decided and nothing is with the admin', () => {
    const base = buildReview(input());
    const decisions = Object.fromEntries(base.items.map((item) => [item.id, { id: null, decision: 'ACCEPT' as const, note: '' }]));
    expect(base.canCertify).toBe(false);
    const done = buildReview(input({ dispositions: decisions }));
    expect(done.canCertify).toBe(true);
    const queried = buildReview(input({ dispositions: { ...decisions, fee: { id: null, decision: 'QUERY' as const, note: '' } } }));
    expect(queried.canCertify).toBe(false);
    expect(queried.health).toBe('BLOCKED');
    expect(queried.steps.find((step) => step.key === 'queries')?.state).toBe('Blocked');
  });
});

describe('close health', () => {
  it('waits on the pack when no statement is loaded and calls it late after the due date', () => {
    const review = buildReview(input({ statement: null, lines: [], positions: [], evidence: { bank: null, lender: null } }));
    expect(review.health).toBe('AWAITING_PACK');
    expect(review.healthNote).toBe('Admin pack is late');
    expect(review.readyForRec).toBe(false);
    expect(review.atRisk).toBe(true);
    const early = buildReview(input({ statement: null, lines: [], positions: [], today: '2026-10-05' }));
    expect(early.healthNote).toBe('Waiting on the admin pack');
    expect(early.atRisk).toBe(false);
  });

  it('reports a certified close as certified and not at risk', () => {
    const review = buildReview(input({ close: { id: 'C1', signoff: 'Done', certifiedAt: '2026-11-02', certifiedBy: 'CFO', certifiedNav: 343.8 * M } }));
    expect(review.health).toBe('CERTIFIED');
    expect(review.atRisk).toBe(false);
    expect(review.steps.find((step) => step.key === 'certify')?.state).toBe('Done');
  });

  it('lists every input the rec needs and shows them present for the sample fund', () => {
    const review = buildReview(input());
    expect(review.readiness.map((item) => item.key)).toEqual(['statement', 'prior', 'marks', 'roll', 'bank', 'lender', 'notices', 'terms']);
    expect(review.readyForRec).toBe(true);
  });
});

describe('attribute sources', () => {
  it('points each reported figure at the entity attribute it was read from', () => {
    const review = buildReview(input());
    const net = review.statements.flatMap((statement) => statement.lines).find((line) => line.label === 'Net assets');
    expect(net?.currentSources).toEqual([expect.objectContaining({
      entityId: 'S1', code: 'NAV_BS_NET_16', domainCode: 'NAV_STATEMENT', sourceCode: 'FUND_ADMIN', asOfDate: '2026-09-30',
    })]);
    expect(net?.priorSources.map((source) => source.code)).toEqual(['NAV_BS_NET_16']);
    expect(net?.priorSources[0]).toMatchObject({ entityId: 'S1', sourceCode: 'FUND_ADMIN' });
    expect(review.sources.netIrr[0]).toMatchObject({ entityId: 'F1', code: 'FUND_NET_IRR', domainCode: 'FUND' });
    expect(review.sources.navReported[0]?.code).toBe('NAV_BS_NET_16');
    const balance = review.checks.find((check) => check.id === 'balance');
    expect(balance?.aSources).toHaveLength(2);
    expect(balance?.bSources[0]?.code).toBe('NAV_BS_NET_16');
    expect(review.marks.every((mark) => mark.adminSources[0]?.code === 'POSITION_MARK' && mark.agentSources[0]?.code === 'POSITION_AGENT_MARK')).toBe(true);
    expect(review.mgmtFee.sources.rate[0]?.code).toBe('FUND_MGMT_FEE_RATE_PCT');
    expect(review.steps.find((step) => step.key === 'signoff')?.dueSources[0]?.code).toBe('FUND_CLOSE_LAG_DAYS');
    const lines = statementLines();
    const assets = lines.find((line) => line.label === 'Net assets');
    if (assets) assets.shadow = 343.92 * M;
    const compared = buildReview(input({ lines })).statements.flatMap((statement) => statement.lines).find((line) => line.label === 'Net assets');
    expect(compared?.internal).toBe(343.92 * M);
    expect(compared?.variance).toBeCloseTo(-0.12 * M);
    expect(compared?.internalSources[0]).toMatchObject({ sourceCode: 'INTERNAL', asOfDate: '2026-09-30', code: 'NAV_BS_NET_16' });
  });

  it('opens a comparative at the prior certification and a roll amount on its entity', () => {
    const base = input();
    const review = buildReview(input({
      priorAsOf: '2026-06-30',
      priorKnowledge: '2026-08-06T23:59:59.999Z',
      lines: base.lines,
      positions: positions().map((position, index) => ({
        ...position,
        rollId: `R${index}`,
        rollName: `${position.name} roll`,
        openingFromHistory: { fairValue: true, accrued: true },
      })),
      evidence: { ...base.evidence, bankEntityId: 'BANK1', bankEntityName: 'Custody bank', lenderEntityId: 'LEND1', lenderEntityName: 'Sub line' },
      capital: {
        ...base.capital,
        calls: base.capital.calls.map((call, index) => ({ ...call, id: `CALL${index}`, name: `Call ${index}` })),
        distributions: [{ id: 'DIST1', name: 'September distribution' }],
      },
    }));
    const net = review.statements.flatMap((statement) => statement.lines).find((line) => line.label === 'Net assets');
    expect(net?.priorSources[0]).toMatchObject({
      entityId: 'S1', code: 'NAV_BS_NET_16', sourceCode: 'FUND_ADMIN', asOfDate: '2026-06-30', knowledgeDate: '2026-08-06T23:59:59.999Z',
    });
    const row = review.roll.rows.find((item) => item.name === 'Northwind Logistics');
    expect(row?.sources[0].map((source) => source.code)).toEqual(['MARKET_VALUE', 'ACCRUED_CASH_INTEREST_AMOUNT']);
    expect(row?.sources[0][0]).toMatchObject({ asOfDate: '2026-06-30' });
    expect(row?.sources[1].map((source) => source.code)).toEqual(['ROLL_PURCHASES']);
    expect(row?.sources[1][0]?.entityId).toBe('R0');
    expect(review.accruals[0]?.oursSources[0]?.code).toBe('ROLL_OUR_ACCRUED');
    expect(review.checks.find((check) => check.id === 'bank')?.bSources[0]).toMatchObject({ entityId: 'BANK1', code: 'EVIDENCE_AMOUNT' });
    expect(review.checks.find((check) => check.id === 'distNotice')?.bSources[0]?.entityId).toBe('DIST1');
  });
});

/* An evergreen BDC's 10-Q for June 30, 2026: six months against December 31, 2025, in $ millions. */
function bdcLines(): RecLine[] {
  order = 0;
  return [
    line('BS_ASSET', 'HEADER', 'Assets', null),
    line('BS_ASSET', 'DETAIL', 'Senior secured', null),
    line('BS_ASSET', 'SUBTOTAL', 'Total investments at fair value', 3100.822, 2893.559),
    line('BS_ASSET', 'LINE', 'Cash and equivalents', 65.048, 140.859),
    line('BS_ASSET', 'LINE', 'Interest receivable', 23.96, 21.267),
    line('BS_ASSET', 'LINE', 'Subscriptions receivable', 0, 0.95),
    line('BS_ASSET', 'LINE', 'Receivable for investments sold', 0.559, 1.476),
    line('BS_ASSET', 'LINE', 'Derivative assets', 7.619, 10.981),
    line('BS_ASSET', 'LINE', 'Deferred financing costs', 10.037, 12.197),
    line('BS_ASSET', 'LINE', 'Other assets', 1.118, 0),
    line('BS_ASSET', 'TOTAL', 'Total assets', 3209.163, 3081.289),
    line('BS_LIABILITY', 'LINE', 'Debt and credit facility', 1522.471, 1441.856),
    line('BS_LIABILITY', 'LINE', 'Interest and debt fees payable', 8.329, 9.417),
    line('BS_LIABILITY', 'LINE', 'Payable for investments purchased', 0.248, 3.259),
    line('BS_LIABILITY', 'LINE', 'Distributions payable', 12.516, 13.465),
    line('BS_LIABILITY', 'LINE', 'Accrued management fee', 5.1, 4.753),
    line('BS_LIABILITY', 'LINE', 'Accrued incentive fee', 5.657, 5.391),
    line('BS_LIABILITY', 'LINE', 'Distribution and servicing fees payable', 0.132, 0.124),
    line('BS_LIABILITY', 'LINE', 'Derivative liabilities', 1.118, 0),
    line('BS_LIABILITY', 'LINE', 'Accrued expenses and interest', 6.035, 4.038),
    line('BS_LIABILITY', 'LINE', 'Other liabilities', 5.71, 10.74),
    line('BS_LIABILITY', 'SUBTOTAL', 'Total liabilities', 1567.316, 1493.043),
    line('BS_NET', 'HEADER', 'Net assets', null),
    line('BS_NET', 'LINE', 'Capital contributions', null),
    line('BS_NET', 'LINE', 'Shares at par value', 0.633, 0.591),
    line('BS_NET', 'LINE', 'Additional paid-in capital', 1725.884, 1615.011),
    line('BS_NET', 'LINE', 'Accumulated net investment income and gains', -84.67, -27.356),
    line('BS_NET', 'TOTAL', 'Net assets', 1641.847, 1588.246),
    line('BS_NET', 'TOTAL', 'Total liabilities and net assets', 3209.163, 3081.289),
    line('OPS', 'LINE', 'Cash interest income', 137.614),
    line('OPS', 'LINE', 'PIK interest income', 9.473),
    line('OPS', 'LINE', 'Fee and other income', 3.8),
    line('OPS', 'SUBTOTAL', 'Total investment income', 150.887),
    line('OPS', 'LINE', 'Management fee', 10.11),
    line('OPS', 'LINE', 'Incentive fee', 10.682),
    line('OPS', 'LINE', 'Interest and facility fees', 47.588),
    line('OPS', 'LINE', 'Distribution and servicing fees', 0.778),
    line('OPS', 'SUBTOTAL', 'Total expenses', 76.435),
    line('OPS', 'TOTAL', 'Net investment income', 74.452),
    line('OPS', 'LINE', 'Net realized gain on investments', 0.526),
    line('OPS', 'SUBTOTAL', 'Net realized gain, total', 3.527),
    line('OPS', 'LINE', 'Net change in unrealized appreciation (depreciation)', -57.386),
    line('OPS', 'SUBTOTAL', 'Net change in unrealized, total', -56.047),
    line('OPS', 'TOTAL', 'Net increase in net assets from operations', 21.932),
    line('CHANGES', 'SUBTOTAL', 'Net increase from operations', 21.932),
    line('CHANGES', 'LINE', 'Distributions to investors', -79.246),
    line('CHANGES', 'LINE', 'Capital contributions', 124.203),
    line('CHANGES', 'SUBTOTAL', 'Net increase from share transactions', 110.915),
    line('CHANGES', 'LINE', 'Total increase in net assets', 53.601),
    line('CHANGES', 'LINE', 'Beginning of period', 1588.246),
    line('CHANGES', 'TOTAL', 'End of period', 1641.847),
    line('CASH', 'LINE', 'Net increase in net assets from operations', 21.932),
    line('CASH', 'LINE', 'Net realized gain on investments', -0.526),
    line('CASH', 'LINE', 'Net change in unrealized (appreciation) depreciation', 57.386),
    line('CASH', 'LINE', 'PIK interest income', -8.919),
    line('CASH', 'LINE', 'Net accretion of discount', -4.695),
    line('CASH', 'LINE', 'Other non-cash items', 2.522),
    line('CASH', 'LINE', 'Purchases of investments', -397.021),
    line('CASH', 'LINE', 'Proceeds from sales and repayments', 146.512),
    line('CASH', 'LINE', 'Settlement of derivatives', 4.161),
    line('CASH', 'LINE', 'Increase in interest receivable', -2.694),
    line('CASH', 'LINE', 'Change in unsettled trades', -2.094),
    line('CASH', 'LINE', 'Increase in accrued liabilities', -3.5),
    line('CASH', 'LINE', 'Borrowings and repayments of debt and credit facility', 85.1),
    line('CASH', 'LINE', 'Capital contributions', 142.925),
    line('CASH', 'LINE', 'Distributions paid', -80.193),
    line('CASH', 'LINE', 'Net increase in cash', -75.664),
    line('CASH', 'LINE', 'Effect of exchange rate changes on cash', -0.147),
    line('CASH', 'LINE', 'Beginning of period', 140.859),
    line('CASH', 'TOTAL', 'End of period', 65.048),
  ];
}

function bdcInput(overrides: Partial<RecInput> = {}): RecInput {
  return input({
    fund: {
      id: 'F2', code: 'EX-BDC', name: 'Example Private Credit BDC', strategy: 'Direct lending',
      frequency: 'QUARTERLY', lagDays: 45, commitments: null, feeRatePct: 1.25, prefPct: 5, carryPct: 12.5, catchUpPct: 100,
      netIrr: null, hasFacility: false, capitalModel: 'EVERGREEN', mgmtFeeBasis: 'NET_ASSETS', perfFeeBasis: 'INCOME',
    },
    periodEnd: '2026-06-30',
    priorAsOf: '2025-12-31',
    today: '2026-08-20',
    statement: { id: 'S2', label: 'Example BDC 10-Q', receivedDate: '2026-08-13', certified: false, tolerancePct: 0.5 },
    lines: bdcLines(),
    positions: [],
    adminSchedule: { total: 3100.822 * M, count: 390, sources: [] },
    sourceChecks: {
      total: 200,
      ties: 199,
      checks: [
        { label: 'Schedule of investments, June 30, 2026: total fair value agrees with the balance sheet', where: 'Balance sheet and schedule', reported: 3100.822 * M, computed: 3100.822 * M, difference: 0, result: 'Ties' },
        { label: 'First Lien Debt, Software: fair value adds up', where: 'Schedule of investments, page 17', reported: 7.776 * M, computed: 7.78 * M, difference: -0.004 * M, result: 'Break' },
      ],
    },
    evidence: { bank: null, lender: null },
    capital: { calls: [], callsInPeriod: 0, distributionsInPeriod: 0 },
    ...overrides,
  });
}

describe('a filed 10-Q of an evergreen BDC', () => {
  it('compares six months with the fiscal year end and ties every statement', () => {
    const review = buildReview(bdcInput());
    expect(review.priorPeriodEnd).toBe('2025-12-31');
    expect(review.spanMonths).toBe(6);
    const results = Object.fromEntries(review.checks.map((check) => [check.id, check.result]));
    expect(results).toMatchObject({
      balance: 'Ties', assetsFoot: 'Ties', liabilitiesFoot: 'Ties', equityFoot: 'Ties', opening: 'Ties',
      rollNav: 'Ties', changesFoot: 'Ties', opsCash: 'Ties', schedule: 'Ties', invRoll: 'Ties', cashCf: 'Ties',
      positions: 'Missing', bank: 'Missing',
    });
    // No capital call notices for a fund that issues shares, and no sleeves when the balance sheet has none.
    expect(results.contribNotice).toBeUndefined();
    expect(results.distNotice).toBeUndefined();
    expect(results.sleeves).toBeUndefined();
  });

  it('rolls investments with capitalized PIK and accretion, and cash with the effect of exchange rates', () => {
    const review = buildReview(bdcInput());
    const invRoll = review.checks.find((check) => check.id === 'invRoll')!;
    expect(invRoll.label).toMatch(/accretion/);
    expect(invRoll.difference! / M).toBeCloseTo(0, 6);
    const cash = review.checks.find((check) => check.id === 'cashCf')!;
    expect(cash.a! / M).toBeCloseTo(65.048, 6);
  });

  it('reports the report\'s own failing check as a break with both figures, and says how many tie', () => {
    const review = buildReview(bdcInput());
    const own = review.checks.filter((check) => check.origin === 'report');
    expect(own.map((check) => check.result)).toEqual(['Ties', 'Break']);
    expect(review.breaks).toBe(1);
    const readiness = review.readiness.find((item) => item.key === 'report')!;
    expect(readiness).toMatchObject({ ok: false, required: false });
    expect(readiness.detail).toMatch(/199 of 200/);
  });

  it('recalculates the management fee on average net assets for the span, and the incentive fee on income over the hurdle', () => {
    const review = buildReview(bdcInput());
    expect(review.mgmtFee.basis).toBe('NET_ASSETS');
    expect(review.mgmtFee.share).toBe(0.5);
    expect(review.mgmtFee.recalculated! / M).toBeCloseTo((1641.847 + 1588.246) / 2 * 0.0125 * 0.5, 6);
    expect(review.items.some((item) => item.id === 'fee')).toBe(false);
    expect(review.perfFee.basis).toBe('INCOME');
    expect(review.perfFee.profit / M).toBeCloseTo(74.452 + 10.682 + 0.778, 6);
    expect(review.perfFee.hurdle / M).toBeCloseTo(1588.246 * 0.05 * 0.5, 6);
    expect(review.perfFee.carry / M).toBeCloseTo(0.125 * (74.452 + 10.682 + 0.778), 6);
    const perf = review.items.find((item) => item.id === 'perf')!;
    expect(perf.title).toBe('Incentive fee on income');
    expect(perf.effect / M).toBeCloseTo(10.682 - 0.125 * 85.912, 6);
    expect(perf.why).toMatch(/quarterly incentive fee calculation/);
  });

  it('does not ask for notices or commitments, and does not flag working capital the cash flow statement explains', () => {
    const review = buildReview(bdcInput());
    expect(review.readiness.find((item) => item.key === 'notices')).toMatchObject({ required: false });
    expect(review.readiness.find((item) => item.key === 'terms')).toMatchObject({ ok: true });
    const flagged = review.drift.filter((row) => row.flagged).map((row) => row.label.replace(/^[^:]+: /, ''));
    expect(flagged).not.toEqual(expect.arrayContaining(['Receivable for investments sold', 'Payable for investments purchased', 'Accrued expenses and interest', 'Other liabilities', 'Deferred financing costs', 'Derivative assets', 'Subscriptions receivable']));
    expect(review.drift.find((row) => row.label.endsWith('Payable for investments purchased'))!.explained).toMatch(/Ties to the cash flow/);
  });

  it('shows only the chart lines the statement has, with their headings', () => {
    const review = buildReview(bdcInput());
    const balance = review.statements.find((statement) => statement.kind === 'BS')!;
    expect(balance.lines.map((row) => row.label)).not.toContain('Senior secured');
    expect(balance.lines.map((row) => row.label)).not.toContain('Capital contributions');
    expect(balance.lines[0].label).toBe('Assets');
    const kept = visibleLines(bdcLines().filter((row) => row.statement === 'BS_NET'));
    expect(kept.map((row) => row.label)).toEqual(['Net assets', 'Shares at par value', 'Additional paid-in capital', 'Accumulated net investment income and gains', 'Net assets', 'Total liabilities and net assets']);
  });

  it('counts the months between period ends', () => {
    expect(monthSpan('2025-12-31', '2026-06-30')).toBe(6);
    expect(monthSpan('2026-06-30', '2026-09-30')).toBe(3);
  });
});

describe('the break summary', () => {
  it('lists each break, missing figure, open item and gap with both figures, the cause, the next step and the owner', () => {
    const summary = summarizeBreaks({ ...buildReview(bdcInput()), fundCode: 'EX-BDC' });
    expect(summary.counts).toMatchObject({ breaks: 1, missing: 2 });
    const report = summary.entries.find((entry) => entry.kind === 'break')!;
    expect(report).toMatchObject({ title: 'First Lien Debt, Software: fair value adds up', owner: 'Fund administrator', blocking: true });
    expect(report.difference! / M).toBeCloseTo(-0.004, 6);
    expect(summary.entries.find((entry) => entry.id === 'positions')).toMatchObject({ kind: 'missing', owner: 'Portfolio accountant' });
    expect(summary.entries.find((entry) => entry.id === 'perf')).toMatchObject({ kind: 'item', owner: 'Fund accountant' });
    // The bank is already named by its missing check, so it is not listed again as an input not on file.
    expect(summary.entries.some((entry) => entry.kind === 'gap' && entry.title === 'Bank cash statement')).toBe(false);
    expect(summary.entries.find((entry) => entry.id === 'gap:roll')).toMatchObject({ kind: 'gap', owner: 'Portfolio accountant' });
    expect(summary.markdown).toMatch(/199 of 200 of the report's own subtotals/);
    expect(summary.headline).toMatch(/^Example Private Credit BDC, Q2 2026: 1 break and \d+ open review items?\./);
    expect(summary.markdown).toMatch(/### Breaks\n1\. \*\*First Lien Debt, Software: fair value adds up\.\*\* \$7\.78M against \$7\.78M, difference −\$0\.004M\./);
    expect(summary.markdown).toMatch(/compared with 2025-12-31 \(6 months\)/);
    expect(summary.tied).toContain('Asset lines add up to total assets');
  });

  it('says a fund ties when nothing breaks and nothing is open', () => {
    const clean = bdcInput({ sourceChecks: null, fund: { ...bdcInput().fund, perfFeeBasis: 'WATERFALL', carryPct: null } });
    const review = buildReview(clean);
    const summary = summarizeBreaks({ ...review, items: [] });
    expect(summary.counts.breaks).toBe(0);
    expect(summary.headline).toMatch(/ties for Q2 2026/);
  });
});
