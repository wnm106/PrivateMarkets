import { describe, expect, it } from 'vitest';
import { projectPerformance } from './deal-performance';
import { DEAL_OUTPUTS, TRANCHE_OUTPUTS, performanceValues } from './deal-performance-store';

const model = projectPerformance({
  closeDate: '2026-01-15',
  asOfDate: '2026-06-30',
  closed: false,
  holdYears: 3,
  oid: 0.98,
  mark: 1,
  indexRate: 0.043,
  undrawnFeeRate: 0.01,
  pikRate: 0,
  amortizationRate: 0.0025,
  seniorLeverage: 4.5,
  totalLeverage: 5.5,
  fees: { management: 0.0125, expenses: 0.0015, carry: 0.1, hurdle: 0.06 },
  tranches: [
    { id: 'tranche-a', name: 'Term Loan', unfunded: false, hold: 50_000_000, spread: 0.055, draws: [] },
    { id: 'tranche-b', name: 'DDTL', unfunded: true, hold: 10_000_000, spread: 0.055, draws: [{ date: '2026-09-15', amount: 5_000_000, trancheId: 'tranche-b' }] },
  ],
});

describe('performanceValues', () => {
  it('projects a model for the fixture', () => {
    expect(model).not.toBeNull();
  });

  const values = performanceValues('deal-1', model!);
  const find = (entityId: string, code: string) => values.find((value) => value.entityId === entityId && value.code === code);

  it('stores rates in percent points and multiples as plain numbers', () => {
    expect(find('deal-1', 'DEAL_GROSS_IRR')?.numeric).toBeCloseTo((model!.grossIrr as number) * 100, 3);
    expect(find('deal-1', 'DEAL_GROSS_MOIC')?.numeric).toBeCloseTo(model!.grossMoic as number, 3);
    expect(find('deal-1', 'DEAL_GROSS_PROFIT')?.numeric).toBeCloseTo(model!.grossProfit, 1);
  });

  it('stores the end date as a date', () => {
    const end = find('deal-1', 'DEAL_PROJECTION_END_DATE');
    expect(end?.date).toBe(model!.endDate.slice(0, 10));
    expect(end?.numeric).toBeNull();
  });

  it('writes tranche outputs on the tranche, not the deal', () => {
    expect(find('tranche-a', 'TRANCHE_HELD_POSITION')?.numeric).toBe(50_000_000);
    expect(find('deal-1', 'TRANCHE_HELD_POSITION')).toBeUndefined();
    expect(find('deal-1', 'DEAL_HELD_POSITION')?.numeric).toBe(60_000_000);
  });

  it('keeps the bridge and the source lines consistent with profit', () => {
    const n = (code: string) => find('deal-1', code)?.numeric ?? 0;
    expect(n('DEAL_GROSS_PROFIT') + n('DEAL_MGMT_FEE_AMOUNT') + n('DEAL_FUND_EXPENSE_AMOUNT') + n('DEAL_INCENTIVE_FEE_AMOUNT')).toBeCloseTo(n('DEAL_NET_PROFIT'), 0);
    expect(n('DEAL_INCOME_CASH') + n('DEAL_INCOME_PIK') + n('DEAL_INCOME_OID') + n('DEAL_INCOME_MARK')).toBeCloseTo(n('DEAL_GROSS_PROFIT'), 0);
  });

  it('never emits a blank or non-finite value', () => {
    for (const value of values) {
      expect(value.text).not.toBe('');
      if (value.numeric != null) expect(Number.isFinite(value.numeric)).toBe(true);
    }
  });

  it('uses each attribute code once', () => {
    const codes = [...DEAL_OUTPUTS, ...TRANCHE_OUTPUTS].map((output) => output.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
