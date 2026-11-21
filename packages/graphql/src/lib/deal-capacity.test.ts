import { describe, expect, it } from 'vitest';
import { solveDealObservations, walkRankedCapacity, type DealObservationRow } from './compliance-capacity';

const M = 1_000_000;

function row(partial: Partial<DealObservationRow>): DealObservationRow {
  return {
    fund_id: 'fund',
    rule_code: 'RULE',
    rule_name: 'Rule',
    group_value: null,
    group_label: null,
    limit_direction: 'MAX',
    result_unit: 'PERCENTAGE',
    base_numerator: null,
    base_denominator: null,
    base_value: null,
    base_status: null,
    base_soft_limit: null,
    base_hard_limit: null,
    probe_numerator: null,
    probe_denominator: null,
    probe_value: null,
    probe_status: null,
    probe_soft_limit: null,
    probe_hard_limit: null,
    probe_rank: null,
    contributions: null,
    rank_sensitive: false,
    error_message: null,
    ...partial,
  };
}

const leg = (numerator: number | null, denominator = 0) => ({ par: 1, numerator, denominator });

describe('solveDealObservations', () => {
  it('solves a share of NAV for a group the deal creates, with both securities sharing it', () => {
    const { lines } = solveDealObservations([row({
      rule_code: 'ISSUER', group_value: 'Brightwater Health',
      probe_numerator: 2, probe_denominator: 700 * M, probe_hard_limit: 5,
      contributions: { tl: leg(1), rcf: leg(1) },
    })]);
    expect(lines.map((line) => [line.securityId, line.capacity])).toEqual([['tl', 35 * M], ['rcf', 35 * M]]);
    expect(lines[0].baseNumerator).toBe(0);
    expect(lines[0].baseDenominator).toBe(700 * M);
  });

  it('leaves out a security the rule does not sum (a term loan on an unfunded limit)', () => {
    const { lines } = solveDealObservations([row({
      rule_code: 'UNFUNDED', base_numerator: 20.71 * M, base_denominator: 700 * M, base_status: 'PASS',
      probe_numerator: 20.71 * M + 1, probe_denominator: 700 * M, probe_hard_limit: 10,
      contributions: { tl: leg(0), rcf: leg(1) },
    })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].securityId).toBe('rcf');
    expect(lines[0].capacity).toBeCloseTo(70 * M - 20.71 * M, 0);
  });

  it('counts the buy in a book-share denominator: (L * D - N) / (1 - L)', () => {
    const D = 131.568 * M;
    const { lines } = solveDealObservations([row({
      rule_code: 'SECTOR', group_value: 'Healthcare services',
      probe_numerator: 1, probe_denominator: D + 1, probe_hard_limit: 25,
      contributions: { tl: leg(1, 1) },
    })]);
    expect(lines[0].capacity).toBeCloseTo((0.25 * D) / 0.75, 0);
    expect(lines[0].denominatorSlope).toBe(1);
  });

  it('has no room on an empty book for a book-share limit below 100%', () => {
    const { lines } = solveDealObservations([row({
      rule_code: 'SECTOR', group_value: 'Healthcare services',
      probe_numerator: 1, probe_denominator: 1, probe_hard_limit: 35,
      contributions: { tl: leg(1, 1) },
    })]);
    expect(lines[0].capacity).toBe(0);
  });

  it('blocks an instrument the fund may not hold (a 0 limit on an amount)', () => {
    const { lines } = solveDealObservations([row({
      rule_code: 'INSTRUMENT', group_value: 'REVOLVING_CREDIT', result_unit: 'CURRENCY',
      probe_numerator: 1, probe_hard_limit: 0,
      contributions: { rcf: leg(1) },
    })]);
    expect(lines[0].capacity).toBe(0);
  });

  it('drops a group with no limit and reports an evaluator error instead of guessing', () => {
    const solved = solveDealObservations([
      row({ rule_code: 'INSTRUMENT', group_value: 'LOAN', result_unit: 'CURRENCY', base_numerator: 63 * M, probe_numerator: 63 * M + 1, contributions: { tl: leg(1) } }),
      row({ rule_code: 'BROKEN', error_message: 'division by zero' }),
    ]);
    expect(solved.lines).toEqual([]);
    expect(solved.errors).toEqual(['BROKEN: division by zero']);
  });

  it('solves a floor (MIN) the buy dilutes', () => {
    const { lines } = solveDealObservations([row({
      rule_code: 'NAME_80', limit_direction: 'MIN', base_numerator: 90 * M, base_denominator: 100 * M, base_value: 90, base_status: 'PASS',
      probe_numerator: 90 * M, probe_denominator: 100 * M + 1, probe_hard_limit: 80,
      contributions: { tl: leg(0, 1) },
    })]);
    // 90 / (100 + x) = 0.80 at x = 12.5
    expect(lines[0].capacity).toBeCloseTo(12.5 * M, 0);
  });
});

