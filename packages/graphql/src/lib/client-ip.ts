/**
 * The caller's network address, and whether their clients allow it
 * (supabase/migrations/20261126150000_ip_allowlist.sql).
 *
 * The address is Cloudflare's cf-connecting-ip: Cloudflare sets it on every
 * request it forwards and replaces any value the caller sent. X-Forwarded-For
 * is not used, because its first entry is whatever the caller wrote. Where no
 * trusted address is present (a server not behind Cloudflare), the address is
 * unknown, and a client that lists networks refuses the request.
 */

export function clientIp(headers: Pick<Headers, 'get'>): string | null {
  const value = headers.get('cf-connecting-ip')?.trim();
  return value ? value : null;
}

type RpcClient = {
  schema: (name: string) => { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };
};

/** Errors that mean the check is not set up yet: the function is missing. */
function notSetUp(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message || '');
}

export const IP_UNCHECKED = 'Your network could not be checked. Try again.';

const CACHE_MS = 60_000;
const cache = new Map<string, { refusal: string | null; at: number }>();

/**
 * Why this caller may not use the app from this address, or null. A person's
 * answer is kept for a minute per address, so a changed list takes up to a
 * minute to apply; most requests then cost nothing.
 */
export async function ipRefusal(supabase: RpcClient, userId: string, ip: string | null, now = Date.now()): Promise<string | null> {
  const key = `${userId}|${ip ?? ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.refusal;

  const { data, error } = await supabase.schema('tenancy').rpc('ip_refusal', { p_ip: ip });
  if (error) {
    if (notSetUp(error)) return null;
    return IP_UNCHECKED;
  }
  const refusal = typeof data === 'string' && data ? data : null;
  if (cache.size > 5000) cache.clear();
  cache.set(key, { refusal, at: now });
  return refusal;
}

/** For tests. */
export function clearIpRefusalCache(): void {
  cache.clear();
}
