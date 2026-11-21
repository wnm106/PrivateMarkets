import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fillDateTokens,
  isPublicAddress,
  pinnedLookup,
  pinnedRequest,
  publicAddresses,
  publicFetch,
  httpConnector,
  matchesPattern,
  mediaTypeFor,
  hostKeyFingerprint,
  safeFolder,
  sftpConnector,
  sftpFolder,
  storageConnector,
  type SftpSession,
  type ConnectionSpec,
  type Connector,
  type FileOutcome,
  type RemoteFile,
} from './connectors';
import { connectionCheckHandler, feedActivity, feedCheckHandler, feedPollHandler, lateFeeds, type LoadOutcome, type LoadRequest } from './feeds';
import { JobError, type JobRun } from './worker';

const NOW = new Date('2026-11-16T15:00:00Z');

function run(payload: Record<string, unknown> = {}, clientId = 'client-a'): JobRun {
  return { id: 'run-1', clientId, scheduleId: null, requestedBy: 'user-1', jobType: 'feed.poll', payload, attempts: 1, maxAttempts: 3 };
}

const connection = (overrides: Partial<ConnectionSpec> = {}): ConnectionSpec => ({
  id: 'conn-1',
  clientId: 'client-a',
  kind: 'HTTP',
  config: { baseUrl: 'https://files.example.com/packs/', authType: 'BEARER' },
  secret: 'tok',
  ...overrides,
});

