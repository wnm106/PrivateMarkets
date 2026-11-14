import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSurfaceAccess, SURFACE_SDK_VERSION, type SurfaceManifest } from '../../../packages/surface-sdk/src/index';

const base: SurfaceManifest = { code: 'x', title: 'X', sdkVersion: SURFACE_SDK_VERSION, version: '1.0.0' };
const user = { clientCode: 'ACME', permissions: ['fund.read'] };

describe('checkSurfaceAccess', () => {
  it('opens an unrestricted surface to any signed-in user', () => {
    assert.equal(checkSurfaceAccess(base, user).allowed, true);
  });
  it('limits a surface to its listed clients', () => {
    const m = { ...base, clients: ['OTHER'] };
    assert.deepEqual(checkSurfaceAccess(m, user), { allowed: false, reason: 'client' });
    assert.equal(checkSurfaceAccess({ ...base, clients: ['ACME'] }, user).allowed, true);
  });
  it('requires every listed permission', () => {
    const m = { ...base, requiredPermissions: ['fund.read', 'fund.write'] };
    assert.deepEqual(checkSurfaceAccess(m, user), { allowed: false, reason: 'permission' });
  });
  it('rejects a surface built for a different SDK version', () => {
    assert.deepEqual(checkSurfaceAccess({ ...base, sdkVersion: 99 }, user), { allowed: false, reason: 'sdk' });
  });
  it('lets tenant admins in regardless of client', () => {
    const m = { ...base, clients: ['OTHER'] };
    assert.equal(checkSurfaceAccess(m, { ...user, isTenantAdmin: true }).allowed, true);
  });
});
