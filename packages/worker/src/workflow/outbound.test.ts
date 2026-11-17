import { describe, expect, it } from 'vitest';
import { connectionUrl, workflowOutbound } from './outbound';

describe('connectionUrl', () => {
  it('keeps a step inside its connection address', () => {
    expect(connectionUrl('https://api.admin.example/v1/', '/statements?fund=HSCF2').toString()).toBe('https://api.admin.example/v1/statements?fund=HSCF2');
    expect(connectionUrl('https://api.admin.example/v1', 'queries').toString()).toBe('https://api.admin.example/v1/queries');
    expect(() => connectionUrl('https://api.admin.example/v1', 'https://evil.example/x')).toThrow(/not a whole address/);
    expect(() => connectionUrl('https://api.admin.example/v1', '//evil.example/x')).toThrow(/not a whole address/);
    expect(() => connectionUrl('https://api.admin.example/v1', '/../admin')).toThrow(/climb out/);
  });
});

describe('workflowOutbound', () => {
  const supabase = (rows: Record<string, unknown>) => ({ rpc: async (fn: string) => ({ data: rows[fn] ?? null, error: null }) });

  it('calls a connection with its credential and refuses redirects', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ id: 7 }), { status: 201 });
    }) as unknown as typeof fetch;
    const outbound = workflowOutbound({
      supabase: supabase({ workflow_worker_connection: { connection: { kind: 'HTTP', is_active: true, config: { baseUrl: 'https://api.admin.example/v1', authType: 'BEARER' } }, secret: 'tok' } }) as never,
      fetchImpl,
      http: { allowPrivate: true },
    });
    expect(await outbound.http({ clientId: 'c', connection: 'ADMIN', method: 'POST', path: '/queries', body: { q: 1 } })).toEqual({ status: 201, body: { id: 7 } });
    expect(seen[0].url).toBe('https://api.admin.example/v1/queries');
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(seen[0].init.redirect).toBe('manual');
  });

  it('says why it cannot send', async () => {
    const outbound = workflowOutbound({ supabase: supabase({}) as never, env: {}, fetchImpl: (async () => new Response('')) as unknown as typeof fetch });
    await expect(outbound.http({ clientId: 'c', connection: 'NOPE', method: 'GET', path: '', body: undefined })).rejects.toThrow(/no connection "NOPE"/);
    await expect(outbound.email(['a@example.com'], 's', 't')).rejects.toThrow(/RESEND_API_KEY/);
    await expect(outbound.slack('c', 't')).rejects.toThrow(/no Slack address/);
    expect(outbound.formLink('abc')).toBe('/portal/abc');
  });
});
