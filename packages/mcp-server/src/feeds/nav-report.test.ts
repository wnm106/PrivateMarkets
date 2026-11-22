import { describe, expect, it } from 'vitest';
import type { NavReportPlan } from '@tapestrai/graphql/src/lib/nav-report-map';
import { comparableName, holdsFor, type FundResolution } from './nav-report';

const fund = { id: 'F1', entity_code: 'EX-BDC', entity_name: 'Example BDC' };
const found: FundResolution = { fund, matchedBy: 'report', note: 'The report is for Example BDC.', choices: [] };

function plan(overrides: Partial<NavReportPlan> = {}): NavReportPlan {
  return {
    periodEnd: '2026-06-30',
    comparativeDate: '2025-12-31',
    months: 6,
    rows: [{ asOf: '2026-06-30', values: [{ code: 'NAV_BS_NET_ASSETS', name: 'Net assets', value: 100, cell: null, from: [] }] }],
    statements: [{
      kind: 'BALANCE_SHEET', title: 'Statement of assets and liabilities', columns: [{ label: 'June 30, 2026', date: '2026-06-30', months: null }],
      lines: [], unmapped: [], periodColumn: 0, comparativeColumn: null,
    }],
    positions: [],
    checks: [],
    problems: [],
    ...overrides,
  };
}

const clean = {
  statement: { dryRun: true, rowCount: 2, records: [{ domainCode: 'NAV_STATEMENT', distinct: 1, created: 1, matched: 0, failed: 0, errors: [] }], values: { created: 80, updated: 0, unchanged: 0 }, links: { created: 1, matched: 0, failed: 0 }, resolutions: 0, rejectCount: 0, rejects: [], warnings: [], errors: [] },
  positions: null,
};

describe('holdsFor', () => {
  it('has nothing to hold for a report that maps, adds up, and loads cleanly onto a fund it found', () => {
    expect(holdsFor(plan(), found, [{ label: 'Schedule adds up', result: 'Ties' }], clean)).toEqual([]);
  });

  it('holds when the fund is not found, and says why', () => {
    const missing: FundResolution = { fund: null, matchedBy: null, note: 'No fund is named Example BDC.', choices: [] };
    expect(holdsFor(plan(), missing, [], clean)).toEqual(['No fund is named Example BDC.']);
  });

  it('holds when the report does not add up, a line has nowhere to go, or a period does not span', () => {
    const unplaced = plan({
      problems: ['Statement of operations has no 6-month column to 2026-06-30.'],
      statements: [{
        ...plan().statements[0],
        unmapped: [
          { index: 3, label: 'Tax receivable', section: 'ASSETS', reason: 'No line on the NAV chart takes this wording.', values: [5] },
          { index: 4, label: 'Interest paid', section: 'Supplemental', reason: 'Supplemental disclosure, not a line of the statement.', values: [9] },
          { index: 5, label: 'Blank line', section: 'ASSETS', reason: 'No line on the NAV chart takes this wording.', values: [0] },
        ],
      }],
    });
    const holds = holdsFor(unplaced, found, [{ label: 'First Lien Debt: fair value adds up', result: 'Break' }], clean);
    expect(holds).toHaveLength(3);
    expect(holds[0]).toMatch(/no 6-month column/);
    expect(holds[1]).toMatch(/^1 of the report's own subtotals or totals do not add up \(First Lien Debt/);
    expect(holds[2]).toBe('1 line has no place on the NAV statement: Statement of assets and liabilities: ASSETS: Tax receivable.');
  });

  it('holds when the trial load refuses records, cannot tell records apart, or restates figures on file', () => {
    const trial = {
      statement: { ...clean.statement, values: { created: 0, updated: 12, unchanged: 70 } },
      positions: { ...clean.statement, records: [{ domainCode: 'POSITION', distinct: 390, created: 388, matched: 0, failed: 2, errors: [] }], resolutions: 1 },
    };
    const holds = holdsFor(plan(), found, [], trial);
    expect(holds).toEqual([
      'NAV statement: the report changes 12 figures already on file for this period, so it restates them.',
      'Positions: the trial load refuses 2 records or values.',
      'Positions: 1 record matches more than one stored record.',
    ]);
  });
});

describe('comparableName', () => {
  it('compares names without case, punctuation or the ampersand', () => {
    expect(comparableName('T. Rowe Price OHA Select Private Credit Fund')).toBe(comparableName('T Rowe Price  OHA Select Private Credit Fund'));
    expect(comparableName('Smith & Co.')).toBe(comparableName('smith and co'));
    expect(comparableName('Example BDC')).not.toBe(comparableName('Example BDC II'));
  });
});
