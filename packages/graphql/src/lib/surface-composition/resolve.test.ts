import { describe, expect, it } from 'vitest';
import {
  describeRules,
  mergeFacts,
  normalizeFacts,
  resolveSurfaceComposition,
  type SurfaceCatalogInput,
} from './resolve';

const rules = (attributeCode: string, value: string) => ({
  logic: 'AND' as const,
  conditions: [{ attributeCode, operator: 'equals' as const, value }],
});

const relationship = (attributeCode: string) => ({
  attributeCode,
  operator: 'relationship_present' as const,
});

function fundCatalog(): SurfaceCatalogInput {
  return {
    experiences: [
      { id: 'base', code: 'FUND_BASELINE', name: 'Fund baseline', isBaseline: true, priority: 100, displayOrder: 1, rules: {} },
      { id: 'bdc', code: 'PUBLIC_BDC_PERFORMANCE', name: 'Public BDC performance', isBaseline: false, priority: 10, displayOrder: 2, rules: rules('FUND_STRUCTURE', 'PUBLIC_BDC') },
      { id: 'closed', code: 'CLOSED_END_PERFORMANCE', name: 'Closed-end performance', isBaseline: false, priority: 10, displayOrder: 3, rules: rules('FUND_STRUCTURE', 'CLOSED_END') },
      { id: 'bdc-coa', code: 'BDC_CHART', name: 'BDC chart of accounts', isBaseline: false, priority: 10, displayOrder: 4, rules: rules('TEMPLATE_CODE', 'FUND_NAV_BDC') },
      { id: 'pe-coa', code: 'PE_CHART', name: 'PE chart of accounts', isBaseline: false, priority: 10, displayOrder: 5, rules: rules('TEMPLATE_CODE', 'FUND_NAV_PE') },
    ],
    slots: [
      { id: 'overview', code: 'OVERVIEW', name: 'Overview', displayOrder: 1, optionality: 'always' },
      { id: 'performance', code: 'PERFORMANCE', name: 'Performance', displayOrder: 2, optionality: 'always' },
      { id: 'nav', code: 'NAV', name: 'NAV statement', displayOrder: 3, optionality: 'when_qualified' },
      { id: 'capital', code: 'CAPITAL', name: 'Capital accounts', displayOrder: 4, optionality: 'when_qualified' },
      { id: 'investors', code: 'INVESTORS', name: 'Investors', displayOrder: 5, optionality: 'always' },
    ],
    variants: [
      { id: 'overview-default', slotId: 'overview', code: 'FUND_OVERVIEW', name: 'Fund overview', priority: 100, requiredExperienceIds: [] },
      { id: 'overview-bdc', slotId: 'overview', code: 'BDC_OVERVIEW', name: 'BDC overview', priority: 10, requiredExperienceIds: ['bdc'] },
      { id: 'perf-default', slotId: 'performance', code: 'PERFORMANCE_DEFAULT', name: 'Performance summary', priority: 100, requiredExperienceIds: [] },
      { id: 'perf-bdc', slotId: 'performance', code: 'BDC_TOTAL_RETURN', name: 'BDC total return', priority: 10, requiredExperienceIds: ['bdc'] },
      { id: 'perf-closed', slotId: 'performance', code: 'CLOSED_END_IRR', name: 'Closed-end IRR', priority: 20, requiredExperienceIds: ['closed'] },
      { id: 'nav-bdc', slotId: 'nav', code: 'BDC_COA', name: 'BDC chart of accounts', priority: 10, requiredExperienceIds: ['bdc-coa'] },
      { id: 'nav-pe', slotId: 'nav', code: 'PE_COA', name: 'Private-equity chart of accounts', priority: 10, requiredExperienceIds: ['pe-coa'] },
      { id: 'capital-pe', slotId: 'capital', code: 'PARTNER_CAPITAL', name: 'Partner capital', priority: 10, requiredExperienceIds: ['closed'] },
      { id: 'investors-default', slotId: 'investors', code: 'INVESTOR_REGISTRY', name: 'Investor registry', priority: 100, requiredExperienceIds: [] },
    ],
    components: [
      { id: 'identity', code: 'IDENTITY', name: 'Identity and terms', slotId: 'overview', variantId: null, experienceId: 'base', displayOrder: 1 },
      { id: 'standard-terms', code: 'STANDARD_TERMS', name: 'Standard fund terms', slotId: 'overview', variantId: 'overview-default', experienceId: null, displayOrder: 2 },
      { id: 'listed-terms', code: 'LISTED_SHARE_TERMS', name: 'Listed share terms', slotId: 'overview', variantId: 'overview-bdc', experienceId: 'bdc', displayOrder: 2 },
      { id: 'perf-summary', code: 'PERF_SUMMARY', name: 'Performance summary', slotId: 'performance', variantId: 'perf-default', experienceId: null, displayOrder: 1 },
      { id: 'bdc-return', code: 'BDC_RETURN', name: 'BDC total return and NAV per share', slotId: 'performance', variantId: 'perf-bdc', experienceId: 'bdc', displayOrder: 1 },
      { id: 'irr', code: 'IRR_BRIDGE', name: 'IRR, TVPI, and DPI bridge', slotId: 'performance', variantId: 'perf-closed', experienceId: 'closed', displayOrder: 1 },
      { id: 'bdc-nav', code: 'BDC_NAV_LINES', name: 'BDC NAV lines', slotId: 'nav', variantId: 'nav-bdc', experienceId: 'bdc-coa', displayOrder: 1 },
      { id: 'pe-nav', code: 'PE_NAV_LINES', name: 'Private-equity NAV lines', slotId: 'nav', variantId: 'nav-pe', experienceId: 'pe-coa', displayOrder: 1 },
      { id: 'capital', code: 'PARTNER_CAPITAL', name: 'Partner capital accounts', slotId: 'capital', variantId: 'capital-pe', experienceId: 'closed', displayOrder: 1 },
      { id: 'investors', code: 'INVESTOR_COMMITMENTS', name: 'Investor commitments', slotId: 'investors', variantId: 'investors-default', experienceId: 'base', displayOrder: 1 },
    ],
  };
}

