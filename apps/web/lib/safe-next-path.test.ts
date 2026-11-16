import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUnauthenticatedGraphqlError, loginPath, nextPathCookie, safeNextPath } from './safe-next-path';

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
