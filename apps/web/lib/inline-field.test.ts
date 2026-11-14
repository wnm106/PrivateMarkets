import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellEditSeed, inlineCommitValue, inlineDraft } from './inline-field';

describe('inline field edit', () => {
  it('starts a blank row with an empty draft', () => {
    assert.equal(inlineDraft('—'), '');
    assert.equal(inlineDraft(''), '');
    assert.equal(inlineDraft('Corporate'), 'Corporate');
  });

  it('seeds a register cell from its stored value', () => {
    assert.equal(cellEditSeed(null), '');
    assert.equal(cellEditSeed('—'), '');
    assert.equal(cellEditSeed('ENERGY'), 'ENERGY');
    assert.equal(cellEditSeed(new Date(2026, 10, 7)), '2026-11-07');
  });

  it('skips a blank or unchanged edit and strips numeric grouping', () => {
    assert.equal(inlineCommitValue('   ', '—', false), null);
    assert.equal(inlineCommitValue('Corporate', 'Corporate', false), null);
    assert.equal(inlineCommitValue('1,250', '1250', true), null);
    assert.equal(inlineCommitValue('1,250.5', '—', true), '1250.5');
    assert.equal(inlineCommitValue(' Apex ', '—', false), 'Apex');
  });
});
