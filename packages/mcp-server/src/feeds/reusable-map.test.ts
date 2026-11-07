import { describe, expect, it } from 'vitest';
import { applyReusableMap, matchReusableMap, mergeAssignments, mergeHeaders, newMapCode, type ReusableMap } from './reusable-map';
import type { ColumnAssignment } from './suggest';

function assignment(column: string, attributeCode: string | null, role: ColumnAssignment['role'] = 'attribute'): ColumnAssignment {
  return {
    sourceColumn: column,
    samples: ['old'],
    role,
    domainCode: role === 'attribute' || role === 'identity' ? 'POSITION' : null,
    attributeCode,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'trim' },
    suggestion: { method: 'manual', confidence: 1, reason: 'Saved' },
  };
}

function map(headers: string[], core = headers): ReusableMap {
  return {
    version: 1,
    mapCode: newMapCode('POSITIONS', core),
    kind: 'POSITIONS',
    name: 'Positions',
    description: '',
    coreHeaders: core,
    headers,
    assignments: headers.map((header, index) => ({
      sourceColumn: header,
      role: index === 0 ? 'identity' : 'attribute',
      domainCode: 'POSITION',
      attributeCode: index === 0 ? null : `ATTR_${index}`,
      parentDomainCode: null,
      filterEquals: null,
      transform: { kind: 'number' },
    })),
  };
}

describe('matchReusableMap', () => {
  const saved = map(['Portfolio', 'ISIN', 'Shares']);

  it('reuses a map when the headers match, regardless of order or case', () => {
    const match = matchReusableMap(['isin', 'Shares', 'PORTFOLIO'], [saved]);
    expect(match.type).toBe('exact');
    if (match.type === 'exact') expect(match.map.mapCode).toBe(saved.mapCode);
  });

  it('reuses a map when the file only adds columns', () => {
    const match = matchReusableMap(['Portfolio', 'ISIN', 'Shares', 'Notes'], [saved]);
    expect(match.type).toBe('extended');
    if (match.type === 'extended') expect(match.newHeaders).toEqual(['Notes']);
  });

  it('does not reuse a map that is missing one of its original columns', () => {
    const match = matchReusableMap(['Portfolio', 'ISIN'], [saved]);
    expect(match.type).toBe('none');
    if (match.type === 'none') expect(match.missingHeaders).toEqual(['Shares']);
  });

  it('still matches the original format after the map has learned a new field', () => {
    const extended = map(['Portfolio', 'ISIN', 'Shares', 'Notes'], ['Portfolio', 'ISIN', 'Shares']);
    expect(matchReusableMap(['Portfolio', 'ISIN', 'Shares'], [extended]).type).toBe('exact');
    const again = matchReusableMap(['Portfolio', 'ISIN', 'Shares', 'Strategy'], [extended]);
    expect(again.type).toBe('extended');
    if (again.type === 'extended') expect(again.newHeaders).toEqual(['Strategy']);
  });

  it('does not reuse a map from a different document kind', () => {
    const nav = { ...saved, kind: 'NAV_STATEMENT', mapCode: 'NAV-1', coreHeaders: ['Portfolio', 'ISIN', 'Shares'], headers: ['Portfolio', 'ISIN', 'Shares'] };
    expect(matchReusableMap(['Portfolio', 'ISIN', 'Shares'], [nav], 'POSITIONS').type).toBe('none');
  });

  it('prefers the saved map that covers more of the file', () => {
    const small = map(['Portfolio', 'ISIN']);
    const full = map(['Portfolio', 'ISIN', 'Shares', 'Market Value']);
    const match = matchReusableMap(['Portfolio', 'ISIN', 'Shares', 'Market Value'], [small, full]);
    expect(match.type).toBe('exact');
    if (match.type === 'exact') expect(match.map.mapCode).toBe(full.mapCode);
  });
});

describe('applyReusableMap', () => {
  it('keeps the saved targets and maps only the new column', () => {
    const saved = map(['Portfolio', 'Shares']);
    const fresh: ColumnAssignment[] = [{
      ...assignment('Notes', 'STRATEGY'),
      samples: ['Growth'],
      suggestion: { method: 'name', confidence: 0.7, reason: 'New column' },
    }];
    const rows = [{ Portfolio: 'Meridian Growth', Shares: '1,000', Notes: 'Growth' }];
    const applied = applyReusableMap(['portfolio', 'Shares', 'Notes'], rows, saved, fresh);
    expect(applied[0]).toMatchObject({ sourceColumn: 'portfolio', role: 'identity', suggestion: { method: 'source_map' } });
    expect(applied[0].samples).toEqual(['Meridian Growth']);
    expect(applied[1].transform).toEqual({ kind: 'number' });
    expect(applied[2]).toMatchObject({ sourceColumn: 'Notes', attributeCode: 'STRATEGY', suggestion: { method: 'name' } });
  });
});

describe('map identity', () => {
  it('uses one code for the same headers and another code when the format differs', () => {
    expect(newMapCode('POSITIONS', ['B', 'A'])).toBe(newMapCode('POSITIONS', ['a', 'b']));
    expect(newMapCode('POSITIONS', ['A'])).not.toBe(newMapCode('NAV_STATEMENT', ['A']));
    expect(newMapCode('POSITIONS', ['A', 'B'])).not.toBe(newMapCode('POSITIONS', ['A', 'C']));
    expect(mergeHeaders(['ISIN', 'Shares'], ['isin', 'Notes'])).toEqual(['ISIN', 'Shares', 'Notes']);
    const merged = mergeAssignments(
      [{ sourceColumn: 'Notes', role: 'attribute', domainCode: 'POSITION', attributeCode: 'STRATEGY', parentDomainCode: null, filterEquals: null, transform: { kind: 'trim' } }],
      [{ sourceColumn: 'Shares', role: 'attribute', domainCode: 'POSITION', attributeCode: 'SHARE_QUANTITY', parentDomainCode: null, filterEquals: null, transform: { kind: 'number' } }],
    );
    expect(merged.map((assignment) => assignment.sourceColumn)).toEqual(['Notes', 'Shares']);
  });
});
