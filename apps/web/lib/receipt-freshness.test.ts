import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCalculationSource, isStaleReceipt } from './receipt-freshness';

describe('calculation source', () => {
  it('is the source a calculation writes under, in any case', () => {
    assert.equal(isCalculationSource('derived'), true);
    assert.equal(isCalculationSource('CALCULATED'), true);
    assert.equal(isCalculationSource('bloomberg'), false);
    assert.equal(isCalculationSource(null), false);
  });

  it('is never stale', () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    assert.equal(isStaleReceipt(old, 'derived'), false);
    assert.equal(isStaleReceipt(old, 'bloomberg'), true);
  });
});
