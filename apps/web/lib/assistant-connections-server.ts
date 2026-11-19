import { createClient } from '@supabase/supabase-js';
import { serverView, type ServerView } from '@tapestrai/mcp-server/src/external/rows';
import { supabaseServerClient } from '@/lib/supabase-server';
import { feedClientId } from '@/lib/feeds/require-user';

/**
 * Server-side helpers for the assistant connections admin routes. Listing and
 * saving run as the signed-in caller, so the database checks the client and
 * the assistant.connections.manage permission. Only the connection check uses
 * the service role, to read the stored credential.
 */

export async function callerSession() {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { supabase, user: data.user, clientId: await feedClientId() };
}

export type CallerSession = NonNullable<Awaited<ReturnType<typeof callerSession>>>;

export async function listServers(session: CallerSession): Promise<ServerView[]> {
  const { data, error } = await session.supabase.rpc('assistant_mcp_servers_list');
  if (error) throw error;
  return ((data as Record<string, any>[] | null) || []).map(serverView);
}

export async function findServer(session: CallerSession, id: string): Promise<ServerView | null> {
  return (await listServers(session)).find((server) => server.id === id) || null;
}

export async function canManage(session: CallerSession): Promise<boolean> {
  if (!session.clientId) return false;
  const { data, error } = await session.supabase
    .schema('tenancy')
    .rpc('has_permission', { p_client_id: session.clientId, p_permission_code: 'assistant.connections.manage' });
  return !error && data === true;
}

/** Sources a server can be tied to: the same list lineage and precedence use. */
export async function listSources(session: CallerSession) {
  const { data, error } = await session.supabase
    .schema('entity_instances')
    .from('source_registry')
    .select('source_code, source_name, source_type, is_active')
    .order('source_name');
  if (error) return [];
  return (data || [])
    .filter((row: any) => row.is_active !== false)
    .map((row: any) => ({ sourceCode: row.source_code as string, sourceName: row.source_name as string, sourceType: row.source_type as string }));
}

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('The service role key is not configured, so the connection cannot be checked.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
