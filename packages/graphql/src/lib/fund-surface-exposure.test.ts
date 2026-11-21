import { describe, expect, it } from 'vitest';
import { exposureStatus, resolveExposureLimit, type ExposureThreshold } from './fund-surface';

const asOf = '2026-09-30';
const fund = 'fund-1';

function row(partial: Partial<ExposureThreshold> & Pick<ExposureThreshold, 'id'>): ExposureThreshold {
  return {
    entityId: fund,
    groupValue: null,
    rankFrom: null,
    rankTo: null,
    soft: null,
    hard: null,
    applies: true,
    validFrom: '2020-01-01',
    validTo: '9999-12-31',
    ...partial,
  };
}

describe('resolveExposureLimit', () => {
  it('uses the fund row for that name ahead of the fund default', () => {
    const rows = [
      row({ id: 'fund', hard: 25, soft: 21.25 }),
      row({ id: 'name', groupValue: 'Industrials', hard: 20, soft: 18 }),
    ];
    expect(resolveExposureLimit(rows, fund, 'Industrials', 1, asOf)).toEqual({
      limitPct: 20,
      softPct: 18,
      thresholdId: 'name',
    });
    expect(resolveExposureLimit(rows, fund, 'Healthcare', 2, asOf)).toEqual({
      limitPct: 25,
      softPct: 21.25,
      thresholdId: null,
    });
  });

  it("ignores a rule-wide row: only the fund's own limits count", () => {
    const rows = [row({ id: 'rule', entityId: null, hard: 35, soft: 22 })];
    expect(resolveExposureLimit(rows, fund, 'Healthcare', 1, asOf)).toEqual({
      limitPct: null,
      softPct: null,
      thresholdId: null,
    });
  });

  it("ignores another fund's row", () => {
    const rows = [row({ id: 'other', entityId: 'fund-2', hard: 10 })];
    expect(resolveExposureLimit(rows, fund, 'Healthcare', 1, asOf).limitPct).toBeNull();
  });

  it('has no limit when the fund row has no numbers', () => {
    const rows = [row({ id: 'blank', soft: null, hard: null })];
    expect(resolveExposureLimit(rows, fund, 'Healthcare', 1, asOf)).toEqual({
      limitPct: null,
      softPct: null,
      thresholdId: null,
    });
  });

  it('uses the rank band that contains the group', () => {
    const rows = [
      row({ id: 'top', rankFrom: 1, rankTo: 1, hard: 8, soft: 6 }),
      row({ id: 'rest', rankFrom: 2, rankTo: null, hard: 3, soft: 2.4 }),
    ];
    expect(resolveExposureLimit(rows, fund, 'Largest', 1, asOf).limitPct).toBe(8);
    expect(resolveExposureLimit(rows, fund, 'Smaller', 3, asOf).limitPct).toBe(3);
  });

  it('shows no limit when the fund has declined the rule', () => {
    const rows = [row({ id: 'out', applies: false, hard: 35 })];
    expect(resolveExposureLimit(rows, fund, 'Healthcare', 1, asOf)).toEqual({
      limitPct: null,
      softPct: null,
      thresholdId: null,
    });
  });
});

describe('exposureStatus', () => {
  it('marks a share at the hard limit as over and a share at the warning as near', () => {
    expect(exposureStatus(20, 20, 18)).toBe('OVER');
    expect(exposureStatus(18, 20, 18)).toBe('NEAR');
    expect(exposureStatus(10, 20, 18)).toBe('OK');
    expect(exposureStatus(17, 20, null)).toBe('NEAR');
    expect(exposureStatus(12, null, null)).toBe('OK');
  });
});
