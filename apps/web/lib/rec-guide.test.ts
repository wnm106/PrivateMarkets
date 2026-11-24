import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TIE } from '@tapestrai/graphql/src/lib/fund-rec';
import { REC_GUIDE, guideText, type RecGuideKey } from './rec-guide';

const TABS: RecGuideKey[] = ['close', 'breaks', 'pack', 'stmt', 'roll', 'cash', 'integrity', 'fees', 'val', 'drift', 'inputs'];

describe('how each step of the NAV review works', () => {
  it('explains every tab, with a summary and at least three points', () => {
    assert.deepEqual(Object.keys(REC_GUIDE).sort(), [...TABS].sort());
    for (const key of TABS) {
      assert.ok(REC_GUIDE[key].summary.length > 30, key);
      assert.ok(REC_GUIDE[key].points.length >= 3, key);
      for (const [term, text] of REC_GUIDE[key].points) assert.ok(term && text.length > 20, `${key}: ${term}`);
    }
  });

  it('says whether a step holds certification where a reader would ask', () => {
    for (const key of ['roll', 'cash', 'fees', 'val', 'drift', 'stmt'] as RecGuideKey[]) {
      assert.ok(REC_GUIDE[key].points.some(([term]) => term === 'What it holds'), key);
    }
    assert.match(guideText('cash'), /does not block certification/);
    assert.match(guideText('roll'), /blocks this step and certification/);
  });

  it('quotes the tolerance the reconciliation uses, not a figure typed again', () => {
    assert.ok(guideText('roll').includes(`$${TIE.toLocaleString('en-US')}`));
  });
});
