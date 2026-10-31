import { evalNumericExpr, type Expr } from './calc-engine';

export type ToleranceType = 'EXACT' | 'ABSOLUTE' | 'PERCENT';
export type CompareMode = 'SOURCE' | 'PERIOD' | 'BOTH';
export type BreakKind = 'SOURCE' | 'PERIOD' | 'IDENTITY';

export interface MeasureDef {
  attributeCode: string;
  toleranceType: ToleranceType;
  tolerance: number;
  role?: string;
}

export interface IdentityCheck {
  code: string;
  name: string;
  kind: 'EXPRESSION' | 'SUM_RELATED';
  expression?: Expr;
  compareAttributeCode?: string;
  childAttributeCode?: string;
  anchorAttributeCode?: string;
  toleranceType: ToleranceType;
  tolerance: number;
}

export interface LineRef {
  entityId: string;
  entityCode: string;
  entityName: string;
}

export interface StoredValue {
  entityId: string;
  attributeCode: string;
  sourceCode: string;
  sourceName: string;
  value: string | null;
  numeric: number | null;
  precedenceRank: number;
  isGolden: boolean;
  validFrom: string;
  systemFrom: string;
  asOfRole: 'CURRENT' | 'PRIOR';
}

export interface ComparisonCell {
  key: string;
  label: string;
  value: string | null;
  numeric: number | null;
}

export interface ComparisonDraft {
  lineEntityId: string;
  lineCode: string;
  lineName: string;
  attributeCode: string;
  attributeName: string;
  breakKind: BreakKind;
  cells: ComparisonCell[];
  goldenValue: string | null;
  variance: number | null;
  isBreak: boolean;
}

export interface IdentityResult {
  code: string;
  name: string;
  calculated: number | null;
  compareValue: number | null;
  variance: number | null;
  passed: boolean;
  message: string | null;
}

export interface BuildInput {
  anchor: LineRef;
  lines: LineRef[];
  measures: MeasureDef[];
  identityChecks: IdentityCheck[];
  compareMode: CompareMode;
  facts: StoredValue[];
  attributeNames: Record<string, string>;
}

export interface BuildResult {
  lines: ComparisonDraft[];
  identities: IdentityResult[];
}

const TOLERANCES = new Set<ToleranceType>(['EXACT', 'ABSOLUTE', 'PERCENT']);

export function numberOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function comparisonVariance(
  left: { value: string | null; numeric: number | null },
  right: { value: string | null; numeric: number | null },
  toleranceType: ToleranceType,
  tolerance: number,
): { differ: boolean; variance: number | null } {
  const leftEmpty = left.value == null || left.value.trim() === '';
  const rightEmpty = right.value == null || right.value.trim() === '';
  if (leftEmpty && rightEmpty) return { differ: false, variance: null };
  if (leftEmpty || rightEmpty) return { differ: true, variance: null };

  const leftNumber = left.numeric ?? numberOrNull(left.value);
  const rightNumber = right.numeric ?? numberOrNull(right.value);
  if (toleranceType !== 'EXACT' && leftNumber != null && rightNumber != null) {
    const variance = leftNumber - rightNumber;
    const limit = toleranceType === 'PERCENT' ? Math.abs(rightNumber) * tolerance : tolerance;
    return { differ: Math.abs(variance) > limit + 1e-9, variance };
  }
  return { differ: left.value!.trim() !== right.value!.trim(), variance: null };
}

export function pickLatest(rows: StoredValue[]): StoredValue | null {
  if (rows.length === 0) return null;
  return rows.slice().sort((left, right) => {
    const byValid = right.validFrom.localeCompare(left.validFrom);
    if (byValid !== 0) return byValid;
    return right.systemFrom.localeCompare(left.systemFrom);
  })[0];
}

export function withGolden(rows: StoredValue[]): StoredValue[] {
  if (rows.length === 0 || rows.some((row) => row.isGolden)) return rows;
  const winner = rows.reduce((best, row) => (row.precedenceRank < best.precedenceRank ? row : best));
  return rows.map((row) => (row === winner ? { ...row, isGolden: true } : row));
}

function isMeasure(raw: unknown): raw is MeasureDef {
  if (!raw || typeof raw !== 'object') return false;
  const measure = raw as MeasureDef;
  return typeof measure.attributeCode === 'string'
    && TOLERANCES.has(measure.toleranceType)
    && typeof measure.tolerance === 'number';
}

