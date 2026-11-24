import { compactIdentifier, normalizeName } from '../../../graphql/src/lib/entity-resolution/similarity';

/**
 * Match a file row to an existing entity before inserting another one.
 * A row matches an entity in the same domain when any of these agree:
 * the entity code, the entity name, a single-attribute identifier, or a
 * full composite identifier. Codes and identifier values ignore punctuation.
 * Names ignore case, punctuation, and legal suffixes.
 *
 * Pass the file's as-of date and identifier values are taken from the slice
 * that was current on that date. A dated identifier wins over the entity code,
 * so a historical file whose only key was later reused lands on the entity
 * that held the key on the file date.
 */

export interface IdentifierCatalog {
  singles: string[];
  composites: string[][];
}

export interface IdentifierTerm {
  value: string;
  validFrom: string;
  validTo: string;
}

export interface MatchEntity {
  id: string;
  code: string;
  name: string;
  domainCode: string;
  /** The owning client. Every record belongs to exactly one. */
  clientId: string;
  active: boolean;
  provisional: boolean;
  identifiers: Map<string, string[]>;
  identifierTerms?: Map<string, IdentifierTerm[]>;
  /** Other names of this record, such as a project name. */
  aliases?: string[];
}

export interface IncomingEntity {
  code: string;
  name: string;
  attributes: Map<string, string>;
  aliases?: string[];
}

/** The record a value in another record's column names, such as a position's fund. */
export type LookupHit =
  | { kind: 'match'; entity: MatchEntity; via: 'id' | 'code' | 'identifier' | 'name' }
  | { kind: 'ambiguous'; entities: MatchEntity[]; message: string }
  | { kind: 'none'; message: string };

const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolveHit =
  | { kind: 'match'; entity: MatchEntity; via: 'code' | 'identifier' | 'name' }
  | { kind: 'ambiguous'; via: 'code' | 'identifier' | 'name'; entities: MatchEntity[]; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'none' };

export function identifierCatalog(definitions: readonly (readonly string[])[]): IdentifierCatalog {
  const singles: string[] = [];
  const composites: string[][] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const codes = [...new Set(definition.map((code) => code.trim().toUpperCase()).filter(Boolean))];
    if (codes.length === 1) {
      if (seen.has(codes[0])) continue;
      seen.add(codes[0]);
      singles.push(codes[0]);
      continue;
    }
    if (codes.length > 1) composites.push(codes);
  }
  return { singles, composites };
}

function attributeValues(attributes: Map<string, string>): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const [code, raw] of attributes) {
    const key = code.trim().toUpperCase();
    if (!key || !raw?.trim()) continue;
    const list = values.get(key) || [];
    list.push(raw);
    values.set(key, list);
  }
  return values;
}

function compactValues(rawValues: readonly string[]): string[] {
  return [...new Set(rawValues.map((value) => compactIdentifier(value)).filter((value) => value.length >= 2))];
}

function nameKey(value: string): string {
  const key = normalizeName(value);
  return key.length >= 2 ? key : '';
}

function sameLabel(left: string, right: string): boolean {
  const leftName = nameKey(left);
  const rightName = nameKey(right);
  if (leftName && leftName === rightName) return true;
  const leftCode = compactIdentifier(left);
  const rightCode = compactIdentifier(right);
  return leftCode.length >= 2 && leftCode === rightCode;
}

/** When a prior load stored the name as the code, keep the entity that has its own code. */
function soleCodedEntity(entities: MatchEntity[]): MatchEntity | null {
  const coded = entities.filter((entity) => !sameLabel(entity.code, entity.name));
  return coded.length === 1 ? coded[0] : null;
}

function compositeKeys(values: Map<string, string[]>, composite: readonly string[]): string[] {
  let keys = [''];
  for (const code of composite) {
    const parts = compactValues(values.get(code) || []);
    if (!parts.length) return [];
    const next: string[] = [];
    for (const prefix of keys) {
      for (const part of parts) next.push(prefix ? `${prefix}|${part}` : part);
    }
    keys = next.slice(0, 24);
  }
  return keys;
}

export class EntityMatchIndex {
  private readonly byId = new Map<string, MatchEntity>();
  private readonly byCode = new Map<string, MatchEntity[]>();
  private readonly byName = new Map<string, MatchEntity[]>();
  private readonly byCodeName = new Map<string, MatchEntity[]>();
  private readonly byIdentifier = new Map<string, MatchEntity[]>();
  private readonly byComposite = new Map<string, MatchEntity[]>();

  constructor(
    private readonly catalog: IdentifierCatalog,
    private readonly domainCode: string,
    private readonly clientId: string,
  ) {}

  add(entity: MatchEntity): void {
    if (this.byId.has(entity.id) || !this.ownedByClient(entity)) return;
    this.byId.set(entity.id, entity);
    this.indexCode(entity, entity.code);
    this.indexName(entity, entity.name);
    for (const alias of entity.aliases || []) this.indexName(entity, alias);
    this.indexIdentifiers(entity, entity.identifiers);
    this.indexIdentifiers(entity, this.termValues(entity));
  }

