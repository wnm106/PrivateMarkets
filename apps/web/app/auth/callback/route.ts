import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { NEXT_PATH_COOKIE, safeNextPath } from '@/lib/safe-next-path';

/**
 * OAuth (Azure AD) PKCE callback. The session cookies have to be set on this
 * redirect response. A separate cookie store does not travel with it, and the
 * next request looks signed out and is sent home.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const remembered = request.cookies.get(NEXT_PATH_COOKIE)?.value;
  const redirectedFrom = safeNextPath(
    searchParams.get('redirectedFrom') || (remembered ? decodeURIComponent(remembered) : null),
  );

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const redirect = NextResponse.redirect(`${origin}${redirectedFrom}`);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
  if (!error) return redirect;
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
}
