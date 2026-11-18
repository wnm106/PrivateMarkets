import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SURFACE_SDK_VERSION, type SurfaceManifest } from '../../../packages/surface-sdk/src/index';
import { omitSurfacesFromTools, surfaceLinkActive, surfaceNavLinks } from './surface-links';

const deal: SurfaceManifest = {
  code: 'deal-pipeline',
  title: 'Deal Pipeline',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
};
const fund: SurfaceManifest = {
  code: 'fund-index',
  title: 'Fund surface',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  clients: ['ACME'],
};

const tools = [
  { href: '/s/deal-pipeline', label: 'Deal Pipeline', icon: 'layers' },
  { href: '/fund-surface', label: 'Fund surface', icon: 'chart' },
  { href: '/workflows', label: 'Workflows', icon: 'nodes' },
] as const;

describe('surface nav links', () => {
  it('lists the surfaces a caller may open, in registry order', () => {
    const links = surfaceNavLinks([deal, fund], { clientCode: 'ACME', permissions: [] });
    assert.deepEqual(
      links.map((link) => ({ code: link.code, href: link.href, label: link.label, icon: link.icon })),
      [
        { code: 'deal-pipeline', href: '/s/deal-pipeline', label: 'Deal Pipeline', icon: 'layers' },
        { code: 'fund-index', href: '/s/fund-index', label: 'Fund surface', icon: 'chart' },
      ],
    );
  });

  it('hides a surface limited to another client', () => {
    const links = surfaceNavLinks([deal, fund], { clientCode: 'OTHER', permissions: [] });
    assert.deepEqual(links.map((link) => link.code), ['deal-pipeline']);
  });

  it('shows every surface to a tenant admin', () => {
    const links = surfaceNavLinks([deal, fund], { clientCode: null, permissions: [], isTenantAdmin: true });
    assert.deepEqual(links.map((link) => link.code), ['deal-pipeline', 'fund-index']);
  });

  it('takes replaced pages out of tools', () => {
    const links = surfaceNavLinks([deal, fund], { clientCode: 'ACME', permissions: [] });
    assert.deepEqual(omitSurfacesFromTools(tools, links).map((tool) => tool.href), ['/workflows']);
  });

  it('leaves the older fund page in tools when that surface is closed', () => {
    const links = surfaceNavLinks([deal, fund], { clientCode: 'OTHER', permissions: [] });
    assert.deepEqual(omitSurfacesFromTools(tools, links).map((tool) => tool.label), ['Fund surface', 'Workflows']);
  });

  it('treats a fund overview as the fund surface', () => {
    const link = surfaceNavLinks([fund], { clientCode: 'ACME', permissions: [] })[0];
    assert.equal(surfaceLinkActive('/s/fund-index', link), true);
    assert.equal(surfaceLinkActive('/funds/abc/overview', link), true);
    assert.equal(surfaceLinkActive('/fund-surface', link), true);
    assert.equal(surfaceLinkActive('/workflows', link), false);
  });
});
