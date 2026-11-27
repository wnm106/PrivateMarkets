import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSignInCache, rememberDecision, sessionKey, wasRecentlyAllowed } from './sign-in-cache';

const allowed = { allowed: true, mfa_required: false, mfa_satisfied: false, matched: true } as any;

test('an allowed session is remembered for the window, then asked again', () => {
  clearSignInCache();
  rememberDecision('k', allowed, 1_000);
  assert.equal(wasRecentlyAllowed('k', 1_000 + 29_999), true);
  assert.equal(wasRecentlyAllowed('k', 1_000 + 30_000), false);
  assert.equal(wasRecentlyAllowed('k', 1_000 + 1), false, 'an expired entry is gone');
});

test('refused, owes a second factor, and unchecked are never remembered', () => {
  clearSignInCache();
  rememberDecision('r', { allowed: false, reason: 'no' } as any, 0);
  rememberDecision('m', { allowed: true, mfa_required: true, mfa_satisfied: false } as any, 0);
  rememberDecision('u', null, 0);
  assert.equal(wasRecentlyAllowed('r', 1), false);
  assert.equal(wasRecentlyAllowed('m', 1), false);
  assert.equal(wasRecentlyAllowed('u', 1), false);
});

test('a later refusal for the same session drops the remembered allow', () => {
  clearSignInCache();
  rememberDecision('k', allowed, 0);
  rememberDecision('k', { allowed: false } as any, 10);
  assert.equal(wasRecentlyAllowed('k', 11), false);
});

test('a different token is a different session', async () => {
  clearSignInCache();
  const a = await sessionKey('token-a');
  const b = await sessionKey('token-b');
  assert.notEqual(a, b);
  rememberDecision(a, allowed, 0);
  assert.equal(wasRecentlyAllowed(b, 1), false);
  assert.equal(a.length, 64);
});
