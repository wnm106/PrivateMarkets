import { describe, expect, it } from 'vitest';
import { buildStatementTemplate, retargetLine } from './build';
import { isDomainCode, statementKindCode } from './entities';
import { labelMatchesAlias } from './normalize';
import { parseStatementSource, visionJsonToStatementText } from './parse';
import type { CatalogAttribute } from './types';

const fundCatalog: CatalogAttribute[] = [
  { attributeCode: 'NAV', attributeName: 'Net Asset Value', dataType: 'NUMBER', aliases: ['Net Assets'] },
  { attributeCode: 'NAV_DATE', attributeName: 'NAV Date', dataType: 'DATE' },
  { attributeCode: 'NAV_CURRENCY', attributeName: 'NAV Currency', dataType: 'STRING' },
  { attributeCode: 'AUM', attributeName: 'Assets Under Management', dataType: 'NUMBER' },
  { attributeCode: 'CASH', attributeName: 'Cash', dataType: 'NUMBER' },
];

const issuerCatalog: CatalogAttribute[] = [
  { attributeCode: 'MARKET_CAP', attributeName: 'Market Capitalization', dataType: 'NUMBER' },
  { attributeCode: 'REVENUE', attributeName: 'Revenue', dataType: 'NUMBER', aliases: ['Turnover'] },
];

const navA = `
Assets
Investments at Fair Value          12,400,000.00
Cash and Cash Equivalents           1,250,000.00
Liabilities
Accrued Expenses                       85,000.00
Net Asset Value
Ending NAV                         13,565,000.00
NAV Date                              31-Jan-2026
Currency                                    USD
`;

const navB = `
Net Asset Value
Net Asset Value                    13,565,000.00
Valuation Date                     2026-01-31
Assets
Cash                                  400,000
Investments at Fair Value          12,000,000
Receivable from Manager                50,000
Liabilities
Accrued Expenses                       40,000
`;

describe('parseStatementSource', () => {
  it('reads a pasted NAV statement into sections and typed lines', () => {
    const parsed = parseStatementSource({ sourceName: 'Fund A', sourceKind: 'paste', text: navA });
    const names = parsed.sections.map((section) => section.name);
    expect(names).toEqual(['Assets', 'Liabilities', 'Net Asset Value']);
    const investments = parsed.sections[0].lines[0];
    expect(investments.label).toBe('Investments at Fair Value');
    expect(investments.dataType).toBe('NUMBER');
    const navDate = parsed.sections[2].lines.find((line) => line.label === 'NAV Date');
    expect(navDate?.dataType).toBe('DATE');
    expect(parsed.sections[2].lines.find((line) => line.label === 'Currency')?.dataType).toBe('STRING');
  });

  it('reads a sectioned csv and a wide csv', () => {
    const sectioned = parseStatementSource({
      sourceName: 'section.csv',
      sourceKind: 'file',
      text: 'Section,Line Item,Amount\nAssets,Investments,100\nAssets,Cash,20\nLiabilities,Accrued Expenses,5\n',
    });
    expect(sectioned.sections.map((section) => section.name)).toEqual(['Assets', 'Liabilities']);
    expect(sectioned.sections[0].lines.map((line) => line.label)).toEqual(['Investments', 'Cash']);

    const wide = parseStatementSource({
      sourceName: 'wide.csv',
      sourceKind: 'file',
      text: 'NAV,NAV Date,Currency\n100,2026-01-31,USD\n',
    });
    expect(wide.sections).toHaveLength(1);
    expect(wide.sections[0].lines.map((line) => line.label)).toEqual(['NAV', 'NAV Date', 'Currency']);
    expect(wide.sections[0].lines[1].dataType).toBe('DATE');
  });

  it('reads markdown and html tables', () => {
    const markdown = parseStatementSource({
      sourceName: 'md',
      sourceKind: 'paste',
      text: '## Income\n| Line | Amount |\n| --- | --- |\n| Revenue | 80 |\n| Net income | 10 |\n',
    });
    expect(markdown.sections[0].name).toBe('Income');
    expect(markdown.sections[0].lines.map((line) => line.label)).toEqual(['Revenue', 'Net income']);

    const html = parseStatementSource({
      sourceName: 'page.html',
      sourceKind: 'file',
      text: '<h2>Assets</h2><table><tr><th>Line</th><th>Amount</th></tr><tr><td>Cash</td><td>20</td></tr></table>',
    });
    expect(html.sections[0].name).toBe('Assets');
    expect(html.sections[0].lines[0].label).toBe('Cash');
  });

  it('turns a vision payload into statement text', () => {
    const text = visionJsonToStatementText({
      sections: [{ name: 'Assets', lines: [{ label: 'Cash', value: '20' }, { label: 'Investments', value: '100' }] }],
    });
    const parsed = parseStatementSource({ sourceName: 'scan.png', sourceKind: 'image', text });
    expect(parsed.sections[0].name).toBe('Assets');
    expect(parsed.sections[0].lines.map((line) => line.label)).toEqual(['Cash', 'Investments']);
  });
});

