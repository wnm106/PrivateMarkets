import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUnauthenticatedGraphqlError, loginPath, nextPathCookie, nextPathFromCookie, safeNextPath } from './safe-next-path';

describe('safeNextPath', () => {
  it('keeps an in-app path and drops pages that bounce a signed-in user', () => {
    assert.equal(safeNextPath('/admin/tenancy'), '/admin/tenancy');
    assert.equal(safeNextPath('/funds/abc?tab=1'), '/funds/abc?tab=1');
    assert.equal(safeNextPath('/login?redirectedFrom=/funds'), '/');
    assert.equal(safeNextPath('/welcome'), '/');
    assert.equal(safeNextPath('//evil.example'), '/');
    assert.equal(safeNextPath('https://evil.example'), '/');
    assert.equal(safeNextPath(null), '/');
  });

  it('refuses every spelling of another site', () => {
    const origin = 'https://app.example.com';
    const elsewhere = [
      'https://evil.com',
      'http://evil.com/path',
      '//evil.com',
      '///evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      '\\\\evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r/evil.com',
      '/\t\n/evil.com',
      '\t//evil.com',
      '/%09/evil.com',
      '/%0A/evil.com',
      '/%0d/evil.com',
      '/%2F/evil.com',
      '/%2f%2Fevil.com',
      '/%5Cevil.com',
      '/%5c/evil.com',
      '/%2509/evil.com',
      '/%252F/evil.com',
      '/.//evil.com',
      '/..//evil.com',
      '/funds\\..\\evil.com',
      '/funds?next=\t//evil.com',
      'javascript:alert(1)',
      'evil.com',
      ' /funds',
      '/%E0%A4%A/evil.com',
      '/%25252509/evil.com',
    ];
    for (const value of elsewhere) {
      const next = safeNextPath(value);
      assert.equal(next, '/', `${JSON.stringify(value)} was kept`);
    }
    // What survives always lands on the app's own origin, however it is turned into a URL.
    const kept = ['/', '/admin/tenancy', '/funds/abc?tab=1', '/s/fund-rec#nav', '/funds?name=A%20B', '/funds/a%20b', '/funds?q=100%'];
    for (const value of kept) {
      const next = safeNextPath(value);
      assert.equal(next, value);
      assert.equal(new URL(next, `${origin}/login`).origin, origin);
      assert.equal(new URL(`${origin}${next}`).origin, origin);
    }
  });

  it('refuses a control character that a query string delivers decoded', () => {
    // ?redirectedFrom=/%09/evil.com arrives as a tab. The URL parser would drop it and leave //evil.com.
    const delivered = new URLSearchParams('redirectedFrom=/%09/evil.com').get('redirectedFrom');
    assert.equal(delivered, '/\t/evil.com');
    assert.equal(new URL(delivered as string, 'https://app.example.com/login').origin, 'https://evil.com');
    assert.equal(safeNextPath(delivered), '/');
  });

  it('drops the pages that bounce a signed-in user, however they are written', () => {
    assert.equal(safeNextPath('/login'), '/');
    assert.equal(safeNextPath('/login/'), '/');
    assert.equal(safeNextPath('/./login'), '/');
    assert.equal(safeNextPath('/auth/callback?code=x'), '/');
    assert.equal(safeNextPath('/auth/callback/extra'), '/');
    assert.equal(safeNextPath('/welcome#top'), '/');
    assert.equal(safeNextPath('/login/mfa', '/home'), '/login/mfa');
    assert.equal(safeNextPath('//evil.com', '/home'), '/home');
  });

  it('reads the return path back from its cookie, and survives a broken one', () => {
    assert.equal(nextPathFromCookie('%2Fadmin%2Fdq-rules'), '/admin/dq-rules');
    assert.equal(nextPathFromCookie('%2F%2Fevil.com'), '/');
    assert.equal(nextPathFromCookie('%2F%09%2Fevil.com'), '/');
    assert.equal(nextPathFromCookie('%E0%A4%A'), '/');
    assert.equal(nextPathFromCookie(undefined), '/');
  });

  it('sends every protected path to login, including the home page', () => {
    assert.equal(loginPath('/'), '/login?redirectedFrom=%2F');
    assert.equal(loginPath('/admin/entities'), '/login?redirectedFrom=%2Fadmin%2Fentities');
    assert.equal(loginPath('/login'), '/login?redirectedFrom=%2F');
  });

  it('recognizes a rejected session and ignores other request failures', () => {
    assert.equal(isUnauthenticatedGraphqlError({ message: 'Not authenticated' }), true);
    assert.equal(isUnauthenticatedGraphqlError({ graphQLErrors: [{ message: 'Not authenticated' }] }), true);
    assert.equal(isUnauthenticatedGraphqlError({ message: 'The overview could not be loaded.' }), false);
    assert.equal(isUnauthenticatedGraphqlError(undefined), false);
  });

  it('stores the return path in a short-lived cookie', () => {
    assert.equal(nextPathCookie('/admin/dq-rules'), 'tapestr-next=%2Fadmin%2Fdq-rules; Path=/; Max-Age=600; SameSite=Lax');
    assert.match(nextPathCookie('https://evil.example'), /^tapestr-next=%2F;/);
  });
});
