import { POSITION_FILE_MAP } from './position-file-map';
import type { ColumnTransform, FeedMap, TransformKind } from './types';
import { applyTransform } from './values';

export type AssignmentRole = 'ignore' | 'filter' | 'as_of' | 'identity' | 'name' | 'attribute' | 'parent';
export type SuggestionMethod = 'source_map' | 'name' | 'sample' | 'ai' | 'manual';

export interface AttributeChoice {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string | null;
  referenceListCode: string | null;
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
  return DOMAIN_LABELS[code] || code.charAt(0) + code.slice(1).toLowerCase();
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
    .slice(0, 40)
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

function scoreAttribute(header: string, attribute: AttributeChoice, domainCode: string): number {
  const headerTokens = new Set(tokens(header));
  const nameTokens = new Set(tokens(attribute.attributeName));
  const codeTokens = new Set(tokens(attribute.attributeCode.replace(/_/g, ' ')));
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
      const score = scoreAttribute(split.field, attribute, domainCode);
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

export function suggestAssignments(
  headers: string[],
  rows: Record<string, string>[],
  attributes: AttributeChoice[]
): ColumnAssignment[] {
  const usedAttributes = new Set<string>();
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

    const qualified = qualifiedAssignment(column, rows, attributes, usedAttributes);
    if (qualified) return withDistinct(qualified, rows);

    const bare = bareAssignment(column, rows);
    if (bare) return withDistinct(bare, rows);

    const samples = samplesFor(rows, column);
    let best: { score: number; domainCode: string; attribute: AttributeChoice } | null = null;
    for (const attribute of attributes) {
      const domains = attribute.domainCode ? [attribute.domainCode] : LOAD_DOMAINS;
      for (const domainCode of domains) {
        const key = `${domainCode}:${attribute.attributeCode}`;
        if (usedAttributes.has(key)) continue;
        const score = scoreAttribute(column, attribute, domainCode);
        if (!best || score > best.score) best = { score, domainCode, attribute };
      }
    }

    if (best && best.score >= 0.45) {
      usedAttributes.add(`${best.domainCode}:${best.attribute.attributeCode}`);
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
          confidence: Number(best.score.toFixed(2)),
          reason: `${column} matches ${best.attribute.attributeName} on the ${domainLabel(best.domainCode).toLowerCase()}.`,
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
  if (assignment.role === 'filter') return 'filter';
  if (assignment.role === 'identity') return `identity:${assignment.domainCode}`;
  if (assignment.role === 'name') return `name:${assignment.domainCode}`;
  if (assignment.role === 'parent') return `parent:${assignment.domainCode}:${assignment.parentDomainCode}`;
  return `attribute:${assignment.domainCode}:${assignment.attributeCode}`;
}

export function mappingTargets(attributes: AttributeChoice[], domains: string[]): MappingTarget[] {
  const targets: MappingTarget[] = [
    { key: 'ignore', group: 'File', label: 'Do not load', role: 'ignore', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: null, referenceListCode: null },
    { key: 'as_of', group: 'File', label: 'As-of date', role: 'as_of', domainCode: null, attributeCode: null, parentDomainCode: null, dataType: 'DATE', referenceListCode: null },
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

export function feedMapFromAssignments(
  assignments: ColumnAssignment[],
  identity?: { mapCode: string; sourceCode: string; name: string; description: string }
): FeedMap {
  const domains = new Map<string, FeedMap['domains'][number]>();
  const transforms: Record<string, ColumnTransform> = {};
  let asOfHintColumn: string | undefined;
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
      };
      domains.set(domainCode, domain);
    }
    return domain;
  };

  for (const assignment of assignments) {
    if (assignment.transform?.kind) transforms[assignment.sourceColumn] = assignment.transform;
    if (assignment.role === 'ignore') continue;
    if (assignment.role === 'as_of') asOfHintColumn = assignment.sourceColumn;
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
    if (assignment.role === 'attribute' && assignment.attributeCode) {
      domain.attributes.push({ column: assignment.sourceColumn, attributeCode: assignment.attributeCode });
    }
    if (assignment.role === 'parent' && assignment.parentDomainCode) {
      domain.parents.push({ column: assignment.sourceColumn, parentDomainCode: assignment.parentDomainCode });
    }
  }

  for (const link of IDENTITY_LINKS) {
    const parent = domains.get(link.parent);
    const child = domains.get(link.child);
    if (!parent?.identityColumn || !child) continue;
    if (child.parents.some((parentLink) => parentLink.parentDomainCode === link.parent)) continue;
    child.parents.push({ column: parent.identityColumn, parentDomainCode: link.parent });
  }

  const mapIdentity = identity || {
    mapCode: POSITION_FILE_MAP.mapCode,
    sourceCode: POSITION_FILE_MAP.sourceCode,
    name: POSITION_FILE_MAP.name,
    description: POSITION_FILE_MAP.description,
  };
  return {
    mapCode: mapIdentity.mapCode,
    sourceCode: mapIdentity.sourceCode,
    name: mapIdentity.name,
    description: mapIdentity.description,
    asOfHintColumn,
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
