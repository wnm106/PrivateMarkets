import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { CLIENT_ADMIN_PERMISSIONS, isPlatformAdminPath } from '@/lib/admin-access';
import { NEXT_PATH_COOKIE, safeNextPath } from '@/lib/safe-next-path';

const PUBLIC_PATHS = ['/welcome', '/login', '/auth/callback', '/no-access'];

async function adminAccess(supabase: { schema: (name: string) => any }, userId: string) {
  const { data: profile, error: profileError } = await supabase
    .schema('tenancy')
    .from('profiles')
    .select('is_tenant_admin')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) return { tenant: false, admin: false };
  if (profile?.is_tenant_admin) return { tenant: true, admin: true };

  const { data: rows, error: roleError } = await supabase
    .schema('tenancy')
    .from('user_roles')
    .select('role:roles(role_permissions(permission:permissions(permission_code)))')
    .eq('user_id', userId);
  if (roleError) return { tenant: false, admin: false };

  const codes = new Set<string>();
  for (const row of rows || []) {
    const role = (row as { role?: { role_permissions?: { permission?: { permission_code?: string } }[] } }).role;
    for (const rp of role?.role_permissions || []) {
      if (rp.permission?.permission_code) codes.add(rp.permission.permission_code);
    }
  }
  const admin = CLIENT_ADMIN_PERMISSIONS.some((code) => codes.has(code));
  return { tenant: false, admin };
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const refreshedCookies: { name: string; value: string; options?: Record<string, unknown> }[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          refreshedCookies.splice(0, refreshedCookies.length, ...cookiesToSet);
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options as any));
        },
      },
    }
  );

  const redirectTo = (pathname: string) => {
    const redirect = NextResponse.redirect(new URL(pathname, request.url));
    refreshedCookies.forEach(({ name, value, options }) => redirect.cookies.set(name, value, options as any));
    return redirect;
  };

  // Refreshes the session token if expired -- required for Server Components.
  const { data: { user } } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Microsoft sign-in sometimes returns the auth code to the site root
  // instead of /auth/callback. Trading that code here is what creates the session.
  const oauthCode = request.nextUrl.searchParams.get('code');
  if (oauthCode && oauthCode.length > 20 && (pathname === '/' || pathname === '/login' || pathname === '/welcome')) {
    const callback = new URL('/auth/callback', request.url);
    request.nextUrl.searchParams.forEach((value, key) => callback.searchParams.set(key, value));
    if (!callback.searchParams.get('redirectedFrom')) {
      const remembered = request.cookies.get(NEXT_PATH_COOKIE)?.value;
      if (remembered) callback.searchParams.set('redirectedFrom', safeNextPath(decodeURIComponent(remembered)));
    }
    return NextResponse.redirect(callback);
  }
  const isPublicPath = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const isApiOrAsset =
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    /\.(jpg|jpeg|png|svg|ico|webp|gif)$/i.test(pathname); // public/ images (logo)

  // Signed-out visitors to the root see the marketing landing page.
  if (!user && pathname === '/') {
    return redirectTo('/welcome');
  }

  // Signed-in users have no need for the marketing page or the sign-in form.
  if (user && (pathname === '/welcome' || pathname === '/login')) {
    const next = pathname === '/login' ? safeNextPath(request.nextUrl.searchParams.get('redirectedFrom')) : '/';
    return redirectTo(next);
  }

  if (!user && !isPublicPath && !isApiOrAsset) {
    const redirectUrl = new URL('/login', request.url);
    redirectUrl.searchParams.set('redirectedFrom', request.nextUrl.pathname);
    const redirect = NextResponse.redirect(redirectUrl);
    refreshedCookies.forEach(({ name, value, options }) => redirect.cookies.set(name, value, options as any));
    return redirect;
  }

  // Admin tools are limited to tenant admins and client administrators.
  // Fail closed: if the role lookup errors, the admin area stays shut.
  if (user && pathname.startsWith('/admin')) {
    const access = await adminAccess(supabase, user.id);
    if (!access.admin) {
      return redirectTo('/');
    }
    if (!access.tenant && isPlatformAdminPath(pathname)) {
      return redirectTo('/admin/tenancy');
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files, so middleware still runs
     * on API routes (needed to keep the session cookie fresh for GraphQL
     * resolvers that may run server-side later) and page routes alike.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
