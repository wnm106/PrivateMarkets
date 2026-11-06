import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parseData } from '../import-map/data-parsers';
import { extractPdfText, itemsToLines } from './pdf-text';
import { interpretMatrices, interpretText } from './interpret';

const positions = `Position extract
Run 2024-09-30

Portfolio;Instrument;ISIN;Qty;Mkt Value;Book Cost;Ccy;As Of
Meridian Growth;Apple Inc;US0378331005;1,000;"173,500.00";150000;USD;9/30/2024
Meridian Growth;Microsoft Corporation;US5949181045;500;189450;160000;USD;09/30/2024
`;

const navRows = [
  ['Meridian Growth Fund'],
  ['Statement of Net Assets'],
  ['As of September 30, 2024'],
  ['Currency', 'USD'],
  [],
  ['Assets'],
  ['Investments at fair value', '12400000'],
  ['Cash and cash equivalents', '800000'],
  ['Total assets', '13200000'],
  ['Liabilities'],
  ['Accrued expenses', '50000'],
  ['Total liabilities', '50000'],
  ['Net Asset Value'],
  ['Ending NAV', '13150000'],
];

const financial = `Northwind Holdings Inc.
Consolidated Statement of Operations
For the year ended December 31, 2025

Income
Revenue                  8,200,000
Cost of goods sold       3,100,000
Gross profit             5,100,000
Operating income         2,400,000
Net income               1,600,000
Balance Sheet
Total assets            12,000,000
Total liabilities        4,500,000
Total equity             7,500,000
Cash                       900,000
`;

function column(doc: ReturnType<typeof interpretText>, header: string) {
  return doc.rows[0]?.[header];
}

function target(doc: ReturnType<typeof interpretText>, header: string) {
  return doc.targets.find((item) => item.column === header);
}

describe('position files', () => {
  it('reads a preamble, a semicolon delimiter, and quoted amounts', () => {
    const doc = interpretText('holdings.csv', positions, 'csv');
    expect(doc.kind).toBe('POSITIONS');
    expect(doc.mapCode).toBe('POSITION_FILE');
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0].Portfolio).toBe('Meridian Growth');
    expect(doc.rows[0]['Mkt Value']).toBe('173,500.00');
    expect(doc.asOfDate).toBe('2024-09-30');
    expect(target(doc, 'Fund Code')).toMatchObject({ role: 'identity', domainCode: 'FUND' });
    expect(target(doc, 'Portfolio')).toMatchObject({ role: 'name', domainCode: 'FUND' });
    expect(target(doc, 'Security Code')).toMatchObject({ role: 'identity', domainCode: 'SECURITY' });
    expect(target(doc, 'ISIN')).toMatchObject({ role: 'attribute', attributeCode: 'ISIN' });
    expect(target(doc, 'Qty')).toMatchObject({ role: 'attribute', attributeCode: 'SHARE_QUANTITY', domainCode: 'POSITION' });
    expect(target(doc, 'Mkt Value')).toMatchObject({ attributeCode: 'TOTAL_FAIR_MARKET_VALUE_AMOUNT' });
    expect(target(doc, 'Book Cost')).toMatchObject({ attributeCode: 'CARRYING_AMORTIZED_COST_AMOUNT' });
    expect(target(doc, 'Ccy')).toMatchObject({ attributeCode: 'POSITION_CURRENCY' });
    expect(target(doc, 'As Of')).toMatchObject({ role: 'as_of' });
    expect(doc.rows[0]['Position Code']).toBe('MERIDIAN-GROWTH|US0378331005');
    expect(doc.rows[1]['Security Code']).toBe('US5949181045');
  });

  it('leaves the curated position file columns and amounts untouched', () => {
    const doc = interpretText('Position_FIle.csv', [
      'Domai,Poition,issuer code,fund code,security code,quantity,market value,valid from',
      'POSITION,POS-1,ISS-1,FUND-1,SEC-1,"1,000","173,500.00",9/30/2024',
    ].join('\n'), 'csv');
    expect(doc.preserveSource).toBe(true);
    expect(doc.targets).toEqual([]);
    expect(doc.headers).toEqual(['Domai', 'Poition', 'issuer code', 'fund code', 'security code', 'quantity', 'market value', 'valid from']);
    expect(doc.rows[0]['market value']).toBe('173,500.00');
    expect(doc.rows[0].quantity).toBe('1,000');
  });

  it('keeps a wide position sheet as holdings rather than a statement', () => {
    const doc = interpretMatrices('book.xlsx', [{
      name: 'Holdings',
      rows: [
        ['Fund', 'Security', 'ISIN', 'Shares', 'Market Value'],
        ['Growth', 'Apple Inc', 'US0378331005', '10', '1735'],
      ],
    }]);
    expect(doc.kind).toBe('POSITIONS');
    expect(doc.rows).toHaveLength(1);
    expect(target(doc, 'Shares')?.attributeCode).toBe('SHARE_QUANTITY');
  });
});

