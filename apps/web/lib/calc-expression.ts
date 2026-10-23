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
  if (typeof node.ref === 'string') return node.ref;
  if ('const' in node) return String(node.const);
  if (node.op === 'neg' && Array.isArray(node.args)) return `-${decompileCalcExpression(node.args[0])}`;
  if (typeof node.op === 'string' && Array.isArray(node.args) && node.args.length === 2) {
    const symbol = node.op === 'add' ? '+' : node.op === 'sub' ? '-' : node.op === 'mul' ? '*' : node.op === 'div' ? '/' : node.op;
    return `${decompileCalcExpression(node.args[0])} ${symbol} ${decompileCalcExpression(node.args[1])}`;
  }
  if (typeof node.fn === 'string' && Array.isArray(node.args)) {
    return `${node.fn}(${node.args.map((arg) => decompileCalcExpression(arg)).join(', ')})`;
  }
  return JSON.stringify(expr);
}

/** Attribute codes referenced by a compiled expression, in first-seen order. */
export function collectCalcRefs(expr: unknown, found: string[] = []): string[] {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return found;
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string' && !found.includes(node.ref)) found.push(node.ref);
  if (Array.isArray(node.args)) node.args.forEach((arg) => collectCalcRefs(arg, found));
  return found;
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
      return { fn: name[0].toUpperCase(), args };
    }
    return { ref: name[0] };
  }
}
