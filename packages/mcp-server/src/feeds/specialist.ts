import { dependencyLoadWaves } from './load-order';
import { POSITION_FILE_MAP } from './position-file-map';
import {
  feedMapFromAssignments,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
  type FeedMapIdentity,
} from './suggest';
import type { FeedDomainSpec, FeedMap } from './types';
import { parseUsDate } from './values';

/**
 * Reads a table the way a data specialist would.
 * Obvious structure is decided. The questions are only the forks:
 * which source, which as-of date, which entity id, and columns that
 * could belong in more than one place. A column with no home becomes
 * a recommendation for a new attribute, entity, or relationship.
 */

export interface SpecialistDomain {
  code: string;
  name: string;
}

export interface SpecialistSource {
  code: string;
  name: string;
}

export interface SpecialistRelationship {
  code: string;
  name: string;
  parentDomain: string;
  childDomain: string;
}

export interface SpecialistCatalog {
  attributes: AttributeChoice[];
  domains: SpecialistDomain[];
  sources: SpecialistSource[];
  relationships: SpecialistRelationship[];
  maps: FeedMap[];
}

export interface SpecialistTableChoice {
  id: string;
  name: string;
  rowCount: number;
  headers: string[];
}

export interface SpecialistInput {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  catalog: SpecialistCatalog;
  answers: Record<string, string>;
  acceptedRecommendationIds: string[];
  dismissedRecommendationIds: string[];
  tables?: SpecialistTableChoice[];
}

export interface SpecialistOption {
  id: string;
  label: string;
  detail?: string;
}

export interface SpecialistQuestion {
  id: string;
  kind: 'table' | 'reuse_map' | 'source' | 'as_of' | 'identity' | 'stub' | 'column' | 'filter';
  prompt: string;
  detail: string;
  required: boolean;
  assumed: boolean;
  answer: string | null;
  options: SpecialistOption[];
  allowDate?: boolean;
  allowText?: boolean;
  textLabel?: string;
}

export interface SchemaColumnPlan {
  column: string;
  role: 'identity' | 'name' | 'attribute';
  attributeCode?: string;
  attributeName?: string;
  dataType?: string;
}

export interface SchemaRecommendation {
  id: string;
  kind: 'attribute' | 'domain' | 'relationship';
  title: string;
  rationale: string;
  payload: {
    domainCode?: string;
    domainName?: string;
    templateCode?: string;
    attributeCode?: string;
    attributeName?: string;
    dataType?: string;
    column?: string;
    columns?: SchemaColumnPlan[];
    relationshipCode?: string;
    relationshipName?: string;
    parentDomainCode?: string;
    childDomainCode?: string;
  };
}

export interface UnmappedColumn {
  column: string;
  samples: string[];
  domainCode: string | null;
  recommendationId: string | null;
  reason: string;
}

export interface MapChange {
  column: string;
  change: 'added' | 'missing';
  domainCode: string | null;
  note: string;
}

export interface FileRecord {
  domainCode: string;
  label: string;
  identifiedBy: string;
  count: number;
  needs: string;
}

export interface SpecialistReading {
  briefing: string;
  findings: string[];
  questions: SpecialistQuestion[];
  recommendations: SchemaRecommendation[];
  assignments: ColumnAssignment[];
  unmappedColumns: UnmappedColumn[];
  changes: MapChange[];
  records: FileRecord[];
  fundMissing: boolean;
  map: FeedMap | null;
  loadWaves: string[][];
  blockedReasons: string[];
  sampleRows: Record<string, string>[];
  asOfDate: string | null;
  sourceCode: string | null;
  focusQuestionId: string | null;
  acceptedRecommendationIds: string[];
}

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'for', 'to', 'from']);

const DOMAIN_ALIASES: Record<string, string[]> = {
  ISSUER: ['issuer', 'company', 'obligor', 'borrower'],
  FUND: ['fund', 'portfolio', 'vehicle'],
  SECURITY: ['security', 'instrument'],
  POSITION: ['position', 'holding', 'poition'],
  DEAL: ['deal', 'transaction'],
  CASH_FLOW: ['cashflow'],
  INVESTOR: ['investor'],
};

const IDENTITY_WORDS = new Set(['code', 'id', 'identifier', 'lei', 'isin', 'cusip', 'ticker', 'number']);

export function slugCode(value: string, max = 48): string {
  const slug = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return (slug || 'SOURCE').slice(0, max);
}

export function columnsUsedByMap(map: FeedMap): string[] {
  const columns: string[] = [];
  const add = (column?: string) => {
    if (column && !columns.includes(column)) columns.push(column);
  };
  add(map.asOfHintColumn);
  add(map.rowFilter?.column);
  for (const domain of map.domains) {
    add(domain.identityColumn);
    add(domain.nameColumn);
    for (const attribute of domain.attributes) add(attribute.column);
    for (const parent of domain.parents) add(parent.column);
  }
  return columns;
}

export function mapsWithBuiltin(maps: FeedMap[]): FeedMap[] {
  const byCode = new Map<string, FeedMap>();
  byCode.set(POSITION_FILE_MAP.mapCode, POSITION_FILE_MAP);
  for (const map of maps) {
    if (map?.mapCode && Array.isArray(map.domains)) byCode.set(map.mapCode, map);
  }
  return [...byCode.values()];
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !STOP.has(token));
}