function isExpr(raw: unknown): raw is Expr {
  if (!raw || typeof raw !== 'object') return false;
  const expr = raw as Expr;
  if ('const' in expr) return typeof expr.const === 'number';
  if ('ref' in expr) return typeof expr.ref === 'string';
  if (!('op' in expr) || !Array.isArray(expr.args)) return false;
  if (expr.op === 'neg') return expr.args.length === 1 && isExpr(expr.args[0]);
  return (expr.op === 'add' || expr.op === 'sub' || expr.op === 'mul' || expr.op === 'div')
    && expr.args.length === 2
    && isExpr(expr.args[0])
    && isExpr(expr.args[1]);
}

export function parseMeasures(raw: unknown): MeasureDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMeasure);
}

export function parseIdentityChecks(raw: unknown): IdentityCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const check = item as IdentityCheck;
    if (typeof check.code !== 'string' || typeof check.name !== 'string') return [];
    if (!TOLERANCES.has(check.toleranceType) || typeof check.tolerance !== 'number') return [];
    if (check.kind === 'EXPRESSION' && isExpr(check.expression)) return [check];
    if (check.kind === 'SUM_RELATED' && check.childAttributeCode && check.anchorAttributeCode) return [check];
    return [];
  });
}

export function parseStages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['Select', 'Sync', 'Exception handling', 'Review', 'Approved'];
  const stages = raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return stages.length > 0 ? stages : ['Select', 'Sync', 'Exception handling', 'Review', 'Approved'];
}

function factsFor(facts: StoredValue[], entityId: string, attributeCode: string, role: 'CURRENT' | 'PRIOR'): StoredValue[] {
  return facts.filter((fact) => fact.entityId === entityId && fact.attributeCode === attributeCode && fact.asOfRole === role);
}

function goldenOf(rows: StoredValue[]): StoredValue | null {
  return rows.find((row) => row.isGolden && row.value != null && row.value.trim() !== '')
    || rows.find((row) => row.isGolden)
    || null;
}

function attributeName(names: Record<string, string>, code: string): string {
  return names[code] || code;
}

function sourceDraft(
  line: LineRef,
  measure: MeasureDef,
  rows: StoredValue[],
  names: Record<string, string>,
): ComparisonDraft | null {
  const populated = rows.filter((row) => row.value != null && row.value.trim() !== '');
  if (populated.length < 2) return null;
  const golden = goldenOf(rows);
  const baseline = golden && golden.value?.trim()
    ? golden
    : populated[0];
  let isBreak = false;
  let variance: number | null = null;
  for (const row of populated) {
    if (row.sourceCode === baseline.sourceCode) continue;
    const compared = comparisonVariance(row, baseline, measure.toleranceType, measure.tolerance);
    if (compared.variance != null) {
      variance = variance == null ? compared.variance : Math.abs(compared.variance) > Math.abs(variance) ? compared.variance : variance;
    }
    if (compared.differ) isBreak = true;
  }
  return {
    lineEntityId: line.entityId,
    lineCode: line.entityCode,
    lineName: line.entityName,
    attributeCode: measure.attributeCode,
    attributeName: attributeName(names, measure.attributeCode),
    breakKind: 'SOURCE',
    cells: populated.map((row) => ({
      key: row.sourceCode,
      label: row.sourceName || row.sourceCode,
      value: row.value,
      numeric: row.numeric ?? numberOrNull(row.value),
    })),
    goldenValue: baseline.value,
    variance,
    isBreak,
  };
}

function periodDraft(
  line: LineRef,
  measure: MeasureDef,
  currentRows: StoredValue[],
  priorRows: StoredValue[],
  names: Record<string, string>,
): ComparisonDraft | null {
  const current = goldenOf(currentRows);
  const prior = goldenOf(priorRows);
  const currentValue = current?.value ?? null;
  const priorValue = prior?.value ?? null;
  if ((currentValue == null || currentValue.trim() === '') && (priorValue == null || priorValue.trim() === '')) return null;
  const compared = comparisonVariance(
    { value: currentValue, numeric: current?.numeric ?? null },
    { value: priorValue, numeric: prior?.numeric ?? null },
    measure.toleranceType,
    measure.tolerance,
  );
  return {
    lineEntityId: line.entityId,
    lineCode: line.entityCode,
    lineName: line.entityName,
    attributeCode: measure.attributeCode,
    attributeName: attributeName(names, measure.attributeCode),
    breakKind: 'PERIOD',
    cells: [
      { key: 'PRIOR', label: 'Prior', value: priorValue, numeric: prior?.numeric ?? numberOrNull(priorValue) },
      { key: 'CURRENT', label: 'Current', value: currentValue, numeric: current?.numeric ?? numberOrNull(currentValue) },
    ],
    goldenValue: currentValue,
    variance: compared.variance,
    isBreak: compared.differ,
  };
}

