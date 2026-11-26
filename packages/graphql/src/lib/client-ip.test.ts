import { beforeEach, describe, expect, it } from 'vitest';
import { clearIpRefusalCache, clientIp, IP_UNCHECKED, ipRefusal } from './client-ip';

function client(answers: Array<{ data?: unknown; error?: { code?: string; message?: string } | null }>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    schema: () => ({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        calls.push(args);
        const next = answers.shift() ?? { data: null };
        return { data: next.data ?? null, error: next.error ?? null };
      },
    }),
  };
}

describe('clientIp', () => {
  it('trusts only the address Cloudflare sets', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': ' 203.0.113.9 ', 'x-forwarded-for': '1.2.3.4' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull();
  });
});

describe('ipRefusal', () => {
  beforeEach(() => clearIpRefusalCache());

  it('passes the refusal through, and asks again only after a minute', async () => {
    const db = client([{ data: 'Not from here.' }, { data: null }]);
    expect(await ipRefusal(db, 'u1', '198.51.100.7', 0)).toBe('Not from here.');
    expect(await ipRefusal(db, 'u1', '198.51.100.7', 30_000)).toBe('Not from here.');
    expect(db.calls).toEqual([{ p_ip: '198.51.100.7' }]);
    expect(await ipRefusal(db, 'u1', '198.51.100.7', 61_000)).toBeNull();
    expect(db.calls.length).toBe(2);
  });

  it('allows when the check is not set up, and refuses when it could not run', async () => {
    expect(await ipRefusal(client([{ error: { code: 'PGRST202', message: 'Could not find the function' } }]), 'u1', null)).toBeNull();
    expect(await ipRefusal(client([{ error: { code: '57014', message: 'timeout' } }]), 'u2', null)).toBe(IP_UNCHECKED);
  });
});
