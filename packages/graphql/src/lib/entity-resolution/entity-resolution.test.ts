import { describe, expect, it } from 'vitest';
import { walkEntityGraph, type GraphEdge } from './graph';
import { compareAttributes, findCandidates, scorePair, type MatchRule, type MatchableEntity } from './match';
import { jaroWinkler, levenshteinDistance, levenshteinSimilarity, similarity } from './similarity';

const legalRule: MatchRule = {
  ruleCode: 'LEGAL_ENTITY',
  ruleName: 'Legal entity across types',
  minScore: 72,
  isActive: true,
  clauses: [
    {
      clauseCode: 'EXACT_LEGAL_KEYS',
      attributeCodes: ['LEI', 'TAX_ID', 'EIN', 'CIK'],
      useEntityName: false,
      algorithm: 'exact',
      threshold: 1,
      weight: 60,
      deterministic: true,
      isActive: true,
    },
    {
      clauseCode: 'EXACT_INSTRUMENT_KEYS',
      attributeCodes: ['ISIN', 'CUSIP', 'SEDOL', 'TICKER', 'FUND_CODE'],
      useEntityName: false,
      algorithm: 'exact',
      threshold: 1,
      weight: 55,
      deterministic: true,
      isActive: true,
    },
    {
      clauseCode: 'NAME_JARO',
      attributeCodes: ['LEGAL_NAME'],
      useEntityName: true,
      algorithm: 'jaro_winkler',
      threshold: 0.88,
      weight: 30,
      deterministic: false,
      isActive: true,
    },
    {
      clauseCode: 'NAME_JACCARD',
      attributeCodes: ['LEGAL_NAME'],
      useEntityName: true,
      algorithm: 'jaccard',
      threshold: 0.55,
      weight: 20,
      deterministic: false,
      isActive: true,
    },
    {
      clauseCode: 'NAME_LEVENSHTEIN',
      attributeCodes: ['LEGAL_NAME'],
      useEntityName: true,
      algorithm: 'levenshtein',
      threshold: 0.82,
      weight: 15,
      deterministic: false,
      isActive: true,
    },
  ],
};

function entity(partial: Partial<MatchableEntity> & Pick<MatchableEntity, 'id' | 'entityName' | 'domainCode'>): MatchableEntity {
  return {
    entityCode: partial.entityCode || partial.id,
    clientId: partial.clientId ?? 'client-1',
    attributes: partial.attributes || {},
    ...partial,
  };
}

describe('similarity', () => {
  it('scores the standard Jaro-Winkler pairs', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 2);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.814, 2);
  });

  it('scores Levenshtein distance and a normalized similarity', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 5);
  });

  it('treats punctuation-insensitive identifiers as exact and ignores legal suffixes in names', () => {
    expect(similarity('exact', '5493-00 ABC', '549300ABC')).toBe(1);
    expect(similarity('exact', '12-3456789', '123456789')).toBe(1);
    expect(similarity('jaro_winkler', 'Northwind Capital Partners IV, L.P.', 'Northwind Capital Partners IV')).toBe(1);
    expect(similarity('jaccard', 'Northwind Capital Partners IV, L.P.', 'Northwind Capital Partners IV')).toBe(1);
  });

  it('does not fuzzy-match very short names', () => {
    expect(similarity('jaro_winkler', 'LP', 'LP')).toBe(0);
    expect(similarity('jaccard', 'Cat', 'Cat')).toBe(0);
  });
});

