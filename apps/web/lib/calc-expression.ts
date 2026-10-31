import { AS_OF_PERIOD_CODES } from './expression-library';

/** Turns a calculation expression into the text shown in the editor. */
export function decompileCalcExpression(expr: unknown): string {
  if (expr == null) return '';
  if (typeof expr === 'string') {
    const text = expr.trim();
    if (!text) return '';
    try {
      return decompileCalcExpression(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (typeof expr !== 'object') return String(expr);
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string') {
    const period = periodFunction(node.asOf);
    if (period) return `${period}(${node.ref})`;
    if (node.asOf) return `${node.ref} AS OF ${decompileCalcExpression(node.asOf)}`;
    return node.ref;
  }
  if ('const' in node) return String(node.const);
  if (node.op === 'neg' && Array.isArray(node.args)) return `-${decompileCalcExpression(node.args[0])}`;
  if (typeof node.op === 'string' && Array.isArray(node.args) && node.args.length === 2) {
    const symbol = node.op === 'add' ? '+' : node.op === 'sub' ? '-' : node.op === 'mul' ? '*' : node.op === 'div' ? '/' : node.op;
    return `${decompileCalcExpression(node.args[0])} ${symbol} ${decompileCalcExpression(node.args[1])}`;
  }
  if (typeof node.fn === 'string' && Array.isArray(node.args)) {
    if (node.args.length === 0) return node.fn;
    return `${node.fn}(${node.args.map((arg) => decompileCalcExpression(arg)).join(', ')})`;
  }
  return JSON.stringify(expr);
}

/** Attribute codes referenced by a compiled expression, in first-seen order. */
export function collectCalcRefs(expr: unknown, found: string[] = []): string[] {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return found;
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string' && node.ref.toUpperCase() !== 'CURRENT_DATE' && !found.includes(node.ref)) found.push(node.ref);
  if (node.asOf) collectCalcRefs(node.asOf, found);
  if (Array.isArray(node.args)) node.args.forEach((arg) => collectCalcRefs(arg, found));
  return found;
}

function periodFunction(asOf: unknown): string | null {
  if (!asOf || typeof asOf !== 'object') return null;
  const node = asOf as Record<string, unknown>;
  if (typeof node.fn === 'string' && Array.isArray(node.args) && node.args.length === 0 && AS_OF_PERIOD_CODES.has(node.fn)) return node.fn;
  return null;
}

function stampAsOf(expr: unknown, when: unknown): unknown {
  if (!expr || typeof expr !== 'object') return expr;
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string') {
    if (node.ref.toUpperCase() === 'CURRENT_DATE' || node.asOf) return expr;
    return { ...node, asOf: when };
  }
  if (Array.isArray(node.args)) return { ...node, args: node.args.map((arg) => stampAsOf(arg, when)) };
  return expr;
}

/** Accepts QUANTITY * PRICE or a JSON expression object. */
export function compileCalcExpression(source: string): unknown {
  const text = source.trim();
  if (!text) throw new Error('Enter an expression');
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  return new InfixParser(text).parse();
}

class InfixParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const expr = this.parseAdd();
    this.skip();
    if (this.index < this.source.length) throw new Error(`Unexpected "${this.source.slice(this.index)}"`);
    return expr;
  }

  private skip(): void {
    while (this.source[this.index] === ' ' || this.source[this.index] === '\n' || this.source[this.index] === '\t') this.index += 1;
  }

  private parseAdd(): unknown {
    let left = this.parseMul();
    for (;;) {
      this.skip();
      const op = this.source[this.index];
      if (op !== '+' && op !== '-') break;
      this.index += 1;
      const right = this.parseMul();
      left = { op: op === '+' ? 'add' : 'sub', args: [left, right] };
    }
    return left;
  }

  private parseMul(): unknown {
    let left = this.parseUnary();
    for (;;) {
      this.skip();
      const op = this.source[this.index];
      if (op !== '*' && op !== '/') break;
      this.index += 1;
      const right = this.parseUnary();
      left = { op: op === '*' ? 'mul' : 'div', args: [left, right] };
    }
    return left;
  }

  private parseUnary(): unknown {
    this.skip();
    if (this.source[this.index] === '-') {
      this.index += 1;
      return { op: 'neg', args: [this.parseUnary()] };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const atom = this.parseAtom();
    if (this.matchWord('AS')) {
      if (!this.matchWord('OF')) throw new Error('Expected OF after AS');
      return stampAsOf(atom, this.parseAtom());
    }
    return atom;
  }

  private matchWord(word: string): boolean {
    this.skip();
    const match = new RegExp(`^${word}(?![A-Za-z0-9_])`, 'i').exec(this.source.slice(this.index));
    if (!match) return false;
    this.index += match[0].length;
    return true;
  }

  private parseAtom(): unknown {
    this.skip();
    const char = this.source[this.index];
    if (char === '(') {
      this.index += 1;
      const inner = this.parseAdd();
      this.skip();
      if (this.source[this.index] !== ')') throw new Error('Missing )');
      this.index += 1;
      return inner;
    }
    if ((char >= '0' && char <= '9') || char === '.') {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(this.source.slice(this.index));
      if (!match) throw new Error('Invalid number');
      this.index += match[0].length;
      return { const: Number(match[0]) };
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index));
    if (!name) throw new Error('Expected an attribute, number, or (');
    this.index += name[0].length;
    this.skip();
    if (this.source[this.index] === '(') {
      this.index += 1;
      const args: unknown[] = [];
      this.skip();
      if (this.source[this.index] !== ')') {
        for (;;) {
          args.push(this.parseAdd());
          this.skip();
          if (this.source[this.index] === ',') {
            this.index += 1;
            continue;
          }
          break;
        }
      }
      this.skip();
      if (this.source[this.index] !== ')') throw new Error(`Missing ) after ${name[0]}`);
      this.index += 1;
      return this.finishCall(name[0].toUpperCase(), args);
    }
    if (AS_OF_PERIOD_CODES.has(name[0].toUpperCase())) return { fn: name[0].toUpperCase(), args: [] };
    return { ref: name[0] };
  }

  private finishCall(name: string, args: unknown[]): unknown {
    if (!AS_OF_PERIOD_CODES.has(name)) return { fn: name, args };
    if (args.length !== 1) throw new Error(`${name} expects the attribute to read`);
    const arg = args[0] as Record<string, unknown> | null;
    if (arg && arg.ref === 'CURRENT_DATE') return { fn: name, args: [] };
    return stampAsOf(args[0], { fn: name, args: [] });
  }
}

