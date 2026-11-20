import type { SupabaseClient } from '@supabase/supabase-js';
import { serverFromRuntimeRow } from './rows';
import type { ExternalServer } from './types';

/**
 * The client's active servers that have at least one tool turned on, with
 * their credentials. `serviceSupabase` must use the service role key: the
 * function that returns secrets is not granted to signed-in users. Pass the
 * client id that was resolved from the caller's own session, never one taken
 * from the request body.
 */
export async function loadExternalServers(serviceSupabase: SupabaseClient, clientId: string): Promise<ExternalServer[]> {
  const { data, error } = await serviceSupabase.rpc('assistant_mcp_servers_runtime', { p_client_id: clientId });
  if (error) throw error;
  return ((data as Record<string, any>[] | null) || []).map(serverFromRuntimeRow);
}