describe('match rules across entity types', () => {
  it('matches a shared LEI on an issuer and a fund even when the names differ', () => {
    const issuer = entity({
      id: 'issuer-1',
      entityName: 'Northwind Holdings',
      domainCode: 'ISSUER',
      attributes: { LEI: '549300ABC123' },
    });
    const fund = entity({
      id: 'fund-1',
      entityName: 'Northwind Capital Partners IV',
      domainCode: 'FUND',
      attributes: { LEI: '5493-00ABC123' },
    });
    const scored = scorePair(issuer, fund, legalRule);
    expect(scored).not.toBeNull();
    expect(scored?.crossDomain).toBe(true);
    expect(scored?.score).toBe(100);
    expect(scored?.reasons.some((reason) => reason.deterministic && reason.algorithm === 'exact')).toBe(true);
  });

  it('vetoes a pair when both sides have a tax id and the ids differ', () => {
    const left = entity({
      id: 'a',
      entityName: 'Acme Industries',
      domainCode: 'ISSUER',
      attributes: { TAX_ID: '12-3456789' },
    });
    const right = entity({
      id: 'b',
      entityName: 'Acme Industries',
      domainCode: 'ISSUER',
      attributes: { TAX_ID: '98-7654321' },
    });
    expect(scorePair(left, right, legalRule)).toBeNull();
  });

  it('does not veto when only one side has the exact key', () => {
    const left = entity({
      id: 'a',
      entityName: 'Blue River Energy',
      domainCode: 'ISSUER',
      attributes: { TAX_ID: '12-3456789' },
    });
    const right = entity({
      id: 'b',
      entityName: 'Blue River Energy LLC',
      domainCode: 'FUND',
      attributes: {},
    });
    const scored = scorePair(left, right, legalRule);
    expect(scored).not.toBeNull();
    expect(scored?.crossDomain).toBe(true);
    expect(scored?.reasons.every((reason) => !reason.deterministic)).toBe(true);
  });

  it('finds a name pair across types and keeps different clients apart', () => {
    const entities = [
      entity({ id: 'issuer', entityName: 'Northwind Capital Partners IV, L.P.', domainCode: 'ISSUER' }),
      entity({ id: 'fund', entityName: 'Northwind Capital Partners IV', domainCode: 'FUND' }),
      entity({ id: 'other-client', entityName: 'Northwind Capital Partners IV', domainCode: 'FUND', clientId: 'client-2', attributes: { LEI: 'SAMELEI0001' } }),
      entity({ id: 'unrelated', entityName: 'Harbor Point Credit', domainCode: 'DEAL' }),
    ];
    entities[0].attributes = { LEI: 'SAMELEI0001' };
    const result = findCandidates(entities, [legalRule], { limit: 20 });
    const pair = result.candidates.find((candidate) => candidate.leftId === 'fund' && candidate.rightId === 'issuer');
    expect(pair?.crossDomain).toBe(true);
    expect(result.candidates.some((candidate) => candidate.leftId === 'other-client' || candidate.rightId === 'other-client')).toBe(false);
    expect(result.candidates.some((candidate) => candidate.leftId === 'unrelated' || candidate.rightId === 'unrelated')).toBe(false);
  });

  it('compares one entity against every other type when a focus id is set', () => {
    const focus = entity({ id: 'focus', entityName: 'Widgets International', domainCode: 'ISSUER' });
    const swapped = entity({ id: 'swapped', entityName: 'International Widgets', domainCode: 'SECURITY' });
    const result = findCandidates([focus, swapped], [legalRule], { focusId: 'focus' });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].crossDomain).toBe(true);
    expect(result.scannedCount).toBe(2);
  });

  it('lays attribute conflicts out for a merge without dropping either side', () => {
    const survivor = entity({
      id: 's',
      entityName: 'Northwind',
      domainCode: 'ISSUER',
      attributes: { LEI: 'AAA', COUNTRY: 'US' },
    });
    const retired = entity({
      id: 'r',
      entityName: 'Northwind Holdings',
      domainCode: 'FUND',
      attributes: { LEI: 'AAA', TAX_ID: '12' },
    });
    const fields = compareAttributes(survivor, retired);
    expect(fields.find((field) => field.attributeCode === 'entity_name')?.status).toBe('conflict');
    expect(fields.find((field) => field.attributeCode === 'LEI')?.status).toBe('same');
    expect(fields.find((field) => field.attributeCode === 'COUNTRY')?.status).toBe('only_survivor');
    expect(fields.find((field) => field.attributeCode === 'TAX_ID')?.status).toBe('only_retired');
  });
});

describe('relationship graph', () => {
  const edges: GraphEdge[] = [
    { id: 'e1', parentEntityId: 'owner', childEntityId: 'holdco', relationshipCode: 'BENEFICIAL_OWNER', relationshipType: 'Beneficial owner of', metadata: { ownership_pct: 60 } },
    { id: 'e2', parentEntityId: 'holdco', childEntityId: 'opco', relationshipCode: 'BENEFICIAL_OWNER', relationshipType: 'Beneficial owner of', metadata: { ownership_pct: 100 } },
    { id: 'e3', parentEntityId: 'opco', childEntityId: 'owner', relationshipCode: 'BENEFICIAL_OWNER', relationshipType: 'Beneficial owner of' },
    { id: 'e4', parentEntityId: 'owner', childEntityId: 'facility', relationshipCode: 'ENTITY_FACILITY', relationshipType: 'Facility of entity' },
    { id: 'e5', parentEntityId: 'owner', childEntityId: 'bank', relationshipCode: 'COUNTERPARTY', relationshipType: 'Counterparty of' },
  ];

  it('walks parent, ownership, facility, and counterparty edges without folding them into the node', () => {
    const graph = walkEntityGraph('owner', edges, 2);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['bank', 'facility', 'holdco', 'opco', 'owner']);
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(graph.edges.find((edge) => edge.id === 'e1')?.metadata).toEqual({ ownership_pct: 60 });
    expect(graph.nodes.every((node) => !('ownership_pct' in node))).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'opco')?.direction).toBe('CROSS');
    expect(graph.nodes.find((node) => node.id === 'bank')?.direction).toBe('DOWN');
  });

  it('stops at the requested depth and does not loop on a cycle', () => {
    const shallow = walkEntityGraph('owner', edges, 1);
    expect(shallow.nodes.map((node) => node.id).sort()).toEqual(['bank', 'facility', 'holdco', 'opco', 'owner']);
    expect(shallow.edges.map((edge) => edge.id).sort()).toEqual(['e1', 'e3', 'e4', 'e5']);
    const deep = walkEntityGraph('opco', edges, 8);
    expect(deep.nodes.filter((node) => node.id === 'opco')).toHaveLength(1);
    expect(deep.nodes.length).toBeLessThanOrEqual(edges.length + 1);
  });

  it('can limit the walk to one relationship', () => {
    const graph = walkEntityGraph('owner', edges, 3, ['COUNTERPARTY']);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['bank', 'owner']);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].relationshipCode).toBe('COUNTERPARTY');
  });
});
