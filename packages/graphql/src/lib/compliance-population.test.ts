import { describe, expect, it } from 'vitest';
import { conditionValueKey, pathKey } from './compliance-population';

describe('condition value keys', () => {
  it('keys an attribute on the record by its code alone', () => {
    expect(conditionValueKey([], 'SECTOR')).toBe('SECTOR');
    expect(conditionValueKey(null, 'SECTOR')).toBe('SECTOR');
  });

  it('prefixes an attribute along a path with the path', () => {
    const path = [{ relationshipCode: 'POSITION_SECURITY', direction: 'up' }, { relationshipCode: 'SECURITY_ISSUER', direction: 'UP' }];
    expect(pathKey(path)).toBe('UP:POSITION_SECURITY|UP:SECURITY_ISSUER');
    expect(conditionValueKey(path, 'RATING')).toBe('UP:POSITION_SECURITY|UP:SECURITY_ISSUER\u001fRATING');
  });
});
