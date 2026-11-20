import { phrasesEqual, type DomainAlias, type EntityNameAlias } from '@tapestrai/graphql/src/lib/semantic-aliases';
import { POSITION_FILE_MAP } from './position-file-map';
import type { ColumnTransform, FeedMap, TransformKind } from './types';
import { applyTransform, isBlankToken, numberText, parseUsDate } from './values';

export type AssignmentRole = 'ignore' | 'filter' | 'as_of' | 'source' | 'identity' | 'name' | 'alias' | 'attribute' | 'parent';

export interface ColumnHint {
  sourceColumn: string;
  role: AssignmentRole;
  domainCode: string | null;
  attributeCode: string | null;
  parentDomainCode: string | null;
  confidence: number;
  reason: string;
}
export type SuggestionMethod = 'source_map' | 'name' | 'sample' | 'ai' | 'manual';

export interface AttributeChoice {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string | null;
  referenceListCode: string | null;
  /** Other words for this field, such as "Ending NAV" for NAV. */
  aliasLabels?: string[];
}

export interface MappingAliases {
  domains: DomainAlias[];
  names: EntityNameAlias[];
}

export interface DistinctValue {
  value: string;
  count: number;
}

export interface ListChoice {
  code: string;
  label: string;
  synonyms?: string[] | null;
}

export interface ColumnAssignment {
  sourceColumn: string;
  samples: string[];
  distinctCount?: number;
  distinctValues?: DistinctValue[];
  role: AssignmentRole;
  domainCode: string | null;
  attributeCode: string | null;
  parentDomainCode: string | null;
  /** Parent codes are resolved from entities already stored, not loaded from this file. */
  parentExisting?: boolean;
  filterEquals: string | null;
  transform: ColumnTransform;
  suggestion: {
    method: SuggestionMethod;
    confidence: number;
    reason: string;
  };
}

export interface MappingTarget {
  key: string;
  group: string;
  label: string;
  role: AssignmentRole;
  domainCode: string | null;
  attributeCode: string | null;
  parentDomainCode: string | null;
  dataType: string | null;
  referenceListCode: string | null;
}

const LOAD_DOMAINS = ['ISSUER', 'FUND', 'SECURITY', 'POSITION', 'DEAL', 'CASH_FLOW'];

export const DOMAIN_LABELS: Record<string, string> = {
  ISSUER: 'Issuer',
  FUND: 'Fund',
  SECURITY: 'Security',
  POSITION: 'Position',
  DEAL: 'Deal',
  CASH_FLOW: 'Cash flow',
};

const DOMAIN_PREFIX: Record<string, string> = {
  sec: 'SECURITY',
  security: 'SECURITY',
  iss: 'ISSUER',
  issuer: 'ISSUER',
  fund: 'FUND',
  pos: 'POSITION',
  position: 'POSITION',
  deal: 'DEAL',
};

export function domainLabel(code: string | null | undefined): string {
  if (!code) return 'File';
  const plain = code.replace(/_/g, ' ').toLowerCase();
  return DOMAIN_LABELS[code] || plain.charAt(0).toUpperCase() + plain.slice(1);
}

const TEMPLATE_BY_DOMAIN: Record<string, string> = {
  ISSUER: 'ISSUER_STANDARD',
  FUND: 'FUND_STANDARD',
  SECURITY: 'SECURITY_STANDARD',
  POSITION: 'POSITION_STANDARD',
  DEAL: 'DEAL_STANDARD',
  CASH_FLOW: 'STANDARD_CASHFLOW',
};

/** Child domains that reuse another domain's identity column as their parent key. */
const IDENTITY_LINKS = [
  { child: 'SECURITY', parent: 'ISSUER' },
  { child: 'POSITION', parent: 'FUND' },
  { child: 'POSITION', parent: 'SECURITY' },
];

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !['the', 'of', 'a', 'an'].includes(token));
}

