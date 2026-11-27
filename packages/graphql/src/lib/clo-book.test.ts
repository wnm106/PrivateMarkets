import { describe, expect, it } from 'vitest';
import {
  cureAmount, dealPhase, diversityScore, industryScore, quarterEnds, rankOpportunities, runWaterfall, scoreOpportunity, tagRule, toTests,
  type RuleShape, type WaterfallInput,
} from './clo-book';

const TABLE = [
  { units: 0, score: 0 }, { units: 1, score: 1 }, { units: 2, score: 1.5 }, { units: 3, score: 2 }, { units: 4, score: 2.33 },
  { units: 5, score: 2.67 }, { units: 6, score: 3 }, { units: 7, score: 3.25 }, { units: 8, score: 3.5 }, { units: 9, score: 3.75 }, { units: 10, score: 4 },
];

const shape = (ruleCode: string, category: string, lines: RuleShape['lines'], limitTermAttribute: string | null = null): RuleShape => ({ ruleCode, ruleName: ruleCode, category, lines, limitTermAttribute });
const line = (side: string, kind: string, attributeCode: string, conditions: Array<[string, string, string]> = []) => ({
  side, kind, attributeCode, weightAttributeCode: kind === 'WAVG' ? 'FUNDED_PAR_AMOUNT' : null, label: null,
  conditions: conditions.map(([attributeCode, operator, value]) => ({ attributeCode, operator, value })),
});

describe('tagRule', () => {
  it('reads a coverage test and its rank from the limit line', () => {
    const oc = shape('ANY_OC', 'COVERAGE', [line('LIMIT', 'MAX', 'CLO_NOTE_OC_TRIGGER', [['CLO_NOTE_SENIORITY_RANK', 'equals', '3']])]);
    expect(tagRule(oc)).toMatchObject({ metric: 'OC', rank: 3, limitAttribute: 'CLO_NOTE_OC_TRIGGER', limitHolder: 'NOTE' });
    const ic = shape('ANY_IC', 'COVERAGE', [line('LIMIT', 'MAX', 'CLO_NOTE_IC_TRIGGER', [['CLO_NOTE_SENIORITY_RANK', 'equals', '2']])]);
    expect(tagRule(ic)).toMatchObject({ metric: 'IC', rank: 2 });
  });
  it('reads quality metrics from the weighted line and CCC from the line filter', () => {
    expect(tagRule(shape('X', 'COLLATERAL_QUALITY', [line('NUMERATOR', 'WAVG', 'CLO_MOODYS_RATING_FACTOR'), line('LIMIT', 'MAX', 'CLO_MAX_WARF')])).metric).toBe('WARF');
    expect(tagRule(shape('X', 'COLLATERAL_QUALITY', [line('NUMERATOR', 'WAVG', 'SPREAD_BPS')])).metric).toBe('WAS');
    expect(tagRule(shape('X', 'COLLATERAL_QUALITY', [line('NUMERATOR', 'WAVG', 'MATURITY_DATE')])).metric).toBe('WAL');
    expect(tagRule(shape('X', 'CONCENTRATION', [line('NUMERATOR', 'SUM', 'FUNDED_PAR_AMOUNT', [['CLO_IS_CCC', 'equals', 'true']])])).metric).toBe('CCC');
    expect(tagRule(shape('X', 'CONCENTRATION', [line('NUMERATOR', 'SUM', 'FUNDED_PAR_AMOUNT')])).metric).toBeNull();
  });
  it('takes the limit attribute from a limit term when there is no limit line', () => {
    expect(tagRule(shape('X', 'CONCENTRATION', [], 'CLO_MAX_SINGLE_OBLIGOR_PCT'))).toMatchObject({ limitAttribute: 'CLO_MAX_SINGLE_OBLIGOR_PCT', limitHolder: 'TRANSACTION' });
  });
});

