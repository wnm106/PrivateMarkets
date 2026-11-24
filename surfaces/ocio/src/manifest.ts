import { SURFACE_SDK_VERSION, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** Server-safe: no React, so the host can read it without loading the surface. */
export const manifest: SurfaceManifest = {
  code: 'ocio',
  title: 'Mandate Target Manager',
  description: 'Targets, pacing, compliance and deal allocation across client programs and mandate sleeves.',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  domains: ['FUND', 'OCIO_TARGET', 'POSITION', 'SECURITY', 'DEAL', 'DEAL_TRANCHE', 'DEAL_FUNDING_PLAN'],
  // Built for one client. The module grant (supabase/seed/ocio_harbor_lite.sql) turns it on for that client too.
  clients: ['HARBOR_LITE'],
};
