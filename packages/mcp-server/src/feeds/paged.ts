/**
 * Reads every row of a query a page at a time.
 *
 * The database returns at most 1,000 rows to one request and says nothing when
 * it cuts a list short. A list that must be whole (every attribute a column
 * can be mapped to) is therefore read in pages until a page comes back short.
 * The query has to be ordered the same way on every page, on something unique,
 * or a row can be skipped or read twice between pages.
 */

export const PAGE_ROWS = 1000;

interface Page<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function allRows<T>(page: (from: number, to: number) => PromiseLike<Page<T>>, size: number = PAGE_ROWS): Promise<Page<T>> {
  const rows: T[] = [];
  // A register a hundred times this size would still end; a query that ignores its range would not.
  for (let from = 0; from < size * 200; from += size) {
    const result = await page(from, from + size - 1);
    if (result.error) return { data: null, error: result.error };
    const batch = result.data || [];
    rows.push(...batch);
    if (batch.length < size) break;
  }
  return { data: rows, error: null };
}
