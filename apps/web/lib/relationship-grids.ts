import { domainLabel, singularRelationshipCodes, type ParentLinkCount, type ParentRelationshipType } from './parent-entities';

export interface RelatedEntityRef {
  entityId?: string | null;
  domainCode?: string | null;
  relationshipCode?: string | null;
  members?: Array<{ entityId?: string | null; domainCode?: string | null }> | null;
}

export interface RelationshipGrid {
  side: 'parent' | 'child';
  domainCode: string;
  entityIds: string[];
}

/**
 * A security is a child of its issuer. The stored link keeps the security on
 * the parent side of SECURITY_ISSUER, so the record swaps that pair when it presents them.
 */
export function classifyRecordRelationships(
  domainCode: string,
  parents: RelatedEntityRef[],
  children: RelatedEntityRef[],
): { parents: RelatedEntityRef[]; children: RelatedEntityRef[] } {
  const domain = domainCode.trim().toUpperCase();
  if (domain === 'ISSUER') {
    const stay: RelatedEntityRef[] = [];
    const securities: RelatedEntityRef[] = [];
    for (const parent of parents) {
      if (domainOf(parent) === 'SECURITY') securities.push(parent);
      else stay.push(parent);
    }
    return { parents: stay, children: [...children, ...securities] };
  }
  if (domain === 'SECURITY') {
    const stay: RelatedEntityRef[] = [];
    const issuers: RelatedEntityRef[] = [];
    for (const child of children) {
      if (domainOf(child) === 'ISSUER') issuers.push(child);
      else stay.push(child);
    }
    return { parents: [...parents, ...issuers], children: stay };
  }
  return { parents, children };
}

function domainOf(related: RelatedEntityRef): string {
  return (related.domainCode || '').trim().toUpperCase();
}

/** Keep related records only when this entity type has one of them. */
export function singularRelatedRefs(
  domainCode: string,
  rows: RelatedEntityRef[],
  relationships: ParentRelationshipType[],
  linkCounts: ParentLinkCount[] = [],
  onlyDomains: string[] = [],
): RelatedEntityRef[] {
  const allowed = singularRelationshipCodes(domainCode, relationships, linkCounts, onlyDomains);
  return rows.filter((row) => allowed.has((row.relationshipCode || '').trim().toUpperCase()));
}

/** One grid per related entity type. Parent types come first, then child types. */
export function relationshipGrids(
  parents: RelatedEntityRef[],
  children: RelatedEntityRef[],
  excludeEntityId?: string | null,
): RelationshipGrid[] {
  const parentGroups = collectSide(parents, 'parent', excludeEntityId);
  const childGroups = collectSide(children, 'child', excludeEntityId);
  return [...parentGroups, ...childGroups];
}

/** Parent types stay ahead of child types. Within a side, grids follow the entity type name. */
export function orderRelationshipGrids(
  grids: RelationshipGrid[],
  names: Record<string, string> = {},
): RelationshipGrid[] {
  const label = (code: string) => names[code] || names[code.toUpperCase()] || domainLabel(code);
  return [...grids].sort((a, b) => {
    if (a.side !== b.side) return a.side === 'parent' ? -1 : 1;
    return label(a.domainCode).localeCompare(label(b.domainCode)) || a.domainCode.localeCompare(b.domainCode);
  });
}

function collectSide(
  rows: RelatedEntityRef[],
  side: RelationshipGrid['side'],
  excludeEntityId?: string | null,
): RelationshipGrid[] {
  const groups = new Map<string, RelationshipGrid>();
  const add = (domainCode?: string | null, entityId?: string | null) => {
    const domain = (domainCode || '').trim().toUpperCase();
    const id = (entityId || '').trim();
    if (!domain || !id || (excludeEntityId && id === excludeEntityId)) return;
    let group = groups.get(domain);
    if (!group) {
      group = { side, domainCode: domain, entityIds: [] };
      groups.set(domain, group);
    }
    if (!group.entityIds.includes(id)) group.entityIds.push(id);
  };
  for (const row of rows) {
    add(row.domainCode, row.entityId);
    for (const member of row.members || []) add(member.domainCode, member.entityId);
  }
  return [...groups.values()].sort((a, b) => a.domainCode.localeCompare(b.domainCode));
}
