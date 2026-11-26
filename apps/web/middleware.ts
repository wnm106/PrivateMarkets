import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { CLIENT_ADMIN_PERMISSIONS, isPlatformAdminPath } from '@/lib/admin-access';
import { loginPath, NEXT_PATH_COOKIE, nextPathFromCookie, safeNextPath } from '@/lib/safe-next-path';
import { isPublicPath } from '@/lib/public-paths';
import { readSignInDecision, REFUSED_SIGN_IN, signInStanding, UNCHECKED_SIGN_IN, uncheckedSignInAction, type SignInDecision } from '@/lib/sign-in-gate';

// Which pages a signed-out visitor may open is in lib/public-paths.ts, shared with the signed-out gate.

/**
 * The client's sign-in rules as they apply to this session, or null when they
 * could not be read. It is asked twice before giving up, so one dropped request
 * does not count. Null is never treated as allowed: see signInStanding.
 */
async function signInDecision(supabase: { schema: (name: string) => any }): Promise<SignInDecision | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await supabase.schema('tenancy').rpc('current_sign_in_decision');
      const decision = error ? null : readSignInDecision(data);
      if (decision) return decision;
    } catch {
      // Asked once more below.
    }
  }
  return null;
}

/**
 * Marks this sign-in as active, for a client's idle limit (tenancy.touch_session
 * writes at most once a minute). Best effort: the limit is still enforced by the
 * database on every read, so a failed mark only shortens nobody's session.
 */
async function touchSession(supabase: { schema: (name: string) => any }) {
  try {
    await supabase.schema('tenancy').rpc('touch_session');
  } catch {
    // Not marked this time.
  }
}

function withSessionCookies(next: NextResponse, response: NextResponse) {
  response.cookies.getAll().forEach((cookie) => next.cookies.set(cookie));
  return next;
}

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
      if (remembered) callback.searchParams.set('redirectedFrom', nextPathFromCookie(remembered));
    }
    return NextResponse.redirect(callback);
  }
  const isPublic = isPublicPath(pathname);
  const isApiOrAsset =
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    /\.(jpg|jpeg|png|svg|ico|webp|gif)$/i.test(pathname); // public/ images (logo)

  // Signed-in users have no need for the marketing page or the sign-in form.
  if (user && (pathname === '/welcome' || pathname === '/login')) {
    const next = pathname === '/login' ? safeNextPath(request.nextUrl.searchParams.get('redirectedFrom')) : '/';
    return redirectTo(next);
  }

  // A signed-out visitor never sees the application shell, including the home page.
  // The query goes with them: the approval page (/oauth/consent) is useless without its request id.
  if (!user && !isPublic && !isApiOrAsset) {
    return redirectTo(loginPath(`${pathname}${request.nextUrl.search}`));
  }

  // A client's sign-in rules apply after the session exists. Direct data calls
  // are also refused by the Auth access-token hook; this stops the app itself.
  if (user) {
    const decision = await signInDecision(supabase);
    const standing = signInStanding(decision);
    if (standing === 'refused') {
      // A sign-in that ran out ends here only; "refused" for any other reason ends them all.
      await supabase.auth.signOut(decision?.session_ended ? { scope: 'local' } : undefined);
      const message = decision?.reason || REFUSED_SIGN_IN;
      if (pathname.startsWith('/api/')) {
        return withSessionCookies(NextResponse.json({ error: message }, { status: 403 }), response);
      }
      const redirectUrl = new URL('/login', request.url);
      redirectUrl.searchParams.set('error', message);
      return withSessionCookies(NextResponse.redirect(redirectUrl), response);
    }
    // Fail closed. When the rules could not be read, or gave no answer, nobody knows whether this
    // session is allowed or still owes a second factor, so nothing of the app is served on it: a
    // page sends the visitor to the sign-in page with the reason, and an API route answers 403.
    // For a page, this browser's session is dropped, because the sign-in page sends a signed-in
    // visitor straight back here. Public pages and static files are left alone.
    if (standing === 'unchecked') {
      const action = uncheckedSignInAction(pathname, { isPublic, isAsset: isApiOrAsset && !pathname.startsWith('/api/') });
      if (action === 'forbid') {
        return withSessionCookies(NextResponse.json({ error: UNCHECKED_SIGN_IN }, { status: 403 }), response);
      }
      if (action === 'sign_in_again') {
        await supabase.auth.signOut({ scope: 'local' });
        const redirectUrl = new URL('/login', request.url);
        redirectUrl.searchParams.set('error', UNCHECKED_SIGN_IN);
        return withSessionCookies(NextResponse.redirect(redirectUrl), response);
      }
    }
    if (standing === 'allowed' || standing === 'needs_mfa') await touchSession(supabase);
    // The Excel sign-in page checks the step-up for its own session (lib/session-store.ts).
    if (standing === 'needs_mfa' && !pathname.startsWith('/login/mfa') && !pathname.startsWith('/api/auth/') && !pathname.startsWith('/excel/')) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Multi-factor authentication is required.' }, { status: 403 });
      }
      if (!isApiOrAsset) {
        const redirectUrl = new URL('/login/mfa', request.url);
        redirectUrl.searchParams.set('redirectedFrom', safeNextPath(`${pathname}${request.nextUrl.search}`));
        return NextResponse.redirect(redirectUrl);
      }
    }
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
