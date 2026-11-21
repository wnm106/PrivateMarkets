/**
 * Writing and reading =TAP formulas.
 *
 * Excel custom functions always carry a namespace, so the function itself is
 * TAPESTRY.TAP. The add-in also defines a workbook name TAP, a LAMBDA that calls it,
 * so a person can write =TAP("NAV", "FUND-1"). The builder writes =TAP when that
 * name is in the workbook and =TAPESTRY.TAP when it is not.
 */

export const FUNCTION_NAMESPACE = 'TAPESTRY';
export const FUNCTION_ID = 'TAP';
export const QUALIFIED_FUNCTION = `${FUNCTION_NAMESPACE}.${FUNCTION_ID}`;
export const SHORT_NAME = 'TAP';

/** The workbook name that makes =TAP(...) work. ISOMITTED keeps the as-of optional. */
export const SHORT_NAME_FORMULA =
  `=LAMBDA(attribute, entity, [as_of], ${QUALIFIED_FUNCTION}(attribute, entity, IF(ISOMITTED(as_of), "", as_of)))`;
export const SHORT_NAME_COMMENT = 'Tapestry: =TAP(attribute, record, [as_of]). Added by the Tapestry add-in.';

/** An argument is either a literal the builder quotes, or a cell reference or expression kept as written. */
export type FormulaArgument = { kind: 'text'; value: string } | { kind: 'expression'; value: string };

export interface TapFormula {
  attribute: FormulaArgument;
  entity: FormulaArgument;
  asOf: FormulaArgument | null;
}

export function quoteExcelString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function render(argument: FormulaArgument): string {
  return argument.kind === 'text' ? quoteExcelString(argument.value) : argument.value;
}

/** A cell reference (B2, $B$2, Sheet1!B2, 'My sheet'!B2) or a defined name. */
export function looksLikeReference(value: string): boolean {
  const text = value.trim();
  return /^(?:(?:'[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$/.test(text);
}

/** The as-of a person typed in the builder: a date, a cell reference, or nothing. */
export function asOfArgument(input: string): FormulaArgument | null {
  const text = input.trim();
  if (!text) return null;
  if (looksLikeReference(text)) return { kind: 'expression', value: text.replace(/^=/, '') };
  return { kind: 'text', value: text };
}

export function buildTapFormula(formula: TapFormula, useShortName: boolean): string {
  const name = useShortName ? SHORT_NAME : QUALIFIED_FUNCTION;
  const args = [render(formula.attribute), render(formula.entity)];
  if (formula.asOf) args.push(render(formula.asOf));
  return `=${name}(${args.join(', ')})`;
}

/** Split a function's argument list at top-level commas. Quotes and brackets are respected. */
export function splitArguments(text: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      current += char;
      if (char === '"') {
        if (text[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    if (depth < 0) return null;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (inString || depth !== 0) return null;
  args.push(current.trim());
  return args;
}

function parseArgument(text: string): FormulaArgument | null {
  if (!text) return null;
  const quoted = text.match(/^"((?:[^"]|"")*)"$/);
  if (quoted) return { kind: 'text', value: quoted[1].replace(/""/g, '"') };
  return { kind: 'expression', value: text };
}

/** A cell formula that is exactly one TAP call, or null. */
export function parseTapFormula(formula: unknown): TapFormula | null {
  if (typeof formula !== 'string') return null;
  const match = formula.trim().match(/^=\s*(?:TAPESTRY\.TAP|TAP)\s*\(([\s\S]*)\)\s*$/i);
  if (!match) return null;
  const args = splitArguments(match[1]);
  if (!args || args.length < 2 || args.length > 3) return null;
  const attribute = parseArgument(args[0]);
  const entity = parseArgument(args[1]);
  if (!attribute || !entity) return null;
  return { attribute, entity, asOf: args[2] ? parseArgument(args[2]) : null };
}
