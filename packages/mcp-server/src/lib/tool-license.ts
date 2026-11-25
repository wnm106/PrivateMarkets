import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether the caller's client is licensed for a group of assistant tools.
 *
 * The database decides (tenancy.item_enabled with kind 'assistant_tool' and the
 * tool's category), as the caller, so the answer is for the client the call
 * runs as. A database without the function predates license switches and
 * leaves every group on. Any other error refuses the call.
 *
 * Answers are kept for a minute per database client, so a model turn that
 * calls ten tools asks once per group.
 */
const TTL_MS = 60_000;
const MISSING_FUNCTION = new Set(['PGRST202', '42883']);
const answers = new WeakMap<object, Map<string, { until: number; licensed: boolean }>>();

export class ToolNotLicensedError extends Error {
  constructor(readonly toolName: string, readonly category: string) {
    super(`The ${category} tools are not part of this client's license, so ${toolName} cannot run. A tenant admin can turn them on under Clients, Users & Roles.`);
    this.name = 'ToolNotLicensedError';
  }
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

function tenancyRpc(supabase: SupabaseClient): Rpc | null {
  const schema = (supabase as unknown as { schema?: (name: string) => { rpc?: Rpc } }).schema;
  if (typeof schema !== 'function') return null;
  const scoped = schema.call(supabase, 'tenancy');
  return scoped && typeof scoped.rpc === 'function' ? scoped.rpc.bind(scoped) : null;
}

export async function toolGroupLicensed(supabase: SupabaseClient, category: string): Promise<boolean> {
  const rpc = tenancyRpc(supabase);
  // A stand-in client with no database (unit tests) has nothing to ask.
  if (!rpc) return true;

  const now = Date.now();
  let known = answers.get(supabase);
  const hit = known?.get(category);
  if (hit && hit.until > now) return hit.licensed;

  const { data, error } = await rpc('item_enabled', { p_kind: 'assistant_tool', p_code: category });
  let licensed: boolean;
  if (error) {
    if (!MISSING_FUNCTION.has(String(error.code || ''))) {
      throw new Error(`This client's license could not be read: ${error.message || 'unknown error'}`);
    }
    licensed = true;
  } else {
    licensed = data !== false;
  }

  if (!known) {
    known = new Map();
    answers.set(supabase, known);
  }
  known.set(category, { until: now + TTL_MS, licensed });
  return licensed;
}
