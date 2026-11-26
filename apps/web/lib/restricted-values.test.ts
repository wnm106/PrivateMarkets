import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHiddenAttribute } from './restricted-values';

test('a hidden attribute is hidden by its own code and as a related column', () => {
  const hidden = new Set(['NAV']);
  assert.equal(isHiddenAttribute(hidden, 'NAV'), true);
  assert.equal(isHiddenAttribute(hidden, 'fund.NAV'), true);
  assert.equal(isHiddenAttribute(hidden, 'NAV_DATE'), false);
  assert.equal(isHiddenAttribute(new Set(), 'NAV'), false);
  assert.equal(isHiddenAttribute(hidden, null), false);
});
