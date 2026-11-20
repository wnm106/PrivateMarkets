import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editorFieldValue, editorInputType, formatAttributeDisplay } from './attribute-display';

describe('attribute editor value', () => {
  it('shows a currency mask only while the field is resting', () => {
    const meta = { dataType: 'CURRENCY' };
    assert.equal(editorFieldValue('12345678.5', meta, false), '$12,345,678.50');
    assert.equal(editorFieldValue('12345678.5', meta, true), '12345678.5');
  });

  it('writes the unit the analytics profile stores', () => {
    assert.equal(formatAttributeDisplay('4.25', { dataType: 'PERCENTAGE', displayFormat: 'percentage', numericPrecision: 4 }), '4.25%');
    assert.equal(formatAttributeDisplay('142.5', { dataType: 'DECIMAL', displayFormat: 'bps', numericPrecision: 2 }), '142.50 bps');
    assert.equal(formatAttributeDisplay('7.2531', { dataType: 'NUMBER', displayFormat: 'years', numericPrecision: 4 }), '7.2531 yrs');
    assert.equal(formatAttributeDisplay('36.5', { dataType: 'NUMBER', displayFormat: 'months', numericPrecision: 1 }), '36.5 mo');
    assert.equal(formatAttributeDisplay('18.4', { dataType: 'NUMBER', displayFormat: 'multiple', numericPrecision: 1 }), '18.4x');
    assert.equal(formatAttributeDisplay('0.075234', { dataType: 'DECIMAL', displayFormat: 'price', numericPrecision: 6 }), '0.075234');
    assert.equal(formatAttributeDisplay('-23.4', { dataType: 'PERCENTAGE', numericPrecision: 1 }), '-23.4%');
  });

  it('keeps a number as text so the mask is not cleared', () => {
    assert.equal(editorInputType('currency'), 'text');
    assert.equal(editorInputType('percentage'), 'text');
    assert.equal(editorInputType('number'), 'text');
    assert.equal(editorInputType('date'), 'date');
  });
});
