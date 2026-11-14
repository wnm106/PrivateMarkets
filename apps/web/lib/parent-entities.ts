export interface ParentEntityColumn {
  alias: string;
  label: string;
  direction: 'UP' | 'DOWN';
  relationshipCode: string;
  domainCode: string;
  field: string;
  header: string;
}

export interface ParentRelationshipType {
  relationshipCode: string;
  parentDomainCode?: string | null;
  childDomainCode?: string | null;
  cardinality?: string | null;
}

export interface ParentLinkCount {
  relationshipCode: string;
  parentDomainCode: string;
  childDomainCode: string;
  linkCount: number;
  /** Most children stored on one parent. Null when the count is unknown. */
  maxPerParent?: number | null;
  /** Most parents stored on one child. Null when the count is unknown. */
  maxPerChild?: number | null;
}

/**
 * Related columns for an entity list. A position lists its fund and its security.
 * A column is included only when this entity has one record of that type.
 * An issuer does not list its deals or its securities, because it can have many of each.
 */
/**
 * Member domains of an intersection, such as a position's fund and security.
 * Empty when this entity type is not itself an intersection.
 */
export function definingParentDomains(
  domainCode: string,
  intersections: Array<{
    intersectionCode?: string | null;
    isActive?: boolean | null;
    members?: Array<{ domainCode?: string | null }> | null;
  }>,
): string[] {
  const domain = domainCode.trim().toUpperCase();
  if (!domain) return [];
  const match = intersections.find((item) => item.isActive !== false && (item.intersectionCode || '').trim().toUpperCase() === domain);
  if (!match) return [];
  return [...new Set(
    (match.members || [])
      .map((member) => (member.domainCode || '').trim().toUpperCase())
      .filter((code) => code && code !== domain),
  )];
}

export function parentEntityColumns(
  domainCode: string,
  relationships: ParentRelationshipType[],
  names: Record<string, string> = {},
  linkCounts: ParentLinkCount[] = [],
  onlyDomains: string[] = [],
): ParentEntityColumn[] {
  const domain = domainCode.trim().toUpperCase();
  if (!domain) return [];

  const candidates = relationships
    .map((relationship) => parentHop(domain, relationship, linkCounts))
    .filter((row): row is ParentHop => !!row)
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const aOwn = a.relationshipCode.toUpperCase().startsWith(`${domain}_`) ? 0 : 1;
      const bOwn = b.relationshipCode.toUpperCase().startsWith(`${domain}_`) ? 0 : 1;
      return aOwn - bOwn || a.relationshipCode.localeCompare(b.relationshipCode);
    });

  const allowed = allowedDomains(onlyDomains);
  const usedAliases = new Set<string>();
  const seenParents = new Set<string>();
  const columns: ParentEntityColumn[] = [];
  for (const candidate of candidates) {
    if (allowed && !allowed.has(candidate.target)) continue;
    if (seenParents.has(candidate.target)) continue;
    seenParents.add(candidate.target);
    const header = columnHeader(candidate.target, domain, names);
    const alias = uniqueAlias(candidate.target, usedAliases);
    columns.push({
      alias,
      label: header,
      direction: candidate.direction,
      relationshipCode: candidate.relationshipCode,
      domainCode: candidate.target,
      field: 'entity_name',
      header,
    });
  }
  return columns.sort((a, b) => a.header.localeCompare(b.header));
}

/** Keep a page's own columns, then add any parent domain it does not already show. */
export function mergeParentColumns<T extends { domainCode?: string | null }>(
  explicit: readonly T[] | undefined,
  discovered: ParentEntityColumn[],
): Array<T | ParentEntityColumn> {
  const base = explicit ? [...explicit] : [];
  const seen = new Set(base.map((column) => (column.domainCode || '').toUpperCase()).filter(Boolean));
  return [
    ...base,
    ...discovered.filter((column) => !seen.has((column.domainCode || '').toUpperCase())),
  ];
}

/** Copy a name found by walking the other direction into the column the list shows. */
export function withParentNames<T extends Record<string, unknown>>(
  rows: T[],
  related: Array<{ alias: string; field: string }>,
): T[] {
  return rows.map((row) => {
    let next = row;
    for (const column of related) {
      const primary = `${column.alias}.${column.field}`;
      const alternate = `${column.alias}Alt.${column.field}`;
      const value = row[primary];
      if ((value == null || value === '') && row[alternate] != null && row[alternate] !== '') {
        next = { ...next, [primary]: row[alternate] };
      }
    }
    return next;
  });
}

/** Relationship codes where this entity type has one related record. */
export function singularRelationshipCodes(
  domainCode: string,
  relationships: ParentRelationshipType[],
  linkCounts: ParentLinkCount[] = [],
  onlyDomains: string[] = [],
): Set<string> {
  const domain = domainCode.trim().toUpperCase();
  const codes = new Set<string>();
  if (!domain) return codes;
  const allowed = allowedDomains(onlyDomains);
  for (const relationship of relationships) {
    const hop = parentHop(domain, relationship, linkCounts);
    if (!hop || (allowed && !allowed.has(hop.target))) continue;
    const code = relationship.relationshipCode.trim().toUpperCase();
    if (code) codes.add(code);
  }
  return codes;
}

