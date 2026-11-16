import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedStatusLabel, fileSize, isLate } from './feeds-admin';

describe('fileSize', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    assert.equal(fileSize(512), '512 B');
    assert.equal(fileSize(2048), '2.0 KB');
    assert.equal(fileSize(250 * 1024), '250 KB');
    assert.equal(fileSize(3.5 * 1024 * 1024), '3.5 MB');
    assert.equal(fileSize(null), '');
  });
});

describe('feedStatusLabel', () => {
  it('reads statuses in words', () => {
    assert.equal(feedStatusLabel('NEEDS_REVIEW'), 'Needs review');
    assert.equal(feedStatusLabel(null), '');
  });
});

describe('isLate', () => {
  const feed = { isActive: true, expectedCron: '0 9 * * 1-5', expectedTimezone: 'UTC', graceMinutes: 60, lastReceivedAt: '2026-11-13T09:10:00Z' };

  it('is late once the next expected time plus the grace period has passed', () => {
    assert.equal(isLate(feed, new Date('2026-11-16T09:59:00Z')), false);
    assert.equal(isLate(feed, new Date('2026-11-16T10:01:00Z')), true);
  });

  it('is never late when paused, without a deadline, or before a first file', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    assert.equal(isLate({ ...feed, isActive: false }, now), false);
    assert.equal(isLate({ ...feed, expectedCron: null }, now), false);
    assert.equal(isLate({ ...feed, lastReceivedAt: null }, now), false);
    assert.equal(isLate({ ...feed, expectedCron: 'nonsense' }, now), false);
  });
});
