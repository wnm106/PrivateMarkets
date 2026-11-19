import { supabaseServerClient } from '@/lib/supabase-server';

export async function requireFeedUser() {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/** The client this session is allowed to load into, including support-mode impersonation. */
export async function feedClientId(): Promise<string | null> {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.schema('tenancy').rpc('current_client_ids');
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const value = Object.values(first)[0];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Whether this session may promote a staged load to live records, or revert one. */
export async function canPromoteLoads(clientId: string): Promise<boolean> {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.schema('tenancy').rpc('has_permission', { p_client_id: clientId, p_permission_code: 'load.promote' });
  return !error && data === true;
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