describe('statements', () => {
  it('reads a NAV spreadsheet with a title block', () => {
    const doc = interpretMatrices('nav.xlsx', [{ name: 'NAV', rows: navRows }]);
    expect(doc.kind).toBe('NAV_STATEMENT');
    expect(doc.mapCode).toBe('NAV_STATEMENT');
    expect(doc.entityName).toBe('Meridian Growth Fund');
    expect(doc.asOfDate).toBe('2024-09-30');
    expect(doc.domains).toEqual(['FUND']);
    expect(column(doc, 'Entity Code')).toBe('MERIDIAN-GROWTH-FUND');
    expect(target(doc, 'Ending NAV')).toMatchObject({ attributeCode: 'NAV', domainCode: 'FUND' });
    expect(column(doc, 'Ending NAV')).toBe('13150000');
    expect(target(doc, 'Cash and cash equivalents')?.attributeCode).toBe('CASH_AND_EQUIVALENTS');
    expect(target(doc, 'Investments at fair value')?.attributeCode).toBe('INVESTMENTS_AT_FAIR_VALUE');
    expect(target(doc, 'Total assets')?.attributeCode).toBe('TOTAL_ASSETS');
    expect(target(doc, 'Accrued expenses')?.attributeCode).toBe('ACCRUED_EXPENSES');
    expect(target(doc, 'Currency')?.attributeCode).toBe('NAV_CURRENCY');
    expect(column(doc, 'Currency')).toBe('USD');
  });

  it('reads a sectioned NAV csv', () => {
    const doc = interpretText('nav.csv', [
      'Section,Line Item,Amount',
      'Assets,Investments at fair value,12400000',
      'Assets,Cash and cash equivalents,800000',
      'Net Asset Value,Ending NAV,13150000',
    ].join('\n'), 'csv');
    expect(doc.kind).toBe('NAV_STATEMENT');
    expect(target(doc, 'Ending NAV')?.attributeCode).toBe('NAV');
    expect(column(doc, 'Cash and cash equivalents')).toBe('800000');
  });

  it('reads a company financial statement and keeps the latest period', async () => {
    const prose = interpretText('northwind.pdf', financial, 'pdf');
    expect(prose.kind).toBe('FINANCIAL_STATEMENT');
    expect(prose.domains).toEqual(['ISSUER']);
    expect(prose.entityName).toBe('Northwind Holdings Inc.');
    expect(prose.asOfDate).toBe('2025-12-31');
    expect(target(prose, 'Revenue')).toMatchObject({ attributeCode: 'REVENUE', domainCode: 'ISSUER' });
    expect(column(prose, 'Revenue')).toBe('8,200,000');
    expect(target(prose, 'Net income')?.attributeCode).toBe('NET_INCOME');
    expect(target(prose, 'Total assets')?.attributeCode).toBe('TOTAL_ASSETS');
    expect(target(prose, 'Cash')?.attributeCode).toBe('CASH');

    const parsed = await parseData(financial, 'auto', { fileName: 'northwind.txt' });
    expect(parsed.documentKind).toBe('FINANCIAL_STATEMENT');
    expect(parsed.format).toBe('csv');
    expect(parsed.suggestedDomains).toEqual(['ISSUER']);
    expect(parsed.records[0].REVENUE).toBe('8,200,000');
    expect(parsed.records[0].NET_INCOME).toBe('1,600,000');
    expect(parsed.records[0].ENTITY_NAME).toBe('Northwind Holdings Inc.');

    const compared = interpretMatrices('fy.xlsx', [{
      rows: [
        ['Northwind Holdings Inc.'],
        ['', 'FY 2025', 'FY 2024'],
        ['Revenue', '8200000', '7100000'],
        ['Net income', '1600000', '1200000'],
      ],
    }]);
    expect(compared.kind).toBe('FINANCIAL_STATEMENT');
    expect(compared.asOfDate).toBe('2025-12-31');
    expect(column(compared, 'Revenue')).toBe('8200000');
    expect(compared.reason).toContain('FY 2025');
  });

  it('reads an html statement table', () => {
    const doc = interpretText('page.html', '<h2>Assets</h2><table><tr><th>Line</th><th>Amount</th></tr><tr><td>Cash</td><td>20</td></tr><tr><td>Ending NAV</td><td>100</td></tr></table>', 'html');
    expect(doc.kind).toBe('NAV_STATEMENT');
    expect(target(doc, 'Ending NAV')?.attributeCode).toBe('NAV');
    expect(column(doc, 'Cash')).toBe('20');
  });
});

