/**
 * Compact navigation catalog for the chat agent.
 * The store is already entities, attributes, and relationships. This shapes
 * that graph into the lookups, filters, groups, and identifier labels
 * query_data expects, including the direction the stored links actually use.
 */

export interface ModelAttributeRow {
  domain_code: string | null;
  attribute_code: string;
  attribute_name?: string | null;
  data_type?: string | null;
  reference_domain_code?: string | null;
  aggregation_type?: string | null;
  weight_attribute_code?: string | null;
}

export interface ModelRelationshipRow {
  relationship_code: string;
  relationship_name?: string | null;
  parent_domain_code?: string | null;
  child_domain_code?: string | null;
  cardinality?: string | null;
  composite_key?: string[] | null;
}

export interface ModelIdentifierRow {
  domain_code: string;
  identifier_code: string;
  identifier_name?: string | null;
  attribute_codes?: string[] | null;
  is_primary?: boolean | null;
  description?: string | null;
}

export interface ModelLinkCount {
  relationship_code: string;
  parent_domain_code?: string | null;
  child_domain_code?: string | null;
  link_count?: number | string | null;
}

export interface ShapeModelMapInput {
  focus?: string | null;
  /** Far entity type the question needs, such as INVESTOR when the start is DEAL. */
  toDomain?: string | null;
  attributes: ModelAttributeRow[];
  relationships: ModelRelationshipRow[];
  identifiers: ModelIdentifierRow[];
  linkCounts?: ModelLinkCount[];
}

export interface ModelLookup {
  alias: string;
  direction: 'UP' | 'DOWN';
  relationshipCode: string;
  domainCode: string;
  from?: string;
}

const QUERY_WITH = 'Entity grain on query_data. Copy a path\'s lookups onto the query. filters, groupBy, orderBy, select, and metrics accept an attribute of the entity you are querying, or "<alias>.<ATTRIBUTE>" and "<alias>.entity_name" from a lookup. WEIGHTED_AVG needs field and weightField. A group\'s weight in a total is its sum divided by the sum of that metric; return the sums and compute each share in the answer. Label every row with the identifier in readAs.';

const DOMAIN_ALIAS: Record<string, string> = {
  FUND: 'fund',
  SECURITY: 'sec',
  ISSUER: 'iss',
  POSITION: 'pos',
  DEAL: 'deal',
  DEAL_TRANCHE: 'tranche',
  DEAL_FUNDING_PLAN: 'funding',
  CASH_FLOW: 'cf',
  SPONSOR: 'sponsor',
};

function code(value: string | null | undefined): string {
  return (value || '').trim().toUpperCase();
}

