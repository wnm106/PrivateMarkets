import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  columnMonths,
  parseReportAmount,
  readFinancialReport,
  reportFromTables,
  reportTables,
  splitAmountRuns,
} from './financial-report';
import { extractPdfFragments } from './pdf-text';

/** Text at a point measured from the top of the page, left-aligned or right-aligned at x. */
function put(page: PDFPage, font: PDFFont, text: string, x: number, top: number, align: 'left' | 'right' = 'left', size = 9) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: align === 'right' ? x - width : x, y: page.getHeight() - top, size, font });
}

/** One statement line: a label and amounts right-aligned at the column edges. */
function line(page: PDFPage, font: PDFFont, top: number, label: string, x: number, amounts: string[], edges: number[]) {
  if (label) put(page, font, label, x, top);
  amounts.forEach((amount, index) => { if (amount) put(page, font, amount, edges[index], top, 'right'); });
}

async function sampleReport(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const cover = pdf.addPage([612, 792]);
  put(cover, font, 'FORM 10-Q', 260, 60, 'left', 14);
  put(cover, font, 'Example Credit Fund', 230, 120, 'left', 14);

  const bs = pdf.addPage([612, 792]);
  const bsEdges = [457, 548];
  put(bs, font, 'Example Credit Fund', 230, 60, 'left', 10);
  put(bs, font, 'Consolidated Statements of Assets and Liabilities', 200, 72, 'left', 10);
  put(bs, font, '(in thousands, except share and per share amounts)', 196, 84, 'left', 10);
  put(bs, font, 'As of', 410, 110);
  put(bs, font, 'As of', 500, 110);
  put(bs, font, 'June 30, 2026', 390, 124);
  put(bs, font, 'December 31, 2025', 470, 124);
  line(bs, font, 140, 'ASSETS', 60, [], bsEdges);
  line(bs, font, 154, 'Investments at fair value:', 70, [], bsEdges);
  line(bs, font, 168, 'Non-controlled investments (cost of $310 and', 79, [], bsEdges);
  line(bs, font, 180, '$250, respectively)', 79, ['$ 300', '$ 250'], bsEdges);
  line(bs, font, 194, 'Cash and cash equivalents', 70, ['40', '50'], bsEdges);
  line(bs, font, 208, 'Total assets', 64, ['$ 340', '$ 300'], bsEdges);
  line(bs, font, 228, 'LIABILITIES', 64, [], bsEdges);
  line(bs, font, 242, 'Debt', 70, ['140', '120'], bsEdges);
  line(bs, font, 256, 'Total liabilities', 64, ['140', '120'], bsEdges);
  line(bs, font, 276, 'NET ASSETS', 61, [], bsEdges);
  line(bs, font, 290, 'Total net assets', 61, ['$ 200', '$ 180'], bsEdges);
  line(bs, font, 310, 'NET ASSET VALUE PER SHARE', 63, [], bsEdges);
  line(bs, font, 324, 'Class I Shares:', 63, [], bsEdges);
  line(bs, font, 338, 'Net assets', 63, ['200', '180'], bsEdges);
  line(bs, font, 352, 'Common shares outstanding', 63, ['8,000', '7,000'], bsEdges);
  line(bs, font, 366, 'Net asset value per share', 63, ['25.00', '25.71'], bsEdges);
  put(bs, font, 'See accompanying notes to consolidated financial statements.', 183, 700);

  const ops = pdf.addPage([612, 792]);
  const opsEdges = [314, 385, 457, 528];
  put(ops, font, 'Example Credit Fund', 230, 24, 'left', 10);
  put(ops, font, 'Consolidated Statements of Operations', 223, 36, 'left', 10);
  put(ops, font, '(in thousands)', 276, 48, 'left', 10);
  put(ops, font, 'For the Three Months Ended', 263, 82);
  put(ops, font, 'For the Six Months Ended', 411, 82);
  put(ops, font, 'June 30, 2026', 262, 94);
  put(ops, font, 'June 30, 2025', 332, 94);
  put(ops, font, 'June 30, 2026', 404, 94);
  put(ops, font, 'June 30, 2025', 476, 94);
  line(ops, font, 110, 'Investment income:', 82, [], opsEdges);
  line(ops, font, 122, 'Interest income', 88, ['10', '9', '20', '17'], opsEdges);
  line(ops, font, 134, 'Total investment income', 82, ['10', '9', '20', '17'], opsEdges);
  line(ops, font, 150, 'Expenses:', 82, [], opsEdges);
  line(ops, font, 162, 'Management fees', 88, ['1', '1', '2', '2'], opsEdges);
  line(ops, font, 174, 'Distribution and shareholder servicing fees', 88, [], opsEdges);
  line(ops, font, 186, 'Class S', 95, ['(1)', '—', '(1)', '—'], opsEdges);
  line(ops, font, 198, 'Net investment income', 82, ['10', '8', '19', '15'], opsEdges);
  line(ops, font, 214, 'Net increase (decrease) in net assets', 85, ['$ 8', '$ 7', '$ 15', '$ 13'], opsEdges);
  line(ops, font, 224, 'resulting from operations', 85, [], opsEdges);

  const soi = pdf.addPage([792, 612]);
  put(soi, font, 'Example Credit Fund', 300, 42, 'left', 10);
  put(soi, font, 'Consolidated Schedule of Investments', 315, 54, 'left', 10);
  put(soi, font, 'June 30, 2026', 367, 66, 'left', 10);
  put(soi, font, '(in thousands)', 366, 76, 'left', 10);
  put(soi, font, 'Interest', 434, 112);
  put(soi, font, 'Maturity', 473, 112);
  put(soi, font, 'Par Amount/', 547, 112);
  put(soi, font, '% of Net', 704, 112);
  put(soi, font, 'Footnotes', 266, 121);
  put(soi, font, 'Reference Rate and Spread', 321, 121);
  put(soi, font, 'Rate', 435, 121);
  put(soi, font, 'Date', 481, 121);
  put(soi, font, 'Units', 562, 121);
  put(soi, font, 'Cost', 613, 121);
  put(soi, font, 'Fair Value', 654, 121);
  put(soi, font, 'Assets', 709, 121);
  const investment = (top: number, company: string, values: string[]) => {
    put(soi, font, company, 53, top);
    put(soi, font, '(4) (5)', 274, top);
    put(soi, font, 'S + 5.00%', 325, top);
    put(soi, font, '8.66%', 464, top, 'right');
    put(soi, font, '9/30/2030', 475, top);
    [601, 648, 695, 741].forEach((edge, index) => put(soi, font, values[index], edge, top, 'right'));
  };
  put(soi, font, 'First Lien Debt', 53, 154);
  put(soi, font, 'Software', 53, 167);
  investment(180, 'Alpha Software LLC', ['200', '199', '200', '100.0']);
  investment(193, 'Beta Analytics Inc.', ['100', '101', '98', '49.0']);
  put(soi, font, '(Holdings) (US)', 53, 202);
  [648, 695, 741].forEach((edge, index) => put(soi, font, ['300', '298', '149.0'][index], edge, 215, 'right'));
  put(soi, font, 'Total First Lien Debt', 53, 240);
  put(soi, font, '$ 300 $ 298', 695, 240, 'right');
  put(soi, font, '149.0 %', 741, 240, 'right');
  put(soi, font, 'Common Stocks', 53, 260);
  put(soi, font, 'Software', 53, 273);
  put(soi, font, 'Alpha Equity', 53, 286);
  [601, 648, 695, 741].forEach((edge, index) => put(soi, font, ['1', '10', '2', '1.0'][index], edge, 286, 'right'));
  put(soi, font, 'Total Common Stocks', 53, 306);
  put(soi, font, '$ 10 $ 2', 695, 306, 'right');
  put(soi, font, 'Total Portfolio Investments', 53, 326);
  put(soi, font, '$ 310 $ 300', 695, 326, 'right');
  put(soi, font, '150.0 %', 741, 326, 'right');
  return pdf.save();
}

