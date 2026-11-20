import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { posix } from 'node:path';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import { JobError } from './worker';

/**
 * Connectors: where a feed's files come from.
 *
 * A connector lists the files waiting, fetches one, and is told how each one
 * turned out. Everything after that (hashing, the ledger, loading through the
 * saved map) is the same for every connector and lives in feeds.ts.
 *
 *   STORAGE  a folder in the private feed-inbox bucket, under the client's own folder
 *   HTTP     an https address
 *   SFTP     a folder on an SFTP server
 *
 * To add a kind: implement Connector, add it to buildConnector, and allow the
 * kind in ops.connections (supabase/migrations/20261114210000_feeds.sql).
 */

export const FEED_BUCKET = 'feed-inbox';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_POLL = 50;

export type FileOutcome = 'LOADED' | 'DUPLICATE' | 'NEEDS_REVIEW' | 'FAILED' | 'GAVE_UP';

export interface RemoteFile {
  name: string;
  /** Where the file is: a bucket path or an address. Stored in the ledger. */
  ref: string;
  size?: number;
}

export interface FetchedFile {
  name: string;
  bytes: Buffer;
  mediaType: string;
}

export interface FeedSpec {
  feedCode: string;
  path: string;
  filePattern: string;
}

export interface ConnectionSpec {
  id: string;
  clientId: string;
  kind: string;
  config: Record<string, unknown>;
  secret: string | null;
}

