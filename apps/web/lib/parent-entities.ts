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
}

/** Parent columns for an entity list. A position lists its fund and its security. */
export function parentEntityColumns(
  domainCode: string,
  relationships: ParentRelationshipType[],
  names: Record<string, string> = {},
  linkCounts: ParentLinkCount[] = [],
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

  const usedAliases = new Set<string>();
  const seenParents = new Set<string>();
  const columns: ParentEntityColumn[] = [];
  for (const candidate of candidates) {
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

export interface RecordLink {
  entityId: string;
  entityName: string;
  domainCode: string;
}

/** Parents on one record, including a fund stored on the child side of a position. */
export function recordParentLinks(
  parents: Array<{ parentEntityId?: string | null; parentEntityName?: string | null; parentDomainCode?: string | null; relationshipCode?: string | null }>,
  children: Array<{ childEntityId?: string | null; childEntityName?: string | null; childDomainCode?: string | null; relationshipCode?: string | null }>,
  types: ParentRelationshipType[],
  domainCode = '',
): RecordLink[] {
  const byCode = new Map(types.map((type) => [type.relationshipCode, type]));
  const domain = domainCode.trim().toUpperCase();
  const seen = new Set<string>();
  const links: RecordLink[] = [];
  const add = (id?: string | null, name?: string | null, relatedDomain?: string | null) => {
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    links.push({ entityId: id, entityName: name, domainCode: relatedDomain || '' });
  };
  const typesReady = types.length > 0;
  for (const parent of parents) {
    const type = byCode.get(parent.relationshipCode || '');
    const related = (parent.parentDomainCode || '').toUpperCase();
    if (!typesReady || !type) {
      add(parent.parentEntityId, parent.parentEntityName, parent.parentDomainCode);
      continue;
    }
    if ((domain && related === domain) || toOneUp(type.cardinality)) {
      add(parent.parentEntityId, parent.parentEntityName, parent.parentDomainCode);
    }
  }
  for (const child of children) {
    const type = byCode.get(child.relationshipCode || '');
    if (!type) continue;
    const related = (child.childDomainCode || '').toUpperCase();
    const declaredParent = (type.parentDomainCode || '').toUpperCase();
    const declaredChild = (type.childDomainCode || '').toUpperCase();
    const storedBackwards = !!declaredParent && declaredParent === related && declaredParent !== declaredChild;
    if (storedBackwards || (toOneDown(type.cardinality) && (!domain || related !== domain))) {
      add(child.childEntityId, child.childEntityName, child.childDomainCode);
    }
  }
  return links.sort((a, b) => a.domainCode.localeCompare(b.domainCode) || a.entityName.localeCompare(b.entityName));
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
        if (next === row) next = { ...row };
        next[primary] = row[alternate];
      }
    }
    return next;
  });
}

export function domainLabel(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface ParentHop {
  target: string;
  direction: 'UP' | 'DOWN';
  weight: number;
  relationshipCode: string;
}

function parentHop(
  domain: string,
  relationship: ParentRelationshipType,
  linkCounts: ParentLinkCount[],
): ParentHop | null {
  const ends = storedEnds(relationship, linkCounts);
  if (!ends.parent || !ends.child) return null;
  const relationshipCode = relationship.relationshipCode;
  if (ends.child === domain && toOneUp(relationship.cardinality) && ends.parent !== domain) {
    return { target: ends.parent, direction: 'UP', weight: ends.weight, relationshipCode };
  }
  if (ends.parent === domain && toOneDown(relationship.cardinality) && ends.child !== domain) {
    return { target: ends.child, direction: 'DOWN', weight: ends.weight, relationshipCode };
  }
  return null;
}

function storedEnds(relationship: ParentRelationshipType, linkCounts: ParentLinkCount[]) {
  const code = relationship.relationshipCode.toUpperCase();
  const stored = linkCounts
    .filter((row) => row.relationshipCode.toUpperCase() === code && row.linkCount > 0 && row.parentDomainCode && row.childDomainCode)
    .sort((a, b) => b.linkCount - a.linkCount)[0];
  if (stored) {
    return {
      parent: stored.parentDomainCode.toUpperCase(),
      child: stored.childDomainCode.toUpperCase(),
      weight: stored.linkCount,
    };
  }
  return {
    parent: (relationship.parentDomainCode || '').toUpperCase(),
    child: (relationship.childDomainCode || '').toUpperCase(),
    weight: 0,
  };
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
