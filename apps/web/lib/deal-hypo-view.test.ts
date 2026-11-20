import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, filterHypoLines, groupHypoLines, pairHypoResults, tallyHypo, type HypoResult } from './deal-hypo-view';

function result(partial: Partial<HypoResult> & Pick<HypoResult, 'anchorEntityId' | 'ruleId' | 'status'>): HypoResult {
  return { id: `${partial.anchorEntityId}-${partial.ruleId}-${partial.groupByValue ?? ''}-${partial.status}`, limitDirection: 'MAX', ...partial };
}

describe('deal hypo view', () => {
  it('pairs before and after by fund, rule and group, and calls a pass that becomes a breach a new breach', () => {
    const before = [
      result({ anchorEntityId: 'inst', ruleId: 'sector', groupByValue: 'Consumer brands', status: 'PASS', computedValue: 18 }),
      result({ anchorEntityId: 'inst', ruleId: 'sector', groupByValue: 'Healthcare', status: 'PASS', computedValue: 13.4 }),
    ];
    const after = [
      result({ anchorEntityId: 'inst', ruleId: 'sector', groupByValue: 'Consumer brands', status: 'HARD_BREACH', computedValue: 26.1 }),
      result({ anchorEntityId: 'inst', ruleId: 'sector', groupByValue: 'Healthcare', status: 'PASS', computedValue: 13.4 }),
    ];
    const lines = pairHypoResults(before, after);
    assert.equal(lines.length, 2);
    const consumer = lines.find((line) => line.groupByValue === 'Consumer brands')!;
    assert.equal(consumer.change, 'new_breach');
    assert.ok(Math.abs((consumer.delta ?? Number.NaN) - 8.1) < 1e-6);
    assert.equal(lines.find((line) => line.groupByValue === 'Healthcare')!.changed, false);
    assert.deepEqual(tallyHypo(lines), { checks: 2, changed: 1, newBreaches: 1, breachesAfter: 1, cleared: 0 });
  });

  it('reads a rise as worse under a limit and better above a floor', () => {
    const up = (direction: string) => classify(
      result({ anchorEntityId: 'f', ruleId: 'r', status: 'PASS', computedValue: 1, limitDirection: direction }),
      result({ anchorEntityId: 'f', ruleId: 'r', status: 'PASS', computedValue: 2, limitDirection: direction }),
    ).change;
    assert.equal(up('MAX'), 'worse');
    assert.equal(up('MIN'), 'better');
  });

  it('marks a check the deal brings in, a breach it clears, and one it no longer touches', () => {
    assert.equal(classify(null, result({ anchorEntityId: 'f', ruleId: 'r', status: 'PASS', computedValue: 4 })).change, 'added');
    assert.equal(classify(
      result({ anchorEntityId: 'f', ruleId: 'r', status: 'HARD_BREACH', computedValue: 40 }),
      result({ anchorEntityId: 'f', ruleId: 'r', status: 'PASS', computedValue: 30 }),
    ).change, 'cleared');
    assert.equal(classify(result({ anchorEntityId: 'f', ruleId: 'r', status: 'PASS', computedValue: 4 }), null).change, 'dropped');
  });

  it('filters to changed lines by default, groups sleeves under their portfolio, and puts the worst change first', () => {
    const lines = pairHypoResults(
      [
        result({ anchorEntityId: 'hsi', ruleId: 'issuer', status: 'PASS', computedValue: 1 }),
        result({ anchorEntityId: 'inst', ruleId: 'issuer', status: 'PASS', computedValue: 1 }),
        result({ anchorEntityId: 'inst', ruleId: 'sector', status: 'PASS', computedValue: 10 }),
        result({ anchorEntityId: 'retail', ruleId: 'issuer', status: 'PASS', computedValue: 1 }),
      ],
      [
        result({ anchorEntityId: 'hsi', ruleId: 'issuer', status: 'PASS', computedValue: 2 }),
        result({ anchorEntityId: 'inst', ruleId: 'issuer', status: 'PASS', computedValue: 3 }),
        result({ anchorEntityId: 'inst', ruleId: 'sector', status: 'HARD_BREACH', computedValue: 30 }),
        result({ anchorEntityId: 'retail', ruleId: 'issuer', status: 'PASS', computedValue: 1 }),
      ],
    );
    const groups = groupHypoLines(filterHypoLines(lines, 'changed'), [
      { fundId: 'hsi', fundName: 'Harbor Senior Income', level: 'PORTFOLIO' },
      { fundId: 'inst', fundName: 'Harbor SI: Institutional Sleeve', parentFundId: 'hsi', level: 'SLEEVE' },
      { fundId: 'retail', fundName: 'Harbor SI: Retail Sleeve', parentFundId: 'hsi', level: 'SLEEVE' },
    ]);
    assert.deepEqual(groups.map((group) => [group.fund.fundId, group.depth]), [['hsi', 0], ['inst', 1]]);
    assert.deepEqual(groups[1].lines.map((line) => line.ruleId), ['sector', 'issuer']);
    assert.deepEqual(filterHypoLines(lines, 'breaches').map((line) => line.ruleId), ['sector']);
  });
});
