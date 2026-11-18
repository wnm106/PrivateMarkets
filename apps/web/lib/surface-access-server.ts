import { supabaseServerClient } from '@/lib/supabase-server';
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

/** Mounted surfaces this caller may open, for the sidebar. Empty when signed out. */
export async function loadSurfaceNavLinks(): Promise<SurfaceNavLink[]> {
  const user = await loadSurfaceUser();
  if (!user) return [];
  return surfaceNavLinks(
    SURFACES.map((entry) => entry.manifest),
    user,
  );
}
