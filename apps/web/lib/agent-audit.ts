import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runWithAgentContext,
  takeAgentAudits,
  usageForClient,
  type AgentAudit,
  type AgentContext,
  type ClientUsage,
} from '@tapestrai/mcp-server/src/agent/harness';

/** Puts the signed-in user on model calls made while loading a file. */
export function asFeedCaller<T>(userId: string, clientId: string, fn: () => Promise<T>): Promise<T> {
  return runWithAgentContext({ userId, clientId, feature: 'feed-intake', activity: 'feed.import' }, fn);
}

/** The client this session is acting for, including support-mode impersonation. */
export async function callerClientId(supabase: SupabaseClient): Promise<string | null> {
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

/**
 * Runs fn as the signed-in user and client, and returns the model receipts
 * from that work so the response can hand them back to the caller.
 */
export async function withAgentCaller<T>(
  supabase: SupabaseClient | null,
  userId: string | null,
  fields: AgentContext,
  fn: () => Promise<T>,
): Promise<{ result: T; audits: AgentAudit[]; usage: ClientUsage }> {
  const clientId = fields.clientId !== undefined ? fields.clientId : supabase && userId ? await callerClientId(supabase) : null;
  let audits: AgentAudit[] = [];
  try {
    const result = await runWithAgentContext({ ...fields, userId, clientId }, async () => {
      try {
        return await fn();
      } finally {
        audits = [...takeAgentAudits()];
      }
    });
    return { result, audits, usage: usageForClient(audits) };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    (wrapped as Error & { usage?: ClientUsage }).usage = usageForClient(audits);
    throw wrapped;
  }
}