function dealCatalog(): SurfaceCatalogInput {
  return {
    experiences: [
      { id: 'base', code: 'DEAL_BASELINE', name: 'Deal baseline', isBaseline: true, priority: 100, displayOrder: 1, rules: {} },
      {
        id: 'property',
        code: 'PROPERTY',
        name: 'Property',
        isBaseline: false,
        priority: 10,
        displayOrder: 2,
        rules: {
          logic: 'AND',
          conditions: [
            { attributeCode: 'ASSET_CLASS', operator: 'equals', value: 'REAL_ESTATE' },
            relationship('PROPERTY_OF'),
          ],
        },
      },
      {
        id: 'rent',
        code: 'RENT_ROLL',
        name: 'Rent roll',
        isBaseline: false,
        priority: 10,
        displayOrder: 3,
        rules: {
          logic: 'AND',
          conditions: [
            { attributeCode: 'ASSET_CLASS', operator: 'equals', value: 'REAL_ESTATE' },
            relationship('PROPERTY_OF'),
            relationship('UNITS'),
          ],
        },
      },
      { id: 'credit', code: 'CREDIT', name: 'Credit facility', isBaseline: false, priority: 10, displayOrder: 4, rules: rules('ASSET_CLASS', 'CREDIT') },
    ],
    slots: [
      { id: 'pipeline', code: 'PIPELINE', name: 'Pipeline', displayOrder: 1, optionality: 'always' },
      { id: 'property', code: 'PROPERTY', name: 'Property', displayOrder: 2, optionality: 'when_qualified' },
      { id: 'rent', code: 'RENT_ROLL', name: 'Rent roll', displayOrder: 3, optionality: 'when_qualified' },
      { id: 'credit', code: 'CREDIT', name: 'Credit facility', displayOrder: 4, optionality: 'when_qualified' },
    ],
    variants: [
      { id: 'pipeline-default', slotId: 'pipeline', code: 'PIPELINE_STAGE', name: 'Stage and milestones', priority: 100, requiredExperienceIds: [] },
      { id: 'property-variant', slotId: 'property', code: 'PROPERTY_SUMMARY', name: 'Property summary', priority: 10, requiredExperienceIds: ['property'] },
      { id: 'rent-variant', slotId: 'rent', code: 'RENT_ROLL_VARIANT', name: 'Unit and lease roll', priority: 10, requiredExperienceIds: ['rent'] },
      { id: 'credit-variant', slotId: 'credit', code: 'FACILITY_TERMS', name: 'Facility terms', priority: 10, requiredExperienceIds: ['credit'] },
    ],
    components: [
      { id: 'identity', code: 'DEAL_IDENTITY', name: 'Deal identity and stage', slotId: 'pipeline', variantId: null, experienceId: 'base', displayOrder: 1 },
      { id: 'property', code: 'PROPERTY_SUMMARY', name: 'Property summary', slotId: 'property', variantId: 'property-variant', experienceId: 'property', displayOrder: 1 },
      { id: 'rent', code: 'RENT_ROLL', name: 'Rent roll', slotId: 'rent', variantId: 'rent-variant', experienceId: 'rent', displayOrder: 1 },
      { id: 'facility', code: 'FACILITY_TERMS', name: 'Facility terms and covenants', slotId: 'credit', variantId: 'credit-variant', experienceId: 'credit', displayOrder: 1 },
    ],
  };
}