/** Up to `limit` non-empty values of a column, for judging what kind of data it holds. */
function valuesFor(rows: Record<string, string>[], column: string, limit = 30): string[] {
  const values: string[] = [];
  for (const row of rows) {
    const value = (row[column] || '').trim();
    if (!value || isBlankToken(value)) continue;
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

const NUMERIC_TYPES = new Set(['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE']);

/**
 * How well a column's values fit a field's data type, from 0 to 1. A column of loan
 * names does not fit a money amount however alike the two names are.
 */
export function sampleFit(values: string[], dataType?: string | null): number {
  if (values.length === 0 || !dataType) return 1;
  const share = (test: (value: string) => boolean) => values.filter(test).length / values.length;
  if (NUMERIC_TYPES.has(dataType)) return share((value) => numberText(value.replace(/%$/, '')) !== null);
  if (dataType === 'DATE') return share((value) => parseUsDate(value) !== null);
  if (dataType === 'BOOLEAN') return share((value) => /^(true|false|yes|no|y|n|0|1)$/i.test(value));
  return 1;
}

/** Below this, a field is not offered for the column at all. Below the next, it needs the user's decision. */
const FIT_REJECT = 0.5;
const FIT_CONFIRM = 0.9;
/** The most a suggestion can claim when it needs a person to look at it. Under the confirmation threshold. */
const NEEDS_LOOK = 0.7;

function samplesFor(rows: Record<string, string>[], column: string): string[] {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const row of rows) {
    const value = (row[column] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    samples.push(value);
    if (samples.length === 3) break;
  }
  return samples;
}

function distinctFor(rows: Record<string, string>[], column: string): { count: number; values: DistinctValue[] } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = (row[column] || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([value, count]) => ({ value, count }));
  return { count: counts.size, values };
}

function withDistinct(assignment: ColumnAssignment, rows: Record<string, string>[]): ColumnAssignment {
  const distinct = distinctFor(rows, assignment.sourceColumn);
  return { ...assignment, distinctCount: distinct.count, distinctValues: distinct.values };
}

function mostCommon(rows: Record<string, string>[], column: string): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = (row[column] || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function suggestTransform(samples: string[], dataType?: string | null, referenceListCode?: string | null): ColumnTransform {
  if (referenceListCode) return { kind: 'list' };
  if (dataType === 'DATE' || samples.some((sample) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(sample))) return { kind: 'date' };
  if (dataType === 'PERCENTAGE' || samples.some((sample) => sample.trim().endsWith('%'))) return { kind: 'percent' };
  if (
    ['NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY'].includes(dataType || '') ||
    samples.some((sample) => /,/.test(sample) && /\d/.test(sample))
  ) {
    return { kind: 'number' };
  }
  return { kind: 'trim' };
}

function knownAssignment(column: string, rows: Record<string, string>[]): ColumnAssignment | null {
  const samples = samplesFor(rows, column);
  if (POSITION_FILE_MAP.rowFilter?.column === column) {
    return {
      sourceColumn: column,
      samples,
      role: 'filter',
      domainCode: null,
      attributeCode: null,
      parentDomainCode: null,
      filterEquals: mostCommon(rows, column) || POSITION_FILE_MAP.rowFilter.equals,
      transform: { kind: 'trim' },
      suggestion: { method: 'source_map', confidence: 0.99, reason: 'Position File map keeps these rows' },
    };
  }
  if (POSITION_FILE_MAP.asOfHintColumn === column) {
    return {
      sourceColumn: column,
      samples,
      role: 'as_of',
      domainCode: null,
      attributeCode: null,
      parentDomainCode: null,
      filterEquals: null,
      transform: { kind: 'date' },
      suggestion: { method: 'source_map', confidence: 0.99, reason: 'Position File map uses this column as the as-of date' },
    };
  }
  for (const domain of POSITION_FILE_MAP.domains) {
    if (domain.identityColumn === column) {
      return base(column, samples, 'identity', domain.domainCode, null, null, { kind: 'trim' }, `Position File map identifies ${domain.domainCode}`);
    }
    if (domain.nameColumn === column && domain.nameColumn !== domain.identityColumn) {
      return base(column, samples, 'name', domain.domainCode, null, null, { kind: 'trim' }, `Position File map names ${domain.domainCode}`);
    }
    const attribute = domain.attributes.find((item) => item.column === column);
    if (attribute) {
      return base(
        column,
        samples,
        'attribute',
        domain.domainCode,
        attribute.attributeCode,
        null,
        { kind: 'trim' },
        `Position File map assigns this column to ${attribute.attributeCode}`
      );
    }
  }
  return null;
}

function base(
  column: string,
  samples: string[],
  role: AssignmentRole,
  domainCode: string | null,
  attributeCode: string | null,
  parentDomainCode: string | null,
  transform: ColumnTransform,
  reason: string
): ColumnAssignment {
  return {
    sourceColumn: column,
    samples,
    role,
    domainCode,
    attributeCode,
    parentDomainCode,
    filterEquals: null,
    transform,
    suggestion: { method: 'source_map', confidence: 0.97, reason },
  };
}

function scoreAttribute(header: string, attribute: AttributeChoice, domainCode: string, ignoreTokens: ReadonlySet<string> = new Set()): number {
  if ((attribute.aliasLabels || []).some((label) => phrasesEqual(header, label))) return 0.96;
  const rawTokens = tokens(header);
  const stripped = rawTokens.filter((token) => !ignoreTokens.has(token));
  const headerTokens = new Set(stripped.length > 0 ? stripped : rawTokens);
  const nameTokens = new Set(tokens(attribute.attributeName));
  const codeTokens = new Set(tokens(attribute.attributeCode.replace(/_/g, ' ')));
  for (const label of attribute.aliasLabels || []) {
    for (const token of tokens(label)) nameTokens.add(token);
  }
  const compare = nameTokens.size > 0 ? nameTokens : codeTokens;
  let overlap = 0;
  for (const token of headerTokens) {
    if (compare.has(token)) overlap += 1;
  }
  if (overlap === 0) {
    for (const token of headerTokens) {
      if (codeTokens.has(token)) overlap += 1;
    }
    if (overlap === 0) return 0;
  }
  const coverage = overlap / Math.max(headerTokens.size, 1);
  const precision = overlap / Math.max(compare.size, 1);
  const exact = coverage === 1 && precision === 1;
  const domainBonus = headerTokens.has(domainCode.toLowerCase()) ? 0.15 : 0;
  return Math.min(0.99, coverage * 0.55 + precision * 0.35 + (exact ? 0.2 : 0) + domainBonus);
}

function splitHeader(column: string): { domain: string | null; field: string } {
  const dotted = column.replace(/[·•]/g, '.').replace(/[_/]/g, ' ');
  const parts = dotted.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const prefix = tokens(parts[0])[0];
    return { domain: DOMAIN_PREFIX[prefix] || null, field: parts.slice(1).join(' ') };
  }
  const words = tokens(column);
  if (words.length >= 2 && DOMAIN_PREFIX[words[0]]) {
    return { domain: DOMAIN_PREFIX[words[0]], field: words.slice(1).join(' ') };
  }
  return { domain: null, field: column };
}

/**
 * A column named for a record type, holding names that mostly differ from row to row,
 * identifies those records. "Issuer" with Acme, Beta, Gamma is the issuer, not a field of it.
 * This runs before any field is matched, so the other columns can be placed on these records.
 */
function detectHeaderIdentities(
  headers: string[],
  rows: Record<string, string>[],
  domainCodes: Set<string>,
  domainAliases: readonly DomainAlias[] = [],
): Map<string, string> {
  const found = new Map<string, string>();
  const taken = new Set<string>();
  for (const column of headers.filter(Boolean)) {
    const words = tokens(column);
    if (words.length === 0 || words.some((word) => ['name', 'id', 'code', 'number', 'no'].includes(word))) continue;
    const values = valuesFor(rows, column);
    if (values.length === 0) continue;
    if (sampleFit(values, 'NUMBER') >= 0.5 || sampleFit(values, 'DATE') >= 0.5) continue;
    if (new Set(values).size / values.length < 0.5) continue;
    const matches = [...domainCodes].filter((code) => {
      const parts = tokens(code.replace(/_/g, ' '));
      return words.every((word) => parts.includes(word)) && parts[parts.length - 1] === words[words.length - 1];
    });
    const exact = matches.filter((code) => tokens(code.replace(/_/g, ' ')).join(' ') === words.join(' '));
    let domain = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
    if (!domain) {
      const aliasHits = domainAliases.filter((alias) => domainCodes.has(alias.domainCode) && (phrasesEqual(column, alias.aliasLabel) || phrasesEqual(column, alias.aliasCode)));
      const codes = [...new Set(aliasHits.map((alias) => alias.domainCode))];
      domain = codes.length === 1 ? codes[0] : null;
    }
    if (!domain || taken.has(domain)) continue;
    taken.add(domain);
    found.set(column, domain);
  }
  return found;
}

function parentsOf(domainCode: string): string[] {
  return IDENTITY_LINKS.filter((link) => link.child === domainCode).map((link) => link.parent);
}

function structural(
  column: string,
  samples: string[],
  role: AssignmentRole,
  domainCode: string,
  reason: string,
  confidence: number
): ColumnAssignment {
  return {
    sourceColumn: column,
    samples,
    role,
    domainCode,
    attributeCode: null,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'trim' },
    suggestion: { method: 'name', confidence, reason },
  };
}

