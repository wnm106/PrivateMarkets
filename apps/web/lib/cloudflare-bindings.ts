import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { RateLimitBinding } from '@tapestrai/graphql/src/lib/rate-limit';

/**
 * The Workers rate-limiting binding (RATE_LIMITER in wrangler.jsonc), or null
 * where the app does not run on Cloudflare (next dev, tests).
 */
export function rateLimiter(): RateLimitBinding | null {
  try {
    const env = getCloudflareContext().env as unknown as { RATE_LIMITER?: RateLimitBinding };
    return env.RATE_LIMITER ?? null;
  } catch {
    return null;
  }
}
