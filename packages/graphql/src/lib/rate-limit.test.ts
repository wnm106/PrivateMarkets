import { describe, expect, it } from 'vitest';
import { rateLimitKey, withinRateLimit } from './rate-limit';

describe('withinRateLimit', () => {
  it('asks the binding with the caller\'s key', async () => {
    const keys: string[] = [];
    const binding = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length < 2 }; } };
    expect(await withinRateLimit(binding, 'user:u1')).toBe(true);
    expect(await withinRateLimit(binding, 'user:u1')).toBe(false);
    expect(keys).toEqual(['user:u1', 'user:u1']);
  });

  it('limits nothing without a binding or a key, and lets a request through when the binding fails', async () => {
    expect(await withinRateLimit(undefined, 'user:u1')).toBe(true);
    expect(await withinRateLimit({ limit: async () => ({ success: false }) }, null)).toBe(true);
    expect(await withinRateLimit({ limit: async () => { throw new Error('down'); } }, 'user:u1')).toBe(true);
  });
});

describe('rateLimitKey', () => {
  it('counts a signed-in person by id, else by address', () => {
    expect(rateLimitKey('u1', '203.0.113.9')).toBe('user:u1');
    expect(rateLimitKey(null, '203.0.113.9')).toBe('ip:203.0.113.9');
    expect(rateLimitKey(null, null)).toBeNull();
  });
});