function byCode<T extends { code: string }>(rows: T[], code: string): T {
  const found = rows.find((row) => row.code === code);
  if (!found) throw new Error(`Missing ${code}`);
  return found;
}

describe('normalizeFacts', () => {
  it('separates attributes, relationships, and the winning template', () => {
    const facts = normalizeFacts(
      {
        attributes: { FUND_STRUCTURE: 'PUBLIC_BDC', LISTING_STATUS: 'LISTED' },
        relationships: ['PROPERTY_OF'],
      },
      'FUND_NAV_BDC',
    );
    expect(facts.map).toEqual({
      FUND_STRUCTURE: 'PUBLIC_BDC',
      LISTING_STATUS: 'LISTED',
      PROPERTY_OF: true,
      TEMPLATE_CODE: 'FUND_NAV_BDC',
    });
    expect(facts.labeled.map((fact) => fact.source)).toEqual(['ATTRIBUTE', 'ATTRIBUTE', 'RELATIONSHIP', 'TEMPLATE']);
  });

  it('lets an overlay replace a profile fact', () => {
    const base = normalizeFacts({ attributes: { FUND_STRUCTURE: 'CLOSED_END' } }, 'FUND_NAV_PE');
    const overlay = normalizeFacts({ FUND_STRUCTURE: 'PUBLIC_BDC' });
    const merged = mergeFacts(base, overlay);
    expect(merged.map.FUND_STRUCTURE).toBe('PUBLIC_BDC');
    expect(merged.map.TEMPLATE_CODE).toBe('FUND_NAV_PE');
    expect(merged.labeled.filter((fact) => fact.key === 'FUND_STRUCTURE')).toHaveLength(1);
  });
});

