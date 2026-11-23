import { describe, expect, it } from 'vitest';
import { DbError, ok } from './db-result';

describe('ok', () => {
  it('passes a result through', () => {
    expect(ok({ data: [1], error: null })).toEqual({ data: [1], error: null });
  });
  it('throws the database error instead of returning no data', () => {
    expect(() => ok({ data: null, error: { message: 'permission denied for table x', code: '42501' } })).toThrow(DbError);
    expect(() => ok({ data: null, error: { message: 'permission denied for table x', code: '42501' } })).toThrow(/You do not have access/);
    try {
      ok({ data: null, error: { message: 'permission denied for table x', code: '42501' } });
    } catch (error) {
      // The database's own text is kept for the log, not shown.
      expect((error as DbError).raw).toBe('permission denied for table x');
    }
  });
  it('reads "no row" from .single() as null data', () => {
    expect(ok({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }).data).toBeNull();
  });
});
