import { SURFACE_SDK_VERSION, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** Server-safe: no React, so the host can read it without loading the surface. */
export const manifest: SurfaceManifest = {
  code: 'performance',
  title: 'Performance',
  description: 'Firm-wide performance by fund, position, deal and investor, and ad hoc across any funds, deals, sectors and periods.',
  sdkVersion: SURFACE_SDK_VERSION,
  version: '1.0.0',
  domains: ['FUND', 'POSITION', 'CASH_FLOW', 'DEAL', 'DEAL_TRANCHE', 'SECURITY', 'ISSUER', 'INVESTOR', 'CAPITAL_ACCOUNT'],
};
