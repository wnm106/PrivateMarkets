import { describe, expect, it } from 'vitest';
import { sampleFit, suggestAssignments, type AttributeChoice } from './suggest';

const attr = (attributeCode: string, attributeName: string, dataType: string, domainCode: string): AttributeChoice => ({
  attributeCode, attributeName, dataType, domainCode, referenceListCode: null,
});

const catalog: AttributeChoice[] = [
  attr('ISSUER_INDUSTRY_SECTOR', 'Issuer Industry', 'STRING', 'ISSUER'),
  attr('FACILITY_DRAWN', 'Drawn', 'CURRENCY', 'CREDIT_FACILITY'),
  attr('FACILITY_MATURITY', 'Maturity', 'DATE', 'CREDIT_FACILITY'),
  attr('FUNDED_PAR_AMOUNT', 'Funded Par Amount', 'CURRENCY', 'POSITION'),
  attr('SPREAD_BPS', 'Spread (bps)', 'NUMBER', 'SECURITY'),
  attr('LEI', 'Legal Entity Identifier', 'STRING', 'ISSUER'),
  attr('DRAWN_NAME_NOTE', 'Facility Note', 'STRING', 'CREDIT_FACILITY'),
];

const headers = ['Issuer', 'Facility', 'Par Amount', 'Spread (bps)', 'Maturity'];
const rows = [
  { Issuer: 'Acme Corp', Facility: 'Term Loan B', 'Par Amount': '12,500,000', 'Spread (bps)': '425', Maturity: '2030-06-30' },
  { Issuer: 'Beta LLC', Facility: 'Revolver', 'Par Amount': '(3,000,000)', 'Spread (bps)': '375', Maturity: '2029-03-31' },
  { Issuer: 'Gamma Inc', Facility: 'Term Loan A', 'Par Amount': '8,250,000.50', 'Spread (bps)': '350', Maturity: '2031-09-15' },
];

describe('sampleFit', () => {
  it('scores how well values fit a type', () => {
    expect(sampleFit(['$1,000', '(500)', '2.5%'], 'NUMBER')).toBe(1);
    expect(sampleFit(['Term Loan B', 'Revolver', '12'], 'CURRENCY')).toBeCloseTo(1 / 3);
    expect(sampleFit(['2030-06-30', 'soon'], 'DATE')).toBe(0.5);
    expect(sampleFit(['anything'], 'STRING')).toBe(1);
    expect(sampleFit([], 'NUMBER')).toBe(1);
  });
});

describe('suggestAssignments with context', () => {
  const byColumn = () => Object.fromEntries(suggestAssignments(headers, rows, catalog).map((item) => [item.sourceColumn, item]));

  it('treats a column named for a record type, holding names, as that record\'s identity', () => {
    const result = byColumn();
    expect(result.Issuer).toMatchObject({ role: 'identity', domainCode: 'ISSUER' });
    expect(result.Facility).toMatchObject({ role: 'identity', domainCode: 'CREDIT_FACILITY' });
    expect(result.Issuer.suggestion.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('never offers a money field for a column of names', () => {
    const result = byColumn();
    expect(result.Facility.attributeCode).not.toBe('FACILITY_DRAWN');
  });

  it('keeps a field that fits the identified record confident', () => {
    const result = byColumn();
    expect(result.Maturity).toMatchObject({ role: 'attribute', domainCode: 'CREDIT_FACILITY', attributeCode: 'FACILITY_MATURITY' });
    expect(result.Maturity.suggestion.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('sends a field on a record the file does not identify to the user', () => {
    const result = byColumn();
    expect(result['Par Amount'].domainCode).toBe('POSITION');
    expect(result['Par Amount'].suggestion.confidence).toBeLessThan(0.8);
    expect(result['Par Amount'].suggestion.reason).toMatch(/no identity column/);
  });

  it('lowers confidence when only some values fit the type', () => {
    const mixed = rows.map((row, index) => ({ ...row, 'Par Amount': index === 0 ? 'n/a text' : row['Par Amount'], Notes: '' }));
    mixed[1]['Par Amount'] = 'about two';
    const result = Object.fromEntries(suggestAssignments(headers, mixed, catalog).map((item) => [item.sourceColumn, item]));
    expect(result['Par Amount'].attributeCode).not.toBe('FUNDED_PAR_AMOUNT');
  });

  it('does not make a column of repeated values an identity', () => {
    const repeated = rows.map((row) => ({ ...row, Issuer: 'Acme Corp' }));
    const result = Object.fromEntries(suggestAssignments(headers, repeated, catalog).map((item) => [item.sourceColumn, item]));
    expect(result.Issuer.role).not.toBe('identity');
  });
});
