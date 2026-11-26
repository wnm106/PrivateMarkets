import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoredClientError, readClientError } from './client-errors';

test('a report is bounded and keeps the path only', () => {
  const report = readClientError({ message: 'x'.repeat(5000), stack: 'at f', page: '/funds/abc?q=secret', kind: 'nonsense' });
  assert.equal(report?.message.length, 1000);
  assert.equal(report?.page, '/funds/abc');
  assert.equal(report?.kind, 'error');
});

test('nothing to report without a message', () => {
  assert.equal(readClientError({ stack: 'at f' }), null);
  assert.equal(readClientError('boom'), null);
});

test('browser noise is ignored', () => {
  assert.equal(ignoredClientError({ message: 'ResizeObserver loop completed with undelivered notifications.', stack: null }), true);
  assert.equal(ignoredClientError({ message: 'TypeError: x is undefined', stack: 'at chrome-extension://abc/content.js' }), true);
  assert.equal(ignoredClientError({ message: 'TypeError: x is undefined', stack: 'at FundSurface' }), false);
});
