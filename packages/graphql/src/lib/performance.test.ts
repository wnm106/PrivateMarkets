import { describe, expect, it } from 'vitest';
import { xirr } from './calc-engine';
import { accountLeg, groupBook, pool, positionLeg, standardWindows, windowStart, type BookAccount, type BookPosition } from './performance';
import { resolveWindows } from './performance-store';

describe('pool', () => {
  it('matches the formula for one position over its life', () => {
    const flows = [{ date: '2024-01-01', amount: -100 }, { date: '2024-07-01', amount: 5 }, { date: '2025-01-01', amount: 5 }];
    const m = pool([positionLeg(flows, { start: null, end: '2025-12-31' }, null, 104)]);
    expect(m.paidIn).toBe(100);
    expect(m.distributed).toBe(10);
    expect(m.closing).toBe(104);
    expect(m.moic).toBeCloseTo(1.14, 10);
    expect(m.dpi).toBeCloseTo(0.1, 10);
    expect(m.rvpi).toBeCloseTo(1.04, 10);
    expect(m.gain).toBe(14);
    expect(m.irr).toBe(xirr(['2024-01-01', '2024-07-01', '2025-01-01', '2025-12-31'], [-100, 5, 5, 104]));
  });

  it('opens a window with the market value on the start day and leaves out flows on that day', () => {
    const flows = [{ date: '2024-01-01', amount: -100 }, { date: '2024-12-31', amount: 7 }, { date: '2025-06-30', amount: 4 }];
    const leg = positionLeg(flows, { start: '2024-12-31', end: '2025-12-31' }, 101, 102);
    expect(leg.open).toEqual({ date: '2024-12-31', value: 101 });
    expect(leg.flows).toEqual([{ date: '2025-06-30', amount: 4 }]);
    const m = pool([leg]);
    expect(m.paidIn).toBe(101);
    expect(m.moic).toBeCloseTo(106 / 101, 10);
  });

  it('pools legs rather than averaging their returns', () => {
    const a = positionLeg([{ date: '2024-01-01', amount: -100 }], { start: null, end: '2025-01-01' }, null, 120);
    const b = positionLeg([{ date: '2024-01-01', amount: -300 }], { start: null, end: '2025-01-01' }, null, 300);
    const m = pool([a, b]);
    expect(m.moic).toBeCloseTo(420 / 400, 10);
    expect(m.legs).toBe(2);
  });

  it('gives no figures for an empty pool', () => {
    expect(pool([]).moic).toBeNull();
    expect(pool([{ flows: [] }]).legs).toBe(0);
  });
});

describe('accountLeg', () => {
  const statements = [
    { periodEnd: '2024-06-30', contributions: 10, distributions: 0, closing: 10.2 },
    { periodEnd: '2024-09-30', contributions: 5, distributions: 1, closing: 14.6 },
    { periodEnd: '2024-12-31', contributions: 0, distributions: 2, closing: 13.1 },
  ];
  it('dates contributions and distributions at the period end and closes on the last statement', () => {
    const leg = accountLeg(statements, { start: null, end: '2025-01-15' });
    expect(leg.open).toBeNull();
    expect(leg.close).toEqual({ date: '2024-12-31', value: 13.1 });
    const m = pool([leg]);
    expect(m.paidIn).toBe(15);
    expect(m.distributed).toBe(3);
    expect(m.moic).toBeCloseTo(16.1 / 15, 10);
  });
  it('opens a window with the closing balance of the last statement before it', () => {
    const leg = accountLeg(statements, { start: '2024-09-30', end: '2025-01-15' });
    expect(leg.open).toEqual({ date: '2024-09-30', value: 14.6 });
    expect(leg.flows).toEqual([{ date: '2024-12-31', amount: 2 }]);
  });
  it('has nothing to measure when no statement falls inside the window', () => {
    expect(accountLeg(statements, { start: '2024-12-31', end: '2025-02-01' })).toEqual({ flows: [] });
  });
});

