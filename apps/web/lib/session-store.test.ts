import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionCookieName, sessionCookieNames, sessionStoreCookie, sessionStoreFrom } from './session-store';
import { accessTokenFromCookieHeader } from './auth-token';

describe('session stores', () => {
  it('keeps the app on the default cookie and Excel on its own', () => {
    assert.equal(sessionCookieName('app', 'abc'), null);
    assert.equal(sessionCookieName('excel', 'abc'), 'sb-abc-excel-auth-token');
  });

  it('reads only the stores it knows', () => {
    assert.equal(sessionStoreFrom('excel'), 'excel');
    assert.equal(sessionStoreFrom('admin'), 'app');
    assert.equal(sessionStoreFrom(undefined), 'app');
  });

  it('clears the store cookie when an app sign-in starts', () => {
    assert.match(sessionStoreCookie('app'), /Max-Age=0/);
    assert.match(sessionStoreCookie('excel'), /^tapestr-session-store=excel;/);
  });

  it('finds every cookie of one store and none of the other', () => {
    const header = 'sb-abc-auth-token=app; sb-abc-excel-auth-token.0=x; sb-abc-excel-auth-token.1=y; sb-abc-excel-auth-token-code-verifier=v; other=1';
    assert.deepEqual(sessionCookieNames(header, 'sb-abc-excel-auth-token'), [
      'sb-abc-excel-auth-token.0',
      'sb-abc-excel-auth-token.1',
      'sb-abc-excel-auth-token-code-verifier',
    ]);
  });

  it('never reads the Excel session as the app session', () => {
    const session = Buffer.from(JSON.stringify({ access_token: 'excel-token' })).toString('base64url');
    const header = `sb-abc-excel-auth-token=base64-${session}`;
    assert.equal(accessTokenFromCookieHeader(header, 'abc'), null);
    assert.equal(accessTokenFromCookieHeader(header, null), null);
  });
});
