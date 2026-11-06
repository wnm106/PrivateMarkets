/** Permissions that open the admin area for a client administrator. */
export const CLIENT_ADMIN_PERMISSIONS = ['user.manage', 'role.manage', 'entity_access.manage', 'client.manage'] as const;

/** Platform catalog tools. Tenant admins only; client admins stay on security. */
export const PLATFORM_ADMIN_PREFIXES = [
  '/admin/entities',
  '/admin/sources',
  '/admin/attributes',
  '/admin/templates',
  '/admin/dq-rules',
  '/admin/compliance',
  '/admin/dashboards',
  '/admin/narratives',
  '/admin/precedence',
];

export function isPlatformAdminPath(pathname: string) {
  return PLATFORM_ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
