import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { timelineChanges } from './entity-timeline';

describe('timelineChanges', () => {
  it('pairs each changed field with the value on the version below it', () => {
    const changes = timelineChanges({
      truncated: false,
      attributes: [{ attributeCode: 'a', attributeName: 'Alpha' }, { attributeCode: 'b', attributeName: 'Beta' }],
      versions: [
        { effectiveFrom: '2026-03-01', effectiveTo: null, changed: ['a'], values: [{ attributeCode: 'a', value: '2', sourceName: null }, { attributeCode: 'b', value: 'x', sourceName: null }] },
        { effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28', changed: ['a', 'b'], values: [{ attributeCode: 'a', value: '1', sourceName: null }, { attributeCode: 'b', value: 'x', sourceName: null }] },
      ],
    });
    assert.deepEqual(changes[0].changes, [{ attributeCode: 'a', attributeName: 'Alpha', from: '1', to: '2' }]);
    assert.deepEqual(changes[1].changes.map((change) => change.from), [null, null]);
  });
});
