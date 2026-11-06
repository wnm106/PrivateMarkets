import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { readImportFile } from './intake';
import { dependencyLoadOrder } from './load-order';
import { feedMapFromAssignments, suggestAssignments, type AttributeChoice } from './suggest';
import { applyTransform, parseUsDate } from './values';

const catalog: AttributeChoice[] = [
  { attributeCode: 'ISIN', attributeName: 'ISIN', dataType: 'STRING', domainCode: 'SECURITY', referenceListCode: null },
  { attributeCode: 'TICKER', attributeName: 'Ticker', dataType: 'STRING', domainCode: 'SECURITY', referenceListCode: null },
  { attributeCode: 'SHARE_QUANTITY', attributeName: 'Share Quantity', dataType: 'DECIMAL', domainCode: 'POSITION', referenceListCode: null },
  { attributeCode: 'TOTAL_FAIR_MARKET_VALUE_AMOUNT', attributeName: 'Total Fair Market Value', dataType: 'CURRENCY', domainCode: 'POSITION', referenceListCode: null },
  { attributeCode: 'CARRYING_AMORTIZED_COST_AMOUNT', attributeName: 'Carrying Cost', dataType: 'CURRENCY', domainCode: 'POSITION', referenceListCode: null },
  { attributeCode: 'POSITION_CURRENCY', attributeName: 'Position Currency', dataType: 'STRING', domainCode: 'POSITION', referenceListCode: null },
  { attributeCode: 'NAV', attributeName: 'Net Asset Value', dataType: 'NUMBER', domainCode: 'FUND', referenceListCode: null },
  { attributeCode: 'NAV_CURRENCY', attributeName: 'NAV Currency', dataType: 'STRING', domainCode: 'FUND', referenceListCode: null },
  { attributeCode: 'CASH_AND_EQUIVALENTS', attributeName: 'Cash and Cash Equivalents', dataType: 'CURRENCY', domainCode: null, referenceListCode: null },
  { attributeCode: 'REVENUE', attributeName: 'Revenue', dataType: 'CURRENCY', domainCode: 'ISSUER', referenceListCode: null },
  { attributeCode: 'NET_INCOME', attributeName: 'Net Income', dataType: 'CURRENCY', domainCode: 'ISSUER', referenceListCode: null },
  { attributeCode: 'LEI', attributeName: 'LEI', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: null },
];

function workbook(rows: string[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Statement');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('readImportFile', () => {
  it('maps a csv of positions onto fund, security, and position', async () => {
    const csv = [
      'Portfolio,Instrument,ISIN,Shares,Market Value,Cost Basis,Currency',
      'Meridian Growth,Apple Inc,US0378331005,"1,000","173,500",150000,USD',
      'Meridian Growth,Microsoft Corporation,US5949181045,500,189450,160000,USD',
    ].join('\n');
    const read = await readImportFile('positions.csv', Buffer.from(csv));
    const assignments = suggestAssignments(read.table.headers, read.table.rows, catalog, read.hints);
    const map = feedMapFromAssignments(assignments);
    const order = dependencyLoadOrder(map.domains);
    expect(read.kind).toBe('POSITIONS');
    expect(order.indexOf('FUND')).toBeLessThan(order.indexOf('POSITION'));
    expect(order.indexOf('SECURITY')).toBeLessThan(order.indexOf('POSITION'));
    const position = map.domains.find((domain) => domain.domainCode === 'POSITION');
    expect(position?.attributes.map((attribute) => attribute.attributeCode).sort()).toEqual([
      'CARRYING_AMORTIZED_COST_AMOUNT',
      'POSITION_CURRENCY',
      'SHARE_QUANTITY',
      'TOTAL_FAIR_MARKET_VALUE_AMOUNT',
    ]);
    expect(position?.parents.map((parent) => parent.parentDomainCode).sort()).toEqual(['FUND', 'SECURITY']);
    const quantity = assignments.find((column) => column.sourceColumn === 'Shares');
    expect(quantity?.transform.kind).toBe('number');
    expect(applyTransform(read.table.rows[0]['Market Value'], { kind: 'number' })).toBe('173500');
  });

  it('maps an xlsx NAV statement onto the fund', async () => {
    const bytes = workbook([
      ['Meridian Growth Fund'],
      ['Statement of Net Assets'],
      ['As of September 30, 2024'],
      ['Currency', 'USD'],
      ['Assets'],
      ['Investments at fair value', '12400000'],
      ['Cash and cash equivalents', '800000'],
      ['Net Asset Value'],
      ['Ending NAV', '13150000'],
    ]);
    const read = await readImportFile('nav-statement.xlsx', bytes);
    const assignments = suggestAssignments(read.table.headers, read.table.rows, catalog, read.hints);
    const map = feedMapFromAssignments(assignments);
    expect(read.kind).toBe('NAV_STATEMENT');
    expect(read.asOfDate).toBe('2024-09-30');
    expect(map.domains.map((domain) => domain.domainCode)).toEqual(['FUND']);
    expect(map.asOfHintColumn).toBe('As of Date');
    const nav = map.domains[0].attributes.find((attribute) => attribute.attributeCode === 'NAV');
    expect(nav).toBeTruthy();
    expect(read.table.rows[0][nav!.column]).toBe('13150000');
    expect(assignments.find((column) => column.attributeCode === 'NAV')?.transform.kind).toBe('number');
    expect(map.domains[0].attributes.some((attribute) => attribute.attributeCode === 'CASH_AND_EQUIVALENTS')).toBe(true);
    expect(parseUsDate('September 30, 2024')).toBe('2024-09-30');
    expect(applyTransform('(85,000.00)', { kind: 'number' })).toBe('-85000.00');
  });

  it('keeps the curated position file on the source map', async () => {
    const csv = 'Domai,Poition,issuer code,fund code,security code,quantity,issuer lei\nPOSITION,POS-1,ISS-1,FUND-1,SEC-1,10,529900T8BM49AURSDO55\n';
    const read = await readImportFile('Position_FIle.csv', Buffer.from(csv));
    const assignments = suggestAssignments(read.table.headers, read.table.rows, catalog, read.hints);
    expect(read.preserveSource).toBe(true);
    expect(read.headers).toHaveLength(7);
    expect(assignments.find((column) => column.sourceColumn === 'Poition')).toMatchObject({ role: 'identity', domainCode: 'POSITION', suggestion: { method: 'source_map' } });
    expect(assignments.find((column) => column.sourceColumn === 'quantity')).toMatchObject({ attributeCode: 'SHARE_QUANTITY', suggestion: { method: 'source_map' } });
    expect(assignments.find((column) => column.sourceColumn === 'issuer lei')?.attributeCode).toBe('LEI');
  });
});