function qualifiedAssignment(
  column: string,
  rows: Record<string, string>[],
  attributes: AttributeChoice[],
  usedAttributes: Set<string>
): ColumnAssignment | null {
  const split = splitHeader(column);
  if (!split.domain) return null;
  const samples = samplesFor(rows, column);
  const fieldTokens = tokens(split.field);
  const label = domainLabel(split.domain);
  if (fieldTokens.length === 1 && ['name', 'description'].includes(fieldTokens[0])) {
    return structural(column, samples, 'name', split.domain, `${column} is the ${label.toLowerCase()} name.`, 0.92);
  }
  if (fieldTokens.length === 1 && ['code', 'id', 'identifier', 'key'].includes(fieldTokens[0])) {
    return structural(column, samples, 'identity', split.domain, `${column} is the ${label.toLowerCase()} code.`, 0.94);
  }

  let best: { score: number; domainCode: string; attribute: AttributeChoice; hopped: boolean } | null = null;
  for (const domainCode of [split.domain, ...parentsOf(split.domain)]) {
    for (const attribute of attributes) {
      if (attribute.domainCode && attribute.domainCode !== domainCode) continue;
      const key = `${domainCode}:${attribute.attributeCode}`;
      if (usedAttributes.has(key)) continue;
      const fit = sampleFit(valuesFor(rows, column), attribute.dataType);
      if (fit < FIT_REJECT) continue;
      const score = fit < FIT_CONFIRM ? Math.min(scoreAttribute(split.field, attribute, domainCode), NEEDS_LOOK) : scoreAttribute(split.field, attribute, domainCode);
      if (!best || score > best.score) best = { score, domainCode, attribute, hopped: domainCode !== split.domain };
    }
  }
  if (!best || best.score < 0.45) return null;
  usedAttributes.add(`${best.domainCode}:${best.attribute.attributeCode}`);
  const where = domainLabel(best.domainCode);
  const reason = best.hopped
    ? `${column} matches ${best.attribute.attributeName}. That field is stored on the ${where.toLowerCase()}, which is linked from the ${label.toLowerCase()}.`
    : `${column} matches ${best.attribute.attributeName} on the ${where.toLowerCase()}.`;
  return {
    sourceColumn: column,
    samples,
    role: 'attribute',
    domainCode: best.domainCode,
    attributeCode: best.attribute.attributeCode,
    parentDomainCode: null,
    filterEquals: null,
    transform: suggestTransform(samples, best.attribute.dataType, best.attribute.referenceListCode),
    suggestion: { method: 'name', confidence: best.hopped ? 0.74 : Number(Math.min(best.score, 0.93).toFixed(2)), reason },
  };
}

