import { describe, expect, it } from 'vitest';
import { EntityMatchIndex, codeUnavailableMessage, identifierCatalog, type MatchEntity } from './entity-match';

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
  it('matches a project name stored as another name of the borrower', () => {
    const index = indexWith([
      entity({ id: 'acme', code: 'ACME', name: 'Acme Holdings', aliases: ['Project Falcon'] }),
    ]);
    const hit = index.resolve({ code: 'Project Falcon', name: 'Project Falcon', attributes: new Map() });
    expect(hit).toMatchObject({ kind: 'match', via: 'name', entity: { id: 'acme' } });
  });

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
    expect(codeHit).toEqual({ kind: 'rejected', message: codeUnavailableMessage('ISS-9') });
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
    expect(hit.kind).toBe('ambiguous');
    if (hit.kind !== 'ambiguous') return;
    expect(hit.entities.map((item) => item.id).sort()).toEqual(['a', 'b']);
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

  it('matches a reused identifier to the entity that held it on the file as-of date', () => {
    const loanCatalog = identifierCatalog([['LOAN_X_CODE']]);
    const index = new EntityMatchIndex(loanCatalog, 'SECURITY', 'client-1');
    index.add(entity({
      id: 'prior',
      code: 'LOAN-001',
      name: 'Original term loan',
      domainCode: 'SECURITY',
      identifierTerms: new Map([['LOAN_X_CODE', [{ value: 'LX123456', validFrom: '2020-01-01', validTo: '2024-06-30' }]]]),
    }));
    index.add(entity({
      id: 'successor',
      code: 'LX123456',
      name: 'Refinanced term loan',
      domainCode: 'SECURITY',
      identifierTerms: new Map([['LOAN_X_CODE', [{ value: 'LX-123456', validFrom: '2024-07-01', validTo: '9999-12-31' }]]]),
    }));

    const historical = index.resolve({
      code: 'LX123456',
      name: 'Refinanced term loan',
      attributes: new Map([['Loan_X_Code', 'LX-123456']]),
    }, '2024-03-31');
    expect(historical.kind).toBe('match');
    if (historical.kind !== 'match') return;
    expect(historical.entity.id).toBe('prior');
    expect(historical.via).toBe('identifier');

    const current = index.resolve({
      code: 'LX123456',
      name: 'Original term loan',
      attributes: new Map([['LOAN_X_CODE', 'LX123456']]),
    }, '2024-09-30');
    expect(current.kind).toBe('match');
    if (current.kind !== 'match') return;
    expect(current.entity.id).toBe('successor');

    const gap = index.resolve({
      code: 'FILE-ONLY',
      name: 'Unrelated',
      attributes: new Map([['LOAN_X_CODE', 'LX123456']]),
    }, '2019-12-31');
    expect(gap.kind).toBe('none');
  });

  it('asks for a decision when two entities hold the identifier on the as-of date', () => {
    const loanCatalog = identifierCatalog([['LOAN_X_CODE']]);
    const index = new EntityMatchIndex(loanCatalog, 'SECURITY', 'client-1');
    index.add(entity({
      id: 'a',
      code: 'LOAN-001',
      name: 'First loan',
      domainCode: 'SECURITY',
      identifierTerms: new Map([['LOAN_X_CODE', [{ value: 'LX1', validFrom: '2020-01-01', validTo: '9999-12-31' }]]]),
    }));
    index.add(entity({
      id: 'b',
      code: 'LOAN-002',
      name: 'Second loan',
      domainCode: 'SECURITY',
      identifierTerms: new Map([['LOAN_X_CODE', [{ value: 'LX1', validFrom: '2020-01-01', validTo: '9999-12-31' }]]]),
    }));
    const hit = index.resolve({
      code: 'FILE',
      name: 'Incoming',
      attributes: new Map([['LOAN_X_CODE', 'LX1']]),
    }, '2024-03-31');
    expect(hit.kind).toBe('ambiguous');
    if (hit.kind !== 'ambiguous') return;
    expect(hit.via).toBe('identifier');
    expect(hit.entities.map((item) => item.id).sort()).toEqual(['a', 'b']);
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

describe('entity match keeps each client to its own records', () => {
  const base = { domainCode: 'ISSUER', active: true, provisional: false, identifiers: new Map<string, string[]>() };

  it('matches only the own record when another client holds a code that reads the same', () => {
    // Client A owns ACME1. Client B owns ACME-1. The file code compacts to both and equals neither.
    const index = new EntityMatchIndex(identifierCatalog([['LEI']]), 'ISSUER', 'client-A');
    index.add({ ...base, id: 'A-entity', code: 'ACME1', name: 'Acme A', clientId: 'client-A' });
    index.add({ ...base, id: 'B-entity', code: 'ACME-1', name: 'Acme Victim Holdings', clientId: 'client-B' });
    const hit = index.resolve({ code: 'acme_1', name: 'x', attributes: new Map() });
    expect(hit).toMatchObject({ kind: 'match', via: 'code', entity: { id: 'A-entity' } });
    expect(JSON.stringify(hit)).not.toContain('B-entity');
    expect(JSON.stringify(hit)).not.toContain('Victim');
  });

  it('never offers another client\'s record as a choice', () => {
    const index = new EntityMatchIndex(identifierCatalog([['LEI']]), 'ISSUER', 'client-A');
    index.add({ ...base, id: 'A1', code: 'ACME1', name: 'Acme', clientId: 'client-A' });
    index.add({ ...base, id: 'A2', code: 'ACME_1', name: 'Acme', clientId: 'client-A' });
    index.add({ ...base, id: 'B1', code: 'ACME-1', name: 'Acme', clientId: 'client-B' });
    const hit = index.resolve({ code: 'Acme 1', name: 'Acme', attributes: new Map() });
    expect(hit.kind).toBe('ambiguous');
    if (hit.kind !== 'ambiguous') return;
    expect(hit.entities.map((item) => item.id).sort()).toEqual(['A1', 'A2']);
    expect(hit.message).not.toContain('ACME-1');
  });

  it('does not match on an identifier another client holds', () => {
    const index = new EntityMatchIndex(identifierCatalog([['LEI']]), 'ISSUER', 'client-A');
    index.add({ ...base, id: 'B1', code: 'B-ISSUER', name: 'Secret Borrower', clientId: 'client-B', identifiers: new Map([['LEI', ['549300SECRET0000001']]]) });
    const hit = index.resolve({ code: 'NEW-ISSUER', name: 'New', attributes: new Map([['LEI', '549300SECRET0000001']]) });
    expect(hit.kind).toBe('none');
  });

  it('refuses a code held elsewhere in words that say nothing of who holds it', () => {
    const index = new EntityMatchIndex(identifierCatalog([['LEI']]), 'ISSUER', 'client-A');
    index.add({ ...base, id: 'B-entity', code: 'SECRET-DEAL', name: 'Project X', clientId: 'client-B' });
    const hit = index.resolve({ code: 'SECRET-DEAL', name: 'x', attributes: new Map() });
    expect(hit).toEqual({ kind: 'rejected', message: 'SECRET-DEAL is not available as a record code. Use a different code.' });
    expect(JSON.stringify(hit)).not.toMatch(/client|Project X|B-entity/i);
  });

  it('refuses a code reserved by the database, unless the row is one of the client\'s own records', () => {
    const index = new EntityMatchIndex(identifierCatalog([['LEI']]), 'ISSUER', 'client-A');
    index.reserveCode('TAKEN');
    index.add({ ...base, id: 'A1', code: 'A-OWN', name: 'Own Name', clientId: 'client-A' });
    expect(index.resolve({ code: 'TAKEN', name: 'Something else', attributes: new Map() })).toEqual({ kind: 'rejected', message: codeUnavailableMessage('TAKEN') });
    // The row matches a record of this client by name, so no new record takes the code.
    expect(index.resolve({ code: 'TAKEN', name: 'Own Name', attributes: new Map() })).toMatchObject({ kind: 'match', entity: { id: 'A1' } });
  });
});
