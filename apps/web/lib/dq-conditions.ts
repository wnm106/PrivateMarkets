// Data quality rules are stored as one line of text: ISIN IS NOT NULL AND COUNTRY IN ('US', 'GB') OR ...
// The condition builder edits rows. These helpers turn one into the other.
//
// A row is a ComplianceCondition. Groups are joined by OR, and the rows inside a group are
// joined by AND, which is how the stored line reads (AND is applied before OR). A group set to
// "ANY of these" is written as OR between its rows, which reads the same way.

import type { ComplianceCondition } from '@/components/forms/ComplianceRuleForm';
import type { ConditionOperator } from '@/components/forms/ConditionBuilder';
import {
  EXPRESSION_PLACEHOLDER_CODE,
  applyLeftText,
  emptyReadSettings,
  type OperandContext,
  type OperandField,
} from './condition-expression';
import {
  type DqClause,
  type DqOperator,
  applyRhs,
  clauseIssue,
  isComparison,
  isListOperator,
  isPatternOperator,
  newClause,
  parseExpression,
  rhsText,
  serializeClauses,
} from './dq-expression';

const TO_ROW: Record<string, string> = {
  'IS NULL': 'is_null',
  'IS NOT NULL': 'is_not_null',
  '=': 'equals',
  '!=': 'not_equals',
  '<>': 'not_equals',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  IN: 'in',
  'NOT IN': 'not_in',
  '~': 'matches',
  '!~': 'not_matches',
  LIKE: 'like',
  ILIKE: 'ilike',
};

const FROM_ROW: Record<string, DqOperator> = {
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
  equals: '=',
  not_equals: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'IN',
  not_in: 'NOT IN',
  matches: '~',
  not_matches: '!~',
  like: 'LIKE',
  ilike: 'ILIKE',
};

export const DQ_CONDITION_OPERATORS: ConditionOperator[] = [
  { value: 'is_not_null', label: 'is present' },
  { value: 'is_null', label: 'is blank' },
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'matches', label: 'matches pattern', plainValue: true, placeholder: '^[A-Z]{2}$' },
  { value: 'not_matches', label: 'does not match pattern', plainValue: true, placeholder: '^[A-Z]{3}$' },
  { value: 'like', label: 'is like', plainValue: true, placeholder: '%USD%' },
  { value: 'ilike', label: 'is like, ignoring case', plainValue: true, placeholder: '%usd%' },
];

const PLAIN = new Set(['matches', 'not_matches', 'like', 'ilike']);
const NO_VALUE = new Set(['is_null', 'is_not_null']);
export const DQ_RIGHT_HINT = 'Use a value, another attribute, or a date such as END_OF_MONTH(CURRENT_DATE).';

export interface DqAttribute {
  attributeCode: string;
  attributeName: string;
  domainCode: string | null;
  dataType?: string | null;
}

/** Fields the builder can pick: attributes of the record itself, one per code. */
export function dqOperandContext(attributes: DqAttribute[], domainName: (code: string) => string): OperandContext {
  const seen = new Set<string>();
  const fields: OperandField[] = [];
  for (const attribute of attributes) {
    if (seen.has(attribute.attributeCode)) continue;
    seen.add(attribute.attributeCode);
    fields.push({
      attributeCode: attribute.attributeCode,
      attributeName: attribute.attributeName,
      dataType: attribute.dataType || '',
      domainCode: attribute.domainCode || '',
      groupLabel: attribute.domainCode ? domainName(attribute.domainCode) : 'Shared',
      path: [],
      valueKey: attribute.attributeCode,
    });
  }
  return { fields, relationshipTypes: [] };
}

function quoteText(value: string) {
  if (value === 'true' || value === 'false') return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function splitList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').trim())
    .filter(Boolean);
}

function rowRightText(clause: DqClause): string {
  if (!(clause.operator === 'IS NULL' || clause.operator === 'IS NOT NULL')) {
    if (isListOperator(clause.operator)) return clause.values.join(', ');
    if (isPatternOperator(clause.operator)) return clause.value;
    if (clause.valueKind === 'text' && clause.value) return quoteText(clause.value);
    return rhsText(clause);
  }
  return '';
}

