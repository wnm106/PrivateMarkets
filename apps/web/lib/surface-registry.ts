/**
 * Registry of mounted surfaces. Adding a client surface = one entry here.
 *
 * Server-safe: it holds manifests (plain data) and lazy loaders. The loader is
 * only called from the client mount, so the host can gate access on the
 * server without importing any surface UI.
 */
import type { SurfaceManifest, SurfaceModule } from '@tapestrai/surface-sdk';
import { manifest as fundIndex } from '@surfaces/fund-index/src/manifest';

export interface SurfaceRegistration {
  manifest: SurfaceManifest;
  load: () => Promise<{ default: SurfaceModule }>;
}

export const SURFACES: readonly SurfaceRegistration[] = [
  { manifest: fundIndex, load: () => import('@surfaces/fund-index/src') },
];

export function findSurface(code: string): SurfaceRegistration | undefined {
  return SURFACES.find((entry) => entry.manifest.code === code);
}
