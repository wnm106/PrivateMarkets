// Text <-> expression tree for the operands of a compliance condition.
//
// Operands are typed as text:   NAV * 0.1    END_OF_MONTH(CURRENT_DATE)    POSITION.MARKET_VALUE + CASH
// and saved as the shared expression tree ({const} | {ref} | {op, args} | {fn, args}).
// A bare field is the root entity's attribute; DOMAIN.FIELD reaches a related entity.

import { comparisonFields, comparisonText, parseComparisonExpression } from './expression-library';

export type Expr =
  | { const: number | string | null }
  | { ref: string }
  | { op: 'neg'; args: [Expr] }
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: [Expr, Expr] }
  | { fn: string; args: Expr[] };

export interface PathHop {
  relationshipCode: string;
  direction: 'UP' | 'DOWN';
}

export interface OperandField {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string;
  groupLabel: string;
  path: PathHop[];
  valueKey: string;
}

export interface OperandContext {
  fields: OperandField[];
  relationshipTypes: Array<{ relationshipCode: string; parentDomainCode: string; childDomainCode: string }>;
}

export const REF_SEPARATOR = '\u001f';
export const EXPRESSION_PLACEHOLDER_CODE = '__EXPR__';

export interface OperandFunction {
  name: string;
  insert: string;
  signature: string;
  description: string;
  group: 'Math' | 'Text' | 'Dates';
  min: number;
  max: number;
}

const fn = (name: string, signature: string, description: string, group: OperandFunction['group'], min: number, max = min): OperandFunction => ({
  name,
  insert: `${name}(`,
  signature,
  description,
  group,
  min,
  max,
});

export const OPERAND_FUNCTIONS: OperandFunction[] = [
  fn('ABS', 'ABS(number)', 'Distance from zero', 'Math', 1),
  fn('ROUND', 'ROUND(number, places)', 'Round to a number of decimal places', 'Math', 1, 2),
  fn('FLOOR', 'FLOOR(number)', 'Round down to a whole number', 'Math', 1),
  fn('CEIL', 'CEIL(number)', 'Round up to a whole number', 'Math', 1),
  fn('MIN', 'MIN(a, b, …)', 'Smallest of the values', 'Math', 1, 99),
  fn('MAX', 'MAX(a, b, …)', 'Largest of the values', 'Math', 1, 99),
  fn('COALESCE', 'COALESCE(a, b, …)', 'First value that is not blank', 'Text', 1, 99),
  fn('CONCAT', 'CONCAT(a, b, …)', 'Join values into text', 'Text', 1, 99),
  fn('UPPER', 'UPPER(text)', 'Upper case', 'Text', 1),
  fn('LOWER', 'LOWER(text)', 'Lower case', 'Text', 1),
  fn('TRIM', 'TRIM(text)', 'Remove surrounding spaces', 'Text', 1),
  fn('LEFT', 'LEFT(text, count)', 'First characters of text', 'Text', 2),
  fn('LENGTH', 'LENGTH(text)', 'Number of characters', 'Text', 1),
  { name: 'CURRENT_DATE', insert: 'CURRENT_DATE', signature: 'CURRENT_DATE', description: 'The as-of date of the run', group: 'Dates', min: 0, max: 0 },
  fn('PREVIOUS_DAY', 'PREVIOUS_DAY(date)', 'The day before', 'Dates', 1),
  fn('START_OF_MONTH', 'START_OF_MONTH(date)', 'First day of the month', 'Dates', 1),
  fn('END_OF_MONTH', 'END_OF_MONTH(date)', 'Last day of the month', 'Dates', 1),
  fn('START_OF_QUARTER', 'START_OF_QUARTER(date)', 'First day of the quarter', 'Dates', 1),
  fn('END_OF_QUARTER', 'END_OF_QUARTER(date)', 'Last day of the quarter', 'Dates', 1),
  fn('START_OF_YEAR', 'START_OF_YEAR(date)', 'First day of the year', 'Dates', 1),
  fn('END_OF_YEAR', 'END_OF_YEAR(date)', 'Last day of the year', 'Dates', 1),
];