describe('file helpers', () => {
  it('matches file-name patterns without regard to case', () => {
    expect(matchesPattern('NAV_2026-10.xlsx', 'nav_*.xlsx')).toBe(true);
    expect(matchesPattern('NAV_2026-10.xlsx.bak', 'nav_*.xlsx')).toBe(false);
    expect(matchesPattern('a.csv', 'a?csv')).toBe(true);
    expect(matchesPattern('anything.pdf', '')).toBe(true);
    expect(matchesPattern('report(1).csv', 'report(1).csv')).toBe(true);
  });

  it('fills date tokens from the run date', () => {
    expect(fillDateTokens('nav/{YYYY}/{MM}/positions_{YYYY}{MM}{DD}.csv', NOW)).toBe('nav/2026/11/positions_20261116.csv');
  });

  it('builds a folder path and refuses anything that could climb out of it', () => {
    expect(safeFolder('client-a', ' admin /nav', '')).toBe('client-a/admin/nav');
    expect(() => safeFolder('client-a', '../client-b')).toThrow(JobError);
    expect(() => safeFolder('client-a', 'nav/./x')).toThrow(JobError);
    expect(() => safeFolder('client-a', 'nav?x')).toThrow(JobError);
  });

  it('prefers a real content type and falls back to the extension', () => {
    expect(mediaTypeFor('a.csv', 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(mediaTypeFor('a.xlsx', 'application/octet-stream')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mediaTypeFor('a.unknown', null)).toBe('application/octet-stream');
  });
});

describe('isPublicAddress', () => {
  it('accepts public IPv4 and global IPv6, however IPv4 is carried', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '::ffff:93.184.216.34', '::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses every address that is not a host on the public internet', () => {
    const refused = [
      // IPv4: this network, private, carrier NAT, loopback, link-local (cloud metadata), protocol, benchmarking, documentation, 6to4 relay, multicast, reserved, broadcast
      '0.0.0.0', '0.1.2.3', '10.0.0.5', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.9.10', '169.254.169.254', '172.16.0.1', '172.31.255.254',
      '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.10', '198.18.0.1', '198.19.255.254', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
      '240.0.0.1', '255.255.255.255',
      // IPv6: unspecified, loopback, unique-local, link-local (with a zone too), multicast, documentation, discard, site-local
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'ff02::1', '2001:db8::1', '100::1', 'fec0::1',
      // IPv4 carried in IPv6: mapped (dotted and hex), compatible, NAT64, 6to4, Teredo, translated
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::127.0.0.1', '::7f00:1', '::a00:5',
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.5', '64:ff9b:1::1', '2002:7f00:1::1', '2002:a9fe:a9fe::', '2002:c0a8:101::5',
      '2001:0:4136:e378:8000:63bf:80ff:fffe', '2001:0:7f00:1::1', '::ffff:0:7f00:1',
      // Not an address at all
      'localhost', '', '127.1', '2130706433',
    ];
    for (const address of refused) expect(isPublicAddress(address), address).toBe(false);
  });
});

describe('publicAddresses and publicFetch', () => {
  const resolveTo = (...addresses: string[]) => ({ resolve: async () => addresses });

  it('returns the addresses a public host may be reached at', async () => {
    expect(await publicAddresses('files.example.com', resolveTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'))).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
  });

  it('refuses a private, loopback or link-local host, and one where any address is private', async () => {
    for (const address of ['10.0.0.5', '172.20.1.1', '192.168.1.10', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      await expect(publicAddresses('internal.example.com', resolveTo(address))).rejects.toThrow(/not a public address/);
    }
    await expect(publicAddresses('mixed.example.com', resolveTo('93.184.216.34', '10.0.0.1'))).rejects.toThrow(/not a public address/);
    await expect(publicAddresses('empty.example.com', resolveTo())).rejects.toThrow(/not a public address/);
  });

  it('refuses addresses written straight into the URL, however they are written', async () => {
    const fetchImpl = (async () => new Response('should not be reached')) as typeof fetch;
    for (const address of [
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:10.0.0.5]:8443/',
      'https://[64:ff9b::a9fe:a9fe]/',
      'https://[::127.0.0.1]/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://2130706433/',
      'https://0x7f.1/',
      'https://[2002:7f00:1::1]/',
    ]) {
      await expect(publicFetch(new URL(address), { method: 'GET', headers: {}, redirect: 'error' }, { fetchImpl }), address).rejects.toThrow(/not a public address/);
    }
    await expect(publicFetch(new URL('http://files.example.com/x'), { method: 'GET', headers: {}, redirect: 'error' }, { ...resolveTo('93.184.216.34'), fetchImpl })).rejects.toThrow(/https/);
  });

  it('looks the name up once, whatever it would answer the next time', async () => {
    let lookups = 0;
    // A name that answers with a public address first and a private one after: DNS rebinding.
    const resolve = async () => (lookups++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const fetchImpl = (async () => new Response('ok')) as typeof fetch;
    await publicFetch(new URL('https://rebind.example/x'), { method: 'GET', headers: {}, redirect: 'error' }, { resolve, fetchImpl });
    expect(lookups).toBe(1);
  });

  it('answers a connection\'s lookup with the checked addresses only', () => {
    const lookup = pinnedLookup(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const answers: unknown[] = [];
    lookup('rebind.example', { all: true }, (_error, addresses) => answers.push(addresses));
    lookup('rebind.example', {}, (_error, address, family) => answers.push([address, family]));
    expect(answers).toEqual([
      [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
      ['93.184.216.34', 4],
    ]);
  });
});

describe('pinnedRequest', () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ url?: string; host?: string }> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push({ url: request.url, host: request.headers.host });
      if (request.url === '/moved') {
        response.writeHead(302, { location: 'http://169.254.169.254/' });
        response.end();
      } else if (request.url === '/zipped') {
        response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/csv' });
        response.end(gzipSync('a,b\n1,2\n'));
      } else if (request.url === '/large') {
        response.writeHead(200);
        response.end(Buffer.alloc(64 * 1024, 120));
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`hello ${request.method}`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (path: string, extra: Partial<Parameters<typeof pinnedRequest>[1]> = {}) =>
    // .invalid never resolves, so reaching the server at all shows the name was not looked up.
    pinnedRequest(new URL(`http://files.invalid:${port}${path}`), { method: 'GET', headers: {}, redirect: 'error', ...extra }, ['127.0.0.1']);

  it('connects to the checked address and never looks the name up', async () => {
    const response = await get('/file');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello GET');
    expect(seen.at(-1)).toEqual({ url: '/file', host: `files.invalid:${port}` });
  });

  it('refuses a redirect, or hands it back when asked to', async () => {
    await expect(get('/moved')).rejects.toThrow(/redirect, which is not followed/);
    const manual = await get('/moved', { redirect: 'manual' });
    expect(manual.status).toBe(302);
  });

  it('decodes a compressed reply and stops reading past the limit', async () => {
    const zipped = await get('/zipped');
    expect(await zipped.text()).toBe('a,b\n1,2\n');
    expect(zipped.headers.get('content-encoding')).toBeNull();
    const large = await get('/large', { maxBytes: 1000 });
    expect((await large.arrayBuffer()).byteLength).toBeLessThan(64 * 1024);
  });
});

describe('httpConnector', () => {
  function withFetch(respond: (url: URL, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init: init || {} });
      return respond(new URL(String(input)), init || {});
    }) as typeof fetch;
    return { calls, options: { fetchImpl, resolve: async () => ['93.184.216.34'] } };
  }

  it('builds the address from the base, the path and the run date, and sends the credential', async () => {
    const { calls, options } = withFetch(() => new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv' } }));
    const connector = httpConnector(connection(), options);
    const [file] = await connector.list({ feedCode: 'NAV', path: 'nav_{YYYY}{MM}{DD}.csv', filePattern: '*' }, NOW);
    expect(file).toEqual({ name: 'nav_20261116.csv', ref: 'https://files.example.com/packs/nav_20261116.csv' });
    const fetched = await connector.fetch(file);
    expect(fetched?.bytes.toString()).toBe('a,b\n1,2\n');
    expect(fetched?.mediaType).toBe('text/csv');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[0].init.redirect).toBe('error');
  });

  it('takes the file name from the response, without any folder part', async () => {
    const { options } = withFetch(() => new Response('x', { headers: { 'content-disposition': 'attachment; filename="../../etc/Pack Oct.xlsx"' } }));
    const fetched = await httpConnector(connection(), options).fetch({ name: 'download', ref: 'https://files.example.com/packs/download' });
    expect(fetched?.name).toBe('Pack Oct.xlsx');
  });

  it('treats 404 as not published yet and a refused sign-in as final', async () => {
    const missing = withFetch(() => new Response('', { status: 404 }));
    expect(await httpConnector(connection(), missing.options).fetch({ name: 'x', ref: 'https://files.example.com/x' })).toBeNull();
    const refused = withFetch(() => new Response('', { status: 401 }));
    await expect(httpConnector(connection(), refused.options).fetch({ name: 'x', ref: 'https://files.example.com/x' })).rejects.toBeInstanceOf(JobError);
    const broken = withFetch(() => new Response('', { status: 503 }));
    const failure = await httpConnector(connection(), broken.options).fetch({ name: 'x', ref: 'https://files.example.com/x' }).catch((error) => error);
    expect(failure).not.toBeInstanceOf(JobError);
  });

  it('supports basic and header sign-in and needs a credential when one is expected', async () => {
    const basic = withFetch(() => new Response('x'));
    await httpConnector(connection({ config: { baseUrl: 'https://files.example.com/', authType: 'BASIC', username: 'ops' } }), basic.options)
      .fetch({ name: 'x', ref: 'https://files.example.com/x' });
    expect((basic.calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('ops:tok').toString('base64')}`);

    const header = withFetch(() => new Response('x'));
    await httpConnector(connection({ config: { baseUrl: 'https://files.example.com/', authType: 'HEADER', headerName: 'X-Api-Key' } }), header.options)
      .fetch({ name: 'x', ref: 'https://files.example.com/x' });
    expect((header.calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('tok');

    const none = withFetch(() => new Response('x'));
    await expect(httpConnector(connection({ secret: null }), none.options).fetch({ name: 'x', ref: 'https://files.example.com/x' })).rejects.toThrow(/stored credential/);
    expect(none.calls).toHaveLength(0);
  });

  it('refuses a feed path that points at another host', async () => {
    const { options } = withFetch(() => new Response('x'));
    const connector = httpConnector(connection(), options);
    for (const path of ['https://elsewhere.example.com/x', '//elsewhere.example.com/x', '\\\\elsewhere.example.com\\x']) {
      await expect(connector.list({ feedCode: 'NAV', path, filePattern: '*' }, NOW)).rejects.toThrow(/points away/);
    }
  });

  it('never calls a private address', async () => {
    const { calls, options } = withFetch(() => new Response('x'));
    const connector = httpConnector(connection({ config: { baseUrl: 'https://intranet.example.com/', authType: 'NONE' } }), { ...options, resolve: async () => ['10.1.2.3'] });
    await expect(connector.check()).rejects.toThrow(/not a public address/);
    expect(calls).toHaveLength(0);
  });
});

describe('storageConnector', () => {
  function fakeStorage(entries: Array<{ name: string; id: string | null; size?: number }>) {
    const calls: Array<[string, ...unknown[]]> = [];
    const bucket = {
      async list(folder: string) {
        calls.push(['list', folder]);
        return { data: entries.map((entry) => ({ name: entry.name, id: entry.id, metadata: entry.size ? { size: entry.size } : null })), error: null };
      },
      async download(path: string) {
        calls.push(['download', path]);
        return { data: new Blob([`content of ${path}`], { type: 'text/csv' }), error: null };
      },
      async move(from: string, to: string) {
        calls.push(['move', from, to]);
        return { data: {}, error: null };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = { storage: { from: (name: string) => (calls.push(['bucket', name]), bucket) } } as any;
    return { supabase, calls };
  }
  const storage = connection({ kind: 'STORAGE', config: { folder: 'admin' }, secret: null });
  const feed = { feedCode: 'NAV', path: 'nav', filePattern: 'NAV_*.csv' };

  it('lists matching files in the client folder and skips subfolders', async () => {
    const { supabase, calls } = fakeStorage([
      { name: 'NAV_oct.csv', id: '1', size: 120 },
      { name: 'notes.txt', id: '2' },
      { name: 'processed', id: null },
      { name: '.emptyFolderPlaceholder', id: '3' },
    ]);
    const files = await storageConnector(supabase, storage).list(feed, NOW);
    expect(files).toEqual([{ name: 'NAV_oct.csv', ref: 'client-a/admin/nav/NAV_oct.csv', size: 120 }]);
    expect(calls).toContainEqual(['bucket', 'feed-inbox']);
    expect(calls).toContainEqual(['list', 'client-a/admin/nav']);
  });

  it('cannot be pointed outside the client folder', async () => {
    const { supabase } = fakeStorage([]);
    const escaping = connection({ kind: 'STORAGE', config: { folder: '../client-b' }, secret: null });
    await expect(storageConnector(supabase, escaping).list(feed, NOW)).rejects.toBeInstanceOf(JobError);
  });

  it('moves a handled file out of the inbox and leaves a failed one for the next poll', async () => {
    const { supabase, calls } = fakeStorage([]);
    const connector = storageConnector(supabase, storage);
    const file: RemoteFile = { name: 'NAV_oct.csv', ref: 'client-a/admin/nav/NAV_oct.csv' };
    await connector.settle?.(file, 'LOADED', NOW);
    await connector.settle?.(file, 'NEEDS_REVIEW', NOW);
    await connector.settle?.(file, 'GAVE_UP', NOW);
    await connector.settle?.(file, 'FAILED', NOW);
    expect(calls.filter((call) => call[0] === 'move').map((call) => call[2])).toEqual([
      'client-a/admin/nav/processed/20261116T150000_NAV_oct.csv',
      'client-a/admin/nav/review/20261116T150000_NAV_oct.csv',
      'client-a/admin/nav/failed/20261116T150000_NAV_oct.csv',
    ]);
  });

  it('refuses a file over the size limit before downloading it', async () => {
    const { supabase, calls } = fakeStorage([]);
    await expect(storageConnector(supabase, storage).fetch({ name: 'big.csv', ref: 'client-a/admin/big.csv', size: 30 * 1024 * 1024 })).rejects.toThrow(/larger than 25 MB/);
    expect(calls.some((call) => call[0] === 'download')).toBe(false);
  });
});

describe('sftpConnector', () => {
  const HOST_KEY = Buffer.from('a server host key');
  const sftp = (config: Record<string, unknown> = {}, secret: string | null = 'pw'): ConnectionSpec =>
    connection({ kind: 'SFTP', secret, config: { host: 'sftp.example.com', port: 22, username: 'feeds', folder: '/outbound', authType: 'PASSWORD', ...config } });

  function fakeServer(entries: Array<{ type: string; name: string; size: number }> = [], behaviour: { rejectConnect?: string; readOnly?: boolean } = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    let sessions = 0;
    const createSession = (): SftpSession => {
      sessions += 1;
      return {
        async connect(options) {
          calls.push(['connect', { ...options, hostVerifier: undefined }]);
          const accepted = (options.hostVerifier as (key: Buffer) => boolean)(HOST_KEY);
          if (!accepted) throw new Error('Handshake failed: host verification');
          if (behaviour.rejectConnect) throw new Error(behaviour.rejectConnect);
        },
        async list(path) {
          calls.push(['list', path]);
          return entries;
        },
        async get(path) {
          calls.push(['get', path]);
          if (path.endsWith('gone.csv')) throw new Error('get: No such file');
          return Buffer.from(`content of ${path}`);
        },
        async rename(from, to) {
          if (behaviour.readOnly) throw new Error('rename: Permission denied');
          calls.push(['rename', from, to]);
        },
        async mkdir(path) {
          calls.push(['mkdir', path]);
        },
        async end() {
          calls.push(['end']);
        },
      };
    };
    const options = { createSession, resolve: async () => ['93.184.216.34'] };
    return { calls, options, sessions: () => sessions };
  }
  const feed = { feedCode: 'NAV', path: 'nav', filePattern: 'NAV_*.csv' };

  it('builds remote folders, keeping a leading slash', () => {
    expect(sftpFolder('/outbound', 'nav')).toBe('/outbound/nav');
    expect(sftpFolder('outbound', '')).toBe('outbound');
    expect(sftpFolder('', '')).toBe('.');
    expect(() => sftpFolder('/outbound', '../etc')).toThrow(JobError);
  });

  it('lists matching files, fetches one, and uses a single session', async () => {
    const server = fakeServer([
      { type: '-', name: 'NAV_oct.csv', size: 10 },
      { type: 'd', name: 'processed', size: 0 },
      { type: '-', name: 'notes.txt', size: 3 },
      { type: '-', name: 'NAV_nov.csv', size: 12 },
    ]);
    const connector = sftpConnector(sftp(), server.options);
    const files = await connector.list(feed, NOW);
    expect(files).toEqual([
      { name: 'NAV_nov.csv', ref: '/outbound/nav/NAV_nov.csv', size: 12 },
      { name: 'NAV_oct.csv', ref: '/outbound/nav/NAV_oct.csv', size: 10 },
    ]);
    const fetched = await connector.fetch(files[0]);
    expect(fetched?.bytes.toString()).toBe('content of /outbound/nav/NAV_nov.csv');
    expect(fetched?.mediaType).toBe('text/csv');
    expect(await connector.fetch({ name: 'gone.csv', ref: '/outbound/nav/gone.csv' })).toBeNull();
    expect(server.sessions()).toBe(1);
    // The address that was checked, not the name, which could answer differently by the time the session connects.
    expect(server.calls[0]).toEqual(['connect', expect.objectContaining({ host: '93.184.216.34', port: 22, username: 'feeds', password: 'pw' })]);
    await connector.close?.();
    expect(server.calls.at(-1)).toEqual(['end']);
  });

  it('signs in with a private key when the connection uses one', async () => {
    const server = fakeServer();
    await sftpConnector(sftp({ authType: 'KEY' }, '-----BEGIN KEY-----'), server.options).list(feed, NOW);
    const sent = server.calls[0][1] as Record<string, unknown>;
    expect(sent.privateKey).toBe('-----BEGIN KEY-----');
    expect(sent.password).toBeUndefined();
  });

  it('reports the host key on a check and accepts it once pinned', async () => {
    const fingerprint = hostKeyFingerprint(HOST_KEY);
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const open = fakeServer();
    expect(await sftpConnector(sftp(), open.options).check()).toContain(`Its host key is ${fingerprint}`);
    const pinned = fakeServer();
    expect(await sftpConnector(sftp({ hostKey: fingerprint }), pinned.options).check()).toMatch(/matches the saved one/);
  });

  it('refuses a server whose host key is not the pinned one', async () => {
    const server = fakeServer();
    const failure = await sftpConnector(sftp({ hostKey: `SHA256:${'A'.repeat(43)}` }), server.options).check().catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(failure.message).toMatch(/different host key/);
    expect(server.calls.at(-1)).toEqual(['end']);
  });

  it('does not retry a refused sign-in, and does retry a server that cannot be reached', async () => {
    const refused = await sftpConnector(sftp(), fakeServer([], { rejectConnect: 'All configured authentication methods failed' }).options).check().catch((error) => error);
    expect(refused).toBeInstanceOf(JobError);
    const down = await sftpConnector(sftp(), fakeServer([], { rejectConnect: 'connect ECONNREFUSED' }).options).check().catch((error) => error);
    expect(down).toBeInstanceOf(Error);
    expect(down).not.toBeInstanceOf(JobError);
  });

  it('never connects to a private address or without a credential', async () => {
    const server = fakeServer();
    await expect(sftpConnector(sftp(), { ...server.options, resolve: async () => ['10.0.0.8'] }).check()).rejects.toThrow(/not a public address/);
    await expect(sftpConnector(sftp({}, null), server.options).check()).rejects.toThrow(/stored credential/);
    expect(server.sessions()).toBe(0);
  });

  it('moves handled files, leaves them when told to, and explains a read-only server', async () => {
    const file: RemoteFile = { name: 'NAV_oct.csv', ref: '/outbound/nav/NAV_oct.csv' };
    const moving = fakeServer();
    await sftpConnector(sftp(), moving.options).settle?.(file, 'LOADED', NOW);
    expect(moving.calls).toContainEqual(['mkdir', '/outbound/nav/processed']);
    expect(moving.calls).toContainEqual(['rename', '/outbound/nav/NAV_oct.csv', '/outbound/nav/processed/20261116T150000_NAV_oct.csv']);

    const leaving = fakeServer();
    await sftpConnector(sftp({ afterLoad: 'LEAVE' }), leaving.options).settle?.(file, 'LOADED', NOW);
    expect(leaving.sessions()).toBe(0);

    const readOnly = fakeServer([], { readOnly: true });
    await expect(sftpConnector(sftp(), readOnly.options).settle?.(file, 'LOADED', NOW)).rejects.toThrow(/leave files in place/);
  });
});

// ---------------------------------------------------------------------------
// feed.poll against a ledger held in memory
// ---------------------------------------------------------------------------

function pollSetup(options: {
  files: Array<{ name: string; content: string | null }>;
  load?: (request: LoadRequest) => Promise<LoadOutcome>;
  feed?: Record<string, unknown>;
  connectionActive?: boolean;
}) {
  const ledger = new Map<string, { id: string; status: string; attempts: number }>();
  const finished: Array<Record<string, unknown>> = [];
  const settled: Array<[string, FileOutcome]> = [];
  const loads: LoadRequest[] = [];
  const activity: Array<Record<string, unknown>> = [];
  let polled = 0;
  const supabase = {
    async rpc(fn: string, args: Record<string, any>) {
      if (fn === 'feed_poll_context') {
        return {
          data: {
            feed: { id: 'feed-1', client_id: 'client-a', feed_code: 'NAV', feed_name: 'NAV pack', path: 'nav', file_pattern: '*', map_code: 'NAV_MAP', source_code: 'ADMIN', is_active: true, ...options.feed },
            connection: { id: 'conn-1', client_id: 'client-a', kind: 'STORAGE', config: {}, is_active: options.connectionActive ?? true },
            secret: null,
          },
          error: null,
        };
      }
      if (fn === 'feed_file_begin') {
        const existing = ledger.get(args.p_sha256);
        if (!existing) {
          const row = { id: `file-${ledger.size + 1}`, status: 'LOADING', attempts: 1 };
          ledger.set(args.p_sha256, row);
          return { data: { ...row, action: 'LOAD' }, error: null };
        }
        if (existing.status === 'FAILED' && existing.attempts < 3) {
          existing.status = 'LOADING';
          existing.attempts += 1;
          return { data: { ...existing, action: 'LOAD' }, error: null };
        }
        return { data: { ...existing, action: 'SKIP' }, error: null };
      }
      if (fn === 'feed_file_finish') {
        finished.push(args);
        for (const row of ledger.values()) if (row.id === args.p_id) row.status = args.p_status;
        return { data: null, error: null };
      }
      if (fn === 'feed_polled') {
        polled += 1;
        return { data: null, error: null };
      }
      if (fn === 'activity_record') {
        activity.push(args);
        return { data: 'event-1', error: null };
      }
      return { data: null, error: { message: `unexpected ${fn}` } };
    },
  };
  const connector: Connector = {
    check: async () => 'ok',
    list: async () => options.files.map((file) => ({ name: file.name, ref: `inbox/${file.name}` })),
    fetch: async (file) => {
      const found = options.files.find((item) => item.name === file.name);
      return found && found.content !== null ? { name: found.name, bytes: Buffer.from(found.content), mediaType: 'text/csv' } : null;
    },
    settle: async (file, outcome) => {
      settled.push([file.name, outcome]);
    },
  };
  const loadFile = async (request: LoadRequest) => {
    loads.push(request);
    return options.load ? options.load(request) : { status: 'LOADED' as const, importInstanceId: 'imp-1', created: 4, matched: 6 };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = feedPollHandler({ supabase: supabase as any, loadFile, now: () => NOW, connectorFor: () => connector });
  return { handler, ledger, finished, settled, loads, activity, polled: () => polled };
}

describe('feedActivity', () => {
  it('names a load, a file waiting for review, and a failure, and skips a duplicate', () => {
    expect(feedActivity('NAV pack', 'nav.csv', 'LOADED')).toEqual({ kind: 'FEED_LOADED', summary: 'NAV pack: loaded nav.csv.' });
    expect(feedActivity('NAV pack', 'odd.csv', 'NEEDS_REVIEW', 'Missing NAV.')?.summary).toMatch(/waiting for review\. Missing NAV\./);
    expect(feedActivity('NAV pack', 'bad.csv', 'GAVE_UP', 'Row 3 has no identifier')?.kind).toBe('FEED_FAILED');
    expect(feedActivity('NAV pack', 'nav.csv', 'DUPLICATE')).toBeNull();
  });
});

describe('feedPollHandler', () => {
  it('loads a new file through the feed map and records it', async () => {
    const setup = pollSetup({ files: [{ name: 'nav.csv', content: 'a,b\n1,2' }] });
    const result = await setup.handler(run({ feedId: 'feed-1' }));
    expect(result).toMatchObject({ feed: 'NAV', files: 1, loaded: 1, duplicates: 0, needsReview: 0, failed: 0 });
    expect(setup.loads[0]).toMatchObject({ clientId: 'client-a', mapCode: 'NAV_MAP', sourceCode: 'ADMIN', fileName: 'nav.csv', mediaType: 'text/csv' });
    expect(setup.finished[0]).toMatchObject({ p_status: 'LOADED', p_import_instance_id: 'imp-1', p_rows_created: 4, p_rows_matched: 6 });
    expect(setup.settled).toEqual([['nav.csv', 'LOADED']]);
    expect(setup.polled()).toBe(1);
    expect(setup.activity[0]).toMatchObject({ p_kind: 'FEED_LOADED', p_subject_id: 'feed-1', p_summary: 'NAV pack: loaded nav.csv.' });
  });

  it('does not load the same content twice, even under another name', async () => {
    const setup = pollSetup({ files: [{ name: 'nav.csv', content: 'same' }, { name: 'nav-copy.csv', content: 'same' }] });
    const result = await setup.handler(run({ feedId: 'feed-1' }));
    expect(result).toMatchObject({ files: 2, loaded: 1, duplicates: 1 });
    expect(setup.loads).toHaveLength(1);
    expect(setup.settled).toEqual([['nav.csv', 'LOADED'], ['nav-copy.csv', 'DUPLICATE']]);

    const again = await setup.handler(run({ feedId: 'feed-1' }));
    expect(again).toMatchObject({ loaded: 0, duplicates: 2 });
    expect(setup.loads).toHaveLength(1);
  });

  it('skips a file that is not there yet', async () => {
    const setup = pollSetup({ files: [{ name: 'nav.csv', content: null }] });
    expect(await setup.handler(run({ feedId: 'feed-1' }))).toMatchObject({ files: 0, loaded: 0 });
    expect(setup.settled).toEqual([]);
  });

  it('loads the good files, then fails the run when one needs review', async () => {
    const setup = pollSetup({
      files: [{ name: 'good.csv', content: 'good' }, { name: 'odd.csv', content: 'odd' }],
      load: async (request) =>
        request.fileName === 'odd.csv'
          ? { status: 'NEEDS_REVIEW', importInstanceId: 'imp-2', message: 'This file is missing NAV from map NAV_MAP. It is waiting in Load data.' }
          : { status: 'LOADED', importInstanceId: 'imp-1', created: 1, matched: 0 },
    });
    const failure = await setup.handler(run({ feedId: 'feed-1' })).catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(failure.message).toMatch(/NAV pack: 1 loaded, 1 waiting for review, 0 failed\. odd\.csv: This file is missing NAV/);
    expect(setup.settled).toEqual([['good.csv', 'LOADED'], ['odd.csv', 'NEEDS_REVIEW']]);
    expect(setup.polled()).toBe(1);
  });

  it('tries a failed file on the next two polls, then sets it aside', async () => {
    const setup = pollSetup({
      files: [{ name: 'bad.csv', content: 'bad' }],
      load: async () => {
        throw new Error('Row 3 has no identifier');
      },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failure = await setup.handler(run({ feedId: 'feed-1' })).catch((error) => error);
      expect(failure.message).toMatch(/bad\.csv: Row 3 has no identifier/);
    }
    expect(setup.loads).toHaveLength(3);
    expect(setup.settled.map((item) => item[1])).toEqual(['FAILED', 'FAILED', 'FAILED']);

    const final = await setup.handler(run({ feedId: 'feed-1' })).catch((error) => error);
    expect(final).toBeInstanceOf(JobError);
    expect(setup.loads).toHaveLength(3);
    expect(setup.settled.at(-1)).toEqual(['bad.csv', 'GAVE_UP']);
  });

  it('refuses a paused feed, a paused connection and another client\'s feed', async () => {
    await expect(pollSetup({ files: [], feed: { is_active: false } }).handler(run({ feedId: 'feed-1' }))).rejects.toThrow(/feed is paused/);
    await expect(pollSetup({ files: [], connectionActive: false }).handler(run({ feedId: 'feed-1' }))).rejects.toThrow(/connection is paused/);
    await expect(pollSetup({ files: [] }).handler(run({ feedId: 'feed-1' }, 'client-b'))).rejects.toThrow(/another client/);
    await expect(pollSetup({ files: [] }).handler(run({}))).rejects.toThrow(/no feedId/);
  });
});

describe('lateFeeds', () => {
  const feed = (overrides: Record<string, unknown>) => ({
    feed_code: 'NAV', feed_name: 'NAV pack', expected_cron: '0 9 * * 1-5', expected_timezone: 'America/New_York', grace_minutes: 120,
    last_received_at: null, created_at: '2026-11-01T00:00:00Z', ...overrides,
  });

  it('is late once the next expected time plus the grace period has passed', () => {
    // Last file Friday 13 November. Next expected Monday 16 November 09:00 New York (14:00 UTC), grace until 16:00 UTC.
    const row = feed({ last_received_at: '2026-11-13T14:30:00Z' });
    expect(lateFeeds([row], new Date('2026-11-16T15:59:00Z'))).toEqual([]);
    expect(lateFeeds([row], new Date('2026-11-16T16:01:00Z'))).toEqual([
      { feed: 'NAV', name: 'NAV pack', expectedAt: '2026-11-16T14:00:00.000Z', lastReceivedAt: '2026-11-13T14:30:00Z' },
    ]);
  });

  it('is not late when today\'s file already arrived', () => {
    expect(lateFeeds([feed({ last_received_at: '2026-11-16T14:20:00Z' })], new Date('2026-11-16T20:00:00Z'))).toEqual([]);
  });

  it('counts from when the feed was created if nothing has ever arrived', () => {
    expect(lateFeeds([feed({ created_at: '2026-11-16T12:00:00Z' })], new Date('2026-11-16T15:00:00Z'))).toEqual([]);
    expect(lateFeeds([feed({ created_at: '2026-11-16T12:00:00Z' })], new Date('2026-11-16T17:00:00Z'))).toHaveLength(1);
  });
});

describe('feedCheckHandler and connectionCheckHandler', () => {
  it('passes when nothing is late and names the feeds that are', async () => {
    const rows = [{ feed_code: 'NAV', feed_name: 'NAV pack', expected_cron: '0 9 * * 1-5', expected_timezone: 'UTC', grace_minutes: 60, last_received_at: '2026-11-13T09:10:00Z', created_at: '2026-11-01T00:00:00Z' }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = { rpc: async () => ({ data: rows, error: null }) } as any;
    expect(await feedCheckHandler({ supabase, now: () => new Date('2026-11-16T09:30:00Z') })(run())).toEqual({ checked: 1, late: 0 });
    const failure = await feedCheckHandler({ supabase, now: () => new Date('2026-11-16T10:30:00Z') })(run()).catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(failure.message).toBe('1 of 1 feeds are late: NAV pack (expected 2026-11-16 09:00 UTC).');
  });

  it('records the outcome of a connection check either way', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'feed_connection_context') return { data: { connection: { id: 'conn-1', client_id: 'client-a', kind: 'HTTP', config: {} }, secret: 's' }, error: null };
        recorded.push(args);
        return { data: null, error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const good = connectionCheckHandler({ supabase, connectorFor: () => ({ check: async () => 'files.example.com can be reached (200).' }) as Connector });
    expect(await good(run({ connectionId: 'conn-1' }))).toEqual({ ok: true, message: 'files.example.com can be reached (200).' });
    const bad = connectionCheckHandler({ supabase, connectorFor: () => ({ check: async () => { throw new Error('files.example.com could not be found.'); } }) as unknown as Connector });
    await expect(bad(run({ connectionId: 'conn-1' }))).rejects.toThrow(/could not be found/);
    expect(recorded.map((item) => item.p_ok)).toEqual([true, false]);
    await expect(good(run({ connectionId: 'conn-1' }, 'client-b'))).rejects.toThrow(/another client/);
  });
});
