import { describe, expect, it } from 'vitest';
import { matchColumnsToStoredRecords, rankHits, scoreHit, type StoredHit } from './entity-values';
import { suggestAssignments, type AttributeChoice } from './suggest';

const attr = (attributeCode: string, attributeName: string, dataType: string, domainCode: string): AttributeChoice => ({
  attributeCode, attributeName, dataType, domainCode, referenceListCode: null,
});

const catalog: AttributeChoice[] = [
  attr('NAV_DATE', 'NAV Date', 'DATE', 'NAV_STATEMENT'),
  attr('NAV_TOTAL', 'Net Asset Value', 'CURRENCY', 'NAV_STATEMENT'),
  attr('STATEMENT_END', 'Period End', 'DATE', 'STATEMENT_PERIOD'),
  attr('STATEMENT_REVENUE', 'Revenue', 'CURRENCY', 'STATEMENT_PERIOD'),
  attr('STATEMENT_COGS', 'Cost of Revenue', 'CURRENCY', 'STATEMENT_PERIOD'),
  attr('STATEMENT_SM', 'Sales and Marketing', 'CURRENCY', 'STATEMENT_PERIOD'),
  attr('ISSUER_INDUSTRY_SECTOR', 'Issuer Industry', 'STRING', 'ISSUER'),
];

const headers = ['Statement', 'Borrower', 'Period end', 'Revenue', 'Cost of revenue', 'Sales and marketing'];
const rows = [{
  Statement: 'HALY-STMT-HALYARD-202609',
  Borrower: 'Halyard Systems',
  'Period end': '2026-09-30',
  Revenue: '37313043.72',
  'Cost of revenue': '11417791.38',
  'Sales and marketing': '6343217.43',
}];

const issuer: StoredHit = { id: 'i1', code: 'HALYARD_SYSTEMS', name: 'Halyard Systems, Inc.', domainCode: 'ISSUER', alias: null };

describe('header word versus the rest of the file', () => {
  it('does not take a statement period for a NAV statement because of one word in a header', () => {
    const byColumn = Object.fromEntries(suggestAssignments(headers, rows, catalog).map((item) => [item.sourceColumn, item]));
    expect(byColumn.Statement).toMatchObject({ role: 'identity', domainCode: 'STATEMENT_PERIOD' });
    expect(byColumn.Revenue).toMatchObject({ role: 'attribute', domainCode: 'STATEMENT_PERIOD', attributeCode: 'STATEMENT_REVENUE' });
  });
});

describe('scoring stored records', () => {
  it('is surest of an exact code, then an exact name, then a name apart from its suffix', () => {
    expect(scoreHit('HALYARD_SYSTEMS', issuer).confidence).toBe(1);
    expect(scoreHit('halyard systems, inc.', issuer).confidence).toBe(0.97);
    expect(scoreHit('Halyard Systems', issuer).confidence).toBe(0.92);
  });

  it('ranks the closest record first and drops those that do not resemble the value', () => {
    const other: StoredHit = { id: 'f1', code: 'HALYARD_FUND', name: 'Halyard Systems Fund I', domainCode: 'FUND', alias: null };
    const stranger: StoredHit = { id: 'x1', code: 'ACME', name: 'Acme', domainCode: 'ISSUER', alias: null };
    const ranked = rankHits('Halyard Systems', [other, stranger, issuer]);
    expect(ranked.map((hit) => hit.id)).toEqual(['i1', 'f1']);
  });
});

describe('a column of stored names', () => {
  const lookup = async (values: string[]) => new Map(values.map((value) => [value, [issuer]]));

  it('knows Borrower holds issuers because a stored issuer has that name', async () => {
    const base = suggestAssignments(headers, rows, catalog);
    const matched = await matchColumnsToStoredRecords(base, rows, lookup);
    const borrower = matched.find((item) => item.sourceColumn === 'Borrower');
    expect(borrower).toMatchObject({ role: 'name', domainCode: 'ISSUER' });
    expect(borrower?.suggestion.confidence).toBeGreaterThan(0.85);
  });

  it('leaves the column alone when nothing stored has those names', async () => {
    const base = suggestAssignments(headers, rows, catalog);
    const matched = await matchColumnsToStoredRecords(base, rows, async () => new Map());
    expect(matched.find((item) => item.sourceColumn === 'Borrower')?.role).toBe('ignore');
  });

  it('asks rather than guesses when two record types fit equally', async () => {
    const twin: StoredHit = { ...issuer, id: 'c1', code: 'HALYARD_CO', domainCode: 'COUNTERPARTY' };
    const base = suggestAssignments(headers, rows, catalog);
    const matched = await matchColumnsToStoredRecords(base, rows, async (values) => new Map(values.map((value) => [value, [issuer, twin]])));
    expect(matched.find((item) => item.sourceColumn === 'Borrower')?.role).toBe('ignore');
  });
});
