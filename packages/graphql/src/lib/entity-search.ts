export type EntitySearchMatchKind = 'NAME' | 'ALIAS' | 'PARENT' | 'RELATED';

export interface SearchEntityRow {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  isActive?: boolean | null;
  /** Another name of this record that the query matched. Null when the record name itself matched. */
  matchedAlias?: string | null;
}

export interface SearchDomainRow {
  domainCode: string;
  domainName: string;
  parentDomainCode?: string | null;
}

export interface SearchLinkRow {
  parentEntityId: string;
  childEntityId: string;
}

export interface EntitySearchHit {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  depth: number;
  match: EntitySearchMatchKind;
  matchedName: string | null;
  matchedDomainName: string | null;
}

const PER_DOMAIN = 8;
const CHILD_LINK_CAP = 80;
const PARENT_LINK_CAP = 200;
const NEIGHBOR_CAP = 80;
const MIN_QUERY = 2;

type SearchClient = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** LIKE pattern that matches the query as a substring. `%` and `_` in the query stay literal. */
export function ilikeContainsPattern(query: string): string {
  const literal = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${literal}%`;
}

/** Domains with no parent in this catalog. Their records are the parent entities. */
export function rootDomainCodes(domains: readonly SearchDomainRow[]): string[] {
  const known = new Set(domains.map((domain) => domain.domainCode.toUpperCase()));
  return domains
    .filter((domain) => {
      const parent = (domain.parentDomainCode || '').toUpperCase();
      return !parent || !known.has(parent);
    })
    .map((domain) => domain.domainCode);
}

export function domainDepth(code: string, parentOf: ReadonlyMap<string, string | null>): number {
  let depth = 0;
  let cursor = parentOf.get(code.toUpperCase()) ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    if (depth > 12) break;
    cursor = parentOf.get(cursor) ?? null;
  }
  return depth;
}

/**
 * Rank entities whose own name, a stored alias, a related entity name, or a parent
 * entity name contains the query. Records in parent domains come before records in child domains.
 */
export function rankEntitySearch(input: {
  query: string;
  entities: readonly SearchEntityRow[];
  links: readonly SearchLinkRow[];
  domains: readonly SearchDomainRow[];
  limit?: number;
}): EntitySearchHit[] {
  const query = normalize(input.query);
  if (query.length < MIN_QUERY) return [];
  const limit = clampLimit(input.limit);

  const known = new Set(input.domains.map((domain) => domain.domainCode.toUpperCase()));
  const parentOf = new Map<string, string | null>();
  const domainNames = new Map<string, string>();
  for (const domain of input.domains) {
    const code = domain.domainCode.toUpperCase();
    const parent = (domain.parentDomainCode || '').toUpperCase();
    parentOf.set(code, parent && known.has(parent) ? parent : null);
    domainNames.set(code, domain.domainName || domain.domainCode);
  }

  const entities = dedupeEntities(
    input.entities.filter((entity) => entity.isActive !== false && entity.id && entity.entityName),
  );
  const byId = new Map(entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const ownNameHits = new Set(
    entities.filter((entity) => contains(entity.entityName, query)).map((entity) => entity.id.toLowerCase()),
  );
  const aliasHits = new Map<string, string>();
  for (const entity of entities) {
    const id = entity.id.toLowerCase();
    if (ownNameHits.has(id) || !entity.matchedAlias || !contains(entity.matchedAlias, query)) continue;
    aliasHits.set(id, entity.matchedAlias);
  }
  const directHits = new Set<string>([...ownNameHits, ...aliasHits.keys()]);

  const linksByEntity = new Map<string, SearchLinkRow[]>();
  for (const link of input.links) {
    const parentId = link.parentEntityId.toLowerCase();
    const childId = link.childEntityId.toLowerCase();
    if (!byId.has(parentId) || !byId.has(childId)) continue;
    const normalized = { parentEntityId: parentId, childEntityId: childId };
    pushLink(linksByEntity, parentId, normalized);
    pushLink(linksByEntity, childId, normalized);
  }

  const candidates = entities.filter((entity) => {
    const id = entity.id.toLowerCase();
    if (directHits.has(id)) return true;
    return (linksByEntity.get(id) || []).some((link) => directHits.has(otherEnd(link, id)));
  });

  const ranked = candidates.map((entity) => {
    const domainCode = entity.domainCode.toUpperCase();
    const choice = chooseMatch(
      entity,
      ownNameHits,
      aliasHits,
      linksByEntity.get(entity.id.toLowerCase()) || [],
      byId,
      parentOf,
      domainNames,
    );
    return {
      hit: {
        id: entity.id,
        entityCode: entity.entityCode,
        entityName: entity.entityName,
        domainCode: entity.domainCode,
        domainName: domainNames.get(domainCode) || entity.domainCode,
        depth: domainDepth(domainCode, parentOf),
        match: choice.match,
        matchedName: choice.matchedName,
        matchedDomainName: choice.matchedDomainName,
      } satisfies EntitySearchHit,
    };
  });

  ranked.sort((a, b) => (
    a.hit.depth - b.hit.depth
    || a.hit.domainName.localeCompare(b.hit.domainName)
    || a.hit.entityName.localeCompare(b.hit.entityName)
    || a.hit.id.localeCompare(b.hit.id)
  ));

  return spreadAcrossDomains(ranked.map((row) => row.hit), limit);
}

/**
 * Keep every entity type in the list. A single ordered slice would fill the
 * limit with whichever type sorts first, and drop the rest.
 */
function spreadAcrossDomains(hits: EntitySearchHit[], limit: number): EntitySearchHit[] {
  if (hits.length <= limit) return hits;
  const groups: EntitySearchHit[][] = [];
  let currentKey = '';
  for (const hit of hits) {
    const key = `${hit.depth}\0${hit.domainName}`;
    if (key !== currentKey) {
      groups.push([]);
      currentKey = key;
    }
    groups[groups.length - 1].push(hit);
  }
  const chosen: EntitySearchHit[] = [];
  const cursors = groups.map(() => 0);
  let remaining = limit;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < groups.length && remaining > 0; index += 1) {
      const cursor = cursors[index];
      if (cursor >= groups[index].length) continue;
      chosen.push(groups[index][cursor]);
      cursors[index] = cursor + 1;
      remaining -= 1;
      progressed = true;
    }
  }
  chosen.sort((a, b) => (
    a.depth - b.depth
    || a.domainName.localeCompare(b.domainName)
    || a.entityName.localeCompare(b.entityName)
    || a.id.localeCompare(b.id)
  ));
  return chosen;
}

/** Load a bounded candidate set and rank parent domains ahead of child domains. */
export async function fetchEntitySearchHits(
  supabase: SearchClient,
  query: string,
  limit?: number,
): Promise<EntitySearchHit[]> {
  const text = query.trim();
  if (text.length < MIN_QUERY) return [];
  const capped = clampLimit(limit);

  const domainResult = await supabase
    .from('domain_types')
    .select('domain_code, domain_name, parent_domain_code')
    .eq('is_active', true);
  if (domainResult.error) throw new Error(domainResult.error.message);

  const domains: SearchDomainRow[] = ((domainResult.data || []) as Record<string, unknown>[]).map((row) => ({
    domainCode: String(row.domain_code || ''),
    domainName: String(row.domain_name || row.domain_code || ''),
    parentDomainCode: row.parent_domain_code ? String(row.parent_domain_code) : null,
  })).filter((domain) => domain.domainCode);

  const named = await loadNamesByDomain(supabase, text);

  const links = named.length ? await loadLinks(supabase, named.map((entity) => entity.id)) : [];
  const neighborIds = preferParentNeighbors(named, links);
  const neighbors = neighborIds.length ? await loadByIds(supabase, neighborIds) : [];

  return rankEntitySearch({
    query: text,
    entities: dedupeEntities([...named, ...neighbors]),
    links,
    domains,
    limit: capped,
  });
}

/** Top alphabetical name matches from each domain, so one type cannot crowd out the others. */
async function loadNamesByDomain(supabase: SearchClient, query: string): Promise<SearchEntityRow[]> {
  const result = await supabase.rpc('search_entity_names', { p_query: query, p_per_domain: PER_DOMAIN });
  if (result.error) throw new Error(result.error.message);
  return dedupeEntities(((result.data || []) as Record<string, unknown>[]).map(mapEntity));
}

async function loadByIds(supabase: SearchClient, ids: string[]): Promise<SearchEntityRow[]> {
  const result = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name, domain_code, is_active')
    .eq('is_active', true)
    .in('id', ids);
  if (result.error) throw new Error(result.error.message);
  const order = new Map(ids.map((id, index) => [id, index]));
  return ((result.data || []) as Record<string, unknown>[])
    .map(mapEntity)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

async function loadLinks(supabase: SearchClient, nameIds: string[]): Promise<SearchLinkRow[]> {
  const [asParent, asChild] = await Promise.all([
    supabase
      .from('entity_relationships')
      .select('parent_entity_id, child_entity_id, valid_to, system_to')
      .in('parent_entity_id', nameIds)
      .eq('valid_to', '9999-12-31')
      .limit(CHILD_LINK_CAP),
    supabase
      .from('entity_relationships')
      .select('parent_entity_id, child_entity_id, valid_to, system_to')
      .in('child_entity_id', nameIds)
      .eq('valid_to', '9999-12-31')
      .limit(PARENT_LINK_CAP),
  ]);
  if (asParent.error) throw new Error(asParent.error.message);
  if (asChild.error) throw new Error(asChild.error.message);

  const seen = new Set<string>();
  const links: SearchLinkRow[] = [];
  for (const row of [...(asParent.data || []), ...(asChild.data || [])]) {
    if (!isCurrent(row)) continue;
    const parentEntityId = String(row.parent_entity_id || '');
    const childEntityId = String(row.child_entity_id || '');
    if (!parentEntityId || !childEntityId) continue;
    const key = `${parentEntityId}|${childEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ parentEntityId, childEntityId });
  }
  return links;
}