/** The stored line as builder rows. raw is true when the line uses something the builder cannot show. */
export function rowsFromExpression(expression: string): { rows: ComplianceCondition[]; raw: boolean } {
  if (!expression.trim()) return { rows: [], raw: false };
  const parsed = parseExpression(expression);
  if (parsed.raw) return { rows: [], raw: true };
  // Split at each OR. Neighbouring groups of one check are the same as one "any of these" group.
  const chunks: DqClause[][] = [];
  parsed.clauses.forEach((clause, index) => {
    if (index === 0 || clause.join === 'OR') chunks.push([clause]);
    else chunks[chunks.length - 1].push(clause);
  });
  const groups: Array<{ clauses: DqClause[]; any: boolean }> = [];
  for (const chunk of chunks) {
    const last = groups[groups.length - 1];
    if (chunk.length === 1 && last && (last.any || last.clauses.length === 1)) {
      last.clauses.push(chunk[0]);
      last.any = true;
    } else {
      groups.push({ clauses: chunk, any: false });
    }
  }
  const rows = groups.flatMap((group, groupIndex) => group.clauses.map((clause, order): ComplianceCondition => {
    const operator = TO_ROW[clause.operator] || 'equals';
    const right = rowRightText(clause);
    return {
      key: clause.id,
      appliesTo: 'BASE',
      conditionGroup: groupIndex + 1,
      conditionOrder: order + 1,
      attributeCode: clause.attribute,
      attributePath: [],
      attributeDimension: emptyReadSettings(),
      operator,
      value: right,
      compareAttributeCode: '',
      compareAttributePath: [],
      compareDimension: emptyReadSettings(),
      leftExpression: null,
      rightExpression: null,
      leftText: clause.attribute,
      rightText: right,
      logicOperator: group.any && order > 0 ? 'OR' : 'AND',
    };
  }));
  return { rows, raw: false };
}

/** What a right-hand text means in a stored rule, or why it cannot be used. */
export function dqPatchRight(text: string, operator: string): Partial<ComplianceCondition> {
  const cleared = { value: text, compareAttributeCode: '', compareAttributePath: [], rightExpression: null, rightError: undefined };
  if (NO_VALUE.has(operator) || PLAIN.has(operator) || operator === 'in' || !text.trim()) return cleared;
  const patch = applyRhs({ ...newClause(), operator: FROM_ROW[operator] || '=' }, text.trim());
  return patch ? cleared : { ...cleared, rightError: DQ_RIGHT_HINT };
}

export function dqPatchLeft(text: string, ctx: OperandContext): Partial<ComplianceCondition> {
  const r = applyLeftText(text, ctx);
  const attributeCode = r.attributeCode === EXPRESSION_PLACEHOLDER_CODE ? '' : r.attributeCode;
  return {
    leftError: r.error || (r.attributeCode === EXPRESSION_PLACEHOLDER_CODE ? 'Pick an attribute on this record.' : undefined),
    attributeCode,
    attributePath: [],
    leftExpression: null,
  };
}

/** Builder rows as the stored line, with the first problem that stops it being saved. */
export function rowsToExpression(
  rows: ComplianceCondition[],
  dataTypeOf: (code: string) => string | null | undefined = () => null,
): { expression: string; issue: string | null } {
  if (!rows.length) return { expression: '', issue: null };
  const ordered = [...rows].sort((a, b) => (a.conditionGroup || 1) - (b.conditionGroup || 1) || a.conditionOrder - b.conditionOrder);
  let issue: string | null = null;
  let previousGroup = ordered[0].conditionGroup || 1;
  const clauses = ordered.map((row, index): DqClause => {
    const operator = FROM_ROW[row.operator] || '=';
    const base: DqClause = { ...newClause(), attribute: row.attributeCode, operator };
    const group = row.conditionGroup || 1;
    base.join = index === 0 ? null : group !== previousGroup ? 'OR' : row.logicOperator === 'OR' ? 'OR' : 'AND';
    previousGroup = group;
    const text = (row.rightText ?? row.value ?? '').trim();
    if (isListOperator(operator)) base.values = splitList(text);
    else if (PLAIN.has(row.operator)) base.value = row.rightText ?? row.value ?? '';
    else if (isComparison(operator)) {
      const patch = text ? applyRhs(base, text) : { value: '' };
      if (patch) Object.assign(base, patch);
      else issue = issue || DQ_RIGHT_HINT;
    }
    issue = issue || row.leftError || row.rightError || clauseIssue(base, dataTypeOf(base.attribute)) || null;
    return base;
  });
  return { expression: serializeClauses(clauses), issue };
}

/** Attributes a rule reads, for the preview's columns. */
export function referencedAttributes(rows: ComplianceCondition[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.attributeCode) out.add(row.attributeCode);
    const right = (row.rightText ?? row.value ?? '').trim();
    for (const match of right.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (/^'/.test(right)) break;
      out.add(match[0]);
    }
  }
  return [...out];
}

/** Attributes a stored expression reads, for the preview's columns. */
export function columnsFromExpression(expression: string): string[] {
  const parsed = parseExpression(expression);
  if (parsed.raw) return [];
  const out = new Set<string>();
  for (const clause of parsed.clauses) {
    if (clause.attribute) out.add(clause.attribute);
    if (clause.valueKind === 'attribute' && clause.value.trim()) out.add(clause.value.trim());
  }
  return [...out];
}
