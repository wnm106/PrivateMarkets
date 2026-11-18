import { checkSurfaceAccess, type SurfaceManifest } from '@tapestrai/surface-sdk';

/** A mounted surface the sidebar can show. Plain data, safe to pass from the server. */
export interface SurfaceNavLink {
  code: string;
  href: string;
  label: string;
  icon: string;
}

const ICONS: Record<string, string> = {
  'deal-pipeline': 'layers',
  'fund-index': 'chart',
};

export type SurfaceNavUser = {
  clientCode: string | null;
  permissions: readonly string[];
  isTenantAdmin?: boolean;
};

/** Manifests the caller may open, in registry order. */
export function eligibleManifests(manifests: readonly SurfaceManifest[], user: SurfaceNavUser): SurfaceManifest[] {
  return manifests.filter((manifest) => checkSurfaceAccess(manifest, user).allowed);
}

/** Sidebar entries for those surfaces. The route is always /s/<code>. */
export function surfaceNavLinks(manifests: readonly SurfaceManifest[], user: SurfaceNavUser): SurfaceNavLink[] {
  return eligibleManifests(manifests, user).map((manifest) => ({
    code: manifest.code,
    href: `/s/${manifest.code}`,
    label: manifest.title,
    icon: ICONS[manifest.code] ?? 'layers',
  }));
}

/**
 * Tools that a visible surface has taken over. A tool goes when it is the
 * surface's own route, or when it is the older page of the same name.
 */
export function omitSurfacesFromTools<T extends { href: string; label: string }>(
  tools: readonly T[],
  surfaces: readonly Pick<SurfaceNavLink, 'href' | 'label'>[],
): T[] {
  const hrefs = new Set(surfaces.map((surface) => surface.href));
  const titles = new Set(surfaces.map((surface) => surface.label.toLowerCase()));
  return tools.filter((tool) => !hrefs.has(tool.href) && !titles.has(tool.label.toLowerCase()));
}

/** True when this path is the surface, or a page the surface owns. */
export function surfaceLinkActive(pathname: string, link: Pick<SurfaceNavLink, 'code' | 'href'>): boolean {
  if (pathname === link.href || pathname.startsWith(`${link.href}/`)) return true;
  // The fund surface opens each fund on its overview. The older index is /fund-surface.
  if (link.code === 'fund-index') {
    return pathname === '/fund-surface' || pathname.startsWith('/fund-surface/') || /^\/funds\/[^/]+\/overview\/?$/.test(pathname);
  }
  return false;
}
