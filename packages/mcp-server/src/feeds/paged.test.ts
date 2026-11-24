import { describe, expect, it } from 'vitest';
import { allRows } from './paged';

/** A table that, like the database, never returns more than `cap` rows to one request. */
function table(count: number, cap: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ name: `Attribute ${String(index).padStart(5, '0')}` }));
  const calls: Array<[number, number]> = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null };
  };
  return { rows, calls, page };
}

describe('reading every row of a list', () => {
  it('reads past the first page, to the last row', async () => {
    const source = table(2063, 1000);
    const result = await allRows(source.page);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2063);
    expect(result.data?.[2062]).toEqual(source.rows[2062]);
    expect(source.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops at a page that comes back short, and reads a short list once', async () => {
    const short = table(12, 1000);
    expect((await allRows(short.page)).data).toHaveLength(12);
    expect(short.calls).toHaveLength(1);
    // A list that ends exactly on a page asks once more and gets nothing.
    const exact = table(20, 10);
    expect((await allRows(exact.page, 10)).data).toHaveLength(20);
    expect(exact.calls).toEqual([[0, 9], [10, 19], [20, 29]]);
  });

  it('gives the error back and no rows when a page fails', async () => {
    const result = await allRows(async (from) => (from === 0 ? { data: [{ name: 'a' }, { name: 'b' }], error: null } : { data: null, error: { message: 'timeout' } }), 2);
    expect(result).toEqual({ data: null, error: { message: 'timeout' } });
  });
});
