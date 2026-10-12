import { NextRequest, NextResponse } from 'next/server';
import { supabaseServerClient } from '@/lib/supabase-server';

/**
 * OAuth (Azure AD) PKCE callback. Exchanges the ?code for a session, which
 * supabaseServerClient() persists back into cookies for middleware/SSR to see.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirectedFrom = searchParams.get('redirectedFrom') || '/';

  if (code) {
    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${redirectedFrom}`);
    }
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  return NextResponse.redirect(`${origin}/login?error=missing_code`);
}