describe('amounts', () => {
  it('reads printed amounts, parentheses and dashes', () => {
    expect(parseReportAmount('$ 3,100,822')).toBe(3100822);
    expect(parseReportAmount('(84,670)')).toBe(-84670);
    expect(parseReportAmount('—')).toBe(0);
    expect(parseReportAmount('8.48 %')).toBe(8.48);
    expect(parseReportAmount('(4) (5) (7)')).toBeNull();
    expect(parseReportAmount('9/30/2030')).toBeNull();
    expect(parseReportAmount('Total assets')).toBeNull();
  });

  it('splits a run that holds two amounts, and leaves footnote marks whole', () => {
    const run = { text: '$ 2,868,101 $ 2,815,947', x: 606, y: 160, w: 89, h: 9 };
    const parts = splitAmountRuns(run);
    expect(parts.map((part) => part.text)).toEqual(['2,868,101', '2,815,947']);
    expect(parts[1].x + parts[1].w).toBeCloseTo(695, 0);
    expect(splitAmountRuns({ text: '(4) (5) (7)', x: 268, y: 160, w: 36, h: 9 })).toHaveLength(1);
    expect(splitAmountRuns({ text: '5,698 $', x: 580, y: 160, w: 30, h: 9 }).map((part) => part.text)).toEqual(['5,698']);
  });

  it('reads how many months a column covers', () => {
    expect(columnMonths('For the Three Months Ended June 30, 2026')).toBe(3);
    expect(columnMonths('For the Six Months Ended June 30, 2026')).toBe(6);
    expect(columnMonths('For the Year Ended December 31, 2025')).toBe(12);
    expect(columnMonths('As of June 30, 2026')).toBeNull();
  });
});

