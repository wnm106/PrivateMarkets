import { Context } from '../context';

function tenancy(context: Context) {
  return (context.supabaseAdmin ?? context.supabase).schema('tenancy');
}

/**
 * Decide which client owns a new schema row or entity.
 * A tenant admin who is not simulating a client may leave schema rows global.
 * Entity records always belong to a client.
 */
export async function resolveSchemaClientId(
  context: Context,
  requested: string | null | undefined,
  options: { required: boolean }
): Promise<string | null> {
  if (!context.user?.id) {
    throw new Error('Not authenticated');
  }

  const userId = context.user.id;
  const db = tenancy(context);
  const [
    { data: profile, error: profileError },
    { data: impersonation, error: impersonationError },
    { data: memberships, error: membershipError },
  ] = await Promise.all([
    db.from('profiles').select('is_tenant_admin').eq('id', userId).maybeSingle(),
    db.from('impersonation_sessions')
      .select('client_id')
      .eq('admin_user_id', userId)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('client_users').select('client_id').eq('user_id', userId).eq('is_active', true),
  ]);

  if (profileError) throw profileError;
  if (impersonationError) throw impersonationError;
  if (membershipError) throw membershipError;

  const isTenantAdmin = profile?.is_tenant_admin === true;
  const impersonatingId: string | null = impersonation?.client_id ?? null;
  const memberIds = (memberships || []).map((row: { client_id: string }) => row.client_id);
  const requestedId = requested || null;

  if (impersonatingId) {
    if (requestedId && requestedId !== impersonatingId) {
      throw new Error('While simulating a client, new definitions belong to that client.');
    }
    return impersonatingId;
  }

  if (requestedId) {
    if (!isTenantAdmin && !memberIds.includes(requestedId)) {
      throw new Error('You cannot add definitions for that client.');
    }
    return requestedId;
  }

  if (options.required) {
    if (!isTenantAdmin && memberIds.length === 1) return memberIds[0];
    throw new Error('Choose a client for this entity.');
  }

  if (isTenantAdmin) return null;
  if (memberIds.length === 1) return memberIds[0];
  throw new Error('Choose a client for this definition.');
}

export async function clientNameMap(
  context: Context,
  clientIds: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const ids = [...new Set(clientIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const { data, error } = await tenancy(context).from('clients').select('id, client_name').in('id', ids);
  if (error || !data) return new Map();
  return new Map(data.map((row: { id: string; client_name: string }) => [row.id, row.client_name]));
}

export async function withClientNames<T extends { clientId?: string | null }>(
  context: Context,
  rows: T[]
): Promise<Array<T & { clientName: string | null }>> {
  const names = await clientNameMap(context, rows.map((row) => row.clientId));
  return rows.map((row) => ({
    ...row,
    clientName: row.clientId ? names.get(row.clientId) ?? null : null,
  }));
}
