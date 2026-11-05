import { describe, expect, it } from 'vitest';
import {
  gridSections,
  headlineAttributes,
  linesForSection,
  projectStatementBook,
  statementAttributesFromRegister,
  type RegisterAttribute,
  type StatementPeriod,
} from './statement-book';

function line(overrides: Record<string, unknown>) {
  return overrides;
}

function attr(partial: Partial<RegisterAttribute> & { attributeCode: string; attributeName: string }): RegisterAttribute {
  return partial;
}

const income: RegisterAttribute[] = [
  attr({
    attributeCode: 'REV', attributeName: 'Revenue', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 10,
    validationRules: { statementLine: line({ rollup: 'SUM' }) },
  }),
  attr({
    attributeCode: 'COGS', attributeName: 'Cost of revenue', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 20,
    validationRules: { statementLine: line({ rollup: 'SUM', indent: true, sign: -1 }) },
  }),
  attr({
    attributeCode: 'GP', attributeName: 'Gross profit', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 30,
    derivationFormula: '{"op":"sub","args":[{"ref":"REV"},{"ref":"COGS"}]}',
    validationRules: { statementLine: line({ rollup: 'SUM', role: 'sub' }) },
  }),
  attr({
    attributeCode: 'EBITDA', attributeName: 'EBITDA', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 40,
    derivationFormula: '{"op":"sub","args":[{"ref":"GP"},{"ref":"OPEX"}]}',
    validationRules: { statementLine: line({ rollup: 'SUM', role: 'total' }) },
  }),
  attr({
    attributeCode: 'OPEX', attributeName: 'Total operating expenses', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 35,
    derivationFormula: '{"ref":"GA"}',
    validationRules: { statementLine: line({ rollup: 'SUM', role: 'sub', sign: -1 }) },
  }),
  attr({
    attributeCode: 'GA', attributeName: 'General and administrative', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 34,
    validationRules: { statementLine: line({ rollup: 'SUM', indent: true, sign: -1 }) },
  }),
  attr({
    attributeCode: 'MARGIN', attributeName: 'EBITDA margin', dataType: 'NUMBER', displayFormat: 'ratio', displaySection: 'Income statement', displayGroup: 50,
    derivationFormula: '{"op":"div","args":[{"ref":"EBITDA"},{"ref":"REV"}]}',
    validationRules: { statementLine: line({ rollup: 'NONE', role: 'ratio' }) },
  }),
  attr({
    attributeCode: 'LTM_REV', attributeName: 'LTM revenue', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 60,
    derivationFormula: '{"op":"trail","periods":4,"args":[{"ref":"REV"}]}',
    validationRules: { statementLine: line({ rollup: 'NONE', role: 'ratio', placement: 'both', headlineOrder: 1, hideWhen: ['statement'], captionDate: 'short', captionPrefix: 'Twelve months to ' }) },
  }),
  attr({
    attributeCode: 'CASH', attributeName: 'Cash and equivalents', dataType: 'CURRENCY', displaySection: 'Balance sheet', displayGroup: 20,
    validationRules: { statementLine: line({ rollup: 'PERIOD_END', indent: true, placement: 'both', headlineOrder: 3, captionDate: 'long' }) },
  }),
  attr({
    attributeCode: 'BEGIN', attributeName: 'Beginning cash', dataType: 'CURRENCY', displaySection: 'Cash flow statement', displayGroup: 10,
    derivationFormula: '{"op":"prior","args":[{"ref":"CASH"}]}',
    validationRules: { statementLine: line({ rollup: 'NONE', indent: true, blankZero: true }) },
  }),
  attr({
    attributeCode: 'NI', attributeName: 'Net income', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 70,
    validationRules: { statementLine: line({ rollup: 'SUM', role: 'net' }) },
  }),
  attr({
    attributeCode: 'RETAINED', attributeName: 'Retained earnings', dataType: 'CURRENCY', displaySection: 'Balance sheet', displayGroup: 30,
    derivationFormula: '{"op":"cumsum","args":[{"ref":"NI"}]}',
    validationRules: { statementLine: line({ rollup: 'PERIOD_END', indent: true }) },
  }),
  attr({
    attributeCode: 'AR', attributeName: 'Accounts receivable', dataType: 'CURRENCY', displaySection: 'Balance sheet', displayGroup: 22,
    validationRules: { statementLine: line({ rollup: 'PERIOD_END', indent: true }) },
  }),
  attr({
    attributeCode: 'CF_AR', attributeName: 'Change in accounts receivable', dataType: 'CURRENCY', displaySection: 'Cash flow statement', displayGroup: 20,
    derivationFormula: '{"op":"sub","args":[{"op":"prior","args":[{"ref":"AR"}]},{"ref":"AR"}]}',
    validationRules: { statementLine: line({ rollup: 'SUM', indent: true, blankZero: true }) },
  }),
  attr({
    attributeCode: 'DA', attributeName: 'Depreciation and amortization', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 45,
    validationRules: { statementLine: line({ rollup: 'SUM', indent: true, sign: -1 }) },
  }),
  attr({
    attributeCode: 'CF_DA', attributeName: 'Depreciation and amortization', dataType: 'CURRENCY', displaySection: 'Cash flow statement', displayGroup: 15,
    derivationFormula: '{"op":"when_prior","args":[{"ref":"DA"}]}',
    validationRules: { statementLine: line({ rollup: 'SUM', indent: true, blankZero: true }) },
  }),
  attr({
    attributeCode: 'ASSETS', attributeName: 'Assets', dataType: 'STRING', displaySection: 'Balance sheet', displayGroup: 10, isVisible: false,
    validationRules: { statementLine: line({ role: 'section', placement: 'grid' }) },
  }),
  attr({
    attributeCode: 'END', attributeName: 'Period end', dataType: 'DATE', displaySection: 'Period', displayGroup: 1, isVisible: true,
  }),
];

