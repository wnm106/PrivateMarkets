import { describe, expect, it } from 'vitest';
import { DEFAULT_CASH_RULES, buildCashRec, type BankTxnFact, type CashFlowFact, type CashRecInput } from './cash-rec';
import { buildReview, type RecInput } from './fund-rec';
import { cashPairing, decisionProblem } from './rec-actions';
import { cashDigest, navDigest, positionDigest, recOutcome } from './rec-digest';

const day = '2026-09-30';

function flow(code: string, type: string, amount: number, date = day): CashFlowFact {
  return { id: code, code, name: code, positionId: 'P1', positionName: 'Position one', type, date, amount };
}

function txn(code: string, amount: number, date = day): BankTxnFact {
  return { id: code, code, accountId: 'ACCT', date, amount, description: code, counterparty: '', reference: '' };
}

function cash(flows: CashFlowFact[], transactions: BankTxnFact[], extra: Partial<CashRecInput> = {}) {
  return buildCashRec({
    fundId: 'F', fundCode: 'HSCF2', fundName: 'Fund', clientId: 'C', periodEnd: day, priorPeriodEnd: '2026-06-30',
    accounts: [{ id: 'ACCT', code: 'ACCT', name: 'Operating', bankName: 'JPM', accountNumber: '1' }],
    flows, transactions, rules: DEFAULT_CASH_RULES.map((rule) => ({ ...rule })), adjustments: [], locked: [],
    ...extra,
  });
}

function review(extra: Partial<RecInput> = {}) {
  return buildReview({
    fund: {
      id: 'F', code: 'HSCF2', name: 'Fund', strategy: 'Direct lending', frequency: 'QUARTERLY', lagDays: 37,
      commitments: null, feeRatePct: null, prefPct: null, carryPct: null, catchUpPct: null, netIrr: null, hasFacility: false,
    },
    periodEnd: day,
    today: '2026-10-20',
    statement: null,
    lines: [],
    positions: [],
    evidence: { bank: null, lender: null },
    capital: { calls: [], callsInPeriod: 0, distributionsInPeriod: 0 },
    close: null,
    dispositions: {},
    driftThresholdPct: 10,
    ...extra,
  });
}

describe('decisionProblem', () => {
  it('needs a note for an adjustment or a query, and none to accept', () => {
    expect(decisionProblem({ decision: 'ACCEPT' })).toBeNull();
    expect(decisionProblem({ decision: 'ADJUST', note: ' ' })).toMatch(/adjustment needs a note/);
    expect(decisionProblem({ decision: 'QUERY' })).toMatch(/question for the administrator/);
    expect(decisionProblem({ decision: 'QUERY', note: 'Why is the fee base 410m?' })).toBeNull();
    expect(decisionProblem({ decision: 'CERTIFY' })).toMatch(/ACCEPT, ADJUST, or QUERY/);
  });
});

describe('cashPairing', () => {
  it('keeps the rule and confidence of a pair the rules already propose', () => {
    const rec = cash([flow('CF-A', 'INTEREST', 100)], [txn('BTX-A', 100)]);
    const proposed = rec.matches[0];
    expect(proposed.status).toBe('PROPOSED');
    expect(cashPairing(rec, 'BTX-A', ['CF-A'])).toEqual({ kind: proposed.kind, confidence: proposed.confidence, variance: proposed.variance });
  });

  it('records any other pair as manual, with the variance between the two sides', () => {
    const rec = cash([flow('CF-A', 'INTEREST', 100), flow('CF-B', 'FEE', 40, '2026-08-03')], [txn('BTX-A', 150)]);
    expect(cashPairing(rec, 'BTX-A', ['CF-A', 'CF-B', 'CF-A'])).toEqual({ kind: 'MANUAL', confidence: 1, variance: 10 });
  });

  it('refuses a pair that no longer fits the reconciliation', () => {
    const rec = cash(
      [flow('CF-A', 'INTEREST', 100), flow('CF-B', 'INTEREST', 70)],
      [txn('BTX-A', 100), txn('BTX-B', 70)],
      { locked: [{ id: 'M1', kind: 'EXACT', bankTxnId: 'BTX-A', flowIds: ['CF-A'] }] },
    );
    expect(() => cashPairing(rec, 'BTX-A', ['CF-B'])).toThrow(/already paired/);
    expect(() => cashPairing(rec, 'BTX-B', ['CF-A'])).toThrow(/already paired to a bank transaction/);
    expect(() => cashPairing(rec, 'BTX-B', [])).toThrow(/at least one cash flow/);
    expect(() => cashPairing(rec, 'BTX-Z', ['CF-B'])).toThrow(/not in this period/);
    expect(() => cashPairing(rec, 'BTX-B', ['CF-Z'])).toThrow(/CF-Z is not in this period/);
  });
});