function bareAssignment(column: string, rows: Record<string, string>[]): ColumnAssignment | null {
  const words = tokens(column);
  if (words.length !== 1) return null;
  const samples = samplesFor(rows, column);
  if (words[0] === 'code' || words[0] === 'id') {
    return structural(column, samples, 'identity', 'POSITION', 'Code identifies each position in this file.', 0.9);
  }
  if (words[0] === 'name') {
    return structural(column, samples, 'name', 'POSITION', 'Name is the position name on each row.', 0.88);
  }
  return null;
}

function assignmentFromHint(
  column: string,
  rows: Record<string, string>[],
  hint: ColumnHint,
  attributes: AttributeChoice[],
): ColumnAssignment {
  const samples = samplesFor(rows, column);
  const attribute = hint.attributeCode
    ? attributes.find((item) => item.attributeCode === hint.attributeCode && item.domainCode === hint.domainCode)
      || attributes.find((item) => item.attributeCode === hint.attributeCode)
    : undefined;
  const domainCode = hint.role === 'as_of' || hint.role === 'source' || hint.role === 'filter' || hint.role === 'ignore'
    ? null
    : hint.domainCode || attribute?.domainCode || null;
  return {
    sourceColumn: column,
    samples,
    role: hint.role,
    domainCode,
    attributeCode: hint.role === 'attribute' ? hint.attributeCode : null,
    parentDomainCode: hint.role === 'parent' ? hint.parentDomainCode : null,
    filterEquals: hint.role === 'filter' ? mostCommon(rows, column) || null : null,
    transform: hint.role === 'as_of'
      ? { kind: 'date' }
      : hint.role === 'source'
        ? { kind: 'uppercase' }
        : hint.role === 'attribute'
          ? suggestTransform(samples, attribute?.dataType, attribute?.referenceListCode)
          : { kind: 'trim' },
    suggestion: {
      method: 'name',
      confidence: hint.confidence,
      reason: hint.reason,
    },
  };
}

