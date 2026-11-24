import { describe, expect, it } from 'vitest';
import { borrowerDigest, buildBorrowerFinancials, changeText, figureText, reviewOutcome, settles, type BorrowerFinancialsInput } from './borrower-financials';
import { mapCovenantTest } from './covenant-test';
import type { RegisterAttribute, StatementPeriod } from './statement-book';

const line = (rules: Record<string, unknown>) => ({ statementLine: rules });

const REGISTER: RegisterAttribute[] = [
  { attributeCode: 'END', attributeName: 'Period end', dataType: 'DATE', displaySection: 'Period', displayGroup: 1, validationRules: line({ placement: 'caption', rollup: 'NONE' }) },
  { attributeCode: 'REV', attributeName: 'Revenue', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 10, validationRules: line({ rollup: 'SUM' }) },
  { attributeCode: 'COSTS', attributeName: 'Costs', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 20, validationRules: line({ rollup: 'SUM', indent: true }) },
  { attributeCode: 'EBITDA', attributeName: 'EBITDA', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 30, derivationFormula: '{"op":"sub","args":[{"ref":"REV"},{"ref":"COSTS"}]}', validationRules: line({ rollup: 'SUM', role: 'total' }) },
  { attributeCode: 'MARGIN', attributeName: 'EBITDA margin', dataType: 'NUMBER', displayFormat: 'ratio', displaySection: 'Income statement', displayGroup: 40, derivationFormula: '{"op":"div","args":[{"ref":"EBITDA"},{"ref":"REV"}]}', validationRules: line({ rollup: 'NONE', role: 'ratio' }) },
  { attributeCode: 'CASH', attributeName: 'Cash', dataType: 'CURRENCY', displaySection: 'Balance sheet', displayGroup: 50, validationRules: line({ rollup: 'PERIOD_END', placement: 'both', headlineOrder: 1 }) },
  // Not a statement line: it has no rule, so the book leaves it out.
  { attributeCode: 'STATEMENT_REVIEW_NOTES', attributeName: 'Review Notes', dataType: 'STRING', displaySection: 'Period', displayGroup: 90, validationRules: {} },
];

const quarter = (end: string, rev: number, costs: number, cash: number): StatementPeriod => ({ end, entityId: `s-${end}`, entityName: `Statement ${end}`, values: { REV: rev, COSTS: costs, CASH: cash } });

const PERIODS: StatementPeriod[] = [
  quarter('2025-06-30', 90e6, 72e6, 30e6),
  quarter('2025-09-30', 100e6, 80e6, 28e6),
  quarter('2025-12-31', 104e6, 84e6, 26e6),
  quarter('2026-03-31', 108e6, 88e6, 24e6),
  quarter('2026-06-30', 110e6, 92e6, 20e6),
  quarter('2026-09-30', 113e6, 99e6, 14e6),
  // Not ended on the day the review is read.
  quarter('2026-12-31', 118e6, 100e6, 15e6),
];

const covenant = (overrides: Record<string, unknown>) =>
  mapCovenantTest({ covenantId: 'c1', code: 'COV-1', name: 'Maximum total leverage', dealId: 'd1', dealName: 'Project Northwind', metric: 'TOTAL_LEVERAGE', direction: 'MAX', unit: 'MULTIPLE', level: 5.25, firstTest: '2025-03-31', asOf: '2026-09-30', testDate: '2026-09-30', value: 5.33, numerator: 311.4e6, denominator: 58.4e6, stored: 5.33, house: 5.6, isLibrary: false, isHouse: false, missing: [], reported: [], components: [], history: [{ testDate: '2026-06-30', value: 4.78, level: 5.25, tested: true }], ...overrides });

const input = (overrides: Partial<BorrowerFinancialsInput> = {}): BorrowerFinancialsInput => ({
  borrower: { id: 'b1', code: 'BRW-NWL', name: 'Northwind Energy' },
  periods: PERIODS,
  register: REGISTER,
  covenants: [],
  asked: null,
  today: '2026-11-23',
  notesKept: true,
  ...overrides,
});

