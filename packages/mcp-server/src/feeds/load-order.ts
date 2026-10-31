import type { FeedDomainSpec } from './types';

export interface RelationshipTypeRow {
  relationship_code: string;
  parent_domain_code: string;
  child_domain_code: string;
  is_required: boolean | null;
}

/** Parent domains this map loads itself. A parent marked existing is resolved from stored entities. */
export function loadDependencies(domain: FeedDomainSpec, known: Set<string>): string[] {
  const parents: string[] = [];
  for (const parent of domain.parents) {
    if (!known.has(parent.parentDomainCode)) {
      if (parent.existing) continue;
      throw new Error(
        `${domain.domainCode} depends on ${parent.parentDomainCode}, which is not in this source map`
      );
    }
    if (!parents.includes(parent.parentDomainCode)) parents.push(parent.parentDomainCode);
  }
  return parents;
}

/**
 * Topological order of domains from the map's parent-key edges.
 * A domain is loaded only after every domain it references.
 * Relationship catalog direction is intentionally ignored: POSITION_FUND
 * lists POSITION as the parent, which would load positions first.
 */
export function dependencyLoadOrder(domains: FeedDomainSpec[]): string[] {
  const codes = domains.map((domain) => domain.domainCode);
  const known = new Set(codes);
  const indegree = new Map(codes.map((code) => [code, 0]));
  const childrenOf = new Map<string, string[]>();

  for (const domain of domains) {
    for (const parentCode of loadDependencies(domain, known)) {
      indegree.set(domain.domainCode, (indegree.get(domain.domainCode) || 0) + 1);
      const children = childrenOf.get(parentCode) || [];
      children.push(domain.domainCode);
      childrenOf.set(parentCode, children);
    }
  }

  const queue = codes.filter((code) => indegree.get(code) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    for (const child of childrenOf.get(current) || []) {
      const next = (indegree.get(child) || 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (order.length !== codes.length) {
    throw new Error('The source map has a cycle in its parent dependencies');
  }
  return order;
}

/** Domains that can load together, earliest parents first. */
export function dependencyLoadWaves(domains: FeedDomainSpec[]): string[][] {
  const byCode = new Map(domains.map((domain) => [domain.domainCode, domain]));
  const known = new Set(byCode.keys());
  const depthOf = new Map<string, number>();

  const depth = (code: string, stack: string[]): number => {
    const cached = depthOf.get(code);
    if (cached !== undefined) return cached;
    if (stack.includes(code)) {
      throw new Error('The source map has a cycle in its parent dependencies');
    }
    const domain = byCode.get(code);
    if (!domain) throw new Error(`Unknown domain ${code}`);
    const parents = loadDependencies(domain, known);
    const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((parent) => depth(parent, [...stack, code])));
    depthOf.set(code, value);
    return value;
  };

  for (const domain of domains) depth(domain.domainCode, []);
  const waves: string[][] = [];
  for (const domain of domains) {
    const level = depthOf.get(domain.domainCode) || 0;
    waves[level] = waves[level] || [];
    waves[level].push(domain.domainCode);
  }
  return waves.filter((wave) => wave.length > 0);
}

/**
 * Pick the catalog relationship that connects a loaded domain to a referenced
 * domain, preferring the row whose parent domain is the referenced one.
 * Endpoint ids still follow the catalog's parent and child domains.
 */
export function chooseRelationship(
  loadedDomain: string,
  referencedDomain: string,
  types: RelationshipTypeRow[]
): RelationshipTypeRow | null {
  const connecting = types.filter(
    (type) =>
      (type.parent_domain_code === loadedDomain && type.child_domain_code === referencedDomain) ||
      (type.parent_domain_code === referencedDomain && type.child_domain_code === loadedDomain)
  );
  return (
    connecting.find(
      (type) => type.parent_domain_code === referencedDomain && type.child_domain_code === loadedDomain
    ) ||
    connecting.find((type) => type.is_required) ||
    connecting[0] ||
    null
  );
}

export function relationshipEndpoints(
  type: RelationshipTypeRow,
  loadedDomain: string,
  loadedId: string,
  referencedDomain: string,
  referencedId: string
): { parentEntityId: string; childEntityId: string } {
  if (type.parent_domain_code === loadedDomain && type.child_domain_code === referencedDomain) {
    return { parentEntityId: loadedId, childEntityId: referencedId };
  }
  if (type.parent_domain_code === referencedDomain && type.child_domain_code === loadedDomain) {
    return { parentEntityId: referencedId, childEntityId: loadedId };
  }
  throw new Error(
    `Relationship ${type.relationship_code} does not connect ${loadedDomain} and ${referencedDomain}`
  );
}
