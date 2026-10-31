/**
 * Best-practice expression library.
 *
 * The database catalog and evaluator in
 * supabase/migrations/20261014132853_expression_function_library.sql are the
 * runtime. This module is the same contract, so the functions can be tested
 * without Postgres and served when the catalog table is not installed yet.
 *
 * Row functions are `{fn, args}` inside a calc expression. Arithmetic may
 * also be written as `{op, args}`. Group functions are aggregate_fn values.
 * Domain entries are patterns to copy. Format stays on the attribute.
 */

export type ExprValue = number | string | null;

export type Expression =
  | { const: number | string | null }
  | { ref: string }
  | { op: 'neg'; args: [Expression] }
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: [Expression, Expression] }
  | { fn: string; args: Expression[] };

export interface ExpressionFunctionDef {
  id: string;
  code: string;
  name: string;
  category: 'ROW' | 'GROUP' | 'DOMAIN' | 'DISPLAY';
  returnType: 'NUMBER' | 'TEXT' | 'VALUE' | 'DISPLAY';
  description: string;
  signature: string;
  example: unknown;
  callable: boolean;
  sortOrder: number;
}

const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

function expectCount(code: string, count: number, expected: number): void {
  if (count !== expected) {
    throw new Error(`${code} expects ${expected} argument${expected === 1 ? '' : 's'}`);
  }
}