describe("a borrower's financials for a quarter", () => {
  it('looks at the latest quarter that has ended, and shows the quarters up to it', () => {
    const financials = buildBorrowerFinancials(input());
    expect(financials.periodEnd).toBe('2026-09-30');
    expect(financials.periodLabel).toBe('Q3 2026');
    expect(financials.onFile).toBe(true);
    expect(financials.statementId).toBe('s-2026-09-30');
    expect(financials.quarters.map((entry) => entry.end)).toEqual(['2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30']);
  });

  it('takes the lines from the statement book, with the totals and margins worked out by its formulas', () => {
    const financials = buildBorrowerFinancials(input({ quarters: 2 }));
    const by = Object.fromEntries(financials.lines.map((entry) => [entry.code, entry]));
    expect(by.EBITDA.values).toEqual([18e6, 14e6]);
    expect(by.EBITDA.key).toBe(true);
    expect(by.COSTS.key).toBe(false);
    expect(by.MARGIN.unit).toBe('percent');
    expect(by.MARGIN.values[1]).toBeCloseTo(14 / 113);
    expect(by.STATEMENT_REVIEW_NOTES).toBeUndefined();
  });

  it('measures each key line on the quarter and on the year, and marks the sharp moves', () => {
    const by = Object.fromEntries(buildBorrowerFinancials(input()).trends.map((row) => [row.code, row]));
    // An amount moves as a share of the earlier figure.
    expect(by.REV.onQuarter).toBeCloseTo(3 / 110);
    expect(by.REV.onYear).toBeCloseTo(0.13);
    expect(by.REV.notable).toBe(false);
    expect(by.EBITDA.onYear).toBeCloseTo(-0.3);
    expect(by.EBITDA.notable).toBe(true);
    // A margin moves in points.
    expect(by.MARGIN.onYear).toBeCloseTo(14 / 113 - 0.2);
    expect(by.MARGIN.notable).toBe(true);
    expect(by.CASH.yearAgo).toBe(28e6);
    expect(by.COSTS).toBeUndefined();
  });

  it('sets each covenant beside the certificate and says whether the two agree', () => {
    const financials = buildBorrowerFinancials(
      input({
        covenants: [
          covenant({ reported: [{ sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Certificate', value: 4.94, validFrom: '2026-09-30' }] }),
          covenant({ covenantId: 'c2', name: 'Minimum interest coverage', metric: 'INTEREST_COVERAGE', direction: 'MIN', level: 1.75, value: 2.1, stored: 2.1, reported: [{ sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Certificate', value: 2.12, validFrom: '2026-09-30' }] }),
          covenant({ covenantId: 'c3', name: 'Minimum liquidity', metric: 'LIQUIDITY', direction: 'MIN', unit: 'USD', level: 10e6, value: 10.6e6, stored: 10.6e6 }),
          covenant({ covenantId: 'lib', isLibrary: true }),
        ],
      }),
    );
    const [leverage, coverage, liquidity] = financials.covenants;
    expect(financials.covenants).toHaveLength(3);
    expect(leverage.status).toBe('BREACH');
    expect(leverage.certificate).toBe(4.94);
    expect(leverage.difference).toBeCloseTo(-0.39);
    expect(leverage.agrees).toBe(false);
    expect(coverage.status).toBe('PASS');
    expect(coverage.agrees).toBe(true);
    expect(liquidity.unit).toBe('amount');
    expect(liquidity.status).toBe('WATCH');
    expect(liquidity.certificate).toBeNull();
    expect(financials.counts).toMatchObject({ covenants: 3, breaches: 1, watch: 1, pass: 1, certificateDiffers: 1, certificateMissing: 1 });
    expect(financials.headline).toBe('Northwind Energy, Q3 2026: statement on file. 3 covenants tested: 1 past its limit, 1 close to it, 1 inside. 1 certificate value differs from our calculation.');
  });

  it('lists what is open, with the next step and who has it', () => {
    const financials = buildBorrowerFinancials(
      input({
        covenants: [
          covenant({ reported: [{ sourceCode: 'BORROWER_CERTIFICATE', sourceName: 'Certificate', value: 4.94, validFrom: '2026-09-30' }] }),
          covenant({ covenantId: 'c3', name: 'Minimum liquidity', direction: 'MIN', unit: 'USD', level: 10e6, value: 10.6e6, stored: 10.6e6 }),
        ],
      }),
    );
    expect(financials.entries.map((entry) => `${entry.id}|${entry.kind}|${entry.owner}|${entry.blocking}`)).toEqual([
      'cov:c1|breach|Deal team|true',
      'cert:c1|certificate|Credit analyst|true',
      'cov:c3|watch|Credit analyst|false',
      'cert:c3|certificate|Credit analyst|false',
      'review:b1|review|Credit analyst|false',
    ]);
    expect(financials.entries[0].cause).toBe('5.33x against a maximum of 5.25x.');
    expect(financials.entries[1].cause).toBe('4.94x on the certificate against 5.33x calculated.');
    // Notes on file close the review item.
    expect(buildBorrowerFinancials(input({ reviewNotes: '## Outcome\nFine.' })).entries).toEqual([]);
  });

  it('says so when the quarter asked for has no statement', () => {
    const financials = buildBorrowerFinancials(input({ asked: '2027-03-31' }));
    expect(financials.onFile).toBe(false);
    expect(financials.headline).toBe('Northwind Energy, Q1 2027: no statement on file for the quarter.');
    expect(financials.entries.map((entry) => entry.id)).toEqual(['statement:b1']);
    expect(financials.trends).toEqual([]);
  });

  it('reads a quarter asked for in the past as that quarter', () => {
    const financials = buildBorrowerFinancials(input({ asked: '2026-03-31', quarters: 3 }));
    expect(financials.quarters.map((entry) => entry.end)).toEqual(['2025-09-30', '2025-12-31', '2026-03-31']);
    expect(financials.trends.find((row) => row.code === 'REV')?.latest).toBe(108e6);
  });

  it('finds a quarter by its month, and reads a key line once', () => {
    // A statement dated the 30th is the quarter that ends on the 31st.
    const periods = PERIODS.map((period) => (period.end === '2025-12-31' ? { ...period, end: '2025-12-30' } : period));
    const financials = buildBorrowerFinancials(input({ periods, asked: '2025-12-31', quarters: 2 }));
    expect(financials.onFile).toBe(true);
    expect(financials.periodEnd).toBe('2025-12-30');
    expect(financials.periodLabel).toBe('Q4 2025');
    // A line that repeats another line's figures is followed once.
    const register = [...REGISTER, { attributeCode: 'CASH_END', attributeName: 'Ending cash', dataType: 'CURRENCY', displaySection: 'Cash flow', displayGroup: 60, derivationFormula: '{"ref":"CASH"}', validationRules: line({ rollup: 'PERIOD_END', role: 'total' }) }];
    const trends = buildBorrowerFinancials(input({ register })).trends.map((row) => row.code);
    expect(trends).toContain('CASH');
    expect(trends).not.toContain('CASH_END');
  });

  it('matches a change to the open entry it settles', () => {
    expect(settles('record_borrower_covenant_value', { entityId: 'c1' })).toBe('cert:c1');
    expect(settles('save_borrower_review', { entityId: 'b1' })).toBe('review:b1');
    expect(settles('submit_manual_override', { entityId: 'b1' })).toBeNull();
  });

  it('leaves out a record that is not a borrower', () => {
    const financials = buildBorrowerFinancials(input({ periods: [], covenants: [] }));
    expect(financials.note).toMatch(/not a borrower/);
    expect(financials.entries).toEqual([]);
  });

  it('writes the outcome line and the digest from the same figures', () => {
    const financials = buildBorrowerFinancials(input({ covenants: [covenant({})] }));
    expect(reviewOutcome(financials, '2026-11-23')).toBe('Q3 2026. 1 covenant: 1 past the limit, 0 close to it, 0 inside; 1 certificate value not on file; 3 lines moving sharply. As of 2026-11-23.');
    const digest = borrowerDigest(financials);
    expect(digest.lines.map((entry) => entry.code)).toEqual(['REV', 'EBITDA', 'MARGIN', 'CASH']);
    expect(borrowerDigest(financials, { allLines: true }).lines.map((entry) => entry.code)).toContain('COSTS');
    expect(digest.trends.find((row) => row.code === 'EBITDA')?.inWords).toBe('$14.0M, down 22.2% on the quarter and down 30.0% on the year');
    expect(digest.covenants[0]).toMatchObject({ covenantId: 'c1', calculated: 5.33, limit: 5.25, status: 'BREACH', certificate: null });
  });

  it('words figures and changes', () => {
    expect(figureText(428.9e6, 'amount')).toBe('$428.9M');
    expect(figureText(-1.25e9, 'amount')).toBe('-$1.25B');
    expect(figureText(0.136, 'percent')).toBe('13.6%');
    expect(figureText(5.333, 'multiple')).toBe('5.33x');
    expect(figureText(null, 'amount')).toBe('no figure');
    expect(changeText(0.042, 'amount')).toBe('up 4.2%');
    expect(changeText(-0.013, 'percent')).toBe('down 1.3 pts');
    expect(changeText(0.55, 'multiple')).toBe('up 0.55x');
    expect(changeText(null, 'amount')).toBe('no comparison');
  });
});
