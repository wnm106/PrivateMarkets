import { describe, expect, it } from 'vitest';
import {
  buildSeriesRows,
  effectiveControls,
  expandLayout,
  periodsBetween,
  recentPeriods,
  type SeriesAttribute,
  type SeriesObservation,
} from './display-layout';

const revenue: SeriesAttribute = {
  attributeCode: 'REVENUE',
  attributeName: 'Revenue',
  reportingGrain: 'QUARTERLY',
  periodRollup: 'SUM',
};
const cash: SeriesAttribute = {
  attributeCode: 'CASH',
  attributeName: 'Cash',
  reportingGrain: 'QUARTERLY',
  periodRollup: 'PERIOD_END',
};

function observation(
  attributeCode: string,
  periodEnd: string,
  periodGrain: SeriesObservation['periodGrain'],
  value: string,
  statementBasis = 'ACTUAL',
): SeriesObservation {
  return { attributeCode, periodEnd, periodGrain, value, statementBasis, entityId: 'issuer' };
}

const quarters: SeriesObservation[] = [
  observation('REVENUE', '2025-04-30', 'QUARTERLY', '10'),
  observation('REVENUE', '2025-07-31', 'QUARTERLY', '20'),
  observation('REVENUE', '2025-10-31', 'QUARTERLY', '30'),
  observation('REVENUE', '2026-01-31', 'QUARTERLY', '40'),
  observation('REVENUE', '2026-01-31', 'ANNUAL', '95', 'ACTUAL'),
  observation('CASH', '2025-04-30', 'QUARTERLY', '5'),
  observation('CASH', '2026-01-31', 'QUARTERLY', '8'),
  observation('REVENUE', '2026-01-31', 'ANNUAL', '100', 'AUDIT'),
];

describe('fiscal periods', () => {
  it('builds quarter ends from a January fiscal year end', () => {
    const periods = periodsBetween('QUARTERLY', 1, '2025-02-01', '2026-01-31');
    expect(periods.map((period) => period.label)).toEqual([
      'Q1 FY2026',
      'Q2 FY2026',
      'Q3 FY2026',
      'Q4 FY2026',
    ]);
    expect(periods.map((period) => period.periodEnd)).toEqual([
      '2025-04-30',
      '2025-07-31',
      '2025-10-31',
      '2026-01-31',
    ]);
  });

  it('keeps the latest period ends on or before the as-of date', () => {
    const periods = recentPeriods('QUARTERLY', 12, '2026-03-31', 2);
    expect(periods.map((period) => period.periodEnd)).toEqual(['2025-12-31', '2026-03-31']);
  });
});

describe('series shaping', () => {
  const controls = effectiveControls([], { viewGrain: 'QUARTERLY', statementBasis: 'ACTUAL', presentation: 'AS_REPORTED' }, 'QUARTERLY');

  it('shows a quarter-end fact only on that month in a monthly view', () => {
    const periods = periodsBetween('MONTHLY', 1, '2025-12-01', '2026-01-31');
    const rows = buildSeriesRows([revenue], quarters, periods, { ...controls, viewGrain: 'MONTHLY' }, 1);
    const byEnd = Object.fromEntries(rows[0].cells.map((cell) => [cell.periodEnd, cell.value]));
    expect(byEnd['2025-12-31']).toBeNull();
    expect(byEnd['2026-01-31']).toBe('40');
  });

  it('uses the reported quarter in a quarterly view and the published year in a yearly view', () => {
    const quarterly = periodsBetween('QUARTERLY', 1, '2026-01-01', '2026-01-31');
    const yearly = periodsBetween('ANNUAL', 1, '2026-01-01', '2026-01-31');
    expect(buildSeriesRows([revenue], quarters, quarterly, controls, 1)[0].cells[0].value).toBe('40');
    expect(buildSeriesRows([revenue], quarters, yearly, { ...controls, viewGrain: 'ANNUAL' }, 1)[0].cells[0].value).toBe('95');
  });

  it('sums quarters into a year when no annual observation exists and keeps cash at year end', () => {
    const yearly = periodsBetween('ANNUAL', 1, '2026-01-01', '2026-01-31');
    const withoutAnnual = quarters.filter((item) => item.periodGrain !== 'ANNUAL');
    const rows = buildSeriesRows([revenue, cash], withoutAnnual, yearly, { ...controls, viewGrain: 'ANNUAL' }, 1);
    expect(rows[0].cells[0].value).toBe('100');
    expect(rows[1].cells[0].value).toBe('8');
  });

  it('sums a complete trailing year and leaves LTM empty when a quarter is missing', () => {
    const period = periodsBetween('QUARTERLY', 1, '2026-01-01', '2026-01-31');
    const ltm = { ...controls, presentation: 'LTM' as const };
    expect(buildSeriesRows([revenue], quarters, period, ltm, 1)[0].cells[0].value).toBe('100');
    expect(buildSeriesRows([revenue], quarters, period, ltm, 1)[0].cells[0].readOnly).toBe(true);
    const missing = quarters.filter((item) => item.periodEnd !== '2025-07-31');
    expect(buildSeriesRows([revenue], missing, period, ltm, 1)[0].cells[0].value).toBeNull();
    expect(buildSeriesRows([cash], quarters, period, ltm, 1)[0].cells[0].value).toBe('8');
  });

  it('filters to the selected statement basis', () => {
    const yearly = periodsBetween('ANNUAL', 1, '2026-01-01', '2026-01-31');
    const audit = { ...controls, viewGrain: 'ANNUAL' as const, statementBasis: ['AUDIT'] };
    expect(buildSeriesRows([revenue], quarters, yearly, audit, 1)[0].cells[0].value).toBe('100');
  });
});

describe('layout controls', () => {
  it('lets one financial type set grain, presentation, and basis', () => {
    const controls = effectiveControls([], { financialType: 'AUDIT' }, 'QUARTERLY');
    expect(controls.viewGrain).toBe('ANNUAL');
    expect(controls.presentation).toBe('AS_REPORTED');
    expect(controls.statementBasis).toEqual(['AUDIT']);
  });

  it('keeps an explicit frequency when a financial type is also selected', () => {
    const controls = effectiveControls([], { financialType: 'LTM', viewGrain: 'MONTHLY' }, 'QUARTERLY');
    expect(controls.viewGrain).toBe('MONTHLY');
    expect(controls.presentation).toBe('LTM');
  });

  it('places controls and hides sections that do not match', () => {
    const periods = periodsBetween('QUARTERLY', 1, '2026-01-01', '2026-01-31');
    const controls = effectiveControls([], { financialType: 'AUDIT' }, 'QUARTERLY');
    const nodes = expandLayout(
      '<div>{{control financialType}}</div><section data-show-when="statementBasis=AUDIT"><p>Audited</p></section><script>alert(1)</script><table><tr>{{#each periods}}<td>{{REVENUE}}</td>{{/each}}</tr></table>',
      periods,
      controls,
    );
    expect(JSON.stringify(nodes)).toContain('financialType');
    expect(JSON.stringify(nodes)).toContain('Audited');
    expect(JSON.stringify(nodes)).not.toContain('alert');
    expect(JSON.stringify(nodes)).toContain('REVENUE');
  });
});
