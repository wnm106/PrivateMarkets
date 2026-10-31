import { compactIdentifier, normalizeName } from '../../../graphql/src/lib/entity-resolution/similarity';

/**
 * Match a file row to an existing entity before inserting another one.
 * A row matches an entity in the same domain when any of these agree:
 * the entity code, the entity name, a single-attribute identifier, or a
 * full composite identifier. Codes and identifier values ignore punctuation.
 * Names ignore case, punctuation, and legal suffixes.
 */

export interface IdentifierCatalog {
  singles: string[];
  composites: string[][];
}

export interface MatchEntity {
  id: string;
  code: string;
  name: string;
  domainCode: string;
  clientId: string | null;
  active: boolean;
  provisional: boolean;
  identifiers: Map<string, string[]>;
}

export interface IncomingEntity {
  code: string;
  name: string;
  attributes: Map<string, string>;
}

export type ResolveHit =
  | { kind: 'match'; entity: MatchEntity; via: 'code' | 'identifier' | 'name' }
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
    if (this.byId.has(entity.id)) return;
    this.byId.set(entity.id, entity);
    this.indexCode(entity, entity.code);
    this.indexName(entity, entity.name);
    this.indexIdentifiers(entity, entity.identifiers);
  }

  absorb(id: string, incoming: IncomingEntity): void {
    const entity = this.byId.get(id);
    if (!entity) return;
    this.indexCode(entity, incoming.code);
    this.indexName(entity, incoming.name);
    const incomingValues = attributeValues(incoming.attributes);
    for (const [code, rawValues] of incomingValues) {
      if (!this.tracks(code)) continue;
      const list = entity.identifiers.get(code) || [];
      list.push(...rawValues);
      entity.identifiers.set(code, list);
    }
    this.indexIdentifiers(entity, incomingValues);
  }

  resolve(incoming: IncomingEntity): ResolveHit {
    const codeHit = this.resolveCode(incoming.code);
    if (codeHit) return codeHit;

    const values = attributeValues(incoming.attributes);
    const identified = this.collectIdentifiers(incoming.code, values);
    if (identified.length) {
      const chosen = this.choose(identified, 'identifier', incoming.code);
      if (chosen) return chosen;
    }

    const named = this.collectNames(incoming);
    if (!named.length) return { kind: 'none' };
    return this.choose(named, 'name', incoming.code) || { kind: 'none' };
  }

  private tracks(code: string): boolean {
    if (this.catalog.singles.includes(code)) return true;
    return this.catalog.composites.some((composite) => composite.includes(code));
  }

  private matchable(entity: MatchEntity): boolean {
    return entity.active
      && entity.domainCode === this.domainCode
      && (!entity.clientId || entity.clientId === this.clientId);
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
        kind: 'rejected',
        message: `${code} matches more than one entity code. Merge those records before loading.`,
      };
    }
    const entity = pool[0];
    if (!entity.active) return { kind: 'rejected', message: `${code} matches inactive ${entity.code}` };
    if (entity.domainCode !== this.domainCode) {
      return { kind: 'rejected', message: `${code} already exists as ${entity.domainCode}, not ${this.domainCode}` };
    }
    if (entity.clientId && entity.clientId !== this.clientId) {
      return { kind: 'rejected', message: `${code} already belongs to another client` };
    }
    // A previous load stored the name in the code column. Prefer the entity that already had its own code.
    if (sameLabel(entity.code, entity.name)) {
      const named = this.collectNames({ code: entity.name, name: entity.name, attributes: new Map() });
      const preferred = soleCodedEntity(named);
      if (preferred) return { kind: 'match', entity: preferred, via: 'name' };
    }
    return { kind: 'match', entity, via: 'code' };
  }

  private collectIdentifiers(code: string, values: Map<string, string[]>): MatchEntity[] {
    const found: MatchEntity[] = [];
    const add = (entities: readonly MatchEntity[] | undefined) => {
      for (const entity of entities || []) {
        if (this.matchable(entity) && !found.some((item) => item.id === entity.id)) found.push(entity);
      }
    };
    const codeKey = compactIdentifier(code);
    for (const attributeCode of this.catalog.singles) {
      for (const value of compactValues(values.get(attributeCode) || [])) {
        add(this.byIdentifier.get(`${attributeCode}|${value}`));
        add((this.byCode.get(value) || []).filter((entity) => this.matchable(entity)));
      }
      if (codeKey.length >= 2) add(this.byIdentifier.get(`${attributeCode}|${codeKey}`));
    }
    this.catalog.composites.forEach((composite, index) => {
      for (const key of compositeKeys(values, composite)) add(this.byComposite.get(`${index}|${key}`));
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
    return found;
  }

  private choose(entities: MatchEntity[], via: 'identifier' | 'name', code: string): ResolveHit | null {
    if (entities.length === 1) return { kind: 'match', entity: entities[0], via };
    const preferred = soleCodedEntity(entities);
    if (preferred) return { kind: 'match', entity: preferred, via };
    const labels = entities.slice(0, 5).map((entity) => entity.code).join(', ');
    return {
      kind: 'rejected',
      message: `${code} matches ${entities.length} ${this.domainCode} records (${labels}). Merge them before loading this file.`,
    };
  }
}