export function suggestAssignments(
  headers: string[],
  rows: Record<string, string>[],
  attributes: AttributeChoice[],
  hints: ColumnHint[] = [],
  aliases: MappingAliases = { domains: [], names: [] },
): ColumnAssignment[] {
  const hintByColumn = new Map(hints.map((hint) => [hint.sourceColumn, hint]));
  const usedAttributes = new Set<string>();
  const domainCodes = new Set(attributes.map((attribute) => attribute.domainCode).filter((code): code is string => Boolean(code)));
  const headerIdentities = detectHeaderIdentities(
    headers.filter((column) => !hintByColumn.has(column) && !knownAssignment(column, rows)),
    rows,
    domainCodes,
    aliases.domains,
  );
  const identified = new Set<string>([...headerIdentities.values(), ...hints.filter((hint) => hint.role === 'identity' && hint.domainCode).map((hint) => hint.domainCode as string)]);
  const namedDomains = new Set<string>();
  const ignoreFor = (domainCode: string) => new Set([
    ...tokens(domainCode.replace(/_/g, ' ')),
    ...aliases.domains.filter((alias) => alias.domainCode === domainCode).flatMap((alias) => tokens(alias.aliasLabel)),
  ]);
  const assignments = headers.filter(Boolean).map((column) => {
    const known = knownAssignment(column, rows);
    if (known) {
      if (known.attributeCode && known.domainCode) usedAttributes.add(`${known.domainCode}:${known.attributeCode}`);
      if (known.role === 'attribute') {
        const attribute = attributes.find((item) => item.attributeCode === known.attributeCode);
        known.transform = suggestTransform(known.samples, attribute?.dataType, attribute?.referenceListCode);
      }
      return withDistinct(known, rows);
    }

    const hint = hintByColumn.get(column);
    if (hint) {
      const assignment = assignmentFromHint(column, rows, hint, attributes);
      if (assignment.attributeCode && assignment.domainCode) usedAttributes.add(`${assignment.domainCode}:${assignment.attributeCode}`);
      return withDistinct(assignment, rows);
    }

    const identityDomain = headerIdentities.get(column);
    if (identityDomain) {
      const label = domainLabel(identityDomain).toLowerCase();
      return withDistinct(structural(column, samplesFor(rows, column), 'identity', identityDomain, `${column} holds a different ${label} on most rows, so it identifies each ${label}.`, 0.9), rows);
    }

    const nameAlias = aliases.names.find((alias) => domainCodes.has(alias.domainCode) && (phrasesEqual(column, alias.aliasLabel) || phrasesEqual(column, alias.aliasCode)));
    if (nameAlias) {
      const role: AssignmentRole = namedDomains.has(nameAlias.domainCode) || identified.has(nameAlias.domainCode) ? 'alias' : 'name';
      if (role === 'name') namedDomains.add(nameAlias.domainCode);
      const reason = role === 'name'
        ? `${column} is the name of each ${domainLabel(nameAlias.domainCode).toLowerCase()}.`
        : `${column} is another name for the same ${domainLabel(nameAlias.domainCode).toLowerCase()}.`;
      return withDistinct({
        ...structural(column, samplesFor(rows, column), role, nameAlias.domainCode, reason, 0.93),
        attributeCode: role === 'alias' ? nameAlias.aliasCode : null,
      }, rows);
    }

    const qualified = qualifiedAssignment(column, rows, attributes, usedAttributes);
    if (qualified) return withDistinct(qualified, rows);

    const bare = bareAssignment(column, rows);
    if (bare) return withDistinct(bare, rows);

    const samples = samplesFor(rows, column);
    const values = valuesFor(rows, column);
    let best: { score: number; ranked: number; domainCode: string; attribute: AttributeChoice; fit: number } | null = null;
    for (const attribute of attributes) {
      const fit = sampleFit(values, attribute.dataType);
      if (fit < FIT_REJECT) continue;
      const domains = attribute.domainCode ? [attribute.domainCode] : LOAD_DOMAINS;
      for (const domainCode of domains) {
        const key = `${domainCode}:${attribute.attributeCode}`;
        if (usedAttributes.has(key)) continue;
        const score = scoreAttribute(column, attribute, domainCode, ignoreFor(domainCode));
        if (score < 0.45) continue;
        // A field on a record this file identifies wins over a slightly better name match on one it does not.
        const ranked = score + (identified.has(domainCode) ? 0.12 : 0);
        if (!best || ranked > best.ranked) best = { score, ranked, domainCode, attribute, fit };
      }
    }

    if (best) {
      usedAttributes.add(`${best.domainCode}:${best.attribute.attributeCode}`);
      const homeless = identified.size > 0 && !identified.has(best.domainCode);
      const notes: string[] = [];
      let confidence = Number(best.score.toFixed(2));
      if (best.fit < FIT_CONFIRM) {
        confidence = Math.min(confidence, NEEDS_LOOK);
        notes.push(`Only ${Math.round(best.fit * 100)}% of the values look like ${best.attribute.dataType === 'DATE' ? 'dates' : 'numbers'}.`);
      }
      if (homeless) {
        confidence = Math.min(confidence, NEEDS_LOOK);
        notes.push(`This file has no identity column for the ${domainLabel(best.domainCode).toLowerCase()}, so check where it belongs.`);
      }
      return withDistinct({
        sourceColumn: column,
        samples,
        role: 'attribute',
        domainCode: best.domainCode,
        attributeCode: best.attribute.attributeCode,
        parentDomainCode: null,
        filterEquals: null,
        transform: suggestTransform(samples, best.attribute.dataType, best.attribute.referenceListCode),
        suggestion: {
          method: 'name',
          confidence,
          reason: [`${column} matches ${best.attribute.attributeName} on the ${domainLabel(best.domainCode).toLowerCase()}.`, ...notes].join(' '),
        },
      }, rows);
    }

    const transform = suggestTransform(samples, null, null);
    return withDistinct({
      sourceColumn: column,
      samples,
      role: 'ignore',
      domainCode: null,
      attributeCode: null,
      parentDomainCode: null,
      filterEquals: null,
      transform,
      suggestion: {
        method: transform.kind === 'trim' || transform.kind === 'none' ? 'name' : 'sample',
        confidence: 0.2,
        reason: 'No confident match. Leave it out, or choose a field.',
      },
    }, rows);
  });

  return promoteNamesToIdentity(assignments);
}

