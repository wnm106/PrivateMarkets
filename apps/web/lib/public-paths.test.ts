import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicPath } from './public-paths';

describe('isPublicPath', () => {
  it('opens the sign-in pages and portal forms, and nothing under them', () => {
    for (const path of ['/welcome', '/welcome/', '/login', '/no-access', '/auth/callback', '/portal/0123abc']) assert.equal(isPublicPath(path), true, path);
    for (const path of ['/', '/welcome/form-preview', '/login/x', '/portal', '/portalx', '/workflows', '/funds/123']) assert.equal(isPublicPath(path), false, path);
  });
});
