import { supabaseServerClient } from '@/lib/supabase-server';

export interface SurfaceUser {
  clientCode: string | null;
  permissions: string[];
  isTenantAdmin: boolean;
}

/** Resolves who the caller is for surface gating. Fails closed: errors yield no client and no permissions. */
export async function loadSurfaceUser(): Promise<SurfaceUser | null> {
  const supabase = await supabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;

  const tenancy = supabase.schema('tenancy');
  const { data: profile } = await tenancy.from('profiles').select('is_tenant_admin').eq('id', user.id).maybeSingle();

  const { data: memberships } = await tenancy
    .from('client_users')
    .select('client:clients(client_code)')
    .eq('user_id', user.id);
  const first = (memberships || [])[0] as { client?: { client_code?: string } | null } | undefined;

  const { data: roleRows } = await tenancy
    .from('user_roles')
    .select('role:roles(role_permissions(permission:permissions(permission_code)))')
    .eq('user_id', user.id);
  const codes = new Set<string>();
  for (const row of roleRows || []) {
    const role = (row as { role?: { role_permissions?: { permission?: { permission_code?: string } }[] } }).role;
    for (const rp of role?.role_permissions || []) {
      if (rp.permission?.permission_code) codes.add(rp.permission.permission_code);
    }
  }

  return {
    clientCode: first?.client?.client_code ?? null,
    permissions: [...codes],
    isTenantAdmin: Boolean(profile?.is_tenant_admin),
  };
}