/** Parents of a name match come first, then a bounded set of children. */
function preferParentNeighbors(named: readonly SearchEntityRow[], links: readonly SearchLinkRow[]): string[] {
  const namedIds = new Set(named.map((entity) => entity.id));
  const parents: string[] = [];
  const children: string[] = [];
  for (const link of links) {
    const parentNamed = namedIds.has(link.parentEntityId);
    const childNamed = namedIds.has(link.childEntityId);
    if (childNamed && !parentNamed) parents.push(link.parentEntityId);
    if (parentNamed && !childNamed) children.push(link.childEntityId);
  }
  return unique([...parents, ...children]).slice(0, NEIGHBOR_CAP);
}

function mapEntity(row: Record<string, unknown>): SearchEntityRow {
  return {
    id: String(row.id || ''),
    entityCode: String(row.entity_code || ''),
    entityName: String(row.entity_name || ''),
    domainCode: String(row.domain_code || ''),
    isActive: row.is_active !== false,
    matchedAlias: row.matched_alias ? String(row.matched_alias) : null,
  };
}

function isCurrent(row: Record<string, unknown>): boolean {
  const validTo = String(row.valid_to || '9999-12-31').slice(0, 10);
  const systemTo = String(row.system_to || '9999');
  return validTo >= '9999-01-01' && systemTo.startsWith('9999');
}