describe('toTests', () => {
  it('gives the cushion with the sign of the limit direction', () => {
    const [min, max] = toTests([
      { ruleCode: 'A', ruleName: 'A', groupByValue: null, limitDirection: 'MIN', numeratorValue: 1, denominatorValue: 1, computedValue: 130, softLimitValue: null, hardLimitValue: 120, status: 'PASS', resultUnit: 'PERCENTAGE' },
      { ruleCode: 'B', ruleName: 'B', groupByValue: null, limitDirection: 'MAX', numeratorValue: 1, denominatorValue: 1, computedValue: 3300, softLimitValue: null, hardLimitValue: 3000, status: 'HARD_BREACH', resultUnit: 'RATIO' },
    ], new Map());
    expect(min.cushion).toBe(10);
    expect(max.cushion).toBe(-300);
    expect(max.cushionPct).toBeCloseTo(-10);
  });
});

describe('diversityScore', () => {
  it('interpolates the table and holds the last row', () => {
    expect(industryScore(2.5, TABLE)).toBeCloseTo(1.75);
    expect(industryScore(14, TABLE)).toBe(4);
    expect(industryScore(0, TABLE)).toBe(0);
  });
  it('groups by obligor, caps each obligor at one unit and leaves defaults out', () => {
    const result = diversityScore([
      { obligorKey: 'a', industry: 'X', par: 10, performing: true },
      { obligorKey: 'a', industry: 'X', par: 10, performing: true }, // same group: 20
      { obligorKey: 'b', industry: 'X', par: 10, performing: true },
      { obligorKey: 'c', industry: 'Y', par: 10, performing: true },
      { obligorKey: 'd', industry: 'Y', par: 50, performing: false },
    ], TABLE);
    // average obligor par 40/3; a = 1 unit (capped), b and c = 0.75 each
    expect(result.obligors).toBe(3);
    const x = result.industries.find((i) => i.industry === 'X')!;
    expect(x.units).toBeCloseTo(1.75);
    expect(result.score).toBeCloseTo(industryScore(1.75, TABLE) + industryScore(0.75, TABLE));
  });
});

