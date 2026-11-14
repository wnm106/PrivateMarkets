import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fundUsesRule } from './fund-enrollment';

const fund = 'fund-1';
const rule = 'rule-1';

describe('fund enrollment', () => {
  it('scores a fund only when its own threshold applies', () => {
    assert.equal(fundUsesRule([], rule, fund), false);
    assert.equal(fundUsesRule([
      { ruleId: rule, entityId: null, applies: true },
    ], rule, fund), false);
    assert.equal(fundUsesRule([
      { ruleId: rule, entityId: fund, applies: false },
    ], rule, fund), false);
    assert.equal(fundUsesRule([
      { ruleId: rule, entityId: fund, groupValue: 'Industrials', applies: true },
    ], rule, fund), false);
    assert.equal(fundUsesRule([
      { ruleId: rule, entityId: fund, applies: true },
    ], rule, fund), true);
  });
});