function domainAlias(domain: string): string {
  return DOMAIN_ALIAS[domain] || domain.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'rel';
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

interface ResolvedRel {
  code: string;
  name: string | null;
  parentDomain: string;
  childDomain: string;
  cardinality: string | null;
  compositeKey: string[];
  note?: string;
  hops: Array<{
    fromDomain: string;
    direction: 'UP' | 'DOWN';
    toDomain: string;
    toOne: boolean;
  }>;
}

function toOne(cardinality: string | null, direction: 'UP' | 'DOWN'): boolean {
  const kind = code(cardinality);
  if (kind === 'ONE_TO_ONE' || kind === '') return true;
  if (direction === 'UP') return kind === 'ONE_TO_MANY';
  return kind === 'MANY_TO_ONE';
}

function resolveRelationship(rel: ModelRelationshipRow, counts: ModelLinkCount[]): ResolvedRel | null {
  const declaredParent = code(rel.parent_domain_code);
  const declaredChild = code(rel.child_domain_code);
  if (!declaredParent || !declaredChild) return null;

  const rows = counts
    .filter((row) => code(row.relationship_code) === code(rel.relationship_code))
    .map((row) => ({
      parent: code(row.parent_domain_code),
      child: code(row.child_domain_code),
      n: Number(row.link_count) || 0,
    }))
    .filter((row) => row.parent && row.child && row.n > 0)
    .sort((a, b) => b.n - a.n);

  const dominant = rows[0];
  const parent = dominant?.parent || declaredParent;
  const child = dominant?.child || declaredChild;
  const reversed = !!dominant && (parent !== declaredParent || child !== declaredChild);
  const cardinality = rel.cardinality || null;

  const hops: ResolvedRel['hops'] = [
    { fromDomain: child, direction: 'UP', toDomain: parent, toOne: toOne(cardinality, 'UP') },
    { fromDomain: parent, direction: 'DOWN', toDomain: child, toOne: toOne(cardinality, 'DOWN') },
  ];

  return {
    code: rel.relationship_code,
    name: rel.relationship_name || null,
    parentDomain: parent,
    childDomain: child,
    cardinality,
    compositeKey: Array.isArray(rel.composite_key) ? rel.composite_key.filter(Boolean) : [],
    note: reversed
      ? `Stored links put ${parent} on the parent side and ${child} on the child side. The declared direction is ${declaredParent} → ${declaredChild}. Use these hops, which follow the stored links.`
      : undefined,
    hops,
  };
}

function hopScore(rel: ResolvedRel, fromDomain: string, toDomain: string): number {
  const relCode = code(rel.code);
  let score = 0;
  if (relCode === `${fromDomain}_${toDomain}`) score += 5;
  if (relCode === `${toDomain}_${fromDomain}`) score += 4;
  if (relCode.includes(fromDomain) && relCode.includes(toDomain)) score += 2;
  const hop = rel.hops.find((item) => item.fromDomain === fromDomain && item.toDomain === toDomain);
  if (hop?.toOne) score += 1;
  return score;
}

function bestHop(rels: ResolvedRel[], fromDomain: string, toDomain: string): { rel: ResolvedRel; hop: ResolvedRel['hops'][number] } | null {
  const matches = rels.flatMap((rel) => rel.hops
    .filter((hop) => hop.fromDomain === fromDomain && hop.toDomain === toDomain)
    .map((hop) => ({ rel, hop })));
  matches.sort((a, b) => hopScore(b.rel, fromDomain, toDomain) - hopScore(a.rel, fromDomain, toDomain));
  return matches[0] || null;
}

function nextHops(rels: ResolvedRel[], fromDomain: string): Array<{ rel: ResolvedRel; hop: ResolvedRel['hops'][number] }> {
  const best = new Map<string, { rel: ResolvedRel; hop: ResolvedRel['hops'][number] }>();
  for (const rel of rels) {
    for (const hop of rel.hops) {
      if (hop.fromDomain !== fromDomain) continue;
      const key = `${hop.direction}:${hop.toDomain}:${rel.code}`;
      const domainKey = hop.toDomain === fromDomain ? key : `${hop.direction}:${hop.toDomain}`;
      const prev = best.get(domainKey);
      if (!prev || hopScore(rel, fromDomain, hop.toDomain) > hopScore(prev.rel, fromDomain, hop.toDomain)) {
        best.set(domainKey, { rel, hop });
      }
    }
  }
  return [...best.values()];
}

function stepAlias(toDomain: string, direction: 'UP' | 'DOWN', self: boolean, used: string[]): string {
  const base = domainAlias(toDomain);
  if (!self && !used.includes(base)) return base;
  const prefixed = direction === 'UP' ? `parent${cap(base)}` : `sub${cap(base)}`;
  return used.includes(prefixed) ? `${prefixed}2` : prefixed;
}

function lookupStep(
  rel: ResolvedRel,
  hop: ResolvedRel['hops'][number],
  prior: ModelLookup[]
): ModelLookup {
  const self = hop.toDomain === hop.fromDomain;
  return {
    alias: stepAlias(hop.toDomain, hop.direction, self, prior.map((item) => item.alias)),
    direction: hop.direction,
    relationshipCode: rel.code,
    domainCode: hop.toDomain,
    ...(prior.length ? { from: prior[prior.length - 1].alias } : {}),
  };
}

/**
 * Shortest simple path from the focus to every reachable type.
 * A repeating edge (a fund and its parent funds) is one extra step, not a walk
 * that continues forever. There is no fixed hop limit other than the size of the graph.
 */
function buildPaths(focus: string, rels: ResolvedRel[]): Array<{ label: string; steps: number; lookups: ModelLookup[] }> {
  const maxSteps = new Set(rels.flatMap((rel) => [rel.parentDomain, rel.childDomain])).size;
  type Node = { domain: string; lookups: ModelLookup[]; seen: Set<string> };
  const queue: Node[] = [{ domain: focus, lookups: [], seen: new Set([focus]) }];
  const best = new Map<string, ModelLookup[][]>();
  const paths: Array<{ label: string; steps: number; lookups: ModelLookup[] }> = [];

  const remember = (target: string, lookups: ModelLookup[]) => {
    const known = best.get(target) || [];
    const signature = lookups.map((item) => item.relationshipCode).join('|');
    if (known.some((path) => path.map((item) => item.relationshipCode).join('|') === signature)) return;
    if (known.length && lookups.length > known[0].length) return;
    const kept = known.length && lookups.length === known[0].length ? known : [];
    if (kept.length >= 2) return;
    best.set(target, [...kept, lookups]);
    paths.push({
      label: [focus, ...lookups.map((item) => item.domainCode)].join(' → '),
      steps: lookups.length,
      lookups,
    });
  };

  while (queue.length) {
    const current = queue.shift()!;
    if (current.lookups.length >= maxSteps) continue;
    for (const { rel, hop } of nextHops(rels, current.domain)) {
      const self = hop.toDomain === current.domain;
      const step = lookupStep(rel, hop, current.lookups);
      const next = [...current.lookups, step];
      if (self) {
        if (current.lookups.some((item) => item.relationshipCode === rel.code)) continue;
        remember(`${current.domain}:${rel.code}`, next);
        continue;
      }
      if (current.seen.has(hop.toDomain)) continue;
      const known = best.get(hop.toDomain);
      if (known && next.length > known[0].length) continue;
      const isNew = !known || next.length < known[0].length;
      remember(hop.toDomain, next);
      if (isNew || next.length === known![0].length) {
        queue.push({ domain: hop.toDomain, lookups: next, seen: new Set([...current.seen, hop.toDomain]) });
      }
    }
  }

  return paths.sort((a, b) => a.steps - b.steps || a.label.localeCompare(b.label));
}

function reachableDomains(focus: string, rels: ResolvedRel[]): Set<string> {
  const domains = new Set<string>([focus]);
  const queue = [focus];
  while (queue.length) {
    const domain = queue.shift()!;
    for (const { hop } of nextHops(rels, domain)) {
      if (hop.toDomain === domain || domains.has(hop.toDomain)) continue;
      domains.add(hop.toDomain);
      queue.push(hop.toDomain);
    }
  }
  return domains;
}

function attributeIndex(attributes: ModelAttributeRow[]): Map<string, ModelAttributeRow> {
  const index = new Map<string, ModelAttributeRow>();
  for (const attribute of attributes) {
    if (!attribute.domain_code || !attribute.attribute_code) continue;
    index.set(`${code(attribute.domain_code)}:${code(attribute.attribute_code)}`, attribute);
  }
  return index;
}

function readAs(
  domain: string,
  identifiers: ModelIdentifierRow[],
  attributes: Map<string, ModelAttributeRow>,
  rels: ResolvedRel[]
): string {
  const own = identifiers.filter((item) => code(item.domain_code) === domain);
  const primary = own.filter((item) => item.is_primary);
  const pool = primary.length ? primary : own;
  const identifier = [...pool].sort((a, b) => (b.attribute_codes?.length || 0) - (a.attribute_codes?.length || 0))[0];
  if (!identifier) return `Read a ${domain} by entity_name.`;

  const parts = identifier.attribute_codes || [];
  const sentences = [
    `A ${domain} is identified by ${identifier.identifier_name || identifier.identifier_code} (${parts.join(', ')}).`,
  ];
  const shown: string[] = [];
  for (const part of parts) {
    const attribute = attributes.get(`${domain}:${code(part)}`);
    const reference = code(attribute?.reference_domain_code);
    if (reference) {
      const match = bestHop(rels, domain, reference);
      if (match) {
        const alias = domainAlias(reference);
        sentences.push(
          `Read ${part} through ${match.rel.code} (direction ${match.hop.direction}) as ${alias}.entity_name. The reference attribute is often empty; the relationship is the identifier.`
        );
        shown.push(`${alias}.entity_name`);
      } else {
        sentences.push(`${part} references ${reference}. No relationship to ${reference} is in this map, so select ${part} itself.`);
        shown.push(part);
      }
    } else {
      sentences.push(`Read ${part} on the ${domain}.`);
      shown.push(part);
    }
  }
  if (parts.length > 1) {
    sentences.push(`When you list or group ${domain} records, include ${shown.join(' and ')} so the reader sees the whole identifier, not the record code alone.`);
  }
  return sentences.join(' ');
}

function slimAttributes(domain: string, attributes: ModelAttributeRow[]) {
  return attributes
    .filter((attribute) => code(attribute.domain_code) === domain)
    .map((attribute) => {
      const aggregation = code(attribute.aggregation_type);
      return {
        code: attribute.attribute_code,
        dataType: attribute.data_type || null,
        ...(attribute.reference_domain_code ? { referenceDomain: code(attribute.reference_domain_code) } : {}),
        ...(aggregation && aggregation !== 'NONE' ? { aggregation } : {}),
        ...(attribute.weight_attribute_code ? { weight: attribute.weight_attribute_code } : {}),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function shapeModelMap(input: ShapeModelMapInput) {
  const focus = code(input.focus);
  const toDomain = code(input.toDomain);
  const counts = input.linkCounts || [];
  const resolved = input.relationships
    .map((rel) => resolveRelationship(rel, counts))
    .filter((rel): rel is ResolvedRel => !!rel);
  const scope = focus ? reachableDomains(focus, resolved) : null;
  const rels = scope
    ? resolved.filter((rel) => scope.has(rel.parentDomain) && scope.has(rel.childDomain))
    : resolved;

  const identifiers = input.identifiers.filter((item) => !scope || scope.has(code(item.domain_code)));
  const attributes = input.attributes.filter((item) => !scope || scope.has(code(item.domain_code)));
  const byAttribute = attributeIndex(attributes);

  const relationships = rels.map((rel) => ({
    code: rel.code,
    name: rel.name,
    parentDomain: rel.parentDomain,
    childDomain: rel.childDomain,
    cardinality: rel.cardinality,
    ...(rel.parentDomain === rel.childDomain ? { repeats: true } : {}),
    ...(rel.compositeKey.length ? { compositeKey: rel.compositeKey } : {}),
    ...(rel.note ? { note: rel.note } : {}),
    hops: rel.hops.map((hop) => ({
      fromDomain: hop.fromDomain,
      direction: hop.direction,
      toDomain: hop.toDomain,
      toOne: hop.toOne,
      lookup: {
        alias: hop.toDomain === hop.fromDomain
          ? (hop.direction === 'UP' ? `parent${cap(domainAlias(hop.toDomain))}` : `sub${cap(domainAlias(hop.toDomain))}`)
          : domainAlias(hop.toDomain),
        direction: hop.direction,
        relationshipCode: rel.code,
        domainCode: hop.toDomain,
      },
    })),
  }));

  if (!focus) {
    return {
      focus: null,
      note: 'Pass domainCode for the type you start from. Pass toDomain for the type the question needs to reach, however many relationships away it is.',
      queryWith: QUERY_WITH,
      relationships,
      identifiers: identifiers.map((item) => ({
        domainCode: code(item.domain_code),
        code: item.identifier_code,
        name: item.identifier_name || item.identifier_code,
        primary: !!item.is_primary,
        attributeCodes: item.attribute_codes || [],
      })),
    };
  }

  const domains = [...(scope || new Set([focus]))].sort((a, b) => (a === focus ? -1 : b === focus ? 1 : a.localeCompare(b)));
  const paths = buildPaths(focus, rels);
  const toward = toDomain
    ? paths.filter((path) => path.lookups[path.lookups.length - 1]?.domainCode === toDomain)
    : [];
  const shortest = toward.reduce((best, path) => Math.min(best, path.steps), Number.POSITIVE_INFINITY);
  const selected = toward.filter((path) => path.steps === shortest);
  return {
    focus,
    ...(toDomain ? {
      toDomain,
      path: selected[0] || null,
      ...(selected.length ? {} : {
        pathNote: `${toDomain} is not reachable from ${focus}. Reachable types: ${domains.filter((domain) => domain !== focus).join(', ') || 'none'}.`,
      }),
    } : {}),
    readAs: readAs(focus, identifiers, byAttribute, rels),
    queryWith: QUERY_WITH,
    paths,
    relationships,
    domains: domains.map((domain) => ({
      domainCode: domain,
      readAs: readAs(domain, identifiers, byAttribute, rels),
      identifiers: identifiers
        .filter((item) => code(item.domain_code) === domain)
        .map((item) => ({
          code: item.identifier_code,
          name: item.identifier_name || item.identifier_code,
          primary: !!item.is_primary,
          attributeCodes: item.attribute_codes || [],
        })),
      attributes: slimAttributes(domain, attributes),
    })),
  };
}
