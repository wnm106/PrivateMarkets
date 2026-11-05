import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CASH_RULES,
  buildCashRec,
  clearingAdjustment,
  inBusinessWindow,
  settlementAmount,
  shiftBusinessDays,
  type BankTxnFact,
  type CashFlowFact,
  type CashRecInput,
} from './cash-rec';

const day = '2026-09-30';

function flow(code: string, positionId: string, type: string, amount: number, date = day): CashFlowFact {
  return {
    id: code, code, name: code, positionId, positionName: positionId, type, date, amount,
  };
}

function txn(code: string, amount: number, date = day): BankTxnFact {
  return {
    id: code, code, accountId: 'ACCT', date, amount, description: code, counterparty: '', reference: '',
  };
}

function input(flows: CashFlowFact[], transactions: BankTxnFact[], extra: Partial<CashRecInput> = {}): CashRecInput {
  return {
    fundId: 'F', fundCode: 'F', fundName: 'Fund', clientId: 'C', periodEnd: day, priorPeriodEnd: '2026-06-30',
    accounts: [{ id: 'ACCT', code: 'ACCT', name: 'Operating', bankName: 'JPM', accountNumber: '1' }],
    flows, transactions, rules: DEFAULT_CASH_RULES.map((rule) => ({ ...rule })), adjustments: [], locked: [],
    ...extra,
  };
}

describe('business-day window', () => {
  it('skips the weekend when it steps one business day', () => {
    expect(shiftBusinessDays('2026-09-25', 1)).toBe('2026-09-28');
    expect(shiftBusinessDays('2026-09-30', -3)).toBe('2026-09-25');
    expect(inBusinessWindow('2026-09-30', '2026-10-01', 1, 1)).toBe(true);
    expect(inBusinessWindow('2026-09-25', '2026-09-26', 1, 1)).toBe(false);
  });
});

describe('settlement amount', () => {
  it('treats a purchase as cash out and leaves valuation flows off the bank rec', () => {
    expect(settlementAmount('PURCHASE', 12_000_000)).toBe(-12_000_000);
    expect(settlementAmount('Interest', 1_400_000)).toBe(1_400_000);
    expect(settlementAmount('REALIZED_GAIN', 1_000_000)).toBeNull();
    expect(settlementAmount('PIK', 300_000)).toBeNull();
  });
});

describe('match preference', () => {
  it('pairs an exact date and amount before a dollar variance', () => {
    const rec = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 100)],
      [txn('BTX-A', 100)],
    ));
    expect(rec.matches).toEqual([expect.objectContaining({ kind: 'EXACT', bankTxnId: 'BTX-A', flowIds: ['CF-A'], status: 'PROPOSED' })]);
  });

  it('accepts an exact amount one business day later', () => {
    const rec = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 100, '2026-09-30')],
      [txn('BTX-A', 100, '2026-10-01')],
    ));
    expect(rec.matches[0]).toMatchObject({ kind: 'DATE_DELAY', flowIds: ['CF-A'] });
  });

  it('accepts a same-day amount inside the dollar tolerance', () => {
    const rec = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 600_000)],
      [txn('BTX-A', 595_000)],
    ));
    expect(rec.matches[0]).toMatchObject({ kind: 'DOLLAR_VARIANCE', variance: -5_000 });
  });

  it('accepts an exact amount three business days away', () => {
    const rec = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 800_000, '2026-09-30')],
      [txn('BTX-A', 800_000, '2026-09-25')],
    ));
    expect(rec.matches[0]).toMatchObject({ kind: 'DATE_VARIANCE' });
  });

  it('sums several cash flows on one position before it searches across positions', () => {
    const rec = buildCashRec(input(
      [flow('CF-INT', 'P1', 'INTEREST', 1_600_000), flow('CF-FEE', 'P1', 'FEE', 100_000), flow('CF-OTHER', 'P2', 'INTEREST', 100_000)],
      [txn('BTX-A', 1_700_000)],
    ));
    expect(rec.matches[0]).toMatchObject({ kind: 'MULTI_POSITION', flowIds: ['CF-FEE', 'CF-INT'] });
    expect(rec.flows.find((row) => row.id === 'CF-OTHER')?.status).toBe('OPEN');
  });

  it('pairs cash flows from more than one position to one bank transaction', () => {
    const rec = buildCashRec(input(
      [
        flow('CF-A', 'P1', 'INTEREST', 300_000),
        flow('CF-B', 'P1', 'FEE', 200_000),
        flow('CF-C', 'P2', 'INTEREST', 100_000),
        flow('CF-D', 'P2', 'FEE', 200_000),
      ],
      [txn('BTX-A', 800_000)],
    ));
    expect(rec.matches[0]).toMatchObject({ kind: 'MULTI', flowIds: ['CF-A', 'CF-B', 'CF-C', 'CF-D'] });
  });

  it('uses each cash flow once, earliest bank date and code first', () => {
    const rec = buildCashRec(input(
      [flow('CF-07-FEE', 'P7', 'FEE', 300_000), flow('CF-11-INT', 'P11', 'INTEREST', 300_000)],
      [txn('BTX-10', 300_000)],
    ));
    expect(rec.matches[0]?.flowIds).toEqual(['CF-07-FEE']);
    expect(rec.summary.openFlowCount).toBe(1);
  });

  it('keeps an approved pair and does not propose those items again', () => {
    const rec = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 100), flow('CF-B', 'P1', 'FEE', 40)],
      [txn('BTX-A', 100), txn('BTX-B', 40)],
      { locked: [{ id: 'M1', kind: 'MANUAL', bankTxnId: 'BTX-A', flowIds: ['CF-A'] }] },
    ));
    expect(rec.matches.map((match) => match.status)).toEqual(['APPROVED', 'PROPOSED']);
    expect(rec.transactions.find((row) => row.id === 'BTX-A')?.status).toBe('APPROVED');
  });
});

