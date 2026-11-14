import { SURFACE_SDK_VERSION, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** Server-safe: no React, so the host can read it without loading the surface. */
export const manifest: SurfaceManifest = {
  code: 'fund-index',
  title: 'Fund surface',
  description: 'Fund list that opens each fund overview.',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  domains: ['FUND'],
};