function periods(): StatementPeriod[] {
  const ends = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31'];
  const revenue = [100, 100, 100, 100, 200];
  const cogs = [50, 10, 50, 50, 40];
  const ga = [10, 10, 10, 10, 20];
  return ends.map((end, index) => ({
    end,
    values: {
      REV: revenue[index],
      COGS: cogs[index],
      GA: ga[index],
      CASH: index + 1,
      NI: 10 * (index + 1),
      AR: 20 + index * 4,
      DA: 4,
    },
  }));
}

describe('statement attributes', () => {
  const catalog = statementAttributesFromRegister(income);

  it('reads labels, sign, and formulas from the attribute', () => {
    const cogs = catalog.find((attr) => attr.code === 'COGS');
    expect(cogs).toMatchObject({ name: 'Cost of revenue', sign: -1, indent: true, rollup: 'SUM' });
    const gross = catalog.find((attr) => attr.code === 'GP');
    expect(gross?.formula).toEqual({ op: 'sub', args: [{ ref: 'REV' }, { ref: 'COGS' }] });
    expect(gridSections(catalog, [
      { sectionName: 'Cash flow statement', displayOrder: 30 },
      { sectionName: 'Income statement', displayOrder: 10 },
      { sectionName: 'Balance sheet', displayOrder: 20 },
    ])).toEqual(['Income statement', 'Balance sheet', 'Cash flow statement']);
    expect(linesForSection(catalog, 'Balance sheet', 'quarter').map((attr) => attr.name)[0]).toBe('Assets');
    expect(linesForSection(catalog, 'Income statement', 'statement').some((attr) => attr.code === 'LTM_REV')).toBe(false);
    expect(headlineAttributes(catalog).map((attr) => attr.code)).toEqual(['LTM_REV', 'CASH']);
    const withNoise = statementAttributesFromRegister([
      ...income,
      attr({ attributeCode: 'QUANTITY', attributeName: 'Quantity', dataType: 'NUMBER', displaySection: 'General', isVisible: true }),
    ]);
    expect(withNoise.some((attr) => attr.code === 'QUANTITY')).toBe(false);
  });

  it('computes totals from attribute formulas and keeps a new line that the catalog adds', () => {
    const extra = statementAttributesFromRegister([
      ...income,
      attr({
        attributeCode: 'CUSTOM', attributeName: 'Custom spread', dataType: 'CURRENCY', displaySection: 'Income statement', displayGroup: 31,
        derivationFormula: '{"op":"sub","args":[{"ref":"REV"},{"ref":"COGS"}]}',
        validationRules: { statementLine: line({ rollup: 'SUM' }) },
      }),
    ]);
    const book = projectStatementBook(periods(), extra, '2025-03-31', 'quarter');
    const last = book.columns[book.columns.length - 1];
    expect(last.values.GP).toBe(160);
    expect(last.values.CUSTOM).toBe(160);
    expect(last.values.EBITDA).toBe(140);
    expect(last.values.RETAINED).toBe(10 + 20 + 30 + 40 + 50);
    expect(book.columns[0].values.CF_AR).toBeNull();
    expect(book.columns[0].values.CF_DA).toBeNull();
    expect(book.columns[1].values.CF_AR).toBe(-4);
    expect(book.columns[1].values.CF_DA).toBe(4);
  });

  it('rolls the trailing year from each attribute rollup', () => {
    const book = projectStatementBook(periods(), catalog, '2025-03-31', 'quarter');
    expect(book.pinned?.values.REV).toBe(500);
    expect(book.pinned?.values.MARGIN).toBeCloseTo((80 + 40 + 40 + 140) / 500, 6);
    expect(book.columns[3].values.MARGIN).toBeCloseTo(0.4, 6);
    expect(book.pinned?.values.BEGIN).toBe(1);
    expect(book.pinned?.values.CASH).toBe(5);
    expect(book.pinned?.values.LTM_REV).toBe(500);
    expect(book.columns[2].values.LTM_REV).toBeNull();
    expect(book.columns[3].values.LTM_REV).toBe(400);
  });

  it('divides flow attributes across the three months of a quarter and leaves balances', () => {
    const book = projectStatementBook(periods().slice(0, 1), catalog, '2024-03-31', 'month');
    expect(book.columns.map((column) => column.label)).toEqual(['Jan 2024', 'Feb 2024', 'Mar 2024']);
    expect(book.columns.map((column) => column.values.REV)).toEqual([100 / 3, 100 / 3, 100 / 3]);
    expect(book.columns.map((column) => column.values.CASH)).toEqual([1, 1, 1]);
  });

  it('keeps the statement period on each column so a cell can open that record', () => {
    const sourced = periods().map((period, index) => ({ ...period, entityId: `period-${index}`, entityName: period.end }));
    const quarter = projectStatementBook(sourced, catalog, '2025-03-31', 'quarter');
    expect(quarter.columns[2]).toMatchObject({ entityId: 'period-2', entityName: '2024-09-30' });
    expect(quarter.pinned).toMatchObject({ entityId: 'period-4', end: '2025-03-31' });
    const month = projectStatementBook(sourced.slice(0, 1), catalog, '2024-03-31', 'month');
    expect(month.columns.map((column) => column.entityId)).toEqual(['period-0', 'period-0', 'period-0']);
  });
});
