import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  const host = url.hostname.replace(/^\[|\]$/g, '');
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

export function buildConnector(supabase: SupabaseClient, connection: ConnectionSpec, options: HttpOptions = {}): Connector {
  if (connection.kind === 'STORAGE') return storageConnector(supabase, connection);
  if (connection.kind === 'HTTP') return httpConnector(connection, options);
  throw new JobError(`There is no connector for "${connection.kind}".`);
}
