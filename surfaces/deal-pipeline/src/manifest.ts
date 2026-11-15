import { SURFACE_SDK_VERSION, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** Server-safe: no React, so the host can read it without loading the surface. */
export const manifest: SurfaceManifest = {
  code: 'deal-pipeline',
  title: 'Deal Pipeline',
  description: 'Where every deal sits in its life cycle, across strategies.',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  domains: ['DEAL'],
};
