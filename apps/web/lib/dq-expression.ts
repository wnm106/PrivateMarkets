import { attributeDisplayKind } from './attribute-display';
import { DQ_DATE_FNS } from './expression-library';

export { DQ_DATE_FNS };

export type DqOperator =
  | 'IS NULL'
  | 'IS NOT NULL'
  | '='
  | '!='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'IN'
  | '~'
  | 'LIKE'
  | 'ILIKE';

export type DqJoin = 'AND' | 'OR';
export type DqValueKind = 'number' | 'text' | 'current_date' | 'attribute' | 'relative';
export type DqLiteralKind = 'number' | 'text' | 'date' | 'boolean';
export type DqDateFn =
  | 'as_of'
  | 'previous_day'
  | 'start_of_month'
  | 'end_of_month'
  | 'start_of_quarter'
  | 'end_of_quarter'
  | 'start_of_year'
  | 'end_of_year';

export interface DqClause {
  id: string;
  join: DqJoin | null;
  attribute: string;
  operator: DqOperator;
  valueKind: DqValueKind;
  value: string;
  values: string[];
  /** Set when the comparison date is the as-of date, or a function of the as-of date or another attribute. */
  dateFn: DqDateFn | null;
}

export const DQ_OPERATORS: Array<{ value: DqOperator; label: string; hint: string }> = [
  { value: 'IS NOT NULL', label: 'is present', hint: 'The attribute has a value.' },
  { value: 'IS NULL', label: 'is blank', hint: 'A blank value passes. Use or when a missing value should not fail the other checks.' },
  { value: '=', label: 'equals', hint: 'Compare with a value or another attribute.' },
  { value: '!=', label: 'does not equal', hint: 'Compare with a value or another attribute.' },
  { value: '>', label: 'is greater than', hint: 'Compare with a value or another attribute.' },
  { value: '>=', label: 'is at least', hint: 'Compare with a value or another attribute.' },
  { value: '<', label: 'is less than', hint: 'Compare with a value or another attribute.' },
  { value: '<=', label: 'is at most', hint: 'Compare with a value or another attribute.' },
  { value: 'IN', label: 'is one of', hint: 'Matching ignores case. Paste a list to add many values at once.' },
  { value: '~', label: 'matches pattern', hint: 'A regular expression, such as ^[A-Z]{2}$ for two letters.' },
  { value: 'LIKE', label: 'is like', hint: '% matches any text and _ matches one character. Case sensitive.' },
  { value: 'ILIKE', label: 'is like, ignoring case', hint: 'Same as is like, without case sensitivity.' },
];

export const DQ_REFERENCES: Array<{ token: string; detail: string }> = [
  { token: 'CURRENT_DATE', detail: 'The as-of date of the quality check, not the clock at the moment you save the rule.' },
  { token: 'PREVIOUS_DAY(date)', detail: 'The day before a date. PREVIOUS_DAY(CURRENT_DATE) is yesterday relative to the as-of date. The date can also be another attribute.' },
  { token: 'START_OF_MONTH(date) / END_OF_MONTH(date)', detail: 'The first or last day of the month containing that date.' },
  { token: 'START_OF_QUARTER(date) / END_OF_QUARTER(date)', detail: 'The first or last day of the calendar quarter containing that date.' },
  { token: 'START_OF_YEAR(date) / END_OF_YEAR(date)', detail: 'The first or last day of the calendar year containing that date.' },
  { token: 'Attribute', detail: 'Another attribute on the same record, for example INTEREST_COVERAGE_RATIO >= MIN_INTEREST_COVERAGE.' },
  { token: 'AND', detail: 'Both conditions must pass. AND is applied before OR.' },
  { token: 'OR', detail: 'Either side can pass. Use this with “is blank” so a missing value does not fail a format check.' },
  { token: 'IS NULL', detail: 'The attribute is blank.' },
  { token: 'IS NOT NULL', detail: 'The attribute has a value.' },
  { token: 'IN', detail: "One of a quoted list, for example COUNTRY IN ('US', 'GB')." },
  { token: '~', detail: "A regular expression in quotes, for example ISIN ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'." },
  { token: 'LIKE / ILIKE', detail: 'A pattern in quotes. % matches any text and _ matches one character.' },
];

const COMPARISON = new Set<DqOperator>(['=', '!=', '<>', '>', '>=', '<', '<=']);
const DATE_FN_PATTERN = 'PREVIOUS_DAY|START_OF_MONTH|END_OF_MONTH|START_OF_QUARTER|END_OF_QUARTER|START_OF_YEAR|END_OF_YEAR';
const RESERVED_RHS = new Set([
  'AND', 'OR', 'IS', 'NULL', 'NOT', 'IN', 'LIKE', 'ILIKE', 'TRUE', 'FALSE', 'CURRENT_DATE', 'YESTERDAY',
  ...DATE_FN_PATTERN.split('|'),
]);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function literalKindFor(dataType?: string | null): DqLiteralKind {
  const kind = attributeDisplayKind({ dataType });
  if (kind === 'date') return 'date';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'text') return 'text';
  return 'number';
}

