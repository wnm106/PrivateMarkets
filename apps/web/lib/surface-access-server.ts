import { supabaseServerClient } from '@/lib/supabase-server';
import { OPEN_SCOPE, parseModuleScope, moduleAllowsSurface, moduleAllowsTool, type ModuleScope } from '@/lib/client-modules';
import { LICENSED_PAGES, TOOL_PAGES } from '@/lib/tool-pages';
import { SURFACES } from '@/lib/surface-registry';
import { surfaceNavLinks, type SurfaceNavLink } from '@/lib/surface-links';

export interface SurfaceUser {
  clientCode: string | null;
  permissions: string[];
  isTenantAdmin: boolean;
}

interface SurfaceCaller {
  clientCode?: string | null;
  permissions?: unknown;
  isTenantAdmin?: boolean;
}

/**
 * Resolves who the caller is for surface gating. The database decides
 * (tenancy.surface_caller), with the rule the surface catalog uses: the
 * simulated client, else the caller's only active membership. A tenant admin
 * who is simulating a client is gated as that client.
 * Fails closed: errors yield no client and no permissions.
 */
export async function loadSurfaceUser(): Promise<SurfaceUser | null> {
  const supabase = await supabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;

  const { data: caller, error } = await supabase.schema('tenancy').rpc('surface_caller');
  if (error || !caller) return { clientCode: null, permissions: [], isTenantAdmin: false };

  const row = caller as SurfaceCaller;
  return {
    clientCode: row.clientCode ?? null,
    permissions: Array.isArray(row.permissions)
      ? row.permissions.filter((code): code is string => typeof code === 'string')
      : [],
    isTenantAdmin: row.isTenantAdmin === true,
  };
}

/** Surfaces and tools for this session. A missing function leaves the full catalog in place. */
export async function loadModuleScope(): Promise<ModuleScope> {
  const supabase = await supabaseServerClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return OPEN_SCOPE;
  const { data, error } = await supabase.schema('tenancy').rpc('module_scope');
  if (error) return OPEN_SCOPE;
  return parseModuleScope(data);
}

export interface AppNav {
  surfaceLinks: SurfaceNavLink[];
  /** Null when the session uses the full catalog and no page is switched off. */
  enabledToolHrefs: string[] | null;
}

/** Mounted surfaces and tools this caller may open. Empty surfaces when signed out. */
export async function loadAppNav(): Promise<AppNav> {
  const [user, scope] = await Promise.all([loadSurfaceUser(), loadModuleScope()]);
  if (!user) return { surfaceLinks: [], enabledToolHrefs: null };
  const manifests = SURFACES.map((entry) => entry.manifest).filter((manifest) => moduleAllowsSurface(scope, manifest.code));
  return {
    surfaceLinks: surfaceNavLinks(manifests, user),
    enabledToolHrefs: toolHrefsFor(scope),
  };
}

/** The tool pages this session keeps: null for all of them, else the list a curated client saved less what a switch turned off. */
export function toolHrefsFor(scope: ModuleScope): string[] | null {
  if (!scope.restricted && (scope.blocked?.tool.length ?? 0) === 0) return null;
  const hrefs = new Set<string>([...TOOL_PAGES.map((page) => page.href), ...LICENSED_PAGES.map((page) => page.href), ...scope.tools]);
  return [...hrefs].filter((href) => moduleAllowsTool(scope, href));
}