/** A file with a name for a record type but no code uses the name to tell its records apart. */
export function promoteNamesToIdentity(assignments: ColumnAssignment[]): ColumnAssignment[] {
  const identityDomains = new Set(assignments.filter((assignment) => assignment.role === 'identity' && assignment.domainCode).map((assignment) => assignment.domainCode));
  return assignments.map((assignment) => {
    if (assignment.role !== 'name' || !assignment.domainCode || identityDomains.has(assignment.domainCode)) return assignment;
    identityDomains.add(assignment.domainCode);
    return {
      ...assignment,
      role: 'identity' as const,
      suggestion: {
        ...assignment.suggestion,
        reason: `${assignment.suggestion.reason} This file has no separate code, so the name is also the identifier.`,
      },
    };
  });
}

export function suggestListValues(
  distinct: { value: string }[],
  choices: ListChoice[]
): { from: string; to: string }[] {
  const index = new Map<string, string>();
  const put = (key: string, code: string) => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return;
    index.set(normalized, code);
  };
  for (const choice of choices) {
    for (const synonym of choice.synonyms || []) put(synonym, choice.code);
    put(choice.label, choice.code);
    put(choice.code, choice.code);
  }
  const mapped: { from: string; to: string }[] = [];
  for (const item of distinct) {
    const to = index.get(item.value.trim().toLowerCase());
    if (to) mapped.push({ from: item.value, to });
  }
  return mapped;
}

export function applyListSuggestions(
  assignments: ColumnAssignment[],
  attributes: AttributeChoice[],
  lists: { listCode: string; values: ListChoice[] }[]
): ColumnAssignment[] {
  return assignments.map((assignment) => {
    if (assignment.role !== 'attribute' || !assignment.attributeCode) return assignment;
    const attribute = attributes.find((item) => item.attributeCode === assignment.attributeCode && (!item.domainCode || item.domainCode === assignment.domainCode));
    if (!attribute?.referenceListCode) return assignment;
    const list = lists.find((item) => item.listCode === attribute.referenceListCode);
    if (!list) return assignment;
    return {
      ...assignment,
      transform: {
        ...assignment.transform,
        kind: 'list',
        values: suggestListValues(assignment.distinctValues || [], list.values),
      },
    };
  });
}

export function targetKey(assignment: Pick<ColumnAssignment, 'role' | 'domainCode' | 'attributeCode' | 'parentDomainCode'>): string {
  if (assignment.role === 'ignore') return 'ignore';
  if (assignment.role === 'as_of') return 'as_of';
  if (assignment.role === 'source') return 'source';
  if (assignment.role === 'filter') return 'filter';
  if (assignment.role === 'identity') return `identity:${assignment.domainCode}`;
  if (assignment.role === 'name') return `name:${assignment.domainCode}`;
  if (assignment.role === 'alias') return `alias:${assignment.domainCode}:${assignment.attributeCode}`;
  if (assignment.role === 'parent') return `parent:${assignment.domainCode}:${assignment.parentDomainCode}`;
  return `attribute:${assignment.domainCode}:${assignment.attributeCode}`;
}

