/**
 * A Supabase result, or an error that says what failed.
 *
 * Reading only `data` from a result drops its `error`: a permission or network
 * failure then looks like "no data", and the page shows an empty list instead of
 * saying something went wrong. Wrap the call: `const { data } = ok(await query)`.
 *
 * "No row" from .single() (PGRST116) is not a failure: it comes back as null
 * data, the way .maybeSingle() reports it.
 */
import { safeMessage } from './mask-errors';

export interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

/**
 * A refused database call. `message` is safe to show a person (lib/mask-errors.ts),
 * since mutation payloads pass it on; `raw` keeps the database's own text for the log.
 */
export class DbError extends Error {
  readonly raw: string;
  constructor(readonly code: string | undefined, raw: string) {
    super(safeMessage({ code }, raw) ?? 'The database refused the request.');
    this.raw = raw;
  }
}

export function ok<T, R extends DbResult<T>>(result: R): R {
  const error = result?.error;
  if (!error) return result;
  if (error.code === 'PGRST116') return { ...result, data: null, error: null };
  throw new DbError(error.code, error.message || 'The database refused the request.');
}
