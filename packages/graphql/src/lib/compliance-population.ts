/**
 * Match a compliance condition population in memory.
 *
 * A condition may name an attribute on the entity being tested, or on an entity
 * reached by a relationship path (security, issuer, cash flow, …). A path matches
 * when ANY related entity satisfies the operator. No related entity is treated as
 * a null value, so is_null matches and equals does not.
 */

export interface RelationshipHopRef {
  relationshipCode: string;
  direction: string;
  recursive?: boolean;
}

export interface PopulationCondition {
  conditionGroup?: number | null;
  conditionOrder?: number | null;
  attributeCode: string;
  operator: string;
  value?: string | null;
  compareAttributeCode?: string | null;
  attributePath?: RelationshipHopRef[] | null;
  comparePath?: RelationshipHopRef[] | null;
  logicOperator?: string | null;
}

export function hopKey(hop: RelationshipHopRef): string {
  return `${(hop.direction || 'UP').toUpperCase()}:${hop.relationshipCode}`;
}

export function pathKey(path?: RelationshipHopRef[] | null): string {
  return (path || []).filter((h) => h?.relationshipCode).map(hopKey).join('|');
}

/** Stable key for a condition's attribute, shared by the preview payload and the form. */
export function conditionValueKey(path: RelationshipHopRef[] | null | undefined, attributeCode: string): string {
  const prefix = pathKey(path);
  return prefix ? `${prefix}\u001f${attributeCode}` : attributeCode;
}

export function textOfAttribute(attributes: any, code: string): string | null {
  const entry = attributes?.[code];
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.value;
  if (value == null || value === '') return null;
  return String(value);
}

function listValues(raw: string | null): string[] {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      /* fall through to comma-separated */
    }
  }
  return trimmed.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

import { parseComparisonExpression, resolveComparisonExpression } from './expression-library';

function compareOrdered(actual: string, expected: string, operator: 'gt' | 'gte' | 'lt' | 'lte') {
  const date = /^\d{4}-\d{2}-\d{2}/;
  if (date.test(actual) && date.test(expected)) {
    const left = actual.slice(0, 10);
    const right = expected.slice(0, 10);
    if (operator === 'gt') return left > right;
    if (operator === 'gte') return left >= right;
    if (operator === 'lt') return left < right;
    return left <= right;
  }
  const left = Number(actual);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  return left <= right;
}

export function evaluateOperator(actual: string | null, operator: string, expected: string | null): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'is_null':
      return actual == null || actual === '';
    case 'is_not_null':
      return actual != null && actual !== '';
    case 'in':
      return actual != null && listValues(expected).includes(actual);
    case 'not_in':
      return actual == null || !listValues(expected).includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (actual == null || expected == null) return false;
      return compareOrdered(actual, expected, operator);
    }
    default:
      return false;
  }
}

export interface PopulationMatch {
  match: boolean;
  values: Record<string, string | null>;
}

/**
 * @param resolveTargets entity ids reached by walking `path` from `startId`.
 *        Empty path is not passed; the caller is the start entity itself.
 */
export function matchPopulationEntity(
  entityId: string,
  conditions: PopulationCondition[],
  resolveTargets: (startId: string, path: RelationshipHopRef[]) => string[],
  readValue: (entityId: string, attributeCode: string) => string | null,
  asOf?: string,
): PopulationMatch {
  const active = conditions.filter((c) => c.attributeCode);
  const values: Record<string, string | null> = {};
  if (active.length === 0) return { match: true, values };

  const groups = new Map<number, PopulationCondition[]>();
  for (const cond of active) {
    const group = cond.conditionGroup ?? 1;
    const list = groups.get(group) || [];
    list.push(cond);
    groups.set(group, list);
  }

  let anyGroup = false;
  for (const groupConds of groups.values()) {
    const ordered = [...groupConds].sort((a, b) => (a.conditionOrder ?? 0) - (b.conditionOrder ?? 0));
    let groupMatch: boolean | null = null;
    for (const cond of ordered) {
      const result = conditionMatches(entityId, cond, resolveTargets, readValue, values, asOf);
      if (groupMatch == null) groupMatch = result;
      else if ((cond.logicOperator || 'AND').toUpperCase() === 'OR') groupMatch = groupMatch || result;
      else groupMatch = groupMatch && result;
    }
    if (groupMatch) anyGroup = true;
  }
  return { match: anyGroup, values };
}