  absorb(id: string, incoming: IncomingEntity): void {
    const entity = this.byId.get(id);
    if (!entity) return;
    this.indexCode(entity, incoming.code);
    this.indexName(entity, incoming.name);
    for (const alias of incoming.aliases || []) this.indexName(entity, alias);
    const incomingValues = attributeValues(incoming.attributes);
    for (const [code, rawValues] of incomingValues) {
      if (!this.tracks(code)) continue;
      const list = entity.identifiers.get(code) || [];
      list.push(...rawValues);
      entity.identifiers.set(code, list);
    }
    this.indexIdentifiers(entity, incomingValues);
  }

  resolve(incoming: IncomingEntity, asOf?: string): ResolveHit {
    const values = attributeValues(incoming.attributes);
    if (asOf) {
      const dated = this.collectIdentifiers(incoming.code, values, asOf, true);
      if (dated.length) {
        const chosen = this.choose(dated, 'identifier', incoming.code);
        if (chosen) return chosen;
      }
    }

    const codeHit = this.resolveCode(incoming.code);
    if (codeHit) return codeHit;

    const identified = this.collectIdentifiers(incoming.code, values, asOf, false);
    if (identified.length) {
      const chosen = this.choose(identified, 'identifier', incoming.code);
      if (chosen) return chosen;
    }

    const named = this.collectNames(incoming);
    if (!named.length) return { kind: 'none' };
    return this.choose(named, 'name', incoming.code) || { kind: 'none' };
  }

  /**
   * The record a single value names, the way a file names a parent or a referenced
   * record: its id, then the same lookup a row gets (a dated identifier, the code,
   * any identifier, then the name or an alias). The value is tried as a code, an
   * identifier value and a name at once.
   */
  lookup(raw: string, asOf?: string): LookupHit {
    const value = raw.trim();
    if (!value) return { kind: 'none', message: 'No value given.' };
    if (ENTITY_ID.test(value)) {
      const entity = this.byId.get(value.toLowerCase()) || this.byId.get(value);
      if (entity && this.matchable(entity)) return { kind: 'match', entity, via: 'id' };
    }
    const hit = this.resolve({ code: value, name: value, attributes: new Map() }, asOf);
    if (hit.kind === 'match') return hit;
    if (hit.kind === 'ambiguous') {
      const labels = hit.entities.slice(0, 5).map((entity) => entity.code).join(', ');
      return { kind: 'ambiguous', entities: hit.entities, message: `"${value}" names ${hit.entities.length} ${this.domainCode} records (${labels}).` };
    }
    if (hit.kind === 'rejected') return { kind: 'none', message: hit.message };
    return { kind: 'none', message: `No ${this.domainCode} record matches "${value}".` };
  }

  private tracks(code: string): boolean {
    if (this.catalog.singles.includes(code)) return true;
    return this.catalog.composites.some((composite) => composite.includes(code));
  }

  /** A record of the loading client. Records of any other client are never matched, named or reported. */
  private ownedByClient(entity: MatchEntity): boolean {
    return Boolean(this.clientId) && entity.clientId === this.clientId;
  }

  private matchable(entity: MatchEntity): boolean {
    return entity.active
      && entity.domainCode === this.domainCode
      && this.ownedByClient(entity);
  }

  private push(index: Map<string, MatchEntity[]>, key: string, entity: MatchEntity): void {
    if (!key) return;
    const list = index.get(key) || [];
    if (!list.some((item) => item.id === entity.id)) list.push(entity);
    index.set(key, list);
  }

  private indexCode(entity: MatchEntity, code: string): void {
    this.push(this.byCode, compactIdentifier(code), entity);
    this.push(this.byCodeName, nameKey(code), entity);
  }

  private indexName(entity: MatchEntity, name: string): void {
    this.push(this.byName, nameKey(name), entity);
  }

  private termValues(entity: MatchEntity): Map<string, string[]> {
    const values = new Map<string, string[]>();
    for (const [code, terms] of entity.identifierTerms || []) {
      values.set(code, terms.map((term) => term.value));
    }
    return values;
  }

  /** True when a dated slice covers the value. Null when this entity has no slices for the attribute. */
  private termCovers(entity: MatchEntity, code: string, compactValue: string, asOf?: string): boolean | null {
    const terms = entity.identifierTerms?.get(code);
    if (!terms?.length) return null;
    if (!asOf) return true;
    return terms.some((term) => compactIdentifier(term.value) === compactValue && term.validFrom <= asOf && term.validTo >= asOf);
  }

  private hasTerm(code: string, compactValue: string): boolean {
    const entities = this.byIdentifier.get(`${code}|${compactValue}`) || [];
    return entities.some((entity) => (entity.identifierTerms?.get(code) || []).some((term) => compactIdentifier(term.value) === compactValue));
  }

