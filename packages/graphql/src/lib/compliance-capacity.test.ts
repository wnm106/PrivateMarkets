import { describe, expect, it } from 'vitest';
import {
  applyVerifiedCapacity,
  buildCapacityQuote,
  newBreachKeys,
  normalizeProformaLegs,
  observationFromProbes,
  searchFeasiblePar,
  solveCapacityLine,
  type SnapshotRow,
} from './compliance-capacity';

const near = (actual: number | null, expected: number) => {
  expect(actual).not.toBeNull();
  expect(actual as number).toBeCloseTo(expected, 4);
};

describe('solveCapacityLine', () => {
  it('converts a fixed-denominator issuer limit into par', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 10,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      baseNum: 8_000_000,
      baseDen: 100_000_000,
      baseValue: 8,
      baseStatus: 'PASS',
      probeNum: 9_000_000,
      probeDen: 100_000_000,
      probeValue: 9,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('worsens');
    expect(solved.shape).toBe('ratio');
    near(solved.capacityPar, 2_000_000);
    near(solved.nativeHeadroom, 2);
  });

  it('shrinks a concentration cap when the purchase also grows the denominator', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 7.5,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      baseNum: 5_000_000,
      baseDen: 100_000_000,
      baseValue: 5,
      baseStatus: 'PASS',
      probeNum: 6_000_000,
      probeDen: 101_000_000,
      probeValue: (6 / 101) * 100,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('worsens');
    near(solved.capacityPar, 2_702_702.7027);
  });

  it('leaves a max test out when the security is outside the bucket', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 7.5,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      baseNum: 5_000_000,
      baseDen: 100_000_000,
      baseValue: 5,
      baseStatus: 'PASS',
      probeNum: 5_000_000,
      probeDen: 101_000_000,
      probeValue: (5 / 101) * 100,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('improves');
    expect(solved.capacityPar).toBeNull();
  });

  it('returns zero when the security worsens a test the book already fails', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 7.5,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      baseNum: 20_000_000,
      baseDen: 100_000_000,
      baseValue: 20,
      baseStatus: 'HARD_BREACH',
      probeNum: 21_000_000,
      probeDen: 101_000_000,
      probeValue: (21 / 101) * 100,
      probeStatus: 'HARD_BREACH',
    });
    expect(solved.impact).toBe('worsens');
    expect(solved.capacityPar).toBe(0);
  });

  it('solves a minimum weighted average from the security spread and the book weight', () => {
    const solved = solveCapacityLine({
      direction: 'MIN',
      limit: 350,
      shape: 'wavg',
      securityMetric: 300,
      probePar: 1_000_000,
      baseNum: 400,
      baseDen: null,
      baseValue: 400,
      baseStatus: 'PASS',
      probeNum: (100_000_000 * 400 + 1_000_000 * 300) / 101_000_000,
      probeDen: null,
      probeValue: (100_000_000 * 400 + 1_000_000 * 300) / 101_000_000,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('worsens');
    near(solved.capacityPar, 100_000_000);
  });

  it('solves a maximum weighted average such as WARF', () => {
    const weight = 100_000_000;
    const current = 3000;
    const metric = 4000;
    const probePar = 1_000_000;
    const probed = (weight * current + probePar * metric) / (weight + probePar);
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 3200,
      shape: 'wavg',
      securityMetric: metric,
      probePar,
      baseNum: current,
      baseDen: null,
      baseValue: current,
      baseStatus: 'PASS',
      probeNum: probed,
      probeDen: null,
      probeValue: probed,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('worsens');
    near(solved.capacityPar, 25_000_000);
  });

  it('does not cap a weighted average the security cannot cross', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 3200,
      shape: 'wavg',
      securityMetric: 3100,
      probePar: 1_000_000,
      baseNum: 3000,
      baseDen: null,
      baseValue: 3000,
      baseStatus: 'PASS',
      probeNum: 3001,
      probeDen: null,
      probeValue: 3001,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('unbounded');
    expect(solved.capacityPar).toBeNull();
  });

  it('solves a minimum coverage test when the purchase adds debt', () => {
    const solved = solveCapacityLine({
      direction: 'MIN',
      limit: 1.5,
      resultUnit: 'RATIO',
      probePar: 1,
      baseNum: 200,
      baseDen: 100,
      baseValue: 2,
      baseStatus: 'PASS',
      probeNum: 200,
      probeDen: 101,
      probeValue: 200 / 101,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('worsens');
    near(solved.capacityPar, 100 / 3);
  });

  it('treats a size-independent failure as a block', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 1,
      probePar: 1_000_000,
      baseNum: 0,
      baseDen: null,
      baseValue: 0,
      baseStatus: 'PASS',
      probeNum: 0,
      probeDen: null,
      probeValue: 0,
      probeStatus: 'HARD_BREACH',
    });
    expect(solved.impact).toBe('blocks');
    expect(solved.capacityPar).toBe(0);
  });

  it('ignores a weighted average the security is filtered out of', () => {
    const solved = solveCapacityLine({
      direction: 'MIN',
      limit: 350,
      shape: 'wavg',
      securityMetric: 100,
      probePar: 1_000_000,
      baseNum: 400,
      baseDen: null,
      baseValue: 400,
      baseStatus: 'PASS',
      probeNum: 400,
      probeDen: null,
      probeValue: 400,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('neutral');
    expect(solved.capacityPar).toBeNull();
  });

  it('reports no data when a weighted average has no metric for the security', () => {
    const solved = solveCapacityLine({
      direction: 'MAX',
      limit: 3200,
      shape: 'wavg',
      securityMetric: null,
      probePar: 1_000_000,
      baseNum: 3000,
      baseDen: null,
      baseValue: 3000,
      baseStatus: 'PASS',
      probeNum: 3010,
      probeDen: null,
      probeValue: 3010,
      probeStatus: 'PASS',
    });
    expect(solved.impact).toBe('no_data');
    expect(solved.capacityPar).toBeNull();
  });
});

