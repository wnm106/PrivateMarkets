import { describe, expect, it } from 'vitest';
import { excelSessionMessage, parseExcelSessionMessage, type ExcelSession } from '@tapestrai/graphql/src/lib/excel-session';
import { browserStore, ExcelAuth, pageStorage, SESSION_KEY } from './auth';

const NOW = Date.UTC(2026, 10, 21, 12);

function session(overrides: Partial<ExcelSession> = {}): ExcelSession {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW / 1000 + 3600,
    userId: 'user-1',
    email: 'analyst@example.com',
    supabaseUrl: 'https://project.supabase.co',
    anonKey: 'anon',
    ...overrides,
  };
}

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('the sign-in message', () => {
  it('round-trips a session', () => {
    expect(parseExcelSessionMessage(excelSessionMessage(session()))).toEqual(session());
  });

  it('carries the client the sign-in chose, for the pane to show', () => {
    const chosen = parseExcelSessionMessage(excelSessionMessage(session({ clientName: 'Acme Capital' })));
    expect(chosen?.clientName).toBe('Acme Capital');
    expect(parseExcelSessionMessage(excelSessionMessage(session({ clientName: '  ' })))).toEqual(session());

    const auth = new ExcelAuth(browserStore(undefined));
    auth.accept(session());
    expect(auth.clientName()).toBeNull();
    auth.accept(session({ clientName: 'Acme Capital' }));
    expect(auth.clientName()).toBe('Acme Capital');
  });

  it('ignores other messages and refuses a non-https project', () => {
    expect(parseExcelSessionMessage('hello')).toBeNull();
    expect(parseExcelSessionMessage(JSON.stringify({ type: 'other', version: 1, session: session() }))).toBeNull();
    expect(parseExcelSessionMessage(excelSessionMessage(session({ supabaseUrl: 'http://evil.example' })))).toBeNull();
    expect(parseExcelSessionMessage(excelSessionMessage(session({ refreshToken: '' })))).toBeNull();
  });
});

describe('ExcelAuth', () => {
  it('uses a token that has time left without asking', async () => {
    const { calls, fetchImpl } = fakeFetch([]);
    const auth = new ExcelAuth(browserStore(undefined), fetchImpl, () => NOW);
    auth.accept(session());
    expect(await auth.getAccessToken()).toBe('access-1');
    expect(calls).toHaveLength(0);
  });

  it('refreshes once for many callers and keeps the rotated refresh token', async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } }]);
    const store = browserStore(undefined);
    const auth = new ExcelAuth(store, fetchImpl, () => NOW);
    auth.accept(session({ expiresAt: NOW / 1000 + 30 }));
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://project.supabase.co/auth/v1/token?grant_type=refresh_token');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ refresh_token: 'refresh-1' });
    expect(calls[0].init?.credentials).toBe('omit');
    expect(JSON.parse(store.get(SESSION_KEY) as string)).toMatchObject({ refreshToken: 'refresh-2', expiresAt: NOW / 1000 + 3600 });
  });

  it('uses a refresh another workbook already made', async () => {
    const { calls, fetchImpl } = fakeFetch([]);
    const store = browserStore(undefined);
    const auth = new ExcelAuth(store, fetchImpl, () => NOW);
    auth.accept(session({ expiresAt: NOW / 1000 + 30 }));
    const stale = auth.session();
    store.set(SESSION_KEY, JSON.stringify(session({ accessToken: 'access-other', refreshToken: 'refresh-other' })));
    // Simulate this workbook having read the old session just before the other one refreshed.
    expect(await (auth as unknown as { refresh: (seen: unknown, forced: boolean) => Promise<string | null> }).refresh(stale, false)).toBe('access-other');
    expect(calls).toHaveLength(0);
  });

  it('signs out when the refresh token is refused', async () => {
    const { fetchImpl } = fakeFetch([{ status: 400, body: { error: 'invalid_grant' } }]);
    const auth = new ExcelAuth(browserStore(undefined), fetchImpl, () => NOW);
    let changes = 0;
    auth.onChange(() => { changes += 1; });
    auth.accept(session({ expiresAt: NOW / 1000 - 10 }));
    expect(await auth.getAccessToken()).toBeNull();
    expect(auth.session()).toBeNull();
    expect(changes).toBe(2);
  });

  it('stays signed in while offline if the token has not expired', async () => {
    const { fetchImpl } = fakeFetch([new TypeError('Failed to fetch')]);
    const auth = new ExcelAuth(browserStore(undefined), fetchImpl, () => NOW);
    auth.accept(session({ expiresAt: NOW / 1000 + 30 }));
    expect(await auth.getAccessToken()).toBe('access-1');
    expect(auth.session()).not.toBeNull();
  });

  it('revokes only this session on sign-out, and forgets it even offline', async () => {
    const { calls, fetchImpl } = fakeFetch([new TypeError('Failed to fetch')]);
    const auth = new ExcelAuth(browserStore(undefined), fetchImpl, () => NOW);
    auth.accept(session());
    await auth.signOut();
    expect(calls[0].url).toBe('https://project.supabase.co/auth/v1/logout?scope=local');
    expect(auth.session()).toBeNull();
  });
});

describe('storage the browser blocks', () => {
  it('falls back to memory instead of failing when reading localStorage throws', () => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      get localStorage(): Storage {
        throw new Error("SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.");
      },
    };
    try {
      expect(pageStorage()).toBeNull();
      const store = browserStore();
      expect(store.persistent).toBe(false);
      store.set(SESSION_KEY, 'kept');
      expect(store.get(SESSION_KEY)).toBe('kept');
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});
