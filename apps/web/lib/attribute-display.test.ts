import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editorFieldValue, editorInputType } from './attribute-display';

describe('attribute editor value', () => {
  it('shows a currency mask only while the field is resting', () => {
    const meta = { dataType: 'CURRENCY' };
    assert.equal(editorFieldValue('12345678.5', meta, false), '$12,345,678.50');
    assert.equal(editorFieldValue('12345678.5', meta, true), '12345678.5');
  });

  it('keeps a number as text so the mask is not cleared', () => {
    assert.equal(editorInputType('currency'), 'text');
    assert.equal(editorInputType('percentage'), 'text');
    assert.equal(editorInputType('number'), 'text');
    assert.equal(editorInputType('date'), 'date');
  });
});
