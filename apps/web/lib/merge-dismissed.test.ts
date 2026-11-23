import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openPairCount, pairKey } from './merge-dismissed';

describe('merge dismissed pairs', () => {
  it('keys a pair the same whichever side is left', () => {
    assert.equal(pairKey({ left: { id: 'b' }, right: { id: 'a' } }), pairKey({ left: { id: 'a' }, right: { id: 'b' } }));
  });

  it('counts open pairs once each and leaves out dismissed ones', () => {
    const pairs = [
      { left: { id: 'a' }, right: { id: 'b' } },
      { left: { id: 'b' }, right: { id: 'a' } },
      { left: { id: 'a' }, right: { id: 'c' } },
    ];
    assert.equal(openPairCount(pairs, new Set()), 2);
    assert.equal(openPairCount(pairs, new Set(['a:c'])), 1);
  });
});