function asNumber(value: ExprValue, code: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${code} expects a number`);
    return value;
  }
  if (NUMERIC_TEXT.test(value)) return Number(value);
  throw new Error(`${code} expects a number`);
}

function asText(value: ExprValue): string | null {
  if (value === null) return null;
  return String(value);
}

function roundNumber(value: number, places: number): number {
  const scale = Math.trunc(places);
  const factor = 10 ** Math.abs(scale);
  const magnitude = scale >= 0 ? Math.abs(value) * factor : Math.abs(value) / factor;
  const rounded = Math.round(magnitude);
  const scaled = scale >= 0 ? rounded / factor : rounded * factor;
  return Math.sign(value) * scaled;
}

function applyNumericOp(op: 'add' | 'sub' | 'mul' | 'div', left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  if (op === 'add') return left + right;
  if (op === 'sub') return left - right;
  if (op === 'mul') return left * right;
  if (right === 0) return null;
  return left / right;
}

const DATE_FN_TOKENS = new Set([
  'PREVIOUS_DAY', 'START_OF_MONTH', 'END_OF_MONTH', 'START_OF_QUARTER', 'END_OF_QUARTER', 'START_OF_YEAR', 'END_OF_YEAR',
]);

function applyFunction(code: string, args: ExprValue[]): ExprValue {
  const fn = code.toUpperCase();
  if (fn === 'ABS' || fn === 'FLOOR' || fn === 'CEIL') {
    expectCount(fn, args.length, 1);
    const value = asNumber(args[0], fn);
    if (value === null) return null;
    if (fn === 'ABS') return Math.abs(value);
    if (fn === 'FLOOR') return Math.floor(value);
    return Math.ceil(value);
  }
  if (fn === 'ROUND') {
    if (args.length < 1 || args.length > 2) throw new Error('ROUND expects 1 or 2 arguments');
    const value = asNumber(args[0], fn);
    if (value === null) return null;
    const places = args.length === 2 ? asNumber(args[1], fn) : 0;
    if (places === null) return null;
    return roundNumber(value, places);
  }
  if (fn === 'MIN' || fn === 'MAX') {
    if (args.length < 1) throw new Error(`${fn} expects 1 or more arguments`);
    let best: number | null = null;
    for (const arg of args) {
      const value = asNumber(arg, fn);
      if (value === null) continue;
      if (best === null) best = value;
      else best = fn === 'MIN' ? Math.min(best, value) : Math.max(best, value);
    }
    return best;
  }
  if (fn === 'COALESCE') {
    if (args.length < 1) throw new Error('COALESCE expects 1 or more arguments');
    for (const arg of args) {
      if (arg !== null) return arg;
    }
    return null;
  }
  if (fn === 'CONCAT') {
    if (args.length < 1) throw new Error('CONCAT expects 1 or more arguments');
    let text = '';
    for (const arg of args) {
      if (arg === null) continue;
      text += String(arg);
    }
    return text;
  }
  if (fn === 'UPPER' || fn === 'LOWER' || fn === 'TRIM' || fn === 'LENGTH') {
    expectCount(fn, args.length, 1);
    const text = asText(args[0]);
    if (text === null) return null;
    if (fn === 'UPPER') return text.toUpperCase();
    if (fn === 'LOWER') return text.toLowerCase();
    if (fn === 'TRIM') return text.replace(/^ +| +$/g, '');
    return text.length;
  }
  if (fn === 'LEFT') {
    expectCount(fn, args.length, 2);
    const text = asText(args[0]);
    const count = asNumber(args[1], fn);
    if (text === null || count === null) return null;
    const places = Math.trunc(count);
    if (places < 0) throw new Error('LEFT expects a count of zero or more');
    return text.slice(0, places);
  }
  if (fn === 'NEG') {
    expectCount(fn, args.length, 1);
    const value = asNumber(args[0], fn);
    return value === null ? null : -value;
  }
  if (fn === 'ADD' || fn === 'SUB' || fn === 'MUL' || fn === 'DIV') {
    expectCount(fn, args.length, 2);
    const op = fn === 'ADD' ? 'add' : fn === 'SUB' ? 'sub' : fn === 'MUL' ? 'mul' : 'div';
    return applyNumericOp(op, asNumber(args[0], fn), asNumber(args[1], fn));
  }
  if (DATE_FN_TOKENS.has(fn)) {
    expectCount(fn, args.length, 1);
    const text = asText(args[0]);
    if (text === null) return null;
    const shifted = applyDateFn(fn, text);
    if (!shifted) throw new Error(`${fn} expects a date`);
    return shifted;
  }
  throw new Error(`Unknown expression function: ${fn}`);
}

export function evalExpression(expr: Expression, vars: Record<string, ExprValue>): ExprValue {
  if ('const' in expr) return expr.const;
  if ('ref' in expr) {
    const value = vars[expr.ref];
    return value === undefined ? null : value;
  }
  if ('op' in expr) {
    if (expr.op === 'neg') {
      const value = asNumber(evalExpression(expr.args[0], vars), 'NEG');
      return value === null ? null : -value;
    }
    return applyNumericOp(
      expr.op,
      asNumber(evalExpression(expr.args[0], vars), expr.op.toUpperCase()),
      asNumber(evalExpression(expr.args[1], vars), expr.op.toUpperCase()),
    );
  }
  const fn = expr.fn.toUpperCase();
  if (fn === 'COALESCE') {
    if (expr.args.length < 1) throw new Error('COALESCE expects 1 or more arguments');
    for (const arg of expr.args) {
      const value = evalExpression(arg, vars);
      if (value !== null) return value;
    }
    return null;
  }
  return applyFunction(fn, expr.args.map((arg) => evalExpression(arg, vars)));
}

export const EXPRESSION_FUNCTIONS: ExpressionFunctionDef[] = [
  {
    id: 'ROW:ABS',
    code: 'ABS',
    name: 'Absolute value',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Distance from zero. A blank input stays blank.',
    signature: 'ABS(number)',
    example: { fn: 'ABS', args: [{ const: -4 }] },
    callable: true,
    sortOrder: 10,
  },
  {
    id: 'ROW:ROUND',
    code: 'ROUND',
    name: 'Round',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Rounds half away from zero. Omit places to round to a whole number. Use this when the stored value should change precision. Display rounding belongs on the attribute.',
    signature: 'ROUND(number, places)',
    example: { fn: 'ROUND', args: [{ const: 1.26 }, { const: 1 }] },
    callable: true,
    sortOrder: 20,
  },
  {
    id: 'ROW:FLOOR',
    code: 'FLOOR',
    name: 'Floor',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Greatest whole number that is not larger than the input.',
    signature: 'FLOOR(number)',
    example: { fn: 'FLOOR', args: [{ const: 1.9 }] },
    callable: true,
    sortOrder: 30,
  },
  {
    id: 'ROW:CEIL',
    code: 'CEIL',
    name: 'Ceiling',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Smallest whole number that is not smaller than the input.',
    signature: 'CEIL(number)',
    example: { fn: 'CEIL', args: [{ const: 1.1 }] },
    callable: true,
    sortOrder: 40,
  },
  {
    id: 'ROW:MIN',
    code: 'MIN',
    name: 'Minimum',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Smallest of the arguments on one entity. Blank arguments are skipped. To take the minimum across related entities, use the group function MIN instead.',
    signature: 'MIN(number, ...)',
    example: { fn: 'MIN', args: [{ ref: 'PRICE' }, { ref: 'PRIOR_PRICE' }] },
    callable: true,
    sortOrder: 50,
  },
  {
    id: 'ROW:MAX',
    code: 'MAX',
    name: 'Maximum',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Largest of the arguments on one entity. Blank arguments are skipped. To take the maximum across related entities, use the group function MAX instead.',
    signature: 'MAX(number, ...)',
    example: { fn: 'MAX', args: [{ ref: 'PRICE' }, { ref: 'PRIOR_PRICE' }] },
    callable: true,
    sortOrder: 60,
  },
  {
    id: 'ROW:COALESCE',
    code: 'COALESCE',
    name: 'First value',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'First argument that is not blank, keeping it as text or a number.',
    signature: 'COALESCE(value, ...)',
    example: { fn: 'COALESCE', args: [{ ref: 'SHORT_NAME' }, { ref: 'LEGAL_NAME' }] },
    callable: true,
    sortOrder: 70,
  },
  {
    id: 'ROW:CONCAT',
    code: 'CONCAT',
    name: 'Concatenate',
    category: 'ROW',
    returnType: 'TEXT',
    description: 'Joins text. A blank argument is skipped, so a missing middle piece does not blank the whole result. Numbers are written as plain decimals.',
    signature: 'CONCAT(value, ...)',
    example: { fn: 'CONCAT', args: [{ ref: 'SECURITY_NAME' }, { const: ' ' }, { ref: 'CURRENCY' }] },
    callable: true,
    sortOrder: 80,
  },
  {
    id: 'ROW:UPPER',
    code: 'UPPER',
    name: 'Upper case',
    category: 'ROW',
    returnType: 'TEXT',
    description: 'Converts text to upper case.',
    signature: 'UPPER(text)',
    example: { fn: 'UPPER', args: [{ ref: 'TICKER' }] },
    callable: true,
    sortOrder: 90,
  },
  {
    id: 'ROW:LOWER',
    code: 'LOWER',
    name: 'Lower case',
    category: 'ROW',
    returnType: 'TEXT',
    description: 'Converts text to lower case.',
    signature: 'LOWER(text)',
    example: { fn: 'LOWER', args: [{ ref: 'TICKER' }] },
    callable: true,
    sortOrder: 100,
  },
  {
    id: 'ROW:TRIM',
    code: 'TRIM',
    name: 'Trim',
    category: 'ROW',
    returnType: 'TEXT',
    description: 'Removes leading and trailing spaces.',
    signature: 'TRIM(text)',
    example: { fn: 'TRIM', args: [{ ref: 'SECURITY_NAME' }] },
    callable: true,
    sortOrder: 110,
  },
  {
    id: 'ROW:LEFT',
    code: 'LEFT',
    name: 'Left',
    category: 'ROW',
    returnType: 'TEXT',
    description: 'First characters of a text value. The count is zero or more.',
    signature: 'LEFT(text, count)',
    example: { fn: 'LEFT', args: [{ ref: 'CUSIP' }, { const: 8 }] },
    callable: true,
    sortOrder: 120,
  },
  {
    id: 'ROW:LENGTH',
    code: 'LENGTH',
    name: 'Length',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Number of characters.',
    signature: 'LENGTH(text)',
    example: { fn: 'LENGTH', args: [{ ref: 'CUSIP' }] },
    callable: true,
    sortOrder: 130,
  },
  {
    id: 'ROW:ADD',
    code: 'ADD',
    name: 'Add',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Adds two numbers. The op form {"op":"add","args":[...]} is the same function. A blank input makes the result blank.',
    signature: 'ADD(number, number)',
    example: { fn: 'ADD', args: [{ ref: 'COST' }, { ref: 'FEE' }] },
    callable: true,
    sortOrder: 140,
  },
  {
    id: 'ROW:SUB',
    code: 'SUB',
    name: 'Subtract',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Subtracts the second number from the first. A blank input makes the result blank.',
    signature: 'SUB(number, number)',
    example: { op: 'sub', args: [{ ref: 'MARKET_VALUE' }, { ref: 'COST' }] },
    callable: true,
    sortOrder: 150,
  },
  {
    id: 'ROW:MUL',
    code: 'MUL',
    name: 'Multiply',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Multiplies two numbers. Market value is quantity times price. A blank input makes the result blank.',
    signature: 'MUL(number, number)',
    example: { op: 'mul', args: [{ ref: 'QUANTITY' }, { ref: 'PRICE' }] },
    callable: true,
    sortOrder: 160,
  },
  {
    id: 'ROW:DIV',
    code: 'DIV',
    name: 'Divide',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Divides the first number by the second. A blank input or a zero divisor makes the result blank.',
    signature: 'DIV(number, number)',
    example: { op: 'div', args: [{ ref: 'INCOME' }, { ref: 'PRICE' }] },
    callable: true,
    sortOrder: 170,
  },
  {
    id: 'ROW:NEG',
    code: 'NEG',
    name: 'Negate',
    category: 'ROW',
    returnType: 'NUMBER',
    description: 'Changes the sign. A blank input stays blank.',
    signature: 'NEG(number)',
    example: { op: 'neg', args: [{ ref: 'AMOUNT' }] },
    callable: true,
    sortOrder: 180,
  },
  {
    id: 'ROW:CURRENT_DATE',
    code: 'CURRENT_DATE',
    name: 'As-of date',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The as-of date of the calculation, not the day the expression is saved.',
    signature: 'CURRENT_DATE',
    example: { ref: 'CURRENT_DATE' },
    callable: true,
    sortOrder: 182,
  },
  {
    id: 'ROW:PREVIOUS_DAY',
    code: 'PREVIOUS_DAY',
    name: 'Yesterday',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The day before a date. PREVIOUS_DAY(CURRENT_DATE) is the day before the as-of date.',
    signature: 'PREVIOUS_DAY(date)',
    example: { fn: 'PREVIOUS_DAY', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 184,
  },
  {
    id: 'ROW:START_OF_MONTH',
    code: 'START_OF_MONTH',
    name: 'Start of month',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The first day of the month containing a date.',
    signature: 'START_OF_MONTH(date)',
    example: { fn: 'START_OF_MONTH', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 186,
  },
  {
    id: 'ROW:END_OF_MONTH',
    code: 'END_OF_MONTH',
    name: 'End of month',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The last day of the month containing a date.',
    signature: 'END_OF_MONTH(date)',
    example: { fn: 'END_OF_MONTH', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 188,
  },
  {
    id: 'ROW:START_OF_QUARTER',
    code: 'START_OF_QUARTER',
    name: 'Start of quarter',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The first day of the calendar quarter containing a date.',
    signature: 'START_OF_QUARTER(date)',
    example: { fn: 'START_OF_QUARTER', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 190,
  },
  {
    id: 'ROW:END_OF_QUARTER',
    code: 'END_OF_QUARTER',
    name: 'End of quarter',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The last day of the calendar quarter containing a date.',
    signature: 'END_OF_QUARTER(date)',
    example: { fn: 'END_OF_QUARTER', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 192,
  },
  {
    id: 'ROW:START_OF_YEAR',
    code: 'START_OF_YEAR',
    name: 'Start of year',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The first day of the calendar year containing a date.',
    signature: 'START_OF_YEAR(date)',
    example: { fn: 'START_OF_YEAR', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 194,
  },
  {
    id: 'ROW:END_OF_YEAR',
    code: 'END_OF_YEAR',
    name: 'End of year',
    category: 'ROW',
    returnType: 'VALUE',
    description: 'The last day of the calendar year containing a date.',
    signature: 'END_OF_YEAR(date)',
    example: { fn: 'END_OF_YEAR', args: [{ ref: 'CURRENT_DATE' }] },
    callable: true,
    sortOrder: 196,
  },
  {
    id: 'GROUP:SUM',
    code: 'SUM',
    name: 'Sum',
    category: 'GROUP',
    returnType: 'NUMBER',
    description: 'Adds a measure across related entities. Set the calc kind to AGGREGATE and aggregate_fn to SUM. Gross asset value is the sum of position market value.',
    signature: 'aggregate_fn SUM',
    example: { aggregateFn: 'SUM', inputRole: 'MEASURE', attributeCode: 'MARKET_VALUE' },
    callable: false,
    sortOrder: 200,
  },
  {
    id: 'GROUP:WAVG',
    code: 'WAVG',
    name: 'Weighted average',
    category: 'GROUP',
    returnType: 'NUMBER',
    description: 'Average of a measure weighted by a second attribute. Declare a MEASURE and a WEIGHT. A zero total weight stays blank.',
    signature: 'aggregate_fn WAVG',
    example: { aggregateFn: 'WAVG', measure: 'COUPON', weight: 'PAR' },
    callable: false,
    sortOrder: 210,
  },
  {
    id: 'GROUP:MIN',
    code: 'MIN',
    name: 'Group minimum',
    category: 'GROUP',
    returnType: 'NUMBER',
    description: 'Smallest measure across the related entities. Set aggregate_fn to MIN. This is separate from the row function MIN, which compares arguments inside one expression.',
    signature: 'aggregate_fn MIN',
    example: { aggregateFn: 'MIN', inputRole: 'MEASURE', attributeCode: 'PRICE' },
    callable: false,
    sortOrder: 220,
  },
  {
    id: 'GROUP:MAX',
    code: 'MAX',
    name: 'Group maximum',
    category: 'GROUP',
    returnType: 'NUMBER',
    description: 'Largest measure across the related entities. Set aggregate_fn to MAX. This is separate from the row function MAX.',
    signature: 'aggregate_fn MAX',
    example: { aggregateFn: 'MAX', inputRole: 'MEASURE', attributeCode: 'PRICE' },
    callable: false,
    sortOrder: 230,
  },
  {
    id: 'DOMAIN:XIRR',
    code: 'XIRR',
    name: 'Internal rate of return',
    category: 'DOMAIN',
    returnType: 'NUMBER',
    description: 'Annualized rate from dated cash flows plus a terminal value. Set the calc kind to SERIES and series_fn to XIRR, with AMOUNT, FLOW_DATE, and TERMINAL inputs. A filtered or quarter-only IRR calls this same function at query time with a population and a horizon. It is not a different formula.',
    signature: 'series_fn XIRR',
    example: { seriesFn: 'XIRR', inputs: ['AMOUNT', 'FLOW_DATE', 'TERMINAL'] },
    callable: false,
    sortOrder: 300,
  },
  {
    id: 'DOMAIN:CURRENT_YIELD',
    code: 'CURRENT_YIELD',
    name: 'Current yield',
    category: 'DOMAIN',
    returnType: 'NUMBER',
    description: 'Income divided by price. Copy the example into the expression and declare INCOME and PRICE as operands. This is not a bond-yield solver.',
    signature: 'INCOME / PRICE',
    example: { op: 'div', args: [{ ref: 'INCOME' }, { ref: 'PRICE' }] },
    callable: false,
    sortOrder: 310,
  },
  {
    id: 'DOMAIN:UNREALIZED_PNL',
    code: 'UNREALIZED_PNL',
    name: 'Unrealized P&L',
    category: 'DOMAIN',
    returnType: 'NUMBER',
    description: 'Market value minus cost on the same entity. Copy the example and declare both operands.',
    signature: 'MARKET_VALUE - COST',
    example: { op: 'sub', args: [{ ref: 'MARKET_VALUE' }, { ref: 'COST' }] },
    callable: false,
    sortOrder: 320,
  },
  {
    id: 'DOMAIN:NET_MULTIPLE',
    code: 'NET_MULTIPLE',
    name: 'Net multiple',
    category: 'DOMAIN',
    returnType: 'NUMBER',
    description: 'Distributions divided by contributions. Sum each amount across the group first, then divide once. Do not average entity-level multiples.',
    signature: 'SUM(DISTRIBUTIONS) / SUM(CONTRIBUTIONS)',
    example: {
      pattern: 'expression of totals',
      expression: { op: 'div', args: [{ ref: 'DISTRIBUTIONS' }, { ref: 'CONTRIBUTIONS' }] },
    },
    callable: false,
    sortOrder: 330,
  },
  {
    id: 'DISPLAY:FORMAT',
    code: 'FORMAT',
    name: 'Format',
    category: 'DISPLAY',
    returnType: 'DISPLAY',
    description: 'Format is the attribute displayFormat, not a formula. The formula returns the value and the screen formats it. Use ROUND only when the stored number itself should change precision.',
    signature: 'attribute.displayFormat',
    example: { displayFormat: '#,##0.00' },
    callable: false,
    sortOrder: 400,
  },
];

export function listExpressionFunctions(category?: string | null): ExpressionFunctionDef[] {
  const rows = [...EXPRESSION_FUNCTIONS].sort((a, b) => a.sortOrder - b.sortOrder);
  const filter = category?.trim().toUpperCase();
  if (!filter) return rows;
  return rows.filter((row) => row.category === filter);
}

export interface DateExpressionFn {
  value: string;
  token: string;
  label: string;
  wrapLabel: string;
  hint: string;
  wrapHint: string;
  asOfPhrase: string;
  signature: string;
  wrapPhrase: (name: string) => string;
}

export const DQ_DATE_FNS: DateExpressionFn[] = [
  { value: 'as_of', token: 'CURRENT_DATE', label: 'As-of date', wrapLabel: 'That date', hint: 'The as-of date of this check, not the day you save the rule.', wrapHint: 'Compared with that attribute on the same record.', asOfPhrase: 'the as-of date', signature: 'CURRENT_DATE', wrapPhrase: (name) => name },
  { value: 'previous_day', token: 'PREVIOUS_DAY', label: 'Yesterday', wrapLabel: 'The day before', hint: 'The day before a date. With no date, that is the day before the as-of date.', wrapHint: 'The day before that attribute’s date.', asOfPhrase: 'the day before the as-of date', signature: 'PREVIOUS_DAY(date)', wrapPhrase: (name) => `the day before ${name}` },
  { value: 'start_of_month', token: 'START_OF_MONTH', label: 'Start of month', wrapLabel: 'Start of its month', hint: 'The first day of the month containing a date.', wrapHint: 'The first day of the month that contains that attribute.', asOfPhrase: 'the start of the as-of month', signature: 'START_OF_MONTH(date)', wrapPhrase: (name) => `the start of the month of ${name}` },
  { value: 'end_of_month', token: 'END_OF_MONTH', label: 'End of month', wrapLabel: 'End of its month', hint: 'The last day of the month containing a date.', wrapHint: 'The last day of the month that contains that attribute.', asOfPhrase: 'the end of the as-of month', signature: 'END_OF_MONTH(date)', wrapPhrase: (name) => `the end of the month of ${name}` },
  { value: 'start_of_quarter', token: 'START_OF_QUARTER', label: 'Start of quarter', wrapLabel: 'Start of its quarter', hint: 'The first day of the calendar quarter containing a date.', wrapHint: 'The first day of the calendar quarter that contains that attribute.', asOfPhrase: 'the start of the as-of quarter', signature: 'START_OF_QUARTER(date)', wrapPhrase: (name) => `the start of the quarter of ${name}` },
  { value: 'end_of_quarter', token: 'END_OF_QUARTER', label: 'End of quarter', wrapLabel: 'End of its quarter', hint: 'The last day of the calendar quarter containing a date.', wrapHint: 'The last day of the calendar quarter that contains that attribute.', asOfPhrase: 'the end of the as-of quarter', signature: 'END_OF_QUARTER(date)', wrapPhrase: (name) => `the end of the quarter of ${name}` },
  { value: 'start_of_year', token: 'START_OF_YEAR', label: 'Start of year', wrapLabel: 'Start of its year', hint: 'The first day of the calendar year containing a date.', wrapHint: 'The first day of the calendar year that contains that attribute.', asOfPhrase: 'the start of the as-of year', signature: 'START_OF_YEAR(date)', wrapPhrase: (name) => `the start of the year of ${name}` },
  { value: 'end_of_year', token: 'END_OF_YEAR', label: 'End of year', wrapLabel: 'End of its year', hint: 'The last day of the calendar year containing a date.', wrapHint: 'The last day of the calendar year that contains that attribute.', asOfPhrase: 'the end of the as-of year', signature: 'END_OF_YEAR(date)', wrapPhrase: (name) => `the end of the year of ${name}` },
];

export const CALC_DATE_FUNCTIONS = DQ_DATE_FNS.map((fn) => ({
  code: fn.token,
  name: fn.label,
  category: 'ROW',
  description: fn.hint,
  signature: fn.signature,
  callable: true,
}));

/** A field is read on this date, computed from the expression's as-of date. */
export const AS_OF_PERIODS = [
  { code: 'PRIOR_MONTH_END', name: 'Prior month end', description: 'The attribute’s value on the last day of the month before the as-of date. As of 23 Oct 2026, that is 30 Sep 2026.', signature: 'PRIOR_MONTH_END(attribute)' },
  { code: 'PRIOR_QUARTER_END', name: 'Prior quarter end', description: 'The attribute’s value on the last day of the quarter before the as-of date.', signature: 'PRIOR_QUARTER_END(attribute)' },
  { code: 'PRIOR_YEAR_END', name: 'Prior year end', description: 'The attribute’s value on 31 December of the year before the as-of date.', signature: 'PRIOR_YEAR_END(attribute)' },
  { code: 'MONTH_END', name: 'Month end', description: 'The attribute’s value on the last day of the as-of date’s month.', signature: 'MONTH_END(attribute)' },
  { code: 'QUARTER_END', name: 'Quarter end', description: 'The attribute’s value on the last day of the as-of date’s quarter.', signature: 'QUARTER_END(attribute)' },
  { code: 'YEAR_END', name: 'Year end', description: 'The attribute’s value on 31 December of the as-of date’s year.', signature: 'YEAR_END(attribute)' },
] as const;

export const AS_OF_PERIOD_CODES = new Set<string>(AS_OF_PERIODS.map((period) => period.code));

const CALL_TOKENS = DQ_DATE_FNS.filter((fn) => fn.token !== 'CURRENT_DATE').map((fn) => fn.token).join('|');

export function isReservedRef(code: string) {
  return code.toUpperCase() === 'CURRENT_DATE';
}

export type ComparisonExpression =
  | { kind: 'literal'; text: string }
  | { kind: 'attribute'; name: string }
  | { kind: 'call'; token: string; argument: string; canonical: string }
  | { kind: 'asof'; attribute: string; period: string; canonical: string };

export function parseComparisonExpression(text: string): ComparisonExpression {
  const raw = text.trim();
  const wrapped = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/);
  if (wrapped && AS_OF_PERIOD_CODES.has(wrapped[1].toUpperCase())) {
    const period = wrapped[1].toUpperCase();
    const attribute = wrapped[2];
    return { kind: 'asof', attribute, period, canonical: `${period}(${attribute})` };
  }
  const asOf = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+OF\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (asOf && AS_OF_PERIOD_CODES.has(asOf[2].toUpperCase())) {
    const attribute = asOf[1];
    const period = asOf[2].toUpperCase();
    return { kind: 'asof', attribute, period, canonical: `${attribute} AS OF ${period}` };
  }
  if (/^CURRENT_DATE$/i.test(raw)) return { kind: 'call', token: 'CURRENT_DATE', argument: 'CURRENT_DATE', canonical: 'CURRENT_DATE' };
  if (/^YESTERDAY$/i.test(raw)) return { kind: 'call', token: 'PREVIOUS_DAY', argument: 'CURRENT_DATE', canonical: 'PREVIOUS_DAY(CURRENT_DATE)' };
  let match = raw.match(new RegExp(`^(${CALL_TOKENS})$`, 'i'));
  if (match) {
    const token = match[1].toUpperCase();
    return { kind: 'call', token, argument: 'CURRENT_DATE', canonical: `${token}(CURRENT_DATE)` };
  }
  match = raw.match(new RegExp(`^(${CALL_TOKENS})\\s*\\(\\s*(CURRENT_DATE|[A-Za-z_][A-Za-z0-9_]*)\\s*\\)$`, 'i'));
  if (match) {
    const token = match[1].toUpperCase();
    const argument = /^CURRENT_DATE$/i.test(match[2]) ? 'CURRENT_DATE' : match[2];
    return { kind: 'call', token, argument, canonical: `${token}(${argument})` };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return { kind: 'attribute', name: raw };
  return { kind: 'literal', text };
}

export function comparisonFields(text: string): { value: string; compareAttributeCode: string } {
  const parsed = parseComparisonExpression(text);
  if (!text.trim()) return { value: '', compareAttributeCode: '' };
  if (parsed.kind === 'asof') return { value: `AS OF ${parsed.period}`, compareAttributeCode: parsed.attribute };
  if (parsed.kind === 'attribute') return { value: '', compareAttributeCode: parsed.name };
  if (parsed.kind === 'call' && parsed.argument !== 'CURRENT_DATE') return { value: parsed.canonical, compareAttributeCode: parsed.argument };
  if (parsed.kind === 'call') return { value: parsed.canonical, compareAttributeCode: '' };
  const quoted = text.trim().match(/^'((?:[^']|'')*)'$/);
  if (quoted) return { value: quoted[1].replace(/''/g, "'"), compareAttributeCode: '' };
  return { value: text, compareAttributeCode: '' };
}

export function comparisonText(value: string | null | undefined, compareAttributeCode: string | null | undefined): string {
  const expression = (value || '').trim();
  if (/^AS OF /i.test(expression) && compareAttributeCode && compareAttributeCode !== '__PICK__') {
    const period = expression.replace(/^AS OF\s+/i, '').trim().toUpperCase();
    if (AS_OF_PERIOD_CODES.has(period)) return `${period}(${compareAttributeCode})`;
    return `${compareAttributeCode} ${expression}`;
  }
  if (parseComparisonExpression(expression).kind === 'call') return expression;
  if (compareAttributeCode && compareAttributeCode !== '__PICK__') return compareAttributeCode;
  if (!expression || /^-?\d+(\.\d+)?$/.test(expression) || expression === 'true' || expression === 'false') return expression;
  if (expression.startsWith("'")) return expression;
  return `'${expression.replace(/'/g, "''")}'`;
}

