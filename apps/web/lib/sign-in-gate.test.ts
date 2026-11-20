import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSignInDecision, signInStanding, uncheckedSignInAction } from './sign-in-gate';
import { isPublicPath } from './public-paths';

describe('signInStanding', () => {
  it('passes a session the rules allow', () => {
    assert.equal(signInStanding({ allowed: true, mfa_required: false, mfa_satisfied: true }), 'allowed');
    assert.equal(signInStanding({ allowed: true, mfa_required: true, mfa_satisfied: true }), 'allowed');
  });

  it('refuses a session the rules refuse', () => {
    assert.equal(signInStanding({ allowed: false, reason: 'Use Microsoft sign-in.' }), 'refused');
  });

  it('never treats a check that did not run as allowed', () => {
    // The function errored, or the request failed.
    assert.equal(signInStanding(null), 'unchecked');
    // An answer with no verdict in it.
    assert.equal(signInStanding({}), 'unchecked');
    assert.equal(signInStanding({ mfa_required: false, mfa_satisfied: true }), 'unchecked');
    assert.equal(signInStanding({ allowed: 'true' as unknown as boolean }), 'unchecked');
  });

  it('holds a session that owes a second factor, unless the decision says it was given', () => {
    assert.equal(signInStanding({ allowed: true, mfa_required: true, mfa_satisfied: false }), 'needs_mfa');
    assert.equal(signInStanding({ allowed: true, mfa_required: true }), 'needs_mfa');
  });
});

describe('readSignInDecision', () => {
  it('keeps an object and drops anything else', () => {
    assert.deepEqual(readSignInDecision({ allowed: true }), { allowed: true });
    assert.equal(readSignInDecision(null), null);
    assert.equal(readSignInDecision(undefined), null);
    assert.equal(readSignInDecision('allowed'), null);
    assert.equal(readSignInDecision([{ allowed: true }]), null);
  });
});

describe('uncheckedSignInAction', () => {
  // The same reading of a path the middleware makes.
  const where = (pathname: string) => ({
    isPublic: isPublicPath(pathname),
    isAsset: !pathname.startsWith('/api/') && (pathname.startsWith('/_next/') || pathname.startsWith('/favicon') || /\.(jpg|jpeg|png|svg|ico|webp|gif)$/i.test(pathname)),
  });
  const action = (pathname: string) => uncheckedSignInAction(pathname, where(pathname));

  it('sends a page of the app back to the sign-in page', () => {
    for (const path of ['/', '/funds/abc', '/admin/tenancy', '/s/fund-rec', '/login/mfa', '/imports']) {
      assert.equal(action(path), 'sign_in_again', path);
    }
  });

  it('refuses every API route with 403, data and model calls among them', () => {
    for (const path of ['/api/graphql', '/api/chat', '/api/chat/attachments/1', '/api/feeds/position-file', '/api/documents', '/api', '/api/logo.png']) {
      assert.equal(action(path), 'forbid', path);
    }
  });

  it('leaves public pages, static files and the sign-in API alone', () => {
    for (const path of ['/login', '/welcome', '/no-access', '/auth/callback', '/portal/abc', '/_next/static/chunk.js', '/favicon.ico', '/logo.svg', '/api/auth/discover']) {
      assert.equal(action(path), 'serve', path);
    }
  });
});
