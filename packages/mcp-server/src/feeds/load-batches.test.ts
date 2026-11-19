import { describe, expect, it } from 'vitest';
import { applyCellEdits, batchesMissing, planDrift, resultDigest } from './load-batch-store';
import { dedupeRecords, promoteBlockers, type BatchQuality } from './load-batches';
import type { FeedLoadResult } from './types';

function result(overrides: Partial<FeedLoadResult> = {}): FeedLoadResult {
  return {
    mapCode: 'M',
    sourceCode: 'S',
    asOfDate: '2026-09-30',
    fileName: 'f.csv',
    rowCount: 3,
    loadWaves: [['ISSUER']],
    domains: [{ domainCode: 'ISSUER', distinctEntities: 3, created: 1, matched: 2, failed: 0, errors: [] }],
    relationships: { created: 0, matched: 0, failed: 0 },
    attributes: { created: 5, updated: 1, unchanged: 4 },
    normalizations: [],
    warnings: [],
    errors: [],
    resolutions: [],
    ...overrides,
  };
}

function quality(blocking: number): BatchQuality {
  return {
    batchId: 'b',
    asOf: '2026-09-30',
    recordCount: 3,
    ruleCount: 2,
    summary: { newFailures: blocking, existingFailures: 0, cleared: 0, missingRequired: 0, blocking, outranked: 0 },
    failures: [],
    cleared: [],
    missing: [],
    outranked: [],
  };
}

describe('applyCellEdits', () => {
  const rows = [{ Name: 'Acme', Revenue: '1O0' }, { Name: 'Beta', Revenue: '200' }];

  it('lays a correction over one cell and leaves the stored rows alone', () => {
    const edited = applyCellEdits(rows, [{ row: 0, column: 'Revenue', value: '100' }]);
    expect(edited[0].Revenue).toBe('100');
    expect(edited[1]).toBe(rows[1]);
    expect(rows[0].Revenue).toBe('1O0');
  });

  it('returns the same rows when there is nothing to correct', () => {
    expect(applyCellEdits(rows, [])).toBe(rows);
    expect(applyCellEdits(rows, undefined)).toBe(rows);
  });

  it('ignores a correction for a row the file does not have', () => {
    expect(applyCellEdits(rows, [{ row: 9, column: 'Revenue', value: '1' }])).toEqual(rows);
  });
});

describe('planDrift', () => {
  it('is empty when the promote wrote what was staged', () => {
    expect(planDrift(resultDigest(result()), resultDigest(result()))).toEqual([]);
  });

  it('names each count that changed between staging and promoting', () => {
    const written = result({
      domains: [{ domainCode: 'ISSUER', distinctEntities: 3, created: 0, matched: 3, failed: 0, errors: [] }],
      attributes: { created: 4, updated: 1, unchanged: 5 },
    });
    expect(planDrift(resultDigest(result()), resultDigest(written))).toEqual([
      'ISSUER records created: 1 staged, 0 written',
      'ISSUER records matched: 2 staged, 3 written',
      'Values added: 5 staged, 4 written',
    ]);
  });

  it('says nothing when either side is missing', () => {
    expect(planDrift(null, resultDigest(result()))).toEqual([]);
    expect(planDrift(resultDigest(result()), null)).toEqual([]);
  });
});

describe('promoteBlockers', () => {
  it('lets a staged batch with no critical failure through', () => {
    expect(promoteBlockers('STAGED', quality(0))).toEqual([]);
  });

  it('holds a batch that brings a critical failure', () => {
    expect(promoteBlockers('STAGED', quality(2))[0]).toMatch(/2 critical checks fail/);
  });

  it('lets it through when a person gives a reason', () => {
    expect(promoteBlockers('STAGED', quality(2), 'Confirmed with the administrator')).toEqual([]);
    expect(promoteBlockers('STAGED', quality(2), '   ')).toHaveLength(1);
  });

  it('refuses a batch that is not staged, whatever the reason', () => {
    expect(promoteBlockers('PROMOTED', quality(0), 'again')[0]).toMatch(/Only a staged batch/);
  });
});

describe('dedupeRecords', () => {
  it('keeps the first mention of a record', () => {
    const kept = dedupeRecords([
      { domainCode: 'ISSUER', fileCode: 'A', name: 'Acme', action: 'MATCH', entityId: 'e1', templateId: null },
      { domainCode: 'ISSUER', fileCode: 'A', name: 'Acme Inc', action: 'CREATE', entityId: null, templateId: null },
      { domainCode: 'FUND', fileCode: 'A', name: 'Fund A', action: 'CREATE', entityId: null, templateId: null },
    ]);
    expect(kept.map((item) => `${item.domainCode}:${item.action}`)).toEqual(['ISSUER:MATCH', 'FUND:CREATE']);
  });
});

describe('batchesMissing', () => {
  it('recognises a database without the batch tables', () => {
    expect(batchesMissing({ code: '42P01', message: 'relation does not exist' })).toBe(true);
    expect(batchesMissing({ code: 'PGRST205', message: 'Could not find the table' })).toBe(true);
    expect(batchesMissing({ message: 'Could not find the function public.load_batch_quality' })).toBe(true);
  });

  it('does not mistake another failure for it', () => {
    expect(batchesMissing({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(batchesMissing(null)).toBe(false);
  });
});
