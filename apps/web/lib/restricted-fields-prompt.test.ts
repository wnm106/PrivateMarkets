import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictedFieldsBlock } from './restricted-fields-prompt';

test('nothing is added when nothing is restricted', () => {
  assert.equal(restrictedFieldsBlock([]), '');
});

test('the restricted fields are named, with what to say about them', () => {
  const block = restrictedFieldsBlock(['NAV', 'FUND_FEES']);
  assert.match(block, /not cleared to see these fields: NAV, FUND_FEES/);
  assert.match(block, /never estimate or work out its value/);
});