export interface Connector {
  /** Confirms the place can be reached. Returns a sentence to show; throws when it cannot. */
  check(): Promise<string>;
  list(feed: FeedSpec, now: Date): Promise<RemoteFile[]>;
  /** Null when the file is not there (yet). */
  fetch(file: RemoteFile): Promise<FetchedFile | null>;
  /** Called once per file with how it turned out, so the source can be tidied. */
  settle?(file: RemoteFile, outcome: FileOutcome, now: Date): Promise<void>;
  /** Called when the job is finished with the connector. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MEDIA_TYPES: Record<string, string> = {
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  htm: 'text/html',
};

export function mediaTypeFor(fileName: string, declared?: string | null): string {
  const clean = (declared || '').split(';')[0].trim().toLowerCase();
  if (clean && clean !== 'application/octet-stream' && clean !== 'binary/octet-stream') return clean;
  const extension = fileName.toLowerCase().split('.').pop() || '';
  return MEDIA_TYPES[extension] || 'application/octet-stream';
}

/** A file-name pattern with * and ?, matched without regard to case. */
export function matchesPattern(fileName: string, pattern: string): boolean {
  const source = (pattern || '*').trim() || '*';
  const expression = source
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${expression}$`, 'i').test(fileName);
}

/** Replaces {YYYY} {MM} {DD} with the run date (UTC). */
export function fillDateTokens(text: string, now: Date): string {
  const iso = now.toISOString();
  return text
    .replace(/\{YYYY\}/g, iso.slice(0, 4))
    .replace(/\{MM\}/g, iso.slice(5, 7))
    .replace(/\{DD\}/g, iso.slice(8, 10));
}

/**
 * Joins folder parts into a bucket path. Each part may only use letters,
 * digits, dot, dash, underscore and space, and may not be "." or "..", so a
 * configured path can never climb out of the client's folder.
 */
export function safeFolder(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of String(part || '').split(/[\\/]+/)) {
      const clean = segment.trim();
      if (!clean) continue;
      if (clean === '.' || clean === '..' || !/^[A-Za-z0-9._ -]+$/.test(clean)) {
        throw new JobError(`"${segment}" cannot be used in a folder path.`);
      }
      segments.push(clean);
    }
  }
  return segments.join('/');
}

// ---------------------------------------------------------------------------
// STORAGE: a drop folder in the feed-inbox bucket
// ---------------------------------------------------------------------------

/** Subfolders a poll moves files into. They are never listed as incoming files. */
const SETTLED_FOLDER: Record<FileOutcome, string | null> = {
  LOADED: 'processed',
  DUPLICATE: 'processed',
  NEEDS_REVIEW: 'review',
  GAVE_UP: 'failed',
  // Left in place: the next poll tries it again.
  FAILED: null,
};

export function storageConnector(supabase: SupabaseClient, connection: ConnectionSpec): Connector {
  const bucket = supabase.storage.from(FEED_BUCKET);
  // Always inside the client's own folder, whatever the connection says.
  const root = (feed?: FeedSpec) =>
    safeFolder(connection.clientId, String(connection.config.folder || ''), feed?.path || '');

  return {
    async check() {
      const folder = root();
      const { error } = await bucket.list(folder, { limit: 1 });
      if (error) throw new Error(error.message);
      return `The folder ${FEED_BUCKET}/${folder} can be read.`;
    },

    async list(feed) {
      const folder = root(feed);
      const { data, error } = await bucket.list(folder, { limit: 200, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(error.message);
      return (data || [])
        // A folder has no id. The placeholder is what the dashboard leaves in an empty folder.
        .filter((entry) => entry.id && entry.name !== '.emptyFolderPlaceholder' && matchesPattern(entry.name, feed.filePattern))
        .slice(0, MAX_FILES_PER_POLL)
        .map((entry) => ({
          name: entry.name,
          ref: `${folder}/${entry.name}`,
          size: Number((entry.metadata as { size?: number } | null)?.size) || undefined,
        }));
    },

    async fetch(file) {
      if (file.size && file.size > MAX_FILE_BYTES) {
        throw new JobError(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      const { data, error } = await bucket.download(file.ref);
      if (error) {
        if (/not.?found/i.test(error.message)) return null;
        throw new Error(error.message);
      }
      const bytes = Buffer.from(await data.arrayBuffer());
      return { name: file.name, bytes, mediaType: mediaTypeFor(file.name, data.type) };
    },

    async settle(file, outcome, now) {
      const target = SETTLED_FOLDER[outcome];
      if (!target) return;
      const folder = file.ref.slice(0, file.ref.length - file.name.length - 1);
      // The time keeps two files with the same name from colliding.
      const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      const { error } = await bucket.move(file.ref, `${folder}/${target}/${stamp}_${file.name}`);
      if (error) throw new Error(`${file.name} was handled but could not be moved to ${target}: ${error.message}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Public addresses only
// ---------------------------------------------------------------------------
//
// The worker sits inside the network, so an address a user typed must not be
// able to reach internal services. Two things make that hold:
//
//   1. Every address the host resolves to must be public (isPublicAddress).
//   2. The connection is made to an address that passed, and to no other
//      (pinnedLookup). The name is resolved once. If it were resolved again to
//      connect, a name that answers differently the second time would get
//      past the check.

function blockList(family: 'ipv4' | 'ipv6', subnets: Array<[string, number]>): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

/** IPv4 that is not a host on the public internet. */
const NOT_PUBLIC_V4 = blockList('ipv4', [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared by carriers (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, where cloud metadata services live
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relays
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
]);

/**
 * The only IPv6 that can be a public host is global unicast. Everything outside
 * it is refused without being listed: ::, ::1, unique-local fc00::/7, link-local
 * fe80::/10, multicast ff00::/8, and whatever is set aside next.
 */
const GLOBAL_V6 = blockList('ipv6', [['2000::', 3]]);

/** Global unicast that is set aside for something other than hosts. */
const NOT_PUBLIC_V6 = blockList('ipv6', [
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
]);

/** The eight 16-bit groups of an IPv6 address that isIP has already accepted. */
function groupsOf(address: string): number[] {
  // A dotted tail (::ffff:1.2.3.4) is the last two groups.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`
    : address;
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // "::" stands for as many zero groups as it takes to make eight.
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(zeros).fill('0'), ...right].map((group) => parseInt(group, 16));
}

function dottedQuad(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * The IPv4 addresses an IPv6 address carries inside it, or null when it carries
 * none. A packet sent to one of these forms is delivered to the IPv4 address
 * inside, so the address is only as public as that is. However the address is
 * written (::ffff:127.0.0.1 or ::ffff:7f00:1), the groups are the same.
 */
function embeddedV4(groups: number[]): string[] | null {
  const [a, b, c, d, e, f, g, h] = groups;
  // ::a.b.c.d, the old IPv4-compatible form. :: and ::1 are in it too, as 0.0.0.0 and 0.0.0.1.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return [dottedQuad(g, h)];
  // ::ffff:a.b.c.d, IPv4-mapped.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return [dottedQuad(g, h)];
  // 64:ff9b::a.b.c.d, NAT64. A network with only IPv6 reaches IPv4 hosts through it.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return [dottedQuad(g, h)];
  // 2002:AABB:CCDD::/48, 6to4.
  if (a === 0x2002) return [dottedQuad(b, c)];
  // 2001:0:SERVER:..:CLIENT, Teredo. The client's address is stored with every bit flipped.
  if (a === 0x2001 && b === 0) return [dottedQuad(c, d), dottedQuad(g ^ 0xffff, h ^ 0xffff)];
  return null;
}

/** Whether an IP address is a host on the public internet. Anything that is not an IP address is not. */
export function isPublicAddress(address: string): boolean {
  // A zone (fe80::1%eth0) names an interface, not a different address.
  const text = address.split('%')[0];
  const family = isIP(text);
  if (family === 4) return !NOT_PUBLIC_V4.check(text, 'ipv4');
  if (family !== 6) return false;
  const inside = embeddedV4(groupsOf(text));
  if (inside) return inside.every((v4) => !NOT_PUBLIC_V4.check(v4, 'ipv4'));
  return GLOBAL_V6.check(text, 'ipv6') && !NOT_PUBLIC_V6.check(text, 'ipv6');
}

export interface HttpOptions {
  /** Tests supply a stand-in. The default connects only to an address that was checked. */
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: allow http and private addresses. */
  allowPrivate?: boolean;
}

/**
 * The addresses a host may be reached at. The name is resolved once, here, and
 * the host is refused unless every address it has is public. Connect to one of
 * the addresses returned, never to the name again.
 *
 * Empty when private hosts are allowed: nothing is checked, so whatever makes
 * the connection resolves the name itself.
 */
export async function publicAddresses(host: string, options: HttpOptions = {}): Promise<string[]> {
  if (options.allowPrivate) return [];
  const resolve = options.resolve || (async (name: string) => (await lookup(name, { all: true })).map((entry) => entry.address));
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new Error(`${host} could not be found.`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new JobError(`${host} is not a public address.`);
  }
  return addresses;
}

/** A name lookup that only ever answers with the addresses given, whatever the name resolves to by now. */
export function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  };
}

export interface PublicRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** A redirect is never followed. 'error' fails the request; 'manual' hands the redirect back as the reply. */
  redirect: 'error' | 'manual';
  signal?: AbortSignal;
  /** Stop reading the reply once it is longer than this. What was read so far is returned. */
  maxBytes?: number;
}

