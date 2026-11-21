/**
 * A stand-in for the Supabase client in unit tests. Every query is recorded
 * with its table, operation, payload and filters, and answered by a handler.
 */

export type FakeOp = 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';

export interface FakeCall {
  schema: string;
  table: string | null;
  fn: string | null;
  op: FakeOp;
  payload: unknown;
  columns: string | null;
  filters: Array<[string, ...unknown[]]>;
  returning: boolean;
}

export type FakeResult = { data?: unknown; error?: unknown; count?: number | null };
export type FakeHandler = (call: FakeCall) => FakeResult | undefined;

const FILTERS = ['eq', 'neq', 'in', 'is', 'lt', 'lte', 'gt', 'gte', 'or', 'not', 'ilike', 'like', 'match', 'filter', 'contains', 'order', 'limit', 'range', 'returns'];

export function fakeSupabase(handler: FakeHandler = () => undefined) {
  const calls: FakeCall[] = [];

  const builder = (call: FakeCall) => {
    const chain: any = {};
    for (const name of FILTERS) {
      chain[name] = (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return chain;
      };
    }
    chain.select = (columns?: string) => {
      if (call.op === 'select') call.columns = columns ?? '*';
      else call.returning = true;
      return chain;
    };
    chain.single = () => chain;
    chain.maybeSingle = () => chain;
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      calls.push(call);
      const result = handler(call) || {};
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null }).then(resolve, reject);
    };
    return chain;
  };

  const start = (schema: string, table: string | null, fn: string | null, op: FakeOp, payload: unknown = null) =>
    builder({ schema, table, fn, op, payload, columns: null, filters: [], returning: false });

  const tables = (schema: string) => (table: string) => ({
    select: (columns?: string) => {
      const chain = start(schema, table, null, 'select');
      return chain.select(columns);
    },
    insert: (payload: unknown) => start(schema, table, null, 'insert', payload),
    update: (payload: unknown) => start(schema, table, null, 'update', payload),
    upsert: (payload: unknown) => start(schema, table, null, 'upsert', payload),
    delete: () => start(schema, table, null, 'delete'),
  });

  const client: any = {
    from: tables('public'),
    rpc: (fn: string, args?: unknown) => start('public', null, fn, 'rpc', args ?? null),
    schema: (name: string) => ({
      from: tables(name),
      rpc: (fn: string, args?: unknown) => start(name, null, fn, 'rpc', args ?? null),
    }),
  };

  return { client, calls };
}

/** The value a recorded call filtered a column on with `op` (eq, in, ...). */
export function filterValue(call: FakeCall, op: string, column: string): unknown {
  const found = call.filters.find(([name, first]) => name === op && first === column);
  return found ? found[2] : undefined;
}
