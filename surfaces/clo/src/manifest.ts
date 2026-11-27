import { SURFACE_SDK_VERSION, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** Server-safe: no React, so the host can read it without loading the surface. */
export const manifest: SurfaceManifest = {
  code: 'clo',
  title: 'CLO Manager',
  description: 'Every CLO vehicle: indenture terms and tests with drill-down, collateral, the headline quality and coverage measures, how they have drifted, the liabilities and payment-date waterfall, and the offered loans that would improve each CLO.',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  domains: ['FUND', 'CLO_TRANSACTION', 'CLO_NOTE_CLASS', 'CLO_ACCOUNT', 'POSITION', 'SECURITY', 'ISSUER'],
};