describe('pdf text', () => {
  it('keeps a label and an amount in separate cells', () => {
    const text = itemsToLines([
      { str: 'Revenue', transform: [1, 0, 0, 1, 72, 700], width: 48 },
      { str: '8,200,000', transform: [1, 0, 0, 1, 360, 700], width: 60 },
      { str: 'Net income', transform: [1, 0, 0, 1, 72, 680], width: 70 },
      { str: '1,600,000', transform: [1, 0, 0, 1, 360, 682], width: 60 },
    ]);
    expect(text).toBe('Revenue\t8,200,000\nNet income\t1,600,000');
  });

  it('reads a text PDF of financials', async () => {
    const bytes = await financialPdf();
    const text = await extractPdfText(bytes);
    expect(text).toContain('Northwind Holdings Inc.');
    expect(text).toMatch(/Revenue\t/);
    const doc = interpretText('northwind.pdf', text, 'pdf');
    expect(doc.kind).toBe('FINANCIAL_STATEMENT');
    expect(doc.entityName).toBe('Northwind Holdings Inc.');
    expect(target(doc, 'Revenue')?.attributeCode).toBe('REVENUE');
    expect(column(doc, 'Net income')?.replace(/,/g, '')).toBe('1600000');
    expect(doc.asOfDate).toBe('2025-12-31');
  });
});

async function financialPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines: Array<[string, number, number]> = [
    ['Northwind Holdings Inc.', 72, 740],
    ['Consolidated Statement of Operations', 72, 722],
    ['For the year ended December 31, 2025', 72, 704],
    ['Income', 72, 670],
    ['Revenue', 72, 648],
    ['8,200,000', 360, 648],
    ['Cost of goods sold', 72, 630],
    ['3,100,000', 360, 630],
    ['Net income', 72, 612],
    ['1,600,000', 360, 612],
    ['Balance Sheet', 72, 580],
    ['Total assets', 72, 558],
    ['12,000,000', 360, 558],
    ['Cash', 72, 540],
    ['900,000', 360, 540],
  ];
  for (const [text, x, y] of lines) {
    page.drawText(text, { x, y, size: 11, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
}
