/**
 * Batches the reads a field resolver makes per parent into one read per request.
 *
 * A list of 50 rules asking for each rule's versions made 50 queries. A loader
 * collects the ids asked for in the same tick and reads them with one `.in()`.
 * Loaders live for one request: they are keyed by the request's context object,
 * so nothing is cached across callers or tenants.
 *
 *   const versions = await loaderFor(context, 'versionsByRule', async (ids) => {
 *     const rows = ...read where rule_id in ids...
 *     return groupBy(rows, 'rule_id');
 *   }).load(parent.id);
 */

import DataLoader from 'dataloader';

const byRequest = new WeakMap<object, Map<string, DataLoader<string, unknown>>>();

export function loaderFor<V>(
  context: object,
  name: string,
  load: (ids: readonly string[]) => Promise<Map<string, V>>,
  missing: () => V,
): DataLoader<string, V> {
  let loaders = byRequest.get(context);
  if (!loaders) {
    loaders = new Map();
    byRequest.set(context, loaders);
  }
  let loader = loaders.get(name) as DataLoader<string, V> | undefined;
  if (!loader) {
    loader = new DataLoader<string, V>(async (ids) => {
      const found = await load(ids);
      return ids.map((id) => (found.has(id) ? (found.get(id) as V) : missing()));
    });
    loaders.set(name, loader as DataLoader<string, unknown>);
  }
  return loader;
}

/** Rows grouped by one of their columns. */
export function groupBy<T extends Record<string, any>>(rows: T[], column: keyof T): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row[column]);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}