describe('observationFromProbes', () => {
  it('prices a new issuer bucket against a fixed denominator', () => {
    const observation = observationFromProbes({
      direction: 'MAX',
      limit: 10,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      base: null,
      probe: { num: 1_000_000, den: 100_000_000, value: 1, status: 'PASS' },
      probeAgain: { num: 2_000_000, den: 100_000_000, value: 2, status: 'PASS' },
    });
    const solved = solveCapacityLine(observation);
    expect(solved.impact).toBe('worsens');
    near(solved.capacityPar, 10_000_000);
  });

  it('blocks any purchase that would be the entire denominator of a tight cap', () => {
    const observation = observationFromProbes({
      direction: 'MAX',
      limit: 7.5,
      resultUnit: 'PERCENTAGE',
      probePar: 1_000_000,
      base: null,
      probe: { num: 1_000_000, den: 1_000_000, value: 100, status: 'HARD_BREACH' },
      probeAgain: { num: 2_000_000, den: 2_000_000, value: 100, status: 'HARD_BREACH' },
    });
    const solved = solveCapacityLine(observation);
    expect(solved.impact).toBe('worsens');
    expect(solved.capacityPar).toBe(0);
  });
});

function row(partial: Partial<SnapshotRow> & Pick<SnapshotRow, 'ruleCode'>): SnapshotRow {
  return {
    ruleName: partial.ruleCode,
    groupByValue: null,
    limitDirection: 'MAX',
    numeratorValue: null,
    denominatorValue: null,
    computedValue: null,
    softLimitValue: null,
    hardLimitValue: null,
    status: 'PASS',
    resultUnit: 'PERCENTAGE',
    ...partial,
  };
}

describe('buildCapacityQuote', () => {
  it('binds the package to the tightest rule the security worsens', () => {
    const baseline = [
      row({
        ruleCode: 'ISSUER',
        groupByValue: 'Acme',
        numeratorValue: 8_000_000,
        denominatorValue: 100_000_000,
        computedValue: 8,
        hardLimitValue: 10,
      }),
      row({
        ruleCode: 'WAS',
        limitDirection: 'MIN',
        resultUnit: 'RATIO',
        numeratorValue: 400,
        computedValue: 400,
        hardLimitValue: 350,
      }),
      row({
        ruleCode: 'CCC',
        numeratorValue: 5_000_000,
        denominatorValue: 100_000_000,
        computedValue: 5,
        hardLimitValue: 7.5,
      }),
    ];
    const at = (par: number) => [
      row({
        ruleCode: 'ISSUER',
        groupByValue: 'Acme',
        numeratorValue: 8_000_000 + par,
        denominatorValue: 100_000_000,
        computedValue: ((8_000_000 + par) / 100_000_000) * 100,
        hardLimitValue: 10,
      }),
      row({
        ruleCode: 'WAS',
        limitDirection: 'MIN',
        resultUnit: 'RATIO',
        numeratorValue: (100_000_000 * 400 + par * 500) / (100_000_000 + par),
        computedValue: (100_000_000 * 400 + par * 500) / (100_000_000 + par),
        hardLimitValue: 350,
      }),
      row({
        ruleCode: 'CCC',
        numeratorValue: 5_000_000,
        denominatorValue: 100_000_000 + par,
        computedValue: (5_000_000 / (100_000_000 + par)) * 100,
        hardLimitValue: 7.5,
      }),
    ];
    const quote = buildCapacityQuote({
      baseline,
      probe: at(1_000_000),
      probeAgain: at(2_000_000),
      probePar: 1_000_000,
      weightedMetrics: new Map([['WAS', 500]]),
    });
    near(quote.capacityPar, 2_000_000);
    expect(quote.bindingRuleCode).toBe('ISSUER');
    expect(quote.bindingGroup).toBe('Acme');
    const was = quote.lines.find((line) => line.ruleCode === 'WAS');
    expect(was?.impact).toBe('improves');
    const ccc = quote.lines.find((line) => line.ruleCode === 'CCC');
    expect(ccc?.impact).toBe('improves');
  });
});

