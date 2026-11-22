/**
 * fetch for a client's MCP server that connects only to the addresses that
 * were checked.
 *
 * assertPublicHost resolves the server's name and refuses a private address.
 * A plain fetch would then resolve the name a second time, and a name that
 * answers differently the second time (DNS rebinding) could point the request
 * into our own network. On Node the request goes to the checked addresses: the
 * name is used for the Host header and the certificate check only. The reply
 * is streamed, since the MCP transports read server-sent events.
 *
 * On Cloudflare Workers, where the web app is deployed, the platform's fetch is
 * used: it reaches only the public internet (global_fetch_strictly_public), and
 * Workers cannot choose the address a name connects to.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

function onWorkers(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers';
}

/** A name lookup that only ever answers with the addresses given. */
export function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  }) as unknown as LookupFunction;
}

function headersOf(init?: RequestInit, request?: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const merged = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
  merged.forEach((value, key) => { out[key] = value; });
  return out;
}

async function bodyOf(init?: RequestInit, request?: Request): Promise<Buffer | undefined> {
  const body = init?.body ?? (request && request.body ? await request.arrayBuffer() : undefined);
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return Buffer.from(await new Response(body as BodyInit).arrayBuffer());
}

/**
 * Sends the request to one of `addresses`, never to whatever the name resolves
 * to now. Empty `addresses` means nothing was checked (private addresses are
 * allowed for local development), so a plain fetch is used.
 */
export async function pinnedFetch(input: string | URL | Request, init: RequestInit | undefined, addresses: string[]): Promise<Response> {
  if (!addresses.length || onWorkers()) return fetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : String(input));
  const body = await bodyOf(init, request);
  const signal = init?.signal ?? request?.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = (url.protocol === 'http:' ? http : https).request(url, {
      method: init?.method ?? request?.method ?? 'GET',
      headers: headersOf(init, request),
      // A connection of its own, made to a checked address. A shared one may be to an address checked for another call.
      agent: false,
      lookup: pinnedLookup(addresses),
      signal: signal || undefined,
    }, (incoming) => {
      const status = incoming.statusCode || 0;
      // A redirect is a second address nobody checked.
      if (status >= 300 && status < 400) {
        incoming.resume();
        reject(new Error(`${url.host} answered with a redirect, which is not followed.`));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      }
      const empty = status === 204 || status === 205 || status === 304 || (init?.method ?? request?.method) === 'HEAD';
      resolve(new Response(empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream), { status, statusText: incoming.statusMessage, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
