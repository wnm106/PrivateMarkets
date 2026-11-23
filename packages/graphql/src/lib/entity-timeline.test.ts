import { describe, expect, it } from 'vitest';
import { buildTimelineVersions, candidateChangeDays } from './entity-timeline';

const cell = (value: string | null) => ({ value, sourceId: 's' });

describe('candidateChangeDays', () => {
  it('takes each start and the day after each end, sorted and unique', () => {
    expect(candidateChangeDays([
      { validFrom: '2026-03-01', validTo: '9999-12-31' },
      { validFrom: '2026-01-01', validTo: '2026-02-28' },
      { validFrom: '2026-03-01', validTo: null },
    ])).toEqual(['2026-01-01', '2026-03-01']);
  });

  it('crosses month and year ends', () => {
    expect(candidateChangeDays([{ validFrom: '2025-06-01', validTo: '2025-12-31' }])).toEqual(['2025-06-01', '2026-01-01']);
  });
});

describe('buildTimelineVersions', () => {
  it('starts a version only when a value changes, and flags the fields that did', () => {
    const versions = buildTimelineVersions([
      { day: '2026-01-01', values: { a: cell('1'), b: cell('x') } },
      { day: '2026-02-01', values: { a: cell('1'), b: cell('x') } },
      { day: '2026-03-01', values: { a: cell('2'), b: cell('x') } },
      { day: '2026-04-01', values: { a: cell('2') } },
    ], ['a', 'b']);
    expect(versions.map((version) => [version.effectiveFrom, version.effectiveTo, version.changed])).toEqual([
      ['2026-01-01', '2026-02-28', ['a', 'b']],
      ['2026-03-01', '2026-03-31', ['a']],
      ['2026-04-01', null, ['b']],
    ]);
  });

  it('treats a blank and a missing value as the same', () => {
    const versions = buildTimelineVersions([
      { day: '2026-01-01', values: { a: cell('1'), b: cell('') } },
      { day: '2026-02-01', values: { a: cell('1') } },
    ], ['a', 'b']);
    expect(versions).toHaveLength(1);
    expect(versions[0].changed).toEqual(['a']);
  });

  it('skips days before the record has any value', () => {
    const versions = buildTimelineVersions([
      { day: '2026-01-01', values: {} },
      { day: '2026-02-01', values: { a: cell('1') } },
    ], ['a']);
    expect(versions.map((version) => version.effectiveFrom)).toEqual(['2026-02-01']);
  });
});
