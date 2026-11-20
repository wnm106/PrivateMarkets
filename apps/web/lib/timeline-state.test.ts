import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { timelineState } from './timeline-state';

describe('timelineState', () => {
  const asOf = '2026-11-19';

  it('marks a version that starts after As Of as not yet effective', () => {
    assert.equal(timelineState({ validFrom: '2026-11-26', validTo: '9999-12-31' }, asOf), 'upcoming');
  });

  it('marks the version covering As Of as effective, ends inclusive', () => {
    assert.equal(timelineState({ validFrom: '2026-11-07', validTo: '2026-11-19' }, asOf), 'effective');
  });

  it('marks a version that ended before As Of as past', () => {
    assert.equal(timelineState({ validFrom: '2020-01-01', validTo: '2026-11-06' }, asOf), 'past');
  });

  it('marks a version a later write replaced, whatever its dates', () => {
    assert.equal(timelineState({ validFrom: '2026-11-26', validTo: '9999-12-31', current: false }, asOf), 'replaced');
  });
});
