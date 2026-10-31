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
