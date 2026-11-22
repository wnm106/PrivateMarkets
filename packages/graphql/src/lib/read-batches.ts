/**
 * Reading rows for many ids through PostgREST. Ids go in the request's address
 * and a response stops at 1,000 rows without saying so, so both are batched.
 */

/** Ids per request. Each one goes in the request's address, so a fund of several hundred positions is read in batches. */
export const ID_BATCH = 100;
/** PostgREST returns at most this many rows a request, and says nothing when there are more. */
const PAGE = 1000;

/**
 * Every row of a query over many ids: the ids in batches, and each batch read
 * page by page until a short page, so a large fund is never cut off at the cap.
 */
export async function readInBatches<T>(
  ids: string[],
  query: (batch: string[], from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out: T[] = [];
  for (let index = 0; index < unique.length; index += ID_BATCH) {
    const batch = unique.slice(index, index + ID_BATCH);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await query(batch, from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data || []) as T[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}
