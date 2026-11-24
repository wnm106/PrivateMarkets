/**
 * Entity codes are unique within a client, not across clients. A caller who
 * belongs to more than one client can see two records with the same code, one
 * in each. A lookup that wants one record by code reads up to two rows and,
 * when it finds two, says so rather than picking one.
 */

/** Rows to read for a lookup by code: one more than needed, so a second client's record shows. */
export const CODE_LOOKUP_LIMIT = 2;

export function ambiguousCodeMessage(code: string): string {
  return `Entity code ${code} is used in more than one of your clients. Open the client you are working in, or use the record id.`;
}

/** The one record a code names among the rows read, or null when there is none. */
export function oneByCode<T>(rows: readonly T[] | null | undefined, code: string): T | null {
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) throw new Error(ambiguousCodeMessage(code));
  return rows[0];
}
