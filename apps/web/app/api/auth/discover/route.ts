import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseSignInDiscovery, PLATFORM_DISCOVERY } from '@tapestrai/graphql/src/lib/enterprise-sso';

/**
 * Home-realm discovery for the signed-out login page.
 * The database function is granted only to the service role and returns
 * protocols and labels, never a client secret or a client id.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email.includes('@')) {
    return NextResponse.json(PLATFORM_DISCOVERY);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(PLATFORM_DISCOVERY);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.schema('tenancy').rpc('discover_sign_in', { p_email: email });
  if (error) {
    // The migration is the source of the function. Until it is applied, keep
    // the previous password and Microsoft choices. A configured domain is still
    // enforced by the access-token hook once the function exists.
    if (/discover_sign_in|PGRST202|schema cache/i.test(error.message)) {
      return NextResponse.json(PLATFORM_DISCOVERY);
    }
    return NextResponse.json({ ...PLATFORM_DISCOVERY, message: 'Sign-in options could not be loaded. Try again.' }, { status: 503 });
  }
  return NextResponse.json(parseSignInDiscovery(data));
}
