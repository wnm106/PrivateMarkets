import { describe, expect, it } from 'vitest';
import { shapeModelMap, type ModelAttributeRow, type ModelIdentifierRow, type ModelRelationshipRow } from './model-map';

const relationships: ModelRelationshipRow[] = [
  { relationship_code: 'POSITION_FUND', relationship_name: 'Position to Fund', parent_domain_code: 'FUND', child_domain_code: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationship_code: 'POSITION_SECURITY', relationship_name: 'Position to Security', parent_domain_code: 'SECURITY', child_domain_code: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationship_code: 'SECURITY_POSITION', relationship_name: 'Security Positions', parent_domain_code: 'SECURITY', child_domain_code: 'POSITION', cardinality: 'ONE_TO_MANY' },
  { relationship_code: 'SECURITY_ISSUER', relationship_name: 'Security issued by', parent_domain_code: 'SECURITY', child_domain_code: 'ISSUER', cardinality: 'ONE_TO_ONE' },
  { relationship_code: 'FUND_PARENT', relationship_name: 'Fund to Parent Fund', parent_domain_code: 'FUND', child_domain_code: 'FUND', cardinality: 'MANY_TO_ONE' },
  { relationship_code: 'DEAL_SPONSOR', relationship_name: 'Deal sponsor', parent_domain_code: 'DEAL', child_domain_code: 'SPONSOR', cardinality: 'MANY_TO_ONE' },
];

const attributes: ModelAttributeRow[] = [
  { domain_code: 'POSITION', attribute_code: 'PORTFOLIO_FUND_ID', attribute_name: 'Portfolio / Fund Structure ID', data_type: 'REFERENCE', reference_domain_code: 'FUND' },
  { domain_code: 'POSITION', attribute_code: 'SECURITY_ID', attribute_name: 'Security ID', data_type: 'REFERENCE', reference_domain_code: 'SECURITY' },
  { domain_code: 'POSITION', attribute_code: 'TRADE_DATE', attribute_name: 'Trade Date', data_type: 'DATE' },
  { domain_code: 'POSITION', attribute_code: 'MARKET_VALUE', attribute_name: 'Market Value', data_type: 'DECIMAL', aggregation_type: 'SUM' },
  { domain_code: 'POSITION', attribute_code: 'YIELD', attribute_name: 'Yield', data_type: 'DECIMAL', aggregation_type: 'WEIGHTED_AVG', weight_attribute_code: 'MARKET_VALUE' },
  { domain_code: 'ISSUER', attribute_code: 'INDUSTRY', attribute_name: 'Industry', data_type: 'STRING', aggregation_type: 'NONE' },
  { domain_code: 'DEAL', attribute_code: 'DEAL_NAME', attribute_name: 'Deal Name', data_type: 'STRING' },
];

const identifiers: ModelIdentifierRow[] = [
  { domain_code: 'POSITION', identifier_code: 'POSITION_COMPOSITE', identifier_name: 'Fund + Security + Trade Date', attribute_codes: ['PORTFOLIO_FUND_ID', 'SECURITY_ID', 'TRADE_DATE'], is_primary: true },
  { domain_code: 'SECURITY', identifier_code: 'ISIN', identifier_name: 'ISIN', attribute_codes: ['ISIN'], is_primary: true },
];