export function mappingTargets(attributes: AttributeChoice[], domains: string[], aliases: MappingAliases = { domains: [], names: [] }): MappingTarget[] {
  const targets: MappingTarget[] = [
    { key: 'ignore', group: 'File', label: 'Do not load', role: 'ignore', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: null, referenceListCode: null },
    { key: 'as_of', group: 'File', label: 'As-of date', role: 'as_of', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: 'DATE', referenceListCode: null },
    { key: 'source', group: 'File', label: 'Source', role: 'source', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: 'STRING', referenceListCode: null },
    { key: 'filter', group: 'File', label: 'Row filter', role: 'filter', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: null, referenceListCode: null },
  ];
  const active = domains.length > 0 ? domains : LOAD_DOMAINS;
  const domainList = [...new Set([...LOAD_DOMAINS.filter((code) => active.includes(code)), ...active])];
  for (const domainCode of domainList) {
    const label = domainLabel(domainCode);
    targets.push({
      key: `identity:${domainCode}`,
      group: label,
      label: `${label} · Code`,
      role: 'identity',
      domainCode,
      attributeCode: null,
      parentDomainCode: null,
      dataType: 'STRING',
      referenceListCode: null,
    });
    targets.push({
      key: `name:${domainCode}`,
      group: label,
      label: `${label} · Name`,
      role: 'name',
      domainCode,
      attributeCode: null,
      parentDomainCode: null,
      dataType: 'STRING',
      referenceListCode: null,
    });
    for (const alias of aliases.names.filter((item) => item.domainCode === domainCode)) {
      targets.push({
        key: `alias:${domainCode}:${alias.aliasCode}`,
        group: label,
        label: `${label} · ${alias.aliasLabel}`,
        role: 'alias',
        domainCode,
        attributeCode: alias.aliasCode,
        parentDomainCode: null,
        dataType: 'STRING',
        referenceListCode: null,
      });
    }
  }
  for (const link of IDENTITY_LINKS) {
    targets.push({
      key: `parent:${link.child}:${link.parent}`,
      group: domainLabel(link.child),
      label: `${domainLabel(link.child)} · Parent ${domainLabel(link.parent).toLowerCase()}`,
      role: 'parent',
      domainCode: link.child,
      attributeCode: null,
      parentDomainCode: link.parent,
      dataType: 'STRING',
      referenceListCode: null,
    });
  }
  const sorted = [...attributes].sort((a, b) => a.attributeName.localeCompare(b.attributeName));
  for (const attribute of sorted) {
    const domainsForAttribute = attribute.domainCode ? [attribute.domainCode] : domainList;
    for (const domainCode of domainsForAttribute) {
      targets.push({
        key: `attribute:${domainCode}:${attribute.attributeCode}`,
        group: domainLabel(domainCode),
        label: `${domainLabel(domainCode)} · ${attribute.attributeName}`,
        role: 'attribute',
        domainCode,
        attributeCode: attribute.attributeCode,
        parentDomainCode: null,
        dataType: attribute.dataType,
        referenceListCode: attribute.referenceListCode,
      });
    }
  }
  return targets;
}

export function applyTarget(assignment: ColumnAssignment, target: MappingTarget): ColumnAssignment {
  return {
    ...assignment,
    role: target.role,
    domainCode: target.domainCode,
    attributeCode: target.attributeCode,
    parentDomainCode: target.parentDomainCode,
    filterEquals: target.role === 'filter' ? assignment.filterEquals || assignment.samples[0] || null : null,
    transform: suggestTransform(assignment.samples, target.dataType, target.referenceListCode),
    suggestion: { method: 'manual', confidence: 1, reason: 'You chose this field.' },
  };
}

export interface FeedMapIdentity {
  mapCode: string;
  sourceCode: string;
  name: string;
  description: string;
}

export interface OrphanColumn {
  column: string;
  domainCode: string;
}

/**
 * Columns pointed at a record type that has no identity column. Such a record
 * type is never created, so its columns would be dropped without a word.
 */
export function orphanColumns(assignments: ColumnAssignment[]): OrphanColumn[] {
  const identified = new Set(
    assignments.filter((assignment) => assignment.role === 'identity' && assignment.domainCode).map((assignment) => assignment.domainCode as string),
  );
  return assignments
    .filter((assignment) => (
      (assignment.role === 'attribute' || assignment.role === 'name' || assignment.role === 'alias' || assignment.role === 'parent')
      && assignment.domainCode
      && !identified.has(assignment.domainCode)
    ))
    .map((assignment) => ({ column: assignment.sourceColumn, domainCode: assignment.domainCode as string }));
}