describe('windows', () => {
  it('starts each window on the day before the period, as the formula does', () => {
    expect(windowStart('YTD', '2026-11-27')).toBe('2025-12-31');
    expect(windowStart('QTD', '2026-11-27')).toBe('2026-09-30');
    expect(windowStart('MTD', '2026-11-27')).toBe('2026-10-31');
    expect(windowStart('LTM', '2026-11-27')).toBe('2025-11-27');
    expect(standardWindows('2026-11-27').map((w) => w.key)).toEqual(['ITD', 'LTM', 'YTD', 'QTD']);
  });
  it('never lets a window end after the As Of date', () => {
    const [w] = resolveWindows([{ key: 'X', startDate: '2025-01-01', endDate: '2027-01-01' }], '2026-11-27');
    expect(w.end).toBe('2026-11-27');
    expect(w.start).toBe('2025-01-01');
  });
});

describe('groupBook', () => {
  const positions: BookPosition[] = [
    { id: 'p1', fundId: 'f1', dealId: 'd1', sector: 'Healthcare', flows: [{ date: '2024-01-01', amount: -100 }], values: { '2025-12-31': 110 } },
    { id: 'p2', fundId: 'f2', dealId: 'd1', sector: 'Healthcare', flows: [{ date: '2024-01-01', amount: -50 }], values: { '2025-12-31': 60 } },
    { id: 'p3', fundId: 'f2', dealId: null, sector: null, flows: [{ date: '2024-01-01', amount: -10 }], values: { '2025-12-31': 9 } },
  ];
  const accounts: BookAccount[] = [
    { id: 'i1|f1', investorId: 'i1', fundId: 'f1', statements: [{ periodEnd: '2024-03-31', contributions: 20, distributions: 0, closing: 21 }] },
  ];
  const window = { key: 'ITD', label: 'Inception to date', start: null, end: '2025-12-31' };
  const familyOf = (id: string) => (id === 'f1' || id === 'f2' ? 'fam' : id);

  it('pools a deal across funds and splits it by fund', () => {
    const { groups } = groupBook({ positions, accounts, familyOf, window });
    const deal = groups.find((g) => g.dimension === 'DEAL' && g.key === 'd1')!;
    expect(deal.gross!.moic).toBeCloseTo(170 / 150, 10);
    expect(groups.filter((g) => g.dimension === 'DEAL_FUND').map((g) => g.key).sort()).toEqual(['d1|f1', 'd1|f2']);
  });

  it('rolls vehicles into their family, gross and net', () => {
    const { groups } = groupBook({ positions, accounts, familyOf, window });
    const family = groups.find((g) => g.dimension === 'FAMILY')!;
    expect(family.positionIds.sort()).toEqual(['p1', 'p2', 'p3']);
    expect(family.net!.moic).toBeCloseTo(21 / 20, 10);
    expect(groups.find((g) => g.dimension === 'SECTOR' && g.key === 'Unclassified')!.positionIds).toEqual(['p3']);
  });

  it('applies include and exclude filters, and leaves net out under a deal or sector filter', () => {
    const bySector = groupBook({ positions, accounts, familyOf, window, filter: { excludeSectors: ['Healthcare'] } });
    expect(bySector.total.positionIds).toEqual(['p3']);
    expect(bySector.total.net).toBeNull();
    const byFund = groupBook({ positions, accounts, familyOf, window, filter: { includeFundIds: ['f1'] } });
    expect(byFund.total.positionIds).toEqual(['p1']);
    expect(byFund.total.net!.legs).toBe(1);
    const byDeal = groupBook({ positions, accounts, familyOf, window, filter: { includeDealIds: ['d1'], excludeFundIds: ['f2'] } });
    expect(byDeal.total.positionIds).toEqual(['p1']);
  });
});

describe('legs with nothing put in', () => {
  it('leaves out a value with no money in, and counts it', () => {
    const funded = positionLeg([{ date: '2024-01-01', amount: -100 }], { start: null, end: '2025-01-01' }, null, 110);
    const free = positionLeg([], { start: null, end: '2025-01-01' }, null, 5000);
    const m = pool([funded, free]);
    expect(m.moic).toBeCloseTo(1.1, 10);
    expect(m.legs).toBe(1);
    expect(m.excluded).toBe(1);
  });
  it('keeps a windowed leg that opened with a value', () => {
    const leg = positionLeg([], { start: '2024-12-31', end: '2025-06-30' }, 100, 103);
    expect(pool([leg]).moic).toBeCloseTo(1.03, 10);
  });
});