export function dateFnByToken(token: string): DqDateFn | null {
  const key = token.trim().toUpperCase();
  if (key === 'YESTERDAY') return 'previous_day';
  return (DQ_DATE_FNS.find((item) => item.token === key)?.value as DqDateFn | undefined) || null;
}

export function operatorNeedsValue(operator: DqOperator) {
  return operator !== 'IS NULL' && operator !== 'IS NOT NULL';
}

export function newClause(join: DqJoin | null = null): DqClause {
  return {
    id: Math.random().toString(36).slice(2, 10),
    join,
    attribute: '',
    operator: 'IS NOT NULL',
    valueKind: 'text',
    value: '',
    values: [],
    dateFn: null,
  };
}

function quote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function unquote(value: string) {
  return value.replace(/''/g, "'");
}

function dateFnMeta(dateFn: DqDateFn | null) {
  return DQ_DATE_FNS.find((item) => item.value === (dateFn || 'as_of')) || DQ_DATE_FNS[0];
}

export function serializeClauses(clauses: DqClause[]): string {
  return clauses
    .filter((clause) => clause.attribute.trim())
    .map((clause, index) => {
      const join = index === 0 || !clause.join ? '' : `${clause.join} `;
      return join + serializeClause(clause);
    })
    .filter(Boolean)
    .join(' ');
}

function serializeDateCall(dateFn: DqDateFn | null, argument: string): string {
  const arg = argument.trim() || 'CURRENT_DATE';
  if (!dateFn || dateFn === 'as_of') return arg === 'CURRENT_DATE' ? 'CURRENT_DATE' : arg;
  const token = dateFnMeta(dateFn).token;
  return `${token}(${arg})`;
}

function serializeClause(clause: DqClause): string {
  const attribute = clause.attribute.trim();
  if (!attribute) return '';
  if (clause.operator === 'IS NULL' || clause.operator === 'IS NOT NULL') return `${attribute} ${clause.operator}`;
  if (clause.operator === 'IN') {
    const items = clause.values.map((item) => item.trim()).filter(Boolean);
    if (!items.length) return '';
    return `${attribute} IN (${items.map(quote).join(', ')})`;
  }
  if (clause.operator === '~' || clause.operator === 'LIKE' || clause.operator === 'ILIKE') {
    if (!clause.value) return '';
    const op = clause.operator === '~' ? '~' : clause.operator;
    return `${attribute} ${op} ${quote(clause.value)}`;
  }
  if (clause.valueKind === 'current_date' || clause.valueKind === 'relative') {
    return `${attribute} ${clause.operator} ${serializeDateCall(clause.dateFn, '')}`;
  }
  if (clause.valueKind === 'attribute') {
    const code = clause.value.trim();
    if (!code) return '';
    const target = clause.dateFn && clause.dateFn !== 'as_of' ? serializeDateCall(clause.dateFn, code) : code;
    return `${attribute} ${clause.operator} ${target}`;
  }
  if (clause.valueKind === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(clause.value.trim())) return '';
    return `${attribute} ${clause.operator} ${clause.value.trim()}`;
  }
  if (!clause.value) return '';
  return `${attribute} ${clause.operator} ${quote(clause.value)}`;
}

function joinWords(values: string[]): string {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function previewList(values: string[]): string {
  if (values.length <= 4) return joinWords(values);
  return `${values.slice(0, 4).join(', ')}, and ${values.length - 4} more`;
}

function formatIsoDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

export function rhsText(clause: DqClause): string {
  if (clause.valueKind === 'current_date' || clause.valueKind === 'relative') return serializeDateCall(clause.dateFn, '');
  if (clause.valueKind === 'attribute') {
    const code = clause.value.trim();
    if (!code) return '';
    return clause.dateFn && clause.dateFn !== 'as_of' ? serializeDateCall(clause.dateFn, code) : code;
  }
  if (!clause.value) return '';
  if (clause.valueKind === 'number' || clause.value === 'true' || clause.value === 'false') return clause.value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clause.value.trim())) return clause.value.trim();
  return `'${clause.value.replace(/'/g, "''")}'`;
}

export function applyRhs(clause: DqClause, raw: string): Partial<DqClause> | null {
  const text = raw.trim();
  if (!text) return { value: '', valueKind: 'text', dateFn: null };
  const parsed = parseRhs(text, clause, clause.operator);
  if (!parsed) return null;
  return { valueKind: parsed.valueKind, value: parsed.value, dateFn: parsed.dateFn };
}

