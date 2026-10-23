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
export type DqValueKind = 'number' | 'text' | 'current_date';

export interface DqClause {
  id: string;
  join: DqJoin | null;
  attribute: string;
  operator: DqOperator;
  valueKind: DqValueKind;
  value: string;
  values: string[];
}

export const DQ_OPERATORS: Array<{ value: DqOperator; label: string; hint: string }> = [
  { value: 'IS NOT NULL', label: 'is present', hint: 'The attribute has a value.' },
  { value: 'IS NULL', label: 'is blank', hint: 'A blank value passes. Use or when a missing value should not fail the other checks.' },
  { value: '=', label: 'equals', hint: 'Compare with a number, text, or the as-of date.' },
  { value: '!=', label: 'does not equal', hint: 'Compare with a number, text, or the as-of date.' },
  { value: '>', label: 'is greater than', hint: 'Compare with a number, text, or the as-of date.' },
  { value: '>=', label: 'is at least', hint: 'Compare with a number, text, or the as-of date.' },
  { value: '<', label: 'is less than', hint: 'Compare with a number, text, or the as-of date.' },
  { value: '<=', label: 'is at most', hint: 'Compare with a number, text, or the as-of date.' },
  { value: 'IN', label: 'is one of', hint: 'Matching ignores case. Paste a list to add many values at once.' },
  { value: '~', label: 'matches pattern', hint: 'A regular expression, such as ^[A-Z]{2}$ for two letters.' },
  { value: 'LIKE', label: 'is like', hint: '% matches any text and _ matches one character. Case sensitive.' },
  { value: 'ILIKE', label: 'is like, ignoring case', hint: 'Same as is like, without case sensitivity.' },
];

export const DQ_REFERENCES: Array<{ token: string; detail: string }> = [
  { token: 'CURRENT_DATE', detail: 'The as-of date of the quality check, not the clock at the moment you save the rule.' },
  { token: 'AND', detail: 'Both conditions must pass. AND is applied before OR.' },
  { token: 'OR', detail: 'Either side can pass. Use this with “is blank” so a missing value does not fail a format check.' },
  { token: 'IS NULL', detail: 'The attribute is blank.' },
  { token: 'IS NOT NULL', detail: 'The attribute has a value.' },
  { token: 'IN', detail: "One of a quoted list, for example COUNTRY IN ('US', 'GB')." },
  { token: '~', detail: "A regular expression in quotes, for example ISIN ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'." },
  { token: 'LIKE / ILIKE', detail: 'A pattern in quotes. % matches any text and _ matches one character.' },
];

const COMPARISON = new Set<DqOperator>(['=', '!=', '<>', '>', '>=', '<', '<=']);

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
  };
}

function quote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function unquote(value: string) {
  return value.replace(/''/g, "'");
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
  if (clause.valueKind === 'current_date') return `${attribute} ${clause.operator} CURRENT_DATE`;
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

export function describeClause(clause: DqClause, name: string): string {
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
  if (clause.valueKind === 'current_date') return `${subject} ${op} the as-of date`;
  if (!clause.value.trim()) return `${subject} ${op} a ${clause.valueKind === 'number' ? 'number' : 'value'}`;
  const shown = clause.valueKind === 'number' ? clause.value.trim() : `“${clause.value.trim()}”`;
  return `${subject} ${op} ${shown}`;
}

export function describeRule(clauses: DqClause[], nameFor: (code: string) => string): string {
  const ready = clauses.filter((clause) => !clauseIssue(clause));
  if (!ready.length) return 'Choose an attribute and a check. This sentence updates as you build the rule.';
  const sentence = ready
    .map((clause, index) => {
      const text = describeClause(clause, nameFor(clause.attribute));
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

export function clauseIssue(clause: DqClause): string | null {
  if (!clause.attribute.trim()) return 'Choose an attribute.';
  if (!operatorNeedsValue(clause.operator)) return null;
  if (clause.operator === 'IN') return clause.values.some((item) => item.trim()) ? null : 'Add at least one allowed value.';
  if (clause.operator === '~' || clause.operator === 'LIKE' || clause.operator === 'ILIKE') {
    return clause.value ? null : 'Enter the pattern.';
  }
  if (clause.valueKind === 'current_date') return null;
  if (clause.valueKind === 'number') {
    return /^-?\d+(\.\d+)?$/.test(clause.value.trim()) ? null : 'Enter a number.';
  }
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

function parseOne(text: string): DqClause | null {
  const clause = newClause();
  let match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+NOT\s+NULL$/i);
  if (match) return { ...clause, attribute: match[1], operator: 'IS NOT NULL' };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+NULL$/i);
  if (match) return { ...clause, attribute: match[1], operator: 'IS NULL' };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*~\s*'((?:[^']|'')*)'$/i);
  if (match) return { ...clause, attribute: match[1], operator: '~', valueKind: 'text', value: unquote(match[2]) };
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(I?LIKE)\s*'((?:[^']|'')*)'$/i);
  if (match) {
    return {
      ...clause,
      attribute: match[1],
      operator: match[2].toUpperCase() as DqOperator,
      valueKind: 'text',
      value: unquote(match[3]),
    };
  }
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.*)\)\s*$/i);
  if (match) {
    const values = [...match[2].matchAll(/'((?:[^']|'')*)'/g)].map((item) => unquote(item[1]));
    if (!values.length) return null;
    return { ...clause, attribute: match[1], operator: 'IN', values };
  }
  match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|=|>|<)\s*(CURRENT_DATE|-?\d+(?:\.\d+)?|'[^']*')\s*$/i);
  if (match) {
    const operator = (match[2] === '<>' ? '!=' : match[2]) as DqOperator;
    const raw = match[3];
    if (/^CURRENT_DATE$/i.test(raw)) {
      return { ...clause, attribute: match[1], operator, valueKind: 'current_date', value: '' };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      return { ...clause, attribute: match[1], operator, valueKind: 'number', value: raw };
    }
    return { ...clause, attribute: match[1], operator, valueKind: 'text', value: unquote(raw.slice(1, -1)) };
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