const FUNCTIONS_BY_NAME = new Map(OPERAND_FUNCTIONS.filter((f) => f.max > 0).map((f) => [f.name, f]));

// ---- Tokenizer ----

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'p'; v: '+' | '-' | '*' | '/' | '(' | ')' | ',' | '.'; at: number }
  | { t: 'end'; at: number };

class ParseError extends Error {}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?|^[0-9]+/i.exec(text.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), at: i });
      i += m[0].length;
    } else if (ch === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= text.length) throw new ParseError('A quoted value is missing its closing quote');
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += text[j++];
      }
      out.push({ t: 'str', v: value, at: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
      out.push({ t: 'id', v: m[0], at: i });
      i += m[0].length;
    } else if ('+-*/(),.'.includes(ch)) {
      out.push({ t: 'p', v: ch as '+', at: i });
      i++;
    } else {
      throw new ParseError(`Unexpected “${ch}”`);
    }
  }
  out.push({ t: 'end', at: text.length });
  return out;
}

// ---- Field resolution ----

export function refKey(path: PathHop[], code: string): string {
  const prefix = path.map((h) => `${h.direction}:${h.relationshipCode}`).join('|');
  return prefix ? `${prefix}${REF_SEPARATOR}${code}` : code;
}

function resolveField(ctx: OperandContext, name: string, qualifier?: string): string {
  const code = name.toUpperCase();
  if (qualifier) {
    const domain = qualifier.toUpperCase();
    const hit = ctx.fields.find((f) => f.domainCode.toUpperCase() === domain && f.attributeCode.toUpperCase() === code);
    if (!hit) throw new ParseError(`No field ${qualifier}.${name}`);
    return hit.valueKey;
  }
  const hit = ctx.fields.find((f) => f.path.length === 0 && f.attributeCode.toUpperCase() === code);
  if (!hit) {
    const related = ctx.fields.find((f) => f.attributeCode.toUpperCase() === code);
    throw new ParseError(
      related
        ? `${name} belongs to ${related.domainCode}. Write ${related.domainCode}.${related.attributeCode}`
        : `Unknown field ${name}. Put text values in quotes, like '${name}'`,
    );
  }
  return hit.valueKey;
}

// ---- Parser: expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ----

