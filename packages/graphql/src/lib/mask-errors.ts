/**
 * What a GraphQL caller is told when a resolver fails.
 *
 * Pages show resolver messages ("Choose an as-of date…", "Deal not found"), so
 * errors are not all hidden. What must not reach a caller is the database's own
 * text: table, column, constraint and function names, SQL, and row values in a
 * duplicate-key message. Those are replaced with a plain message and a reference
 * that matches the server log.
 *
 * Messages our database functions raise on purpose (RAISE EXCEPTION, SQLSTATE
 * P0001, or the readable 22023 / P0002 ones) are written for people and pass.
 */
import { GraphQLError } from 'graphql';

interface Coded {
  code?: unknown;
  message?: unknown;
}

/** Text that only the database writes. */
const DATABASE_TEXT = [
  /\brelation "[^"]+"/i,
  /\bcolumn "?[\w.]+"? (?:does not exist|of relation)/i,
  /\bviolates (?:unique|foreign key|check|not-null|exclusion) constraint/i,
  /\bduplicate key value\b/i,
  /\bsyntax error at or near\b/i,
  /\bfunction [\w.]+\(.*\) does not exist/i,
  /\bpermission denied for (?:table|schema|function|relation|sequence|view)\b/i,
  /\bnew row violates row-level security policy\b/i,
  /\binvalid input syntax for type\b/i,
  /\bcould not find the (?:function|table|relation)\b.*schema cache/i,
  /\bPGRST\d{3}\b/,
  /\bJSON object requested, multiple \(or no\) rows returned\b/i,
];

/** Database error classes whose text is for developers, and what a person is told instead. */
const BY_CODE: Array<[RegExp, string]> = [
  [/^42501$/, 'You do not have access to this.'],
  [/^23505$/, 'That already exists.'],
  [/^23503$/, 'It refers to a record that does not exist, or a record still uses it.'],
  [/^23502$/, 'A required value is missing.'],
  [/^23514$/, 'A value is outside what is allowed.'],
  [/^22P02$/, 'A value is not in the expected format.'],
  [/^(?:42|XX|58|53|57|08|40|PGRST)/, ''],
];

/** Readable messages our functions raise on purpose. */
const OWN_CODES = /^(?:P0001|P0002|22023|21000)$/;

function codeOf(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as Coded).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { originalError?: unknown; cause?: unknown }).originalError ?? (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The message a caller may see, or null when it must be replaced. */
export function safeMessage(error: unknown, message: string): string | null {
  const code = codeOf(error);
  if (code && OWN_CODES.test(code)) return message;
  if (code) {
    for (const [pattern, replacement] of BY_CODE) if (pattern.test(code)) return replacement || null;
  }
  if (DATABASE_TEXT.some((pattern) => pattern.test(message))) return null;
  return message;
}

/**
 * For graphql-yoga's maskedErrors.maskError. Validation errors (no original
 * error) pass unchanged. A replaced message carries a reference also logged
 * with the real error.
 */
export function maskGraphqlError(error: unknown, message: string): Error {
  const graphqlError = error instanceof GraphQLError ? error : null;
  const original = graphqlError?.originalError ?? error;
  if (graphqlError && !graphqlError.originalError) return graphqlError;
  const text = original instanceof Error ? original.message : String(message || '');
  const shown = safeMessage(original, text);
  if (shown === text && graphqlError) return graphqlError;
  const reference = Math.random().toString(36).slice(2, 10).toUpperCase();
  if (shown === null) console.error(`[GraphQL] ${reference}:`, original);
  return new GraphQLError(shown ?? `The request could not be completed. Reference ${reference}.`, {
    nodes: graphqlError?.nodes,
    source: graphqlError?.source,
    positions: graphqlError?.positions,
    path: graphqlError?.path,
    extensions: { code: shown === null ? 'INTERNAL' : 'REFUSED', ...(shown === null ? { reference } : {}) },
  });
}