export function describeOrphans(orphans: OrphanColumn[]): string {
  const byDomain = new Map<string, string[]>();
  for (const orphan of orphans) byDomain.set(orphan.domainCode, [...(byDomain.get(orphan.domainCode) || []), orphan.column]);
  return [...byDomain.entries()]
    .map(([domain, columns]) => `${columns.map((column) => `"${column}"`).join(', ')} ${columns.length === 1 ? 'belongs' : 'belong'} to ${domain}, which has no identity column`)
    .join('; ');
}

export function feedMapFromAssignments(
  assignments: ColumnAssignment[],
  identity: FeedMapIdentity = {
    mapCode: POSITION_FILE_MAP.mapCode,
    sourceCode: POSITION_FILE_MAP.sourceCode,
    name: POSITION_FILE_MAP.name,
    description: POSITION_FILE_MAP.description,
  }
): FeedMap {
  const domains = new Map<string, FeedMap['domains'][number]>();
  const transforms: Record<string, ColumnTransform> = {};
  let asOfHintColumn: string | undefined;
  let sourceHintColumn: string | undefined;
  let rowFilter: FeedMap['rowFilter'];

  const ensure = (domainCode: string) => {
    let domain = domains.get(domainCode);
    if (!domain) {
      domain = {
        domainCode,
        templateCode: TEMPLATE_BY_DOMAIN[domainCode] || `${domainCode}_STANDARD`,
        identityColumn: '',
        nameColumn: '',
        attributes: [],
        parents: [],
        aliasColumns: [],
      };
      domains.set(domainCode, domain);
    }
    return domain;
  };

  for (const assignment of assignments) {
    if (assignment.transform?.kind) transforms[assignment.sourceColumn] = assignment.transform;
    if (assignment.role === 'ignore') continue;
    if (assignment.role === 'as_of') asOfHintColumn = assignment.sourceColumn;
    if (assignment.role === 'source') sourceHintColumn = assignment.sourceColumn;
    if (assignment.role === 'filter') {
      rowFilter = { column: assignment.sourceColumn, equals: assignment.filterEquals || assignment.samples[0] || '' };
    }
    if (!assignment.domainCode) continue;
    const domain = ensure(assignment.domainCode);
    if (assignment.role === 'identity') {
      domain.identityColumn = assignment.sourceColumn;
      if (!domain.nameColumn) domain.nameColumn = assignment.sourceColumn;
    }
    if (assignment.role === 'name') domain.nameColumn = assignment.sourceColumn;
    if (assignment.role === 'alias' && assignment.attributeCode) {
      domain.aliasColumns = domain.aliasColumns || [];
      domain.aliasColumns.push({ column: assignment.sourceColumn, aliasCode: assignment.attributeCode });
    }
    if (assignment.role === 'attribute' && assignment.attributeCode) {
      domain.attributes.push({ column: assignment.sourceColumn, attributeCode: assignment.attributeCode });
    }
    if (assignment.role === 'parent' && assignment.parentDomainCode) {
      domain.parents.push({
        column: assignment.sourceColumn,
        parentDomainCode: assignment.parentDomainCode,
        existing: assignment.parentExisting || undefined,
      });
    }
  }

  for (const link of IDENTITY_LINKS) {
    const parent = domains.get(link.parent);
    const child = domains.get(link.child);
    if (!parent?.identityColumn || !child) continue;
    if (child.parents.some((parentLink) => parentLink.parentDomainCode === link.parent)) continue;
    child.parents.push({ column: parent.identityColumn, parentDomainCode: link.parent });
  }

  return {
    mapCode: identity.mapCode,
    sourceCode: identity.sourceCode,
    name: identity.name,
    description: identity.description,
    asOfHintColumn,
    sourceHintColumn,
    rowFilter,
    domains: [...domains.values()].filter((domain) => domain.identityColumn),
    transforms,
  };
}

export function previewTransform(sample: string, transform: ColumnTransform): string {
  return applyTransform(sample, transform);
}

export const TRANSFORM_OPTIONS: { kind: TransformKind; label: string }[] = [
  { kind: 'trim', label: 'Trim' },
  { kind: 'none', label: 'Keep source text' },
  { kind: 'number', label: 'Number (strip commas)' },
  { kind: 'percent', label: 'Percent (1% → 0.01)' },
  { kind: 'date', label: 'Date (M/D/YYYY)' },
  { kind: 'uppercase', label: 'Uppercase' },
  { kind: 'lowercase', label: 'Lowercase' },
  { kind: 'list', label: 'Reference list' },
  { kind: 'replace', label: 'Find and replace' },
];