export interface CalcDraftToken {
  kind: 'field' | 'fn' | 'number' | 'op' | 'paren' | 'comma' | 'keyword' | 'text';
  text: string;
  start: number;
  end: number;
}

/** Splits an infix draft into the chips shown in the expression builder. */
export function tokenizeCalcDraft(source: string, nullary: ReadonlySet<string> = new Set()): CalcDraftToken[] {
  const tokens: CalcDraftToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', text: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma', text: ',', start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ kind: 'op', text: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if ((char >= '0' && char <= '9') || (char === '.' && source[index + 1] >= '0' && source[index + 1] <= '9')) {
      const match = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(source.slice(index));
      if (match) {
        tokens.push({ kind: 'number', text: match[0], start: index, end: index + match[0].length });
        index += match[0].length;
        continue;
      }
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name) {
      const text = name[0];
      const end = index + text.length;
      const upper = text.toUpperCase();
      let kind: CalcDraftToken['kind'] = 'field';
      if (upper === 'AS' || upper === 'OF') kind = 'keyword';
      else if (nullary.has(upper) || looksLikeCall(source, end)) kind = 'fn';
      tokens.push({ kind, text, start: index, end });
      index = end;
      continue;
    }
    tokens.push({ kind: 'text', text: char, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function looksLikeCall(source: string, index: number): boolean {
  let cursor = index;
  while (source[cursor] === ' ' || source[cursor] === '\n' || source[cursor] === '\t') cursor += 1;
  return source[cursor] === '(';
}

/** Inserts a field, function, number, or operator into an infix draft. */
export function insertCalcDraft(source: string, offset: number, raw: string): { next: string; caret: number } {
  const at = Math.max(0, Math.min(offset, source.length));
  const ins = raw.trim();
  if (!ins) return { next: source, caret: at };
  const left = source.slice(0, at).replace(/\s+$/, '');
  const right = source.slice(at).replace(/^\s+/, '');
  if (/^[+\-*/]$/.test(ins)) {
    const mid = `${left ? ' ' : ''}${ins}`;
    const tail = right ? ` ${right}` : '';
    return { next: left + mid + tail, caret: left.length + mid.length };
  }
  if (ins === ',') {
    const tail = right ? ` ${right}` : '';
    return { next: `${left},${tail}`, caret: left.length + 1 };
  }
  if (ins === ')') {
    const tail = right ? `${/^[,)]/.test(right) ? '' : ' '}${right}` : '';
    return { next: `${left})${tail}`, caret: left.length + 1 };
  }
  if (ins === '(') {
    const glue = !left || /[A-Za-z0-9_]$/.test(left);
    const mid = `${glue || !left ? '' : ' '}(`;
    return { next: left + mid + right, caret: left.length + mid.length };
  }
  const glueLeft = !left || /[(,]$/.test(left);
  const mid = `${glueLeft ? '' : ' '}${ins}`;
  const glueRight = !right || /^[,)]/.test(right) || ins.endsWith('(');
  const tail = right ? `${glueRight ? '' : ' '}${right}` : '';
  return { next: left + mid + tail, caret: left.length + mid.length };
}

/** Removes one chip and closes the space it left behind. */
export function deleteCalcDraft(source: string, start: number, end: number): { next: string; caret: number } {
  const left = source.slice(0, start).replace(/\s+$/, '');
  const right = source.slice(end).replace(/^\s+/, '');
  if (!left) return { next: right, caret: 0 };
  if (!right) return { next: left, caret: left.length };
  const gap = /[(,]$/.test(left) || /^[,)]/.test(right) ? '' : ' ';
  return { next: left + gap + right, caret: left.length };
}

/** Chip index where a caret offset sits. */
export function caretToGap(tokens: CalcDraftToken[], caret: number): number {
  const index = tokens.findIndex((token) => token.start >= caret);
  return index < 0 ? tokens.length : index;
}
