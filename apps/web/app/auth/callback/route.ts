import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseProjectRef } from '@/lib/auth-token';
import { NEXT_PATH_COOKIE, nextPathFromCookie, safeNextPath } from '@/lib/safe-next-path';
import { EXCEL_CONNECT_PATH, SESSION_STORE_COOKIE, sessionCookieName, sessionStoreFrom } from '@/lib/session-store';

/**
 * OAuth (Azure AD) PKCE callback. The session cookies have to be set on this
 * redirect response. A separate cookie store does not travel with it, and the
 * next request looks signed out and is sent home.
 *
 * A sign-in started for Excel (lib/session-store.ts) keeps its session in the
 * add-in's own cookie and returns to the Excel sign-in page.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const remembered = request.cookies.get(NEXT_PATH_COOKIE)?.value;
  const store = sessionStoreFrom(request.cookies.get(SESSION_STORE_COOKIE)?.value);
  const requested = searchParams.get('redirectedFrom');
  const redirectedFrom = store === 'excel'
    ? EXCEL_CONNECT_PATH
    : requested ? safeNextPath(requested) : nextPathFromCookie(remembered);
  const cookieName = sessionCookieName(store, supabaseProjectRef());

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const redirect = NextResponse.redirect(`${origin}${redirectedFrom}`);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => redirect.cookies.set(name, value, options as any));
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  redirect.cookies.set(NEXT_PATH_COOKIE, '', { path: '/', maxAge: 0 });
  redirect.cookies.set(SESSION_STORE_COOKIE, '', { path: '/', maxAge: 0 });
  if (!error) return redirect;
  const failed = store === 'excel' ? EXCEL_CONNECT_PATH : '/login';
  const failure = NextResponse.redirect(`${origin}${failed}?error=${encodeURIComponent(error.message)}`);
  failure.cookies.set(SESSION_STORE_COOKIE, '', { path: '/', maxAge: 0 });
  return failure;
}