/**
 * Sends one request. With addresses, the connection is made to one of them and
 * nowhere else: the name in the address is used for the Host header and the
 * certificate check only, and is never looked up again.
 */
export function pinnedRequest(url: URL, init: PublicRequest, addresses: string[]): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'http:' ? http : https).request(
      url,
      {
        method: init.method,
        headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'node', ...init.headers },
        signal: init.signal,
        // A connection of its own: a shared one may be to an address checked for some earlier request.
        agent: false,
        ...(addresses.length > 0 ? { lookup: pinnedLookup(addresses) } : {}),
      },
      (incoming) => {
        const status = incoming.statusCode || 0;
        if (status >= 300 && status < 400 && init.redirect === 'error') {
          request.destroy();
          reject(new Error(`${url.host} answered with a redirect, which is not followed.`));
          return;
        }
        const encoding = String(incoming.headers['content-encoding'] || '').trim().toLowerCase();
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
        const stream = decoder ? incoming.pipe(decoder) : incoming;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
            }
            // Once decoded, these two no longer describe the body.
            if (decoder) {
              headers.delete('content-encoding');
              headers.delete('content-length');
            }
            const empty = init.method === 'HEAD' || status === 204 || status === 205 || status === 304;
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: incoming.statusMessage, headers }));
          } catch (error) {
            // A status no reply may carry.
            reject(error);
          }
        };
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (init.maxBytes && size > init.maxBytes) {
            finish();
            request.destroy();
          }
        });
        stream.on('end', finish);
        stream.on('error', reject);
        incoming.on('error', reject);
        incoming.on('close', () => {
          if (!incoming.complete) reject(new Error(`${url.host} closed the connection before the reply was complete.`));
        });
      },
    );
    request.on('error', reject);
    request.end(init.body);
  });
}

/**
 * fetch, for an address a user typed: https only, public hosts only, and no
 * redirect is followed, because a redirect is a second address nobody checked.
 * The request goes to the address that was checked.
 */
export async function publicFetch(url: URL, init: PublicRequest, options: HttpOptions = {}): Promise<Response> {
  if (!options.allowPrivate && url.protocol !== 'https:') throw new JobError('The address must start with https://.');
  const addresses = await publicAddresses(url.hostname.replace(/^\[|\]$/g, ''), options);
  if (options.fetchImpl) return options.fetchImpl(url, init);
  return pinnedRequest(url, init, addresses);
}

// ---------------------------------------------------------------------------
// HTTP: download from an https address
// ---------------------------------------------------------------------------