describe('verification search', () => {
  it('walks a closed form that overshoots a later breakpoint back to the feasible size', async () => {
    const found = await searchFeasiblePar(15_000_000, async (par) => par <= 10_000_000);
    expect(found).toBeGreaterThan(9_900_000);
    expect(found).toBeLessThanOrEqual(10_000_000);
  });

  it('keeps the closed form when that size still passes', async () => {
    const found = await searchFeasiblePar(2_000_000, async () => true);
    expect(found).toBe(2_000_000);
  });

  it('adds a rule the closed form treated as unconstrained when the full size breaches it', () => {
    const quote = buildCapacityQuote({
      baseline: [row({
        ruleCode: 'ISSUER',
        groupByValue: 'Acme',
        numeratorValue: 8_000_000,
        denominatorValue: 100_000_000,
        computedValue: 8,
        hardLimitValue: 10,
      })],
      probe: [row({
        ruleCode: 'ISSUER',
        groupByValue: 'Acme',
        numeratorValue: 9_000_000,
        denominatorValue: 100_000_000,
        computedValue: 9,
        hardLimitValue: 10,
      })],
      probeAgain: [row({
        ruleCode: 'ISSUER',
        groupByValue: 'Acme',
        numeratorValue: 10_000_000,
        denominatorValue: 100_000_000,
        computedValue: 10,
        hardLimitValue: 10,
      })],
      probePar: 1_000_000,
    });
    const verified = applyVerifiedCapacity(quote, 1_000_000, ['RANK::'], [
      row({ ruleCode: 'RANK', groupByValue: null, status: 'HARD_BREACH', hardLimitValue: 5, computedValue: 6 }),
    ]);
    near(verified.capacityPar, 1_000_000);
    expect(verified.bindingRuleCode).toBe('RANK');
  });

  it('pins the rule that breaches at the closed form', () => {
    const quote = buildCapacityQuote({
      baseline: [row({
        ruleCode: 'CCC',
        numeratorValue: 5_000_000,
        denominatorValue: 100_000_000,
        computedValue: 5,
        hardLimitValue: 7.5,
      })],
      probe: [row({
        ruleCode: 'CCC',
        numeratorValue: 6_000_000,
        denominatorValue: 101_000_000,
        computedValue: (6 / 101) * 100,
        hardLimitValue: 7.5,
      })],
      probeAgain: [row({
        ruleCode: 'CCC',
        numeratorValue: 7_000_000,
        denominatorValue: 102_000_000,
        computedValue: (7 / 102) * 100,
        hardLimitValue: 7.5,
      })],
      probePar: 1_000_000,
    });
    const verified = applyVerifiedCapacity(quote, 2_000_000, ['CCC::']);
    near(verified.capacityPar, 2_000_000);
    expect(verified.bindingRuleCode).toBe('CCC');
  });

  it('names a group that fails only after the trade', () => {
    const keys = newBreachKeys(
      [row({ ruleCode: 'CCC', status: 'PASS' })],
      [row({ ruleCode: 'CCC', status: 'HARD_BREACH' }), row({ ruleCode: 'WAS', status: 'PASS' })],
    );
    expect(keys).toEqual(['CCC::']);
  });
});

describe('normalizeProformaLegs', () => {
  it('accepts a buy and a sell together', () => {
    expect(normalizeProformaLegs([
      { securityCode: 'SEC-BUY', par: 5_000_000 },
      { securityId: 'sale-id', par: -2_000_000, attributes: { CLO_EXPECTED_INTEREST: 12500 } },
    ])).toEqual([
      { security_id: null, security_code: 'SEC-BUY', par: 5_000_000, attributes: null },
      { security_id: 'sale-id', security_code: null, par: -2_000_000, attributes: { CLO_EXPECTED_INTEREST: '12500' } },
    ]);
  });

  it('rejects an empty package, a zero par, and a leg with no security', () => {
    expect(() => normalizeProformaLegs([])).toThrow(/at least one/);
    expect(() => normalizeProformaLegs([{ securityCode: 'SEC', par: 0 }])).toThrow(/non-zero par/);
    expect(() => normalizeProformaLegs([{ par: 1 }])).toThrow(/needs a security/);
  });
});
