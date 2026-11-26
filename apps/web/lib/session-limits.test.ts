import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitMinutes } from './session-limits';

test('a blank limit is no limit', () => {
  assert.equal(limitMinutes('  ', 60), null);
});

test('hours and minutes become minutes', () => {
  assert.equal(limitMinutes('8', 60), 480);
  assert.equal(limitMinutes('1.5', 60), 90);
  assert.equal(limitMinutes('30', 1), 30);
});

test('anything else is not a number', () => {
  assert.ok(Number.isNaN(limitMinutes('eight', 60)));
});