describe('shapeModelMap', () => {
  const map = shapeModelMap({
    focus: 'POSITION',
    attributes,
    relationships,
    identifiers,
    linkCounts: [
      { relationship_code: 'POSITION_FUND', parent_domain_code: 'FUND', child_domain_code: 'POSITION', link_count: 100 },
      { relationship_code: 'SECURITY_ISSUER', parent_domain_code: 'ISSUER', child_domain_code: 'SECURITY', link_count: 300 },
      { relationship_code: 'SECURITY_ISSUER', parent_domain_code: 'SECURITY', child_domain_code: 'ISSUER', link_count: 20 },
    ],
  }) as any;

  it('reads a position back as its fund, security, and trade date', () => {
    expect(map.readAs).toContain('Fund + Security + Trade Date');
    expect(map.readAs).toContain('fund.entity_name');
    expect(map.readAs).toContain('sec.entity_name');
    expect(map.readAs).toContain('TRADE_DATE');
    expect(map.readAs).toContain('POSITION_FUND');
    expect(map.readAs).toContain('POSITION_SECURITY');
  });

  it('chains position to security to issuer using the stored direction', () => {
    const industry = map.paths.find((path: any) => path.label === 'POSITION → SECURITY → ISSUER');
    expect(industry.lookups).toEqual([
      { alias: 'sec', direction: 'UP', relationshipCode: 'POSITION_SECURITY', domainCode: 'SECURITY' },
      { alias: 'iss', direction: 'UP', relationshipCode: 'SECURITY_ISSUER', domainCode: 'ISSUER', from: 'sec' },
    ]);
    const issuerRel = map.relationships.find((rel: any) => rel.code === 'SECURITY_ISSUER');
    expect(issuerRel.parentDomain).toBe('ISSUER');
    expect(issuerRel.note).toContain('Stored links');
  });

  it('prefers the position-to-security relationship over the duplicate', () => {
    const direct = map.paths.filter((path: any) => path.label === 'POSITION → SECURITY');
    expect(direct).toHaveLength(1);
    expect(direct[0].lookups[0].relationshipCode).toBe('POSITION_SECURITY');
  });

  it('keeps weighting metadata and drops unrelated branches', () => {
    const position = map.domains.find((domain: any) => domain.domainCode === 'POSITION');
    expect(position.attributes.find((attribute: any) => attribute.code === 'YIELD').weight).toBe('MARKET_VALUE');
    expect(position.attributes.find((attribute: any) => attribute.code === 'MARKET_VALUE').aggregation).toBe('SUM');
    expect(map.domains.some((domain: any) => domain.domainCode === 'ISSUER')).toBe(true);
    expect(map.domains.some((domain: any) => domain.domainCode === 'DEAL')).toBe(false);
    expect(map.relationships.some((rel: any) => rel.code === 'DEAL_SPONSOR')).toBe(false);
  });

  it('follows a deal out through positions and funds to investors', () => {
    const chain = shapeModelMap({
      focus: 'DEAL',
      toDomain: 'INVESTOR',
      attributes,
      relationships: [
        ...relationships,
        { relationship_code: 'DEAL_SECURITY', relationship_name: 'Deal securities', parent_domain_code: 'DEAL', child_domain_code: 'SECURITY', cardinality: 'ONE_TO_MANY' },
        { relationship_code: 'FUND_INVESTOR', relationship_name: 'Fund investors', parent_domain_code: 'INVESTOR', child_domain_code: 'FUND', cardinality: 'ONE_TO_MANY' },
      ],
      identifiers,
    }) as any;

    expect(chain.path.lookups.map((step: any) => step.domainCode)).toEqual(['SECURITY', 'POSITION', 'FUND', 'INVESTOR']);
    expect(chain.path.lookups.map((step: any) => step.direction)).toEqual(['DOWN', 'DOWN', 'UP', 'UP']);
    expect(chain.path.lookups[0].relationshipCode).toBe('DEAL_SECURITY');
    expect(chain.path.lookups[2].relationshipCode).toBe('POSITION_FUND');
    expect(chain.path.lookups[3].relationshipCode).toBe('FUND_INVESTOR');
    expect(chain.path.lookups[1].from).toBe(chain.path.lookups[0].alias);
    expect(chain.path.lookups[3].from).toBe(chain.path.lookups[2].alias);
    expect(chain.path.steps).toBe(4);
  });

  it('asks for a domain before dumping attributes', () => {
    const index = shapeModelMap({ focus: null, attributes, relationships, identifiers }) as any;
    expect(index.focus).toBeNull();
    expect(index.note).toContain('domainCode');
    expect(index.domains).toBeUndefined();
    expect(index.relationships.some((rel: any) => rel.code === 'DEAL_SPONSOR')).toBe(true);
  });
});
