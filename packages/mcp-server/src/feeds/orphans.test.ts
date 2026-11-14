import { describe, expect, it } from 'vitest';
import { describeOrphans, orphanColumns, type ColumnAssignment } from './suggest';

function column(sourceColumn: string, role: ColumnAssignment['role'], domainCode: string | null, attributeCode: string | null = null): ColumnAssignment {
  return {
    sourceColumn,
    samples: [],
    role,
    domainCode,
    attributeCode,
    transform: { kind: 'trim' },
    parentDomainCode: null,
    filterEquals: null,
    suggestion: { method: 'manual', confidence: 1, reason: '' },
  } as unknown as ColumnAssignment;
}

describe('orphanColumns', () => {
  it('flags columns on a record type with no identity column', () => {
    const orphans = orphanColumns([
      column('Issuer Name', 'identity', 'ISSUER'),
      column('Industry', 'attribute', 'ISSUER', 'INDUSTRY'),
      column('Maturity Date', 'attribute', 'DEAL', 'DEAL_MATURITY_DATE'),
    ]);
    expect(orphans).toEqual([{ column: 'Maturity Date', domainCode: 'DEAL' }]);
    expect(describeOrphans(orphans)).toBe('"Maturity Date" belongs to DEAL, which has no identity column');
  });

  it('ignores skipped columns and fully identified record types', () => {
    expect(orphanColumns([
      column('Issuer Name', 'identity', 'ISSUER'),
      column('Industry', 'attribute', 'ISSUER', 'INDUSTRY'),
      column('Notes', 'ignore', null),
    ])).toEqual([]);
  });
});
