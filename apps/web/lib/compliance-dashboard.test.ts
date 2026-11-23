import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The few matchers these tests use, on node:assert.
function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toBeUndefined: () => assert.equal(actual, undefined),
    toMatchObject: (expected: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(expected)) assert.deepEqual((actual as Record<string, unknown>)[key], value, key);
    },
  };
}
import { cushionOf, dashboardRows, dashboardTabData, formatCushion, summarize, watchlist, type ComplianceDashboardData } from './compliance-dashboard';

const data: ComplianceDashboardData = {
  asOfDate: '2026-09-30',
  knowledgeDate: '2026-11-23',
  domains: [
    { domainCode: 'A', domainName: 'Type A', ruleCount: 3, entityCount: 2, resultCount: 3, passCount: 2, softBreachCount: 0, hardBreachCount: 1, noDataCount: 0 },
  ],
  rules: [
    { id: 'r1', ruleCode: 'R1', ruleName: 'Single name', ruleCategory: 'CONCENTRATION', anchorDomainCode: 'A', resultUnit: 'PERCENTAGE', limitDirection: 'MAX' },
    { id: 'r2', ruleCode: 'R2', ruleName: 'Coverage floor', ruleCategory: 'COVERAGE', anchorDomainCode: 'A', resultUnit: 'RATIO', limitDirection: 'MIN' },
    { id: 'r3', ruleCode: 'R3', ruleName: 'Unscored', ruleCategory: 'OTHER', anchorDomainCode: 'A', resultUnit: 'COUNT', limitDirection: 'MAX', hardLimitValue: 10 },
    { id: 'r4', ruleCode: 'R4', ruleName: 'Other type', ruleCategory: 'OTHER', anchorDomainCode: 'B' },
  ],
  thresholds: [
    { id: 't1', ruleId: 'r1', entityId: 'e1', applies: true, hardLimitValue: 5 },
    { id: 't2', ruleId: 'r3', entityId: 'e1', applies: true, softLimitValue: 8, hardLimitValue: 9 },
  ],
  results: [
    { id: 'x1', ruleId: 'r1', anchorEntityId: 'e1', anchorEntityName: 'Fund One', computedValue: 4.5, limitDirection: 'MAX', hardLimitValue: 5, status: 'PASS' },
    { id: 'x2', ruleId: 'r1', anchorEntityId: 'e2', anchorEntityName: 'Fund Two', computedValue: 6, limitDirection: 'MAX', hardLimitValue: 5, status: 'HARD_BREACH' },
    { id: 'x3', ruleId: 'r2', anchorEntityId: 'e1', anchorEntityName: 'Fund One', computedValue: 2, limitDirection: 'MIN', hardLimitValue: 1.5, status: 'PASS' },
  ],
};

describe('cushionOf', () => {
  it('measures room under a maximum and over a minimum', () => {
    expect(cushionOf(4.5, 'MAX', null, 5)).toMatchObject({ cushion: 0.5, cushionPct: 10, usedPct: 90 });
    expect(cushionOf(2, 'MIN', null, 1.5)).toMatchObject({ cushion: 0.5 });
    expect(cushionOf(6, 'MAX', null, 5).cushion).toBe(-1);
  });

  it('falls back to the soft limit and has no cushion without a limit', () => {
    expect(cushionOf(3, 'MAX', 4, null).cushion).toBe(1);
    expect(cushionOf(3, 'MAX', null, null).cushion).toBeNull();
  });
});

describe('dashboardRows', () => {
  const rows = dashboardRows(data, 'A');

  it('keeps the type, puts breaches first, and lists unscored rules', () => {
    expect(rows.map((row) => row.key)).toEqual(['x2', 'x1', 'x3', 'r3|none']);
    expect(rows.find((row) => row.ruleId === 'r4')).toBeUndefined();
  });

  it('takes an unscored rule its fund threshold', () => {
    const unscored = rows.find((row) => row.status === 'NOT_SCORED');
    expect(unscored).toMatchObject({ soft: 8, hard: 9, thresholdCount: 1 });
  });

  it('summarizes and lists the watchlist', () => {
    const summary = summarize(rows);
    expect(summary).toMatchObject({ rules: 3, rulesScored: 2, entities: 2, tests: 3, hard: 1, pass: 2, notScored: 1 });
    expect(summary.tightest?.key).toBe('x1');
    expect(watchlist(rows).map((row) => row.key)).toEqual(['x2', 'x1', 'x3']);
  });
});

describe('dashboardTabData', () => {
  it('publishes the selected type with its totals and rows', () => {
    const tab = dashboardTabData(data, 'A');
    expect(tab.selectedEntityType).toBe('Type A');
    expect(tab.totals?.hardBreaches).toBe(1);
    expect(tab.rows[0]).toMatchObject({ status: 'Above maximum', rule: 'Single name', cushion: -1 });
  });
});

describe('formatCushion', () => {
  it('writes percentage cushions in points', () => {
    expect(formatCushion(0.5, 'PERCENTAGE')).toBe('+0.5 pp');
    expect(formatCushion(-1, 'PERCENTAGE')).toBe('−1 pp');
  });
});
