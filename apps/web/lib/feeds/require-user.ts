import { supabaseServerClient } from '@/lib/supabase-server';

export async function requireFeedUser() {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
