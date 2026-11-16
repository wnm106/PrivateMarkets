export const AGGREGATE_FUNCTIONS = [
  { code: 'SUM', name: 'Sum' },
  { code: 'MIN', name: 'Minimum' },
  { code: 'MAX', name: 'Maximum' },
  { code: 'WAVG', name: 'Weighted average' },
] as const;

export type AggregateFn = (typeof AGGREGATE_FUNCTIONS)[number]['code'];

export const AGGREGATE_NUMERIC_TYPES = ['NUMBER', 'INTEGER', 'DECIMAL', 'FLOAT', 'CURRENCY', 'PERCENTAGE', 'PERCENT'];

export interface AggregateAttribute {
  attributeCode: string;
  domainCode: string | null;
  dataType: string;
}

export interface AggregateRelationship {
  relationshipCode: string;
  parentDomainCode: string | null;
  childDomainCode: string | null;
}

export interface AggregateBinding {
  attributeCode: string;
  traversal: 'SELF' | 'UP' | 'DOWN';
  relationshipCodes: string[];
}

export interface AggregateRequest {
  aggregateFn: AggregateFn;
  measure: AggregateBinding;
  weightAttributeCode: string | null;
}

export interface AggregatePlan extends AggregateRequest {
  weight: AggregateBinding | null;
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseAggregateRequest(raw: {
  aggregateFn: unknown;
  measure: unknown;
  weightAttributeCode?: unknown;
}): AggregateRequest {
  const aggregateFn = String(raw.aggregateFn || '').trim().toUpperCase();
  if (!AGGREGATE_FUNCTIONS.some((item) => item.code === aggregateFn)) {
    fail('Choose Sum, Minimum, Maximum, or Weighted average');
  }
  const measure = parseBinding(raw.measure);
  const weightAttributeCode = String(raw.weightAttributeCode || '').trim();
  if (aggregateFn === 'WAVG' && !weightAttributeCode) fail('Weighted average needs a weight field');
  return {
    aggregateFn: aggregateFn as AggregateFn,
    measure,
    weightAttributeCode: aggregateFn === 'WAVG' ? weightAttributeCode : null,
  };
}

export function planAggregateUpdate(
  raw: {
    aggregateFn: unknown;
    measure: unknown;
    weightAttributeCode?: unknown;
  },
  catalog: {
    ownAttributeCode: string;
    ownDomainCode: string;
    attributes: AggregateAttribute[];
    relationships: AggregateRelationship[];
  },
): AggregatePlan {
  const request = parseAggregateRequest(raw);
  const place = landedDomain(catalog.ownDomainCode, request.measure, catalog.relationships);
  requireAttribute(request.measure.attributeCode, catalog, place, request.measure.traversal);
  const weight = request.weightAttributeCode
    ? {
      attributeCode: request.weightAttributeCode,
      traversal: request.measure.traversal,
      relationshipCodes: request.measure.relationshipCodes,
    }
    : null;
  if (weight) requireAttribute(weight.attributeCode, catalog, place, weight.traversal);
  return { ...request, weight };
}

function parseBinding(raw: unknown): AggregateBinding {
  if (!raw || typeof raw !== 'object') fail('Choose the field this total reads');
  const record = raw as { attributeCode?: unknown; traversal?: unknown; relationshipCodes?: unknown };
  const attributeCode = String(record.attributeCode || '').trim();
  const traversal = String(record.traversal || '').trim().toUpperCase();
  if (!attributeCode) fail('Choose the field this total reads');
  if (traversal !== 'SELF' && traversal !== 'UP' && traversal !== 'DOWN') {
    fail('Choose where this field is read from');
  }
  const relationshipCodes = Array.isArray(record.relationshipCodes)
    ? record.relationshipCodes.map((code) => String(code || '').trim()).filter(Boolean)
    : [];
  if (traversal === 'SELF' && relationshipCodes.length > 0) {
    fail('A field on this record has no relationship path');
  }
  if (traversal !== 'SELF' && relationshipCodes.length === 0) {
    fail('Choose the records this total is read from');
  }
  return { attributeCode, traversal, relationshipCodes };
}

function landedDomain(rootDomain: string, binding: AggregateBinding, relationships: AggregateRelationship[]): string {
  if (binding.traversal === 'SELF') return rootDomain;
  let domain = rootDomain;
  for (const code of binding.relationshipCodes) {
    const relationship = relationships.find((item) => item.relationshipCode === code);
    if (!relationship) fail(`Relationship ${code} does not exist`);
    const next = binding.traversal === 'DOWN'
      ? (relationship.parentDomainCode === domain ? relationship.childDomainCode : null)
      : (relationship.childDomainCode === domain ? relationship.parentDomainCode : null);
    if (!next) fail(`Relationship ${code} does not connect from ${domain}`);
    domain = next;
  }
  return domain;
}

function requireAttribute(
  attributeCode: string,
  catalog: { ownAttributeCode: string; attributes: AggregateAttribute[] },
  place: string,
  traversal: AggregateBinding['traversal'],
) {
  if (attributeCode === catalog.ownAttributeCode) fail('A calculation cannot read itself');
  const attribute = catalog.attributes.find((item) => item.attributeCode === attributeCode);
  if (!attribute) fail(`Attribute ${attributeCode} does not exist`);
  if (!AGGREGATE_NUMERIC_TYPES.includes(attribute.dataType)) {
    fail(`${attributeCode} is ${attribute.dataType}. Choose a numeric field.`);
  }
  if (!attribute.domainCode) {
    if (traversal !== 'SELF') fail(`${attributeCode} can only be read on this record`);
    return;
  }
  if (attribute.domainCode !== place) {
    fail(`${attributeCode} is on ${attribute.domainCode}. This path reads ${place}.`);
  }
}