export function describeComparisonExpression(text: string, nameFor: (code: string) => string = (code) => code): string {
  const parsed = parseComparisonExpression(text);
  if (!text.trim()) return 'Enter a value, another attribute, or a date function.';
  if (parsed.kind === 'asof') {
    const period = AS_OF_PERIODS.find((item) => item.code === parsed.period);
    return `${period?.name || parsed.period} of ${nameFor(parsed.attribute)}, relative to the as-of date.`;
  }
  if (parsed.kind === 'attribute') return `Compared with ${nameFor(parsed.name)} on the same record.`;
  if (parsed.kind === 'literal') return `Compared with ${text.trim()}.`;
  const fn = DQ_DATE_FNS.find((item) => item.token === parsed.token);
  if (!fn) return text;
  if (parsed.argument === 'CURRENT_DATE') return `${fn.asOfPhrase.charAt(0).toUpperCase()}${fn.asOfPhrase.slice(1)}.`;
  return `${fn.wrapPhrase(nameFor(parsed.argument)).replace(/^./, (letter) => letter.toUpperCase())}.`;
}

function utcDate(iso: string): Date | null {
  const match = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function applyDateFn(token: string, iso: string): string | null {
  const date = utcDate(iso);
  if (!date) return null;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const key = token.toUpperCase();
  if (key === 'CURRENT_DATE') return isoDate(date);
  if (key === 'PREVIOUS_DAY' || key === 'YESTERDAY') return isoDate(new Date(date.getTime() - 86400000));
  if (key === 'START_OF_MONTH') return isoDate(new Date(Date.UTC(year, month, 1)));
  if (key === 'END_OF_MONTH') return isoDate(new Date(Date.UTC(year, month + 1, 0)));
  if (key === 'START_OF_QUARTER') return isoDate(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1)));
  if (key === 'END_OF_QUARTER') return isoDate(new Date(Date.UTC(year, Math.floor(month / 3) * 3 + 3, 0)));
  if (key === 'START_OF_YEAR') return isoDate(new Date(Date.UTC(year, 0, 1)));
  if (key === 'END_OF_YEAR') return isoDate(new Date(Date.UTC(year, 12, 0)));
  if (key === 'MONTH_END') return applyDateFn('END_OF_MONTH', iso);
  if (key === 'QUARTER_END') return applyDateFn('END_OF_QUARTER', iso);
  if (key === 'YEAR_END') return applyDateFn('END_OF_YEAR', iso);
  if (key === 'PRIOR_MONTH_END') return shiftBack(iso, 'START_OF_MONTH', 'END_OF_MONTH');
  if (key === 'PRIOR_QUARTER_END') return shiftBack(iso, 'START_OF_QUARTER', 'END_OF_QUARTER');
  if (key === 'PRIOR_YEAR_END') return shiftBack(iso, 'START_OF_YEAR', 'END_OF_YEAR');
  return null;
}

function shiftBack(iso: string, startToken: string, endToken: string): string | null {
  const start = applyDateFn(startToken, iso);
  if (!start) return null;
  const previous = applyDateFn('PREVIOUS_DAY', start);
  return previous ? applyDateFn(endToken, previous) : null;
}

export function resolveComparisonExpression(
  text: string,
  readAttribute: (code: string) => string | null,
  asOf: string,
): string | null {
  const parsed = parseComparisonExpression(text);
  if (parsed.kind === 'literal') return text;
  if (parsed.kind === 'attribute') return readAttribute(parsed.name);
  if (parsed.kind === 'asof') return null;
  const source = parsed.argument === 'CURRENT_DATE' ? asOf : readAttribute(parsed.argument);
  if (!source) return null;
  if (parsed.token === 'CURRENT_DATE') return source.slice(0, 10);
  return applyDateFn(parsed.token, source);
}
