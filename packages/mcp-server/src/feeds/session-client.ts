import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The client a signed-in session may load into, including support-mode
 * impersonation. Pass a client that carries the caller's JWT. A service-role
 * client has no user, so it resolves to nothing and the load is refused.
 */
export async function sessionClientId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.schema('tenancy').rpc('current_client_ids');
  if (!error && Array.isArray(data) && data.length > 0) {
    const first = data[0];
    const value = typeof first === 'string' ? first : first && typeof first === 'object' ? Object.values(first)[0] : null;
    if (typeof value === 'string' && value) return value;
  }
  throw new Error('Choose a client before importing a file.');
}