describe('readFinancialReport', () => {
  it('reads the statements, their columns, wrapped labels and headings', async () => {
    const report = readFinancialReport(await extractPdfFragments(await sampleReport()));
    expect(report).not.toBeNull();
    expect(report!.form).toBe('10-Q');
    expect(report!.entityName).toBe('Example Credit Fund');
    expect(report!.periodEnd).toBe('2026-06-30');
    expect(report!.comparativeDate).toBe('2025-12-31');

    const bs = report!.statements.find((statement) => statement.kind === 'BALANCE_SHEET')!;
    expect(bs.scale).toBe(1000);
    expect(bs.columns.map((column) => [column.date, column.months])).toEqual([['2026-06-30', null], ['2025-12-31', null]]);
    const investments = bs.lines.find((item) => item.label.startsWith('Non-controlled investments'))!;
    expect(investments.label).toBe('Non-controlled investments (cost of $310 and $250, respectively)');
    expect(investments.section).toBe('Investments at fair value');
    expect(investments.values).toEqual([300000, 250000]);
    expect(bs.lines.find((item) => item.label === 'Cash and cash equivalents')!.section).toBe('ASSETS');
    const shares = bs.lines.find((item) => item.label === 'Common shares outstanding')!;
    expect(shares.section).toBe('Class I Shares');
    expect(shares.unscaled).toBe(true);
    expect(shares.values).toEqual([8000, 7000]);
    expect(bs.lines.find((item) => item.label === 'Net asset value per share')!.values).toEqual([25, 25.71]);

    const ops = report!.statements.find((statement) => statement.kind === 'OPERATIONS')!;
    expect(ops.columns.map((column) => [column.date, column.months])).toEqual([
      ['2026-06-30', 3], ['2025-06-30', 3], ['2026-06-30', 6], ['2025-06-30', 6],
    ]);
    const classS = ops.lines.find((item) => item.label === 'Class S')!;
    expect(classS.section).toBe('Distribution and shareholder servicing fees');
    expect(classS.values).toEqual([-1000, 0, -1000, 0]);
    const net = ops.lines.find((item) => item.label.startsWith('Net increase'))!;
    expect(net.label).toBe('Net increase (decrease) in net assets resulting from operations');
    expect(net.values[2]).toBe(15000);
    expect(net.cells[2]).toMatchObject({ page: 3 });
  });

  it('reads the schedule with its classes, industries, wrapped names and totals, and checks it', async () => {
    const report = readFinancialReport(await extractPdfFragments(await sampleReport()));
    const schedule = report!.schedules[0];
    expect(schedule.date).toBe('2026-06-30');
    const investments = schedule.rows.filter((row) => row.kind === 'investment');
    expect(investments.map((row) => [row.assetClass, row.industry, row.company])).toEqual([
      ['First Lien Debt', 'Software', 'Alpha Software LLC'],
      ['First Lien Debt', 'Software', 'Beta Analytics Inc. (Holdings) (US)'],
      ['Common Stocks', 'Software', 'Alpha Equity'],
    ]);
    expect(investments[0]).toMatchObject({ footnotes: '(4) (5)', reference: 'S + 5.00%', rate: '8.66%', maturity: '2030-09-30', par: 200000, cost: 199000, fairValue: 200000 });
    const total = schedule.rows.find((row) => row.kind === 'class_total' && row.assetClass === 'First Lien Debt')!;
    expect([total.cost, total.fairValue]).toEqual([300000, 298000]);

    const results = Object.fromEntries(report!.checks.map((item) => [item.label, item.result]));
    expect(results['First Lien Debt, Software: fair value adds up']).toBe('Ties');
    expect(results['Total First Lien Debt: fair value adds up']).toBe('Ties');
    expect(results['Schedule of investments, June 30, 2026: total fair value adds up']).toBe('Ties');
    expect(results['Schedule of investments, June 30, 2026: total fair value agrees with the balance sheet']).toBe('Ties');
    expect(results['Class I Shares, June 30, 2026: NAV per share times shares equals net assets']).toBe('Ties');
    expect(results['Class I Shares, December 31, 2025: NAV per share times shares equals net assets']).toBe('Ties');
  });

  it('reports a schedule that does not add up as a break with both figures', async () => {
    const report = readFinancialReport(await extractPdfFragments(await sampleReport()));
    const schedule = report!.schedules[0];
    const subtotal = schedule.rows.find((row) => row.kind === 'subtotal')!;
    subtotal.fairValue = 290000;
    // Checks are made when the report is read; read the stored tables back and compare again.
    const tables = reportTables(report!);
    const back = reportFromTables(tables)!;
    expect(back.schedules[0].rows.find((row) => row.kind === 'subtotal')!.fairValue).toBe(290000);
    expect(back.statements.map((statement) => statement.kind)).toEqual(['BALANCE_SHEET', 'OPERATIONS']);
    expect(back.periodEnd).toBe('2026-06-30');
    expect(back.comparativeDate).toBe('2025-12-31');
  });

  it('is not a report without a balance sheet and another statement', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    put(page, font, 'Quarterly letter to investors', 200, 60, 'left', 12);
    put(page, font, 'Our NAV rose in the quarter.', 60, 120);
    expect(readFinancialReport(await extractPdfFragments(await pdf.save()))).toBeNull();
  });
});
