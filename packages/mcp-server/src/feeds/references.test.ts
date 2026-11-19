import { describe, expect, it } from 'vitest';
import { emptyReferenceIndex, indexReferences, matchReference, referenceLookups } from './references';

const APEX = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
const APEX_HOLD = '7a2d3b5f-2c3d-4e4f-9a0b-1c2d3e4f5a6b';
const OTHER = '8b3e4c6a-3d4e-4f5a-8b1c-2d3e4f5a6b7c';

function index() {
  return indexReferences(emptyReferenceIndex(), [
    { id: APEX, code: 'ISS-001', name: 'Apex Industries' },
    { id: APEX_HOLD, code: 'ISS-002', name: 'Apex Holdings' },
    { id: OTHER, code: 'ISS-003', name: 'Apex Holdings' },
  ]);
}

describe('matchReference', () => {
  it('matches a record id, ignoring case', () => {
    expect(matchReference(index(), APEX.toUpperCase())).toEqual({ kind: 'match', id: APEX, matchType: 'id' });
  });

  it('matches an entity code before a name', () => {
    expect(matchReference(index(), ' iss-002 ')).toEqual({ kind: 'match', id: APEX_HOLD, matchType: 'code' });
  });

  it('matches a name only one record holds, ignoring case and extra spaces', () => {
    expect(matchReference(index(), 'apex   industries')).toEqual({ kind: 'match', id: APEX, matchType: 'name' });
  });

  it('does not pick between records that share a name', () => {
    expect(matchReference(index(), 'Apex Holdings')).toEqual({ kind: 'ambiguous' });
  });

  it('reports no match for an unknown or blank value', () => {
    expect(matchReference(index(), 'Nobody Inc')).toEqual({ kind: 'none' });
    expect(matchReference(index(), '  ')).toEqual({ kind: 'none' });
  });

  it('keeps one record named twice as a match', () => {
    const twice = indexReferences(emptyReferenceIndex(), [
      { id: APEX, code: 'ISS-001', name: 'Apex Industries' },
      { id: APEX, code: 'ISS-001', name: 'Apex Industries' },
    ]);
    expect(matchReference(twice, 'Apex Industries')).toEqual({ kind: 'match', id: APEX, matchType: 'name' });
  });
});

describe('referenceLookups', () => {
  it('splits ids from codes and names', () => {
    expect(referenceLookups([APEX, 'ISS-001', ' Apex Industries ', ''])).toEqual({
      ids: [APEX],
      texts: ['ISS-001', 'Apex Industries'],
    });
  });
});
