import { describe, expect, it } from 'vitest';
import {
  assertPublicAddress,
  fillDateTokens,
  httpConnector,
  matchesPattern,
  mediaTypeFor,
  safeFolder,
  storageConnector,
  type ConnectionSpec,
  type Connector,
  type FileOutcome,
  type RemoteFile,
} from './connectors';
import { connectionCheckHandler, feedCheckHandler, feedPollHandler, lateFeeds, type LoadOutcome, type LoadRequest } from './feeds';
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

describe('assertPublicAddress', () => {
  const resolveTo = (...addresses: string[]) => ({ resolve: async () => addresses });

  it('accepts a public https host', async () => {
    await expect(assertPublicAddress(new URL('https://files.example.com/x'), resolveTo('93.184.216.34'))).resolves.toBeUndefined();
  });

  it('refuses http, private, loopback and link-local addresses', async () => {
    await expect(assertPublicAddress(new URL('http://files.example.com/x'), resolveTo('93.184.216.34'))).rejects.toThrow(/https/);
    for (const address of ['10.0.0.5', '172.20.1.1', '192.168.1.10', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      await expect(assertPublicAddress(new URL('https://internal.example.com/x'), resolveTo(address))).rejects.toThrow(/not a public address/);
    }
    await expect(assertPublicAddress(new URL('https://169.254.169.254/latest/meta-data'))).rejects.toThrow(/not a public address/);
  });

  it('refuses a host where any address is private', async () => {
    await expect(assertPublicAddress(new URL('https://mixed.example.com/x'), resolveTo('93.184.216.34', '10.0.0.1'))).rejects.toThrow(/not a public address/);
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
  return { handler, ledger, finished, settled, loads, polled: () => polled };
}

describe('feedPollHandler', () => {
  it('loads a new file through the feed map and records it', async () => {
    const setup = pollSetup({ files: [{ name: 'nav.csv', content: 'a,b\n1,2' }] });
    const result = await setup.handler(run({ feedId: 'feed-1' }));
    expect(result).toMatchObject({ feed: 'NAV', files: 1, loaded: 1, duplicates: 0, needsReview: 0, failed: 0 });
    expect(setup.loads[0]).toMatchObject({ clientId: 'client-a', mapCode: 'NAV_MAP', sourceCode: 'ADMIN', fileName: 'nav.csv', mediaType: 'text/csv' });
    expect(setup.finished[0]).toMatchObject({ p_status: 'LOADED', p_import_instance_id: 'imp-1', p_rows_created: 4, p_rows_matched: 6 });
    expect(setup.settled).toEqual([['nav.csv', 'LOADED']]);
    expect(setup.polled()).toBe(1);
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