describe('tie-out', () => {
  it('ties when a bank adjustment closes the residual', () => {
    const open = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 1_000)],
      [txn('BTX-A', 950)],
    ));
    expect(open.summary.tied).toBe(false);
    expect(open.summary.residual).toBe(50);
    expect(clearingAdjustment(open.summary.residual)).toEqual({ amount: 50, side: 'BANK' });
    const tied = buildCashRec(input(
      [flow('CF-A', 'P1', 'INTEREST', 1_000)],
      [txn('BTX-A', 950)],
      { adjustments: [{ id: 'ADJ', amount: 50, side: 'BANK', reason: 'Wire fee', status: 'POSTED' }] },
    ));
    expect(tied.summary.tied).toBe(true);
    expect(tied.summary.positionTied).toBe(tied.summary.bankTied);
  });
});

describe('Halyard quarter', () => {
  const flows: CashFlowFact[] = [
    flow('CF-01-REPAY', 'P01', 'REPAYMENT', 15_000_000),
    flow('CF-01-INT', 'P01', 'INTEREST', 1_700_000),
    flow('CF-02-INT', 'P02', 'INTEREST', 1_400_000),
    flow('CF-03-PUR', 'P03', 'PURCHASE', -12_000_000),
    flow('CF-03-INT', 'P03', 'INTEREST', 1_600_000),
    flow('CF-03-FEE', 'P03', 'FEE', 100_000),
    flow('CF-04-INT', 'P04', 'INTEREST', 1_200_000),
    flow('CF-05-REPAY', 'P05', 'REPAYMENT', 8_000_000),
    flow('CF-05-INT', 'P05', 'INTEREST', 1_200_000),
    flow('CF-06-INT', 'P06', 'INTEREST', 1_300_000),
    flow('CF-07-PUR', 'P07', 'PURCHASE', -10_200_000),
    flow('CF-07-INT', 'P07', 'INTEREST', 1_000_000),
    flow('CF-07-FEE', 'P07', 'FEE', 300_000),
    flow('CF-08-SALE', 'P08', 'SALE', 12_000_000),
    flow('CF-08-INT', 'P08', 'INTEREST', 1_200_000),
    flow('CF-09-INT', 'P09', 'INTEREST', 800_000),
    flow('CF-10-INT', 'P10', 'INTEREST', 600_000),
    flow('CF-11-PUR', 'P11', 'PURCHASE', -14_000_000),
    flow('CF-11-INT', 'P11', 'INTEREST', 300_000),
    flow('CF-11-FEE', 'P11', 'FEE', 200_000),
    flow('CF-12-PUR', 'P12', 'PURCHASE', -8_000_000),
    flow('CF-12-INT', 'P12', 'INTEREST', 100_000),
    flow('CF-12-FEE', 'P12', 'FEE', 200_000),
  ];

  const transactions: BankTxnFact[] = [
    txn('BTX-01', -12_000_000),
    txn('BTX-02', -10_200_000),
    txn('BTX-03', -14_000_000),
    txn('BTX-04', -8_000_000),
    txn('BTX-05', 15_000_000),
    txn('BTX-06', 1_400_000),
    txn('BTX-07', 1_600_000),
    txn('BTX-08', 100_000),
    txn('BTX-09', 1_000_000),
    txn('BTX-10', 300_000),
    txn('BTX-11', 9_200_000),
    txn('BTX-12', 13_200_000),
    txn('BTX-13', 800_000, '2026-09-25'),
    txn('BTX-14', 595_000),
    txn('BTX-15', 800_000),
    txn('BTX-16', 1_300_000, '2026-10-01'),
    txn('BTX-17', 2_847_650),
  ];

  it('matches each rule and ties with the bank adjustment', () => {
    const rec = buildCashRec(input(flows, transactions, {
      adjustments: [{ id: 'ADJ', amount: 57_350, side: 'BANK', reason: 'Wire fee and unidentified wire', status: 'POSTED' }],
    }));
    const kind = Object.fromEntries(rec.matches.map((match) => [match.bankTxnId, match.kind]));
    expect(kind['BTX-06']).toBe('EXACT');
    expect(kind['BTX-16']).toBe('DATE_DELAY');
    expect(kind['BTX-14']).toBe('DOLLAR_VARIANCE');
    expect(kind['BTX-13']).toBe('DATE_VARIANCE');
    expect(kind['BTX-11']).toBe('MULTI_POSITION');
    expect(kind['BTX-12']).toBe('MULTI_POSITION');
    expect(kind['BTX-15']).toBe('MULTI');
    expect(rec.matches.find((match) => match.bankTxnId === 'BTX-10')?.flowIds).toEqual(['CF-07-FEE']);
    expect(rec.matches.find((match) => match.bankTxnId === 'BTX-15')?.flowIds).toEqual(['CF-11-FEE', 'CF-11-INT', 'CF-12-FEE', 'CF-12-INT']);
    expect(rec.flows.filter((row) => row.status === 'OPEN').map((row) => row.code)).toEqual(['CF-01-INT', 'CF-04-INT']);
    expect(rec.transactions.filter((row) => row.status === 'OPEN').map((row) => row.code)).toEqual(['BTX-17']);
    expect(rec.summary.openFlowAmount).toBe(2_900_000);
    expect(rec.summary.residual).toBe(0);
    expect(rec.summary.tied).toBe(true);
  });
});
