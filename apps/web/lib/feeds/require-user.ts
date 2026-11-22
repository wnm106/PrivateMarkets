import { NextResponse } from 'next/server';
import {
  LOAD_PROMOTE_PERMISSION,
  LOAD_PROMOTE_REFUSED,
  LOAD_WRITE_PERMISSION,
  LOAD_WRITE_REFUSED,
  SEVERAL_CLIENTS_MESSAGE,
  hasClientPermission,
  sessionClientIds,
} from '@tapestrai/mcp-server/src/feeds/session-client';
import { supabaseServerClient } from '@/lib/supabase-server';

/**
 * Who a feed route is acting for. The feed code these routes call writes with
 * the service role, which row security does not hold back, so every check here
 * is made with the caller's own session before that code runs.
 */

export async function requireFeedUser() {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/**
 * The client this session reads the load queue of, including support-mode
 * impersonation. Someone who belongs to several clients reads the first by id,
 * always the same one. For anything that writes, use requireFeedWriter or
 * feedWriteClientId: they refuse a session with more than one client.
 */
export async function feedClientId(): Promise<string | null> {
  const ids = await sessionClientIds(await supabaseServerClient());
  return ids[0] ?? null;
}

/** The session's only client, for naming it on a model call. Null when there is none or more than one: never a guess. */
export async function feedAuditClientId(): Promise<string | null> {
  const ids = await sessionClientIds(await supabaseServerClient());
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The one client a write is for. A session with no client, or with more than
 * one, gets an error to return instead: nothing says which client the write
 * belongs to, and picking one could put a client's records into another.
 */
export async function feedWriteClientId(noClientMessage = 'Choose a client before loading the file'): Promise<{ clientId: string } | { error: NextResponse }> {
  const ids = await sessionClientIds(await supabaseServerClient());
  if (ids.length === 1) return { clientId: ids[0] };
  return { error: NextResponse.json({ error: ids.length === 0 ? noClientMessage : SEVERAL_CLIENTS_MESSAGE }, { status: 400 }) };
}

type FeedUser = NonNullable<Awaited<ReturnType<typeof requireFeedUser>>>;

/**
 * For a feed route that stores or changes anything. Answers with the response
 * to return when the caller may not: 401 without a session, 400 with no client
 * or more than one, 403 without permission to edit records in the client
 * (entity.write). Belonging to the client is not enough: a viewer is refused.
 */
export async function requireFeedWriter(signInMessage = 'Sign in to load a file'): Promise<{ user: FeedUser; clientId: string } | { error: NextResponse }> {
  const user = await requireFeedUser();
  if (!user) return { error: NextResponse.json({ error: signInMessage }, { status: 401 }) };
  const client = await feedWriteClientId();
  if ('error' in client) return client;
  if (!(await canWriteLoads(client.clientId))) return { error: NextResponse.json({ error: LOAD_WRITE_REFUSED }, { status: 403 }) };
  return { user, clientId: client.clientId };
}

/**
 * For a feed route that writes straight to live records (a load that is not
 * staged first). It needs what promoting a staged batch needs: load.promote in
 * the one client, checked with the caller's own session. 401 without a
 * session, 400 with no client or more than one, 403 without the permission.
 */
export async function requireFeedLoader(signInMessage = 'Sign in to load a file'): Promise<{ user: FeedUser; clientId: string } | { error: NextResponse }> {
  const user = await requireFeedUser();
  if (!user) return { error: NextResponse.json({ error: signInMessage }, { status: 401 }) };
  const client = await feedWriteClientId();
  if ('error' in client) return client;
  if (!(await canPromoteLoads(client.clientId))) return { error: NextResponse.json({ error: LOAD_PROMOTE_REFUSED }, { status: 403 }) };
  return { user, clientId: client.clientId };
}

/** Whether this session may store or change a file and its staged batch: permission to edit records in the client. */
export async function canWriteLoads(clientId: string): Promise<boolean> {
  return hasClientPermission(await supabaseServerClient(), clientId, LOAD_WRITE_PERMISSION);
}

/** Whether this session may promote a staged load to live records, or revert one. */
export async function canPromoteLoads(clientId: string): Promise<boolean> {
  return hasClientPermission(await supabaseServerClient(), clientId, LOAD_PROMOTE_PERMISSION);
}

/**
 * Whether this session may add fields or record types for the client. The
 * database decides, with the same rule its own schema policies use.
 */
export async function canChangeSchema(clientId: string): Promise<boolean> {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.schema('tenancy').rpc('can_write_schema_row', { p_client_id: clientId });
  return !error && data === true;
}
