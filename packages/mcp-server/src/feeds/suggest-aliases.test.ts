import { describe, expect, it } from 'vitest';
import { suggestAssignments, type AttributeChoice, type MappingAliases } from './suggest';

const attributes: AttributeChoice[] = [
  { attributeCode: 'NAV', attributeName: 'NAV', dataType: 'NUMBER', domainCode: 'FUND', referenceListCode: null, aliasLabels: ['Ending NAV', 'Net Assets'] },
  { attributeCode: 'COUNTRY', attributeName: 'Country', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: null },
];

const aliases: MappingAliases = {
  domains: [
    { domainCode: 'ISSUER', aliasLabel: 'Borrower', aliasCode: 'BORROWER' },
    { domainCode: 'SECURITY', aliasLabel: 'Tranche', aliasCode: 'TRANCHE' },
  ],
  names: [
    { domainCode: 'ISSUER', aliasLabel: 'Borrower name', aliasCode: 'BORROWER_NAME' },
    { domainCode: 'ISSUER', aliasLabel: 'Project name', aliasCode: 'PROJECT_NAME' },
  ],
};

describe('suggestAssignments aliases', () => {
  it('maps a borrower, a project name, and ending NAV onto the catalog', () => {
    const headers = ['Borrower', 'Project Name', 'Ending NAV'];
    const rows = [
      { Borrower: 'Acme Holdings', 'Project Name': 'Project Falcon', 'Ending NAV': '100' },
      { Borrower: 'Northwind', 'Project Name': 'Project North', 'Ending NAV': '40' },
    ];
    const byColumn = Object.fromEntries(suggestAssignments(headers, rows, attributes, [], aliases).map((column) => [column.sourceColumn, column]));
    expect(byColumn.Borrower).toMatchObject({ role: 'identity', domainCode: 'ISSUER' });
    expect(byColumn['Project Name']).toMatchObject({ role: 'alias', domainCode: 'ISSUER', attributeCode: 'PROJECT_NAME' });
    expect(byColumn['Ending NAV']).toMatchObject({ role: 'attribute', domainCode: 'FUND', attributeCode: 'NAV' });
  });

  it('uses the project name as the borrower name when that is the only name column', () => {
    const headers = ['Project Name'];
    const rows = [
      { 'Project Name': 'Project Falcon' },
      { 'Project Name': 'Project North' },
    ];
    const [column] = suggestAssignments(headers, rows, attributes, [], aliases);
    expect(column.role).toBe('identity');
    expect(column.domainCode).toBe('ISSUER');
  });
});
