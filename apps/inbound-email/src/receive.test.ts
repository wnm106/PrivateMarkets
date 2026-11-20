import { describe, expect, it } from 'vitest';
import { receive, tokenFrom, type Env, type InboundMessage } from './receive';

const TOKEN = '0123456789abcdef01234567';
const env: Env = { SUPABASE_URL: 'https://db.example.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-key', INBOUND_EMAIL_DOMAIN: 'in.example.com' };

function message(overrides: Partial<{ to: string; body: string; rawSize: number; headers: Record<string, string> }> = {}) {
  const body = overrides.body ?? 'From: ops@adminco.com\r\nSubject: NAV\r\n\r\nhello';
  const bytes = new TextEncoder().encode(body);
  const rejected: string[] = [];
  const value: InboundMessage = {
    from: 'bounce@adminco.com',
    to: overrides.to ?? `${TOKEN}@in.example.com`,
    headers: new Headers(overrides.headers ?? { 'message-id': '<nav-oct@adminco.com>', from: 'Fund Ops <ops@adminco.com>', subject: 'October  NAV' }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 5));
        controller.enqueue(bytes.slice(5));
        controller.close();
      },
    }),
    rawSize: overrides.rawSize ?? bytes.length,
    setReject: (reason) => rejected.push(reason),
  };
  return { value, rejected };
}

function fakeFetch(route: Record<string, unknown>, begin: Record<string, unknown> = { duplicate: false, id: 'm-1', rawPath: 'client-a/_email/conn-1/raw/m-1.eml' }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/rpc/email_inbound_route')) return json(route);
    if (url.endsWith('/rpc/email_inbound_begin')) return json(begin);
    if (url.endsWith('/rpc/email_inbound_stored')) return json('run-1');
    if (url.includes('/storage/v1/object/')) return json({ Key: 'ok' });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const OK = { verdict: 'OK', connectionId: 'conn-1', clientId: 'client-a', maxBytes: 1024 };

describe('tokenFrom', () => {
  it('takes only a 24-character token at the inbound domain', () => {
    expect(tokenFrom(`${TOKEN.toUpperCase()}@IN.example.com`, 'in.example.com')).toBe(TOKEN);
    expect(tokenFrom(`<${TOKEN}@in.example.com>`, 'in.example.com')).toBe(TOKEN);
    expect(tokenFrom(`${TOKEN}@example.com`, 'in.example.com')).toBeNull();
    expect(tokenFrom('postmaster@in.example.com', 'in.example.com')).toBeNull();
    expect(tokenFrom(`${TOKEN}+x@in.example.com`, 'in.example.com')).toBeNull();
    expect(tokenFrom(`${TOKEN}@anywhere.com`)).toBe(TOKEN);
  });
});

describe('receive', () => {
  it('stores a message for a live address and records it, which queues screening', async () => {
    const { value, rejected } = message();
    const { fetcher, calls } = fakeFetch(OK);
    expect(await receive(value, env, fetcher)).toEqual({ taken: true, messageId: 'm-1' });
    expect(rejected).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://db.example.co/rest/v1/rpc/email_inbound_route',
      'https://db.example.co/rest/v1/rpc/email_inbound_begin',
      'https://db.example.co/storage/v1/object/feed-inbox/client-a/_email/conn-1/raw/m-1.eml',
      'https://db.example.co/rest/v1/rpc/email_inbound_stored',
    ]);
    const begin = JSON.parse(String(calls[1].init.body));
    expect(begin).toMatchObject({ p_connection_id: 'conn-1', p_message_id: '<nav-oct@adminco.com>', p_envelope_from: 'bounce@adminco.com', p_subject: 'October  NAV' });
    expect(new TextDecoder().decode(calls[2].init.body as Uint8Array)).toContain('Subject: NAV');
    expect((calls[2].init.headers as Record<string, string>)['x-upsert']).toBe('true');
  });

  it('refuses an address that is not a connection, without asking the database', async () => {
    const { value, rejected } = message({ to: 'ceo@in.example.com' });
    const { fetcher, calls } = fakeFetch(OK);
    expect(await receive(value, env, fetcher)).toEqual({ taken: false, refused: 'Address not found' });
    expect(rejected).toEqual(['Address not found']);
    expect(calls).toEqual([]);
  });

  it('refuses what the database turns down, and says the same for unknown and paused', async () => {
    for (const [verdict, said] of [
      ['UNKNOWN', 'Address not found'],
      ['PAUSED', 'Address not found'],
      ['TOO_LARGE', 'Message too large'],
      ['RATE_LIMITED', 'Too many messages to this address; try again later'],
    ]) {
      const { value, rejected } = message();
      const { fetcher, calls } = fakeFetch({ verdict });
      await receive(value, env, fetcher);
      expect(rejected).toEqual([said]);
      expect(calls).toHaveLength(1);
    }
  });

  it('stops reading at the limit, whatever size the sender declared', async () => {
    const { value, rejected } = message({ body: 'x'.repeat(2000), rawSize: 10 });
    const { fetcher, calls } = fakeFetch(OK);
    expect(await receive(value, env, fetcher)).toEqual({ taken: false, refused: 'Message too large' });
    expect(rejected).toEqual(['Message too large']);
    expect(calls).toHaveLength(1);
  });

  it('takes nothing for a Message-ID it has had, and does not refuse it', async () => {
    const { value, rejected } = message();
    const { fetcher, calls } = fakeFetch(OK, { duplicate: true, id: 'm-0' });
    expect(await receive(value, env, fetcher)).toEqual({ taken: false, duplicate: true, messageId: 'm-0' });
    expect(rejected).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('fails loudly when the database cannot be reached', async () => {
    const { value } = message();
    const fetcher = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    await expect(receive(value, env, fetcher)).rejects.toThrow(/email_inbound_route failed: 503/);
  });
});
