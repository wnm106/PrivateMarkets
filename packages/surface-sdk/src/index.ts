/**
 * Surface SDK: the only platform API a client surface may import.
 *
 * A surface is presentation. The host app owns routing, auth, tenancy, the
 * shell and the data layer, and hands a surface a `SurfaceHost` through React
 * context (see `@tapestrai/surface-sdk/react`). This entry is server-safe: no React runtime.
 * Surfaces must not import from `apps/web` (enforced by lint).
 */
import type { ComponentType } from 'react';

export const SURFACE_SDK_VERSION = 1;

export interface SurfaceCrumb {
  label: string;
  href?: string;
}

export interface GraphqlResult<TData> {
  data?: TData;
  error?: { message: string };
}

/** What the host exposes to a mounted surface. */
/** One attribute on one entity: what a displayed value points back to. */
export interface SurfaceAttributeTarget {
  entityId: string;
  entityName?: string;
  domainCode: string;
  attributeCode: string;
  attributeName: string;
  /** The value as shown, for the drawer header. */
  value?: string;
}

export interface SurfaceHost {
  /** Client (tenant) code the signed-in user works in, when known. */
  clientCode: string | null;
  /** Permission codes held by the user. */
  permissions: readonly string[];
  /** Selected as-of date (YYYY-MM-DD). */
  asOfDate: string;
  /** Selected knowledge date (YYYY-MM-DD or a datetime). */
  knowledgeDate: string;
  /** Where this surface is mounted, e.g. /s/deal-pipeline. Use it for the surface's own links. */
  basePath: string;
  /** Go to a platform or surface path. Client-side navigation. */
  navigate(path: string, options?: { replace?: boolean }): void;
  /** One URL query parameter on the surface's own page, as a hook: [value, set]. Setting null removes it. */
  useQueryParam(name: string): [string | null, (value: string | null) => void];
  query<TData = unknown>(
    document: string,
    variables?: Record<string, unknown>,
    policy?: 'network-only' | 'cache-first',
  ): Promise<GraphqlResult<TData>>;
  mutate<TData = unknown>(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphqlResult<TData>>;
  /** Link to a platform page, e.g. host.href('/funds/123/overview'). */
  href(path: string): string;
  /** Set the top-bar trail while the surface is mounted. A hook: call it unconditionally. */
  useCrumbs(crumbs: SurfaceCrumb[]): void;
  /** Open the platform's source drawer for a displayed value. */
  inspectAttribute(target: SurfaceAttributeTarget): void;
  /**
   * Tell the assistant what every tab of the surface shows, open or not. A hook: call it
   * unconditionally. A surface with tabs must call it. See docs/SURFACE_TABS.md.
   */
  usePublishTabs(tabs: Record<string, SurfaceTabPayload | null>): void;
}

/** What one tab tells the assistant. Pass the figures as the tab derives them, not raw records. */
export interface SurfaceTabPayload {
  /** The tab's label as the user sees it. */
  label: string;
  /** One sentence on what the tab is for and the question it answers. */
  purpose: string;
  /** Terms or rules needed to read the data, such as which level to report at. */
  howToRead?: string;
  /** The figures and labels the tab shows. Null while the tab loads. */
  data: Record<string, unknown> | null;
}

export interface SurfaceManifest {
  /** Stable code; the route is /s/<code>. Lowercase kebab-case. */
  code: string;
  title: string;
  description?: string;
  /** SDK contract version this surface was built against. */
  sdkVersion: number;
  /** Surface version, for rollout and rollback. */
  version: string;
  /** Domain codes the surface reads or writes (documentation and audit). */
  domains?: readonly string[];
  /** Permission codes the user must hold (all of them). Empty means any signed-in user. */
  requiredPermissions?: readonly string[];
  /** Client codes allowed to open it. Omit for every client. */
  clients?: readonly string[];
}

export interface SurfaceModule {
  manifest: SurfaceManifest;
  Component: ComponentType;
}

export function defineSurface(module: SurfaceModule): SurfaceModule {
  return module;
}

export type SurfaceAccess =
  | { allowed: true }
  | { allowed: false; reason: 'client' | 'permission' | 'sdk' };

/** Pure gate shared by the host and tests. Tenant admins pass the client and permission checks. */
export function checkSurfaceAccess(
  manifest: SurfaceManifest,
  user: { clientCode: string | null; permissions: readonly string[]; isTenantAdmin?: boolean },
): SurfaceAccess {
  if (manifest.sdkVersion !== SURFACE_SDK_VERSION) return { allowed: false, reason: 'sdk' };
  if (user.isTenantAdmin) return { allowed: true };
  if (manifest.clients && (!user.clientCode || !manifest.clients.includes(user.clientCode))) {
    return { allowed: false, reason: 'client' };
  }
  const missing = (manifest.requiredPermissions || []).some((code) => !user.permissions.includes(code));
  return missing ? { allowed: false, reason: 'permission' } : { allowed: true };
}
