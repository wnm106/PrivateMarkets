/**
 * Takes one message from Cloudflare Email Routing for an EMAIL feed connection.
 *
 * This worker only decides whether to take the message at all, and stores it.
 * It refuses, while the sending server is still connected:
 *   - mail to another domain, or to an address that is not a connection's
 *   - mail to a paused connection
 *   - mail larger than the connection allows
 *   - mail over the connection's hourly limit
 * The refusal is the only answer a sender ever gets: nothing here replies or
 * bounces, so a forged sender is never sent mail.
 *
 * What it takes is stored unread in the private feed-inbox bucket and recorded,
 * which queues email.screen on the job worker. Screening checks the sender,
 * DKIM, and the attachments (packages/worker/src/email.ts). Nothing in the
 * message is parsed or acted on here.
 */

/** The part of Cloudflare's ForwardableEmailMessage this worker uses. */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INBOUND_EMAIL_DOMAIN?: string;
}

export type Outcome =
  | { taken: true; messageId: string }
  | { taken: false; duplicate: true; messageId: string }
  | { taken: false; refused: string };

const TOKEN = /^[0-9a-f]{24}$/;

/** What a sender is told. It never says whether an address exists, or why it is paused. */
export const REFUSALS = {
  UNKNOWN: 'Address not found',
  PAUSED: 'Address not found',
  TOO_LARGE: 'Message too large',
  RATE_LIMITED: 'Too many messages to this address; try again later',
} as const;

/** The address token from a recipient, or null when it is not one of ours. */
export function tokenFrom(recipient: string, domain?: string): string | null {
  const address = String(recipient || '').trim().toLowerCase().replace(/^<|>$/g, '');
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const local = address.slice(0, at);
  const host = address.slice(at + 1);
  const expected = String(domain || '').trim().toLowerCase().replace(/^@/, '');
  if (expected && host !== expected) return null;
  return TOKEN.test(local) ? local : null;
}

export function clip(value: string | null | undefined, length: number): string | null {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return text ? text.slice(0, length) : null;
}

async function rpc<T>(env: Env, fetcher: typeof fetch, fn: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetcher(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${fn} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return (await response.json()) as T;
}

async function store(env: Env, fetcher: typeof fetch, path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetcher(`${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/feed-inbox/${encoded}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'message/rfc822',
      // A message sent again after a failed store overwrites its own copy.
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Storing the message failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

interface Route {
  verdict: keyof typeof REFUSALS | 'OK';
  connectionId?: string;
  maxBytes?: number;
}

export async function receive(message: InboundMessage, env: Env, fetcher: typeof fetch = fetch): Promise<Outcome> {
  const refuse = (reason: string): Outcome => {
    message.setReject(reason);
    return { taken: false, refused: reason };
  };

  const token = tokenFrom(message.to, env.INBOUND_EMAIL_DOMAIN);
  if (!token) return refuse(REFUSALS.UNKNOWN);

  const route = await rpc<Route>(env, fetcher, 'email_inbound_route', { p_token: token, p_size_bytes: message.rawSize });
  if (route.verdict !== 'OK' || !route.connectionId) return refuse(REFUSALS[route.verdict as keyof typeof REFUSALS] || REFUSALS.UNKNOWN);

  // rawSize is what the sender declared. Reading stops at the limit whatever it said.
  const raw = await readAll(message.raw, route.maxBytes || 25 * 1024 * 1024);
  if (!raw) return refuse(REFUSALS.TOO_LARGE);

  const begun = await rpc<{ duplicate: boolean; id: string; rawPath?: string }>(env, fetcher, 'email_inbound_begin', {
    p_connection_id: route.connectionId,
    p_message_id: clip(message.headers.get('message-id'), 500),
    p_envelope_from: clip(message.from, 320),
    p_header_from: clip(message.headers.get('from'), 500),
    p_subject: clip(message.headers.get('subject'), 500),
    p_size_bytes: raw.length,
  });
  // The same Message-ID again: accept it quietly, so the sender does not keep trying, and take nothing.
  if (begun.duplicate || !begun.rawPath) return { taken: false, duplicate: true, messageId: begun.id };

  await store(env, fetcher, begun.rawPath, raw);
  await rpc(env, fetcher, 'email_inbound_stored', { p_id: begun.id });
  return { taken: true, messageId: begun.id };
}
