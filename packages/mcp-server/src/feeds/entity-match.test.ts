import { describe, expect, it } from 'vitest';
import { EntityMatchIndex, identifierCatalog, type MatchEntity } from './entity-match';

const catalog = identifierCatalog([
  ['LEI'],
  ['ISSUER_LEGAL_NAME', 'LEI'],
  ['ISIN'],
  ['CUSIP'],
]);

function entity(partial: Partial<MatchEntity> & Pick<MatchEntity, 'id' | 'code' | 'name'>): MatchEntity {
  return {
    domainCode: 'ISSUER',
    clientId: 'client-1',
    active: true,
    provisional: false,
    identifiers: new Map(),
    ...partial,
  };
}

function indexWith(entities: MatchEntity[]): EntityMatchIndex {
  const index = new EntityMatchIndex(catalog, 'ISSUER', 'client-1');
  for (const item of entities) index.add(item);
  return index;
}

describe('entity match for loads', () => {
  it('matches a file that only has the issuer name to the entity with that name', () => {
    const index = indexWith([
      entity({ id: 'original', code: 'BENCH-ISS-0001', name: 'Bench Issuer 1' }),
      entity({ id: 'duplicate', code: 'Bench Issuer 1', name: 'Bench Issuer 1' }),
    ]);
    const hit = index.resolve({
      code: 'Bench Issuer 1',
      name: 'Bench Issuer 1',
      attributes: new Map(),
    });
    expect(hit.kind).toBe('match');
    if (hit.kind !== 'match') return;
    expect(hit.entity.id).toBe('original');
    expect(hit.via).toBe('name');
  });

  it('matches a shared identifier when the code and name differ', () => {
    const index = indexWith([
      entity({
        id: 'original',
        code: 'BENCH-ISS-0001',
        name: 'Northwind Packaging LLC',
        identifiers: new Map([['LEI', ['549300NORTHWIND00001']]]),
      }),
    ]);
    const hit = index.resolve({
      code: 'NW-FILE',
      name: 'Northwind Holdings',
      attributes: new Map([['LEI', '5493-00 NORTHWIND 00001']]),
    });
    expect(hit.kind).toBe('match');
    if (hit.kind !== 'match') return;
    expect(hit.entity.id).toBe('original');
    expect(hit.via).toBe('identifier');
  });

  it('matches the entity code, including punctuation differences', () => {
    const index = indexWith([
      entity({ id: 'original', code: 'BENCH-ISS-0001', name: 'Something else' }),
    ]);
    const hit = index.resolve({
      code: 'benchiss0001',
      name: 'Unrelated name',
      attributes: new Map(),
    });
    expect(hit.kind).toBe('match');
    if (hit.kind !== 'match') return;
    expect(hit.via).toBe('code');
    expect(hit.entity.id).toBe('original');
  });

  it('does not treat one part of a composite identifier as a match', () => {
    const index = indexWith([
      entity({
        id: 'original',
        code: 'ISS-1',
        name: 'Northwind Packaging',
        identifiers: new Map([
          ['ISSUER_LEGAL_NAME', ['Northwind Packaging LLC']],
          ['LEI', ['549300NORTHWIND00001']],
        ]),
      }),
    ]);
    const hit = index.resolve({
      code: 'OTHER',
      name: 'Different Issuer',
      attributes: new Map([['ISSUER_LEGAL_NAME', 'Northwind Packaging LLC']]),
    });
    expect(hit.kind).toBe('none');
  });

  it('matches a composite identifier when every part agrees', () => {
    const index = indexWith([
      entity({
        id: 'original',
        code: 'ISS-1',
        name: 'Stored name',
        identifiers: new Map([
          ['ISSUER_LEGAL_NAME', ['Northwind Packaging LLC']],
          ['LEI', ['549300NORTHWIND00001']],
        ]),
      }),
    ]);
    const hit = index.resolve({
      code: 'OTHER',
      name: 'Different Issuer',
      attributes: new Map([
        ['issuer_legal_name', 'Northwind Packaging, LLC'],
        ['lei', '549300NORTHWIND00001'],
      ]),
    });
    expect(hit.kind).toBe('match');
    if (hit.kind !== 'match') return;
    expect(hit.via).toBe('identifier');
  });

  it('ignores the same name on another client and rejects a code owned by another client', () => {
    const index = indexWith([
      entity({ id: 'other', code: 'ISS-9', name: 'Bench Issuer 1', clientId: 'client-2' }),
    ]);
    expect(index.resolve({ code: 'NEW', name: 'Bench Issuer 1', attributes: new Map() }).kind).toBe('none');
    const codeHit = index.resolve({ code: 'ISS-9', name: 'Different', attributes: new Map() });
    expect(codeHit.kind).toBe('rejected');
  });

  it('rejects a code that already belongs to another domain', () => {
    const index = indexWith([
      entity({ id: 'fund', code: 'SHARED', name: 'Shared', domainCode: 'FUND' }),
    ]);
    const hit = index.resolve({ code: 'SHARED', name: 'Shared', attributes: new Map() });
    expect(hit.kind).toBe('rejected');
    if (hit.kind !== 'rejected') return;
    expect(hit.message).toContain('FUND');
  });

  it('refuses to guess when two coded entities share a name', () => {
    const index = indexWith([
      entity({ id: 'a', code: 'ISS-A', name: 'Northwind' }),
      entity({ id: 'b', code: 'ISS-B', name: 'Northwind' }),
    ]);
    const hit = index.resolve({ code: 'FILE', name: 'Northwind', attributes: new Map() });
    expect(hit.kind).toBe('rejected');
  });

  it('collapses a later file row onto an entity resolved earlier in the same load', () => {
    const index = new EntityMatchIndex(catalog, 'ISSUER', 'client-1');
    const first = {
      code: 'FILE-1',
      name: 'Cedar Ridge',
      attributes: new Map([['LEI', '549300CEDAR000000001']]),
    };
    expect(index.resolve(first).kind).toBe('none');
    index.add(entity({
      id: 'pending:FILE-1',
      code: first.code,
      name: first.name,
      provisional: true,
      identifiers: new Map([['LEI', ['549300CEDAR000000001']]]),
    }));
    const second = index.resolve({
      code: 'FILE-2',
      name: 'Cedar Ridge Holdings',
      attributes: new Map([['LEI', '549300CEDAR000000001']]),
    });
    expect(second.kind).toBe('match');
    if (second.kind !== 'match') return;
    expect(second.entity.id).toBe('pending:FILE-1');
    expect(second.via).toBe('identifier');
  });

  it('strips a legal suffix when comparing names', () => {
    const index = indexWith([
      entity({ id: 'original', code: 'DQ-ISS-NORTHWIND', name: 'Northwind Packaging' }),
    ]);
    const hit = index.resolve({
      code: 'Northwind Packaging LLC',
      name: 'Northwind Packaging LLC',
      attributes: new Map(),
    });
    expect(hit.kind).toBe('match');
    if (hit.kind !== 'match') return;
    expect(hit.entity.id).toBe('original');
    expect(hit.via).toBe('name');
  });
});