interface MatchChoice {
  match: EntitySearchMatchKind;
  matchedName: string | null;
  matchedDomainName: string | null;
  viaDepth: number;
}

function chooseMatch(
  entity: SearchEntityRow,
  ownNameHits: ReadonlySet<string>,
  aliasHits: ReadonlyMap<string, string>,
  links: readonly SearchLinkRow[],
  byId: ReadonlyMap<string, SearchEntityRow>,
  parentOf: ReadonlyMap<string, string | null>,
  domainNames: ReadonlyMap<string, string>,
): MatchChoice {
  const id = entity.id.toLowerCase();
  if (ownNameHits.has(id)) {
    return { match: 'NAME', matchedName: null, matchedDomainName: null, viaDepth: 0 };
  }
  const alias = aliasHits.get(id);
  if (alias) {
    return { match: 'ALIAS', matchedName: alias, matchedDomainName: null, viaDepth: 0 };
  }

  let best: MatchChoice | null = null;
  for (const link of links) {
    const otherId = otherEnd(link, id);
    const other = byId.get(otherId);
    const otherLabel = ownNameHits.has(otherId) ? other?.entityName : aliasHits.get(otherId);
    if (!other || !otherLabel) continue;
    const otherDomain = other.domainCode.toUpperCase();
    const entityDomain = entity.domainCode.toUpperCase();
    const storedAsParent = link.parentEntityId === other.id.toLowerCase() && link.childEntityId === entity.id.toLowerCase();
    const ancestor = isAncestor(otherDomain, entityDomain, parentOf);
    const choice: MatchChoice = {
      match: storedAsParent || ancestor ? 'PARENT' : 'RELATED',
      matchedName: otherLabel,
      matchedDomainName: domainNames.get(otherDomain) || other.domainCode,
      viaDepth: domainDepth(otherDomain, parentOf),
    };
    if (!best || preferChoice(choice, best)) best = choice;
  }

  return best || { match: 'RELATED', matchedName: null, matchedDomainName: null, viaDepth: 99 };
}

function preferChoice(next: MatchChoice, current: MatchChoice): boolean {
  const rank = (kind: EntitySearchMatchKind) => (kind === 'PARENT' ? 0 : 1);
  if (rank(next.match) !== rank(current.match)) return rank(next.match) < rank(current.match);
  if (next.viaDepth !== current.viaDepth) return next.viaDepth < current.viaDepth;
  return (next.matchedName || '').localeCompare(current.matchedName || '') < 0;
}

function isAncestor(ancestor: string, domain: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  let cursor = parentOf.get(domain) ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

function otherEnd(link: SearchLinkRow, entityId: string): string {
  return link.parentEntityId === entityId ? link.childEntityId : link.parentEntityId;
}

function pushLink(linksByEntity: Map<string, SearchLinkRow[]>, entityId: string, link: SearchLinkRow) {
  const current = linksByEntity.get(entityId);
  if (current) current.push(link);
  else linksByEntity.set(entityId, [link]);
}

function contains(name: string, query: string): boolean {
  return normalize(name).includes(query);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 48);
}

function dedupeEntities(entities: readonly SearchEntityRow[]): SearchEntityRow[] {
  const seen = new Set<string>();
  const rows: SearchEntityRow[] = [];
  for (const entity of entities) {
    const id = entity.id.toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push(entity);
  }
  return rows;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}
