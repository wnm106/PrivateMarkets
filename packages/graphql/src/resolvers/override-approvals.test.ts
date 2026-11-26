import { describe, expect, it } from 'vitest';
import { overrideStatusFilter, withRecordNames } from './override-approvals';

describe('overrideStatusFilter', () => {
  it('defaults to pending, and ALL lists every status', () => {
    expect(overrideStatusFilter(undefined)).toBe('PENDING');
    expect(overrideStatusFilter('approved')).toBe('APPROVED');
    expect(overrideStatusFilter('ALL')).toBeNull();
  });

  it('refuses anything else', () => {
    expect(() => overrideStatusFilter('DONE')).toThrow('status is');
  });
});

describe('withRecordNames', () => {
  it('adds each record\'s name, and leaves it blank for a record the caller cannot read', () => {
    const names = new Map([['e1', { entityCode: 'A-FUND-1', entityName: 'Alpha Fund One', domainCode: 'FUND' }]]);
    expect(withRecordNames([{ entityId: 'e1' }, { entityId: 'e2' }], names)).toEqual([
      { entityId: 'e1', entityCode: 'A-FUND-1', entityName: 'Alpha Fund One', domainCode: 'FUND' },
      { entityId: 'e2', entityCode: null, entityName: null, domainCode: null },
    ]);
  });
});
