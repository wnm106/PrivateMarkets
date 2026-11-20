import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
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
 *   EMAIL    attachments from mail sent to the connection's address, once
 *            email.screen has accepted them (see email.ts)
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
// EMAIL: attachments that screening accepted
// ---------------------------------------------------------------------------

/** Under a client's folder: <client>/_email/<connection>/ holds accepted attachments, raw/ the messages. */
export const EMAIL_FOLDER = '_email';

/** Where accepted attachments of an email connection wait for its feeds. */
export function emailInbox(clientId: string, connectionId: string): string {
  return safeFolder(clientId, EMAIL_FOLDER, connectionId);
}

/**
 * Stored attachment names start with eight hex characters from the message
 * id, so two messages can send a file of the same name. Feeds match, and the
 * ledger records, the name the sender gave.
 */
const STORED_PREFIX = /^[0-9a-f]{8}_/;

export function emailConnector(supabase: SupabaseClient, connection: ConnectionSpec): Connector {
  const bucket = supabase.storage.from(FEED_BUCKET);
  const root = emailInbox(connection.clientId, connection.id);

  return {
    async check() {
      const { error } = await bucket.list(root, { limit: 1 });
      if (error) throw new Error(error.message);
      return 'The email inbox can be read. Mail is screened as it arrives; see Inbound email for each message.';
    },

    async list(feed) {
      const { data, error } = await bucket.list(root, { limit: 200, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(error.message);
      return (data || [])
        .filter((entry) => entry.id && STORED_PREFIX.test(entry.name))
        .map((entry) => ({ stored: entry.name, name: entry.name.replace(STORED_PREFIX, ''), size: Number((entry.metadata as { size?: number } | null)?.size) || undefined }))
        .filter((entry) => entry.name && matchesPattern(entry.name, feed.filePattern))
        .slice(0, MAX_FILES_PER_POLL)
        .map((entry) => ({ name: entry.name, ref: `${root}/${entry.stored}`, size: entry.size }));
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
      return { name: file.name, bytes: Buffer.from(await data.arrayBuffer()), mediaType: mediaTypeFor(file.name, data.type) };
    },

    async settle(file, outcome, now) {
      const target = SETTLED_FOLDER[outcome];
      if (!target) return;
      const stored = posix.basename(file.ref);
      const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      const { error } = await bucket.move(file.ref, `${root}/${target}/${stamp}_${stored}`);
      if (error) throw new Error(`${file.name} was handled but could not be moved to ${target}: ${error.message}`);
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP: download from an https address
// ---------------------------------------------------------------------------

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8')
    || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: allow http and private addresses. */
  allowPrivate?: boolean;
}

/**
 * The worker sits inside the network, so an address a user typed must not be
 * able to reach internal services: https only, and no private, loopback or
 * link-local hosts. Redirects are refused for the same reason.
 */
export async function assertPublicAddress(url: URL, options: HttpOptions = {}): Promise<void> {
  if (options.allowPrivate) return;
  if (url.protocol !== 'https:') throw new JobError('The address must start with https://.');
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''), options);
}

/** Refuses a host that is, or resolves to, a private, loopback or link-local address. */
export async function assertPublicHost(host: string, options: HttpOptions = {}): Promise<void> {
  if (options.allowPrivate) return;
  const resolve = options.resolve || (async (name: string) => (await lookup(name, { all: true })).map((entry) => entry.address));
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new Error(`${host} could not be found.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new JobError(`${host} is not a public address.`);
  }
}

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
  const doFetch = options.fetchImpl || fetch;
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

  async function request(url: URL, method: 'GET' | 'HEAD'): Promise<Response> {
    await assertPublicAddress(url, options);
    return doFetch(url, {
      method,
      headers: authHeaders(connection),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
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
    await assertPublicHost(host, options);
    const created = options.createSession
      ? options.createSession()
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        (new (require('ssh2-sftp-client'))() as SftpSession);
    let refused = false;
    try {
      await created.connect({
        host,
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
  if (connection.kind === 'EMAIL') return emailConnector(supabase, connection);
  throw new JobError(`There is no connector for "${connection.kind}".`);
}
