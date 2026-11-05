/**
 * Project a borrower's statements from attribute definitions.
 * Labels, order, sign, and formulas live on the attributes. This module
 * only evaluates them across quarters, months, and a trailing-twelve-month column.
 */

export type StatementRollup = 'SUM' | 'PERIOD_END' | 'NONE';
export type StatementRole = 'line' | 'sub' | 'total' | 'net' | 'ratio' | 'section';
export type StatementPlacement = 'grid' | 'headline' | 'both' | 'caption';

export type StatementExpr =
  | { const: number }
  | { ref: string }
  | { op: 'neg' | 'prior' | 'cumsum' | 'when_prior'; args: [StatementExpr] }
  | { op: 'trail'; args: [StatementExpr]; periods: number }
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: [StatementExpr, StatementExpr] };

export interface StatementAttribute {
  code: string;
  name: string;
  dataType: string;
  section: string;
  order: number;
  visible: boolean;
  displayFormat: string | null;
  formula: StatementExpr | null;
  dependencies: string[];
  rollup: StatementRollup;
  role: StatementRole;
  indent: boolean;
  sign: number;
  blankZero: boolean;
  placement: StatementPlacement;
  hideWhen: string[];
  headlineOrder: number | null;
  captionCode: string | null;
  captionPrefix: string;
  captionSuffix: string;
  captionDate: 'short' | 'long' | null;
}

export interface StatementPeriod {
  end: string;
  values: Record<string, number | null>;
  entityId?: string;
  entityName?: string;
}

export interface StatementColumn {
  key: string;
  label: string;
  sublabel: string;
  end: string;
  actual: boolean;
  forecastStart: boolean;
  pinned: boolean;
  values: Record<string, number | null>;
  entityId?: string;
  entityName?: string;
}

export interface StatementProjection {
  columns: StatementColumn[];
  pinned: StatementColumn | null;
  firstEnd: string | null;
  lastEnd: string | null;
  error: string | null;
}

export interface RegisterAttribute {
  attributeCode: string;
  attributeName: string;
  dataType?: string | null;
  displaySection?: string | null;
  displayGroup?: number | null;
  isVisible?: boolean | null;
  derivationFormula?: string | null;
  derivationDependencies?: string[] | null;
  displayFormat?: string | null;
  validationRules?: unknown;
  periodRollup?: string | null;
}

export interface RegisterSection {
  sectionName: string;
  displayOrder?: number | null;
}

