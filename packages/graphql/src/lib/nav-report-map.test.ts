import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FinancialReport, ReportLine, ReportStatement, ReportStatementKind } from './import-intake/financial-report';
import { chartFromAttributes, mapStatement, monthsBetween, normalizeReportLabel, planNavReport, positionCode, type ChartLine } from './nav-report-map';

/** The chart exactly as the migration writes it, so the rules tested are the rules shipped. */
function migrationChart(): ChartLine[] {
  const sql = readFileSync(resolve(__dirname, '../../../../supabase/migrations/20261122100000_nav_report_chart.sql'), 'utf8');
  const lines = JSON.parse(sql.split('$chart$')[1]) as Array<Record<string, unknown>>;
  return chartFromAttributes(lines.map((line, index) => ({
    attribute_code: String(line.code),
    attribute_name: String(line.name),
    display_group: (index + 1) * 10,
    validation_rules: { navLine: line },
  })));
}

const chart = migrationChart();

function statement(kind: ReportStatementKind, columns: Array<[string, number | null]>, rows: Array<[string, string, ...Array<number | null>] | [string]>): ReportStatement {
  const lines: ReportLine[] = rows.map((row) => {
    if (row.length === 1) return { label: row[0], section: '', header: true, values: columns.map(() => null), cells: columns.map(() => null), unscaled: false, page: 1, labelCell: null };
    const [label, section, ...values] = row as [string, string, ...Array<number | null>];
    return { label, section, header: false, values, cells: values.map(() => null), unscaled: /per share|outstanding/i.test(label), page: 1, labelCell: null };
  });
  return { kind, title: kind, pages: [1], scale: 1, columns: columns.map(([date, months]) => ({ label: `${months ?? 'As of'} ${date}`, date, months })), lines };
}

