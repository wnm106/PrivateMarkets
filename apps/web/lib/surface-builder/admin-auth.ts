import { NextRequest, NextResponse } from 'next/server';
import { authenticate, type ChatAuth } from '@/lib/chat-server';

/**
 * The caller, when they are a tenant admin; otherwise the response to send.
 * The Surface Builder's routes all start here. Row security on
 * surface_blueprints applies the same rule again in the database.
 */
export async function requireTenantAdmin(request: NextRequest): Promise<ChatAuth | NextResponse> {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Sign in to use the Surface Builder.' }, { status: 401 });
  const { data: isAdmin } = await auth.supabase.schema('tenancy').rpc('is_tenant_admin');
  if (isAdmin !== true) return NextResponse.json({ error: 'The Surface Builder is for tenant admins.' }, { status: 403 });
  return auth;
}