const NUMERIC = new Set(['NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Scope {
  ref: (code: string) => number | null;
  prior: (code: string) => number | null;
  cumsum: (code: string) => number | null;
  trail: (code: string, periods: number) => number | null;
  hasPrior: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function parseExpr(value: unknown): StatementExpr | null {
  const node = typeof value === 'string' ? asObject(value) : value;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  if (typeof record.const === 'number') return { const: record.const };
  if (typeof record.ref === 'string') return { ref: record.ref };
  const args = Array.isArray(record.args) ? record.args.map(parseExpr) : [];
  if (args.some((arg) => arg == null)) return null;
  const parsed = args as StatementExpr[];
  if (record.op === 'neg' || record.op === 'prior' || record.op === 'cumsum' || record.op === 'when_prior') {
    if (parsed.length !== 1) return null;
    return { op: record.op, args: [parsed[0]] };
  }
  if (record.op === 'trail') {
    if (parsed.length !== 1) return null;
    const periods = typeof record.periods === 'number' && record.periods > 0 ? record.periods : 4;
    return { op: 'trail', args: [parsed[0]], periods };
  }
  if (record.op === 'add' || record.op === 'sub' || record.op === 'mul' || record.op === 'div') {
    if (parsed.length !== 2) return null;
    return { op: record.op, args: [parsed[0], parsed[1]] };
  }
  return null;
}

function exprRefs(expr: StatementExpr): string[] {
  if ('const' in expr) return [];
  if ('ref' in expr) return [expr.ref];
  return expr.args.flatMap(exprRefs);
}

function evaluate(expr: StatementExpr, scope: Scope): number | null {
  if ('const' in expr) return Number.isFinite(expr.const) ? expr.const : null;
  if ('ref' in expr) return scope.ref(expr.ref);
  if (expr.op === 'prior') {
    const inner = expr.args[0];
    return 'ref' in inner ? scope.prior(inner.ref) : null;
  }
  if (expr.op === 'cumsum') {
    const inner = expr.args[0];
    return 'ref' in inner ? scope.cumsum(inner.ref) : null;
  }
  if (expr.op === 'when_prior') return scope.hasPrior ? evaluate(expr.args[0], scope) : null;
  if (expr.op === 'trail') {
    const inner = expr.args[0];
    return 'ref' in inner ? scope.trail(inner.ref, expr.periods) : null;
  }
  if (expr.op === 'neg') {
    const value = evaluate(expr.args[0], scope);
    return value == null ? null : -value;
  }
  if (expr.op !== 'add' && expr.op !== 'sub' && expr.op !== 'mul' && expr.op !== 'div') return null;
  const left = evaluate(expr.args[0], scope);
  const right = evaluate(expr.args[1], scope);
  if (left == null || right == null) return null;
  if (expr.op === 'add') return left + right;
  if (expr.op === 'sub') return left - right;
  if (expr.op === 'mul') return left * right;
  if (right === 0) return null;
  return left / right;
}

function rollupOf(value: unknown): StatementRollup {
  return value === 'SUM' || value === 'PERIOD_END' || value === 'NONE' ? value : 'NONE';
}

function roleOf(value: unknown): StatementRole {
  return value === 'sub' || value === 'total' || value === 'net' || value === 'ratio' || value === 'section' ? value : 'line';
}

function placementOf(value: unknown, visible: boolean): StatementPlacement {
  if (value === 'grid' || value === 'headline' || value === 'both' || value === 'caption') return value;
  return visible ? 'grid' : 'caption';
}

export function statementAttributesFromRegister(rows: RegisterAttribute[]): StatementAttribute[] {
  return rows.filter((row) => row.attributeCode && row.attributeName && asObject(asObject(row.validationRules)?.statementLine)).map((row) => {
    const rules = asObject(row.validationRules);
    const line = asObject(rules?.statementLine) || {};
    const formula = parseExpr(row.derivationFormula);
    const declared = Array.isArray(row.derivationDependencies) ? row.derivationDependencies.filter((code) => typeof code === 'string') : [];
    const visible = row.isVisible !== false;
    return {
      code: row.attributeCode,
      name: row.attributeName,
      dataType: (row.dataType || 'STRING').toUpperCase(),
      section: (row.displaySection || 'General').trim() || 'General',
      order: row.displayGroup ?? 0,
      visible,
      displayFormat: row.displayFormat || null,
      formula,
      dependencies: [...new Set([...declared, ...(formula ? exprRefs(formula) : [])])],
      rollup: rollupOf(line.rollup || row.periodRollup),
      role: roleOf(line.role),
      indent: line.indent === true,
      sign: typeof line.sign === 'number' && line.sign !== 0 ? line.sign : 1,
      blankZero: line.blankZero === true,
      placement: placementOf(line.placement, visible),
      hideWhen: Array.isArray(line.hideWhen) ? line.hideWhen.filter((item): item is string => typeof item === 'string') : [],
      headlineOrder: typeof line.headlineOrder === 'number' ? line.headlineOrder : null,
      captionCode: typeof line.captionCode === 'string' ? line.captionCode : null,
      captionPrefix: typeof line.captionPrefix === 'string' ? line.captionPrefix : '',
      captionSuffix: typeof line.captionSuffix === 'string' ? line.captionSuffix : '',
      captionDate: line.captionDate === 'short' || line.captionDate === 'long' ? line.captionDate : null,
    };
  });
}

export function isGridLine(attr: StatementAttribute): boolean {
  if (attr.placement !== 'grid' && attr.placement !== 'both') return false;
  if (attr.role === 'section') return true;
  if (!attr.visible) return false;
  return NUMERIC.has(attr.dataType);
}

export function isHeadline(attr: StatementAttribute): boolean {
  return attr.placement === 'headline' || attr.placement === 'both';
}

export function gridSections(attributes: StatementAttribute[], sections: RegisterSection[]): string[] {
  const present = new Set(attributes.filter(isGridLine).map((attr) => attr.section));
  const known = [...sections]
    .filter((section) => present.has(section.sectionName))
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.sectionName.localeCompare(b.sectionName))
    .map((section) => section.sectionName);
  const extra = [...present].filter((name) => !known.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...known, ...extra];
}

export function linesForSection(attributes: StatementAttribute[], section: string, grain: string): StatementAttribute[] {
  return attributes
    .filter((attr) => attr.section === section && isGridLine(attr) && !attr.hideWhen.includes(grain))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function headlineAttributes(attributes: StatementAttribute[]): StatementAttribute[] {
  return attributes
    .filter(isHeadline)
    .sort((a, b) => (a.headlineOrder ?? a.order) - (b.headlineOrder ?? b.order) || a.name.localeCompare(b.name));
}

export function periodEndValue(
  attributes: StatementAttribute[],
  raw: Record<string, unknown>,
  textOf: (value: unknown) => string,
): string {
  const date = attributes
    .filter((attr) => attr.dataType === 'DATE')
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))[0];
  if (!date) return '';
  return textOf(raw[date.code]).slice(0, 10);
}

