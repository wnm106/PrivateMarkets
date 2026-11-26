/**
 * Requests per person per minute, for GraphQL and the assistant connector.
 *
 * On Cloudflare the count is kept by the Workers rate-limiting binding
 * (RATE_LIMITER in apps/web/wrangler.jsonc and apps/api/wrangler.toml), which
 * holds across every copy of the worker. Where there is no binding (next dev,
 * tests), nothing is limited.
 *
 * The key is the person's id once they are signed in, else their address, so
 * one person's script cannot slow everyone else and an anonymous caller is
 * counted by where it comes from.
 */

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const RATE_LIMITED = 'Too many requests. Wait a minute and try again.';

/** Whether this request may go ahead. A binding that fails lets it through: the limit protects, it must not take the app down. */
export async function withinRateLimit(binding: RateLimitBinding | null | undefined, key: string | null): Promise<boolean> {
  if (!binding || !key) return true;
  try {
    const { success } = await binding.limit({ key });
    return success !== false;
  } catch {
    return true;
  }
}

/** The key for a caller: their id, else their address. */
export function rateLimitKey(userId: string | null | undefined, ip: string | null | undefined): string | null {
  if (userId) return `user:${userId}`;
  if (ip) return `ip:${ip}`;
  return null;
}