  private identifierActive(entity: MatchEntity, code: string, compactValue: string, asOf: string | undefined, datedOnly: boolean): boolean {
    const covered = this.termCovers(entity, code, compactValue, asOf);
    if (datedOnly) return covered === true;
    return covered !== false;
  }

  private indexIdentifiers(entity: MatchEntity, values: Map<string, string[]>): void {
    for (const code of this.catalog.singles) {
      for (const value of compactValues(values.get(code) || [])) {
        this.push(this.byIdentifier, `${code}|${value}`, entity);
      }
    }
    this.catalog.composites.forEach((composite, index) => {
      for (const key of compositeKeys(values, composite)) {
        this.push(this.byComposite, `${index}|${key}`, entity);
      }
    });
  }

  private resolveCode(code: string): ResolveHit | null {
    const key = compactIdentifier(code);
    if (key.length < 2) return null;
    const hits = this.byCode.get(key) || [];
    if (!hits.length) return null;
    const exact = hits.filter((entity) => entity.code.trim().toLowerCase() === code.trim().toLowerCase());
    const pool = exact.length ? exact : hits;
    if (pool.length > 1) {
      return {
        kind: 'ambiguous',
        via: 'code',
        entities: pool,
        message: `${code} matches ${pool.length} entity codes.`,
      };
    }
    const entity = pool[0];
    if (!entity.active) return { kind: 'rejected', message: `${code} matches inactive ${entity.code}` };
    if (entity.domainCode !== this.domainCode) {
      return { kind: 'rejected', message: `${code} already exists as ${entity.domainCode}, not ${this.domainCode}` };
    }
    // A previous load stored the name in the code column. Prefer the entity that already had its own code.
    if (sameLabel(entity.code, entity.name)) {
      const named = this.collectNames({ code: entity.name, name: entity.name, attributes: new Map() });
      const preferred = soleCodedEntity(named);
      if (preferred) return { kind: 'match', entity: preferred, via: 'name' };
    }
    return { kind: 'match', entity, via: 'code' };
  }

  private collectIdentifiers(code: string, values: Map<string, string[]>, asOf?: string, datedOnly = false): MatchEntity[] {
    const found: MatchEntity[] = [];
    const add = (entities: readonly MatchEntity[] | undefined) => {
      for (const entity of entities || []) {
        if (this.matchable(entity) && !found.some((item) => item.id === entity.id)) found.push(entity);
      }
    };
    const holdersFor = (attributeCode: string, value: string) => (this.byIdentifier.get(`${attributeCode}|${value}`) || [])
      .filter((entity) => this.matchable(entity) && this.identifierActive(entity, attributeCode, value, asOf, datedOnly));
    const codeKey = compactIdentifier(code);
    for (const attributeCode of this.catalog.singles) {
      for (const value of compactValues(values.get(attributeCode) || [])) {
        const holders = holdersFor(attributeCode, value);
        if (holders.length) add(holders);
        if (!datedOnly && holders.length === 0 && (!asOf || !this.hasTerm(attributeCode, value))) {
          add((this.byCode.get(value) || []).filter((entity) => this.matchable(entity)));
        }
      }
      if (codeKey.length >= 2) add(holdersFor(attributeCode, codeKey));
    }
    this.catalog.composites.forEach((composite, index) => {
      for (const key of compositeKeys(values, composite)) {
        const parts = key.split('|');
        add((this.byComposite.get(`${index}|${key}`) || []).filter((entity) => (
          this.matchable(entity)
          && composite.every((attributeCode, partIndex) => this.identifierActive(entity, attributeCode, parts[partIndex], asOf, datedOnly))
        )));
      }
    });
    return found;
  }

  private collectNames(incoming: IncomingEntity): MatchEntity[] {
    const found: MatchEntity[] = [];
    const add = (entities: readonly MatchEntity[] | undefined) => {
      for (const entity of entities || []) {
        if (this.matchable(entity) && !found.some((item) => item.id === entity.id)) found.push(entity);
      }
    };
    const name = nameKey(incoming.name);
    const code = nameKey(incoming.code);
    if (name) {
      add(this.byName.get(name));
      add(this.byCodeName.get(name));
    }
    if (code && code !== name) add(this.byName.get(code));
    for (const alias of incoming.aliases || []) {
      const key = nameKey(alias);
      if (key && key !== name) add(this.byName.get(key));
    }
    return found;
  }

  private choose(entities: MatchEntity[], via: 'identifier' | 'name', code: string): ResolveHit | null {
    if (entities.length === 1) return { kind: 'match', entity: entities[0], via };
    const preferred = soleCodedEntity(entities);
    if (preferred) return { kind: 'match', entity: preferred, via };
    const labels = entities.slice(0, 5).map((entity) => entity.code).join(', ');
    return {
      kind: 'ambiguous',
      via,
      entities,
      message: `${code} matches ${entities.length} ${this.domainCode} records (${labels}).`,
    };
  }
}