function allowedDomains(onlyDomains: string[]): Set<string> | null {
  const allowed = new Set(onlyDomains.map((domain) => domain.trim().toUpperCase()).filter(Boolean));
  return allowed.size > 0 ? allowed : null;
}

export function toParentLinkCounts(rows: Array<Record<string, unknown>> | null | undefined): ParentLinkCount[] {
  return (rows || []).map((row) => ({
    relationshipCode: String(row.relationship_code || ''),
    parentDomainCode: String(row.parent_domain_code || ''),
    childDomainCode: String(row.child_domain_code || ''),
    linkCount: Number(row.link_count) || 0,
    maxPerParent: optionalCount(row.max_per_parent),
    maxPerChild: optionalCount(row.max_per_child),
  }));
}

function optionalCount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

export function domainLabel(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface DomainPlacement {
  target: string;
  direction: 'UP' | 'DOWN';
  weight: number;
  relationshipCode: string;
  /** This entity has one record on the other side. */
  singular: boolean;
}

interface ParentHop {
  target: string;
  direction: 'UP' | 'DOWN';
  weight: number;
  relationshipCode: string;
}

/** Every other domain this entity type links to, including links that are not one-to-one. */
export function domainPlacements(
  domainCode: string,
  relationships: ParentRelationshipType[],
  linkCounts: ParentLinkCount[] = [],
): DomainPlacement[] {
  const domain = domainCode.trim().toUpperCase();
  if (!domain) return [];
  const rows: DomainPlacement[] = [];
  for (const relationship of relationships) {
    const ends = storedEnds(relationship, linkCounts);
    if (!ends.parent || !ends.child) continue;
    if (ends.child === domain && ends.parent !== domain) {
      rows.push({
        target: ends.parent,
        direction: 'UP',
        weight: ends.weight,
        relationshipCode: relationship.relationshipCode,
        singular: oneRecord('up', relationship.cardinality, ends.maxPerChild),
      });
    } else if (ends.parent === domain && ends.child !== domain) {
      rows.push({
        target: ends.child,
        direction: 'DOWN',
        weight: ends.weight,
        relationshipCode: relationship.relationshipCode,
        singular: oneRecord('down', relationship.cardinality, ends.maxPerParent),
      });
    }
  }
  return rows;
}

interface StoredEnds {
  parent: string;
  child: string;
  weight: number;
  maxPerParent: number | null;
  maxPerChild: number | null;
}

function parentHop(
  domain: string,
  relationship: ParentRelationshipType,
  linkCounts: ParentLinkCount[],
): ParentHop | null {
  const placement = domainPlacements(domain, [relationship], linkCounts).find((row) => row.singular);
  if (!placement) return null;
  return {
    target: placement.target,
    direction: placement.direction,
    weight: placement.weight,
    relationshipCode: placement.relationshipCode,
  };
}

function storedEnds(relationship: ParentRelationshipType, linkCounts: ParentLinkCount[]): StoredEnds {
  const code = relationship.relationshipCode.toUpperCase();
  const stored = linkCounts
    .filter((row) => row.relationshipCode.toUpperCase() === code && row.linkCount > 0 && row.parentDomainCode && row.childDomainCode)
    .sort((a, b) => b.linkCount - a.linkCount)[0];
  if (stored) {
    return {
      parent: stored.parentDomainCode.toUpperCase(),
      child: stored.childDomainCode.toUpperCase(),
      weight: stored.linkCount,
      maxPerParent: stored.maxPerParent ?? null,
      maxPerChild: stored.maxPerChild ?? null,
    };
  }
  return {
    parent: (relationship.parentDomainCode || '').toUpperCase(),
    child: (relationship.childDomainCode || '').toUpperCase(),
    weight: 0,
    maxPerParent: null,
    maxPerChild: null,
  };
}

/** Cardinality says this side is one, and the stored rows agree when we have them. */
function oneRecord(direction: 'up' | 'down', cardinality: string | null | undefined, max: number | null): boolean {
  const declared = direction === 'up' ? toOneUp(cardinality) : toOneDown(cardinality);
  if (!declared) return false;
  return max == null || max <= 1;
}

function toOneUp(cardinality?: string | null): boolean {
  const kind = (cardinality || '').trim().toUpperCase();
  return kind === '' || kind === 'ONE_TO_ONE' || kind === 'ONE_TO_MANY';
}

function toOneDown(cardinality?: string | null): boolean {
  const kind = (cardinality || '').trim().toUpperCase();
  return kind === '' || kind === 'ONE_TO_ONE' || kind === 'MANY_TO_ONE';
}

function columnHeader(parent: string, child: string, names: Record<string, string>): string {
  const name = names[parent] || names[parent.toUpperCase()] || domainLabel(parent);
  return parent === child ? `Parent ${name}` : name;
}

function uniqueAlias(domain: string, used: Set<string>): string {
  const base = domain.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'parent';
  let alias = base;
  let n = 2;
  while (used.has(alias)) {
    alias = `${base}${n}`;
    n += 1;
  }
  used.add(alias);
  return alias;
}
