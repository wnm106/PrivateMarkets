import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessTokenFromAuthCookie, accessTokenFromCookieHeader } from './auth-token';

function jwt(exp: number) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp, sub: 'user_1' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('accessTokenFromAuthCookie', () => {
  it('reads a base64url session cookie that atob cannot decode', () => {
    const accessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
    const session = JSON.stringify({ access_token: accessToken, refresh_token: 'r/with+url_safe' });
    const encoded = `base64-${Buffer.from(session, 'utf8').toString('base64url')}`;
    assert.match(encoded, /[-_]/);
    assert.equal(accessTokenFromAuthCookie(encoded), accessToken);
  });

  it('reads a chunked cookie once the pieces are joined', () => {
    const accessToken = jwt(Math.floor(Date.now() / 1000) + 60);
    const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: accessToken }), 'utf8').toString('base64url')}`;
    const joined = `${encoded.slice(0, 12)}${encoded.slice(12)}`;
    assert.equal(accessTokenFromAuthCookie(joined), accessToken);
  });

  it('reads a legacy raw JSON cookie', () => {
    assert.equal(accessTokenFromAuthCookie(JSON.stringify({ access_token: 'plain-token' })), 'plain-token');
  });

  it('ignores a session cookie left over from another project', () => {
    const current = JSON.stringify({ access_token: 'current-token' });
    const stale = JSON.stringify({ access_token: 'stale-token' });
    const header = `sb-oldproject-auth-token=${encodeURIComponent(stale)}; sb-yxoug-auth-token=${encodeURIComponent(current)}`;
    assert.equal(accessTokenFromCookieHeader(header, 'yxoug'), 'current-token');
    const reversed = `sb-yxoug-auth-token=${encodeURIComponent(current)}; sb-oldproject-auth-token=${encodeURIComponent(stale)}`;
    assert.equal(accessTokenFromCookieHeader(reversed, 'yxoug'), 'current-token');
  });
});