export function readStatementAmounts(
  attributes: StatementAttribute[],
  raw: Record<string, unknown>,
  amountOf: (value: unknown) => number,
): Record<string, number | null> {
  const values: Record<string, number | null> = {};
  for (const attr of attributes) {
    if (attr.formula || attr.role === 'section' || !NUMERIC.has(attr.dataType)) continue;
    values[attr.code] = amountOf(raw[attr.code]);
  }
  return values;
}

function day(value: string): string {
  return value.slice(0, 10);
}

function addMonths(iso: string, count: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const date = Number(iso.slice(8, 10));
  const cursor = new Date(Date.UTC(year, month - 1 + count, 1));
  const dim = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  const y = cursor.getUTCFullYear();
  const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
  const d = String(Math.min(date || 1, dim)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function quarterLabel(end: string): string {
  const month = Number(end.slice(5, 7));
  return `Q${Math.ceil((month || 1) / 3)} ${end.slice(0, 4)}`;
}

function monthLabel(end: string): string {
  const month = Number(end.slice(5, 7));
  return `${MONTHS[(month || 1) - 1]} ${end.slice(0, 4)}`;
}

function sumOf(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => value != null && Number.isFinite(value));
  return nums.length ? nums.reduce((total, value) => total + value, 0) : null;
}

function derivedOrder(attributes: StatementAttribute[]): string[] {
  const derived = attributes.filter((attr) => attr.formula);
  if (derived.length === 0) return [];
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const byCode = new Map(derived.map((attr) => [attr.code, attr]));
  const codes = new Set(derived.map((attr) => attr.code));
  const walk = (code: string): number => {
    const known = depth.get(code);
    if (known != null) return known;
    if (visiting.has(code)) throw new Error(`Calculated attribute cycle: ${code}`);
    visiting.add(code);
    const inputs = (byCode.get(code)?.dependencies || []).filter((input) => codes.has(input));
    const value = inputs.length === 0 ? 0 : 1 + Math.max(...inputs.map(walk));
    visiting.delete(code);
    depth.set(code, value);
    return value;
  };
  for (const code of codes) walk(code);
  return [...codes].sort((a, b) => (depth.get(a) || 0) - (depth.get(b) || 0) || a.localeCompare(b));
}

function quarterScope(
  index: number,
  history: Array<Record<string, number | null>>,
  current: Record<string, number | null>,
): Scope {
  return {
    ref: (code) => current[code] ?? null,
    prior: (code) => (index === 0 ? null : history[index - 1]?.[code] ?? null),
    cumsum: (code) => sumOf([
      ...history.slice(0, index).map((row) => row[code] ?? null),
      current[code] ?? null,
    ]),
    trail: (code, periods) => {
      if (index + 1 < periods) return null;
      const values: Array<number | null> = [];
      for (let cursor = index - periods + 1; cursor <= index; cursor += 1) {
        values.push(cursor === index ? current[code] ?? null : history[cursor]?.[code] ?? null);
      }
      return values.some((value) => value == null) ? null : sumOf(values);
    },
    hasPrior: index > 0,
  };
}

function buildQuarters(
  periods: StatementPeriod[],
  attributes: StatementAttribute[],
  order: string[],
  asOf: string,
): StatementColumn[] {
  const byCode = new Map(attributes.map((attr) => [attr.code, attr]));
  const sorted = [...periods].filter((period) => period.end).sort((a, b) => a.end.localeCompare(b.end));
  const history: Array<Record<string, number | null>> = [];
  return sorted.map((period, index) => {
    const current: Record<string, number | null> = { ...period.values };
    const scope = quarterScope(index, history, current);
    for (const code of order) {
      const formula = byCode.get(code)?.formula;
      if (formula) current[code] = evaluate(formula, scope);
    }
    history.push(current);
    const end = day(period.end);
    return {
      key: end,
      label: quarterLabel(end),
      sublabel: end <= asOf ? 'Actual' : 'Forecast',
      end,
      actual: end <= asOf,
      forecastStart: false,
      pinned: false,
      values: current,
      entityId: period.entityId,
      entityName: period.entityName,
    };
  });
}

function markForecast(columns: StatementColumn[]): void {
  let seenActual = false;
  let seenForecast = false;
  for (const column of columns) {
    column.forecastStart = !column.actual && seenActual && !seenForecast;
    if (column.actual) seenActual = true;
    else seenForecast = true;
  }
}

function windowValues(
  quarters: StatementColumn[],
  attributes: StatementAttribute[],
  order: string[],
): Record<string, number | null> | null {
  const actuals = quarters.filter((column) => column.actual);
  const last = actuals[actuals.length - 1];
  if (!last) return null;
  const window = actuals.slice(-4);
  const before = [...quarters].reverse().find((column) => column.end < window[0].end) || null;
  const values: Record<string, number | null> = {};
  for (const attr of attributes) {
    if (attr.formula && attr.rollup === 'NONE') continue;
    values[attr.code] = attr.rollup === 'SUM'
      ? sumOf(window.map((column) => column.values[attr.code] ?? null))
      : last.values[attr.code] ?? null;
  }
  const scope: Scope = {
    ref: (code) => values[code] ?? null,
    prior: (code) => before?.values[code] ?? null,
    cumsum: (code) => sumOf(quarters.filter((column) => column.end <= last.end).map((column) => column.values[code] ?? null)),
    trail: (code, periods) => (window.length < periods ? null : sumOf(window.slice(-periods).map((column) => column.values[code] ?? null))),
    hasPrior: Boolean(before),
  };
  const byCode = new Map(attributes.map((attr) => [attr.code, attr]));
  for (const code of order) {
    const attr = byCode.get(code);
    if (!attr?.formula || attr.rollup !== 'NONE') continue;
    values[code] = evaluate(attr.formula, scope);
  }
  return values;
}

function pinnedColumn(quarters: StatementColumn[], attributes: StatementAttribute[], order: string[]): StatementColumn | null {
  const values = windowValues(quarters, attributes, order);
  const actuals = quarters.filter((column) => column.actual);
  const last = actuals[actuals.length - 1];
  if (!values || !last) return null;
  return {
    key: 'ltm',
    label: 'LTM',
    sublabel: '',
    end: last.end,
    actual: true,
    forecastStart: false,
    pinned: true,
    values,
    entityId: last.entityId,
    entityName: last.entityName,
  };
}

function monthlyColumns(quarters: StatementColumn[], attributes: StatementAttribute[], asOf: string): StatementColumn[] {
  return quarters.flatMap((column) => [2, 1, 0].map((back) => {
    const end = addMonths(column.end, -back);
    const values: Record<string, number | null> = {};
    for (const attr of attributes) {
      const value = column.values[attr.code] ?? null;
      values[attr.code] = value == null || attr.rollup !== 'SUM' ? value : value / 3;
    }
    return {
      key: end,
      label: monthLabel(end),
      sublabel: end <= asOf ? 'Actual' : 'Forecast',
      end,
      actual: end <= asOf,
      forecastStart: false,
      pinned: false,
      values,
      entityId: column.entityId,
      entityName: column.entityName,
    };
  }));
}

export function projectStatementBook(
  periods: StatementPeriod[],
  attributes: StatementAttribute[],
  asOfDate: string,
  grain: 'quarter' | 'month' | 'statement',
): StatementProjection {
  const empty: StatementProjection = { columns: [], pinned: null, firstEnd: null, lastEnd: null, error: null };
  try {
    const order = derivedOrder(attributes);
    const asOf = day(asOfDate || '9999-12-31');
    const quarters = buildQuarters(periods, attributes, order, asOf);
    markForecast(quarters);
    const pinned = pinnedColumn(quarters, attributes, order);
    const columns = grain === 'month' ? monthlyColumns(quarters, attributes, asOf) : quarters;
    if (grain === 'month') markForecast(columns);
    return {
      columns: grain === 'statement' ? [] : columns,
      pinned,
      firstEnd: quarters[0]?.end || null,
      lastEnd: quarters[quarters.length - 1]?.end || null,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not project statements' };
  }
}
