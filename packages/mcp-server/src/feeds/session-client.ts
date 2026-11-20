import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who a file load is for, and whether they may write.
 *
 * The loader itself writes with the service role, which row security does not
 * hold back. So everything here is asked of the database with a client that
 * carries the CALLER's JWT, before any of that code runs: which clients the
 * session may act in, and what the caller may do in the one it is loading into.
 * A service-role client has no user, so it resolves to no client and is refused.
 */

/** Loading a file creates and edits records, so it needs what editing a record needs. */
export const LOAD_WRITE_PERMISSION = 'entity.write';
/**
 * Writing to live records: promoting a staged batch, reverting a promoted one,
 * and a load that is not staged first, which writes what a promote would.
 */
export const LOAD_PROMOTE_PERMISSION = 'load.promote';

export const NO_CLIENT_MESSAGE = 'Choose a client before importing a file.';
export const SEVERAL_CLIENTS_MESSAGE =
  'Your account belongs to more than one client, so the client this is for cannot be told. Nothing was written. Use an account that belongs to that client only.';
export const LOAD_WRITE_REFUSED = 'Loading or changing a file needs permission to edit records for this client (entity.write). Ask a client admin.';
export const LOAD_PROMOTE_REFUSED = 'Loading into live records, or promoting or reverting a load, needs the load.promote permission for this client. Stage the file instead, or ask a client admin.';

/** A refusal with the HTTP status a route should answer with. */
export class FeedAccessError extends Error {
  constructor(message: string, readonly status: 400 | 403) {
    super(message);
    this.name = 'FeedAccessError';
  }
}

/** The ids out of what tenancy.current_client_ids() returned, without repeats, in a fixed order. */
export function clientIdsFromRows(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  for (const row of data) {
    const value = typeof row === 'string' ? row : row && typeof row === 'object' ? Object.values(row)[0] : null;
    if (typeof value === 'string' && value) ids.add(value);
  }
  // The function returns them in no order. Sorting means the same session always reads the same list.
  return [...ids].sort();
}

/**
 * Every client the session may act in: the one a tenant admin is simulating,
 * or else the caller's own memberships. Empty when there is none or it could not be read.
 */
export async function sessionClientIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.schema('tenancy').rpc('current_client_ids');
  return error ? [] : clientIdsFromRows(data);
}

/** The session's only client. Null when it has none, or more than one: a guess is never returned. */
export async function soleClientId(supabase: SupabaseClient): Promise<string | null> {
  const ids = await sessionClientIds(supabase);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The client a session reads the load queue of. Someone who belongs to several
 * clients reads the first by id, which is always the same one for them. They
 * cannot write through it: see sessionWriteClientId.
 */
export async function sessionClientId(supabase: SupabaseClient): Promise<string> {
  const ids = await sessionClientIds(supabase);
  if (ids.length === 0) throw new FeedAccessError(NO_CLIENT_MESSAGE, 400);
  return ids[0];
}

/**
 * The client a write is for. A session with more than one client is refused:
 * nothing says which one the file belongs to, and picking one could put a
 * client's records into another.
 */
export async function sessionWriteClientId(supabase: SupabaseClient): Promise<string> {
  const ids = await sessionClientIds(supabase);
  if (ids.length === 0) throw new FeedAccessError(NO_CLIENT_MESSAGE, 400);
  if (ids.length > 1) throw new FeedAccessError(SEVERAL_CLIENTS_MESSAGE, 400);
  return ids[0];
}

/** Whether the caller holds a permission in a client. The database decides, as the caller. */
export async function hasClientPermission(supabase: SupabaseClient, clientId: string, permissionCode: string): Promise<boolean> {
  const { data, error } = await supabase.schema('tenancy').rpc('has_permission', { p_client_id: clientId, p_permission_code: permissionCode });
  return !error && data === true;
}

/**
 * Call before any load code that writes. Returns the one client the caller is
 * loading into, once the database has said they may edit records there.
 * Belonging to the client is not enough: a viewer is refused.
 */
export async function requireLoadWrite(supabase: SupabaseClient): Promise<string> {
  const clientId = await sessionWriteClientId(supabase);
  if (!(await hasClientPermission(supabase, clientId, LOAD_WRITE_PERMISSION))) {
    throw new FeedAccessError(LOAD_WRITE_REFUSED, 403);
  }
  return clientId;
}

/**
 * Call before anything that writes live records: promoting or reverting a
 * batch, or loading a file without staging it. The caller must hold
 * load.promote, the same as a promote needs, so a load cannot be used to get
 * around the staged review.
 */
export async function requireLoadPromote(supabase: SupabaseClient): Promise<string> {
  const clientId = await sessionWriteClientId(supabase);
  if (!(await hasClientPermission(supabase, clientId, LOAD_PROMOTE_PERMISSION))) {
    throw new FeedAccessError(LOAD_PROMOTE_REFUSED, 403);
  }
  return clientId;
}