const bdc: FinancialReport = {
  entityName: 'Example BDC',
  form: '10-Q',
  periodEnd: '2026-06-30',
  comparativeDate: '2025-12-31',
  checks: [],
  schedules: [{
    date: '2026-06-30', title: 'Schedule', pages: [10], scale: 1,
    rows: [
      { kind: 'investment', assetClass: 'First Lien Debt', industry: 'Software', company: 'Alpha LLC', footnotes: '(4)', reference: 'S + 5.00%', rate: '8.66%', maturity: '2030-09-30', currency: '', par: 100, cost: 99, fairValue: 100, pctOfNetAssets: 1, page: 10, cells: { company: null, par: null, cost: null, fairValue: null } },
      { kind: 'investment', assetClass: 'First Lien Debt', industry: 'Software', company: 'Alpha LLC', footnotes: '(4)', reference: 'S + 5.00%', rate: '8.66%', maturity: '2030-09-30', currency: '', par: 50, cost: 49, fairValue: 50, pctOfNetAssets: 1, page: 10, cells: { company: null, par: null, cost: null, fairValue: null } },
      { kind: 'subtotal', assetClass: 'First Lien Debt', industry: 'Software', company: 'Software', footnotes: '', reference: '', rate: '', maturity: null, currency: '', par: null, cost: 148, fairValue: 150, pctOfNetAssets: 2, page: 10, cells: { company: null, par: null, cost: null, fairValue: null } },
    ],
  }],
  statements: [
    statement('BALANCE_SHEET', [['2026-06-30', null], ['2025-12-31', null]], [
      ['ASSETS'],
      ['Non-controlled/non-affiliated investments (cost of $3,170,452 and $2,905,803 at June 30, 2026 and December 31, 2025, respectively)', 'Investments at fair value', 150, 120],
      ['Cash, cash equivalents and restricted cash', 'ASSETS', 10, 20],
      ['Interest receivable', 'ASSETS', 2, 1],
      ['Prepaid insurance', 'ASSETS', 1, 1],
      ['Total assets', '', 163, 142],
      ['Debt (net of unamortized debt issuance costs of $2,004 and $2,366, respectively)', 'LIABILITIES', 60, 50],
      ['Distribution payable', 'LIABILITIES', 1, 1],
      ['Distribution and/or shareholder servicing fees payable', 'LIABILITIES', 1, 1],
      ['Income incentive fee payable', 'LIABILITIES', 1, 1],
      ['Total liabilities', '', 63, 53],
      ['Common shares, $0.01 par value (63,250,367 and 59,072,291 shares issued and outstanding)', 'NET ASSETS', 1, 1],
      ['Additional paid in capital', 'NET ASSETS', 110, 90],
      ['Distributable earnings (loss)', 'NET ASSETS', -11, -2],
      ['Total net assets', '', 100, 89],
      ['Total liabilities and net assets', '', 163, 142],
      ['Net assets', 'Class I Shares', 80, 70],
      ['Common shares outstanding ($0.01 par value, unlimited shares authorized)', 'Class I Shares', 4, 3],
      ['Net asset value per share', 'Class I Shares', 25.96, 26.89],
      ['Net assets', 'Class S Shares', 20, 19],
      ['Common shares outstanding ($0.01 par value, unlimited shares authorized)', 'Class S Shares', 1, 1],
      ['Net asset value per share', 'Class S Shares', 25.96, 26.89],
    ]),
    statement('OPERATIONS', [['2026-06-30', 3], ['2026-06-30', 6]], [
      ['Interest and dividend income', 'Investment income', 7, 13],
      ['Management fees', 'Expenses', 1, 2],
      ['Income incentive fee', 'Expenses', 1, 2],
      ['Class S', 'Distribution and shareholder servicing fees', 0.1, 0.2],
      ['Class D', 'Distribution and shareholder servicing fees', 0.1, 0.2],
      ['Total expenses before fee waivers and expense support', 'Expenses', 3, 5],
      ['Expense support', 'Expenses', -0.5, -0.5],
      ['Management fees waiver', 'Expenses', 0, 0],
      ['Total expenses net of fee waivers and expense support', '', 2.5, 4.5],
      ['Non-controlled/non-affiliated investments', 'Realized gain (loss)', 1, 2],
      ['Foreign currency forward contracts', 'Realized gain (loss)', 1, 1],
      ['Net realized gain (loss)', '', 2, 3],
      ['Non-controlled/non-affiliated investments', 'Net change in unrealized appreciation (depreciation)', -3, -5],
      ['Foreign currency translation', 'Net change in unrealized appreciation (depreciation)', 0, 1],
      ['Net change in unrealized appreciation (depreciation)', '', -3, -4],
      ['Net increase (decrease) in net assets resulting from operations', '', 3, 6],
    ]),
    statement('CHANGES', [['2026-06-30', 6]], [
      ['Class I total', 'Distributions to common shareholders', -4],
      ['Class S total', 'Distributions to common shareholders', -1],
      ['Net decrease in net assets resulting from distributions', '', -5],
      ['Proceeds from shares sold', 'Class I', 8],
      ['Repurchase of shares', 'Class I', -2],
      ['Net increase (decrease) in net assets from share transactions', '', 6],
      ['Proceeds from shares sold', 'Class S', 3],
      ['Net increase (decrease) in net assets from share transactions', '', 3],
      ['Total increase (decrease) in net assets', '', 11],
      ['Net assets, beginning of period', '', 89],
      ['Net assets, end of period', '', 100],
    ]),
    statement('CASH_FLOWS', [['2026-06-30', 6], ['2025-06-30', 6]], [
      ['Net accretion of discount and amortization of premium', 'Adjustments to reconcile', -1, -1],
      ['Payment-in-kind interest', 'Adjustments to reconcile', -1, -1],
      ['Interest receivable', 'Changes in operating assets and liabilities', -1, 0],
      ['Management fee payable', 'Changes in operating assets and liabilities', 1, 0],
      ['Borrowings of debt', 'Cash flows from financing activities', 20, 0],
      ['Repayments of debt', 'Cash flows from financing activities', -10, 0],
      ['Proceeds from issuance of common shares net of change in subscription receivable', 'Cash flows from financing activities', 11, 0],
      ['Payments of financing costs', 'Cash flows from financing activities', -1, 0],
      ['Effect of foreign currency exchange rates', '', -0.1, 0],
      ['Interest paid during the period', 'Supplemental information and non-cash activities', 4, 3],
    ]),
  ],
};

const mapped = (kind: ReportStatementKind) => mapStatement(bdc.statements.find((item) => item.kind === kind)!, chart);
const valueOf = (kind: ReportStatementKind, code: string, column = 0) => mapped(kind).lines.find((line) => line.code === code)?.values[column] ?? null;

describe('normalizeReportLabel', () => {
  it('takes out the parenthesis that only qualify the wording or hold an amount', () => {
    expect(normalizeReportLabel('Net increase (decrease) in net assets resulting from operations')).toBe('net increase in net assets resulting from operations');
    expect(normalizeReportLabel('Net unrealized (appreciation) depreciation on investments')).toBe('net unrealized depreciation on investments');
    expect(normalizeReportLabel('Derivative assets, at fair value (Note 5)')).toBe('derivative assets, at fair value');
    expect(normalizeReportLabel('Debt (net of unamortized debt issuance costs of $2,004)')).toBe('debt');
    expect(normalizeReportLabel('Other general & administrative expenses')).toBe('other general and administrative expenses');
  });
});