describe('walkRankedCapacity', () => {
  // A replica of a fund with rank-banded issuer limits: largest issuer 8%,
  // ranks 2-4 3%, rank 5 and after 1.5%, on a 1,250 NAV.
  const NAV = 1250 * M;
  const band = (rank: number) => (rank === 1 ? 8 : rank <= 4 ? 3 : 1.5);
  function bookAt(others: Record<string, number>) {
    return async (par: number): Promise<DealObservationRow[]> => {
      const groups = [...Object.entries(others), ['New issuer', par] as [string, number]]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
      return groups.map(([name, amount], index) => {
        const pct = (amount / NAV) * 100;
        const hard = band(index + 1);
        const isNew = name === 'New issuer';
        const baseRank = Object.entries(others).sort((l, r) => r[1] - l[1]).findIndex(([n]) => n === name) + 1;
        const basePct = isNew ? null : (others[name] / NAV) * 100;
        return row({
          rule_code: 'ISSUER', group_value: name, rank_sensitive: true,
          base_numerator: isNew ? null : others[name], base_denominator: isNew ? null : NAV,
          base_value: basePct, base_status: basePct == null ? null : basePct > band(baseRank) ? 'HARD_BREACH' : 'PASS',
          probe_numerator: amount, probe_denominator: NAV, probe_value: pct,
          probe_status: pct > hard ? 'HARD_BREACH' : 'PASS', probe_hard_limit: hard, probe_rank: index + 1,
          contributions: isNew ? { sec: { par, numerator: par, denominator: 0 } } : null,
        });
      });
    };
  }

  async function capacityFor(others: Record<string, number>) {
    const observe = bookAt(others);
    const first = (await observe(1)).find((item) => item.group_value === 'New issuer')!;
    const { lines } = solveDealObservations([first]);
    return walkRankedCapacity(lines[0], observe);
  }

  it('takes the largest-issuer band on an empty book', async () => {
    expect(await capacityFor({})).toBeCloseTo(100 * M, -2);
  });

  it('stops before the gap where passing an issuer still leaves the buy in a tighter band', async () => {
    // At 18.75 the buy is rank 5 at exactly 1.5%. Just above it breaches until
    // it passes the 18.777 issuer and moves to the 3% band, so the room counted
    // up from zero is 18.75, not the 37.5 the 3% band would allow.
    const room = await capacityFor({ Cormorant: 51.043 * M, Halyard: 32.647 * M, Quillon: 29.101 * M, Northwind: 18.777 * M });
    expect(room).toBeCloseTo(18.75 * M, -2);
  });

  it('crosses into a looser band when nothing breaks on the way', async () => {
    // One small issuer: the buy passes it at 1 and the ranks-2-4 band does not apply.
    const room = await capacityFor({ Small: 1 * M });
    expect(room).toBeCloseTo(100 * M, -2);
  });
});