function goldenNumber(facts: StoredValue[], entityId: string, attributeCode: string): number | null {
  const golden = goldenOf(factsFor(facts, entityId, attributeCode, 'CURRENT'));
  if (!golden) return null;
  return golden.numeric ?? numberOrNull(golden.value);
}

function identityLine(anchor: LineRef, check: IdentityCheck, result: IdentityResult): ComparisonDraft {
  return {
    lineEntityId: anchor.entityId,
    lineCode: anchor.entityCode,
    lineName: anchor.entityName,
    attributeCode: check.code,
    attributeName: check.name,
    breakKind: 'IDENTITY',
    cells: [
      { key: 'CALCULATED', label: 'Calculated', value: result.calculated == null ? null : String(result.calculated), numeric: result.calculated },
      { key: 'REPORTED', label: 'Reported', value: result.compareValue == null ? null : String(result.compareValue), numeric: result.compareValue },
    ],
    goldenValue: result.compareValue == null ? null : String(result.compareValue),
    variance: result.variance,
    isBreak: true,
  };
}

export function buildComparisons(input: BuildInput): BuildResult {
  const drafts: ComparisonDraft[] = [];
  const includeSource = input.compareMode === 'SOURCE' || input.compareMode === 'BOTH';
  const includePeriod = input.compareMode === 'PERIOD' || input.compareMode === 'BOTH';

  for (const line of input.lines) {
    for (const measure of input.measures) {
      const current = withGolden(factsFor(input.facts, line.entityId, measure.attributeCode, 'CURRENT'));
      if (includeSource) {
        const draft = sourceDraft(line, measure, current, input.attributeNames);
        if (draft) drafts.push(draft);
      }
      if (includePeriod) {
        const prior = withGolden(factsFor(input.facts, line.entityId, measure.attributeCode, 'PRIOR'));
        const draft = periodDraft(line, measure, current, prior, input.attributeNames);
        if (draft) drafts.push(draft);
      }
    }
  }

  const identities: IdentityResult[] = input.identityChecks.map((check) => {
    let calculated: number | null = null;
    let message: string | null = null;
    if (check.kind === 'EXPRESSION' && check.expression) {
      const refs = new Set<string>();
      const walk = (expr: Expr) => {
        if ('ref' in expr) refs.add(expr.ref);
        else if ('op' in expr) expr.args.forEach(walk);
      };
      walk(check.expression);
      const vars: Record<string, number | null> = {};
      for (const code of refs) vars[code] = goldenNumber(input.facts, input.anchor.entityId, code);
      calculated = evalNumericExpr(check.expression, vars);
      if (calculated == null) message = 'Identity inputs are missing on the fund.';
    } else if (check.kind === 'SUM_RELATED' && check.childAttributeCode) {
      let sum = 0;
      let seen = 0;
      for (const line of input.lines) {
        const value = goldenNumber(input.facts, line.entityId, check.childAttributeCode);
        if (value == null) continue;
        sum += value;
        seen += 1;
      }
      calculated = seen > 0 ? sum : null;
      if (calculated == null) message = 'No related values were available to sum.';
    }

    const compareCode = check.kind === 'SUM_RELATED' ? check.anchorAttributeCode : check.compareAttributeCode;
    const compareValue = compareCode ? goldenNumber(input.facts, input.anchor.entityId, compareCode) : null;
    if (compareValue == null && message == null) message = compareCode ? `${compareCode} has no golden value.` : 'No value to compare.';
    const compared = calculated == null || compareValue == null
      ? { differ: true, variance: null }
      : comparisonVariance(
        { value: String(calculated), numeric: calculated },
        { value: String(compareValue), numeric: compareValue },
        check.toleranceType,
        check.tolerance,
      );
    return {
      code: check.code,
      name: check.name,
      calculated,
      compareValue,
      variance: compared.variance,
      passed: calculated != null && compareValue != null && !compared.differ,
      message: calculated != null && compareValue != null && !compared.differ ? null : message,
    };
  });

  for (let index = 0; index < identities.length; index += 1) {
    if (!identities[index].passed) drafts.push(identityLine(input.anchor, input.identityChecks[index], identities[index]));
  }

  return { lines: drafts, identities };
}

export function stageIndexFor(status: string, stageCount: number): number {
  const last = Math.max(stageCount - 1, 0);
  if (status === 'APPROVED') return last;
  if (status === 'REVIEW') return Math.max(last - 1, 0);
  return Math.min(2, last);
}