export function describeComparisonTarget(clause: DqClause, nameFor: (code: string) => string = (code) => code): string {
  if (clause.valueKind === 'current_date' || clause.valueKind === 'relative') {
    return dateFnMeta(clause.dateFn).asOfPhrase;
  }
  if (clause.valueKind === 'attribute') {
    const name = clause.value.trim() ? nameFor(clause.value.trim()) : 'another attribute';
    if (!clause.dateFn || clause.dateFn === 'as_of') return name;
    return dateFnMeta(clause.dateFn).wrapPhrase(name);
  }
  if (!clause.value.trim()) return clause.valueKind === 'number' ? 'a number' : 'a value';
  if (clause.valueKind === 'number') return clause.value.trim();
  if (clause.value === 'true') return 'yes';
  if (clause.value === 'false') return 'no';
  if (/^\d{4}-\d{2}-\d{2}$/.test(clause.value.trim())) return formatIsoDate(clause.value.trim());
  return `“${clause.value.trim()}”`;
}

export function comparisonHint(clause: DqClause): string | null {
  if (!isComparison(clause.operator)) return null;
  if (clause.valueKind === 'current_date' || clause.valueKind === 'relative') {
    return dateFnMeta(clause.dateFn).hint;
  }
  if (clause.valueKind !== 'attribute') return null;
  if (!clause.dateFn || clause.dateFn === 'as_of') return 'Compared with that attribute on the same record.';
  return dateFnMeta(clause.dateFn).wrapHint;
}

export function describeClause(clause: DqClause, name: string, nameFor: (code: string) => string = (code) => code): string {
  const subject = name.trim() || 'this attribute';
  const op = DQ_OPERATORS.find((item) => item.value === clause.operator)?.label || clause.operator.toLowerCase();
  if (!operatorNeedsValue(clause.operator)) return `${subject} ${op}`;
  if (clause.operator === 'IN') {
    const values = clause.values.map((item) => item.trim()).filter(Boolean);
    return values.length ? `${subject} ${op} ${previewList(values)}` : `${subject} ${op} the values you add`;
  }
  if (clause.operator === '~' || clause.operator === 'LIKE' || clause.operator === 'ILIKE') {
    return clause.value ? `${subject} ${op} “${clause.value}”` : `${subject} ${op} a pattern`;
  }
  return `${subject} ${op} ${describeComparisonTarget(clause, nameFor)}`;
}

export function describeRule(clauses: DqClause[], nameFor: (code: string) => string): string {
  const ready = clauses.filter((clause) => !clauseIssue(clause));
  if (!ready.length) return 'Choose an attribute and a check. This sentence updates as you build the rule.';
  const sentence = ready
    .map((clause, index) => {
      const text = describeClause(clause, nameFor(clause.attribute), nameFor);
      if (index === 0) return text;
      const join = clause.join === 'OR' ? 'or' : 'and';
      return `${join} ${text}`;
    })
    .join(', ');
  return `${sentence}.`;
}