export function parseExpression(text: string, ctx: OperandContext): Expr {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isP = (v: string) => peek().t === 'p' && (peek() as { v: string }).v === v;

  const expectEnd = () => {
    if (peek().t !== 'end') throw new ParseError(`Unexpected “${describeToken(peek())}”`);
  };

  function parseSum(): Expr {
    let left = parseProduct();
    while (isP('+') || isP('-')) {
      const op = (take() as { v: string }).v === '+' ? 'add' : 'sub';
      left = { op, args: [left, parseProduct()] };
    }
    return left;
  }

  function parseProduct(): Expr {
    let left = parseUnary();
    while (isP('*') || isP('/')) {
      const op = (take() as { v: string }).v === '*' ? 'mul' : 'div';
      left = { op, args: [left, parseUnary()] };
    }
    return left;
  }

  function parseUnary(): Expr {
    if (isP('-')) {
      take();
      const inner = parseUnary();
      if ('const' in inner && typeof inner.const === 'number') return { const: -inner.const };
      return { op: 'neg', args: [inner] };
    }
    if (isP('+')) {
      take();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    const tok = take();
    if (tok.t === 'num') return { const: tok.v };
    if (tok.t === 'str') return { const: tok.v };
    if (tok.t === 'p' && tok.v === '(') {
      const inner = parseSum();
      if (!isP(')')) throw new ParseError('Missing a closing )');
      take();
      return inner;
    }
    if (tok.t === 'id') {
      const upper = tok.v.toUpperCase();
      if (isP('(')) {
        take();
        const def = FUNCTIONS_BY_NAME.get(upper);
        if (!def) throw new ParseError(`Unknown function ${tok.v}`);
        const args: Expr[] = [];
        if (!isP(')')) {
          for (;;) {
            args.push(parseSum());
            if (isP(',')) {
              take();
              continue;
            }
            break;
          }
        }
        if (!isP(')')) throw new ParseError(`Missing a closing ) for ${upper}`);
        take();
        if (args.length < def.min || args.length > def.max) {
          throw new ParseError(`${upper} takes ${def.min === def.max ? def.min : `${def.min} to ${def.max === 99 ? 'any number of' : def.max}`} argument${def.max === 1 ? '' : 's'}`);
        }
        return { fn: upper, args };
      }
      if (upper === 'CURRENT_DATE' || upper === 'AS_OF_DATE') return { ref: 'CURRENT_DATE' };
      if (upper === 'TRUE' || upper === 'FALSE') return { const: upper.toLowerCase() };
      if (upper === 'NULL') return { const: null };
      if (isP('.')) {
        take();
        const field = take();
        if (field.t !== 'id') throw new ParseError(`Name a field after ${tok.v}.`);
        return { ref: resolveField(ctx, field.v, tok.v) };
      }
      return { ref: resolveField(ctx, tok.v) };
    }
    if (tok.t === 'end') throw new ParseError('The expression ends too soon');
    throw new ParseError(`Unexpected “${describeToken(tok)}”`);
  }

  if (tokens.length === 1) return { const: null };
  const result = parseSum();
  expectEnd();
  return result;
}

function describeToken(tok: Token): string {
  if (tok.t === 'end') return 'end';
  if (tok.t === 'str') return `'${tok.v}'`;
  return String(tok.v);
}

export function compileExpression(text: string, ctx: OperandContext): { ast: Expr | null; error?: string } {
  if (!text.trim()) return { ast: null };
  try {
    return { ast: parseExpression(text, ctx) };
  } catch (err: any) {
    return { ast: null, error: err instanceof ParseError ? err.message : 'Could not read this expression' };
  }
}

// ---- Printing and describing ----

function domainAtEnd(path: PathHop[], ctx: OperandContext): string {
  const last = path[path.length - 1];
  const rel = ctx.relationshipTypes.find((r) => r.relationshipCode === last?.relationshipCode);
  if (!rel) return '';
  return last.direction === 'UP' ? rel.parentDomainCode : rel.childDomainCode;
}

export function printRef(path: PathHop[], code: string, ctx: OperandContext): string {
  if (!path.length) return code;
  const hit = ctx.fields.find((f) => f.valueKey === refKey(path, code));
  const domain = hit?.domainCode || domainAtEnd(path, ctx);
  return domain ? `${domain}.${code}` : code;
}

function pathFromKey(key: string): { path: PathHop[]; code: string } {
  const at = key.indexOf(REF_SEPARATOR);
  if (at < 0) return { path: [], code: key };
  const path = key
    .slice(0, at)
    .split('|')
    .filter(Boolean)
    .map((hop) => {
      const [direction, ...rest] = hop.split(':');
      return { direction: (direction || 'UP').toUpperCase() as 'UP' | 'DOWN', relationshipCode: rest.join(':') };
    });
  return { path, code: key.slice(at + 1) };
}

const OP_SYMBOL: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/' };
const OP_PRECEDENCE: Record<string, number> = { add: 1, sub: 1, mul: 2, div: 2 };

function formatConst(value: number | string | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (value === 'true' || value === 'false') return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function printExpression(expr: Expr, ctx: OperandContext, label?: (key: string) => string): string {
  const show = (node: Expr, parent = 0, right = false): string => {
    if ('const' in node) return formatConst(node.const);
    if ('ref' in node) {
      if (node.ref === 'CURRENT_DATE') return 'CURRENT_DATE';
      if (label) return label(node.ref);
      const { path, code } = pathFromKey(node.ref);
      return printRef(path, code, ctx);
    }
    if ('fn' in node) return `${node.fn}(${node.args.map((a) => show(a)).join(', ')})`;
    if (node.op === 'neg') return `-${show(node.args[0], 3)}`;
    const prec = OP_PRECEDENCE[node.op];
    const text = `${show(node.args[0], prec)} ${OP_SYMBOL[node.op]} ${show(node.args[1], prec, true)}`;
    return prec < parent || (prec === parent && right) ? `(${text})` : text;
  };
  return show(expr);
}

/** Plain-language rendering that uses field names instead of codes. */
export function describeOperand(expr: Expr | null, ctx: OperandContext): string {
  if (!expr) return '';
  const nameFor = (key: string) => {
    const hit = ctx.fields.find((f) => f.valueKey === key);
    if (hit) return hit.path.length ? `${hit.groupLabel.split(' › ').slice(-1)[0]} ${hit.attributeName}` : hit.attributeName;
    return pathFromKey(key).code;
  };
  return printExpression(expr, ctx, nameFor).replace(/ \* /g, ' × ').replace(/ \/ /g, ' ÷ ').replace(/ - /g, ' − ');
}

// ---- Mapping an operand to the stored condition fields ----

export interface LeftOperand {
  attributeCode: string;
  attributePath: PathHop[];
  leftExpression: Expr | null;
  error?: string;
}

export function applyLeftText(text: string, ctx: OperandContext): LeftOperand {
  const { ast, error } = compileExpression(text, ctx);
  if (error) return { attributeCode: '', attributePath: [], leftExpression: null, error };
  if (!ast) return { attributeCode: '', attributePath: [], leftExpression: null };
  if ('ref' in ast && ast.ref !== 'CURRENT_DATE') {
    const { path, code } = pathFromKey(ast.ref);
    return { attributeCode: code, attributePath: path, leftExpression: null };
  }
  return { attributeCode: EXPRESSION_PLACEHOLDER_CODE, attributePath: [], leftExpression: ast };
}

export interface RightOperand {
  value: string;
  compareAttributeCode: string;
  compareAttributePath: PathHop[];
  rightExpression: Expr | null;
  error?: string;
}

const emptyRight = (): RightOperand => ({ value: '', compareAttributeCode: '', compareAttributePath: [], rightExpression: null });

export function applyRightText(text: string, operator: string, ctx: OperandContext): RightOperand {
  if (!text.trim()) return emptyRight();
  if (operator === 'in' || operator === 'not_in') return { ...emptyRight(), value: text };

  // Date functions and "value as of a period" keep their long-standing stored form.
  const legacy = parseComparisonExpression(text);
  if (legacy.kind === 'asof' || legacy.kind === 'call') {
    const fields = comparisonFields(text);
    return { ...emptyRight(), value: fields.value, compareAttributeCode: fields.compareAttributeCode };
  }

  const { ast, error } = compileExpression(text, ctx);
  if (error) return { ...emptyRight(), error };
  if (!ast) return emptyRight();
  if ('const' in ast) return { ...emptyRight(), value: ast.const == null ? '' : String(ast.const) };
  if ('ref' in ast && ast.ref !== 'CURRENT_DATE') {
    const { path, code } = pathFromKey(ast.ref);
    return { ...emptyRight(), compareAttributeCode: code, compareAttributePath: path };
  }
  return { ...emptyRight(), rightExpression: ast };
}

export function leftTextOf(
  cond: { attributeCode: string; attributePath: PathHop[]; leftExpression?: Expr | null },
  ctx: OperandContext,
): string {
  if (cond.leftExpression) return printExpression(cond.leftExpression, ctx);
  if (!cond.attributeCode || cond.attributeCode === EXPRESSION_PLACEHOLDER_CODE) return '';
  return printRef(cond.attributePath || [], cond.attributeCode, ctx);
}

export function rightTextOf(
  cond: { value: string; compareAttributeCode: string; compareAttributePath: PathHop[]; rightExpression?: Expr | null; operator: string },
  ctx: OperandContext,
): string {
  if (cond.rightExpression) return printExpression(cond.rightExpression, ctx);
  if (cond.operator === 'in' || cond.operator === 'not_in') return cond.value || '';
  if (cond.compareAttributeCode && cond.compareAttributePath?.length && !(cond.value || '').trim()) {
    return printRef(cond.compareAttributePath, cond.compareAttributeCode, ctx);
  }
  return comparisonText(cond.value, cond.compareAttributeCode);
}