describe('resolveSurfaceComposition', () => {
  it('gives a public BDC the BDC story and records what lost', () => {
    const facts = normalizeFacts(
      { attributes: { FUND_STRUCTURE: 'PUBLIC_BDC', LISTING_STATUS: 'LISTED', ACCOUNTING_BASIS: 'GAAP' } },
      'FUND_NAV_BDC',
    );
    const resolved = resolveSurfaceComposition(fundCatalog(), facts.map);

    expect(byCode(resolved.experiences, 'PUBLIC_BDC_PERFORMANCE').status).toBe('QUALIFIED');
    expect(byCode(resolved.experiences, 'PUBLIC_BDC_PERFORMANCE').ruleTrace).toBe('FUND_STRUCTURE equals PUBLIC_BDC.');
    expect(byCode(resolved.experiences, 'CLOSED_END_PERFORMANCE').ruleTrace).toContain('Rule requires CLOSED_END');
    expect(byCode(resolved.experiences, 'BDC_CHART').status).toBe('QUALIFIED');
    expect(byCode(resolved.experiences, 'PE_CHART').status).toBe('NOT_QUALIFIED');

    const performance = resolved.pages.find((page) => page.slotCode === 'PERFORMANCE');
    expect(performance?.status).toBe('RENDERED');
    expect(performance?.variantCode).toBe('BDC_TOTAL_RETURN');
    expect(performance?.decision).toContain('priority 10');
    expect(performance?.decision).toContain('Closed-end IRR did not qualify');

    const capital = resolved.pages.find((page) => page.slotCode === 'CAPITAL');
    expect(capital?.status).toBe('HIDDEN');

    expect(byCode(resolved.components, 'BDC_RETURN').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'PERF_SUMMARY').status).toBe('SUPERSEDED');
    expect(byCode(resolved.components, 'PERF_SUMMARY').ruleTrace).toContain('lost to BDC total return');
    expect(byCode(resolved.components, 'STANDARD_TERMS').status).toBe('SUPERSEDED');
    expect(byCode(resolved.components, 'LISTED_SHARE_TERMS').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'IRR_BRIDGE').status).toBe('NOT_QUALIFIED');
    expect(byCode(resolved.components, 'PARTNER_CAPITAL').status).toBe('NOT_QUALIFIED');
    expect(byCode(resolved.components, 'BDC_NAV_LINES').ruleTrace).toContain('TEMPLATE_CODE equals FUND_NAV_BDC');
    expect(byCode(resolved.components, 'IDENTITY').status).toBe('QUALIFIED');
  });

  it('gives a closed-end fund the private performance story and capital accounts', () => {
    const facts = normalizeFacts(
      { attributes: { FUND_STRUCTURE: 'CLOSED_END', LISTING_STATUS: 'PRIVATE' } },
      'FUND_NAV_PE',
    );
    const resolved = resolveSurfaceComposition(fundCatalog(), facts.map);

    expect(resolved.pages.find((page) => page.slotCode === 'PERFORMANCE')?.variantCode).toBe('CLOSED_END_IRR');
    expect(resolved.pages.find((page) => page.slotCode === 'NAV')?.variantCode).toBe('PE_COA');
    expect(resolved.pages.find((page) => page.slotCode === 'CAPITAL')?.status).toBe('RENDERED');
    expect(resolved.pages.find((page) => page.slotCode === 'OVERVIEW')?.variantCode).toBe('FUND_OVERVIEW');
    expect(byCode(resolved.components, 'IRR_BRIDGE').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'BDC_RETURN').status).toBe('NOT_QUALIFIED');
    expect(byCode(resolved.components, 'STANDARD_TERMS').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'PARTNER_CAPITAL').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'PERF_SUMMARY').status).toBe('SUPERSEDED');
  });

  it('opens property and rent roll for a real estate deal and keeps them off a credit deal', () => {
    const mercer = normalizeFacts({
      attributes: { ASSET_CLASS: 'REAL_ESTATE', DEAL_TYPE: 'ACQUISITION' },
      relationships: ['PROPERTY_OF', 'UNITS'],
    });
    const realEstate = resolveSurfaceComposition(dealCatalog(), mercer.map);
    expect(byCode(realEstate.components, 'PROPERTY_SUMMARY').status).toBe('QUALIFIED');
    expect(byCode(realEstate.components, 'RENT_ROLL').ruleTrace).toContain('UNITS relationship is present');
    expect(byCode(realEstate.components, 'FACILITY_TERMS').status).toBe('NOT_QUALIFIED');
    expect(realEstate.pages.find((page) => page.slotCode === 'CREDIT')?.status).toBe('HIDDEN');

    const apex = normalizeFacts({ attributes: { ASSET_CLASS: 'CREDIT', DEAL_TYPE: 'FINANCING' } });
    const credit = resolveSurfaceComposition(dealCatalog(), apex.map);
    expect(byCode(credit.components, 'FACILITY_TERMS').status).toBe('QUALIFIED');
    expect(byCode(credit.components, 'PROPERTY_SUMMARY').ruleTrace).toContain('Rule requires REAL_ESTATE');
    expect(byCode(credit.components, 'RENT_ROLL').ruleTrace).toContain('PROPERTY_OF relationship is absent');
    expect(credit.pages.find((page) => page.slotCode === 'RENT_ROLL')?.status).toBe('HIDDEN');
  });

  it('qualifies reported financials from the reporting framework', () => {
    const catalog: SurfaceCatalogInput = {
      experiences: [
        { id: 'base', code: 'COMPANY_BASELINE', name: 'Company baseline', isBaseline: true, priority: 100, displayOrder: 1, rules: {} },
        { id: 'gaap', code: 'GAAP_FINANCIALS', name: 'GAAP reported financials', isBaseline: false, priority: 10, displayOrder: 2, rules: rules('REPORTING_FRAMEWORK', 'GAAP') },
        { id: 'statutory', code: 'STATUTORY_FINANCIALS', name: 'Statutory financials', isBaseline: false, priority: 10, displayOrder: 3, rules: rules('REPORTING_FRAMEWORK', 'STATUTORY') },
      ],
      slots: [
        { id: 'overview', code: 'OVERVIEW', name: 'Overview', displayOrder: 1, optionality: 'always' },
        { id: 'financials', code: 'FINANCIALS', name: 'Reported financials', displayOrder: 2, optionality: 'when_qualified' },
      ],
      variants: [
        { id: 'overview-default', slotId: 'overview', code: 'COMPANY_OVERVIEW', name: 'Company overview', priority: 100, requiredExperienceIds: [] },
        { id: 'gaap', slotId: 'financials', code: 'GAAP_STATEMENTS', name: 'GAAP statements', priority: 10, requiredExperienceIds: ['gaap'] },
        { id: 'statutory', slotId: 'financials', code: 'STATUTORY_STATEMENTS', name: 'Statutory statements', priority: 20, requiredExperienceIds: ['statutory'] },
      ],
      components: [
        { id: 'identity', code: 'LEGAL_IDENTITY', name: 'Legal identity', slotId: 'overview', variantId: null, experienceId: 'base', displayOrder: 1 },
        { id: 'gaap', code: 'GAAP_LINES', name: 'Income statement, balance sheet, cash flow', slotId: 'financials', variantId: 'gaap', experienceId: 'gaap', displayOrder: 1 },
        { id: 'statutory', code: 'STATUTORY_LINES', name: 'Statutory statement lines', slotId: 'financials', variantId: 'statutory', experienceId: 'statutory', displayOrder: 1 },
      ],
    };
    const helios = normalizeFacts(
      { attributes: { REPORTING_FRAMEWORK: 'GAAP', INDUSTRY: 'MANUFACTURING' } },
      'ISSUER_GAAP_FINANCIALS',
    );
    const resolved = resolveSurfaceComposition(catalog, helios.map);
    expect(resolved.pages.find((page) => page.slotCode === 'FINANCIALS')?.variantCode).toBe('GAAP_STATEMENTS');
    expect(byCode(resolved.components, 'GAAP_LINES').status).toBe('QUALIFIED');
    expect(byCode(resolved.components, 'STATUTORY_LINES').ruleTrace).toContain('Rule requires STATUTORY');
    expect(describeRules(rules('REPORTING_FRAMEWORK', 'GAAP'), false)).toBe('REPORTING_FRAMEWORK equals GAAP.');
  });

  it('breaks priority ties by variant code', () => {
    const catalog: SurfaceCatalogInput = {
      experiences: [
        { id: 'base', code: 'BASE', name: 'Baseline', isBaseline: true, priority: 1, displayOrder: 1, rules: {} },
      ],
      slots: [{ id: 'slot', code: 'SLOT', name: 'Slot', displayOrder: 1, optionality: 'always' }],
      variants: [
        { id: 'b', slotId: 'slot', code: 'BETA', name: 'Beta', priority: 10, requiredExperienceIds: [] },
        { id: 'a', slotId: 'slot', code: 'ALPHA', name: 'Alpha', priority: 10, requiredExperienceIds: [] },
      ],
      components: [],
    };
    const resolved = resolveSurfaceComposition(catalog, {});
    expect(resolved.pages[0].variantCode).toBe('ALPHA');
    expect(resolved.pages[0].decision).toContain('Beta at priority 10 is superseded');
  });
});
