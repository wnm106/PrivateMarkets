import { describe, expect, it } from 'vitest';
import {
  discoveredMapCode,
  headerSignature,
  mapNameFromAssignments,
  overlayStoredMap,
  positionFileHeaders,
  proposeLoadIdentity,
  templateFromAssignments,
} from './load-maps';
import type { ColumnAssignment } from './suggest';

function assignment(partial: Partial<ColumnAssignment> & Pick<ColumnAssignment, 'sourceColumn' | 'role'>): ColumnAssignment {
  return {
    samples: ['a'],
    domainCode: null,
    attributeCode: null,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'trim' },
    suggestion: { method: 'name', confidence: 0.9, reason: 'guess' },
    ...partial,
  };
}

describe('load maps', () => {
  it('treats the same columns in a different order as one shape', () => {
    expect(headerSignature(['Name', ' Code '])).toBe(headerSignature(['code', 'name']));
  });

  it('recognizes the position file column set', () => {
    expect(positionFileHeaders()).toHaveLength(42);
    const identity = proposeLoadIdentity(positionFileHeaders(), []);
    expect(identity.mapCode).toBe('POSITION_FILE');
    expect(identity.sourceCode).toBe('POSITION_FILE');
  });

  it('gives a new file its own map code and a name from the records it identifies', () => {
    const headers = ['Deal name', 'Amount'];
    const identity = proposeLoadIdentity(headers, [
      assignment({ sourceColumn: 'Deal name', role: 'identity', domainCode: 'DEAL' }),
    ]);
    expect(identity.mapCode).toBe(discoveredMapCode(headerSignature(headers)));
    expect(identity.sourceCode).toBe('IMPORT');
    expect(identity.name).toBe('Deal');
    expect(mapNameFromAssignments([
      assignment({ sourceColumn: 'Issuer', role: 'identity', domainCode: 'ISSUER' }),
      assignment({ sourceColumn: 'Security', role: 'identity', domainCode: 'SECURITY' }),
    ])).toBe('Issuer and Security');
  });

  it('lets a saved map replace a fresh suggestion and keeps the cleanup', () => {
    const discovered = [assignment({ sourceColumn: 'Industry', role: 'ignore', suggestion: { method: 'name', confidence: 0.2, reason: 'none' } })];
    const template = templateFromAssignments([
      assignment({
        sourceColumn: 'Industry',
        role: 'attribute',
        domainCode: 'ISSUER',
        attributeCode: 'INDUSTRY',
        transform: { kind: 'uppercase' },
      }),
    ]);
    const [overlaid] = overlayStoredMap(discovered, template, 'Positions');
    expect(overlaid.role).toBe('attribute');
    expect(overlaid.attributeCode).toBe('INDUSTRY');
    expect(overlaid.transform.kind).toBe('uppercase');
    expect(overlaid.samples).toEqual(['a']);
    expect(overlaid.suggestion.method).toBe('source_map');
    expect(template[0].samples).toEqual([]);
  });
});