function titleCase(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function fileBase(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Uploaded file';
}

function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function dateFromText(value: string): string | null {
  return parseUsDate(value);
}

function filenameDate(fileName: string): string | null {
  const match = fileName.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  return parseUsDate(iso);
}

interface ColumnProfile {
  column: string;
  samples: string[];
  filled: number;
  distinct: number;
  inferred: 'date' | 'number' | 'percent' | 'currency' | 'boolean' | 'code' | 'name' | 'text' | 'empty';
  constant: string | null;
  dates: string[];
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

function profileColumn(column: string, rows: Record<string, string>[]): ColumnProfile {
  const values: string[] = [];
  const distinct = new Set<string>();
  for (const row of rows) {
    const value = (row[column] || '').trim();
    if (!value) continue;
    values.push(value);
    distinct.add(value);
  }
  const sample = values.slice(0, 12);
  const sampleDates = sample.map((value) => dateFromText(value)).filter((value): value is string => Boolean(value));
  const numeric = (value: string) => /^-?[$€£]?[\d,]+(\.\d+)?%?$/.test(value.trim());
  let inferred: ColumnProfile['inferred'] = 'text';
  if (values.length === 0) inferred = 'empty';
  else if (sampleDates.length >= Math.ceil(sample.length * 0.6)) inferred = 'date';
  else if (sample.some((value) => value.trim().endsWith('%'))) inferred = 'percent';
  else if (sample.some((value) => /[$€£]/.test(value)) && sample.every(numeric)) inferred = 'currency';
  else if (sample.length > 0 && sample.every(numeric)) inferred = 'number';
  else if (sample.every((value) => /^(y|n|yes|no|true|false)$/i.test(value.trim()))) inferred = 'boolean';
  else if (sample.every((value) => value.length <= 32 && !/\s/.test(value))) inferred = 'code';
  else if (sample.some((value) => /\s/.test(value))) inferred = 'name';
  const dates = new Set<string>();
  if (inferred === 'date' || isAsOfHeader(column)) {
    for (const value of values) {
      const iso = dateFromText(value);
      if (!iso) continue;
      dates.add(iso);
      if (dates.size > 8) break;
    }
  }
  return {
    column,
    samples: samplesFor(rows, column),
    filled: values.length,
    distinct: distinct.size,
    inferred,
    constant: distinct.size === 1 ? [...distinct][0] : null,
    dates: [...dates],
  };
}

function dataTypeFor(profile: ColumnProfile): string {
  if (profile.inferred === 'date') return 'DATE';
  if (profile.inferred === 'percent') return 'PERCENTAGE';
  if (profile.inferred === 'currency') return 'CURRENCY';
  if (profile.inferred === 'number') return 'NUMBER';
  if (profile.inferred === 'boolean') return 'BOOLEAN';
  return 'STRING';
}

function aliases(domainCode: string): string[] {
  return DOMAIN_ALIASES[domainCode] || [domainCode.toLowerCase().replace(/_/g, '')];
}

function domainFromHeader(column: string, known: Set<string>): string | null {
  const parts = tokens(column);
  let best: { domain: string; known: boolean } | null = null;
  for (const [domain, words] of Object.entries(DOMAIN_ALIASES)) {
    if (!parts.some((part) => words.includes(part))) continue;
    const isKnown = known.has(domain);
    if (!best || (isKnown && !best.known)) best = { domain, known: isKnown };
  }
  return best?.domain || null;
}

function isIdentityHeader(column: string): boolean {
  return tokens(column).some((token) => IDENTITY_WORDS.has(token));
}

function isNameHeader(column: string): boolean {
  const parts = tokens(column);
  return parts.includes('name') || (parts.includes('legal') && parts.includes('name'));
}

function phrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isAsOfHeader(column: string): boolean {
  const text = phrase(column);
  if (text === 'date') return true;
  return ['as of', 'asof', 'valid from', 'valid date', 'effective', 'snapshot', 'report date', 'period end', 'file date'].some((hint) => text.includes(hint));
}

function scoreAttribute(header: string, attribute: AttributeChoice, domainCode: string): number {
  const aliasWords = new Set(aliases(domainCode));
  const raw = tokens(header);
  const stripped = raw.filter((token) => !aliasWords.has(token));
  const headerTokens = new Set(stripped.length > 0 ? stripped : raw);
  const attributeTokens = new Set([
    ...tokens(attribute.attributeName),
    ...tokens(attribute.attributeCode.replace(/_/g, ' ')),
  ]);
  let overlap = 0;
  for (const token of headerTokens) {
    if (attributeTokens.has(token)) overlap += 1;
  }
  if (overlap === 0) return 0;
  return Math.min(0.95, overlap / Math.max(headerTokens.size, 1));
}

function blankAssignment(column: string, rows: Record<string, string>[], role: ColumnAssignment['role']): ColumnAssignment {
  return {
    sourceColumn: column,
    samples: samplesFor(rows, column),
    role,
    domainCode: null,
    attributeCode: null,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'trim' },
    suggestion: { method: 'name', confidence: 0.4, reason: '' },
  };
}

function attributeAssignment(
  column: string,
  rows: Record<string, string>[],
  domainCode: string,
  attribute: AttributeChoice,
  reason: string,
  confidence: number,
  method: ColumnAssignment['suggestion']['method']
): ColumnAssignment {
  return {
    ...blankAssignment(column, rows, 'attribute'),
    domainCode,
    attributeCode: attribute.attributeCode,
    transform: suggestTransform(samplesFor(rows, column), attribute.dataType, attribute.referenceListCode),
    suggestion: { method, confidence, reason },
  };
}

function headerLookup(headers: string[]): Map<string, string> {
  return new Map(headers.map((header) => [header.toLowerCase(), header]));
}

function assignmentsFromMap(map: FeedMap, headers: string[], rows: Record<string, string>[]): ColumnAssignment[] {
  const lookup = headerLookup(headers);
  const actual = (column: string) => lookup.get(column.toLowerCase()) || null;
  const assignments: ColumnAssignment[] = [];
  const used = new Set<string>();
  const take = (column: string | undefined, build: (header: string) => ColumnAssignment) => {
    if (!column) return;
    const header = actual(column);
    if (!header || used.has(header)) return;
    used.add(header);
    assignments.push(build(header));
  };
  take(map.rowFilter?.column, (header) => ({
    ...blankAssignment(header, rows, 'filter'),
    filterEquals: map.rowFilter?.equals || null,
    suggestion: { method: 'source_map', confidence: 0.99, reason: `${map.name} keeps rows equal to ${map.rowFilter?.equals}` },
  }));
  take(map.asOfHintColumn, (header) => ({
    ...blankAssignment(header, rows, 'as_of'),
    transform: { kind: 'date' },
    suggestion: { method: 'source_map', confidence: 0.99, reason: `${map.name} uses this column as the as-of date` },
  }));
  for (const domain of map.domains) {
    take(domain.identityColumn, (header) => ({
      ...blankAssignment(header, rows, 'identity'),
      domainCode: domain.domainCode,
      suggestion: { method: 'source_map', confidence: 0.99, reason: `${map.name} identifies ${domain.domainCode}` },
    }));
    if (domain.nameColumn !== domain.identityColumn) {
      take(domain.nameColumn, (header) => ({
        ...blankAssignment(header, rows, 'name'),
        domainCode: domain.domainCode,
        suggestion: { method: 'source_map', confidence: 0.97, reason: `${map.name} names ${domain.domainCode}` },
      }));
    }
    for (const attribute of domain.attributes) {
      take(attribute.column, (header) => ({
        ...blankAssignment(header, rows, 'attribute'),
        domainCode: domain.domainCode,
        attributeCode: attribute.attributeCode,
        transform: suggestTransform(samplesFor(rows, header), null, null),
        suggestion: { method: 'source_map', confidence: 0.97, reason: `${map.name} assigns this column to ${attribute.attributeCode}` },
      }));
    }
  }
  return assignments;
}

interface SavedMapMatch {
  map: FeedMap;
  mapCoverage: number;
  added: string[];
  missing: string[];
}

function matchSavedMap(headers: string[], maps: FeedMap[]): SavedMapMatch | null {
  const lookup = headerLookup(headers);
  let best: SavedMapMatch | null = null;
  for (const map of maps) {
    const identities = map.domains.map((domain) => domain.identityColumn.toLowerCase());
    if (identities.length === 0 || identities.some((column) => !lookup.has(column))) continue;
    const used = columnsUsedByMap(map);
    const present = used.filter((column) => lookup.has(column.toLowerCase()));
    const mapCoverage = present.length / Math.max(used.length, 1);
    if (present.length < 6 || mapCoverage < 0.6) continue;
    const added = headers.filter((header) => !used.some((column) => column.toLowerCase() === header.toLowerCase()));
    const missing = used.filter((column) => !lookup.has(column.toLowerCase()));
    const candidate = { map, mapCoverage, added, missing };
    if (!best || mapCoverage > best.mapCoverage) best = candidate;
  }
  return best;
}

function connects(relationships: SpecialistRelationship[], left: string, right: string): boolean {
  return relationships.some(
    (relationship) =>
      (relationship.parentDomain === left && relationship.childDomain === right) ||
      (relationship.parentDomain === right && relationship.childDomain === left)
  );
}

function attributeCodeFrom(column: string, domainCode: string): string {
  const aliasWords = new Set(aliases(domainCode));
  const parts = tokens(column).filter((token) => !aliasWords.has(token));
  return slugCode((parts.length > 0 ? parts : tokens(column)).join(' '), 100);
}

function attributeNameFrom(column: string, domainCode: string): string {
  const aliasWords = new Set(aliases(domainCode));
  const parts = tokens(column).filter((token) => !aliasWords.has(token));
  return titleCase((parts.length > 0 ? parts : tokens(column)).join(' '));
}

function question(
  spec: Omit<SpecialistQuestion, 'answer' | 'assumed'> & { assumed?: boolean },
  answers: Record<string, string>,
  fallback: string | null
): SpecialistQuestion {
  const explicit = answers[spec.id];
  const assumed = !explicit && Boolean(fallback);
  return {
    ...spec,
    assumed,
    answer: explicit || fallback,
  };
}

function isStub(domain: FeedDomainSpec): boolean {
  return domain.attributes.length === 0 && (!domain.nameColumn || domain.nameColumn === domain.identityColumn);
}

export function readSource(input: SpecialistInput): SpecialistReading {
  const answers = input.answers || {};
  const accepted = new Set(input.acceptedRecommendationIds || []);
  const dismissed = new Set(input.dismissedRecommendationIds || []);
  const findings: string[] = [];
  const questions: SpecialistQuestion[] = [];
  const recommendations: SchemaRecommendation[] = [];
  const knownDomains = new Set(input.catalog.domains.map((domain) => domain.code));
  const rows = input.rows || [];
  const headers = (input.headers || []).filter(Boolean);

  if (input.tables && input.tables.length > 1) {
    const ranked = [...input.tables].sort((left, right) => right.rowCount - left.rowCount);
    const obvious = ranked[0].rowCount >= ranked[1].rowCount * 3;
    const tableQuestion = question(
      {
        id: 'table',
        kind: 'table',
        prompt: `This file has ${input.tables.length} tables. Which one should I load?`,
        detail: obvious
          ? `${ranked[0].name} has most of the rows, so I am using that one.`
          : 'The tables are a similar size, so I need you to choose.',
        required: !obvious,
        options: input.tables.map((table) => ({
          id: table.id,
          label: table.name,
          detail: `${table.rowCount} rows · ${table.headers.slice(0, 4).join(', ')}`,
        })),
      },
      answers,
      obvious ? ranked[0].id : null
    );
    questions.push(tableQuestion);
  }

  if (headers.length === 0 || rows.length === 0) {
    findings.push('I do not have a table yet. Upload a CSV, Excel, or JSON file, or extract a document first.');
    return finish(findings, questions, recommendations, [], [], [], [], false, null, null, null, []);
  }

  findings.push(`I read ${rows.length} row${rows.length === 1 ? '' : 's'} and ${headers.length} column${headers.length === 1 ? '' : 's'} from ${input.fileName}.`);

  const profiles = new Map(headers.map((header) => [header, profileColumn(header, rows)]));
  const maps = mapsWithBuiltin(input.catalog.maps);
  const matched = matchSavedMap(headers, maps);
  let reused: FeedMap | null = null;
  let mapDiff: { added: string[]; missing: string[] } | null = null;
  if (matched) {
    const addedNote = matched.added.length === 0
      ? 'Every field in the file is already on that map.'
      : `${matched.added.length} field${matched.added.length === 1 ? ' is' : 's are'} new. I will place the known fields and check the new ones.`;
    const reuse = question(
      {
        id: 'reuse_map',
        kind: 'reuse_map',
        prompt: `This matches ${matched.map.name}.`,
        detail: `${Math.round(matched.mapCoverage * 100)}% of that map is in this file. ${addedNote}`,
        required: matched.mapCoverage < 0.85,
        options: [
          { id: 'use', label: `Use ${matched.map.name}`, detail: matched.map.description },
          { id: 'discover', label: 'Read it as a new file' },
        ],
      },
      answers,
      matched.mapCoverage >= 0.85 ? 'use' : null
    );
    questions.push(reuse);
    if (reuse.answer === 'use') {
      reused = matched.map;
      mapDiff = { added: matched.added, missing: matched.missing };
    }
  }

  const fileSourceName = fileBase(input.fileName);
  const sourceOptions: SpecialistOption[] = input.catalog.sources.slice(0, 12).map((source) => ({
    id: source.code,
    label: source.name,
    detail: source.code,
  }));
  sourceOptions.push({ id: `new:${fileSourceName}`, label: `New source “${fileSourceName}”`, detail: slugCode(fileSourceName) });
  const sourceQuestion = question(
    {
      id: 'source',
      kind: 'source',
      prompt: 'Which source is this file from?',
      detail: 'Every value is stored under that source so precedence and lineage stay intact.',
      required: false,
      allowText: true,
      textLabel: 'Or name a new source',
      options: sourceOptions,
    },
    answers,
    reused ? reused.sourceCode : `new:${fileSourceName}`
  );
  if (!reused) questions.push(sourceQuestion);

  const source = resolveSource(reused ? reused.sourceCode : sourceQuestion.answer, input.catalog.sources, fileSourceName);
  const asOf = resolveAsOf(headers, profiles, input.fileName, answers, questions);

  const assignments: ColumnAssignment[] = [];
  const consumed = new Set<string>();
  const held = new Set<string>();
  if (reused && reused) {
    const mapped = assignmentsFromMap(reused, headers, rows);
    assignments.push(...mapped);
    for (const assignment of mapped) consumed.add(assignment.sourceColumn);
    const addedText = mapDiff && mapDiff.added.length > 0
      ? ` ${mapDiff.added.length} field${mapDiff.added.length === 1 ? ' is' : 's are'} new: ${mapDiff.added.slice(0, 8).join(', ')}${mapDiff.added.length > 8 ? '…' : ''}.`
      : ' No new fields.';
    const missingText = mapDiff && mapDiff.missing.length > 0
      ? ` ${mapDiff.missing.length} field${mapDiff.missing.length === 1 ? ' is' : 's are'} on the map but not in this file: ${mapDiff.missing.slice(0, 8).join(', ')}${mapDiff.missing.length > 8 ? '…' : ''}.`
      : '';
    findings.push(`I compared this file with ${reused.name}.${addedText}${missingText}`);
  }

  const groups = new Map<string, string[]>();
  const pool: string[] = [];
  for (const header of headers) {
    if (consumed.has(header)) continue;
    const domain = domainFromHeader(header, knownDomains);
    if (!domain) {
      pool.push(header);
      continue;
    }
    const list = groups.get(domain) || [];
    list.push(header);
    groups.set(domain, list);
  }

  for (const [domainCode, columns] of groups) {
    const identity = chooseIdentity(domainCode, columns, profiles, answers, questions);
    if (!identity) {
      for (const column of columns) held.add(column);
      continue;
    }
    consumed.add(identity);
    assignments.push({
      ...blankAssignment(identity, rows, 'identity'),
      domainCode,
      suggestion: { method: 'name', confidence: 0.9, reason: `${identity} identifies ${domainCode}` },
    });
    const nameColumn = columns.find((column) => column !== identity && isNameHeader(column));
    if (nameColumn) {
      consumed.add(nameColumn);
      assignments.push({
        ...blankAssignment(nameColumn, rows, 'name'),
        domainCode,
        suggestion: { method: 'name', confidence: 0.86, reason: `${nameColumn} names ${domainCode}` },
      });
    }
    for (const column of columns) {
      if (consumed.has(column) || isAsOfHeader(column)) continue;
      const matchedAttribute = bestAttribute(column, domainCode, input.catalog.attributes);
      if (matchedAttribute && matchedAttribute.score >= 0.62) {
        consumed.add(column);
        assignments.push(attributeAssignment(
          column,
          rows,
          domainCode,
          matchedAttribute.attribute,
          `Header matches ${matchedAttribute.attribute.attributeName} on ${domainCode}`,
          matchedAttribute.score,
          'name'
        ));
      }
    }
  }

  const askBudget = { left: 4 };
  for (const column of [...pool]) {
    if (isAsOfHeader(column) && profiles.get(column)?.inferred === 'date') continue;
    const domainHint = domainFromHeader(column, knownDomains);
    const domains = domainHint ? [domainHint] : [...knownDomains];
    let best: { score: number; domainCode: string; attribute: AttributeChoice } | null = null;
    const ranked: { score: number; domainCode: string; attribute: AttributeChoice }[] = [];
    for (const attribute of input.catalog.attributes) {
      const allowed = attribute.domainCode ? [attribute.domainCode] : domains;
      for (const domainCode of allowed) {
        const score = scoreAttribute(column, attribute, domainCode);
        if (score < 0.4) continue;
        const hit = { score, domainCode, attribute };
        ranked.push(hit);
        if (!best || score > best.score) best = hit;
      }
    }
    ranked.sort((left, right) => right.score - left.score);
    if (best && best.score >= 0.72) {
      consumed.add(column);
      assignments.push(attributeAssignment(
        column,
        rows,
        best.domainCode,
        best.attribute,
        `Header matches ${best.attribute.attributeName}`,
        best.score,
        'name'
      ));
      continue;
    }
    if (best && best.score >= 0.42 && askBudget.left > 0) {
      askBudget.left -= 1;
      const options: SpecialistOption[] = ranked.slice(0, 3).map((hit) => ({
        id: `attribute:${hit.domainCode}:${hit.attribute.attributeCode}`,
        label: `${hit.domainCode} · ${hit.attribute.attributeName}`,
      }));
      const home = best.domainCode;
      options.push({ id: `new_attribute:${home}`, label: `New ${home} attribute` });
      options.push({ id: 'ignore', label: 'Do not load' });
      const asked = question(
        {
          id: `column:${column}`,
          kind: 'column',
          prompt: `Where should “${column}” go?`,
          detail: `It resembles ${best.attribute.attributeName}, but not closely enough to decide.`,
          required: true,
          options,
        },
        answers,
        null
      );
      questions.push(asked);
      if (asked.answer === 'ignore' || !asked.answer) {
        consumed.add(column);
        continue;
      }
      if (asked.answer.startsWith('attribute:')) {
        const [, domainCode, attributeCode] = asked.answer.split(':');
        const attribute = input.catalog.attributes.find((item) => item.attributeCode === attributeCode);
        if (attribute && domainCode) {
          consumed.add(column);
          assignments.push(attributeAssignment(column, rows, domainCode, attribute, 'You chose this attribute', 1, 'manual'));
        }
      }
      if (asked.answer.startsWith('new_attribute:')) {
        const domainCode = asked.answer.slice('new_attribute:'.length);
        consumed.add(column);
        const created = recommendAttribute(column, domainCode, profiles.get(column)!, `You asked for a new ${domainCode} attribute from “${column}”.`);
        recommendations.push(created);
        accepted.add(created.id);
        assignments.push(newAttributeAssignment(column, rows, domainCode, created));
      }
    }
  }

  const unassigned = headers.filter((header) => {
    if (held.has(header)) return false;
    if (isAsOfHeader(header) && profiles.get(header)?.inferred === 'date') return false;
    if (assignments.some((assignment) => assignment.sourceColumn === header)) return false;
    if (questions.some((item) => item.id === `column:${header}`)) return false;
    return true;
  });
  const proposedDomains = proposeDomains(unassigned, profiles, knownDomains);
  for (const proposed of proposedDomains) {
    if (dismissed.has(proposed.id)) continue;
    recommendations.push(proposed);
    if (!accepted.has(proposed.id)) continue;
    for (const column of proposed.payload.columns || []) {
      consumed.add(column.column);
      if (column.role === 'identity') {
        assignments.push({
          ...blankAssignment(column.column, rows, 'identity'),
          domainCode: proposed.payload.domainCode || null,
          suggestion: { method: 'manual', confidence: 1, reason: `New entity ${proposed.payload.domainCode}` },
        });
      } else if (column.role === 'name') {
        assignments.push({
          ...blankAssignment(column.column, rows, 'name'),
          domainCode: proposed.payload.domainCode || null,
          suggestion: { method: 'manual', confidence: 1, reason: `Name of ${proposed.payload.domainCode}` },
        });
      } else if (column.attributeCode) {
        assignments.push(newAttributeAssignment(column.column, rows, proposed.payload.domainCode || '', {
          ...proposed,
          payload: { ...proposed.payload, attributeCode: column.attributeCode, attributeName: column.attributeName, dataType: column.dataType, column: column.column },
        }));
      }
    }
  }

  const claimed = new Set(proposedDomains.flatMap((proposed) => (proposed.payload.columns || []).map((column) => column.column)));
  const unmapped = collectUnmapped(unassigned, claimed, groups, knownDomains, profiles, assignments, input.catalog.attributes, rows, recommendations, accepted, dismissed);
  const pending = unmapped.filter((column) => column.recommendationId);
  if (pending.length > 0) {
    const names = pending.map((column) => column.column);
    const listed = names.slice(0, 8).join(', ');
    findings.push(
      `${pending.length} field${pending.length === 1 ? ' is' : 's are'} not mapped: ${listed}${names.length > 8 ? '…' : ''}. Where I could not match an attribute, I recommended a new one on that entity.`
    );
  }

  if (asOf.column && asOf.date && !assignments.some((assignment) => assignment.sourceColumn === asOf.column)) {
    assignments.push({
      ...blankAssignment(asOf.column, rows, 'as_of'),
      transform: { kind: 'date' },
      suggestion: { method: 'sample', confidence: 0.9, reason: 'This column is the as-of date' },
    });
  }

  const fundColumn = answers.fund_column;
  if (fundColumn && headers.includes(fundColumn)) {
    const existing = assignments.findIndex((assignment) => assignment.sourceColumn === fundColumn);
    if (existing >= 0) assignments.splice(existing, 1);
    assignments.push({
      ...blankAssignment(fundColumn, rows, 'identity'),
      domainCode: 'FUND',
      suggestion: { method: 'manual', confidence: 1, reason: 'You chose this column as the fund' },
    });
  }

  const identity = mapIdentity(reused, source, input.fileName);
  let map = identity ? feedMapFromAssignments(assignments, identity) : null;
  if (map && !reused) {
    const stubbed = applyStubChoices(map, answers);
    map = linkKnownParents(stubbed.map, knownDomains);
    questions.push(...stubbed.questions);
  }

  const blocked: string[] = [];
  let loadWaves: string[][] = [];
  if (map && map.domains.length > 0) {
    try {
      loadWaves = dependencyLoadWaves(map.domains);
    } catch (error: any) {
      blocked.push(error?.message || 'The parent links form a cycle.');
    }
  }

  if (map) {
    const virtualRelationships = [...input.catalog.relationships];
    const missing: SchemaRecommendation[] = [];
    for (const domain of map.domains) {
      for (const parent of domain.parents) {
        if (connects(virtualRelationships, domain.domainCode, parent.parentDomainCode)) continue;
        const id = `rel:${domain.domainCode}:${parent.parentDomainCode}`;
        if (missing.some((item) => item.id === id)) continue;
        missing.push({
          id,
          kind: 'relationship',
          title: `Let ${domain.domainCode} point at ${parent.parentDomainCode}`,
          rationale: `${domain.domainCode} rows carry a ${parent.parentDomainCode} code, and there is no relationship for that link yet.`,
          payload: {
            relationshipCode: slugCode(`${domain.domainCode}_${parent.parentDomainCode}`, 100),
            relationshipName: `${titleCase(domain.domainCode)} to ${titleCase(parent.parentDomainCode)}`,
            parentDomainCode: domain.domainCode,
            childDomainCode: parent.parentDomainCode,
          },
        });
      }
    }
    const stripped = new Set<string>();
    for (const item of missing) {
      if (dismissed.has(item.id)) stripped.add(item.id);
    }
    if (stripped.size > 0) {
      map = {
        ...map,
        domains: map.domains.map((domain) => ({
          ...domain,
          parents: domain.parents.filter((parent) => !stripped.has(`rel:${domain.domainCode}:${parent.parentDomainCode}`)),
        })),
      };
    }
    for (const item of missing) {
      if (stripped.has(item.id)) continue;
      if (connects(virtualRelationships, item.payload.parentDomainCode || '', item.payload.childDomainCode || '')) continue;
      recommendations.push(item);
      if (accepted.has(item.id)) {
        virtualRelationships.push({
          code: item.payload.relationshipCode || item.id,
          name: item.payload.relationshipName || item.id,
          parentDomain: item.payload.parentDomainCode || '',
          childDomain: item.payload.childDomainCode || '',
        });
      }
    }
  }

  if (map && map.domains.length > 0) {
    const names = map.domains.map((domain) => domain.domainCode);
    findings.push(names.length === 1
      ? `The rows are ${names[0]} entities.`
      : `The rows carry ${names.join(', ')}.`);
  }
  if (source) findings.push(`The source is ${source.name} (${source.code}).`);
  if (asOf.date) findings.push(`The as-of date is ${asOf.date}. That date is written on every value.`);
  else findings.push('I cannot see a single as-of date yet.');

  if (loadWaves.length > 1) {
    findings.push(`Load order is ${loadWaves.map((wave) => wave.join(' and ')).join(', then ')}.`);
  }

  for (const item of questions) {
    if (item.required && !item.answer) blocked.push(item.prompt);
  }
  if (!source) blocked.push('Choose the source this file comes from.');
  if (!asOf.date) blocked.push('Choose the as-of date.');
  if (!map || map.domains.length === 0) blocked.push('I need at least one entity id before I can load.');
  for (const item of recommendations) {
    if (item.kind === 'relationship' && !accepted.has(item.id) && !dismissed.has(item.id)) {
      blocked.push(`${item.title}. Accept it, or dismiss it to load without that link.`);
    }
  }

  const openRecommendations = recommendations.filter((item) => !accepted.has(item.id) && !dismissed.has(item.id));
  if (openRecommendations.some((item) => item.kind === 'domain')) {
    findings.push('Some columns describe an entity this system does not have yet. I will not invent it unless you accept it.');
  }

  const changes = describeChanges(reused, mapDiff, assignments, unmapped);
  const records = map ? fileRecords(map, rows) : [];
  const fundMissing = Boolean(map?.domains.some((domain) => domain.domainCode === 'POSITION')
    && !map.domains.some((domain) => domain.domainCode === 'FUND')
    && !map.domains.some((domain) => domain.parents.some((parent) => parent.parentDomainCode === 'FUND')));
  if (fundMissing) {
    findings.push('No fund column was found, so positions will not be linked to a fund.');
  }
  return finish(findings, questions, recommendations, assignments, unmapped, changes, records, fundMissing, map, asOf.date, source?.code || null, rows.slice(0, 4), blocked, [...accepted]);
}

function finish(
  findings: string[],
  questions: SpecialistQuestion[],
  recommendations: SchemaRecommendation[],
  assignments: ColumnAssignment[],
  unmappedColumns: UnmappedColumn[] = [],
  changes: MapChange[] = [],
  records: FileRecord[] = [],
  fundMissing = false,
  map: FeedMap | null,
  asOfDate: string | null,
  sourceCode: string | null,
  rows: Record<string, string>[],
  blockedReasons: string[] = ['I do not have a table yet.'],
  acceptedRecommendationIds: string[] = []
): SpecialistReading {
  const focus = questions.find((item) => item.required && !item.answer) || null;
  return {
    briefing: findings.join(' '),
    findings,
    questions,
    recommendations,
    assignments,
    unmappedColumns,
    changes,
    records,
    fundMissing,
    map,
    loadWaves: map && map.domains.length > 0 ? safeWaves(map) : [],
    blockedReasons,
    sampleRows: rows,
    asOfDate,
    sourceCode,
    focusQuestionId: focus?.id || null,
    acceptedRecommendationIds,
  };
}

function safeWaves(map: FeedMap): string[][] {
  try {
    return dependencyLoadWaves(map.domains);
  } catch {
    return [];
  }
}

function resolveSource(
  answer: string | null,
  sources: SpecialistSource[],
  fileSourceName: string
): { code: string; name: string } | null {
  if (!answer) return null;
  if (answer === 'new' || answer.startsWith('new:')) {
    const raw = answer === 'new' ? fileSourceName : answer.slice(4).trim();
    const code = slugCode(raw || fileSourceName);
    return { code, name: raw || code };
  }
  const known = sources.find((source) => source.code === answer);
  if (known) return { code: known.code, name: known.name };
  return { code: slugCode(answer), name: answer };
}

function resolveAsOf(
  headers: string[],
  profiles: Map<string, ColumnProfile>,
  fileName: string,
  answers: Record<string, string>,
  questions: SpecialistQuestion[]
): { date: string | null; column: string | null } {
  const candidates = headers.filter((header) => {
    const profile = profiles.get(header);
    return profile && profile.inferred === 'date' && isAsOfHeader(header);
  });
  const fromName = filenameDate(fileName);
  const options: SpecialistOption[] = [];
  for (const header of candidates) {
    const dates = profiles.get(header)?.dates || [];
    options.push({
      id: `column:${header}`,
      label: header,
      detail: dates.length === 1 ? dates[0] : dates.length > 1 ? `${dates.length} different dates` : 'Dates in this column',
    });
    if (dates.length > 1 && dates.length <= 8) {
      for (const iso of dates) options.push({ id: `date:${iso}`, label: iso, detail: `A date in ${header}` });
    }
  }
  if (fromName) options.push({ id: `date:${fromName}`, label: `Date in the file name (${fromName})` });
  options.push({ id: 'today', label: `Today (${todayIso()})` });
  options.push({ id: 'specific', label: 'A specific date' });

  let fallback: string | null = null;
  if (candidates.length === 1 && (profiles.get(candidates[0])?.dates.length || 0) === 1) fallback = `column:${candidates[0]}`;
  else if (candidates.length === 0 && fromName) fallback = `date:${fromName}`;

  const asked = question(
    {
      id: 'as_of',
      kind: 'as_of',
      prompt: 'What as-of date should I write on these values?',
      detail: fallback
        ? 'I found one date and I will use it unless you say otherwise.'
        : 'A load needs one valid date. Every value in this file is stored as of that day.',
      required: !fallback,
      allowDate: true,
      options,
    },
    answers,
    fallback
  );
  questions.push(asked);
  const date = asOfFromAnswer(asked.answer, profiles);
  const column = asked.answer?.startsWith('column:') ? asked.answer.slice('column:'.length) : null;
  return { date, column };
}

function asOfFromAnswer(answer: string | null, profiles: Map<string, ColumnProfile>): string | null {
  if (!answer || answer === 'specific') return null;
  if (answer === 'today') return todayIso();
  if (answer.startsWith('date:')) {
    const iso = answer.slice(5);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }
  if (answer.startsWith('column:')) {
    const header = answer.slice('column:'.length);
    const dates = profiles.get(header)?.dates || [];
    return dates.length === 1 ? dates[0] : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(answer)) return answer;
  return null;
}

function chooseIdentity(
  domainCode: string,
  columns: string[],
  profiles: Map<string, ColumnProfile>,
  answers: Record<string, string>,
  questions: SpecialistQuestion[]
): string | null {
  const candidates = columns.filter((column) => {
    const profile = profiles.get(column);
    if (!profile || profile.inferred === 'empty' || profile.inferred === 'date') return false;
    return isIdentityHeader(column);
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((left, right) => (profiles.get(right)?.distinct || 0) - (profiles.get(left)?.distinct || 0));
  const asked = question(
    {
      id: `identity:${domainCode}`,
      kind: 'identity',
      prompt: `Which column is the ${domainCode} entity id?`,
      detail: 'The entity id is how I match a row to an entity that already exists.',
      required: true,
      options: ranked.map((column) => ({
        id: column,
        label: column,
        detail: `${profiles.get(column)?.distinct || 0} distinct values`,
      })),
    },
    answers,
    null
  );
  questions.push(asked);
  return asked.answer && ranked.includes(asked.answer) ? asked.answer : null;
}

function bestAttribute(
  column: string,
  domainCode: string,
  attributes: AttributeChoice[]
): { score: number; attribute: AttributeChoice } | null {
  let best: { score: number; attribute: AttributeChoice } | null = null;
  for (const attribute of attributes) {
    if (attribute.domainCode && attribute.domainCode !== domainCode) continue;
    const score = scoreAttribute(column, attribute, domainCode);
    if (!best || score > best.score) best = { score, attribute };
  }
  return best && best.score > 0 ? best : null;
}

function recommendAttribute(column: string, domainCode: string, profile: ColumnProfile, rationale: string): SchemaRecommendation {
  const attributeCode = attributeCodeFrom(column, domainCode);
  return {
    id: `attr:${domainCode}:${attributeCode}`,
    kind: 'attribute',
    title: `Add ${attributeNameFrom(column, domainCode)} on ${domainCode}`,
    rationale,
    payload: {
      domainCode,
      attributeCode,
      attributeName: attributeNameFrom(column, domainCode),
      dataType: dataTypeFor(profile),
      column,
    },
  };
}

function newAttributeAssignment(
  column: string,
  rows: Record<string, string>[],
  domainCode: string,
  recommendation: SchemaRecommendation
): ColumnAssignment {
  return {
    ...blankAssignment(column, rows, 'attribute'),
    domainCode,
    attributeCode: recommendation.payload.attributeCode || null,
    transform: suggestTransform(samplesFor(rows, column), recommendation.payload.dataType || null, null),
    suggestion: { method: 'manual', confidence: 1, reason: recommendation.title },
  };
}

function proposeDomains(
  columns: string[],
  profiles: Map<string, ColumnProfile>,
  knownDomains: Set<string>
): SchemaRecommendation[] {
  const groups = new Map<string, string[]>();
  for (const column of columns) {
    const first = tokens(column).find((token) => token.length >= 4);
    if (!first) continue;
    if (Object.values(DOMAIN_ALIASES).some((words) => words.includes(first))) continue;
    const list = groups.get(first) || [];
    list.push(column);
    groups.set(first, list);
  }
  const proposed: SchemaRecommendation[] = [];
  for (const [token, group] of groups) {
    if (group.length < 2) continue;
    if (!group.some((column) => isIdentityHeader(column) || isNameHeader(column))) continue;
    const domainCode = slugCode(token, 50);
    if (knownDomains.has(domainCode)) continue;
    const identity = group.find((column) => isIdentityHeader(column)) || group[0];
    const plans: SchemaColumnPlan[] = group.map((column) => {
      if (column === identity) return { column, role: 'identity' };
      if (isNameHeader(column)) return { column, role: 'name' };
      const profile = profiles.get(column)!;
      return {
        column,
        role: 'attribute',
        attributeCode: attributeCodeFrom(column, domainCode),
        attributeName: attributeNameFrom(column, domainCode),
        dataType: dataTypeFor(profile),
      };
    });
    proposed.push({
      id: `domain:${domainCode}`,
      kind: 'domain',
      title: `Create a ${titleCase(token)} entity`,
      rationale: `${group.map((column) => column).join(', ')} hang together, and none of the current entities can hold them.`,
      payload: {
        domainCode,
        domainName: titleCase(token),
        templateCode: `${domainCode}_STANDARD`,
        columns: plans,
      },
    });
  }
  return proposed;
}

function collectUnmapped(
  unassigned: string[],
  claimed: Set<string>,
  groups: Map<string, string[]>,
  knownDomains: Set<string>,
  profiles: Map<string, ColumnProfile>,
  assignments: ColumnAssignment[],
  attributes: AttributeChoice[],
  rows: Record<string, string>[],
  recommendations: SchemaRecommendation[],
  accepted: Set<string>,
  dismissed: Set<string>
): UnmappedColumn[] {
  const unmapped: UnmappedColumn[] = [];
  const homeOf = (column: string): string | null => {
    for (const [domainCode, columns] of groups) {
      if (columns.includes(column)) return domainCode;
    }
    return domainFromHeader(column, knownDomains);
  };
  for (const column of unassigned) {
    if (claimed.has(column) || assignments.some((assignment) => assignment.sourceColumn === column)) continue;
    const profile = profiles.get(column);
    if (!profile || profile.inferred === 'empty') continue;
    const home = homeOf(column) || dominantDomain(assignments);
    if (!home) {
      unmapped.push({
        column,
        samples: profile.samples,
        domainCode: null,
        recommendationId: null,
        reason: 'I cannot tell which entity this field belongs to.',
      });
      continue;
    }
    const best = bestAttribute(column, home, attributes);
    const created = best && best.score >= 0.45
      ? {
          id: `attr:${home}:${best.attribute.attributeCode}`,
          kind: 'attribute' as const,
          title: `Map “${column}” to ${best.attribute.attributeName} on ${home}`,
          rationale: `“${column}” is close to ${best.attribute.attributeName} on ${home}, but not close enough to assign without you.`,
          payload: {
            domainCode: home,
            attributeCode: best.attribute.attributeCode,
            attributeName: best.attribute.attributeName,
            dataType: best.attribute.dataType,
            column,
          },
        }
      : recommendAttribute(
          column,
          home,
          profile,
          `“${column}” does not match an attribute on ${home}. Add one so these values are kept.`
        );
    if (!recommendations.some((item) => item.id === created.id) && !dismissed.has(created.id)) recommendations.push(created);
    if (accepted.has(created.id)) {
      if (best && best.score >= 0.45 && created.payload.attributeCode === best.attribute.attributeCode) {
        assignments.push(attributeAssignment(column, rows, home, best.attribute, 'You accepted this match', 1, 'manual'));
      } else {
        assignments.push(newAttributeAssignment(column, rows, home, created));
      }
      continue;
    }
    unmapped.push({
      column,
      samples: profile.samples,
      domainCode: home,
      recommendationId: dismissed.has(created.id) ? null : created.id,
      reason: dismissed.has(created.id) ? 'You left this field out.' : created.rationale,
    });
  }
  return unmapped;
}

const RECORD_LABELS: Record<string, string> = {
  ISSUER: 'Issuers',
  SECURITY: 'Securities',
  POSITION: 'Positions',
  FUND: 'Funds',
  DEAL: 'Deals',
  CASH_FLOW: 'Cash flows',
  INVESTOR: 'Investors',
};

function fileRecords(map: FeedMap, rows: Record<string, string>[]): FileRecord[] {
  let waves: string[][] = [];
  try {
    waves = dependencyLoadWaves(map.domains);
  } catch {
    waves = [map.domains.map((domain) => domain.domainCode)];
  }
  const order = waves.flat();
  const domains = [...map.domains].sort((left, right) => order.indexOf(left.domainCode) - order.indexOf(right.domainCode));
  return domains.map((domain) => {
    const values = new Set<string>();
    for (const row of rows) {
      const code = (row[domain.identityColumn] || '').trim();
      if (code) values.add(code);
    }
    const label = RECORD_LABELS[domain.domainCode] || titleCase(domain.domainCode);
    const identifiedBy = domain.nameColumn && domain.nameColumn !== domain.identityColumn
      ? `${label.replace(/s$/, '')} · Name`
      : `${label.replace(/s$/, '')} · Code`;
    const parents = [...new Set(domain.parents.map((parent) => RECORD_LABELS[parent.parentDomainCode] || titleCase(parent.parentDomainCode)))];
    return {
      domainCode: domain.domainCode,
      label,
      identifiedBy,
      count: values.size,
      needs: parents.length === 0 ? 'Nothing, loads first' : parents.join(', '),
    };
  });
}

function columnDomain(map: FeedMap, column: string): string | null {
  const key = column.toLowerCase();
  for (const domain of map.domains) {
    const columns = [
      domain.identityColumn,
      domain.nameColumn,
      ...domain.attributes.map((attribute) => attribute.column),
      ...domain.parents.map((parent) => parent.column),
    ];
    if (columns.some((item) => item.toLowerCase() === key)) return domain.domainCode;
  }
  return null;
}

function describeChanges(
  reused: FeedMap | null,
  diff: { added: string[]; missing: string[] } | null,
  assignments: ColumnAssignment[],
  unmapped: UnmappedColumn[]
): MapChange[] {
  if (!reused || !diff) return [];
  const changes: MapChange[] = [];
  for (const column of diff.added) {
    const assignment = assignments.find((item) => item.sourceColumn === column);
    const pending = unmapped.find((item) => item.column === column);
    const domainCode = assignment?.domainCode || pending?.domainCode || null;
    let note = 'New field. I could not place it on an entity.';
    if (assignment?.role === 'attribute' && assignment.attributeCode) note = `New field. Mapped to ${assignment.attributeCode} on ${domainCode}.`;
    else if (assignment?.role === 'identity') note = `New field. It identifies ${domainCode}.`;
    else if (assignment?.role === 'name') note = `New field. It names ${domainCode}.`;
    else if (pending?.recommendationId) note = 'New field. It does not match an attribute, so I recommended one.';
    else if (pending) note = pending.reason;
    changes.push({ column, change: 'added', domainCode, note });
  }
  for (const column of diff.missing) {
    changes.push({
      column,
      change: 'missing',
      domainCode: columnDomain(reused, column),
      note: `On the ${reused.name} map, but not in this file.`,
    });
  }
  return changes;
}

function dominantDomain(assignments: ColumnAssignment[]): string | null {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    if (!assignment.domainCode || assignment.role === 'ignore') continue;
    counts.set(assignment.domainCode, (counts.get(assignment.domainCode) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

function mapIdentity(reused: FeedMap | null, source: { code: string; name: string } | null, fileName: string): FeedMapIdentity | null {
  if (reused) {
    return {
      mapCode: reused.mapCode,
      sourceCode: reused.sourceCode,
      name: reused.name,
      description: reused.description,
    };
  }
  if (!source) return null;
  return {
    mapCode: slugCode(`${source.code}_MAP`, 100),
    sourceCode: source.code,
    name: `${source.name} map`,
    description: `Learned from ${fileName}. Parents load before the rows that reference them.`,
  };
}

function applyStubChoices(map: FeedMap, answers: Record<string, string>): { map: FeedMap; questions: SpecialistQuestion[] } {
  const domains = map.domains.map((domain) => ({
    ...domain,
    attributes: [...domain.attributes],
    parents: [...domain.parents],
  }));
  const stubs = domains.filter(isStub);
  const subjects = domains.filter((domain) => !isStub(domain));
  if (stubs.length === 0 || subjects.length === 0) return { map: { ...map, domains }, questions: [] };
  const questions: SpecialistQuestion[] = [];
  const kept: FeedDomainSpec[] = [...subjects];
  for (const stub of stubs) {
    const id = `stub:${stub.domainCode}`;
    const asked = question(
      {
        id,
        kind: 'stub',
        prompt: `${stub.domainCode} shows up only as “${stub.identityColumn}”.`,
        detail: 'I can match or create those entities, or only link to ones you already have.',
        required: false,
        options: [
          { id: 'create', label: `Match or create ${stub.domainCode}` },
          { id: 'link', label: `Only link to ${stub.domainCode} already stored` },
        ],
      },
      answers,
      'create'
    );
    questions.push(asked);
    if (asked.answer === 'link') {
      for (const subject of subjects) {
        if (subject.parents.some((parent) => parent.parentDomainCode === stub.domainCode)) continue;
        subject.parents.push({ column: stub.identityColumn, parentDomainCode: stub.domainCode, existing: true });
      }
      continue;
    }
    kept.push(stub);
    for (const subject of subjects) {
      if (subject.parents.some((parent) => parent.parentDomainCode === stub.domainCode)) continue;
      subject.parents.push({ column: stub.identityColumn, parentDomainCode: stub.domainCode });
    }
  }
  return { map: { ...map, domains: kept }, questions };
}

/** A new entity on the same row as a known entity id points at that entity. */
function linkKnownParents(map: FeedMap, knownDomains: Set<string>): FeedMap {
  const domains = map.domains.map((domain) => ({
    ...domain,
    attributes: [...domain.attributes],
    parents: [...domain.parents],
  }));
  for (const parent of domains) {
    if (!knownDomains.has(parent.domainCode) || !parent.identityColumn) continue;
    const parentTokens = tokens(parent.identityColumn);
    if (!aliases(parent.domainCode).some((alias) => parentTokens.includes(alias))) continue;
    for (const child of domains) {
      if (child.domainCode === parent.domainCode || knownDomains.has(child.domainCode)) continue;
      if (child.parents.some((link) => link.parentDomainCode === parent.domainCode)) continue;
      child.parents.push({ column: parent.identityColumn, parentDomainCode: parent.domainCode });
    }
  }
  return { ...map, domains };
}
