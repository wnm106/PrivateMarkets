import { describe, expect, it } from 'vitest';
import { CODE_LOOKUP_LIMIT, oneByCode } from './entity-code';

describe('one record by entity code', () => {
  it('reads one more row than it needs, so a second client shows', () => {
    expect(CODE_LOOKUP_LIMIT).toBe(2);
  });

  it('returns the record, or null when there is none', () => {
    expect(oneByCode([{ id: 'a' }], 'FUND-1')).toEqual({ id: 'a' });
    expect(oneByCode([], 'FUND-1')).toBeNull();
    expect(oneByCode(null, 'FUND-1')).toBeNull();
  });

  it('refuses to pick when the code is used in two of the caller\'s clients', () => {
    expect(() => oneByCode([{ id: 'a' }, { id: 'b' }], 'FUND-1')).toThrow(/FUND-1 is used in more than one of your clients/);
  });
});
