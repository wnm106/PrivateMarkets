import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextPathCookie, safeNextPath } from './safe-next-path';

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

  it('stores the return path in a short-lived cookie', () => {
    assert.equal(nextPathCookie('/admin/dq-rules'), 'tapestr-next=%2Fadmin%2Fdq-rules; Path=/; Max-Age=600; SameSite=Lax');
    assert.match(nextPathCookie('https://evil.example'), /^tapestr-next=%2F;/);
  });
});