export function formatExpression(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed) return '';
  const parsed = parseExpression(trimmed);
  if (parsed.raw) return trimmed;
  return parsed.clauses
    .map((clause, index) => {
      const body = serializeClauses([{ ...clause, join: null }]);
      if (!body) return '';
      return index === 0 ? body : `${clause.join || 'AND'}\n${body}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function clauseIssue(clause: DqClause, dataType?: string | null): string | null {
  if (!clause.attribute.trim()) return 'Choose an attribute.';
  if (!operatorNeedsValue(clause.operator)) return null;
  if (clause.operator === 'IN') return clause.values.some((item) => item.trim()) ? null : 'Add at least one allowed value.';
  if (clause.operator === '~' || clause.operator === 'LIKE' || clause.operator === 'ILIKE') {
    return clause.value ? null : 'Enter the pattern.';
  }
  if (clause.valueKind === 'current_date' || clause.valueKind === 'relative') return null;
  if (clause.valueKind === 'attribute') return clause.value.trim() ? null : 'Choose an attribute to compare with.';
  if (clause.valueKind === 'number') {
    return /^-?\d+(\.\d+)?$/.test(clause.value.trim()) ? null : 'Enter a number.';
  }
  const kind = dataType ? literalKindFor(dataType) : 'text';
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(clause.value.trim()) ? null : 'Choose a date.';
  if (kind === 'boolean') return clause.value === 'true' || clause.value === 'false' ? null : 'Choose yes or no.';
  return clause.value ? null : 'Enter the text to compare.';
}

interface RawPart {
  join: DqJoin | null;
  text: string;
}

function splitJoins(expression: string): RawPart[] {
  const source = expression.trim();
  const parts: RawPart[] = [];
  let buffer = '';
  let quoted = false;
  let pending: DqJoin | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'") {
      buffer += char;
      if (quoted && source[index + 1] === "'") {
        buffer += source[index + 1];
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (!quoted) {
      const match = source.slice(index).match(/^\s+(AND|OR)\s+/i);
      if (match && buffer.trim()) {
        parts.push({ join: pending, text: buffer.trim() });
        pending = match[1].toUpperCase() as DqJoin;
        buffer = '';
        index += match[0].length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  if (buffer.trim()) parts.push({ join: pending, text: buffer.trim() });
  return parts;
}

function parseRhs(raw: string, clause: DqClause, operator: DqOperator): DqClause | null {
  if (/^CURRENT_DATE$/i.test(raw)) {
    return { ...clause, operator, valueKind: 'relative', value: '', dateFn: 'as_of' };
  }
  if (/^YESTERDAY$/i.test(raw)) {
    return { ...clause, operator, valueKind: 'relative', value: '', dateFn: 'previous_day' };
  }
  let match = raw.match(new RegExp(`^(${DATE_FN_PATTERN})$`, 'i'));
  if (match) {
    const dateFn = dateFnByToken(match[1]);
    return dateFn ? { ...clause, operator, valueKind: 'relative', value: '', dateFn } : null;
  }
  match = raw.match(new RegExp(`^(${DATE_FN_PATTERN})\\s*\\(\\s*(CURRENT_DATE|[A-Za-z_][A-Za-z0-9_]*)\\s*\\)$`, 'i'));
  if (match) {
    const dateFn = dateFnByToken(match[1]);
    if (!dateFn) return null;
    if (/^CURRENT_DATE$/i.test(match[2])) {
      return { ...clause, operator, valueKind: 'relative', value: '', dateFn };
    }
    return { ...clause, operator, valueKind: 'attribute', value: match[2], dateFn };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return { ...clause, operator, valueKind: 'number', value: raw, dateFn: null };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ...clause, operator, valueKind: 'text', value: raw, dateFn: null };
  }
  if (/^(true|false)$/i.test(raw)) {
    return { ...clause, operator, valueKind: 'text', value: raw.toLowerCase(), dateFn: null };
  }
  match = raw.match(/^'((?:[^']|'')*)'$/);
  if (match) {
    return { ...clause, operator, valueKind: 'text', value: unquote(match[1]), dateFn: null };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && !RESERVED_RHS.has(raw.toUpperCase())) {
    return { ...clause, operator, valueKind: 'attribute', value: raw, dateFn: null };
  }
  return null;
}

function parseOne(text: string): DqClause | null {
  const clause = newClause();
  let match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+NOT\s+NULL$/i);
  if (match) return { ...clause, attribute: match[1], operator: 'IS NOT NULL' };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+NULL$/i);
  if (match) return { ...clause, attribute: match[1], operator: 'IS NULL' };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*~\s*'((?:[^']|'')*)'$/i);
  if (match) return { ...clause, attribute: match[1], operator: '~', valueKind: 'text', value: unquote(match[2]), dateFn: null };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(I?LIKE)\s*'((?:[^']|'')*)'$/i);
  if (match) {
    return {
      ...clause,
      attribute: match[1],
      operator: match[2].toUpperCase() as DqOperator,
      valueKind: 'text',
      value: unquote(match[3]),
      dateFn: null,
    };
  }
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.*)\)\s*$/i);
  if (match) {
    const values = [...match[2].matchAll(/'((?:[^']|'')*)'/g)].map((item) => unquote(item[1]));
    if (!values.length) return null;
    return { ...clause, attribute: match[1], operator: 'IN', values, dateFn: null };
  }
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/i);
  if (match) {
    const operator = (match[2] === '<>' ? '!=' : match[2]) as DqOperator;
    const parsed = parseRhs(match[3].trim(), clause, operator);
    if (!parsed) return null;
    parsed.attribute = match[1];
    return parsed;
  }
  return null;
}

export function parseExpression(expression: string): { clauses: DqClause[]; raw: boolean } {
  const trimmed = expression.trim();
  if (!trimmed) return { clauses: [newClause()], raw: false };
  const parts = splitJoins(trimmed);
  const clauses: DqClause[] = [];
  for (const part of parts) {
    const clause = parseOne(part.text);
    if (!clause) return { clauses: [newClause()], raw: true };
    clause.join = clauses.length ? part.join || 'AND' : null;
    clauses.push(clause);
  }
  return { clauses: clauses.length ? clauses : [newClause()], raw: false };
}

export function isComparison(operator: DqOperator) {
  return COMPARISON.has(operator);
}