describe('mapStatement', () => {
  it('maps a BDC balance sheet onto the chart, other lines to their catch-all, classes left as detail', () => {
    const bs = mapped('BALANCE_SHEET');
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_INVESTMENTS')).toBe(150);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_CASH')).toBe(10);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_OTHER_ASSETS')).toBe(1);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_FACILITY')).toBe(60);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_DISTRIBUTION_PAYABLE')).toBe(1);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_SERVICING_PAYABLE')).toBe(1);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_ACCRUED_PERF')).toBe(1);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_SHARES_AT_PAR')).toBe(1);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_ACCUMULATED')).toBe(-11);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_NET_ASSETS')).toBe(100);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_TOTAL_LIABILITIES_NET_ASSETS')).toBe(163);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_SHARES_OUTSTANDING')).toBe(5);
    expect(valueOf('BALANCE_SHEET', 'NAV_BS_NAV_PER_SHARE', 1)).toBe(26.89);
    expect(bs.unmapped.map((line) => line.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/^Share-class detail/)]));
    expect(bs.unmapped.some((line) => line.label === 'Total net assets')).toBe(false);
  });

  it('takes the per-share amount only when every class agrees', () => {
    const differing = structuredClone(bdc.statements[0]);
    differing.lines.find((line) => line.section === 'Class S Shares' && /per share/.test(line.label))!.values = [25.5, 26.89];
    const line = mapStatement(differing, chart).lines.find((item) => item.code === 'NAV_BS_NAV_PER_SHARE')!;
    expect(line.values).toEqual([null, 26.89]);
    expect(line.note).toMatch(/every class agrees/);
  });

  it('keeps investments, currency and totals apart on the statement of operations', () => {
    expect(valueOf('OPERATIONS', 'NAV_OP_INCENTIVE_FEE', 1)).toBe(2);
    expect(valueOf('OPERATIONS', 'NAV_OP_SERVICING_FEES', 1)).toBe(0.4);
    expect(valueOf('OPERATIONS', 'NAV_OP_GROSS_EXPENSES', 1)).toBe(5);
    expect(valueOf('OPERATIONS', 'NAV_OP_EXPENSE_SUPPORT', 1)).toBe(-0.5);
    expect(valueOf('OPERATIONS', 'NAV_OP_TOTAL_EXPENSES', 1)).toBe(4.5);
    expect(valueOf('OPERATIONS', 'NAV_OP_REALIZED', 1)).toBe(2);
    expect(valueOf('OPERATIONS', 'NAV_OP_REALIZED_OTHER', 1)).toBe(1);
    expect(valueOf('OPERATIONS', 'NAV_OP_REALIZED_TOTAL', 1)).toBe(3);
    expect(valueOf('OPERATIONS', 'NAV_OP_UNREALIZED', 1)).toBe(-5);
    expect(valueOf('OPERATIONS', 'NAV_OP_UNREALIZED_TOTAL', 1)).toBe(-4);
    expect(valueOf('OPERATIONS', 'NAV_OP_NET_INCREASE', 1)).toBe(6);
  });

  it('takes the report total for distributions and adds up share transactions across classes', () => {
    const changes = mapped('CHANGES');
    const distributions = changes.lines.find((line) => line.code === 'NAV_CH_DISTRIBUTIONS')!;
    expect(distributions.values).toEqual([-5]);
    expect(distributions.detail.map((line) => line.label)).toEqual(['Class I total', 'Class S total']);
    expect(valueOf('CHANGES', 'NAV_CH_CONTRIBUTIONS')).toBe(11);
    expect(valueOf('CHANGES', 'NAV_CH_REPURCHASES')).toBe(-2);
    expect(valueOf('CHANGES', 'NAV_CH_NET_SHARES')).toBe(9);
    expect(valueOf('CHANGES', 'NAV_CH_TOTAL_INCREASE')).toBe(11);
    expect(valueOf('CHANGES', 'NAV_CH_BEGINNING')).toBe(89);
  });

  it('keeps financing apart from working capital, and leaves supplemental lines out', () => {
    const cash = mapped('CASH_FLOWS');
    expect(valueOf('CASH_FLOWS', 'NAV_CF_ACCRETION')).toBe(-1);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_RECEIVABLE')).toBe(-1);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_ACCRUED')).toBe(1);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_FACILITY')).toBe(10);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_CONTRIBUTIONS')).toBe(11);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_OTHER_FINANCING')).toBe(-1);
    expect(valueOf('CASH_FLOWS', 'NAV_CF_FX_EFFECT')).toBe(-0.1);
    expect(cash.unmapped).toEqual([expect.objectContaining({ label: 'Interest paid during the period', reason: expect.stringMatching(/^Supplemental/) })]);
  });

  it('maps the chart\'s own wording, as an administrator pack prints it', () => {
    const pack = statement('BALANCE_SHEET', [['2026-09-30', null]], [
      ['Senior secured', 'Investments at fair value', 150],
      ['Total investments at fair value', '', 150],
      ['Cash and equivalents', '', 21],
      ['Interest receivable', '', 5],
      ['Total assets', '', 176],
      ['Credit facility', 'Liabilities', 110],
      ['Accrued management fee', 'Liabilities', 2],
      ['Total liabilities', '', 112],
      ['Capital contributions', 'Net assets', 70],
      ['Cumulative distributions', 'Net assets', -10],
      ['Accumulated net investment income and gains', 'Net assets', 4],
      ['Net assets', 'Net assets', 64],
    ]);
    const lines = Object.fromEntries(mapStatement(pack, chart).lines.map((line) => [line.code, line.values[0]]));
    expect(lines).toMatchObject({
      NAV_BS_SENIOR: 150, NAV_BS_INVESTMENTS: 150, NAV_BS_CASH: 21, NAV_BS_RECEIVABLE: 5, NAV_BS_TOTAL_ASSETS: 176,
      NAV_BS_FACILITY: 110, NAV_BS_ACCRUED_FEE: 2, NAV_BS_TOTAL_LIABILITIES: 112,
      NAV_BS_CONTRIBUTIONS: 70, NAV_BS_DISTRIBUTIONS: -10, NAV_BS_ACCUMULATED: 4, NAV_BS_NET_ASSETS: 64,
    });
  });
});