describe('buildStatementTemplate', () => {
  it('aggregates two NAV statements into one ordered template and aliases ending NAV', () => {
    const draft = buildStatementTemplate([
      { sourceName: 'Admin A', sourceKind: 'paste', text: navA },
      { sourceName: 'Admin B', sourceKind: 'paste', text: navB },
    ], fundCatalog, { statementKind: 'NAV' });

    const sectionNames = draft.sections.map((section) => section.sectionName);
    expect(sectionNames[0]).toBe('Assets');
    expect(sectionNames).toContain('Liabilities');
    expect(sectionNames).toContain('Net Asset Value');
    expect(sectionNames.indexOf('Assets')).toBeLessThan(sectionNames.indexOf('Net Asset Value'));

    const navSection = draft.sections.find((section) => section.sectionName === 'Net Asset Value');
    const nav = navSection?.lines.find((line) => line.attributeCode === 'NAV');
    expect(nav?.isNew).toBe(false);
    expect(nav?.matchKind).toBe('alias');
    expect(nav?.aliases).toContain('Ending NAV');
    expect(nav?.sources).toEqual(['Admin A', 'Admin B']);
    expect(nav?.required).toBe(true);

    const assets = draft.sections.find((section) => section.sectionName === 'Assets');
    const labels = assets?.lines.map((line) => line.attributeCode);
    expect(labels).toContain('INVESTMENTS_AT_FAIR_VALUE');
    expect(labels).toContain('CASH_AND_EQUIVALENTS');
    const receivable = assets?.lines.find((line) => line.displayLabel === 'Receivable from Manager');
    expect(receivable?.isNew).toBe(true);
    expect(receivable?.required).toBe(false);
    expect(receivable?.attributeCode).toBe('RECEIVABLE_FROM_MANAGER');
  });

  it('keeps one copy of an attribute when two sections both resolve to it', () => {
    const draft = buildStatementTemplate([
      { sourceName: 'A', sourceKind: 'paste', text: 'Assets\nCash    10\n' },
      { sourceName: 'B', sourceKind: 'paste', text: 'Cash\nCash balance    4\n' },
    ], fundCatalog, { statementKind: 'NAV' });
    const cashLines = draft.sections.flatMap((section) => section.lines.filter((line) => line.attributeCode === 'CASH'));
    expect(cashLines).toHaveLength(1);
    expect(cashLines[0].sources.sort()).toEqual(['A', 'B']);
  });

  it('keeps cash and cash equivalents distinct when both appear', () => {
    const draft = buildStatementTemplate([
      {
        sourceName: 'both',
        sourceKind: 'paste',
        text: 'Assets\nCash    10\nCash and Cash Equivalents    25\n',
      },
    ], fundCatalog, { statementKind: 'NAV' });
    const codes = draft.sections[0].lines.map((line) => line.attributeCode);
    expect(codes).toEqual(['CASH', 'CASH_AND_EQUIVALENTS']);
  });

  it('applies a stored alias before inventing an attribute', () => {
    const draft = buildStatementTemplate([
      { sourceName: 'alias', sourceKind: 'paste', text: 'Summary\nNet Assets    10\n' },
    ], fundCatalog, { statementKind: 'NAV' });
    const line = draft.sections[0].lines[0];
    expect(line.attributeCode).toBe('NAV');
    expect(line.matchKind).toBe('alias');
    expect(line.isNew).toBe(false);
  });

  it('maps company statement wording onto revenue and proposes net income', () => {
    const draft = buildStatementTemplate([
      {
        sourceName: 'FY25',
        sourceKind: 'paste',
        text: 'Income\nTurnover    80\nProfit for the period    12\nBalance Sheet\nMarket Cap    400\n',
      },
    ], issuerCatalog, { statementKind: 'FINANCIAL' });
    const income = draft.sections.find((section) => section.sectionName === 'Income');
    expect(income?.lines.find((line) => line.displayLabel === 'Turnover')).toMatchObject({
      attributeCode: 'REVENUE',
      matchKind: 'alias',
      isNew: false,
    });
    expect(income?.lines.find((line) => line.displayLabel === 'Profit for the period')).toMatchObject({
      attributeCode: 'NET_INCOME',
      isNew: true,
      matchKind: 'new',
    });
    const balance = draft.sections.find((section) => section.sectionName === 'Balance Sheet');
    expect(balance?.lines[0].attributeCode).toBe('MARKET_CAP');
    expect(balance?.lines[0].matchKind).toBe('exact');
  });

  it('orders sections by their average position across statements', () => {
    const draft = buildStatementTemplate([
      { sourceName: 'A', sourceKind: 'paste', text: 'Assets\nCash    1\nLiabilities\nAccrued Expenses    1\nNet Asset Value\nEnding NAV    1\n' },
      { sourceName: 'B', sourceKind: 'paste', text: 'Net Asset Value\nNet Asset Value    1\nAssets\nCash    1\nLiabilities\nAccrued Expenses    1\n' },
    ], fundCatalog, { statementKind: 'NAV' });
    expect(draft.sections.map((section) => section.sectionName)).toEqual(['Assets', 'Net Asset Value', 'Liabilities']);
  });

  it('lets a reviewer point a line at another attribute or keep it new', () => {
    const draft = buildStatementTemplate([
      { sourceName: 'A', sourceKind: 'paste', text: 'Assets\nEnding NAV    5\n' },
    ], fundCatalog, { statementKind: 'NAV' });
    const line = draft.sections[0].lines[0];
    expect(line.attributeCode).toBe('NAV');
    const asNew = retargetLine(line, null);
    expect(asNew.isNew).toBe(true);
    expect(asNew.attributeCode).toBe('ENDING_NAV');
    const manual = retargetLine(asNew, fundCatalog[2]);
    expect(manual).toMatchObject({ attributeCode: 'NAV_CURRENCY', matchKind: 'manual', isNew: false });
    expect(manual.aliases).toContain('Ending NAV');
  });
});

describe('statement domains', () => {
  it('accepts every domain code and keeps statement shape separate', () => {
    expect(isDomainCode('FUND')).toBe(true);
    expect(isDomainCode('issuer')).toBe(true);
    expect(isDomainCode('SECURITY')).toBe(true);
    expect(isDomainCode('DEAL')).toBe(true);
    expect(isDomainCode('POSITION')).toBe(true);
    expect(isDomainCode('')).toBe(false);
    expect(statementKindCode('nav')).toBe('NAV');
    expect(statementKindCode('loan tape')).toBe('LOAN_TAPE');
    expect(statementKindCode('')).toBe('CUSTOM');
  });
});

describe('labelMatchesAlias', () => {
  it('treats stored alias wording as the same label', () => {
    expect(labelMatchesAlias('Ending NAV', ['ending nav'])).toBe(true);
    expect(labelMatchesAlias('Total Revenue', ['Net income'])).toBe(false);
  });
});
