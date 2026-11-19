/**
 * Reference fields point at another record. A file names that record by its id,
 * its entity code or its name. These helpers turn what the file says into the
 * record's master id.
 */

export interface ReferenceCandidate {
  id: string;
  code: string | null;
  name: string | null;
}

export type ReferenceMatchType = 'id' | 'code' | 'name';

export interface ReferenceIndex {
  byId: Map<string, string>;
  byCode: Map<string, string>;
  /** Names shared by more than one record map to null: they cannot pick one. */
  byName: Map<string, string | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntityId(value: string): boolean {
  return UUID.test(value.trim());
}

function key(value: string | null | undefined): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function emptyReferenceIndex(): ReferenceIndex {
  return { byId: new Map(), byCode: new Map(), byName: new Map() };
}

/** Adds records to an index. Records added first win a code; a name held by two records is ambiguous. */
export function indexReferences(index: ReferenceIndex, candidates: ReferenceCandidate[]): ReferenceIndex {
  for (const candidate of candidates) {
    if (!candidate.id) continue;
    index.byId.set(key(candidate.id), candidate.id);
    const code = key(candidate.code);
    if (code && !index.byCode.has(code)) index.byCode.set(code, candidate.id);
    const name = key(candidate.name);
    if (!name) continue;
    const held = index.byName.get(name);
    if (held === undefined) index.byName.set(name, candidate.id);
    else if (held !== candidate.id) index.byName.set(name, null);
  }
  return index;
}

export type ReferenceMatch =
  | { kind: 'match'; id: string; matchType: ReferenceMatchType }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/** The record a file value names: by id first, then entity code, then a name only one record holds. */
export function matchReference(index: ReferenceIndex, raw: string): ReferenceMatch {
  const value = key(raw);
  if (!value) return { kind: 'none' };
  const byId = index.byId.get(value);
  if (byId) return { kind: 'match', id: byId, matchType: 'id' };
  const byCode = index.byCode.get(value);
  if (byCode) return { kind: 'match', id: byCode, matchType: 'code' };
  const byName = index.byName.get(value);
  if (byName) return { kind: 'match', id: byName, matchType: 'name' };
  if (byName === null) return { kind: 'ambiguous' };
  return { kind: 'none' };
}

/** Lower-cased lookups for a set of raw values, for querying codes and names. */
export function referenceLookups(raws: Iterable<string>): { ids: string[]; texts: string[] } {
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const raw of raws) {
    const value = raw.trim();
    if (!value) continue;
    if (isEntityId(value)) ids.add(value.toLowerCase());
    else texts.add(value);
  }
  return { ids: [...ids], texts: [...texts] };
}
