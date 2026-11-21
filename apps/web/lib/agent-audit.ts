import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runWithAgentContext,
  takeAgentAudits,
  usageForClient,
  type AgentAudit,
  type AgentContext,
  type ClientUsage,
} from '@tapestrai/mcp-server/src/agent/harness';
import { soleClientId } from '@tapestrai/mcp-server/src/feeds/session-client';

/** Puts the signed-in user on model calls made while loading a file. */
export function asFeedCaller<T>(userId: string, clientId: string, fn: () => Promise<T>): Promise<T> {
  return runWithAgentContext({ userId, clientId, feature: 'feed-intake', activity: 'feed.import' }, fn);
}

/**
 * The client this session is acting for, including support-mode impersonation,
 * for naming it on a model call's receipt. Someone who belongs to more than one
 * client gets null: the receipt then names no client instead of a guessed one.
 */
export async function callerClientId(supabase: SupabaseClient): Promise<string | null> {
  return soleClientId(supabase);
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