describe('planNavReport', () => {
  it('loads the balance sheet at both dates and the flows for the span between them', () => {
    const plan = planNavReport(bdc, chart, { fundCode: 'EX-BDC' });
    expect(plan.periodEnd).toBe('2026-06-30');
    expect(plan.comparativeDate).toBe('2025-12-31');
    expect(plan.months).toBe(6);
    expect(plan.problems).toEqual([]);
    const current = Object.fromEntries(plan.rows[0].values.map((value) => [value.code, value.value]));
    expect(current.NAV_OP_INCENTIVE_FEE).toBe(2);
    expect(current.NAV_CH_BEGINNING).toBe(89);
    expect(plan.rows[1].asOf).toBe('2025-12-31');
    expect(Object.fromEntries(plan.rows[1].values.map((value) => [value.code, value.value])).NAV_BS_NET_ASSETS).toBe(89);
    expect(plan.rows[1].values.some((value) => value.code.startsWith('NAV_OP_'))).toBe(false);
  });

  it('makes one position per investment, with codes that tell tranches apart and stay the same', () => {
    const plan = planNavReport(bdc, chart, { fundCode: 'EX-BDC' });
    expect(plan.positions).toHaveLength(2);
    expect(plan.positions[0].code).toBe(positionCode('EX-BDC', bdc.schedules[0].rows[0], 1));
    expect(plan.positions[1].code).toBe(`${plan.positions[0].code}-2`);
    expect(plan.positions[1].name).toMatch(/#2$/);
    expect(plan.positions[0]).toMatchObject({ assetClass: 'First Lien Debt', coupon: 'S + 5.00%, 8.66%', fairValue: 100 });
  });

  it('says when a flow statement does not run from the comparative date', () => {
    const quarterOnly = structuredClone(bdc);
    quarterOnly.statements = quarterOnly.statements.map((item) => (item.kind === 'OPERATIONS' ? { ...item, columns: [item.columns[0]], lines: item.lines.map((line) => ({ ...line, values: [line.values[0]], cells: [null] })) } : item));
    const plan = planNavReport(quarterOnly, chart, { fundCode: 'EX-BDC' });
    expect(plan.problems.join(' ')).toMatch(/no 6-month column/);
  });

  it('counts months between period ends', () => {
    expect(monthsBetween('2025-12-31', '2026-06-30')).toBe(6);
    expect(monthsBetween('2026-03-31', '2026-06-30')).toBe(3);
    expect(monthsBetween('2025-12-31', '2026-12-31')).toBe(12);
  });
});