function subjects(
  entityId: string,
  path: RelationshipHopRef[] | null | undefined,
  resolveTargets: (startId: string, path: RelationshipHopRef[]) => string[],
): Array<string | null> {
  const hops = (path || []).filter((h) => h?.relationshipCode);
  if (hops.length === 0) return [entityId];
  const ids = resolveTargets(entityId, hops);
  return ids.length ? ids : [null];
}

function conditionMatches(
  entityId: string,
  cond: PopulationCondition,
  resolveTargets: (startId: string, path: RelationshipHopRef[]) => string[],
  readValue: (entityId: string, attributeCode: string) => string | null,
  values: Record<string, string | null>,
  asOf?: string,
): boolean {
  const read = (id: string | null, code: string) => (id ? readValue(id, code) : null);
  const attributeSubjects = subjects(entityId, cond.attributePath, resolveTargets);
  const sameCompareTarget = !cond.comparePath?.length || pathKey(cond.comparePath) === pathKey(cond.attributePath);
  const matched: string[] = [];
  let ok = false;

  for (const subject of attributeSubjects) {
    const actual = read(subject, cond.attributeCode);
    const expression = (cond.value || '').trim();
    const parsed = parseComparisonExpression(expression);
    if (parsed.kind === 'call') {
      const expected = resolveComparisonExpression(expression, (code) => read(subject, code), asOf || new Date().toISOString().slice(0, 10));
      if (evaluateOperator(actual, cond.operator, expected)) {
        ok = true;
        if (actual != null) matched.push(actual);
      }
      continue;
    }
    if (!cond.compareAttributeCode) {
      if (evaluateOperator(actual, cond.operator, cond.value ?? null)) {
        ok = true;
        if (actual != null) matched.push(actual);
      }
      continue;
    }
    if (sameCompareTarget) {
      const expected = read(subject, cond.compareAttributeCode);
      if (evaluateOperator(actual, cond.operator, expected)) {
        ok = true;
        if (actual != null) matched.push(actual);
      }
      continue;
    }
    const compareSubjects = subjects(entityId, cond.comparePath, resolveTargets);
    for (const other of compareSubjects) {
      const expected = read(other, cond.compareAttributeCode);
      if (evaluateOperator(actual, cond.operator, expected)) {
        ok = true;
        if (actual != null) matched.push(actual);
      }
    }
  }

  const key = conditionValueKey(cond.attributePath, cond.attributeCode);
  if (matched.length) values[key] = [...new Set(matched)].join(', ');
  else values[key] = read(attributeSubjects[0], cond.attributeCode);
  return ok;
}

/**
 * Walk hop maps (from-id -> to-ids) along a path. Recursive hops repeat up to 8 times.
 * If the declared direction finds nobody, the opposite direction is used. Relationship
 * type metadata and the stored parent/child rows do not always agree (security → issuer
 * is stored with the issuer as the parent).
 */
export function targetsAlongPath(
  startId: string,
  path: RelationshipHopRef[],
  hopMaps: Map<string, Map<string, string[]>>,
): string[] {
  let current = [startId];
  for (const hop of path) {
    const next = hopTargets(current, hop, hopMaps);
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function hopTargets(
  current: string[],
  hop: RelationshipHopRef,
  hopMaps: Map<string, Map<string, string[]>>,
): string[] {
  const direct = expandHop(current, hopMaps.get(hopKey(hop)), !!hop.recursive);
  if (direct.length) return direct;
  const flipped: RelationshipHopRef = {
    ...hop,
    direction: (hop.direction || 'UP').toUpperCase() === 'UP' ? 'DOWN' : 'UP',
  };
  return expandHop(current, hopMaps.get(hopKey(flipped)), !!hop.recursive);
}

function expandHop(current: string[], map: Map<string, string[]> | undefined, recursive: boolean): string[] {
  if (!map) return [];
  const next = oneHop(current, map);
  if (!recursive) return next;
  const seen = new Set(next);
  let frontier = next;
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    frontier = oneHop(frontier, map).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return [...seen];
}

function oneHop(ids: string[], map: Map<string, string[]>): string[] {
  const next = new Set<string>();
  for (const id of ids) {
    for (const target of map.get(id) || []) next.add(target);
  }
  return [...next];
}