function authHeaders(connection: ConnectionSpec): Record<string, string> {
  const authType = String(connection.config.authType || 'NONE').toUpperCase();
  const secret = connection.secret || '';
  if (authType === 'NONE') return {};
  if (!secret) throw new JobError('This connection needs a stored credential.');
  if (authType === 'BEARER') return { authorization: `Bearer ${secret}` };
  if (authType === 'BASIC') {
    const username = String(connection.config.username || '');
    return { authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}` };
  }
  if (authType === 'HEADER') {
    const name = String(connection.config.headerName || '').trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new JobError('The connection needs a header name for its credential.');
    return { [name.toLowerCase()]: secret };
  }
  throw new JobError(`"${authType}" is not a sign-in method.`);
}

function nameFromResponse(response: Response, url: URL, fallback: string): string {
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const raw = match ? decodeURIComponent(match[1]) : decodeURIComponent(url.pathname.split('/').pop() || '');
  // Only the last path part, so a server cannot name a file into another folder.
  const clean = raw.split(/[\\/]/).pop()?.trim() || '';
  return clean || fallback;
}

export function httpConnector(connection: ConnectionSpec, options: HttpOptions = {}): Connector {
  const base = String(connection.config.baseUrl || '').trim();

  function address(path: string, now: Date): URL {
    let root: URL;
    let url: URL;
    try {
      root = new URL(base);
      url = new URL(fillDateTokens(path || '', now), root);
    } catch {
      throw new JobError('The connection address is not valid.');
    }
    // A feed path may not send the connection's credential to another host.
    if (url.origin !== root.origin) throw new JobError('The feed path points away from the connection address.');
    return url;
  }

  function request(url: URL, method: 'GET' | 'HEAD'): Promise<Response> {
    const headers = authHeaders(connection);
    // One byte past the limit is enough to know a file is too large.
    return publicFetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(60_000), maxBytes: MAX_FILE_BYTES + 1 }, options);
  }

  return {
    async check() {
      const url = address('', new Date());
      const response = await request(url, 'HEAD');
      if (response.status === 401 || response.status === 403) {
        throw new JobError(`${url.host} refused the sign-in (${response.status}).`);
      }
      if (response.status >= 500) throw new Error(`${url.host} answered with an error (${response.status}).`);
      return `${url.host} can be reached (${response.status}).`;
    },

    async list(feed, now) {
      const url = address(feed.path, now);
      return [{ name: decodeURIComponent(url.pathname.split('/').pop() || '') || `${feed.feedCode}.dat`, ref: url.toString() }];
    },

    async fetch(file) {
      const url = new URL(file.ref);
      const response = await request(url, 'GET');
      // Not published yet. The late-file check is what notices a file that never comes.
      if (response.status === 404) return null;
      if (response.status === 401 || response.status === 403) {
        throw new JobError(`${url.host} refused the sign-in (${response.status}).`);
      }
      if (!response.ok) throw new Error(`${url.host} answered ${response.status}.`);
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
        throw new JobError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new JobError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      const name = nameFromResponse(response, url, file.name);
      return { name, bytes, mediaType: mediaTypeFor(name, response.headers.get('content-type')) };
    },
  };
}

// ---------------------------------------------------------------------------
// SFTP: a folder on an SFTP server
// ---------------------------------------------------------------------------

/** The part of an SFTP client the connector uses. ssh2-sftp-client fits it. */
export interface SftpSession {
  connect(options: Record<string, unknown>): Promise<unknown>;
  list(path: string): Promise<Array<{ type: string; name: string; size: number }>>;
  get(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  mkdir(path: string, recursive?: boolean): Promise<unknown>;
  end(): Promise<unknown>;
}

export interface SftpOptions extends HttpOptions {
  /** Tests supply a stand-in. The default opens a real session. */
  createSession?: () => SftpSession;
}

/** The fingerprint OpenSSH prints for a host key: SHA256: then base64 without padding. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** A remote folder path. Absolute paths are allowed; ".." and odd characters are not. */
export function sftpFolder(...parts: string[]): string {
  const absolute = String(parts.find((part) => String(part || '').trim()) || '').trim().startsWith('/');
  const joined = safeFolder(...parts);
  return absolute ? `/${joined}` : joined || '.';
}

export function sftpConnector(connection: ConnectionSpec, options: SftpOptions = {}): Connector {
  const host = String(connection.config.host || '').trim();
  const port = Number(connection.config.port) || 22;
  const username = String(connection.config.username || '').trim();
  const authType = String(connection.config.authType || 'PASSWORD').toUpperCase();
  const pinned = String(connection.config.hostKey || '').trim();
  // Some servers only let us read. Then files stay where they are and the ledger alone stops repeats.
  const leave = String(connection.config.afterLoad || 'MOVE').toUpperCase() === 'LEAVE';
  let session: SftpSession | null = null;
  let seenFingerprint = '';

  async function open(): Promise<SftpSession> {
    if (session) return session;
    if (!host || !username) throw new JobError('The connection needs a host and a user name.');
    if (!connection.secret) throw new JobError('This connection needs a stored credential.');
    // Connect to the address that was checked, not to the name: a name looked up again could answer differently.
    // Empty only when private hosts are allowed, and then the name is used as it is.
    const [address] = await publicAddresses(host.replace(/^\[|\]$/g, ''), options);
    const created = options.createSession
      ? options.createSession()
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        (new (require('ssh2-sftp-client'))() as SftpSession);
    let refused = false;
    try {
      await created.connect({
        host: address || host,
        port,
        username,
        ...(authType === 'KEY' ? { privateKey: connection.secret } : { password: connection.secret }),
        readyTimeout: 30_000,
        retries: 0,
        // The server proves who it is with its host key. When one is pinned, anything else is refused.
        hostVerifier: (key: Buffer) => {
          seenFingerprint = hostKeyFingerprint(key);
          refused = Boolean(pinned) && seenFingerprint !== pinned;
          return !refused;
        },
      });
    } catch (error) {
      await created.end().catch(() => undefined);
      if (refused) {
        throw new JobError(`${host} presented a different host key (${seenFingerprint}) from the one saved for this connection. Nothing was sent.`);
      }
      const text = error instanceof Error ? error.message : String(error);
      if (/authentication|permission denied|parse.*key|private key/i.test(text)) throw new JobError(`${host} refused the sign-in.`);
      throw new Error(`${host} could not be reached: ${text}`);
    }
    session = created;
    return created;
  }

  const folderFor = (feed?: FeedSpec) => sftpFolder(String(connection.config.folder || ''), feed?.path || '');

  return {
    async check() {
      const folder = folderFor();
      const sftp = await open();
      try {
        await sftp.list(folder);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (/no such file/i.test(text)) throw new JobError(`${host} accepted the sign-in, but the folder ${folder} does not exist there.`);
        throw error;
      }
      const key = pinned ? 'Its host key matches the saved one.' : `Its host key is ${seenFingerprint}. Save that on the connection to pin it.`;
      return `${host} accepted the sign-in and ${folder} can be read. ${key}`;
    },

    async list(feed) {
      const folder = folderFor(feed);
      const entries = await (await open()).list(folder);
      return entries
        .filter((entry) => entry.type === '-' && matchesPattern(entry.name, feed.filePattern))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_FILES_PER_POLL)
        .map((entry) => ({ name: entry.name, ref: posix.join(folder, entry.name), size: Number(entry.size) || undefined }));
    },

    async fetch(file) {
      if (file.size && file.size > MAX_FILE_BYTES) {
        throw new JobError(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      let data: unknown;
      try {
        data = await (await open()).get(file.ref);
      } catch (error) {
        if (/no such file/i.test(error instanceof Error ? error.message : '')) return null;
        throw error;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      if (bytes.length > MAX_FILE_BYTES) throw new JobError(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      return { name: file.name, bytes, mediaType: mediaTypeFor(file.name) };
    },

    async settle(file, outcome, now) {
      const target = SETTLED_FOLDER[outcome];
      if (!target || leave) return;
      const sftp = await open();
      const folder = posix.join(posix.dirname(file.ref), target);
      const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      try {
        await sftp.mkdir(folder, true).catch(() => undefined);
        await sftp.rename(file.ref, posix.join(folder, `${stamp}_${file.name}`));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name} was handled but could not be moved to ${target}: ${text}. If this server is read-only, set the connection to leave files in place.`);
      }
    },

    async close() {
      const open = session;
      session = null;
      if (open) await open.end().catch(() => undefined);
    },
  };
}

export function buildConnector(supabase: SupabaseClient, connection: ConnectionSpec, options: SftpOptions = {}): Connector {
  if (connection.kind === 'STORAGE') return storageConnector(supabase, connection);
  if (connection.kind === 'HTTP') return httpConnector(connection, options);
  if (connection.kind === 'SFTP') return sftpConnector(connection, options);
  throw new JobError(`There is no connector for "${connection.kind}".`);
}