describe('dealPhase and quarterEnds', () => {
  it('names the phase from the indenture dates', () => {
    const dates = { closing: '2023-01-01', effective: '2023-06-01', reinvestmentEnd: '2027-01-01', maturity: '2035-01-01' };
    expect(dealPhase('2023-03-01', dates)).toBe('Ramp-up');
    expect(dealPhase('2026-01-01', dates)).toBe('Reinvestment');
    expect(dealPhase('2028-01-01', dates)).toBe('Amortization');
  });
  it('lists quarter ends up to the date, and the date itself', () => {
    expect(quarterEnds('2026-11-27', 3)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-11-27']);
    expect(quarterEnds('2026-09-30', 2)).toEqual(['2026-06-30', '2026-09-30']);
  });
});

describe('runWaterfall', () => {
  const notes: WaterfallInput['notes'] = [
    { id: 'a', name: 'A', cls: 'A', rank: 1, par: 600, interestDue: 10, deferrable: false, residual: false },
    { id: 'b', name: 'B', cls: 'B', rank: 2, par: 100, interestDue: 3, deferrable: false, residual: false },
    { id: 'e', name: 'E', cls: 'E', rank: 3, par: 50, interestDue: 4, deferrable: true, residual: false },
    { id: 's', name: 'Sub', cls: 'SUB', rank: 4, par: 100, interestDue: 0, deferrable: false, residual: true },
  ];
  const base: WaterfallInput = {
    interestProceeds: 30, principalProceeds: 5, seniorExpenses: 1, collateralPar: 1000, seniorFeeBps: 20, subFeeBps: 40, periodsPerYear: 4,
    reinvesting: true, notes, coverage: [],
  };
  it('pays expenses, fees, interest in order and leaves the rest to equity', () => {
    const r = runWaterfall(base);
    expect(r.steps.map((s) => s.kind)).toEqual(['EXPENSE', 'FEE', 'INTEREST', 'INTEREST', 'INTEREST', 'FEE', 'RESIDUAL', 'REINVEST']);
    expect(r.paidToNotes).toBe(17);
    // 30 - 1 - 0.5 - 17 - 1 = 10.5
    expect(r.residualToEquity).toBeCloseTo(10.5);
    expect(r.equityCashYieldPct).toBeCloseTo(42);
  });
  it('diverts interest to cure a failing OC test and pays the senior notes down', () => {
    const failing = { metric: 'OC' as const, rank: 3, ruleName: 'Class E OC', value: 100, limit: 105, numerator: 750, denominator: 750, status: 'HARD_BREACH' };
    expect(cureAmount(failing)).toBeCloseTo(750 - 750 / 1.05);
    const r = runWaterfall({ ...base, coverage: [failing] });
    const cure = r.steps.find((s) => s.kind === 'CURE')!;
    expect(cure.paid).toBeCloseTo(Math.min(30 - 1 - 0.5 - 17, 750 - 750 / 1.05));
    expect(r.paydowns[0]).toMatchObject({ cls: 'A' });
    expect(r.residualToEquity).toBeLessThan(10.5);
  });
  it('defers unpaid interest on a deferrable class', () => {
    const r = runWaterfall({ ...base, interestProceeds: 14.5 });
    const e = r.steps.find((s) => s.noteId === 'e')!;
    expect(e.deferred).toBeGreaterThan(0);
    expect(r.shortfall).toBe(0);
  });
  it('pays notes down from principal after the reinvestment period', () => {
    const r = runWaterfall({ ...base, reinvesting: false });
    expect(r.steps.at(-1)!.kind).toBe('PAYDOWN');
    expect(r.paydowns.find((p) => p.cls === 'A')!.amount).toBe(5);
  });
});

describe('scoreOpportunity', () => {
  const shapes = new Map<string, RuleShape>([
    ['W', shape('W', 'COLLATERAL_QUALITY', [line('NUMERATOR', 'WAVG', 'CLO_MOODYS_RATING_FACTOR')])],
    ['C', shape('C', 'CONCENTRATION', [line('NUMERATOR', 'SUM', 'FUNDED_PAR_AMOUNT', [['CLO_IS_CCC', 'equals', 'true']])])],
  ]);
  const lineOf = (ruleCode: string, before: number, after: number, limit: number, verdict: string, approved = true) => ({
    ruleCode, ruleName: ruleCode, groupByValue: null, limitDirection: 'MAX' as const, baselineValue: before, scenarioValue: after,
    baselineStatus: before > limit ? 'HARD_BREACH' : 'PASS', scenarioStatus: after > limit ? 'HARD_BREACH' : 'PASS', hardLimitValue: limit, verdict, approved,
  });
  it('counts cures and scores the gain against the cushion', () => {
    const s = scoreOpportunity([lineOf('W', 2900, 2850, 3000, 'PASS'), lineOf('C', 8, 7.4, 7.5, 'CURED')], shapes, { before: 40, after: 41, limit: 35 });
    expect(s.cures).toBe(1);
    const warf = s.changes.find((c) => c.metric === 'WARF')!;
    expect(warf.gain).toBe(50);
    expect(warf.gainPctOfCushion).toBeCloseTo(50);
    expect(s.changes.find((c) => c.metric === 'DIVERSITY')!.gainPctOfCushion).toBeCloseTo(20);
  });
  it('ranks approved buys first, then cures, then the composition score', () => {
    const mk = (approved: boolean, cures: number, compositionScore: number) => ({ score: { approved, cures, newBreaches: 0, worsensFailing: 0, improvesFailing: 0, changes: [], compositionScore } });
    const ranked = rankOpportunities([mk(false, 3, 90), mk(true, 0, 50), mk(true, 1, 10), { score: null }]);
    expect(ranked.map((r) => r.score?.compositionScore ?? null)).toEqual([10, 50, 90, null]);
  });
});