describe('cashDigest', () => {
  it('gives each proposed pair the ids an approval needs, and pages what is unmatched', () => {
    const rec = cash(
      [flow('CF-A', 'INTEREST', 100), flow('CF-B', 'INTEREST', 71), flow('CF-C', 'FEE', 5, '2026-07-10')],
      [txn('BTX-A', 100), txn('BTX-X', -900, '2026-08-14')],
    );
    const digest = cashDigest(rec, { limit: 1 });
    expect(digest.proposedMatches).toHaveLength(1);
    expect(digest.proposedMatches[0]).toMatchObject({ bankTxnId: 'BTX-A', flowIds: ['CF-A'], bank: { code: 'BTX-A', amount: 100 } });
    expect(digest.openCashFlows).toHaveLength(1);
    expect(digest.openCashFlowsNotShown).toBe(1);
    expect(digest.openBankTransactions.map((row) => row.bankTxnId)).toEqual(['BTX-X']);
    expect(digest.tied).toBe(false);
    expect(digest.clearingAdjustment).not.toBeNull();
  });

  it('offers no clearing entry when cash ties', () => {
    const digest = cashDigest(cash([flow('CF-A', 'INTEREST', 100)], [txn('BTX-A', 100)]));
    expect(digest.tied).toBe(true);
    expect(digest.clearingAdjustment).toBeNull();
  });
});

describe('navDigest and positionDigest', () => {
  it('keeps the figures and drops the per-figure sources', () => {
    const rec = { ...review(), fundCode: 'HSCF2', priorOpen: true, closeNotes: { notes: '## Outcome', outcome: 'In review.' } };
    const nav = navDigest(rec);
    expect(nav.fund).toMatchObject({ id: 'F', code: 'HSCF2' });
    expect(nav.readyForRec).toBe(false);
    expect(nav.priorPeriodOpen).toBe(true);
    expect(nav.notesOnFile).toEqual({ notes: '## Outcome', outcome: 'In review.' });
    expect(nav.steps.length).toBe(rec.steps.length);
    expect(JSON.stringify(nav)).not.toMatch(/Sources"/);

    const positions = positionDigest(rec);
    expect(positions.rollForwardOnFile).toBe(false);
    expect(positions.positions).toEqual([]);
    expect(JSON.stringify(positions)).not.toMatch(/Sources"/);
  });

  it('says in one line where the reconciliation stands', () => {
    const rec = review();
    expect(recOutcome(rec)).toMatch(/^Not ready to reconcile\./);
    expect(recOutcome(rec)).toMatch(/No position roll-forward on file\./);
    const open = cash([flow('CF-A', 'INTEREST', 100)], []);
    expect(recOutcome(rec, open)).toMatch(/Cash is out by 100\.00, with 1 cash flow and 0 bank transactions unmatched\./);
    expect(recOutcome(rec, cash([flow('CF-A', 'INTEREST', 100)], [txn('BTX-A', 100)]))).toMatch(/Cash ties to the bank\./);
  });
});
