import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
/** Falls back to the caller's identity so RLS still applies if the key is unset. */
export const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;

export interface ChatAuth {
  /** Client that acts AS THE CALLER, so row level security applies. */
  supabase: SupabaseClient;
  userId: string;
  token: string;
}

export function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.substring(7) : null;
}

/**
 * Resolves the caller from the Bearer token, returning a Supabase client bound
 * to that token. Returns null when the request carries no usable session.
 */
export async function authenticate(request: NextRequest): Promise<ChatAuth | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  return { supabase, userId: data.user.id, token };
}

/** Builds a conversation title from the first user message. */
export function deriveTitle(text: string, max = 80): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Guards against passing non-UUID context values into uuid columns. */
export function asUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export const CONVERSATION_COLUMNS =
  'id, title, tool_context, page_context, domain_code, entity_id, message_count, last_message_at, created_at, updated_at';
